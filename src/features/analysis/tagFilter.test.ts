// The Analysis tag filter. The owner's rule: no tag chosen counts as choosing all tags, nothing is filtered; with some
// chosen, only the time of tasks that carry ANY of them is kept (as whole tasks); and the choice "No tag" keeps the
// tasks that carry none, alone or together with tags. A subtask goes with its task.
import { describe, expect, it } from 'vitest';

import { NO_FILTERS, type Filters } from './engine';
import { analyze, type Metrics } from './metrics';
import type { RangeSpec } from './range';
import { NO_TAG, liveTagsOf, tagFilterHint, taskPassesTagFilter } from './tagFilter';
import { mkSnapshot, nowOf, params, type Spec } from './testkit';
import { filterText } from './viewText';

const NOW = '2026-03-04T12:00:00Z';
const WEEK: RangeSpec = { kind: 'week', anchor: '2026-03-03' };
const LIVE: ReadonlySet<string> = new Set(['a', 'b']);

describe('taskPassesTagFilter', () => {
  it('keeps every task while no tag is chosen: none counts as all', () => {
    for (const tags of [[], ['a'], ['a', 'b'], ['gone']]) expect(taskPassesTagFilter(tags, [], LIVE)).toBe(true);
  });

  it('with one tag chosen, keeps the tasks that carry it, whatever else they carry', () => {
    expect(taskPassesTagFilter(['a'], ['a'], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['b', 'a'], ['a'], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['b'], ['a'], LIVE)).toBe(false);
    expect(taskPassesTagFilter([], ['a'], LIVE)).toBe(false);
  });

  it('with two tags chosen, keeps a task that carries ANY of them (OR)', () => {
    expect(taskPassesTagFilter(['a'], ['a', 'b'], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['b'], ['a', 'b'], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['a', 'b'], ['a', 'b'], LIVE)).toBe(true);
    expect(taskPassesTagFilter([], ['a', 'b'], LIVE)).toBe(false);
  });

  it('"No tag" alone keeps only the tasks that carry no tag', () => {
    expect(taskPassesTagFilter([], [NO_TAG], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['a'], [NO_TAG], LIVE)).toBe(false);
    expect(taskPassesTagFilter(['a', 'b'], [NO_TAG], LIVE)).toBe(false);
  });

  it('"No tag" with a tag keeps both: the untagged tasks and the ones that carry the tag', () => {
    expect(taskPassesTagFilter([], [NO_TAG, 'a'], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['a'], [NO_TAG, 'a'], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['b'], [NO_TAG, 'a'], LIVE)).toBe(false);
  });

  it('counts a task whose only tags were deleted as having no tag, as the Tags section does', () => {
    expect(liveTagsOf(['gone', 'a'], LIVE)).toEqual(['a']);
    expect(taskPassesTagFilter(['gone'], [NO_TAG], LIVE)).toBe(true);
    expect(taskPassesTagFilter(['gone'], ['a'], LIVE)).toBe(false);
  });
});

describe('the words under the tag filter', () => {
  it('says what is kept, with the choice "No tag" as its own case', () => {
    expect(tagFilterHint([])).toBe('All tasks');
    expect(tagFilterHint(['a'])).toBe('Tasks with any selected tag');
    expect(tagFilterHint(['a', 'b'])).toBe('Tasks with any selected tag');
    expect(tagFilterHint([NO_TAG])).toBe('Tasks with no tag');
    expect(tagFilterHint([NO_TAG, 'a'])).toBe('Tasks with any selected tag, or with no tag');
  });
});

/**
 * Five tasks in one project on 3 March, one hour or less each, so every figure can be added up by hand:
 *   t1 [a] 60 min, 40 of them on its subtask s1       t2 [b] 30 min        t3 [a, b] 20 min
 *   t4 [] 10 min, with 5 minutes of pending time away t5 [a deleted tag] 15 min
 */
const SPEC: Spec = {
  now: NOW,
  projects: [{ id: 'p' }, { id: 'q' }],
  tags: [{ id: 'a', name: 'Design' }, { id: 'b', name: 'Client' }, { id: 'gone', name: 'Old', deleted: true }],
  tasks: [
    { id: 't1', projectId: 'p', tags: ['a'], subtasks: [{ id: 's1', text: 'Sketches' }] },
    { id: 't2', projectId: 'p', tags: ['b'] },
    { id: 't3', projectId: 'q', tags: ['b', 'a'] },
    { id: 't4', projectId: 'q' },
    { id: 't5', projectId: 'q', tags: ['gone'] },
  ],
  segs: [
    ['t1', '2026-03-03T09:00:00Z', '2026-03-03T09:40:00Z', { subtaskId: 's1' }],
    ['t1', '2026-03-03T10:00:00Z', '2026-03-03T10:20:00Z'],
    ['t2', '2026-03-03T11:00:00Z', '2026-03-03T11:30:00Z'],
    ['t3', '2026-03-03T12:00:00Z', '2026-03-03T12:20:00Z'],
    ['t4', '2026-03-03T13:00:00Z', '2026-03-03T13:10:00Z'],
    ['t4', '2026-03-03T14:00:00Z', '2026-03-03T14:05:00Z', { kind: 'billablePause' }],
    ['t5', '2026-03-03T15:00:00Z', '2026-03-03T15:15:00Z'],
  ],
  gaps: [['t4', '2026-03-03T16:00:00Z', '2026-03-03T16:05:00Z', 'pending']],
};

