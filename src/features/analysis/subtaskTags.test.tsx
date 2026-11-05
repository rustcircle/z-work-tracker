// Subtask tags in Analysis (1.4): a subtask can count under some of its task's tags, so time is counted under the tags each piece
// counts under, not the task's. The tag filter, the Tags section and sheet, the Tags level of Share of time and the drill-down all
// follow, and a task none of whose subtasks differs is counted as before. The Rust core's figures for the same rule are pinned by
// analyticsParity.test.ts (fixtures/analytics-parity.json); the rule itself by src/lib/subtaskTags.test.ts.
//
// One task, Write, with tags Design and Client, and three subtasks on 10 March 2026 (UTC), by hand:
//   Draft [Client]  09:00-10:00  60 min       Edit [no tag]  10:00-10:30  30 min       Polish [same as task]  11:00-11:20  20 min
//   no subtask  12:00-12:10  10 min           a subtask that is not in the list any more  13:00-13:05  5 min
// so Write is 125 min: 35 under Design + Client, 60 under Client, 30 under no tag. Beside it: Plan [Design] 15 min,
// Admin [no tag] 45 min and Call [Client] 25 min, so 210 min in all.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { parseIso } from '../../lib/tz';
import type { Snapshot } from '../../lib/types';
import { Controls } from './Controls';
import { drill, type DrillSel } from './drill';
import { NO_FILTERS, type Filters } from './engine';
import { analyze, type Basis, type Metrics } from './metrics';
import type { RangeSpec } from './range';
import type { SecEnv } from './secenv';
import { Projects } from './SectionsA';
import { effectiveTagsOf } from '../../lib/subtasks';
import type { TaskDay } from '../../lib/billing';
import { TagsSection } from './SectionsP2';
import { NO_TAG, TAG_FILTER_KEEPS, TAG_FILTER_KEEPS_BY_SUBTASK, anySubtaskTags, tagFilterHint } from './tagFilter';
import { tagShares } from './shareSlices';
import { tagPartsOf } from './tagSets';
import { mkSnapshot, nowOf, params, type Spec } from './testkit';

const NOW = '2026-03-12T12:00:00Z';
const WEEK: RangeSpec = { kind: 'week', anchor: '2026-03-10' };
const MIN = 60;

/** Work on 10 March from "09:00" to "09:30", on a subtask or none. */
const on = (task: string, from: string, to: string, subtaskId: string | null = null, day = '2026-03-10'): NonNullable<Spec['segs']>[number] => [task, `${day}T${from}:00Z`, `${day}T${to}:00Z`, { subtaskId }];

const TAGS: NonNullable<Spec['tags']> = [{ id: 'a', name: 'Design', color: '#7c3aed' }, { id: 'b', name: 'Client', color: '#0f766e' }];
const WRITE_ITEMS = [{ id: 's1', text: 'Draft', tags: ['b'] }, { id: 's2', text: 'Edit', tags: [] }, { id: 's3', text: 'Polish' }];
const SEGS: NonNullable<Spec['segs']> = [
  on('w', '09:00', '10:00', 's1'),
  on('w', '10:00', '10:30', 's2'),
  on('w', '11:00', '11:20', 's3'),
  on('w', '12:00', '12:10'),
  on('w', '13:00', '13:05', 'gone'),
  on('x', '14:00', '14:15'),
  on('y', '15:00', '15:45'),
  on('z', '16:00', '16:25'),
];

function specOf(more: Partial<Spec> = {}): Spec {
  return {
    now: NOW,
    projects: [{ id: 'p' }],
    tags: TAGS,
    tasks: [
      { id: 'w', projectId: 'p', name: 'Write', tags: ['a', 'b'], subtasks: WRITE_ITEMS },
      { id: 'x', projectId: 'p', name: 'Plan', tags: ['a'] },
      { id: 'y', projectId: 'p', name: 'Admin' },
      { id: 'z', projectId: 'p', name: 'Call', tags: ['b'] },
    ],
    segs: SEGS,
    ...more,
  };
}
/** No rounding, so the figures are the minutes written above. */
const EXACT_ROUNDING: Spec['rounding'] = [{ projectId: null, incrementMinutes: 0, method: 'up' }];

