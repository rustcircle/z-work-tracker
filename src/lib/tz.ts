// Time-zone engine. Rules come from src/generated/tzdata.json, generated from the same tz database
// that Rust links (see the gen_tzdata example), so both sides agree by construction. Each instant
// is converted with the offset in force at that instant; nothing assumes today's offset.
// Instants are whole seconds since the epoch. Days are `YYYY-MM-DD` strings.
import raw from '../generated/tzdata.json';

interface RawRule {
  p: [number, string][];
  t: number[];
  k: number[];
}
interface RawData {
  version: string;
  fromMinutes: number;
  zones: Record<string, number>;
  rules: RawRule[];
}
const data = raw as unknown as RawData;

interface Compiled {
  times: number[];
  kinds: number[];
  periods: [number, string][];
}

const compiled = new Map<number, Compiled>();

function ruleFor(zone: string): Compiled {
  const id = data.zones[zone];
  if (id === undefined) throw new Error(`unknown time zone: ${zone}`);
  let c = compiled.get(id);
  if (!c) {
    const r = data.rules[id] as RawRule;
    const times: number[] = [];
    let cur = data.fromMinutes;
    for (const d of r.t) {
      cur += d;
      times.push(cur * 60);
    }
    c = { times, kinds: r.k, periods: r.p };
    compiled.set(id, c);
  }
  return c;
}

export const TZDB_VERSION = data.version;
export const isZone = (zone: string): boolean => data.zones[zone] !== undefined;

const REGION = /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;
/** Zones offered in the picker: region/city names plus UTC. */
export function pickerZones(): string[] {
  return Object.keys(data.zones)
    .filter((z) => REGION.test(z))
    .concat('UTC')
    .sort();
}

function periodIndex(c: Compiled, sec: number): number {
  let lo = 0;
  let hi = c.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((c.times[mid] as number) <= sec) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : (c.kinds[lo - 1] as number);
}

function period(sec: number, zone: string): [number, string] {
  const c = ruleFor(zone);
  return c.periods[periodIndex(c, sec)] as [number, string];
}

/** Seconds east of UTC in force at `sec`. */
export const offsetAt = (sec: number, zone: string): number => period(sec, zone)[0];

