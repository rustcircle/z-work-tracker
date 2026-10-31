// Goals, money, forecast, shifts, zones, DST, midnight, comparison, filters, live delta and edge cases.
import { describe, expect, it } from 'vitest';

import { centsFromNumerator } from '../../lib/billing';
import { NO_FILTERS } from './engine';
import { analyze } from './metrics';
import { badNumbers, mkSnapshot, nowOf, params, plain, type Spec } from './testkit';

const BASE: Spec = {
  now: '2026-03-09T12:00:00Z',
  projects: [{ id: 'pa', name: 'Alpha' }, { id: 'pb', name: 'Beta' }, { id: 'pc', name: 'Admin', billable: false }],
  tasks: [
    { id: 't1', projectId: 'pa' },
    { id: 't2', projectId: 'pa' },
    { id: 't3', projectId: 'pb' },
    { id: 't4', projectId: 'pc' },
  ],
  segs: [
    ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:30:00Z'],
    ['t1', '2026-03-02T10:40:00Z', '2026-03-02T11:20:00Z'],
    ['t3', '2026-03-02T14:00:00Z', '2026-03-02T15:00:00Z'],
    ['t1', '2026-03-03T08:00:00Z', '2026-03-03T12:00:00Z'],
    ['t2', '2026-03-04T23:00:00Z', '2026-03-05T01:00:00Z'],
    ['t1', '2026-03-05T13:00:00Z', '2026-03-05T13:10:00Z'],
    ['t4', '2026-03-05T13:10:00Z', '2026-03-05T13:30:00Z'],
    ['t3', '2026-03-07T10:00:00Z', '2026-03-07T10:20:00Z'],
  ],
  rates: [{ project: 'pa', cents: 6000, currency: 'EUR' }, { project: 'pc', cents: 5000, currency: 'USD' }],
  settings: { dailyTargetHours: 3, weeklyTargetHours: 12 },
};
const WEEK = { kind: 'week', anchor: '2026-03-04' } as const;
const go = (spec: Spec, zone: string, range: Parameters<typeof params>[1], over = {}, basis: 'exact' | 'billable' = 'billable') =>
  analyze(mkSnapshot(spec), params(zone, range, over), nowOf(spec.now), basis);