const run = (snapshot: Snapshot, extra: Partial<Parameters<typeof params>[2]> = {}, basis: Basis = 'exact', now = NOW): Metrics => analyze(snapshot, params('UTC', WEEK, extra), nowOf(now), basis);
const withTags = (tagIds: readonly string[]) => ({ filters: { ...NO_FILTERS, tagIds } as Filters });
const exact = mkSnapshot(specOf({ rounding: EXACT_ROUNDING }));
const rounded = mkSnapshot(specOf());
const mins = (secs: number | undefined): number | undefined => (secs === undefined ? undefined : secs / MIN);
const rowOf = (m: Metrics, id: string | null) => (id === null ? m.tags.untagged : m.tags.stats.find((t) => t.id === id));

describe('the Tags section counts each piece of time under the tags it counts under', () => {
  const m = run(exact);

  it('splits Write by its subtasks and leaves the other tasks as they were', () => {
    expect(mins(rowOf(m, 'a')?.exact)).toBe(35 + 15);
    expect(mins(rowOf(m, 'b')?.exact)).toBe(35 + 60 + 25);
    expect(mins(rowOf(m, null)?.exact)).toBe(30 + 45);
    // A task counts once in each row it reaches, however many of its parts put time there.
    expect([rowOf(m, 'a')?.taskCount, rowOf(m, 'b')?.taskCount, rowOf(m, null)?.taskCount]).toEqual([2, 2, 2]);
    expect(m.tags.total / MIN).toBe(210);
    expect(m.tags.splitTasks).toBe(1);
    expect(m.tags.multiTagTasks).toBe(1);
    expect(m.tags.stats.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('gives a task whose subtasks all count under its own tags one part with all its time, as before 1.4', () => {
    const plain = run(mkSnapshot(specOf({ rounding: EXACT_ROUNDING, tasks: specOf().tasks?.map((t) => (t.id === 'w' ? { ...t, subtasks: [{ id: 's1', text: 'Draft' }, { id: 's3', text: 'Polish', tags: ['a', 'b'] }] } : t)) })));
    expect(plain.tags.splitTasks).toBe(0);
    expect(plain.tags.parts.filter((p) => p.taskId === 'w')).toEqual([{ taskId: 'w', tags: ['a', 'b'], secs: 125 * MIN, exact: 125 * MIN, billableSecs: 125 * MIN }]);
    expect(mins(rowOf(plain, 'a')?.exact)).toBe(125 + 15);
    expect(mins(rowOf(plain, null)?.exact)).toBe(45);
  });

  it('has parts that add up to each task’s time, on both bases', () => {
    // A running segment whose earlier piece is closed (the active subtask was switched, so the segment is two adjacent pieces).
    const running = mkSnapshot(specOf({ segs: [...SEGS, ['w', '2026-03-12T11:00:00Z', '2026-03-12T11:20:00Z', { segmentId: 'segL', subtaskId: 's1' }], ['w', '2026-03-12T11:20:00Z', null, { segmentId: 'segL', subtaskId: 's1' }]] }));
    for (const snapshot of [exact, rounded, running]) {
      for (const basis of ['exact', 'billable'] as const) {
        const parts = run(snapshot, {}, basis).tags.parts;
        for (const t of run(snapshot, {}, basis).tasks.list) {
          const mine = parts.filter((p) => p.taskId === t.id);
          expect(mine.reduce((n, p) => n + p.exact, 0), `${t.id} exact`).toBe(t.exact);
          expect(mine.reduce((n, p) => n + p.billableSecs, 0), `${t.id} billable`).toBe(t.billableSecs);
          expect(mine.reduce((n, p) => n + p.secs, 0), `${t.id} ${basis}`).toBe(t.secs);
        }
      }
    }
  });

  it('puts the row’s rounding on the latest piece, as the core does: Write is 125 min, 135 when rounded up', () => {
    const b = run(rounded, {}, 'billable');
    // Draft 60 [Client], Edit 30 [none], Polish 20 + no subtask 10 + the removed one 5, which takes the 10 minutes of rounding.
    const write = b.tags.parts.filter((p) => p.taskId === 'w').map((p) => [p.tags.join('+'), p.exact / MIN, p.billableSecs / MIN]);
    expect(write).toEqual(expect.arrayContaining([['b', 60, 60], ['', 30, 30], ['a+b', 35, 45]]));
    expect(write).toHaveLength(3);
    expect(mins(rowOf(b, 'a')?.billableSecs)).toBe(45 + 15);
    expect(mins(rowOf(b, 'b')?.billableSecs)).toBe(45 + 60 + 30);
    expect(mins(rowOf(b, null)?.billableSecs)).toBe(30 + 45);
    // The share keeps the total of all billable time, 135 + 15 + 45 + 30.
    expect(b.tags.total / MIN).toBe(225);
    expect(rowOf(b, 'b')?.share).toBeCloseTo((45 + 60 + 30) / 225, 10);
  });

  it('takes a negative rounding from the latest piece, and from the one before when that would go below nothing', () => {
    // Rounded down to 30 minutes, Edit (5 min) and Polish (20 min) on one day are 25 min, which rounds to nothing.
    const down = mkSnapshot({
      now: NOW,
      projects: [{ id: 'p' }],
      tags: TAGS,
      tasks: [{ id: 'w', projectId: 'p', tags: ['a', 'b'], subtasks: [{ id: 's1', text: 'Edit', tags: ['a'] }, { id: 's2', text: 'Polish', tags: ['b'] }] }],
      segs: [on('w', '09:00', '09:05', 's1'), on('w', '10:00', '10:20', 's2')],
      rounding: [{ projectId: null, incrementMinutes: 30, method: 'down' }],
    });
    const b = run(down, {}, 'billable');
    expect(b.tags.parts.map((p) => [p.tags.join('+'), p.exact / MIN, p.billableSecs / MIN])).toEqual(expect.arrayContaining([['a', 5, 0], ['b', 20, 0]]));
    // And 55 minutes in the same two parts rounds down to 30: the 25 come off Polish, the latest, first.
    const some = mkSnapshot({ ...specOfOne(), segs: [on('w', '09:00', '09:25', 's1'), on('w', '10:00', '10:30', 's2')], rounding: [{ projectId: null, incrementMinutes: 30, method: 'down' }] });
    expect(run(some, {}, 'billable').tags.parts.map((p) => [p.tags.join('+'), p.billableSecs / MIN])).toEqual(expect.arrayContaining([['a', 25], ['b', 5]]));
  });

  it('counts a piece cut by midnight as two pieces, each in its own day’s row', () => {
    const snapshot = mkSnapshot({
      now: NOW,
      projects: [{ id: 'p' }],
      tags: TAGS,
      tasks: [{ id: 'w', projectId: 'p', tags: ['a', 'b'], subtasks: [{ id: 's1', text: 'Draft', tags: ['b'] }, { id: 's2', text: 'Edit', tags: [] }] }],
      segs: [['w', '2026-03-10T23:50:00Z', '2026-03-11T00:20:00Z', { subtaskId: 's1' }], on('w', '00:30', '00:35', 's2', '2026-03-11')],
    });
    // 10 min on the 10th round up to 15, 25 min on the 11th round up to 30, the 5 on the latest piece of each day.
    const b = run(snapshot, {}, 'billable');
    expect(b.tags.parts.map((p) => [p.tags.join('+'), p.exact / MIN, p.billableSecs / MIN])).toEqual(expect.arrayContaining([['b', 30, 35], ['', 5, 10]]));
    expect(b.tags.parts.reduce((n, p) => n + p.billableSecs, 0)).toBe(45 * MIN);
  });

  it('puts a day’s rounding on its latest piece, though a joined stretch of another subtask encloses that piece’s neighbours', () => {
    // Overlapping entries of one task: Draft (tags Design) is 09:00-09:30 work, then 09:30-10:00 and 10:00-10:30 thinking, which are
    // two adjacent pieces of one recorded segment and so one stretch; Edit (tags Client) is 09:45-09:50. The pieces in order are
    // Draft, Draft, Edit, Draft, so the rounding of the day goes onto the last of Draft's, and not onto Edit, which the one stretch
    // 09:30-10:30 would put last.
    const overlapping = (method: 'up' | 'down') =>
      mkSnapshot({
        now: NOW,
        projects: [{ id: 'p' }],
        tags: TAGS,
        tasks: [{ id: 'w', projectId: 'p', tags: ['a', 'b'], subtasks: [{ id: 's1', text: 'Draft', tags: ['a'] }, { id: 's2', text: 'Edit', tags: ['b'] }] }],
        segs: [
          ['w', '2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z', { kind: 'work', segmentId: 'segA', subtaskId: 's1' }],
          ['w', '2026-03-10T09:30:00Z', '2026-03-10T10:00:00Z', { kind: 'thinking', segmentId: 'segA', subtaskId: 's1' }],
          ['w', '2026-03-10T10:00:00Z', '2026-03-10T10:30:00Z', { kind: 'thinking', segmentId: 'segA', subtaskId: 's1' }],
          ['w', '2026-03-10T09:45:00Z', '2026-03-10T09:50:00Z', { kind: 'work', segmentId: 'segB', subtaskId: 's2' }],
        ],
        rounding: [{ projectId: null, incrementMinutes: 15, method }],
      });
    const shown = (m: Metrics) => m.tags.parts.map((p) => [p.tags.join('+'), p.exact / MIN, p.billableSecs / MIN]);
    // 95 minutes: 105 rounded up, 90 rounded down.
    expect(shown(run(overlapping('up'), {}, 'billable'))).toEqual(expect.arrayContaining([['a', 90, 100], ['b', 5, 5]]));
    expect(shown(run(overlapping('down'), {}, 'billable'))).toEqual(expect.arrayContaining([['a', 90, 85], ['b', 5, 5]]));
  });

  it('orders pieces with the same start and end by their ids, as the core does, whatever order they arrive in', () => {
    const sets = effectiveTagsOf({ tags: ['a', 'b'], subtasks: [{ id: 's1', tags: ['a'] }, { id: 's2', tags: ['b'] }] });
    const piece = (id: string, subtaskId: string) => ({ id, taskId: 'w', projectId: 'p', start: 9 * 3600, end: 9 * 3600 + 600, os: 0, oe: 0, live: false, day: 0, kind: 'work' as const, subtaskId });
    // Two pieces of ten minutes at the same time, a day of 20 minutes rounded up to 30: the ten extra minutes go onto the greater id.
    // Only the fields `tagPartsOf` reads of a row: the day and what it bills.
    const row = { taskId: 'w', projectId: 'p', day: '1970-01-01', billableSecs: 1800 } as unknown as TaskDay;
    const parts = (pieces: ReturnType<typeof piece>[]) => tagPartsOf({ sets, pieces, rows: [row], zone: 'UTC', exact: 1200, billable: 1800, billableAvailable: true }).map((x) => [x.tags.join('+'), x.billable / MIN]);
    const expected = expect.arrayContaining([['a', 10], ['b', 20]]);
    expect(parts([piece('p1', 's1'), piece('p2', 's2')])).toEqual(expected);
    expect(parts([piece('p2', 's2'), piece('p1', 's1')])).toEqual(expected);
  });

  it('counts a billable pause under its task’s tags, as it belongs to no subtask, and a deleted tag nowhere', () => {
    const paused = mkSnapshot(specOf({ rounding: EXACT_ROUNDING, segs: [...SEGS, ['w', '2026-03-10T14:30:00Z', '2026-03-10T14:45:00Z', { kind: 'billablePause' }]] }));
    const b = run(paused, {}, 'billable');
    expect(mins(rowOf(b, 'a')?.billableSecs)).toBe(35 + 15 + 15);
    expect(mins(rowOf(b, 'b')?.billableSecs)).toBe(35 + 15 + 60 + 25);
    expect(mins(rowOf(b, 'a')?.exact)).toBe(35 + 15);
    const gone = mkSnapshot(specOf({ rounding: EXACT_ROUNDING, tags: [{ id: 'a', name: 'Design', color: '#7c3aed' }, { id: 'b', name: 'Client', deleted: true }] }));
    const g = run(gone);
    // Client counts nowhere: its time is no tag, and Write's Design + Client time is Design alone.
    expect(g.tags.stats.map((t) => [t.id, t.exact / MIN])).toEqual([['a', 35 + 15]]);
    expect(mins(g.tags.untagged?.exact)).toBe(60 + 30 + 45 + 25);
  });

  it('counts the running stretch of a subtask under that subtask’s tags', () => {
    const running = mkSnapshot(specOf({ rounding: EXACT_ROUNDING, segs: [...SEGS, ['w', '2026-03-12T11:30:00Z', null, { subtaskId: 's1' }]] }));
    const m2 = run(running);
    // Thirty minutes so far on Draft, which is Client's.
    expect(mins(rowOf(m2, 'b')?.exact)).toBe(35 + 60 + 25 + 30);
    expect(mins(rowOf(m2, 'a')?.exact)).toBe(35 + 15);
    const b = run(mkSnapshot(specOf({ segs: [...SEGS, ['w', '2026-03-12T11:30:00Z', null, { subtaskId: 's1' }]] })), {}, 'billable');
    expect(mins(rowOf(b, 'b')?.billableSecs)).toBe(45 + 60 + 30 + 30);
  });

  it('compares with the previous period part by part, under the tags the subtasks have now', () => {
    const before = mkSnapshot(
      specOf({
        rounding: EXACT_ROUNDING,
        segs: [...SEGS, on('w', '09:00', '09:30', 's1', '2026-03-03'), on('w', '11:00', '11:10', 's3', '2026-03-03'), on('w', '09:00', '09:20', 's2', '2026-03-04'), on('x', '09:00', '09:10', null, '2026-03-04'), on('z', '09:00', '09:40', null, '2026-02-20')],
      }),
    );
    const c = run(before, { compare: true });
    // Last week: Draft 30 [Client], Polish 10 [Design + Client], Edit 20 [none], Plan 10 [Design]; Call had nothing then.
    expect(mins(rowOf(c, 'a')?.prevSecs ?? undefined)).toBe(10 + 10);
    expect(mins(rowOf(c, 'b')?.prevSecs ?? undefined)).toBe(30 + 10);
    expect(mins(rowOf(c, null)?.prevSecs ?? undefined)).toBe(20);
    expect(rowOf(c, 'b')?.delta?.prev).toBe(40 * MIN);
  });
});

describe('the tag filter keeps the pieces that count under a chosen tag', () => {
  it('keeps the part of a task under the tag, and the whole of a task that has no subtask with tags of its own', () => {
    const m = run(exact, withTags(['b']));
    expect(m.volume.exact / MIN).toBe(60 + 20 + 10 + 5 + 25);
    expect(m.tasks.list.map((t) => [t.id, t.exact / MIN]).sort()).toEqual([['w', 95], ['z', 25]]);
    const design = run(exact, withTags(['a']));
    expect(design.volume.exact / MIN).toBe(20 + 10 + 5 + 15);
    expect(design.tasks.list.map((t) => [t.id, t.exact / MIN]).sort()).toEqual([['w', 35], ['x', 15]]);
  });

  it('"No tag" keeps the time that counts under none: a subtask with none ticked, and a task with none', () => {
    const m = run(exact, withTags([NO_TAG]));
    expect(m.volume.exact / MIN).toBe(30 + 45);
    expect(m.tasks.list.map((t) => [t.id, t.exact / MIN]).sort()).toEqual([['w', 30], ['y', 45]]);
    expect(m.subtasks.map((s) => [s.taskId, s.id, s.exact / MIN])).toEqual(expect.arrayContaining([['w', 's2', 30]]));
  });

  it('with a tag and "No tag" keeps both, and a task still counts once in the totals', () => {
    const m = run(exact, withTags(['a', NO_TAG]));
    expect(m.volume.exact / MIN).toBe(35 + 30 + 15 + 45);
    expect(run(exact, withTags(['a', 'b'])).volume.exact / MIN).toBe(125 - 30 + 15 + 25);
    expect(run(exact, withTags(['a', 'b', NO_TAG])).volume.exact / MIN).toBe(210);
  });

  it('rounds what is kept, so Billable stays available and a part day rounds on its own', () => {
    const m = run(rounded, withTags(['b']), 'billable');
    expect(m.billableAvailable).toBe(true);
    // 95 min of Write on the 10th round up to 105, and Call's 25 to 30.
    expect(m.volume.billable / MIN).toBe(105 + 30);
  });

  it('keeps a billable pause by its task’s tags, and pending time away by the tags of the segment it happened in', () => {
    const snapshot = mkSnapshot(specOf({ segs: [on('w', '09:00', '10:00', 's1'), on('w', '10:00', '10:30', 's2'), ['w', '2026-03-10T14:30:00Z', '2026-03-10T14:45:00Z', { kind: 'billablePause' }]], gaps: [['w', '2026-03-10T09:30:00Z', '2026-03-10T09:40:00Z', 'pending']] }));
    // The time away is inside Draft's segment, which the segments of the snapshot carry under a segment id of its own.
    const linked: Snapshot = { ...snapshot, segments: snapshot.segments.map((s, i) => (i === 0 ? { ...s, segmentId: 'draft-seg' } : s)), gaps: snapshot.gaps.map((g) => ({ ...g, segmentId: 'draft-seg' })) };
    const withPause = (tagIds: string[]) => run(linked, withTags(tagIds), 'exact');
    expect(withPause(['b']).pieces.unconfirmed.secs).toBe(10 * MIN);
    expect(withPause(['a']).pieces.unconfirmed.secs).toBe(0);
    expect(withPause([NO_TAG]).pieces.unconfirmed.secs).toBe(0);
    expect(withPause(['a']).pieces.pauseSecs).toBe(15 * MIN);
    expect(withPause([NO_TAG]).pieces.pauseSecs).toBe(0);
    expect(run(linked).pieces.unconfirmed.secs).toBe(10 * MIN);
  });

  it('drops a subtask’s time when its task has no tags at all: its list holds nothing to count under', () => {
    const bare = mkSnapshot(specOf({ tasks: [{ id: 'w', projectId: 'p', tags: [], subtasks: WRITE_ITEMS }], segs: SEGS.slice(0, 5) }));
    expect(run(bare, withTags([NO_TAG])).volume.exact / MIN).toBe(125);
    expect(run(bare, withTags(['a'])).volume.exact).toBe(0);
  });
});

describe('drill-down follows the tags a piece counts under', () => {
  const dr = (sel: DrillSel) => drill(exact, params('UTC', WEEK), nowOf(NOW), sel);
  const byTask = (sel: DrillSel) => dr(sel).tasks.map((t) => [t.taskId, t.secs / MIN]).sort();

  it('lists the time under a tag, a subtask with tags of its own counting only under those', () => {
    expect(dr({ title: 'Tag: Client', tagId: 'b' }).totalSecs / MIN).toBe(120);
    expect(byTask({ title: 'Tag: Client', tagId: 'b' })).toEqual([['w', 95], ['z', 25]]);
    expect(byTask({ title: 'Tag: Design', tagId: 'a' })).toEqual([['w', 35], ['x', 15]]);
    expect(byTask({ title: 'No tag', tagId: null })).toEqual([['w', 30], ['y', 45]]);
  });

  it('counts a deleted tag nowhere: time whose tags are all deleted is under no tag, as the bar for no tag has it', () => {
    const gone = mkSnapshot({
      now: NOW,
      projects: [{ id: 'p' }],
      tags: [{ id: 'a', name: 'Design', color: '#7c3aed' }, { id: 'd', name: 'Old', deleted: true }],
      tasks: [
        { id: 'w', projectId: 'p', tags: ['a', 'd'], subtasks: [{ id: 's1', text: 'Draft', tags: ['d'] }] },
        { id: 'x', projectId: 'p', tags: ['d'] },
      ],
      rounding: EXACT_ROUNDING,
      segs: [on('w', '09:00', '10:00', 's1'), on('w', '11:00', '11:20'), on('x', '14:00', '14:30')],
    });
    const bar = run(gone).tags.untagged?.exact;
    expect(bar).toBe(90 * MIN);
    const inGone = (sel: DrillSel) => drill(gone, params('UTC', WEEK), nowOf(NOW), sel).totalSecs;
    expect(inGone({ title: 'No tag', tagId: null })).toBe(bar);
    expect(inGone({ title: 'No tag', tagSet: [] })).toBe(bar);
    expect(inGone({ title: 'Tag: Design', tagId: 'a' })).toBe(20 * MIN);
  });

  it('lists the time of one row of the Tags level: exactly that combination of tags', () => {
    expect(byTask({ title: 'Design + Client', tagSet: ['a', 'b'] })).toEqual([['w', 35]]);
    expect(byTask({ title: 'Client', tagSet: ['b'] })).toEqual([['w', 60], ['z', 25]]);
    expect(byTask({ title: 'Design', tagSet: ['a'] })).toEqual([['x', 15]]);
    expect(byTask({ title: 'No tag', tagSet: [] })).toEqual([['w', 30], ['y', 45]]);
  });
});

/** One task with two subtasks that have a tag each, for the rounding cases. */
function specOfOne(): Spec {
  return { now: NOW, projects: [{ id: 'p' }], tags: TAGS, tasks: [{ id: 'w', projectId: 'p', tags: ['a', 'b'], subtasks: [{ id: 's1', text: 'Edit', tags: ['a'] }, { id: 's2', text: 'Polish', tags: ['b'] }] }] };
}

// ---------------------------------------------------------------- the Tags level of Share of time

/** The card as the Analysis tab draws it, for a snapshot. */
function envOf(snapshot: Snapshot, basis: Basis): SecEnv & { drill: ReturnType<typeof vi.fn<(sel: DrillSel) => void>> } {
  const m = analyze(snapshot, params('UTC', WEEK), nowOf(NOW), basis);
  return {
    m,
    snapshot,
    hide: false,
    nowSec: parseIso(NOW),
    pname: (id) => snapshot.projects.find((p) => p.id === id)?.name ?? id,
    pcolor: () => '#2563eb',
    tname: (id) => snapshot.tasks.find((t) => t.id === id)?.name ?? id,
    order: m.projects.map((p) => p.id),
    drill: vi.fn<(sel: DrillSel) => void>(),
    openGlossary: vi.fn(),
    jumps: { openProject: vi.fn(), openSettings: vi.fn() },
  };
}
const card = (): HTMLElement => screen.getByRole('heading', { name: 'Share of time' }).closest('article') as HTMLElement;

describe('the Tags level of Share of time', () => {
  async function tagsLevel(snapshot: Snapshot, basis: Basis = 'exact') {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const env = envOf(snapshot, basis);
    render(<Projects env={env} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tags' }));
    const rows = within(screen.getByRole('list', { name: 'Share of time legend, tags' })).getAllByRole('listitem');
    return { user, env, rows };
  }
  const nameOf = (li: HTMLElement): string => li.querySelector('.a-share-name')?.textContent ?? '';
  const minutesIn = (li: HTMLElement): number => {
    const m = /^(\d+)h (\d\d)m /.exec(li.querySelector('.a-share-fig')?.textContent ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
  };

  it('gives each exact combination a row, a task’s subtasks counting under their own tags, and the rows add up to the total', async () => {
    const { rows } = await tagsLevel(exact);
    expect(rows.map((li) => [nameOf(li), minutesIn(li)])).toEqual([['Client', 85], ['No tag', 75], ['Design + Client', 35], ['Design', 15]]);
    expect(rows.reduce((n, li) => n + minutesIn(li), 0)).toBe(210);
    expect(card().querySelector('.a-donut-total')?.textContent).toContain('3h 30m');
  });

  it('still adds up under Billable, where the row’s rounding is on its latest piece', async () => {
    const { rows } = await tagsLevel(rounded, 'billable');
    expect(rows.map((li) => [nameOf(li), minutesIn(li)])).toEqual([['Client', 135 - 45], ['No tag', 75], ['Design + Client', 45], ['Design', 15]]);
    expect(rows.reduce((n, li) => n + minutesIn(li), 0)).toBe(225);
  });

  it('opens the time of one combination, not the whole tasks behind it', async () => {
    const { user, env, rows } = await tagsLevel(exact);
    await user.click(within(rows[2] as HTMLElement).getByRole('button'));
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Design + Client', tagSet: ['a', 'b'] });
  });

  it('counts a task once in a row that two of its parts reach, such as sets that differ only by a tag that was deleted', () => {
    const tags = [{ id: 'a', name: 'Design', color: '#7c3aed' }];
    const model = tagShares(
      [
        { id: 't', secs: 600, exact: 600, billableSecs: 600, tagIds: ['a', 'gone'] },
        { id: 't', secs: 300, exact: 300, billableSecs: 300, tagIds: ['a'] },
        { id: 'u', secs: 60, exact: 60, billableSecs: 60, tagIds: ['a'] },
      ],
      tags,
    );
    expect(model.lines).toHaveLength(1);
    expect(model.lines[0]).toMatchObject({ label: 'Design', secs: 960, taskIds: ['t', 'u'] });
  });
});

describe('the words', () => {
  it('say which tasks, or which time, a choice of tags keeps', () => {
    expect(tagFilterHint([NO_TAG, 'a'])).toBe('Tasks with any selected tag, or with no tag');
    expect(tagFilterHint([], true)).toBe('All tasks');
    expect(tagFilterHint([NO_TAG], true)).toBe('Time with no tag');
    expect(tagFilterHint(['a'], true)).toBe('Time with any selected tag');
    expect(tagFilterHint([NO_TAG, 'a'], true)).toBe('Time with any selected tag, or with no tag');
  });

  it('are the time ones only while some subtask has tags of its own', () => {
    expect(anySubtaskTags(exact.tasks)).toBe(true);
    expect(anySubtaskTags(mkSnapshot(specOf({ tasks: [{ id: 'w', projectId: 'p', tags: ['a'], subtasks: [{ id: 's1', text: 'Draft' }] }] })).tasks)).toBe(false);
    // An old file or a fixture can leave a task's list out altogether.
    expect(anySubtaskTags(exact.tasks.map((t) => ({ ...t, subtasks: undefined as unknown as Snapshot['tasks'][number]['subtasks'] })))).toBe(false);
  });

  function Controlled({ snapshot }: { snapshot: Snapshot }) {
    return <Controls snapshot={snapshot} today="2026-03-12" range={{ kind: 'week', anchor: '2026-03-12' }} setRange={vi.fn()} periodLabel="9 Mar – 15 Mar 2026" filters={{ ...NO_FILTERS, tagIds: ['a'] }} setFilters={vi.fn()} basis="billable" setBasis={vi.fn()} billableAvailable compare={false} setCompare={vi.fn()} onGlossary={vi.fn()} />;
  }
  const hint = (): string => screen.getByRole('group', { name: 'Tag filter' }).querySelector('.a-tag-hint')?.textContent ?? '';

  it('under the tag filter name the time that is kept once a subtask has tags of its own, and the tasks before', () => {
    const { unmount } = render(<Controlled snapshot={rounded} />);
    expect(hint()).toBe(`Time with any selected tag; ${TAG_FILTER_KEEPS_BY_SUBTASK}`);
    unmount();
    render(<Controlled snapshot={mkSnapshot(specOf({ tasks: [{ id: 'w', projectId: 'p', tags: ['a'] }] }))} />);
    expect(hint()).toBe(`Tasks with any selected tag; ${TAG_FILTER_KEEPS}`);
  });

  it('say in the Tags section how many tasks have subtasks counted under tags of their own', () => {
    const env = envOf(rounded, 'exact');
    render(<TagsSection env={env} />);
    const note = screen.getByText(/Each bar is the time that counts under the tag/);
    expect(note.textContent).toContain('1 task has such subtasks');
    expect(note.textContent).toContain('1 task carries more than one tag');
    expect(screen.getByRole('img', { name: /Time by tag/ })).toBeInTheDocument();
  });

  it('keep the old words in the Tags section while no task is split', () => {
    const env = envOf(mkSnapshot(specOf({ tasks: [{ id: 'w', projectId: 'p', tags: ['a', 'b'] }], segs: SEGS.slice(0, 2) })), 'exact');
    render(<TagsSection env={env} />);
    expect(screen.getByText(/Each bar is the full time of every task that carries the tag/)).toBeInTheDocument();
  });
});
