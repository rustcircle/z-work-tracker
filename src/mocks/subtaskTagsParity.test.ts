// Subtask tags in the mock, against the table the Rust core runs (subtasks.rs and machine.rs): which tags a subtask's time
// counts under, what a change to the task's tags does to the lists, and what setting them answers, a refusal included.
// A test that passes on the mock then says something about the real backend. The UI's own reading of the same table is
// src/lib/subtaskTags.test.ts.
import { describe, expect, it } from 'vitest';

import table from '../../fixtures/subtask-tags-parity.json';
import { effectiveTagsOf, resetSubtasks } from '../lib/subtasks';
import type { RichDoc, Snapshot, SubtaskTagsExpected, SubtaskTagsReply, WithId } from '../lib/types';
import { emptyState, handle, type MockState, type MockTask } from './ipcMock';

// The JSON import types each case on its own, so the common shapes are stated here. The file is the contract and the Rust
// tests read the same bytes: every case has exactly these fields.
type Lists = Record<string, string[] | null>;
interface Shape {
  name: string;
  taskTags: string[];
  subtasks?: string[];
  overrides: Lists;
}
interface EffectiveCase extends Shape {
  time: { subtask: string | null; tags: string[] }[];
}
interface PruneCase extends Shape {
  newTaskTags: string[];
  expectOverrides: Lists;
  restamped: string[];
}
interface SetCase extends Shape {
  request: { subtask: string; tags: string[] | null; expected?: SubtaskTagsExpected };
  expect?: { conflict: boolean; tags: string[] | null; effective: string[]; stored: Lists; written: boolean };
  expectError?: string;
}
const effectiveCases = table.effective as unknown as EffectiveCase[];
const pruneCases = table.prune as unknown as PruneCase[];
const setCases = table.set as unknown as SetCase[];

const TAGS = ['tag-a', 'tag-b', 'tag-c', 'tag-d', 'tag-x'];
const FIRST = '2026-11-05T09:00:00Z';
const STAMP = { at: '2026-11-01T09:00:00Z', by: 'd' };

/** A task list holding these subtask ids, as the editor writes one. */
const listOf = (ids: readonly string[]): RichDoc => ({
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: ids.map((id) => ({
        type: 'taskItem',
        attrs: { checked: false, subtaskId: id },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `Item ${id}` }] }],
      })),
    },
  ],
});

/** A store holding one live task shaped as a case says, with every tag the table names. */
function world(c: Shape): { s: MockState; task: MockTask } {
  const s = emptyState(FIRST);
  s.tags = TAGS.map((id) => ({ id, name: id, color: '#336699', deleted: false, stamp: STAMP }));
  s.projects.push({ id: 'p', name: 'P', color: '#2563eb', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: FIRST });
  const task: MockTask = {
    id: 't',
    name: 'T',
    projectId: 'p',
    description: listOf(c.subtasks ?? []),
    state: 'paused',
    pauseReason: null,
    createdAt: FIRST,
    stoppedAt: null,
    runningElsewhere: null,
    continuedFrom: null,
    tags: [...c.taskTags],
    subtaskTags: Object.fromEntries(Object.entries(c.overrides).map(([id, tags]) => [id, { tags: tags && [...tags], stamp: STAMP }])),
  };
  s.tasks.push(task);
  return { s, task };
}

const storedLists = (task: MockTask): Lists => Object.fromEntries(Object.entries(task.subtaskTags ?? {}).map(([id, e]) => [id, e.tags]));
const snapshotTask = (s: MockState): Snapshot['tasks'][number] => {
  const found = (handle(s, 'get_snapshot', {}) as Snapshot).tasks.find((t) => t.id === 't');
  if (!found) throw new Error('the task is not in the snapshot');
  return found;
};
const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('the snapshot shows each subtask’s tags as the shared table says', () => {
  it.each(effectiveCases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const { s } = world(c);
    const task = snapshotTask(s);
    const tags = effectiveTagsOf(task);
    for (const t of c.time) expect(tags.of(t.subtask), `time on ${String(t.subtask)}`).toEqual(t.tags);
    // The items are exactly those of the description, each with what the editor shows.
    expect(task.subtasks.map((i) => i.id)).toEqual(c.subtasks ?? []);
    for (const i of task.subtasks) {
      const stored = c.overrides[i.id];
      expect(i.tags, i.id).toEqual(stored == null ? null : c.taskTags.filter((t) => stored.includes(t)));
    }
  });

  it('never shows the stored entries with their stamps: the snapshot has the view only', () => {
    const { s } = world({ name: 'x', taskTags: ['tag-a'], subtasks: ['s1'], overrides: { s1: ['tag-a'] } });
    expect(Object.keys(snapshotTask(s))).not.toContain('subtaskTags');
  });
});