describe('goals, money and forecast', () => {
  it('daily and weekly target attainment', () => {
    const g = go(BASE, 'UTC', WEEK).goals;
    // Daily target 10800: Monday 11400 and Tuesday 14400 reach it; 7 elapsed days.
    expect(g.daily?.daysReached).toBe(2);
    expect(g.daily?.daysCounted).toBe(7);
    expect(g.daily?.secs).toBe(0);
    // Weekly target 43200 against 36000 logged.
    expect(g.weekly?.secs).toBe(36000);
    expect(g.weekly?.attainment).toBeCloseTo(36000 / 43200);
    expect(g.configured).toBe(true);
  });

  it('unset targets give no goals, no overtime and no target line', () => {
    const m = go({ ...BASE, settings: {} }, 'UTC', WEEK);
    expect(m.goals.daily).toBeNull();
    expect(m.goals.weekly).toBeNull();
    expect(m.goals.configured).toBe(false);
    expect(m.consistency.overtime.source).toBeNull();
    expect(m.series.points.every((p) => p.target === null)).toBe(true);
  });

  it('earnings come from billable rows and the rate in force; unrated and non-billable projects earn nothing', () => {
    const m = go(BASE, 'UTC', WEEK).money;
    // Alpha: 30600 billable seconds at 6000 cents/h = 183,600,000 cent-seconds = 51000 cents.
    expect(m.numerators).toEqual({ EUR: 183_600_000 });
    expect(centsFromNumerator(m.numerators.EUR as number)).toBe(51000);
    expect(m.exactNumerators.EUR).toBe(6000 * 30000);
    expect(centsFromNumerator(m.roundingMoney.EUR as number)).toBe(1000);
    expect(m.roundingSecs).toBe(1800);
    expect(m.hourlyCents.EUR).toBe(6120);
    expect(m.missingRate).toEqual(['pb']);
    expect(m.billableFlagSecs).toBe(36000);
    expect(m.nonBillableSecs).toBe(1800);
    expect(m.billableShare).toBeCloseTo(36000 / 37800);
    expect(m.earnings.EUR?.map((p) => p.numerator).reduce((a, b) => a + b, 0)).toBe(183_600_000);
    expect(m.earnings.USD).toBeUndefined();
  });

  it('a rate change splits earnings at the change', () => {
    const spec: Spec = {
      ...BASE,
      rates: [
        { project: 'pa', cents: 6000, currency: 'EUR' },
        { project: 'pa', cents: 9000, currency: 'EUR', from: '2026-03-04' },
      ],
    };
    const m = go(spec, 'UTC', WEEK).money;
    // t1 Mon 8100 + Tue 14400 at 6000; t2 Wed 3600 (starts 23:00 Wed, after the change) and Thu 3600 at 9000; t1 Thu 900 at 9000.
    expect(m.numerators.EUR).toBe(6000 * (8100 + 14400) + 9000 * (3600 + 3600 + 900));
  });

  it('a zero rate is a real zero, not a missing rate', () => {
    const m = go({ ...BASE, rates: [{ project: 'pa', cents: 0, currency: 'EUR' }] }, 'UTC', WEEK).money;
    expect(m.numerators.EUR).toBe(0);
    expect(m.missingRate).toEqual(['pb']);
  });

  it('forecast extends the total linearly and says it is a projection basis', () => {
    const spec: Spec = {
      ...BASE,
      now: '2026-03-04T00:00:00Z',
      segs: [['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:30:00Z'], ['t1', '2026-03-03T08:00:00Z', '2026-03-03T12:00:00Z']],
    };
    const f = go(spec, 'UTC', WEEK, {}, 'exact').forecast;
    // 5400 + 14400 = 19800 logged over 2 of 7 days.
    expect(f.available).toBe(true);
    expect(f.projected).toBeCloseTo(19800 / (2 / 7));
    expect(f.basisText).toMatch(/linearly/);
    expect(f.target).toBe(12 * 3600);
  });

  it('forecast is unavailable for finished periods, single days and too little data', () => {
    expect(go(BASE, 'UTC', WEEK).forecast.available).toBe(false);
    expect(go(BASE, 'UTC', { kind: 'day', anchor: '2026-03-09' }).forecast.available).toBe(false);
    const early = go({ ...BASE, now: '2026-03-02T12:00:00Z' }, 'UTC', WEEK).forecast;
    expect(early.available).toBe(false);
    expect(early.reason).toBe('Not enough data');
  });

  it('budget burn projects the finish from the last 28 days', () => {
    const spec: Spec = {
      ...BASE,
      projects: [{ id: 'pa', name: 'Alpha', budgetHours: 10 }, { id: 'pb' }, { id: 'pc', billable: false }],
    };
    const b = go(spec, 'UTC', WEEK).budgets;
    expect(b).toHaveLength(1);
    // Alpha logged 30000 s of 36000; remaining 6000; pace 30000/28 per day -> ceil(5.6) = 6 days after 9 Mar.
    expect(b[0]?.loggedSecs).toBe(30000);
    expect(b[0]?.state).toBe('projected');
    expect(b[0]?.projectedFinish).toBe(Math.floor(Date.UTC(2026, 2, 15) / 86_400_000));
  });
});

