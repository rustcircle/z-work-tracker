// When does the screen next need to look at the time? Billable time moves in steps (15 minutes by default),
// so earnings and totals are worked out again only when a step falls due, when a whole minute of a running
// stretch completes (so a duration reads "5m", never a stale "4m 37s"), when the day ends, or when data
// changes. The only per-second thing in the app is a running task's elapsed clock (`useLiveSec`).
import { useEffect, useEffectEvent, useState } from 'react';

import type { Rule } from '../lib/billing';
import { useAppState } from './store';

/** With no increment, billable follows exact time; its amount is refreshed once a minute, not each second. */
export const EXACT_REFRESH_SECS = 60;

/**
 * Seconds until a task-day's billable time next changes, if its counted time (exact plus billable pauses)
 * is `counted` now and keeps growing a second per second. At least 1. With rounding off it follows exact
 * time, refreshed every `EXACT_REFRESH_SECS`.
 */
export function nextStepIn(counted: number, rule: Rule): number {
  const inc = rule.incrementMinutes * 60;
  if (inc <= 0) return EXACT_REFRESH_SECS;
  const r = counted % inc;
  const half = Math.ceil(inc / 2);
  switch (rule.method) {
    case 'up':
      // Up holds the multiple until it is passed by a second.
      return r === 0 ? 1 : inc - r + 1;
    case 'down':
      return inc - r;
    case 'nearest':
      return r < half ? half - r : inc - r + half;
  }
}

/** Seconds to the next whole minute counted from `anchor` (the start of a running stretch), else from the epoch minute. */
export function nextMarkIn(now: number, anchor: number | null): number {
  const since = anchor === null ? now : now - anchor;
  return 60 - (((since % 60) + 60) % 60);
}

export interface LiveRow {
  /** Exact plus billable pause seconds as of the moment the rows were worked out. */
  counted: number;
  rule: Rule;
}

/** The soonest moment anything on screen can change: a step, a minute mark of the running stretch, midnight. */
export function nextWake(rows: readonly LiveRow[], now: number, anchor: number | null, untilMidnight: number | null): number {
  let wake = nextMarkIn(now, anchor);
  for (const r of rows) wake = Math.min(wake, nextStepIn(r.counted, r.rule));
  if (untilMidnight !== null && untilMidnight > 0) wake = Math.min(wake, untilMidnight);
  return Math.max(1, wake);
}

/**
 * The time to show, read again at each moment `wakeIn` names (seconds from the time it is given) and
 * whenever `dataKey` changes. `dataKey` must change whenever the answer of `wakeIn` could, apart from the time
 * itself: the new data, the zone, the rounding. `wakeIn` returns null when nothing is running, and then no timer is set.
 * While the window is hidden no timer runs; waking reads the clock at once.
 */
export function useStepNow(dataKey: unknown, wakeIn: (now: number) => number | null): number {
  const { clock } = useAppState();
  const [now, setNow] = useState(() => clock.readNow());
  const [epoch, setEpoch] = useState(0);
  const [seen, setSeen] = useState(dataKey);
  if (seen !== dataKey) {
    setSeen(dataKey);
    setNow(clock.readNow());
  }
  const wakeFor = useEffectEvent(wakeIn);
  useEffect(() => {
    let timer: number | null = null;
    const secs = clock.isAwake() ? wakeFor(now) : null;
    if (secs !== null) timer = window.setTimeout(() => setNow(clock.readNow()), secs * 1000);
    const off = clock.subscribe((awake) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (awake) {
        setNow(clock.readNow());
        setEpoch((e) => e + 1);
      }
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [clock, now, epoch, dataKey]);
  return now;
}
