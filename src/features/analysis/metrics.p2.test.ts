// Phase 2 metrics, worked out by hand: billable pauses, thinking, unconfirmed time, fixed fees, budget status
// and tags. The week is Mon 2 to Sun 8 March 2026 in UTC, now = Mon 9 March 12:00, 15 minute rounding up.
import { describe, expect, it } from 'vitest';

import { demoP2State, demoNowSec } from '../../mocks/demoSeed';
import { handle } from '../../mocks/ipcMock';
import type { Snapshot } from '../../lib/types';
import { NO_FILTERS } from './engine';
import { drill } from './drill';
import { buildInsights } from './insights';
import { analyze } from './metrics';
import { dayNum } from './range';
import { badNumbers, mkSnapshot, nowOf, params, type Spec } from './testkit';

const WEEK = { kind: 'week', anchor: '2026-03-04' } as const;
const DAY = (d: string) => ({ kind: 'day', anchor: d }) as const;

const run = (spec: Spec, over: Partial<ReturnType<typeof params>> = {}, basis: 'exact' | 'billable' = 'billable', range: Parameters<typeof params>[1] = WEEK) =>
  analyze(mkSnapshot(spec), params('UTC', range, over), nowOf(spec.now), basis);

const BASE: Spec = {
  now: '2026-03-09T12:00:00Z',
  projects: [{ id: 'pa', name: 'Alpha' }],
  tasks: [{ id: 't1', projectId: 'pa', state: 'stopped', stoppedAt: '2026-03-02T11:00:00Z' }],
  rates: [{ project: 'pa', cents: 6000, currency: 'EUR' }],
};

describe('billable pauses', () => {
  // Mon: work 09:00-10:00 (3600), pause 10:00-10:30 (1800), work 10:30-11:00 (1800).
  // Exact 5400; counted 5400 + 1800 = 7200, already a multiple of 900, so Billable 7200.
  const spec: Spec = {
    ...BASE,
    segs: [
      ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z', { segmentId: 'a' }],
      ['t1', '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z', { kind: 'billablePause', segmentId: 'p1' }],
      ['t1', '2026-03-02T10:30:00Z', '2026-03-02T11:00:00Z', { segmentId: 'b' }],
    ],
    shifts: [{ start: '09:00', end: '13:00' }],
  };
  const m = run(spec);

  it('is in Billable and not in Exact', () => {
    expect(m.volume.exact).toBe(5400);
    expect(m.volume.billable).toBe(7200);
    expect(m.pieces.pauseSecs).toBe(1800);
    expect(m.pieces.pausesShown).toBe(true);
    expect(m.time.bands[1]?.secs).toBe(5400);
    expect(m.time.hours.secs[10]).toBe(1800);
  });

  it('earns money and is in the rounding adjustment', () => {
    // 7200 s at 6000 cents per hour = 12000 cents; the numerator keeps rate x seconds.
    expect(m.money.numerators.EUR).toBe(6000 * 7200);
    expect(m.money.roundingSecs).toBe(1800);
    expect(m.money.roundingByProject.get('pa')).toBe(1800);
    expect(m.projects[0]?.exact).toBe(5400);
    expect(m.projects[0]?.billableSecs).toBe(7200);
    expect(m.projects[0]?.adjSecs).toBe(1800);
  });

  it('is not worked time in sessions, focus or shifts, and the gap stays a pause', () => {
    expect(m.focus.sessions).toBe(2);
    expect(m.focus.longest).toBe(3600);
    expect(m.focus.pauseCount).toBe(1);
    expect(m.focus.pauseSecs).toBe(1800);
    // Worked 5400 against worked + paused 7200.
    expect(m.focus.focusRatio).toBeCloseTo(0.75, 10);
    expect(m.shifts.worked).toBe(5400);
  });

  it('matches the same time without the pause, apart from Billable and the pause figure', () => {
    const without = run({ ...spec, segs: spec.segs?.filter((s) => s[3]?.kind !== 'billablePause') });
    expect(without.volume.exact).toBe(m.volume.exact);
    expect(without.focus.pauseCount).toBe(m.focus.pauseCount);
    expect(without.focus.focusRatio).toBe(m.focus.focusRatio);
    expect(without.focus.sessions).toBe(m.focus.sessions);
    expect(without.volume.billable).toBe(5400);
    expect(without.pieces.pauseSecs).toBe(0);
  });

  it('adds to the rounding adjustment next to real rounding', () => {
    // work 09:00-09:50 (3000) + pause 09:50-10:05 (900): counted 3900 rounds up to 4500; the adjustment is 1500 = 900 + 600.
    const mixed = run({
      ...BASE,
      segs: [
        ['t1', '2026-03-02T09:00:00Z', '2026-03-02T09:50:00Z'],
        ['t1', '2026-03-02T09:50:00Z', '2026-03-02T10:05:00Z', { kind: 'billablePause' }],
      ],
    });
    expect(mixed.volume.exact).toBe(3000);
    expect(mixed.volume.billable).toBe(4500);
    expect(mixed.money.roundingSecs).toBe(1500);
    expect(mixed.pieces.pauseSecs).toBe(900);
  });

  it('series and the previous period report pauses separately', () => {
    const two = run(spec, { compare: true });
    const mon = two.pieces.series.find((p) => p.fromDay === dayNum(two.period.fromDay));
    expect(mon?.pause).toBe(1800);
    expect(two.pieces.prevPauseSecs).toBe(0);
    expect(two.pieces.pauseDelta?.abs).toBe(1800);
  });

  it('is hidden together with Billable under a band filter', () => {
    const f = run(spec, { filters: { ...NO_FILTERS, band: 1 } });
    expect(f.billableAvailable).toBe(false);
    expect(f.pieces.pausesShown).toBe(false);
    expect(f.volume.exact).toBe(5400);
  });

  it('a day with only a pause has no NaN anywhere', () => {
    // Tuesday holds nothing but a pause 10:00-10:30; Monday has the work.
    const only = run(
      {
        ...BASE,
        segs: [
          ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'],
          ['t1', '2026-03-03T10:00:00Z', '2026-03-03T10:30:00Z', { kind: 'billablePause' }],
        ],
        settings: { dailyTargetHours: 3, weeklyTargetHours: 12 },
      },
      { compare: true },
      'billable',
      DAY('2026-03-03'),
    );
    expect(badNumbers(only)).toEqual([]);
    expect(only.hasData).toBe(false);
    expect(only.volume.exact).toBe(0);
    expect(only.volume.billable).toBe(1800);
    expect(only.pieces.pauseSecs).toBe(1800);
    expect(only.money.hourlyCents.EUR).toBeUndefined();
    expect(only.focus.focusRatio).toBeNull();
    expect(buildInsights(only, { hideEarnings: false, names: new Map() })).toEqual([]);
  });
});

