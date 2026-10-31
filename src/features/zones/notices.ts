// Plain-language notices about clock changes for the zones in play. Every sentence comes from the zone
// engine (nextShift, shiftText, gapPeriods); a zone that never changes clocks gets no change notice and
// a pair whose gap never moves gets no gap notice.
import { cityOf, gapPeriods, humanSpan, nextShift, shiftText, wallAt } from '../../lib/tz';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEAR_SECS = 366 * 86400;

export interface ZoneRole {
  zone: string;
  /** Who the zone is: "Selected", "My zone", "Client zone". One zone can hold several roles. */
  roles: string[];
}

export interface ClockChangeLine {
  zone: string;
  roles: string[];
  /** "New York clocks go forward 1h, 8 Mar" or "No clock change is scheduled." */
  text: string;
  hasChange: boolean;
}

/** `8 Mar`, with the year appended when it is not the current year in that zone. */
export function dateText(sec: number, zone: string, nowSec: number): string {
  const w = wallAt(sec, zone);
  const base = `${w.date} ${MONTHS[w.month - 1] ?? ''}`;
  return w.year === wallAt(nowSec, zone).year ? base : `${base} ${w.year}`;
}

/** Merges roles per zone (first appearance keeps its position) and finds each zone's next clock change. */
export function clockChangeLines(entries: readonly { zone: string; role: string }[], nowSec: number): ClockChangeLine[] {
  const byZone = new Map<string, string[]>();
  for (const e of entries) {
    const roles = byZone.get(e.zone) ?? [];
    if (!roles.includes(e.role)) roles.push(e.role);
    byZone.set(e.zone, roles);
  }
  return [...byZone].map(([zone, roles]) => {
    const next = zone === 'UTC' ? null : nextShift(nowSec, zone);
    if (!next) return { zone, roles, text: 'No clock change is scheduled.', hasChange: false };
    const base = shiftText(next, nowSec);
    const w = wallAt(next.at, next.zone);
    const nowYear = wallAt(nowSec, next.zone).year;
    return { zone, roles, text: w.year === nowYear ? base : `${base} ${w.year}`, hasChange: true };
  });
}

export interface GapNotice {
  a: string;
  b: string;
  /** Always set: how far b is from a right now. */
  now: string;
  /** Present only when the gap moves within the next year. */
  changes: string[];
}

const gapPhrase = (gap: number, a: string, b: string): string =>
  gap === 0
    ? `${cityOf(b)} is at the same time as ${cityOf(a)}`
    : `${cityOf(b)} is ${humanSpan(gap)} ${gap < 0 ? 'behind' : 'ahead of'} ${cityOf(a)}`;

/**
 * The time difference between two zones over the next year. When both change clocks on the same dates
 * (Paris and Berlin) or neither does (Phoenix and Honolulu) the difference never moves and `changes` is
 * empty, so no notice is raised.
 */
export function gapNotice(a: string, b: string, nowSec: number): GapNotice | null {
  if (a === b) return null;
  const periods = gapPeriods(nowSec, nowSec + YEAR_SECS, a, b);
  const first = periods[0];
  if (!first) return null;
  const changes = periods.slice(1, 7).map((p) => `${gapPhrase(p.gap, a, b)} from ${dateText(p.start, a, nowSec)}`);
  return { a, b, now: gapPhrase(first.gap, a, b), changes };
}
