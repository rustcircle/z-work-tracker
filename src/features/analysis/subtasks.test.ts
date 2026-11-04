// Time per subtask: what the Subtasks level of the Share of time donut is made of. A subtask's time is the worked time of
// the stretches logged on it, after the same filters and period as every other figure; a task's time on no subtask is a
// row of its own, so a task's rows always add up to the task.
import { describe, expect, it } from 'vitest';

import { NO_FILTERS, type Filters } from './engine';
import { UNTITLED_SUBTASK } from './fam-subtasks';
import { analyze, type Metrics } from './metrics';
import type { RangeSpec } from './range';
import { availabilityOf } from './shareLevels';
import { mkSnapshot, nowOf, params, type Spec } from './testkit';

const NOW = '2026-03-04T12:00:00Z';
const WEEK: RangeSpec = { kind: 'week', anchor: '2026-03-03' };
const ITEMS = [
  { id: 'moodboard', text: 'Moodboard' },
  { id: 'sketches', text: 'Sketches' },
];

const run = (spec: Spec, basis: 'exact' | 'billable' = 'exact', filters: Partial<Filters> = {}, range: RangeSpec = WEEK, now: string = spec.now): Metrics =>
  analyze(mkSnapshot(spec), params('UTC', range, { filters: { ...NO_FILTERS, ...filters } }), nowOf(now), basis);
const rows = (m: Metrics): [task: string, subtask: string | null, minutes: number][] => m.subtasks.map((s) => [s.taskId, s.id, Math.round(s.exact / 60)]);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Logo: 90 min on Moodboard, 60 on Sketches, 30 on none. Plain: 45 minutes and no list. */
const SPEC: Spec = {
  now: NOW,
  projects: [{ id: 'p' }],
  tasks: [
    { id: 'logo', projectId: 'p', subtasks: ITEMS },
    { id: 'plain', projectId: 'p' },
  ],
  segs: [
    ['logo', '2026-03-03T09:00:00Z', '2026-03-03T10:30:00Z', { subtaskId: 'moodboard' }],
    ['logo', '2026-03-03T11:00:00Z', '2026-03-03T12:00:00Z', { subtaskId: 'sketches' }],
    ['logo', '2026-03-03T13:00:00Z', '2026-03-03T13:30:00Z'],
    ['plain', '2026-03-03T14:00:00Z', '2026-03-03T14:45:00Z'],
  ],
};

