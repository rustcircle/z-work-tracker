// Display helpers shared by the whole UI. Zone arithmetic comes from lib/tz.ts; nothing here uses
// Intl or Date for time-zone math.
import { MASK, moneyTotals, type Numerators } from '../lib/billing';
import { abbrAt, addDays, wallAt, weekdayOf } from '../lib/tz';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "2h 05m", "45m 10s", "30s". Hours drop the seconds; the tooltip form is `formatHMS`. */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return r > 0 ? `${m}m ${pad2(r)}s` : `${m}m`;
  return `${r}s`;
}

/** "1:02:03". */
export function formatHMS(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** `HH:MM` on the wall clock of `zone`. */
export function clock(sec: number, zone: string): string {
  const w = wallAt(sec, zone);
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}

export function clockSeconds(sec: number, zone: string): string {
  const w = wallAt(sec, zone);
  return `${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}`;
}

/** "Thu 12 Mar 2026". */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[weekdayOf(day) - 1]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** "12 Mar". */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}

export function relativeDay(day: string, today: string): string {
  if (day === today) return `Today, ${dayLabel(day)}`;
  if (day === addDays(today, -1)) return `Yesterday, ${dayLabel(day)}`;
  return dayLabel(day);
}

/** "just now", "2 min ago", "3 h ago", "4 d ago". */
export function ago(sec: number, nowSec: number): string {
  const d = Math.max(0, nowSec - sec);
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

/** Wall time with abbreviation, for tooltips: "14:00:00 WET". */
export function clockWithAbbr(sec: number, zone: string): string {
  return `${clockSeconds(sec, zone)} ${abbrAt(sec, zone)}`;
}

/** Money for display: masked when earnings are hidden, empty when there is nothing to show. */
export function amountText(n: Numerators, hide: boolean): string {
  const text = moneyTotals(n);
  if (text === '') return '';
  return hide ? MASK : text;
}

export const hasAmount = (n: Numerators): boolean => n.EUR !== undefined || n.USD !== undefined;

export function addNumerators(a: Numerators, b: Numerators): Numerators {
  const out: Numerators = { ...a };
  for (const c of ['EUR', 'USD'] as const) {
    if (b[c] !== undefined) out[c] = (out[c] ?? 0) + (b[c] as number);
  }
  return out;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
