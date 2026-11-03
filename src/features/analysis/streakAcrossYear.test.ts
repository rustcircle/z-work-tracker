// UI review R9: the current day streak looks back up to 400 days before the period, so the day totals it
// reads must reach that far. They used to start a week before 1 January of the period's year, which cut
// every long streak short during the first weeks of a year.
import { describe, expect, it } from 'vitest';

import { addDays, parseIso } from '../../lib/tz';
import { NO_FILTERS } from './engine';
import { analyze } from './metrics';
import { mkSnapshot } from './testkit';

/** One hour a day for `days` days up to and including `view`, and the streak a week-long view on `view` reports. */
function streakOn(days: number, view: string): number {
  const segs: [string, string, string | null][] = [];
  for (let i = 0; i < days; i += 1) {
    const d = addDays(view, i - (days - 1));
    segs.push(['t', `${d}T10:00:00Z`, `${d}T11:00:00Z`]);
  }
  const now = `${view}T18:00:00Z`;
  const snap = mkSnapshot({ now, projects: [{ id: 'p' }], tasks: [{ id: 't', projectId: 'p', state: 'paused' }], segs });
  const m = analyze(snap, { zone: 'UTC', range: { kind: 'week', anchor: view }, filters: NO_FILTERS, compare: false }, parseIso(now), 'exact');
  return m.consistency.streakCurrent;
}

describe('R9: the current day streak across New Year', () => {
  it('counts 60 days in a row seen on 13 January', () => {
    expect(streakOn(60, '2027-01-13')).toBe(60);
  });

  it('counts a 200-day streak seen on the first Monday of the year', () => {
    expect(streakOn(200, '2027-01-04')).toBe(200);
  });

  it('is unchanged away from New Year', () => {
    expect(streakOn(50, '2026-06-19')).toBe(50);
  });
});