describe('the time of each subtask', () => {
  it('has a row per subtask with time and, for a task with a list, a row for its time on none', () => {
    const m = run(SPEC);
    expect(rows(m)).toEqual([
      ['logo', 'moodboard', 90],
      ['logo', 'sketches', 60],
      ['logo', null, 30],
      ['plain', null, 45],
    ]);
    expect(m.subtasks.find((s) => s.id === 'moodboard')?.name).toBe('Moodboard');
    expect(m.subtasks.find((s) => s.id === null)?.name).toBe('');
  });

  it('adds up to each task’s time, and so to the total, in both bases', () => {
    for (const basis of ['exact', 'billable'] as const) {
      const m = run(SPEC, basis);
      for (const t of m.tasks.list) {
        expect(sum(m.subtasks.filter((s) => s.taskId === t.id).map((s) => s.secs)), `${basis} ${t.id}`).toBeCloseTo(t.secs, 6);
      }
      expect(sum(m.subtasks.map((s) => s.secs))).toBeCloseTo(sum(m.tasks.list.map((t) => t.secs)), 6);
    }
  });

  it('shares a task’s Billable time out in proportion to the worked time of its rows', () => {
    // 20 minutes on Moodboard and 5 on none: 25 worked minutes round up to 30 at 15 minute increments.
    const spec: Spec = {
      now: NOW,
      projects: [{ id: 'p' }],
      tasks: [{ id: 'logo', projectId: 'p', subtasks: ITEMS }],
      segs: [
        ['logo', '2026-03-03T09:00:00Z', '2026-03-03T09:20:00Z', { subtaskId: 'moodboard' }],
        ['logo', '2026-03-03T10:00:00Z', '2026-03-03T10:05:00Z'],
      ],
    };
    const m = run(spec, 'billable');
    expect(m.tasks.list[0]).toMatchObject({ exact: 25 * 60, billableSecs: 30 * 60, secs: 30 * 60 });
    // Moodboard has 4/5 of the worked time, so 4/5 of the 30 billable minutes; none has 1/5.
    expect(m.subtasks.map((s) => [s.id, s.exact, s.billableSecs, s.secs])).toEqual([
      ['moodboard', 20 * 60, 24 * 60, 24 * 60],
      [null, 5 * 60, 6 * 60, 6 * 60],
    ]);
    // Under Exact the rows are the worked time itself, and `billableSecs` still says what Billable would be.
    expect(run(spec, 'exact').subtasks.map((s) => [s.id, s.secs, s.billableSecs])).toEqual([
      ['moodboard', 20 * 60, 24 * 60],
      [null, 5 * 60, 6 * 60],
    ]);
  });

  it('counts time on an item that has since been taken out of the list as time on no subtask', () => {
    const spec: Spec = { ...SPEC, tasks: [{ id: 'logo', projectId: 'p', subtasks: [ITEMS[0] as (typeof ITEMS)[number]] }, { id: 'plain', projectId: 'p' }] };
    expect(rows(run(spec)).filter(([task]) => task === 'logo')).toEqual([
      ['logo', 'moodboard', 90],
      ['logo', null, 90],
    ]);
  });

  it('gives an item without text a name of its own', () => {
    const spec: Spec = { ...SPEC, tasks: [{ id: 'logo', projectId: 'p', subtasks: [{ id: 'moodboard', text: '  ' }] }, { id: 'plain', projectId: 'p' }] };
    expect(run(spec).subtasks.find((s) => s.id === 'moodboard')?.name).toBe(UNTITLED_SUBTASK);
  });

  it('keeps the pieces of one recorded segment together on its subtask, away time cut out', () => {
    const spec: Spec = {
      now: NOW,
      projects: [{ id: 'p' }],
      tasks: [{ id: 'logo', projectId: 'p', subtasks: ITEMS }],
      segs: [
        ['logo', '2026-03-03T09:00:00Z', '2026-03-03T09:30:00Z', { segmentId: 'r1', subtaskId: 'sketches' }],
        ['logo', '2026-03-03T09:30:00Z', '2026-03-03T09:45:00Z', { segmentId: 'r1', subtaskId: 'sketches', kind: 'thinking' }],
        ['logo', '2026-03-03T10:00:00Z', '2026-03-03T10:20:00Z', { segmentId: 'r1', subtaskId: 'sketches' }],
      ],
    };
    expect(rows(run(spec))).toEqual([['logo', 'sketches', 65]]);
  });

  it('leaves a billable pause out: it is not worked time on any subtask', () => {
    const spec: Spec = { ...SPEC, segs: [...(SPEC.segs ?? []), ['logo', '2026-03-03T15:00:00Z', '2026-03-03T15:30:00Z', { kind: 'billablePause' }]] };
    expect(rows(run(spec)).filter(([task]) => task === 'logo')).toEqual([
      ['logo', 'moodboard', 90],
      ['logo', 'sketches', 60],
      ['logo', null, 30],
    ]);
  });

  it('only counts the period: a day outside it adds nothing', () => {
    const spec: Spec = { ...SPEC, segs: [...(SPEC.segs ?? []), ['logo', '2026-03-12T09:00:00Z', '2026-03-12T10:00:00Z', { subtaskId: 'sketches' }]] };
    expect(rows(run(spec)).find(([, id]) => id === 'sketches')?.[2]).toBe(60);
    expect(rows(run(spec, 'exact', {}, { kind: 'week', anchor: '2026-03-10' }))).toEqual([['logo', 'sketches', 60]]);
  });

  it('follows the filters: a task filter, and a band filter', () => {
    expect(rows(run(SPEC, 'exact', { taskIds: ['plain'] }))).toEqual([['plain', null, 45]]);
    // Morning is 06:00-12:00: the Moodboard stretch (09:00-10:30) and the Sketches one (11:00-12:00) are in it, the afternoon ones are not.
    expect(rows(run(SPEC, 'exact', { band: 1 }))).toEqual([
      ['logo', 'moodboard', 90],
      ['logo', 'sketches', 60],
    ]);
    // Afternoon (12:00-18:00) holds only the stretch on no subtask and the other task's.
    expect(rows(run(SPEC, 'exact', { band: 2 }))).toEqual([['plain', null, 45], ['logo', null, 30]]);
  });

  it('cuts a stretch at the edge of a band, and the cut part keeps its subtask', () => {
    const spec: Spec = {
      now: NOW,
      projects: [{ id: 'p' }],
      tasks: [{ id: 'logo', projectId: 'p', subtasks: ITEMS }],
      segs: [['logo', '2026-03-03T11:30:00Z', '2026-03-03T12:30:00Z', { subtaskId: 'sketches' }]],
    };
    expect(rows(run(spec, 'exact', { band: 1 }))).toEqual([['logo', 'sketches', 30]]);
    expect(rows(run(spec, 'exact', { band: 2 }))).toEqual([['logo', 'sketches', 30]]);
    expect(rows(run(spec, 'exact', { band: 0 }))).toEqual([]);
  });

  it('includes the stretch running now, up to now', () => {
    const spec: Spec = { ...SPEC, now: '2026-03-03T16:30:00Z', segs: [...(SPEC.segs ?? []), ['logo', '2026-03-03T16:00:00Z', null, { subtaskId: 'sketches' }]], tasks: [{ id: 'logo', projectId: 'p', state: 'running', subtasks: ITEMS }, { id: 'plain', projectId: 'p' }] };
    // 60 minutes already, and the running 30 minutes since 16:00.
    expect(rows(run(spec)).find(([, id]) => id === 'sketches')?.[2]).toBe(90);
  });

  it('is empty when nothing is logged', () => {
    expect(run({ now: NOW, projects: [{ id: 'p' }], tasks: [{ id: 'logo', projectId: 'p', subtasks: ITEMS }], segs: [] }).subtasks).toEqual([]);
  });
});

describe('when the Subtasks level has something to show', () => {
  it('needs time on a real subtask: time on none is only the tasks again', () => {
    expect(availabilityOf(run(SPEC).subtasks).subtasks).toBe(true);
    const noItems: Spec = { ...SPEC, segs: (SPEC.segs ?? []).map(([t, a, b]) => [t, a, b]) };
    expect(availabilityOf(run(noItems).subtasks).subtasks).toBe(false);
    expect(availabilityOf([]).subtasks).toBe(false);
  });

  it('turns off when a filter takes the subtask time away', () => {
    expect(availabilityOf(run(SPEC, 'exact', { taskIds: ['plain'] }).subtasks).subtasks).toBe(false);
    expect(availabilityOf(run(SPEC, 'exact', { band: 2 }).subtasks).subtasks).toBe(false);
    expect(availabilityOf(run(SPEC, 'exact', {}, { kind: 'week', anchor: '2026-03-10' }).subtasks).subtasks).toBe(false);
  });
});
