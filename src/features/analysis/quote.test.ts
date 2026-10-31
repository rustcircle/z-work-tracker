import { describe, expect, it } from 'vitest';

import { parseIso, toIso } from '../../lib/tz';
import type { PieceKind, Project, RateVersion, RoundingVersion, Segment, Task } from '../../lib/types';
import { fullProject, fullTask } from '../../mocks/factories';
import { MAX_COMPARABLES, MIN_SCORE, nameTokens, quantile, quoteFor, type QuoteData, type QuoteInput, type QuoteResult } from './quote';

const NOW = parseIso('2026-03-12T15:20:00Z');
const stamp = { at: '2026-01-01T00:00:00Z', by: 'dev' };

interface TaskSpec {
  id: string;
  name: string;
  tags?: string[];
  projectId?: string;
  state?: Task['state'];
  stoppedAt?: string | null;
  /** One closed segment of this many minutes per entry, each on its own day from 1 Feb, starting 09:00 UTC. */
  mins?: number[];
  /** Extra pieces: [start, end, kind] in ISO UTC. */
  pieces?: [string, string, PieceKind | undefined][];
  open?: boolean;
}

function build(specs: TaskSpec[], extra: { projects?: Project[]; rates?: RateVersion[]; rounding?: RoundingVersion[] } = {}): QuoteData {
  const tasks: Task[] = [];
  const segments: Segment[] = [];
  let n = 0;
  const piece = (taskId: string, start: string, end: string | null, kind?: PieceKind): void => {
    n += 1;
    segments.push({ id: `s${n}`, taskId, deviceId: 'dev', start, end, provisionalEnd: null, ...(kind ? { kind } : {}) });
  };
  for (const [ti, s] of specs.entries()) {
    tasks.push(fullTask({ id: s.id, name: s.name, projectId: s.projectId ?? 'p', state: s.state ?? 'stopped', tags: s.tags ?? [], stoppedAt: s.stoppedAt === undefined ? `2026-02-${String(10 + ti).padStart(2, '0')}T12:00:00Z` : s.stoppedAt }));
    for (const [i, m] of (s.mins ?? []).entries()) {
      const day = String(1 + i).padStart(2, '0');
      piece(s.id, `2026-02-${day}T09:00:00Z`, toIso(parseIso(`2026-02-${day}T09:00:00Z`) + m * 60));
    }
    for (const [a, b, kind] of s.pieces ?? []) piece(s.id, a, b, kind);
    if (s.open) piece(s.id, '2026-03-12T14:00:00Z', null);
  }
  return {
    tasks,
    segments,
    projects: extra.projects ?? [fullProject({ id: 'p', name: 'Project P' })],
    rates: extra.rates ?? [{ id: 'r1', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 5000, currency: 'EUR', deleted: false, stamp }],
    rounding: extra.rounding ?? [],
  };
}

const ask = (data: QuoteData, input: Partial<QuoteInput> = {}): QuoteResult => quoteFor(data, { name: 'Logo', tags: [], projectId: 'p', ...input }, 'UTC', NOW);

function estimate(r: QuoteResult) {
  if (r.kind !== 'estimate') throw new Error(`expected an estimate, got ${r.kind}`);
  return r;
}

/** Logo jobs of 1, 2, 3, 4 hours (already on the 15-minute grid), newest last. */
const LOGOS: TaskSpec[] = [
  { id: 'a', name: 'Logo concepts', mins: [60], stoppedAt: '2026-02-10T12:00:00Z' },
  { id: 'b', name: 'Logo draft', mins: [120], stoppedAt: '2026-02-11T12:00:00Z' },
  { id: 'c', name: 'Logo revision', mins: [180], stoppedAt: '2026-02-12T12:00:00Z' },
  { id: 'd', name: 'Logo final', mins: [240], stoppedAt: '2026-02-13T12:00:00Z' },
];

describe('nameTokens', () => {
  it('lowercases, splits on anything that is not a letter or digit, drops short words and filler, and removes repeats', () => {
    expect(nameTokens('Logo-Concepts, v2 (for the NEW brand) logo')).toEqual(['logo', 'concepts', 'brand']);
  });
  it('keeps letters outside ASCII and digits inside longer tokens', () => {
    expect(nameTokens('Café Müller 2026')).toEqual(['café', 'müller', '2026']);
  });
  it('drops the generic words task, job, work and project', () => {
    expect(nameTokens('Job task work project')).toEqual([]);
  });
});

