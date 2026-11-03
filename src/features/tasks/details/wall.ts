// Wall-clock input in the active zone, turned into instants honestly. Around a daylight-saving change a
// wall time can not exist (clocks jump over it) or happen twice (clocks go back): the first is refused with
// the reason, the second needs the user to say which of the two they mean.
import { instantOfWall, offsetAt, wallAt } from '../../../lib/tz';

const pad = (n: number): string => String(n).padStart(2, '0');

export type WallResult =
  | { kind: 'ok'; at: number }
  /** The wall time does not exist: clocks jump from `from` to `to` at `at`. */
  | { kind: 'gap'; at: number; from: string; to: string }
  /** The wall time happens twice: `first` before clocks go back, `second` after. */
  | { kind: 'overlap'; first: number; second: number }
  | { kind: 'invalid' };

export function resolveWall(day: string, time: string, zone: string): WallResult {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return { kind: 'invalid' };
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hh, mm] = [Number(t[1]), Number(t[2])];
  if (hh > 23 || mm > 59) return { kind: 'invalid' };
  const probe = new Date(Date.UTC(y, mo - 1, da, hh, mm));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== da) return { kind: 'invalid' };
  const target = probe.getTime() / 1000;
  const offsets = new Set([offsetAt(target - 172800, zone), offsetAt(target + 172800, zone)]);
  const hits = [...offsets].map((o) => target - o).filter((at) => offsetAt(at, zone) === target - at);
  hits.sort((a, b) => a - b);
  const [first, second] = hits;
  if (first === undefined) {
    const at = instantOfWall(day, hh * 60 + mm, zone);
    const before = new Date((at + offsetAt(at - 1, zone)) * 1000);
    const after = new Date((at + offsetAt(at, zone)) * 1000);
    return { kind: 'gap', at, from: `${pad(before.getUTCHours())}:${pad(before.getUTCMinutes())}`, to: `${pad(after.getUTCHours())}:${pad(after.getUTCMinutes())}` };
  }
  if (second !== undefined) return { kind: 'overlap', first, second };
  return { kind: 'ok', at: first };
}

/** What a date input, a time input and the "which one" choice hold. */
export interface WallField {
  day: string;
  time: string;
  /** For a wall time that happens twice: the later occurrence. */
  second: boolean;
}

export function fieldFromInstant(sec: number, zone: string): WallField {
  const w = wallAt(sec, zone);
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  const r = resolveWall(w.day, time, zone);
  return { day: w.day, time, second: r.kind === 'overlap' && sec >= r.second };
}

export type Resolved = { ok: true; at: number } | { ok: false; message: string };

/** Whether two fields name the same wall time. The "which one" choice only counts at a time that happens twice. */
function sameWall(a: WallField, b: WallField, zone: string): boolean {
  return a.day === b.day && a.time === b.time && (a.second === b.second || repeated(b, zone) === null);
}

/**
 * The instant a field holds. A date and a time input hold minutes, so an instant with seconds does not survive a round trip through
 * them. Pass `kept`, the instant the field was made from, and a field that still shows its minute gives it back whole, so editing
 * one end of an entry does not move the other.
 */
export function wallToInstant(field: WallField, zone: string, label: string, kept?: number): Resolved {
  if (kept !== undefined && sameWall(field, fieldFromInstant(kept, zone), zone)) return { ok: true, at: kept };
  const r = resolveWall(field.day, field.time, zone);
  switch (r.kind) {
    case 'ok':
      return { ok: true, at: r.at };
    case 'overlap':
      return { ok: true, at: field.second ? r.second : r.first };
    case 'gap':
      return { ok: false, message: `${label} ${field.time} does not exist in this zone on ${field.day}: clocks jump from ${r.from} to ${r.to}. Pick a time outside that hour.` };
    case 'invalid':
      return { ok: false, message: `${label}: enter a date and a time.` };
  }
}

/** Both instants of a wall time that happens twice, or null. Used to offer the "which one" choice. */
export function repeated(field: WallField, zone: string): { first: number; second: number } | null {
  const r = resolveWall(field.day, field.time, zone);
  return r.kind === 'overlap' ? { first: r.first, second: r.second } : null;
}