describe('a change to the task’s tags prunes the lists as the shared table says', () => {
  const stored = (s: MockState): MockTask => {
    const t = s.tasks.find((x) => x.id === 't');
    if (!t) throw new Error('no task');
    return t;
  };

  it.each(pruneCases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    // `update_task` keeps the tags when it is sent none, so it can only be asked for a list that has some.
    const ways = c.newTaskTags.length > 0 ? (['patch_task', 'update_task'] as const) : (['patch_task'] as const);
    for (const how of ways) {
      const { s, task: before } = world(c);
      const old = structuredClone(before.subtaskTags ?? {});
      const args = how === 'patch_task' ? { id: 't', patch: { tags: c.newTaskTags } } : { id: 't', input: { name: before.name, projectId: before.projectId, description: before.description, tags: c.newTaskTags } };
      handle(s, how, args);
      const after = stored(s);
      expect(after.tags, how).toEqual(c.newTaskTags);
      expect(storedLists(after), how).toEqual(c.expectOverrides);
      const moved = Object.entries(after.subtaskTags ?? {})
        .filter(([id, e]) => e.stamp.at !== old[id]?.stamp.at)
        .map(([id]) => id)
        .sort();
      expect(moved, how).toEqual(c.restamped);
      for (const id of moved) expect(((after.subtaskTags ?? {})[id]?.stamp.at ?? '') > (old[id]?.stamp.at ?? ''), `${how}: ${id} moves past its old stamp`).toBe(true);
    }
  });

  it('prunes with the next change, even to a list that holds only what the task already has', () => {
    const { s } = world({ name: 'x', taskTags: ['tag-a', 'tag-c'], subtasks: ['s1'], overrides: { s1: ['tag-a', 'tag-b', 'tag-c'] } });
    handle(s, 'patch_task', { id: 't', patch: { tags: ['tag-c', 'tag-a'] } });
    expect(storedLists(stored(s))).toEqual({ s1: ['tag-a', 'tag-c'] });
  });

  it('leaves the lists alone when the tags are the same, and when a tag is deleted from the catalogue', () => {
    const { s } = world({ name: 'x', taskTags: ['tag-a', 'tag-b'], subtasks: ['s1'], overrides: { s1: ['tag-a', 'tag-b'] } });
    handle(s, 'patch_task', { id: 't', patch: { tags: ['tag-a', 'tag-b'] } });
    handle(s, 'delete_tag', { id: 'tag-b' });
    expect(storedLists(stored(s))).toEqual({ s1: ['tag-a', 'tag-b'] });
    // The deleted tag stays on the task, so the item still shows it: every reader leaves a deleted tag out where it counts.
    expect(snapshotTask(s).subtasks[0]?.tags).toEqual(['tag-a', 'tag-b']);
  });
});