describe('quantile (linear interpolation between closest ranks)', () => {
  it('matches the documented method on small samples', () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(2); // h = 0.75 -> 1 + 0.75 * 1 = 1.75, rounded to whole seconds
    expect(quantile([100, 200, 300, 400], 0.25)).toBe(175);
    expect(quantile([100, 200, 300, 400], 0.75)).toBe(325);
    expect(quantile([1, 2, 3, 4, 10], 0.25)).toBe(2);
    expect(quantile([1, 2, 3, 4, 10], 0.75)).toBe(4);
  });
  it('the median of an even sample is the mean of the two middle values; of an odd one the middle value', () => {
    expect(quantile([10, 20], 0.5)).toBe(15);
    expect(quantile([10, 20, 90], 0.5)).toBe(20);
  });
  it('a single value is every quantile, and an empty sample is 0', () => {
    expect([quantile([7], 0), quantile([7], 0.5), quantile([7], 1)]).toEqual([7, 7, 7]);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('when there is nothing to compare', () => {
  it('a job with no usable word and no tag has no criteria', () => {
    expect(ask(build(LOGOS), { name: '  the job ', tags: [] })).toEqual({ kind: 'noCriteria' });
    expect(ask(build(LOGOS), { name: '', tags: [] })).toEqual({ kind: 'noCriteria' });
  });
  it('without any stopped task there is not enough data, and only stopped tasks count', () => {
    const none = build([{ id: 'x', name: 'Logo concepts', state: 'running', mins: [60] }, { id: 'y', name: 'Logo draft', state: 'paused', mins: [60] }, { id: 'z', name: 'Logo final', state: 'draft' }]);
    expect(ask(none)).toMatchObject({ kind: 'notEnoughData', n: 0, comparables: [], needed: 3 });
    expect(ask(build([]))).toMatchObject({ kind: 'notEnoughData', n: 0 });
  });
  it('two comparable tasks are not enough, and they are still listed', () => {
    const r = ask(build(LOGOS.slice(0, 2)));
    expect(r).toMatchObject({ kind: 'notEnoughData', n: 2 });
    if (r.kind === 'notEnoughData') expect(r.comparables.map((c) => c.taskId).sort()).toEqual(['a', 'b']);
  });
  it('tasks that do not resemble the job are not comparable', () => {
    const r = ask(build([...LOGOS, { id: 'u', name: 'Quarterly tax filing', mins: [60] }]));
    expect(r.kind === 'estimate' && r.comparables.map((c) => c.taskId)).not.toContain('u');
  });
});

describe('the estimate', () => {
  it('with exactly 3 tasks gives a median and a min to max range but no quartiles', () => {
    const r = estimate(ask(build(LOGOS.slice(0, 3))));
    expect(r).toMatchObject({ n: 3, minSecs: 3600, medianSecs: 7200, maxSecs: 10800, p25Secs: null, p75Secs: null });
  });
  it('with 4 tasks adds the middle half by linear interpolation', () => {
    const r = estimate(ask(build(LOGOS)));
    expect(r).toMatchObject({ n: 4, minSecs: 3600, maxSecs: 14400, medianSecs: 9000, p25Secs: 6300, p75Secs: 11700 });
  });
  it('with 5 tasks the quartiles fall on tasks themselves', () => {
    const r = estimate(ask(build([...LOGOS, { id: 'e', name: 'Logo animation', mins: [600] }])));
    expect(r).toMatchObject({ n: 5, medianSecs: 10800, p25Secs: 7200, p75Secs: 14400, maxSecs: 36000 });
  });
  it('does not depend on the order of the tasks', () => {
    const forward = ask(build(LOGOS));
    const backward = ask(build([...LOGOS].reverse()));
    expect(backward).toEqual(forward);
  });
});

describe('hours are billable hours, not exact', () => {
  const three = (first: TaskSpec): TaskSpec[] => [first, { id: 'b', name: 'Logo draft', mins: [120] }, { id: 'c', name: 'Logo revision', mins: [180] }];

  it('rounds each task and day once, up to 15 minutes by default', () => {
    // 20 minutes exact is 30 billable; two 5-minute segments on one day are 10 exact and 15 billable, not 30.
    const r = estimate(ask(build(three({ id: 'a', name: 'Logo concepts', pieces: [['2026-02-01T09:00:00Z', '2026-02-01T09:05:00Z', undefined], ['2026-02-01T10:00:00Z', '2026-02-01T10:05:00Z', undefined]] }))));
    expect(r.comparables.find((c) => c.taskId === 'a')?.billableSecs).toBe(900);
    const r2 = estimate(ask(build(three({ id: 'a', name: 'Logo concepts', mins: [20] }))));
    expect(r2.comparables.find((c) => c.taskId === 'a')?.billableSecs).toBe(1800);
  });
  it('follows the rounding rule that applies on the day', () => {
    const rounding: RoundingVersion[] = [{ id: 'ro', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 60, method: 'up', deleted: false, stamp }];
    const r = estimate(ask(build(three({ id: 'a', name: 'Logo concepts', mins: [20] }), { rounding })));
    expect(r.comparables.find((c) => c.taskId === 'a')?.billableSecs).toBe(3600);
  });
  it('counts a billable pause as billable time, rounded together with the work', () => {
    const r = estimate(ask(build(three({ id: 'a', name: 'Logo concepts', pieces: [['2026-02-01T09:00:00Z', '2026-02-01T09:20:00Z', 'work'], ['2026-02-01T09:20:00Z', '2026-02-01T09:35:00Z', 'billablePause']] }))));
    expect(r.comparables.find((c) => c.taskId === 'a')?.billableSecs).toBe(2700); // 20 + 15 = 35 minutes, up to 45
  });
  it('counts thinking time like work, and sums a task over several days', () => {
    const r = estimate(ask(build(three({ id: 'a', name: 'Logo concepts', mins: [60], pieces: [['2026-02-05T09:00:00Z', '2026-02-05T10:00:00Z', 'thinking']] }))));
    expect(r.comparables.find((c) => c.taskId === 'a')?.billableSecs).toBe(7200);
  });
  it('ignores a segment that is still open', () => {
    const r = estimate(ask(build(three({ id: 'a', name: 'Logo concepts', mins: [60], open: true }))));
    expect(r.comparables.find((c) => c.taskId === 'a')?.billableSecs).toBe(3600);
  });
});

describe('zero-hour tasks', () => {
  it('a matching task with no time at all is left out and counted', () => {
    const r = ask(build([...LOGOS.slice(0, 3), { id: 'z', name: 'Logo empty' }]));
    expect(r).toMatchObject({ kind: 'estimate', n: 3, skippedZero: 1 });
    if (r.kind === 'estimate') expect(r.comparables.map((c) => c.taskId)).not.toContain('z');
  });
  it('a task rounded down to nothing has no billable time and is left out', () => {
    const rounding: RoundingVersion[] = [{ id: 'ro', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'down', deleted: false, stamp }];
    const r = ask(build([...LOGOS.slice(0, 3), { id: 'z', name: 'Logo quick fix', mins: [10] }], { rounding }));
    expect(r).toMatchObject({ kind: 'estimate', n: 3, skippedZero: 1 });
  });
  it('zero-hour tasks never lift a sample over the minimum', () => {
    const r = ask(build([...LOGOS.slice(0, 2), { id: 'z', name: 'Logo empty' }]));
    expect(r).toMatchObject({ kind: 'notEnoughData', n: 2, skippedZero: 1 });
  });
});

describe('scoring and ties', () => {
  it('scores tags and words equally when the job has both', () => {
    const data = build([
      { id: 'both', name: 'Logo', tags: ['t1'], mins: [60] }, // 1.0
      { id: 'tag', name: 'Banner', tags: ['t1'], mins: [60] }, // tags 1.0, words 0
      { id: 'word', name: 'Logo', tags: ['t2'], mins: [60] }, // tags 0, words 1.0
      { id: 'half', name: 'Logo', tags: ['t1', 't2'], mins: [60] }, // tags 0.5, words 1.0
    ]);
    const r = ask(data, { name: 'Logo', tags: ['t1'] });
    // Equal scores fall back to the newer stop: 'word' (index 2) stopped after 'tag' (index 1).
    expect(r.kind === 'estimate' && r.comparables.map((c) => [c.taskId, c.score])).toEqual([
      ['both', 1],
      ['half', 0.75],
      ['word', 0.5],
      ['tag', 0.5],
    ]);
  });
  it('a job without tags is scored on its name alone, and a job with only tags on its tags alone', () => {
    const data = build([{ id: 'a', name: 'Logo concepts', tags: ['t1'], mins: [60] }]);
    const byName = ask(data, { name: 'Logo concepts', tags: [] });
    expect(byName.kind === 'notEnoughData' && byName.comparables[0]?.score).toBe(1);
    const byTag = ask(data, { name: '', tags: ['t1'] });
    expect(byTag.kind === 'notEnoughData' && byTag.comparables[0]?.score).toBe(1);
  });
  it('keeps a task at exactly the minimum score and drops one just below it', () => {
    expect(MIN_SCORE).toBe(0.25);
    // Words {logo, concepts} against {logo, draft, pitch}: 1 shared of 4 is exactly 0.25. Against {logo, a1, b2, c3}: 1 of 5 is 0.2.
    const data = build([{ id: 'edge', name: 'Logo draft pitch', mins: [60] }, { id: 'below', name: 'Logo alpha bravo charlie', mins: [60] }]);
    const r = ask(data, { name: 'Logo concepts' });
    expect(r.kind === 'notEnoughData' && r.comparables.map((c) => c.taskId)).toEqual(['edge']);
  });
  it('breaks ties by the most recent stop, then by id, whatever the input order', () => {
    const same = (id: string, stoppedAt: string): TaskSpec => ({ id, name: 'Logo', mins: [60], stoppedAt });
    const specs = [same('b', '2026-02-20T00:00:00Z'), same('a', '2026-02-20T00:00:00Z'), same('c', '2026-02-25T00:00:00Z')];
    const order = (s: TaskSpec[]) => {
      const r = ask(build(s));
      return r.kind === 'estimate' ? r.comparables.map((c) => c.taskId) : [];
    };
    expect(order(specs)).toEqual(['c', 'a', 'b']);
    expect(order([...specs].reverse())).toEqual(['c', 'a', 'b']);
  });
  it('keeps only the best matches when there are more than the cap, with ties going to the newest', () => {
    const many: TaskSpec[] = Array.from({ length: MAX_COMPARABLES + 3 }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, name: 'Logo', mins: [60], stoppedAt: `2026-02-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
    const r = estimate(ask(build(many)));
    expect(r.n).toBe(MAX_COMPARABLES);
    expect(r.comparables.map((c) => c.taskId)).not.toContain('t00');
    expect(r.comparables[0]?.taskId).toBe(`t${String(MAX_COMPARABLES + 2).padStart(2, '0')}`);
  });
  it('can compare only within the chosen project', () => {
    const projects = [fullProject({ id: 'p' }), fullProject({ id: 'q' })];
    const data = build([...LOGOS.slice(0, 3), { id: 'other', name: 'Logo mark', projectId: 'q', mins: [60] }], { projects });
    expect(estimate(ask(data)).n).toBe(4);
    expect(estimate(ask(data, { sameProjectOnly: true })).n).toBe(3);
    expect(ask(data, { sameProjectOnly: true, projectId: 'q' }).kind).toBe('notEnoughData');
    // Without a project the flag has nothing to compare with and is ignored.
    expect(estimate(ask(data, { sameProjectOnly: true, projectId: null })).n).toBe(4);
  });
});

describe('the amount at the project rate', () => {
  it('prices the range at the rate in force now, rounding half up to cents', () => {
    const r = estimate(ask(build(LOGOS)));
    expect(r.amount).toEqual({ kind: 'amount', currency: 'EUR', rateCents: 5000, minCents: 5000, medianCents: 12500, maxCents: 20000, p25Cents: 8750, p75Cents: 16250 });
    const odd = estimate(ask(build([{ id: 'a', name: 'Logo', mins: [30] }, { id: 'b', name: 'Logo', mins: [30] }, { id: 'c', name: 'Logo', mins: [30] }], { rates: [{ id: 'r', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 1001, currency: 'USD', deleted: false, stamp }] })));
    expect(odd.amount).toMatchObject({ kind: 'amount', currency: 'USD', medianCents: 501 }); // 1001 * 0.5 = 500.5
  });
  it('uses the newest rate version, not the one in force when the old tasks were done', () => {
    const rates: RateVersion[] = [
      { id: 'r1', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 5000, currency: 'EUR', deleted: false, stamp },
      { id: 'r2', projectId: 'p', effectiveFrom: '2026-03-01T00:00:00Z', rateCents: 6000, currency: 'EUR', deleted: false, stamp },
    ];
    const r = estimate(ask(build(LOGOS.slice(0, 3), { rates })));
    expect(r.amount).toMatchObject({ rateCents: 6000, medianCents: 12000 });
  });
  it('has no amount without a project, and says why', () => {
    expect(estimate(ask(build(LOGOS), { projectId: null })).amount).toEqual({ kind: 'none', reason: 'noProject' });
  });
  it('has no amount when the project has no rate yet', () => {
    expect(estimate(ask(build(LOGOS, { rates: [] }))).amount).toEqual({ kind: 'none', reason: 'noRate' });
    const cleared: RateVersion[] = [{ id: 'r1', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: null, currency: 'EUR', deleted: false, stamp }];
    expect(estimate(ask(build(LOGOS, { rates: cleared }))).amount).toEqual({ kind: 'none', reason: 'noRate' });
  });
  it('has no hourly amount for a fixed-fee project, even with rates on record', () => {
    const projects = [fullProject({ id: 'p', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR' })];
    expect(estimate(ask(build(LOGOS, { projects }))).amount).toEqual({ kind: 'none', reason: 'fixedFee' });
  });
  it('has no amount for a project that is not billable', () => {
    const projects = [fullProject({ id: 'p', billable: false })];
    expect(estimate(ask(build(LOGOS, { projects }))).amount).toEqual({ kind: 'none', reason: 'notBillable' });
  });
  it('still reports hours when there is no amount', () => {
    const r = estimate(ask(build(LOGOS, { rates: [] })));
    expect(r.medianSecs).toBe(9000);
  });
});
