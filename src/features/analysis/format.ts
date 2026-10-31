// Number and time formatting shared by the screen, tooltips, insights and the Excel sheets.
const p2 = (n: number): string => String(n).padStart(2, '0');

/** "2h 05m", "45m", "0m". Rounded to the nearest minute. */
export function fmtHM(secs: number): string {
  const m = Math.round(secs / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${p2(m % 60)}m` : `${m}m`;
}

/** "2:05:13", the exact value for tooltips. */
export function fmtHMS(secs: number): string {
  const s = Math.round(secs);
  return `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

/** "12.5 h". */
export const fmtHours = (secs: number, digits = 1): string => `${(secs / 3600).toFixed(digits)} h`;

export const fmtPct = (fraction: number, digits = 0): string => `${(fraction * 100).toFixed(digits)}%`;

/** "+12%" / "-3%" / "0%". */
export function fmtSignedPct(fraction: number): string {
  const v = Math.round(fraction * 100);
  return `${v > 0 ? '+' : ''}${v}%`;
}

/** Minutes after midnight as "09:05"; values past 24:00 keep counting ("25:10"). */
export function fmtClock(minutes: number): string {
  const m = Math.round(minutes);
  return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
}

export const NOT_ENOUGH = 'Not enough data';