describe('setting a subtask’s tags follows the shared table', () => {
  it.each(setCases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const { s, task } = world(c);
    const before = structuredClone(task);
    const { subtask, tags, expected } = c.request;
    const run = () => handle(s, 'set_subtask_tags', { taskId: 't', subtaskId: subtask, tags, ...(expected ? { expected } : {}) });
    if (c.expectError) {
      expect(caught(run)).toMatchObject({ code: 'not_found', message: c.expectError });
      expect(task, 'nothing written').toEqual(before);
      return;
    }
    const want = c.expect;
    if (!want) throw new Error('a case has either expect or expectError');
    const reply = run() as SubtaskTagsReply;
    expect(reply.conflict).toBe(want.conflict);
    expect(reply.tags).toEqual(want.tags);
    expect(reply.effective).toEqual(want.effective);
    expect(storedLists(task)).toEqual(want.stored);
    expect(JSON.stringify(task) !== JSON.stringify(before)).toBe(want.written);
    // The reply carries a snapshot that shows the same.
    expect(reply.snapshot.tasks.find((t) => t.id === 't')?.subtasks.find((i) => i.id === subtask)?.tags).toEqual(want.tags);
    // Only that subtask's entry moves, past its old stamp, and nothing else of the task changes.
    const { subtaskTags: after, ...rest } = task;
    const { subtaskTags: was, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    for (const [id, entry] of Object.entries(after ?? {})) {
      if (JSON.stringify(entry) === JSON.stringify(was?.[id])) continue;
      expect(id).toBe(subtask);
      expect(entry.stamp.at > (was?.[id]?.stamp.at ?? '')).toBe(true);
    }
  });

  it('answers with a snapshot even when it writes nothing, and only a write moves the data', () => {
    const { s, task } = world({ name: 'x', taskTags: ['tag-a'], subtasks: ['s1'], overrides: {} });
    const reply = handle(s, 'set_subtask_tags', { taskId: 't', subtaskId: 's1', tags: null }) as SubtaskTagsReply;
    expect(reply.snapshot.tasks[0]?.id).toBe('t');
    expect(task.subtaskTags).toEqual({});
  });

  it('needs a task, an item of its list, and a key the backend takes', () => {
    const { s } = world({ name: 'x', taskTags: ['tag-a'], subtasks: ['s1'], overrides: {} });
    expect(caught(() => handle(s, 'set_subtask_tags', { taskId: 'nope', subtaskId: 's1', tags: [] }))).toMatchObject({ code: 'not_found', message: 'task not found' });
    expect(caught(() => handle(s, 'set_subtask_tags', { taskId: 't', subtaskId: '', tags: [] }))).toMatchObject({ code: 'not_found', message: 'subtask not found' });
    // An id no description may hold, from a damaged one: refused, as a reader would refuse the entry.
    const long = 'x'.repeat(65);
    const damaged = world({ name: 'x', taskTags: ['tag-a'], subtasks: [long], overrides: {} });
    expect(caught(() => handle(damaged.s, 'set_subtask_tags', { taskId: 't', subtaskId: long, tags: [] }))).toMatchObject({ code: 'validation' });
    expect(damaged.task.subtaskTags).toEqual({});
    // A task that is gone can't be given any.
    handle(s, 'delete_task', { id: 't' });
    expect(caught(() => handle(s, 'set_subtask_tags', { taskId: 't', subtaskId: 's1', tags: null }))).toMatchObject({ code: 'not_found', message: 'task not found' });
  });

  it('stops at the 10,000th subtask with tags of its own, as the backend does, but still changes one it has', () => {
    const ids = Array.from({ length: 10_001 }, (_, i) => `s${i}`);
    const { s, task } = world({ name: 'x', taskTags: ['tag-a'], subtasks: ids, overrides: Object.fromEntries(ids.slice(0, 10_000).map((id) => [id, ['tag-a']])) });
    expect(caught(() => handle(s, 'set_subtask_tags', { taskId: 't', subtaskId: 's10000', tags: [] }))).toMatchObject({ code: 'validation' });
    expect(Object.keys(task.subtaskTags ?? {})).toHaveLength(10_000);
    const reply = handle(s, 'set_subtask_tags', { taskId: 't', subtaskId: 's0', tags: [] }) as SubtaskTagsReply;
    expect(reply.tags).toEqual([]);
  });
});

describe('a task made from another starts on "Same as task" (Q5)', () => {
  it('a copy keeps the text and forgets the ids, so it has no entry; the original keeps its own', () => {
    const { s, task } = world({ name: 'x', taskTags: ['tag-a', 'tag-b'], subtasks: ['s1', 's2'], overrides: { s1: ['tag-a'], s2: [] } });
    const { id } = handle(s, 'create_task', { input: { name: 'Copy', projectId: 'p', description: resetSubtasks(task.description), continuedFrom: 't', tags: task.tags } }) as WithId;
    const copy = s.tasks.find((t) => t.id === id);
    expect(copy?.subtaskTags ?? {}).toEqual({});
    const snap = handle(s, 'get_snapshot', {}) as Snapshot;
    expect(snap.tasks.find((t) => t.id === id)?.subtasks.map((i) => [i.text, i.tags])).toEqual([['Item s1', null], ['Item s2', null]]);
    expect(snap.tasks.find((t) => t.id === 't')?.subtasks.map((i) => i.tags)).toEqual([['tag-a'], []]);
  });
});