describe('shifts', () => {
  // Two overlapping UTC windows on Monday 2 March: X 09-13 (30 min break), Y 11-15 (30 min break).
  const spec: Spec = {
    now: '2026-03-02T20:00:00Z',
    projects: [{ id: 'pa' }],
    tasks: [{ id: 't1', projectId: 'pa' }],
    segs: [['t1', '2026-03-02T10:00:00Z', '2026-03-02T14:00:00Z'], ['t1', '2026-03-02T15:30:00Z', '2026-03-02T16:00:00Z']],
    shifts: [
      { name: 'X', start: '09:00', end: '13:00', breakMinutes: 30, weekdays: [1] },
      { name: 'Y', start: '11:00', end: '15:00', breakMinutes: 30, weekdays: [1] },
    ],
  };
  const day = { kind: 'day', anchor: '2026-03-02' } as const;

  it('overlapping shifts never double count worked time', () => {
    const s = go(spec, 'UTC', day, {}, 'exact').shifts;
    const x = s.stats.find((v) => v.name === 'X');
    const y = s.stats.find((v) => v.name === 'Y');
    // 10-13 goes to X (earliest start), 13-14 to Y, 15:30-16:00 is outside.
    expect(x?.worked).toBe(10800);
    expect(y?.worked).toBe(3600);
    expect(s.worked).toBe(14400);
    expect(s.outside).toBe(1800);
    expect(s.worked + s.outside).toBe(16200);
    expect(s.outsideShare).toBeCloseTo(1800 / 16200);
  });

  it('scheduled hours, attainment, late start, early finish and coverage', () => {
    const s = go(spec, 'UTC', day, {}, 'exact').shifts;
    const x = s.stats.find((v) => v.name === 'X');
    const y = s.stats.find((v) => v.name === 'Y');
    expect(x?.scheduled).toBe(12600);
    expect(x?.attainment).toBeCloseTo(10800 / 12600);
    expect(y?.attainment).toBeCloseTo(3600 / 12600);
    expect(x?.lateStarts).toBe(1);
    expect(x?.avgLate).toBe(3600);
    expect(x?.earlyFinishes).toBe(0);
    expect(y?.avgLate).toBe(7200);
    expect(y?.avgEarly).toBe(3600);
    expect(x?.coverage).toBeCloseTo(10800 / 14400);
    expect(y?.coverage).toBeCloseTo(3600 / 14400);
    expect(s.overtime.secs).toBe(0);
  });

  it('only the due part of a window counts as scheduled', () => {
    const early = { ...spec, now: '2026-03-02T11:00:00Z' };
    const x = go(early, 'UTC', day, {}, 'exact').shifts.stats.find((v) => v.name === 'X');
    // At 11:00 two of the four window hours are due: 12600 * 2/4.
    expect(x?.scheduled).toBe(6300);
  });

  it('shift filter keeps only that shift and hides billable figures', () => {
    const m = go(spec, 'UTC', day, { filters: { ...NO_FILTERS, shiftKey: 'sh1' } });
    expect(m.volume.exact).toBe(3600);
    expect(m.billableAvailable).toBe(false);
    expect(m.basis).toBe('exact');
    expect(m.money.available).toBe(false);
    const outside = go(spec, 'UTC', day, { filters: { ...NO_FILTERS, shiftKey: '__outside' } });
    expect(outside.volume.exact).toBe(1800);
  });

  it('shifts are reported as not configured when none exist', () => {
    expect(go({ ...spec, shifts: [] }, 'UTC', day).shifts.configured).toBe(false);
  });

  it('overtime against shifts when shifts exist', () => {
    const long: Spec = { ...spec, segs: [['t1', '2026-03-02T09:00:00Z', '2026-03-02T18:00:00Z']] };
    const s = go(long, 'UTC', day, {}, 'exact').shifts;
    // Scheduled 12600 + 12600 = 25200 against 32400 logged.
    expect(s.overtime.secs).toBe(32400 - 25200);
    expect(s.overtime.days).toBe(1);
  });
});

