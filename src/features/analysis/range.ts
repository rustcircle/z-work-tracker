// Analysis periods: whole calendar days in one zone, from day/week/month/quarter/year or a custom
// span. Weeks start on Monday. All edges are zone days, so a period is 23h or 25h long on DST days.
import { addDays, startOfDay, weekdayOf } from '../../lib/tz';

export type RangeKind = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

export interface RangeSpec {
  kind: RangeKind;
  /** Any day inside the period; custom ranges ignore it. */
  anchor: string;
  /** Custom ranges only, inclusive `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

export interface Period {
  kind: RangeKind;
  fromDay: string;
  /** Inclusive. */
  toDay: string;
  /** First instant of `fromDay` in the zone. */
  from: number;
  /** First instant after `toDay` in the zone. */
  to: number;
  days: number;
  label: string;
}

/** Longest custom span the dashboard accepts, in days. */
export const MAX_CUSTOM_DAYS = 1830;

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const WEEKDAY_SHORT = WEEKDAY_NAMES.map((d) => d.slice(0, 3));

/** Days since 1970-01-01 of a `YYYY-MM-DD` string. */
export function dayNum(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dayStr(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Monday .. 6 = Sunday, for a day number. */
export const weekdayIndex = (n: number): number => (((n + 3) % 7) + 7) % 7;

function ymd(day: string): [number, number, number] {
  return day.split('-').map(Number) as [number, number, number];
}

const p2 = (n: number): string => String(n).padStart(2, '0');
const firstOfMonth = (y: number, m: number): string => `${y}-${p2(m)}-01`;

/** First day of the month `n` months away from the month of `day`. */
export function addMonths(day: string, n: number): string {
  const [y, m] = ymd(day);
  const idx = y * 12 + (m - 1) + n;
  return firstOfMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

const lastOfMonth = (day: string): string => addDays(addMonths(day, 1), -1);

export function mondayOf(day: string): string {
  return addDays(day, -(weekdayOf(day) - 1));
}

export function spanDays(range: RangeSpec): { fromDay: string; toDay: string } {
  const a = range.anchor;
  switch (range.kind) {
    case 'day':
      return { fromDay: a, toDay: a };
    case 'week': {
      const m = mondayOf(a);
      return { fromDay: m, toDay: addDays(m, 6) };
    }
    case 'month':
      return { fromDay: addMonths(a, 0), toDay: lastOfMonth(a) };
    case 'quarter': {
      const [y, m] = ymd(a);
      const q = firstOfMonth(y, Math.floor((m - 1) / 3) * 3 + 1);
      return { fromDay: q, toDay: lastOfMonth(addMonths(q, 2)) };
    }
    case 'year': {
      const [y] = ymd(a);
      return { fromDay: `${y}-01-01`, toDay: `${y}-12-31` };
    }
    case 'custom': {
      let f = range.from ?? a;
      let t = range.to ?? a;
      if (t < f) [f, t] = [t, f];
      const max = addDays(f, MAX_CUSTOM_DAYS - 1);
      return { fromDay: f, toDay: t > max ? max : t };
    }
  }
}

const dayLabel = (day: string): string => {
  const [y, m, d] = ymd(day);
  return `${WEEKDAY_SHORT[weekdayOf(day) - 1]} ${d} ${MONTH_SHORT[m - 1]} ${y}`;
};
const shortLabel = (day: string): string => {
  const [, m, d] = ymd(day);
  return `${d} ${MONTH_SHORT[m - 1]}`;
};

export function labelOf(kind: RangeKind, fromDay: string, toDay: string): string {
  const [y, m] = ymd(fromDay);
  switch (kind) {
    case 'day':
      return dayLabel(fromDay);
    case 'week':
    case 'custom': {
      const [ty] = ymd(toDay);
      return `${shortLabel(fromDay)}${y === ty ? '' : ` ${y}`} – ${shortLabel(toDay)} ${ty}`;
    }
    case 'month':
      return `${MONTH_NAMES[m - 1]} ${y}`;
    case 'quarter':
      return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    case 'year':
      return String(y);
  }
}

export function periodOf(range: RangeSpec, zone: string): Period {
  const { fromDay, toDay } = spanDays(range);
  const from = startOfDay(fromDay, zone);
  const to = startOfDay(addDays(toDay, 1), zone);
  return { kind: range.kind, fromDay, toDay, from, to, days: dayNum(toDay) - dayNum(fromDay) + 1, label: labelOf(range.kind, fromDay, toDay) };
}

/** The neighbouring period, `dir` = -1 for the previous one, +1 for the next. */
export function shiftRange(range: RangeSpec, dir: -1 | 1): RangeSpec {
  const { fromDay, toDay } = spanDays(range);
  switch (range.kind) {
    case 'day':
      return { kind: 'day', anchor: addDays(range.anchor, dir) };
    case 'week':
      return { kind: 'week', anchor: addDays(range.anchor, 7 * dir) };
    case 'month':
      return { kind: 'month', anchor: addMonths(range.anchor, dir) };
    case 'quarter':
      return { kind: 'quarter', anchor: addMonths(range.anchor, 3 * dir) };
    case 'year': {
      const [y] = ymd(range.anchor);
      return { kind: 'year', anchor: `${y + dir}-01-01` };
    }
    case 'custom': {
      const len = dayNum(toDay) - dayNum(fromDay) + 1;
      const f = addDays(fromDay, len * dir);
      return { kind: 'custom', anchor: f, from: f, to: addDays(f, len - 1) };
    }
  }
}

/** The previous equivalent period, used for comparison. */
export const previousRange = (range: RangeSpec): RangeSpec => shiftRange(range, -1);

/** Default view: the week containing `today`. */
export const defaultRange = (today: string): RangeSpec => ({ kind: 'week', anchor: today });

/** Day numbers `fromDay..toDay`. */
export function dayNumbers(period: Pick<Period, 'fromDay' | 'toDay'>): number[] {
  const out: number[] = [];
  for (let n = dayNum(period.fromDay); n <= dayNum(period.toDay); n += 1) out.push(n);
  return out;
}
