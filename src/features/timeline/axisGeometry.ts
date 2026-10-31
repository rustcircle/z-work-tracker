// Axis geometry for one stretch of real time shown on a zone's wall clock. Ticks sit on real
// wall-clock hours, so a 23-hour day has no 02:00 and a 25-hour day has the repeated hour twice,
// labelled "01:00" and "01:00 again". Fractions are of real elapsed time, never of 24.
import { dayOf, offsetAt, shiftsBetween, wallAt } from '../../lib/tz';
import { pad2 } from '../../components/format';

export interface Tick {
  at: number;
  /** Position along the axis, 0 to 1, by real elapsed time. */
  frac: number;
  label: string;
  /** Label printed on the axis (every third hour, midnights and repeated hours). */
  major: boolean;
  /** Second pass through a repeated wall-clock hour. */
  repeated: boolean;
  /** This tick is local midnight in the zone. */
  midnight: boolean;
  /** The zone's calendar day starting at this tick. */
  day: string;
}

/** Hour ticks in `[start, end)` on `zone`'s wall clock. */
export function axisTicks(start: number, end: number, zone: string): Tick[] {
  const length = end - start;
  if (length <= 0) return [];
  const cuts = [start, ...shiftsBetween(start, end, zone).map((c) => c.at).filter((t) => t > start), end];
  const seen = new Set<string>();
  const out: Tick[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    const off = offsetAt(a, zone);
    const m = (((a + off) % 3600) + 3600) % 3600;
    for (let t = m === 0 ? a : a + 3600 - m; t < b; t += 3600) {
      const w = wallAt(t, zone);
      const key = `${w.day}|${w.hour}`;
      const repeated = seen.has(key);
      seen.add(key);
      const base = `${pad2(w.hour)}:00`;
      out.push({
        at: t,
        frac: (t - start) / length,
        label: repeated ? `${base} again` : base,
        major: w.hour % 3 === 0 || repeated,
        repeated,
        midnight: w.hour === 0,
        day: w.day,
      });
    }
  }
  return out;
}

/** The pass (1 or 2) through a repeated hour that `sec` falls in, or null on an ordinary hour. */
export function repeatedPass(sec: number, zone: string): 1 | 2 | null {
  for (const c of shiftsBetween(sec - 86400, sec + 86400, zone)) {
    if (c.deltaSecs >= 0) continue;
    const span = -c.deltaSecs;
    if (sec >= c.at - span && sec < c.at) return 1;
    if (sec >= c.at && sec < c.at + span) return 2;
  }
  return null;
}

/** Greedy interval partitioning: the lane index for each interval, so overlaps never share a lane. */
export function assignLanes(items: readonly { start: number; end: number }[]): { lanes: number[]; count: number } {
  const order = items.map((_, i) => i).sort((a, b) => (items[a] as { start: number }).start - (items[b] as { start: number }).start || (items[a] as { end: number }).end - (items[b] as { end: number }).end);
  const ends: number[] = [];
  const lanes: number[] = new Array<number>(items.length).fill(0);
  for (const i of order) {
    const it = items[i] as { start: number; end: number };
    let lane = ends.findIndex((e) => e <= it.start);
    if (lane < 0) {
      lane = ends.length;
      ends.push(it.end);
    } else ends[lane] = it.end;
    lanes[i] = lane;
  }
  return { lanes, count: Math.max(1, ends.length) };
}

/** True when the instant's calendar day in `zone` differs from `day`. */
export const differsFromDay = (sec: number, zone: string, day: string): boolean => dayOf(sec, zone) !== day;