describe('zones', () => {
  const spec: Spec = {
    now: '2026-03-09T12:00:00Z',
    projects: [{ id: 'pa' }],
    tasks: [{ id: 't1', projectId: 'pa' }],
    segs: [['t1', '2026-03-02T12:00:00Z', '2026-03-02T16:00:00Z'], ['t1', '2026-03-07T15:00:00Z', '2026-03-07T16:00:00Z']],
    settings: { myZone: 'UTC', clientZone: 'America/New_York' },
  };

  it('bands in both zones, client-hours overlap on weekdays only, and the gap change', () => {
    const z = go(spec, 'UTC', { kind: 'week', anchor: '2026-03-04' }, {}, 'exact').zonesView;
    // UTC 12-16 is Afternoon; New York (EST, UTC-5) 07-11 is Morning.
    expect(z.bandsMy).toEqual([0, 0, 18000, 0]);
    expect(z.bandsClient).toEqual([0, 18000, 0, 0]);
    // Client hours 09-17 EST = 14-22 UTC: Monday overlap 14-16 = 7200; Saturday does not count.
    expect(z.overlapSecs).toBe(7200);
    expect(z.overlapShare).toBeCloseTo(0.4);
    // New York clocks go forward on 8 March 07:00 UTC, so the gap changes inside the week.
    expect(z.gaps.map((g) => g.gapSecs)).toEqual([-18000, -14400]);
    expect(z.markers).toHaveLength(1);
    expect(z.markers[0]).toMatch(/New York clocks went forward 1h, 8 Mar/);
  });

  it('active zone differing from My zone still gives both zones side by side', () => {
    const z = go(spec, 'America/New_York', { kind: 'week', anchor: '2026-03-04' }, {}, 'exact').zonesView;
    expect(z.bandsMy).toEqual([0, 0, 18000, 0]);
    expect(z.bandsClient).toEqual([0, 18000, 0, 0]);
  });

  it('no client zone: zone view is unavailable and has no markers for UTC', () => {
    const z = go({ ...spec, settings: { myZone: 'UTC' } }, 'UTC', { kind: 'week', anchor: '2026-03-04' }).zonesView;
    expect(z.available).toBe(false);
    expect(z.markers).toEqual([]);
    expect(z.gaps).toEqual([]);
  });
});

describe('daylight saving and midnight', () => {
  const one = (zone: string, segs: Spec['segs'], range: Parameters<typeof params>[1], now = '2026-12-31T00:00:00Z') =>
    go({ now, projects: [{ id: 'pa' }], tasks: [{ id: 't1', projectId: 'pa' }], segs, settings: { myZone: zone } }, zone, range, {}, 'exact');

  it('a 25-hour fall-back day: band totals follow the real clock and the repeated hour is one bucket', () => {
    // Lisbon 25 October 2026: 00:00 WEST (23:00Z on the 24th) to 00:00 WET (00:00Z on the 26th).
    const m = one('Europe/Lisbon', [['t1', '2026-10-24T23:00:00Z', '2026-10-26T00:00:00Z']], { kind: 'day', anchor: '2026-10-25' });
    expect(m.period.to - m.period.from).toBe(90000);
    expect(m.volume.exact).toBe(90000);
    expect(m.time.bands.map((b) => b.secs)).toEqual([25200, 21600, 21600, 21600]);
    expect(m.time.hours.secs[1]).toBe(7200);
    expect(m.time.hours.secs.reduce((a, b) => a + b, 0)).toBe(90000);
    expect(m.series.unit).toBe('hour');
    expect(m.series.points[1]?.exact).toBe(7200);
    expect(m.series.markers.map((k) => k.index)).toEqual([1]);
  });

  it('a 23-hour spring-forward day leaves the skipped hour empty', () => {
    // Lisbon 29 March 2026: 00:00Z to 23:00Z.
    const m = one('Europe/Lisbon', [['t1', '2026-03-29T00:00:00Z', '2026-03-29T23:00:00Z']], { kind: 'day', anchor: '2026-03-29' });
    expect(m.period.to - m.period.from).toBe(82800);
    expect(m.time.bands.map((b) => b.secs)).toEqual([18000, 21600, 21600, 21600]);
    expect(m.time.hours.secs[1]).toBe(0);
    expect(m.time.hours.secs[0]).toBe(3600);
    expect(m.time.hours.secs[2]).toBe(3600);
  });

  it('a segment crossing local midnight splits across days, bands and billable rows', () => {
    // New York 23:30 on 3 March to 00:30 on 4 March (EST).
    const m = one('America/New_York', [['t1', '2026-03-04T04:30:00Z', '2026-03-04T05:30:00Z']], { kind: 'week', anchor: '2026-03-04' });
    expect(m.series.points.map((p) => p.exact)).toEqual([0, 1800, 1800, 0, 0, 0, 0]);
    expect(m.time.bands.map((b) => b.secs)).toEqual([1800, 0, 0, 1800]);
    expect(m.focus.sessions).toBe(1);
    expect(m.focus.dist.reduce((n, b) => n + b.count, 0)).toBe(1);
  });

  it('billable rounds once per task per day in the zone shown', () => {
    const segs: Spec['segs'] = [['t1', '2026-03-04T04:30:00Z', '2026-03-04T04:40:00Z'], ['t1', '2026-03-04T04:50:00Z', '2026-03-04T05:00:00Z']];
    const snap = (zone: string) =>
      analyze(mkSnapshot({ now: '2026-03-10T00:00:00Z', projects: [{ id: 'pa' }], tasks: [{ id: 't1', projectId: 'pa' }], segs }), params(zone, { kind: 'week', anchor: '2026-03-04' }), nowOf('2026-03-10T00:00:00Z'), 'billable');
    // In UTC both ten-minute segments are on 4 March: 1200 s rounds up once to 1800.
    expect(snap('UTC').volume.billable).toBe(1800);
    // In New York 04:30Z is 23:30 on the 3rd and 04:50Z..05:00Z is 23:50..00:00: still one day.
    expect(snap('America/New_York').volume.exact).toBe(snap('UTC').volume.exact);
  });
});

