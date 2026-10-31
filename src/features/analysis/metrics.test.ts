// Hand-computed fixtures. The UTC week of 2 to 8 March 2026 is worked out in the comments.
import { describe, expect, it } from 'vitest';

import { analyze } from './metrics';
import { mkSnapshot, nowOf, params, type Spec } from './testkit';

// Week Mon 2 Mar .. Sun 8 Mar 2026, UTC, 15 min rounding up (the default), now = Mon 9 Mar 12:00.
//   Mon: t1 09:00-10:30, t1 10:40-11:20, t3 14:00-15:00      = 11400 s
//   Tue: t1 08:00-12:00                                     = 14400 s
//   Wed: t2 23:00 -> Thu 01:00 (crosses midnight)            = 3600 on Wed, 3600 on Thu
//   Thu: t1 13:00-13:10, t4 13:10-13:30                      = 1800 s (+3600 from t2)
//   Sat: t3 10:00-10:20                                      = 1200 s
// Total 36000 s. Bands: Night 3600, Morning 23400, Afternoon 5400, Evening 3600.
const WEEK: Spec = {
  now: '2026-03-09T12:00:00Z',
  projects: [{ id: 'pa', name: 'Alpha' }, { id: 'pb', name: 'Beta' }, { id: 'pc', name: 'Admin', billable: false }],
  tasks: [
    { id: 't1', projectId: 'pa', state: 'stopped', stoppedAt: '2026-03-05T14:10:00Z' },
    { id: 't2', projectId: 'pa', state: 'stopped', stoppedAt: '2026-03-05T01:00:00Z' },
    { id: 't3', projectId: 'pb', state: 'paused' },
    { id: 't4', projectId: 'pc', state: 'stopped', stoppedAt: '2026-03-05T13:30:00Z' },
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
const WEEK_RANGE = { kind: 'week', anchor: '2026-03-04' } as const;

const run = (spec: Spec = WEEK, over: Partial<ReturnType<typeof params>> = {}, basis: 'exact' | 'billable' = 'billable') => {
  const snap = mkSnapshot(spec);
  return analyze(snap, params('UTC', WEEK_RANGE, over), nowOf(spec.now), basis);
};

describe('volume', () => {
  it('totals, active days and averages', () => {
    const m = run();
    expect(m.period.fromDay).toBe('2026-03-02');
    expect(m.period.toDay).toBe('2026-03-08');
    expect(m.volume.exact).toBe(36000);
    // Billable rows: t1 Mon 7800->8100, t3 Mon 3600, t1 Tue 14400, t2 Wed 3600, t2 Thu 3600,
    // t1 Thu 600->900, t4 Thu 1200->1800, t3 Sat 1200->1800 = 37800.
    expect(m.volume.billable).toBe(37800);
    expect(m.volume.primary).toBe(37800);
    expect(m.volume.activeDays).toBe(5);
    expect(m.volume.elapsedDays).toBe(7);
    expect(m.volume.avgPerActiveDay).toBe(37800 / 5);
    expect(m.volume.avgPerCalendarDay).toBe(37800 / 7);
    expect(m.volume.perWeek).toBe(37800);
  });

  it('exact basis uses segment time', () => {
    const m = run(WEEK, {}, 'exact');
    expect(m.volume.primary).toBe(36000);
    expect(m.volume.avgPerActiveDay).toBe(7200);
  });

  it('series buckets are days and add up to the total', () => {
    const m = run(WEEK, {}, 'exact');
    expect(m.series.unit).toBe('day');
    expect(m.series.points.map((p) => p.exact)).toEqual([11400, 14400, 3600, 5400, 0, 1200, 0]);
    expect(m.series.points.reduce((n, p) => n + p.exact, 0)).toBe(m.volume.exact);
    expect(m.series.points[0]?.target).toBe(3 * 3600);
  });
});

describe('time of day', () => {
  it('bands sum to the period total', () => {
    const m = run();
    expect(m.time.bands.map((b) => b.secs)).toEqual([3600, 23400, 5400, 3600]);
    expect(m.time.bands.reduce((n, b) => n + b.secs, 0)).toBe(m.volume.exact);
    expect(m.time.bands[1]?.share).toBeCloseTo(23400 / 36000);
    expect(m.time.bands[1]?.avgPerActiveDay).toBe(23400 / 5);
    expect(m.time.mostBand).toBe(1);
    expect(m.time.leastBand).toBe(0);
  });

  it('hour histogram and weekday heatmap', () => {
    const m = run();
    const h = m.time.hours.secs;
    expect([h[0], h[8], h[9], h[10], h[11], h[13], h[14], h[23]]).toEqual([3600, 3600, 7200, 7800, 4800, 1800, 3600, 3600]);
    expect(h.reduce((a, b) => a + b, 0)).toBe(36000);
    expect(m.time.hours.peak).toBe(10);
    // Tuesday (index 1) 08-12 = 3600 per hour; Thursday (3) hour 13 = 1800.
    expect(m.time.heat.cells[1 * 24 + 9]).toBe(3600);
    expect(m.time.heat.cells[3 * 24 + 13]).toBe(1800);
    expect(m.time.heat.cells.reduce((a, b) => a + b, 0)).toBe(36000);
  });

  it('most and least active weekday', () => {
    const m = run();
    expect(m.time.weekdays.map((w) => w.secs)).toEqual([11400, 14400, 3600, 5400, 0, 1200, 0]);
    expect(m.time.mostWeekday).toBe(1);
    expect(m.time.leastWeekday).toBe(4);
    expect(m.time.weekdays[0]?.avgSecs).toBe(11400);
  });

  it('calendar year covers the days of the period', () => {
    const m = run();
    expect(m.time.calendar.year).toBe(2026);
    expect(m.time.calendar.days).toHaveLength(365);
    expect(m.time.calendar.days.find((d) => d.day === '2026-03-03')?.secs).toBe(14400);
  });
});

describe('projects and tasks', () => {
  it('project totals in both bases, shares and ranking', () => {
    const m = run();
    const by = Object.fromEntries(m.projects.map((p) => [p.id, p]));
    expect(by.pa?.exact).toBe(30000);
    expect(by.pa?.billableSecs).toBe(30600);
    expect(by.pb?.exact).toBe(4800);
    expect(by.pb?.billableSecs).toBe(5400);
    expect(by.pc?.billableSecs).toBe(1800);
    expect(m.projects.map((p) => p.id)).toEqual(['pa', 'pb', 'pc']);
    expect(m.projects.reduce((n, p) => n + p.secs, 0)).toBe(m.volume.primary);
    expect(by.pa?.share).toBeCloseTo(30600 / 37800);
    expect(by.pa?.taskCount).toBe(2);
    expect(by.pa?.avgPerTask).toBe(15300);
    // Beta is billable with no rate at all: "No rate set", not zero.
    expect(by.pb?.rate).toBe('none');
    expect(by.pc?.rate).toBe('not-billable');
    expect(by.pa?.rate).toBe('set');
  });

  it('task statistics', () => {
    const m = run(WEEK, {}, 'exact');
    // Exact per task: t1 22800, t2 7200, t3 4800, t4 1200.
    expect(m.tasks.withTime).toBe(4);
    expect(m.tasks.avg).toBe(9000);
    expect(m.tasks.median).toBe((4800 + 7200) / 2);
    expect(m.tasks.longest?.id).toBe('t1');
    expect(m.tasks.top.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    // t1 stopped Thu 14:10, first start Mon 09:00; t2 Thu 01:00 from Wed 23:00; t4 Thu 13:30 from 13:10.
    expect(m.tasks.completed).toBe(3);
    expect(m.tasks.inProgress).toBe(1);
    expect(m.tasks.ageLongest).toBe(3 * 86400 + 5 * 3600 + 10 * 60);
    expect(m.tasks.ageMedian).toBe(7200);
    // t1 has time on Mon, Tue, Thu; t2 on Wed and Thu; t3 on Mon and Sat.
    expect(m.tasks.multiDay).toBe(3);
  });
});

describe('focus and sessions', () => {
  it('session statistics, distribution and fragmentation', () => {
    const f = run().focus;
    // Sessions: 5400, 2400, 3600, 14400, 7200, 600, 1200, 1200.
    expect(f.sessions).toBe(8);
    expect(f.avg).toBe(4500);
    expect(f.median).toBe(3000);
    expect(f.longest).toBe(14400);
    expect(f.dist.map((b) => b.count)).toEqual([0, 1, 2, 1, 0, 2, 1, 1]);
    expect(f.fragmentation).toBeCloseTo(3000 / 36000);
    expect(f.streak?.secs).toBe(14400);
  });

  it('only same-day gaps count as pauses; overnight and multi-day gaps are breaks', () => {
    const f = run().focus;
    // Counted: t1 Mon 10:30 -> 10:40 = 600 and t1 Thu 13:10 -> stop 14:10 = 3600.
    // Not counted: t1 Mon 11:20 -> Tue 08:00 (74400), t1 Tue 12:00 -> Thu 13:00 (176400), t3 Mon 15:00 -> Sat 10:00 (414000).
    expect(f.pauseCount).toBe(2);
    expect(f.pauseSecs).toBe(4200);
    expect(f.pauseAvg).toBe(2100);
    expect(f.pausesPerTask).toBe(2 / 4);
    expect(f.focusRatio).toBeCloseTo(36000 / (36000 + 4200));
    const mon = f.daily[0];
    expect(mon?.paused).toBe(600);
    // No day can show more paused time than it has hours.
    for (const d of f.daily) expect(d.paused).toBeLessThanOrEqual(86400);
  });

  it('context switches count task changes inside a day', () => {
    const f = run().focus;
    // Monday t1 -> t1 -> t3 = 1 switch; Thursday t1 -> t4 = 1 switch.
    expect(f.switchesTotal).toBe(2);
    expect(f.switchesPerActiveDay).toBe(2 / 5);
    expect(f.daily.map((d) => d.switches)).toEqual([1, 0, 0, 1, 0, 0, 0]);
  });
});

describe('consistency', () => {
  it('typical start and finish', () => {
    const c = run().consistency;
    // Starts (minutes): Mon 540, Tue 480, Wed 1380, Thu 780, Sat 600 -> sorted 480 540 600 780 1380.
    expect(c.start?.n).toBe(5);
    expect(c.start?.median).toBe(600);
    expect(c.start?.q1).toBe(540);
    expect(c.start?.q3).toBe(780);
    // Finishes: Mon 900, Tue 720, Wed 1500 (past midnight), Thu 810, Sat 620.
    expect(c.finish?.median).toBe(810);
    expect(c.finish?.q3).toBe(900);
    expect(c.spanMedian).toBe(120);
  });
});