describe('thinking and unconfirmed time', () => {
  // One recorded segment 10:00-11:00: work 10:00-10:20, thinking 10:20-10:40, work 10:40-11:00.
  const split: Spec = {
    ...BASE,
    segs: [
      ['t1', '2026-03-02T10:00:00Z', '2026-03-02T10:20:00Z', { segmentId: 'x' }],
      ['t1', '2026-03-02T10:20:00Z', '2026-03-02T10:40:00Z', { kind: 'thinking', segmentId: 'x' }],
      ['t1', '2026-03-02T10:40:00Z', '2026-03-02T11:00:00Z', { segmentId: 'x' }],
    ],
  };

  it('thinking counts in Exact and Billable and is reported on its own', () => {
    const m = run(split);
    expect(m.volume.exact).toBe(3600);
    expect(m.volume.billable).toBe(3600);
    expect(m.pieces.thinkingSecs).toBe(1200);
    expect(m.pieces.pauseSecs).toBe(0);
    expect(m.time.hours.secs[10]).toBe(3600);
    // Thinking fills the gap, so there is no pause; it is a stretch of its own (3 stretches of 20 minutes).
    expect(m.focus.pauseCount).toBe(0);
    expect(m.focus.sessions).toBe(3);
  });

  it('pending away time counts nowhere but is reported as unconfirmed', () => {
    // 11:00-11:20 pending (1200 s), a kept one is ignored, and it is cut to the period.
    const m = run({ ...split, gaps: [['t1', '2026-03-02T11:00:00Z', '2026-03-02T11:20:00Z', 'pending'], ['t1', '2026-03-02T12:00:00Z', '2026-03-02T12:10:00Z', 'keep']] });
    expect(m.volume.exact).toBe(3600);
    expect(m.pieces.unconfirmed).toEqual({ secs: 1200, count: 1, shown: true });
    const none = run({ ...split, gaps: [['t1', '2026-03-02T11:00:00Z', '2026-03-02T11:20:00Z', 'pending']] }, { filters: { ...NO_FILTERS, projectIds: ['other'] } });
    expect(none.pieces.unconfirmed.secs).toBe(0);
    const banded = run({ ...split, gaps: [['t1', '2026-03-02T11:00:00Z', '2026-03-02T11:20:00Z', 'pending']] }, { filters: { ...NO_FILTERS, band: 1 } });
    expect(banded.pieces.unconfirmed.shown).toBe(false);
  });
});

