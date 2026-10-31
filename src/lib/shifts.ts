// Work shifts. A shift follows its own zone's wall clock through DST, so its UTC instants move and
// its length can be 7h or 9h on a change day. An overnight shift belongs to the date it starts on.
//
// Attribution rule: every piece of work is cut at shift boundaries. Where shifts overlap, the time
// goes to exactly one window: the one that started earliest, ties by shift id. So worked totals are
// never double-counted. Time in no window is "outside any shift".
import { addDays, dayOf, hhmmToMinutes, instantOfWall, weekdayOf } from './tz';
import type { ShiftVersion } from './types';

export interface ShiftWindow {
  shiftId: string;
  versionId: string;
  name: string;
  color: string;
  zone: string;
  /** The date, in the shift's zone, the window starts on. */
  day: string;
  start: number;
  end: number;
  breakSecs: number;
  /** Window length minus the break, never below zero. */
  scheduledSecs: number;
}

/** The version in force on a date, or null when there is none or the shift was retired by then. */
export function versionOn(versions: readonly ShiftVersion[], day: string): ShiftVersion | null {
  let best: ShiftVersion | null = null;
  for (const v of versions) {
    if (v.deleted || v.effectiveFrom > day) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom === best.effectiveFrom && v.id > best.id)) best = v;
  }
  return best && !best.retired ? best : null;
}

export function groupVersions(all: readonly ShiftVersion[]): Map<string, ShiftVersion[]> {
  const out = new Map<string, ShiftVersion[]>();
  for (const v of all) {
    if (v.deleted) continue;
    const list = out.get(v.shiftId) ?? [];
    list.push(v);
    out.set(v.shiftId, list);
  }
  return out;
}

/** Every window overlapping `[from, to)`, sorted by start then shift id. */
export function windowsFor(all: readonly ShiftVersion[], from: number, to: number): ShiftWindow[] {
  const out: ShiftWindow[] = [];
  for (const [shiftId, versions] of groupVersions(all)) {
    const zone = (versions[0] as ShiftVersion).zone;
    // Each version may name its own zone, so widen the date scan by a day on both sides.
    const first = addDays(dayOf(from, zone), -2);
    const last = addDays(dayOf(to, zone), 1);
    for (let day = first; day <= last; day = addDays(day, 1)) {
      const v = versionOn(versions, day);
      if (!v || !v.weekdays.includes(weekdayOf(day))) continue;
      const startMin = hhmmToMinutes(v.start);
      const endMin = hhmmToMinutes(v.end);
      const start = instantOfWall(day, startMin, v.zone);
      const end = instantOfWall(endMin <= startMin ? addDays(day, 1) : day, endMin, v.zone);
      if (end <= from || start >= to || end <= start) continue;
      const breakSecs = v.breakMinutes * 60;
      out.push({
        shiftId,
        versionId: v.id,
        name: v.name,
        color: v.color,
        zone: v.zone,
        day,
        start,
        end,
        breakSecs,
        scheduledSecs: Math.max(0, end - start - breakSecs),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.shiftId < b.shiftId ? -1 : a.shiftId > b.shiftId ? 1 : 0));
}

export interface Attributed {
  start: number;
  end: number;
  /** null: outside any shift. */
  window: ShiftWindow | null;
}

/** Cuts `[start, end)` at shift boundaries. `windows` must come from `windowsFor`. */
export function attributeSpan(start: number, end: number, windows: readonly ShiftWindow[]): Attributed[] {
  if (end <= start) return [];
  const out: Attributed[] = [];
  let cur = start;
  while (cur < end) {
    let owner: ShiftWindow | null = null;
    let nextEdge = end;
    for (const w of windows) {
      if (w.start >= end) break;
      if (w.end <= cur) continue;
      if (w.start <= cur) {
        if (!owner) owner = w;
        if (w.end < nextEdge && owner === w) nextEdge = w.end;
      } else if (w.start < nextEdge) {
        // A later window only matters here when no window owns the time yet.
        if (!owner) nextEdge = w.start;
      }
    }
    const last = out[out.length - 1];
    if (last && last.window === owner) last.end = nextEdge;
    else out.push({ start: cur, end: nextEdge, window: owner });
    cur = nextEdge;
  }
  return out;
}
