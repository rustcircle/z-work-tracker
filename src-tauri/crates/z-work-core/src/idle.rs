//! Notices when a running task may not have been worked on: the machine slept, the clock jumped, or
//! nobody touched it. Pure: the app passes in the clock and the idle time it reads from the OS.

use crate::model::GapKind;
use crate::time::Ts;

/// Ticks arrive every few seconds. A wall-clock step beyond this means the machine wasn't running.
pub const JUMP_SECS: i64 = 120;
/// A lock isn't believed past this long without the OS confirming it, so a failing query can't
/// leave the app thinking the screen is locked while someone works.
pub const LOCK_SILENCE_SECS: i64 = 60;
/// Polls are seconds apart, so a lock this short can't be measured. That time stays work.
pub const MIN_LOCK_SECS: i64 = 10;

#[derive(Debug, Default)]
pub struct IdleTracker {
    last_tick: Option<Ts>,
    away_since: Option<Ts>,
    /// Time up to here is already on a gap. The OS's idle count can span a sleep, so it is clamped.
    settled_until: Option<Ts>,
    /// When the session locked, while it stays locked.
    locked_since: Option<Ts>,
    /// The last time the OS answered that the session is locked.
    locked_confirmed: Option<Ts>,
}

/// The gap for a lock, unless it is too short to measure.
fn lock_gap(start: Ts, end: Ts, measured_from: Ts) -> Vec<NewGap> {
    if end.secs() - measured_from.secs() <= MIN_LOCK_SECS && start >= measured_from {
        return Vec::new();
    }
    vec![NewGap {
        start,
        end,
        kind: GapKind::Lock,
    }]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewGap {
    pub start: Ts,
    pub end: Ts,
    pub kind: GapKind,
}

impl IdleTracker {
    /// `idle_secs` is `None` where the OS can't say. `threshold_secs` 0 turns idle detection off;
    /// a sleep or clock jump is always noticed, because it can overbill by hours.
    pub fn tick(
        &mut self,
        now: Ts,
        running: bool,
        idle_secs: Option<u64>,
        threshold_secs: u64,
    ) -> Vec<NewGap> {
        let mut out = Vec::new();
        let last = self.last_tick.replace(now);
        if let Some(since) = self.locked_since {
            // The unlock closes this absence. A sleep during it is part of it, even when the lock
            // was only seen after the wake.
            if let Some(last) = last
                && now.secs() - last.secs() > JUMP_SECS
            {
                self.locked_since = Some(since.min(last));
            }
            return out;
        }
        if !running {
            self.away_since = None;
            return out;
        }
        if let Some(last) = last
            && now.secs() - last.secs() > JUMP_SECS
        {
            // Idle time running into the sleep belongs to the same absence.
            let start = self.away_since.take().map_or(last, |a| a.min(last));
            out.push(NewGap {
                start,
                end: now,
                kind: GapKind::Sleep,
            });
            self.settled_until = Some(now);
            return out;
        }
        let Some(idle) = idle_secs else {
            return out;
        };
        let idle = i64::try_from(idle).unwrap_or(i64::MAX);
        let threshold = i64::try_from(threshold_secs).unwrap_or(i64::MAX);
        if threshold > 0 && idle >= threshold {
            let since =
                Ts(now.secs().saturating_sub(idle)).max(self.settled_until.unwrap_or(Ts(i64::MIN)));
            self.away_since = Some(self.away_since.map_or(since, |a| a.min(since)));
        } else if let Some(since) = self.away_since.take() {
            let end = Ts(now.secs().saturating_sub(idle));
            // Shorter than the limit: only the part of a longer idle count that a sleep or lock
            // already covered, which isn't an absence of its own.
            if end > since && (threshold == 0 || end.secs() - since.secs() >= threshold) {
                out.push(NewGap {
                    start: since,
                    end,
                    kind: GapKind::Idle,
                });
            }
        }
        out
    }

    /// The session locked or unlocked. A lock is an absence whatever the idle count or limit says,
    /// so unlocking closes a gap running from the lock, or from earlier idle time.
    pub fn set_locked(&mut self, now: Ts, locked: bool) -> Vec<NewGap> {
        match (locked, self.locked_since) {
            (true, None) => {
                self.locked_since = Some(now);
                self.locked_confirmed = Some(now);
                Vec::new()
            }
            (true, Some(_)) => {
                self.locked_confirmed = Some(now);
                Vec::new()
            }
            (false, Some(_)) => self.close_lock(now),
            (false, None) => Vec::new(),
        }
    }

    /// The OS couldn't say. One failed poll doesn't end a lock, but after a while the lock closes at
    /// the last moment it was confirmed, and idle and sleep detection take over again.
    pub fn lock_unknown(&mut self, now: Ts) -> Vec<NewGap> {
        let Some(confirmed) = self
            .locked_confirmed
            .filter(|_| self.locked_since.is_some())
        else {
            return Vec::new();
        };
        if now.secs() - confirmed.secs() < LOCK_SILENCE_SECS {
            return Vec::new();
        }
        self.close_lock(confirmed)
    }

    fn close_lock(&mut self, end: Ts) -> Vec<NewGap> {
        let Some(since) = self.locked_since.take() else {
            return Vec::new();
        };
        self.locked_confirmed = None;
        let start = self.away_since.take().map_or(since, |a| a.min(since));
        let gaps = lock_gap(start, end, since);
        if !gaps.is_empty() {
            self.settled_until = Some(end);
        }
        gaps
    }

    /// What the current absence is, for a crash to label it correctly.
    #[must_use]
    pub fn away_kind(&self) -> Option<GapKind> {
        if self.locked_since.is_some() {
            Some(GapKind::Lock)
        } else {
            self.away_since.map(|_| GapKind::Idle)
        }
    }

    /// When the current absence began, for a crash to recover from.
    #[must_use]
    pub fn away_since(&self) -> Option<Ts> {
        match (self.away_since, self.locked_since) {
            (Some(a), Some(l)) => Some(a.min(l)),
            (a, l) => a.or(l),
        }
    }

    /// The running segment is about to close, so an absence in progress has to be recorded now. The
    /// user is back or the app is going away; the last tick is the last moment known to be away.
    pub fn settle(&mut self, now: Ts) -> Vec<NewGap> {
        let last = self.last_tick.replace(now);
        let away = self.away_since.take();
        let mut out = Vec::new();
        if let Some(since) = self.locked_since {
            // Still locked as far as is known, so what follows belongs to the same absence.
            self.locked_since = Some(now);
            self.locked_confirmed = Some(now);
            let gaps = lock_gap(away.map_or(since, |a| a.min(since)), now, since);
            if !gaps.is_empty() {
                self.settled_until = Some(now);
            }
            return gaps;
        }
        if let Some(l) = last
            && now.secs() - l.secs() > JUMP_SECS
        {
            out.push(NewGap {
                start: away.map_or(l, |a| a.min(l)),
                end: now,
                kind: GapKind::Sleep,
            });
            self.settled_until = Some(now);
        } else if let (Some(a), Some(l)) = (away, last)
            && l > a
        {
            out.push(NewGap {
                start: a,
                end: l,
                kind: GapKind::Idle,
            });
            self.settled_until = Some(l);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000;

    #[test]
    fn a_clock_jump_between_ticks_is_a_gap_and_a_backward_clock_is_not() {
        let mut t = IdleTracker::default();
        assert!(t.tick(Ts(T), true, None, 600).is_empty());
        assert!(t.tick(Ts(T + 5), true, None, 600).is_empty());
        let g = t.tick(Ts(T + 8 * 3600), true, None, 600);
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T + 5),
                end: Ts(T + 8 * 3600),
                kind: GapKind::Sleep
            }]
        );
        assert!(t.tick(Ts(T + 100), true, None, 600).is_empty(), "backwards");
    }

    #[test]
    fn idle_makes_one_gap_when_the_user_returns() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        assert!(t.tick(Ts(T + 5), true, Some(599), 600).is_empty());
        assert!(t.tick(Ts(T + 10), true, Some(700), 600).is_empty());
        assert!(t.tick(Ts(T + 15), true, Some(705), 600).is_empty());
        let g = t.tick(Ts(T + 20), true, Some(2), 600);
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T + 10 - 700),
                end: Ts(T + 18),
                kind: GapKind::Idle
            }]
        );
        assert!(t.tick(Ts(T + 25), true, Some(1), 600).is_empty());
    }

    #[test]
    fn nothing_is_recorded_while_no_task_runs_and_zero_turns_idle_off() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), false, Some(5000), 600);
        assert!(t.tick(Ts(T + 9000), false, Some(9000), 600).is_empty());
        assert!(t.tick(Ts(T + 9005), true, Some(9000), 0).is_empty());
        assert!(t.tick(Ts(T + 9010), true, Some(0), 0).is_empty());
    }

    #[test]
    fn idle_before_a_sleep_is_part_of_the_same_gap() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(1200), 600);
        t.tick(Ts(T + 5), true, Some(1205), 600);
        let gaps = t.tick(Ts(T + 8 * 3600), true, Some(0), 600);
        assert_eq!(gaps.len(), 1);
        assert_eq!(
            gaps[0].start,
            Ts(T - 1200),
            "starts when the user left, not at the sleep"
        );
        assert_eq!(gaps[0].end, Ts(T + 8 * 3600));
    }

    #[test]
    fn an_idle_count_spanning_a_sleep_does_not_make_a_second_overlapping_gap() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        let wake = T + 8 * 3600;
        assert_eq!(t.tick(Ts(wake), true, Some(8 * 3600), 600).len(), 1);
        t.tick(Ts(wake + 5), true, Some(8 * 3600 + 5), 600);
        let later = t.tick(Ts(wake + 10), true, Some(0), 600);
        for g in &later {
            assert!(g.start >= Ts(wake), "{g:?}");
        }
    }

    #[test]
    fn settling_records_the_absence_in_progress_and_only_once() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(900), 600);
        t.tick(Ts(T + 5), true, Some(905), 600);
        let g = t.settle(Ts(T + 7));
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T - 900),
                end: Ts(T + 5),
                kind: GapKind::Idle
            }]
        );
        assert!(t.settle(Ts(T + 8)).is_empty());
        assert!(t.away_since().is_none());
    }

    #[test]
    fn settling_after_an_unnoticed_sleep_records_it() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        let g = t.settle(Ts(T + 3600));
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T),
                end: Ts(T + 3600),
                kind: GapKind::Sleep
            }]
        );
    }

    #[test]
    fn a_lock_shorter_than_the_limit_is_one_gap() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        assert!(t.set_locked(Ts(T + 1), true).is_empty());
        for i in 1..=108 {
            assert!(t.tick(Ts(T + 1 + i * 5), true, Some(0), 600).is_empty());
        }
        let g = t.set_locked(Ts(T + 541), false);
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T + 1),
                end: Ts(T + 541),
                kind: GapKind::Lock
            }]
        );
        assert!(t.tick(Ts(T + 546), true, Some(0), 600).is_empty());
    }

    #[test]
    fn a_lock_of_ten_seconds_or_less_stays_work_and_anything_longer_asks() {
        for (secs, gaps) in [(5, 0), (10, 0), (15, 1)] {
            let mut t = IdleTracker::default();
            t.tick(Ts(T), true, Some(0), 600);
            t.set_locked(Ts(T), true);
            assert_eq!(t.set_locked(Ts(T + secs), false).len(), gaps, "{secs}");
        }
    }

    #[test]
    fn idle_time_before_a_short_lock_is_still_an_absence() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(900), 600);
        t.set_locked(Ts(T + 1), true);
        let g = t.set_locked(Ts(T + 6), false);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].start, Ts(T - 900));
    }

    #[test]
    fn a_long_lock_with_idle_detection_off_is_one_gap() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 0);
        t.set_locked(Ts(T + 5), true);
        t.tick(Ts(T + 10), true, Some(5), 0);
        let g = t.set_locked(Ts(T + 3 * 3600), false);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].start, Ts(T + 5));
    }

    #[test]
    fn repeated_lock_reports_change_nothing_and_an_unlock_alone_is_no_gap() {
        let mut t = IdleTracker::default();
        assert!(t.set_locked(Ts(T), false).is_empty());
        t.set_locked(Ts(T + 5), true);
        assert!(t.set_locked(Ts(T + 10), true).is_empty());
        assert_eq!(t.set_locked(Ts(T + 20), false)[0].start, Ts(T + 5));
        assert!(t.set_locked(Ts(T + 25), false).is_empty());
    }

    #[test]
    fn idle_before_a_lock_and_a_sleep_during_it_are_one_gap() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(900), 600);
        t.set_locked(Ts(T + 1), true);
        assert!(t.tick(Ts(T + 8 * 3600), true, Some(0), 600).is_empty());
        let g = t.set_locked(Ts(T + 8 * 3600 + 30), false);
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T - 900),
                end: Ts(T + 8 * 3600 + 30),
                kind: GapKind::Lock
            }]
        );
    }

    #[test]
    fn a_lock_only_seen_after_a_wake_still_covers_the_sleep() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        t.set_locked(Ts(T + 3600), true);
        assert!(t.tick(Ts(T + 3600), true, Some(0), 600).is_empty());
        assert_eq!(t.set_locked(Ts(T + 3700), false)[0].start, Ts(T));
    }

    #[test]
    fn settling_while_locked_records_it_and_the_rest_stays_one_absence() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        t.set_locked(Ts(T + 5), true);
        assert_eq!(t.away_since(), Some(Ts(T + 5)));
        let g = t.settle(Ts(T + 60));
        assert_eq!(
            g,
            vec![NewGap {
                start: Ts(T + 5),
                end: Ts(T + 60),
                kind: GapKind::Lock
            }]
        );
        assert_eq!(t.set_locked(Ts(T + 90), false)[0].start, Ts(T + 60));
    }

    #[test]
    fn a_sleep_settled_once_is_not_found_again_by_the_next_tick() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        assert_eq!(t.settle(Ts(T + 3600)).len(), 1);
        assert!(t.tick(Ts(T + 3605), true, Some(0), 600).is_empty());
    }

    #[test]
    fn the_few_seconds_after_a_wake_are_not_an_absence_of_their_own() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(0), 600);
        let wake = T + 8 * 3600;
        assert_eq!(t.tick(Ts(wake), true, Some(8 * 3600), 600).len(), 1);
        t.tick(Ts(wake + 5), true, Some(8 * 3600 + 5), 600);
        assert!(t.tick(Ts(wake + 10), true, Some(0), 600).is_empty());
    }

    #[test]
    fn stopping_while_away_records_nothing() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(900), 600);
        t.tick(Ts(T + 5), false, Some(905), 600);
        assert!(t.tick(Ts(T + 10), true, Some(0), 600).is_empty());
    }
}