const snapshot = mkSnapshot(SPEC);
const run = (tagIds: readonly string[], more: Partial<Filters> = {}, basis: 'exact' | 'billable' = 'exact'): Metrics =>
  analyze(snapshot, params('UTC', WEEK, { filters: { ...NO_FILTERS, tagIds, ...more } }), nowOf(NOW), basis);
const taskIdsOf = (m: Metrics): string[] => m.tasks.list.map((t) => t.id).sort();
const minutes = (m: Metrics): number => m.volume.exact / 60;

describe('the tag filter in every filtered figure', () => {
  it('with no tag chosen, all tasks count', () => {
    const m = run([]);
    expect(taskIdsOf(m)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(minutes(m)).toBe(60 + 30 + 20 + 10 + 15);
  });

  it('with one tag chosen, keeps the whole tasks that carry it', () => {
    const m = run(['a']);
    expect(taskIdsOf(m)).toEqual(['t1', 't3']);
    expect(minutes(m)).toBe(60 + 20);
    expect(m.billableAvailable).toBe(true);
  });

  it('with two tags chosen, keeps the tasks that carry either, a task with both once', () => {
    const m = run(['a', 'b']);
    expect(taskIdsOf(m)).toEqual(['t1', 't2', 't3']);
    expect(minutes(m)).toBe(60 + 30 + 20);
  });

  it('"No tag" alone keeps the tasks with no tag, one whose only tag was deleted included', () => {
    const m = run([NO_TAG]);
    expect(taskIdsOf(m)).toEqual(['t4', 't5']);
    expect(minutes(m)).toBe(10 + 15);
    expect(m.billableAvailable).toBe(true);
  });

  it('"No tag" with a tag keeps the untagged tasks and the tasks with that tag', () => {
    const m = run([NO_TAG, 'b']);
    expect(taskIdsOf(m)).toEqual(['t2', 't3', 't4', 't5']);
    expect(minutes(m)).toBe(30 + 20 + 10 + 15);
  });

  it('keeps the subtask time of the tasks it keeps and drops the rest: a subtask goes with its task', () => {
    expect(run(['a']).subtasks.map((s) => [s.taskId, s.id, s.exact / 60])).toEqual([
      ['t1', 's1', 40],
      ['t1', null, 20],
      ['t3', null, 20],
    ]);
    expect(run(['b']).subtasks.map((s) => s.taskId).sort()).toEqual(['t2', 't3']);
    expect(run([NO_TAG]).subtasks.map((s) => s.taskId).sort()).toEqual(['t4', 't5']);
  });

  it('applies to the projects, the Billable figures, the pauses and the pending away time as well', () => {
    const none = run([NO_TAG]);
    // Projects: only q has untagged tasks (t4 and t5).
    expect(none.projects.map((p) => [p.id, p.exact / 60])).toEqual([['q', 25]]);
    // Billable rounds a task-day up to 15 minutes: t4 10 + its 5 minute pause = 15; t5 15; whole tasks, so the rows are as without the filter.
    expect(run([NO_TAG], {}, 'billable').volume.billable).toBe(30 * 60);
    expect(none.pieces.pauseSecs).toBe(5 * 60);
    expect(none.pieces.unconfirmed.secs).toBe(5 * 60);
    // The same figures for a tag: the pause and the pending time belong to t4, which "Design" does not keep.
    const design = run(['a']);
    expect(design.pieces.pauseSecs).toBe(0);
    expect(design.pieces.unconfirmed.secs).toBe(0);
    expect(design.projects.map((p) => [p.id, p.exact / 60])).toEqual([['p', 60], ['q', 20]]);
  });

  it('composes with the project filter: both must hold', () => {
    const m = run([NO_TAG, 'a'], { projectIds: ['q'] });
    expect(taskIdsOf(m)).toEqual(['t3', 't4', 't5']);
  });

  it('is part of the key the engine caches on, so a different choice is a different answer', () => {
    expect(minutes(run([NO_TAG]))).toBe(25);
    expect(minutes(run(['a']))).toBe(80);
    expect(minutes(run([NO_TAG]))).toBe(25);
  });

  it('leaves the Tags section as it was: its rows still show each kept task’s full set of tags', () => {
    const m = run(['a']);
    expect(m.tags.stats.map((t) => [t.id, t.exact / 60])).toEqual([['a', 80], ['b', 20]]);
    expect(m.tags.untagged).toBeNull();
    expect(run([NO_TAG]).tags.untagged?.exact).toBe(25 * 60);
  });
});

describe('the filter in words', () => {
  it('names "No tag" in the exported titles and the Export dialog', () => {
    const f = (tagIds: string[]): string => filterText(snapshot, { ...NO_FILTERS, tagIds });
    expect(f([])).toBe('');
    expect(f(['a'])).toBe('tag Design');
    expect(f([NO_TAG])).toBe('no tag');
    expect(f(['a', NO_TAG])).toBe('tags Design, no tag');
    expect(f([NO_TAG, 'a', 'b'])).toBe('tags Design, Client, no tag');
  });
});