describe('comparison, filters and degenerate data', () => {
  it('comparison against the previous equivalent period', () => {
    const spec: Spec = { ...BASE, now: '2026-03-13T12:00:00Z', segs: [...(BASE.segs ?? []), ['t1', '2026-03-10T08:00:00Z', '2026-03-10T09:00:00Z']] };
    const m = go(spec, 'UTC', { kind: 'week', anchor: '2026-03-11' }, { compare: true }, 'exact');
    expect(m.prevPeriod?.fromDay).toBe('2026-03-02');
    expect(m.volume.deltaTotal).toEqual({ value: 3600, prev: 36000, abs: -32400, pct: -0.9 });
    expect(m.volume.deltaActive?.prev).toBe(5);
    expect(m.series.points[1]?.prev).toBe(14400);
  });

  it('comparison is empty when not requested', () => {
    const m = go(BASE, 'UTC', WEEK);
    expect(m.prevPeriod).toBeNull();
    expect(m.volume.deltaTotal).toBeNull();
  });

  it('project, task and band filters', () => {
    const p = go(BASE, 'UTC', WEEK, { filters: { ...NO_FILTERS, projectIds: ['pb'] } }, 'exact');
    expect(p.volume.exact).toBe(4800);
    const t = go(BASE, 'UTC', WEEK, { filters: { ...NO_FILTERS, taskIds: ['t2'] } }, 'exact');
    expect(t.volume.exact).toBe(7200);
    const b = go(BASE, 'UTC', WEEK, { filters: { ...NO_FILTERS, band: 1 } }, 'exact');
    expect(b.volume.exact).toBe(23400);
    expect(b.time.bands.map((x) => x.secs)).toEqual([0, 23400, 0, 0]);
    expect(b.money.available).toBe(false);
  });

  it('empty data has no NaN, no infinities and a clear empty state', () => {
    const m = go({ now: '2026-03-09T12:00:00Z', projects: [{ id: 'pa' }], tasks: [{ id: 't1', projectId: 'pa' }], settings: { dailyTargetHours: 6, weeklyTargetHours: 30 } }, 'UTC', WEEK, { compare: true });
    expect(m.hasData).toBe(false);
    expect(badNumbers(m)).toEqual([]);
    expect(m.volume.avgPerActiveDay).toBeNull();
    expect(m.focus.avg).toBeNull();
    expect(m.focus.focusRatio).toBeNull();
    expect(m.consistency.start).toBeNull();
    expect(m.consistency.regularity).toBeNull();
    expect(m.time.mostBand).toBeNull();
  });

  it('a single segment has no NaN and not enough data for spreads', () => {
    const m = go({ now: '2026-03-09T12:00:00Z', projects: [{ id: 'pa' }], tasks: [{ id: 't1', projectId: 'pa' }], segs: [['t1', '2026-03-03T08:00:00Z', '2026-03-03T09:00:00Z']] }, 'UTC', WEEK, { compare: true });
    expect(badNumbers(m)).toEqual([]);
    expect(m.focus.sessions).toBe(1);
    expect(m.focus.median).toBe(3600);
    expect(m.consistency.start).toBeNull();
    expect(m.volume.activeDays).toBe(1);
  });

  it('full-size data stays finite across every range kind', () => {
    for (const kind of ['day', 'week', 'month', 'quarter', 'year'] as const) {
      const m = go(BASE, 'Europe/Lisbon', { kind, anchor: '2026-03-04' }, { compare: true });
      expect(badNumbers(m)).toEqual([]);
    }
    const custom = go(BASE, 'UTC', { kind: 'custom', anchor: '2026-03-01', from: '2026-03-01', to: '2026-03-20' }, { compare: true });
    expect(custom.period.days).toBe(20);
    expect(custom.prevPeriod?.fromDay).toBe('2026-02-09');
  });
});

