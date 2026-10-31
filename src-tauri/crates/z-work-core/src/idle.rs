//! Notices when a running task may not have been worked on: the machine slept, the clock jumped, or
//! nobody touched it. Pure: the app passes in the clock and the idle time it reads from the OS.

use crate::model::GapKind;
use crate::time::Ts;

/// Ticks arrive every few seconds. A wall-clock step beyond this means the machine wasn't running.
pub const JUMP_SECS: i64 = 120;

#[derive(Debug, Default)]
pub struct IdleTracker {
    last_tick: Option<Ts>,
    away_since: Option<Ts>,
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
        if !running {
            self.away_since = None;
            return out;
        }
        if let Some(last) = last
            && now.secs() - last.secs() > JUMP_SECS
        {
            out.push(NewGap {
                start: last,
                end: now,
                kind: GapKind::Sleep,
            });
            // The step already covers this time, so an idle span must not count it twice.
            self.away_since = None;
            return out;
        }
        let Some(idle) = idle_secs else {
            return out;
        };
        let idle = i64::try_from(idle).unwrap_or(i64::MAX);
        let threshold = i64::try_from(threshold_secs).unwrap_or(i64::MAX);
        if threshold > 0 && idle >= threshold {
            let since = Ts(now.secs().saturating_sub(idle));
            self.away_since = Some(self.away_since.map_or(since, |a| a.min(since)));
        } else if let Some(since) = self.away_since.take() {
            let end = Ts(now.secs().saturating_sub(idle));
            if end > since {
                out.push(NewGap {
                    start: since,
                    end,
                    kind: GapKind::Idle,
                });
            }
        }
        out
    }

    /// The running task changed, or the app paused it: time before now is settled.
    pub fn reset(&mut self) {
        self.away_since = None;
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
        assert_eq!(g, vec![NewGap { start: Ts(T + 5), end: Ts(T + 8 * 3600), kind: GapKind::Sleep }]);
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
        assert_eq!(g, vec![NewGap { start: Ts(T + 10 - 700), end: Ts(T + 18), kind: GapKind::Idle }]);
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
    fn stopping_while_away_records_nothing() {
        let mut t = IdleTracker::default();
        t.tick(Ts(T), true, Some(900), 600);
        t.tick(Ts(T + 5), false, Some(905), 600);
        assert!(t.tick(Ts(T + 10), true, Some(0), 600).is_empty());
    }
}