describe('stretches of one recorded segment', () => {
  it('a subtask switch does not split a session', () => {
    const m = run({
      ...BASE,
      segs: [
        ['t1', '2026-03-02T09:00:00Z', '2026-03-02T09:30:00Z', { segmentId: 's', subtaskId: 'a' }],
        ['t1', '2026-03-02T09:30:00Z', '2026-03-02T10:00:00Z', { segmentId: 's', subtaskId: 'b' }],
      ],
    });
    expect(m.focus.sessions).toBe(1);
    expect(m.focus.longest).toBe(3600);
  });

  it('a running segment joins the pieces before its last subtask switch', () => {
    // 10:00-10:30 closed, then the open piece from 10:30; at 11:00 the running session is 3600 s long.
    const spec: Spec = {
      ...BASE,
      now: '2026-03-02T11:00:00Z',
      tasks: [{ id: 't1', projectId: 'pa', state: 'running' }],
      segs: [
        ['t1', '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z', { segmentId: 'r', subtaskId: 'a' }],
        ['t1', '2026-03-02T10:30:00Z', null, { segmentId: 'r', subtaskId: 'b' }],
      ],
    };
    const m = run(spec, {}, 'billable', DAY('2026-03-02'));
    expect(m.liveCount).toBe(1);
    expect(m.volume.exact).toBe(3600);
    expect(m.focus.sessions).toBe(1);
    expect(m.focus.longest).toBe(3600);
  });
});