describe('the live delta', () => {
  const closedSpec = (end: string): Spec => ({
    now: end,
    zone: 'Europe/Lisbon',
    projects: [{ id: 'pa', budgetHours: 20 }, { id: 'pb' }],
    tasks: [{ id: 't1', projectId: 'pa', state: 'running' }, { id: 't2', projectId: 'pb', state: 'paused' }],
    segs: [
      ['t2', '2026-03-02T08:00:00Z', '2026-03-02T09:00:00Z'],
      ['t1', '2026-03-02T09:00:00Z', '2026-03-02T09:50:00Z'],
      ['t1', '2026-03-03T08:00:00Z', '2026-03-03T11:10:00Z'],
      ['t2', '2026-03-04T10:00:00Z', '2026-03-04T10:20:00Z'],
      ['t1', '2026-03-04T10:30:00Z', end],
    ],
    rates: [{ project: 'pa', cents: 7000, currency: 'USD' }, { project: 'pb', cents: 5000, currency: 'EUR' }],
    shifts: [{ name: 'Morning', start: '09:00', end: '13:00', zone: 'Europe/Lisbon', breakMinutes: 30, weekdays: [1, 2, 3, 4, 5] }],
    settings: { myZone: 'Europe/Lisbon', clientZone: 'America/New_York', dailyTargetHours: 6, weeklyTargetHours: 20 },
  });

  it.each([
    ['day', '2026-03-04T11:07:00Z'],
    ['week', '2026-03-04T11:07:00Z'],
    ['month', '2026-03-04T12:30:41Z'],
  ] as const)('a running segment gives the same figures as the same segment closed at the same instant (%s)', (kind, now) => {
    const range = { kind, anchor: '2026-03-04' } as const;
    const open = mkSnapshot(closedSpec(now));
    const openSnap = { ...open, segments: open.segments.map((s) => (s.end === now ? { ...s, end: null } : s)) };
    const a = analyze(openSnap, params('Europe/Lisbon', range, { compare: true }), nowOf(now), 'billable');
    const b = analyze(mkSnapshot(closedSpec(now)), params('Europe/Lisbon', range, { compare: true }), nowOf(now), 'billable');
    expect(a.liveCount).toBe(1);
    expect(plain({ ...a, liveCount: 0 })).toEqual(plain({ ...b, liveCount: 0 }));
  });

  it('later ticks only move the live part', () => {
    const base = mkSnapshot(closedSpec('2026-03-04T11:07:00Z'));
    const snap = { ...base, segments: base.segments.map((s) => (s.end === '2026-03-04T11:07:00Z' ? { ...s, end: null } : s)) };
    const p = params('Europe/Lisbon', { kind: 'week', anchor: '2026-03-04' });
    const t0 = nowOf('2026-03-04T11:07:00Z');
    const m0 = analyze(snap, p, t0, 'exact');
    const m1 = analyze(snap, p, t0 + 90, 'exact');
    expect(m1.volume.exact - m0.volume.exact).toBe(90);
    expect(m1.focus.sessions).toBe(m0.focus.sessions);
  });
});