export function formatOffset(offsetSecs: number): string {
  const sign = offsetSecs < 0 ? '-' : '+';
  const abs = Math.abs(offsetSecs);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Abbreviation such as EDT, or the numeric offset where the database has none. */
export function abbrAt(sec: number, zone: string): string {
  const [off, abbr] = period(sec, zone);
  return abbr || formatOffset(off);
}

export function cityOf(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return last.replaceAll('_', ' ');
}

/** "New York, EDT, UTC-4". */
export function zoneLabel(zone: string, sec: number): string {
  if (zone === 'UTC') return 'UTC';
  const [off] = period(sec, zone);
  return `${cityOf(zone)}, ${abbrAt(sec, zone)}, ${formatOffset(off)}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export interface Wall {
  day: string;
  year: number;
  month: number;
  date: number;
  hour: number;
  minute: number;
  second: number;
  /** 1 = Monday .. 7 = Sunday. */
  weekday: number;
}

export function wallAt(sec: number, zone: string): Wall {
  const d = new Date((sec + offsetAt(sec, zone)) * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const date = d.getUTCDate();
  return {
    day: `${year}-${pad(month)}-${pad(date)}`,
    year,
    month,
    date,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1,
  };
}

export const dayOf = (sec: number, zone: string): string => wallAt(sec, zone).day;

function dayToUtcSecs(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 1000;
}

export function addDays(day: string, n: number): string {
  const d = new Date((dayToUtcSecs(day) + n * 86400) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 1 = Monday .. 7 = Sunday. */
export function weekdayOf(day: string): number {
  return ((new Date(dayToUtcSecs(day) * 1000).getUTCDay() + 6) % 7) + 1;
}

/** Whole days from `a` to `b`. */
export const daysBetween = (a: string, b: string): number => Math.round((dayToUtcSecs(b) - dayToUtcSecs(a)) / 86400);

/**
 * The first instant whose wall clock reaches `minutes` past midnight on `day`.
 * Fall-back overlap: the earlier pass. Spring-forward gap: the instant the clocks jump.
 */
export function instantOfWall(day: string, minutes: number, zone: string): number {
  const target = dayToUtcSecs(day) + minutes * 60;
  const c = ruleFor(zone);
  const before = (c.periods[periodIndex(c, target - 172800)] as [number, string])[0];
  const after = (c.periods[periodIndex(c, target + 172800)] as [number, string])[0];
  const a = target - before;
  const b = target - after;
  const okA = offsetAt(a, zone) === before;
  const okB = offsetAt(b, zone) === after;
  if (okA && okB) return Math.min(a, b);
  if (okA) return a;
  if (okB) return b;
  // In a gap: return the transition that skipped this wall time.
  const lo = Math.min(a, b);
  const next = c.times.find((t) => t > lo);
  return next ?? a;
}

export const startOfDay = (day: string, zone: string): number => instantOfWall(day, 0, zone);

export interface DayBounds {
  start: number;
  end: number;
  /** Real length: 86400 normally, 23 or 25 hours on a DST day. */
  length: number;
}

export function dayBounds(day: string, zone: string): DayBounds {
  const start = startOfDay(day, zone);
  const end = startOfDay(addDays(day, 1), zone);
  return { start, end, length: end - start };
}

export interface OffsetChange {
  at: number;
  zone: string;
  fromOffset: number;
  toOffset: number;
  /** Positive when clocks go forward. */
  deltaSecs: number;
}

/** Real offset changes in `[from, to)`. A rename with the same offset is not a shift. */
export function shiftsBetween(from: number, to: number, zone: string): OffsetChange[] {
  const c = ruleFor(zone);
  const out: OffsetChange[] = [];
  let i = c.times.findIndex((t) => t >= from);
  if (i < 0) return out;
  for (; i < c.times.length; i += 1) {
    const at = c.times[i] as number;
    if (at >= to) break;
    const fromOffset = offsetAt(at - 1, zone);
    const toOffset = offsetAt(at, zone);
    if (fromOffset !== toOffset) out.push({ at, zone, fromOffset, toOffset, deltaSecs: toOffset - fromOffset });
  }
  return out;
}

export function nextShift(sec: number, zone: string): OffsetChange | null {
  const c = ruleFor(zone);
  for (const at of c.times) {
    if (at <= sec) continue;
    const fromOffset = offsetAt(at - 1, zone);
    const toOffset = offsetAt(at, zone);
    if (fromOffset !== toOffset) return { at, zone, fromOffset, toOffset, deltaSecs: toOffset - fromOffset };
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function humanSpan(secs: number): string {
  const abs = Math.abs(secs);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/**
 * "New York clocks went forward 1h, 8 Mar", or "go forward" when the change is after `nowSec`. Pass the
 * app's own clock; the default is the system clock.
 */
export function shiftText(change: OffsetChange, nowSec: number = Date.now() / 1000): string {
  const w = wallAt(change.at, change.zone);
  const dir = change.deltaSecs > 0 ? 'forward' : 'back';
  const verb = change.at > nowSec ? 'go' : 'went';
  return `${cityOf(change.zone)} clocks ${verb} ${dir} ${humanSpan(change.deltaSecs)}, ${w.date} ${MONTHS[w.month - 1]}`;
}

/** Seconds that `other` is ahead of `mine` at this instant; negative means behind. */
export const gapAt = (sec: number, mine: string, other: string): number => offsetAt(sec, other) - offsetAt(sec, mine);

/** "New York is 5h behind you on this date". */
export function gapText(sec: number, mine: string, other: string): string {
  const gap = gapAt(sec, mine, other);
  if (gap === 0) return `${cityOf(other)} is at the same time as you on this date`;
  return `${cityOf(other)} is ${humanSpan(gap)} ${gap < 0 ? 'behind' : 'ahead of'} you on this date`;
}

/** Periods in `[from, to)` during which the gap between the zones stays constant. */
export function gapPeriods(from: number, to: number, mine: string, other: string): { start: number; end: number; gap: number }[] {
  const cuts = [...shiftsBetween(from, to, mine), ...shiftsBetween(from, to, other)].map((c) => c.at).sort((a, b) => a - b);
  const out: { start: number; end: number; gap: number }[] = [];
  let cur = from;
  for (const cut of [...cuts, to]) {
    if (cut <= cur) continue;
    const gap = gapAt(cur, mine, other);
    const last = out[out.length - 1];
    if (last && last.gap === gap) last.end = cut;
    else out.push({ start: cur, end: cut, gap });
    cur = cut;
  }
  return out;
}

/** `HH:MM` in the zone at the instant. */
export function clockAt(sec: number, zone: string): string {
  const w = wallAt(sec, zone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

export const parseIso = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
export const toIso = (sec: number): string => `${new Date(sec * 1000).toISOString().slice(0, 19)}Z`;
export const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