describe('fixed fee', () => {
  const spec: Spec = {
    now: '2026-03-09T12:00:00Z',
    projects: [
      { id: 'pa', name: 'Hourly', billable: true },
      { id: 'pf', name: 'Print run', billable: true, billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR', figures: { exactSecs: 7200, pauseSecs: 0, billableSecs: 7200, thinkingSecs: 0, effectiveHourlyCents: 50_000, timeValueCents: { EUR: 10_000 }, budget: null } },
    ],
    tasks: [
      { id: 't1', projectId: 'pa' },
      { id: 't3', projectId: 'pf' },
    ],
    // pf has a rate version too (its time is valued with it) but a fixed fee earns no hourly money.
    rates: [{ project: 'pf', cents: 5000, currency: 'EUR' }],
    segs: [
      ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'],
      ['t3', '2026-03-03T09:00:00Z', '2026-03-03T11:00:00Z'],
    ],
  };

  it('earns no hourly money and is never "No rate set"', () => {
    const m = run(spec);
    expect(m.money.numerators).toEqual({});
    // The hourly project has time and no rate; the fixed-fee project does not count as missing.
    expect(m.money.missingRate).toEqual(['pa']);
    expect(m.projects.find((p) => p.id === 'pf')?.rate).toBe('fixed');
    expect(m.projects.find((p) => p.id === 'pa')?.rate).toBe('none');
  });

  it('reports the effective hourly rate from the project figures', () => {
    const m = run(spec);
    // 100000 cents of fee over 2 billable hours is 50000 cents an hour.
    expect(m.fixedFee).toEqual([
      expect.objectContaining({ projectId: 'pf', feeCents: 100_000, currency: 'EUR', effectiveHourlyCents: 50_000, billableSecs: 7200 }),
    ]);
    const lines = buildInsights(m, { hideEarnings: false, names: new Map() }).filter((i) => i.metrics.includes('money.fixedFeeRate'));
    expect(lines[0]?.text).toContain('€500.00');
    const hidden = buildInsights(m, { hideEarnings: true, names: new Map() }).filter((i) => i.metrics.includes('money.fixedFeeRate'));
    expect(hidden[0]?.text).not.toContain('€');
    expect(hidden[0]?.text).toContain('••••');
  });

  it('has no rate before any billable time and honours the project filter', () => {
    const m = run({ ...spec, projects: [{ id: 'pa', name: 'Hourly' }, { id: 'pf', name: 'Print run', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR' }] });
    expect(m.fixedFee[0]?.effectiveHourlyCents).toBeNull();
    expect(buildInsights(m, { hideEarnings: false, names: new Map() }).some((i) => i.metrics.includes('money.fixedFeeRate'))).toBe(false);
    const only = run(spec, { filters: { ...NO_FILTERS, projectIds: ['pa'] } });
    expect(only.fixedFee).toEqual([]);
  });
});

describe('budget status', () => {
  const figures = (b: NonNullable<Snapshot['projects'][number]['figures']['budget']>) => ({ exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget: b });
  const spec: Spec = {
    ...BASE,
    projects: [
      { id: 'warn', name: 'Warn', figures: figures({ basis: 'hours', percent: 85, level: 80, needsTargetRate: false }) },
      { id: 'over', name: 'Over', figures: figures({ basis: 'hours', percent: 120, level: 100, needsTargetRate: false }) },
      { id: 'fine', name: 'Fine', figures: figures({ basis: 'hours', percent: 10, level: 0, needsTargetRate: false }) },
      { id: 'fee', name: 'Fee', billingType: 'fixedFee', fixedFeeCents: 50_000, feeCurrency: 'EUR', figures: figures({ basis: 'fee', percent: 0, level: 0, needsTargetRate: true }) },
      { id: 'old', name: 'Old', archived: true, figures: figures({ basis: 'hours', percent: 99, level: 80, needsTargetRate: false }) },
      { id: 'none', name: 'None' },
    ],
    tasks: [{ id: 't1', projectId: 'warn' }],
    segs: [['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z']],
  };

  it('lists budgets over first, then warnings, with the unmeasurable fee last', () => {
    const m = run(spec);
    expect(m.budgetStatus.map((b) => [b.projectId, b.level, b.percent])).toEqual([
      ['over', 100, 120],
      ['warn', 80, 85],
      ['fine', 0, 10],
      ['fee', 0, 0],
    ]);
    expect(m.budgetStatus.at(-1)?.needsTargetRate).toBe(true);
    expect(m.budgetStatus.find((b) => b.projectId === 'fee')?.basis).toBe('fee');
  });

  it('follows the project filter and writes an insight per alert', () => {
    const m = run(spec, { filters: { ...NO_FILTERS, projectIds: ['warn'] } });
    expect(m.budgetStatus.map((b) => b.projectId)).toEqual(['warn']);
    const text = buildInsights(run(spec), { hideEarnings: false, names: new Map() }).filter((i) => i.metrics.includes('budget.used')).map((i) => i.text);
    expect(text).toHaveLength(2);
    expect(text.join(' ')).toContain('Over has used 120% of its hours budget: over budget');
    expect(text.join(' ')).toContain('Warn has used 85% of its hours budget: a warning at 80%');
  });
});

describe('tags', () => {
  // t1 (tag a) Mon 09:00-10:00 = 3600; t2 (tags a and b) Mon 11:00-11:25 = 1500 exact, 1800 Billable;
  // t3 (no tag) Mon 12:00-12:15 = 900. Total Billable 6300, Exact 6000.
  const spec: Spec = {
    ...BASE,
    tags: [{ id: 'a', name: 'Concept', color: '#7c3aed' }, { id: 'b', name: 'Revision', color: '#0891b2' }, { id: 'gone', name: 'Gone', deleted: true }],
    tasks: [
      { id: 't1', projectId: 'pa', tags: ['a'] },
      { id: 't2', projectId: 'pa', tags: ['a', 'b'] },
      { id: 't3', projectId: 'pa' },
      { id: 't4', projectId: 'pa', tags: ['gone'] },
    ],
    segs: [
      ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'],
      ['t2', '2026-03-02T11:00:00Z', '2026-03-02T11:25:00Z'],
      ['t3', '2026-03-02T12:00:00Z', '2026-03-02T12:15:00Z'],
    ],
  };
  const m = run(spec);

  it('a task with two tags counts fully in each, so shares overlap', () => {
    const a = m.tags.stats.find((t) => t.id === 'a');
    const b = m.tags.stats.find((t) => t.id === 'b');
    expect(a?.secs).toBe(3600 + 1800);
    expect(b?.secs).toBe(1800);
    expect(a?.exact).toBe(3600 + 1500);
    expect(a?.taskCount).toBe(2);
    expect(m.tags.total).toBe(6300);
    expect(m.tags.untagged?.secs).toBe(900);
    expect(m.tags.multiTagTasks).toBe(1);
    // 5400/6300 + 1800/6300 = 7200/6300: the shares add past 100%, so they are never summed.
    expect((a?.share ?? 0) + (b?.share ?? 0)).toBeGreaterThan(1);
    expect(a?.share).toBeCloseTo(5400 / 6300, 10);
  });

  it('follows the Exact basis and leaves out deleted tags', () => {
    const e = run(spec, {}, 'exact');
    expect(e.tags.stats.find((t) => t.id === 'a')?.secs).toBe(3600 + 1500);
    expect(e.tags.total).toBe(6000);
    expect(m.tags.stats.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('compares each tag with the previous period', () => {
    const c = run({ ...spec, segs: [...(spec.segs ?? []), ['t1', '2026-02-24T09:00:00Z', '2026-02-24T09:30:00Z']] }, { compare: true });
    expect(c.tags.stats.find((t) => t.id === 'a')?.prevSecs).toBe(1800);
    expect(c.tags.stats.find((t) => t.id === 'b')?.prevSecs).toBe(0);
  });

  it('the tag filter keeps whole tasks, so Billable stays available and rounds as before', () => {
    const f = run(spec, { filters: { ...NO_FILTERS, tagIds: ['b'] } });
    expect(f.billableAvailable).toBe(true);
    expect(f.volume.exact).toBe(1500);
    // t2 still rounds as a whole task-day: 1500 s up to 1800 s, the same row as without the filter.
    expect(f.volume.billable).toBe(1800);
    expect(f.money.numerators.EUR).toBe(6000 * 1800);
    // The task keeps all its tags in the chart.
    expect(f.tags.stats.map((t) => [t.id, t.secs])).toEqual([['a', 1800], ['b', 1800]]);
    const any = run(spec, { filters: { ...NO_FILTERS, tagIds: ['a', 'b'] } });
    expect(any.volume.exact).toBe(3600 + 1500);
  });

  it('a band filter still hides Billable, a tag filter does not', () => {
    expect(run(spec, { filters: { ...NO_FILTERS, band: 1 } }).billableAvailable).toBe(false);
    expect(run(spec, { filters: { ...NO_FILTERS, tagIds: ['a'] } }).billableAvailable).toBe(true);
  });

  it('the filter also applies to pauses and pending away time', () => {
    const withPause: Spec = {
      ...spec,
      segs: [...(spec.segs ?? []), ['t2', '2026-03-02T11:25:00Z', '2026-03-02T11:40:00Z', { kind: 'billablePause' }], ['t1', '2026-03-02T10:00:00Z', '2026-03-02T10:15:00Z', { kind: 'billablePause' }]],
      gaps: [['t1', '2026-03-02T13:00:00Z', '2026-03-02T13:10:00Z', 'pending']],
    };
    const f = run(withPause, { filters: { ...NO_FILTERS, tagIds: ['b'] } });
    expect(f.pieces.pauseSecs).toBe(900);
    expect(f.pieces.unconfirmed.secs).toBe(0);
    expect(run(withPause, { filters: { ...NO_FILTERS, tagIds: ['a'] } }).pieces.unconfirmed.secs).toBe(600);
  });

  it('drill-down by tag lists the tasks that carry it', () => {
    const snap = mkSnapshot(spec);
    const res = drill(snap, params('UTC', WEEK), nowOf(spec.now), { title: 'Tag: Concept', tagId: 'a' });
    expect(res.tasks.map((t) => t.taskId).sort()).toEqual(['t1', 't2']);
    expect(res.totalSecs).toBe(3600 + 1500);
    const none = drill(snap, params('UTC', WEEK), nowOf(spec.now), { title: 'No tag', tagId: null });
    expect(none.tasks.map((t) => t.taskId)).toEqual(['t3']);
  });

  it('writes an insight that warns that tags overlap', () => {
    const t = buildInsights(m, { hideEarnings: false, names: new Map() }).find((i) => i.id === 'tags');
    expect(t?.metrics).toEqual(['tags.time']);
    expect(t?.text).toContain('Tags overlap');
  });
});

describe('the p2 demo seed', () => {
  const snapshot = handle(demoP2State(), 'get_snapshot', {}) as Snapshot;
  const now = demoNowSec();
  const m = analyze(snapshot, params('Europe/Lisbon', { kind: 'week', anchor: '2026-03-12' }), now, 'billable');

  it('shows the billable pause, thinking, pending time, the fixed fee and its budget', () => {
    expect(m.pieces.pauseSecs).toBe(1800);
    expect(m.pieces.thinkingSecs).toBe(1500);
    expect(m.pieces.unconfirmed.secs).toBe(1800);
    expect(m.volume.billable).toBeGreaterThan(m.volume.exact);
    expect(m.fixedFee.map((f) => f.projectId)).toEqual(['p-print']);
    expect(m.budgetStatus.find((b) => b.projectId === 'p-print')?.level).toBe(80);
    expect(m.tags.stats.length).toBeGreaterThan(1);
    expect(badNumbers(m)).toEqual([]);
  });
});
