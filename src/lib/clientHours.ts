// The client's working hours as stretches of time. The Timeline shades them and counts the day's logged time
// inside them, and Analysis reports the share of a period inside them: both build their windows here, so the
// two cannot disagree. Every day of the week counts, weekends included, because the user may work any day, and
// hours that end at or before they start (22:00 to 06:00) run overnight into the next day. The same start and
// end (00:00 to 00:00) cover the whole day, which is how to say round the clock.
import { addDays, dayOf, hhmmToMinutes, instantOfWall } from './tz';

export interface HoursWindow {
  start: number;
  end: number;
}

/**
 * The working hours of every client-zone date that touches `[from, to)`, clipped to it, earliest first and
 * without overlap. `workStart` and `workEnd` are `HH:MM` on the client's clock.
 */
export function clientHoursWindows(from: number, to: number, zone: string, workStart: string, workEnd: string): HoursWindow[] {
  const s = hhmmToMinutes(workStart);
  const e = hhmmToMinutes(workEnd);
  const out: HoursWindow[] = [];
  // One date back, for hours that began the evening before and run past midnight into the range.
  for (let d = addDays(dayOf(from, zone), -1); d <= dayOf(Math.max(from, to - 1), zone); d = addDays(d, 1)) {
    const a = instantOfWall(d, s, zone);
    const b = instantOfWall(e <= s ? addDays(d, 1) : d, e, zone);
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (hi > lo) out.push({ start: lo, end: hi });
  }
  return out;
}
