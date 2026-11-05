// The tags a piece of a subtask's time counts under, against the table the Rust core runs (subtasks.rs), so the UI and the
// backend cannot drift apart. The mock's side of the same table is src/mocks/subtaskTagsParity.test.ts.
import { describe, expect, it } from 'vitest';

import table from '../../fixtures/subtask-tags-parity.json';
import { effectiveTags, effectiveTagsOf, sameOverride, sameTagSet, shownTags } from './subtasks';

/** The shape of a case in `effective`: the JSON import types each case on its own, so the common shape is stated here. */
interface EffectiveCase {
  name: string;
  taskTags: string[];
  subtasks: string[];
  overrides: Record<string, string[] | null>;
  time: { subtask: string | null; tags: string[] }[];
}
// The file is the contract and the Rust test reads the same bytes; every case has exactly these fields.
const cases = table.effective as unknown as EffectiveCase[];

/** The task as the backend's snapshot shows it: each item with the tags the editor shows, which is the stored list cut to the task's. */
const viewOf = (c: EffectiveCase) => ({
  tags: c.taskTags,
  subtasks: c.subtasks.map((id) => ({ id, tags: shownTags(c.taskTags, c.overrides[id]) })),
});

describe('effective tags of a subtask, the table shared with the Rust core', () => {
  it('has the cases the Rust test counts', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const tags = effectiveTagsOf(viewOf(c));
    for (const t of c.time) expect(tags.of(t.subtask), `time on ${String(t.subtask)}`).toEqual(t.tags);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: what an item shows says the same as the rule', (_, c) => {
    for (const id of c.subtasks) {
      const own = shownTags(c.taskTags, c.overrides[id]);
      expect(effectiveTags(c.taskTags, own), id).toEqual(effectiveTagsOf(viewOf(c)).of(id));
    }
  });

  it('says a task counts as one set of tags unless a subtask has a different one', () => {
    const uniform = (name: string): boolean => {
      const found = cases.find((c) => c.name === name);
      if (!found) throw new Error(`no case named "${name}" in the table`);
      return effectiveTagsOf(viewOf(found)).uniform;
    };
    expect(uniform("no override: every piece has the task's tags")).toBe(true);
    expect(uniform('a reset is Same as task')).toBe(true);
    expect(uniform("a subtask no longer in the description falls back to the task's tags")).toBe(true);
    expect(uniform('a task without tags gives No tag whatever its subtasks hold')).toBe(true);
    expect(uniform("a subset on one subtask, its sibling keeps the task's tags")).toBe(false);
    expect(uniform('an empty subset is No tag (Q1)')).toBe(false);
  });
});

describe('the pieces of the rule', () => {
  it('cuts a list to the task’s tags in the task’s order, and counts a tag named twice once', () => {
    expect(effectiveTags(['a', 'b', 'c'], ['c', 'a', 'a'])).toEqual(['a', 'c']);
    expect(effectiveTags(['a', 'b'], ['z'])).toEqual([]);
  });

  it('gives the task’s tags for "Same as task", also when the field is missing from an old fixture', () => {
    expect(effectiveTags(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(effectiveTags(['a', 'b'], undefined)).toEqual(['a', 'b']);
    expect(effectiveTagsOf({ tags: ['a'], subtasks: [{ id: 's' }] }).of('s')).toEqual(['a']);
    expect(effectiveTagsOf({ tags: ['a'] }).of('s')).toEqual(['a']);
  });

  it('shows a reset as null and an empty list as No tag, which is not the same', () => {
    expect(shownTags(['a'], null)).toBeNull();
    expect(shownTags(['a'], undefined)).toBeNull();
    expect(shownTags(['a'], [])).toEqual([]);
    expect(sameOverride(null, [])).toBe(false);
    expect(sameOverride([], null)).toBe(false);
    expect(sameOverride(null, undefined)).toBe(true);
  });

  it('compares lists as sets', () => {
    expect(sameTagSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameTagSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameOverride(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('gives time on no item, or on an item that has no id, the task’s tags', () => {
    const view = { tags: ['a', 'b'], subtasks: [{ id: 's', tags: ['b'] }, { id: '', tags: ['a'] }] };
    const tags = effectiveTagsOf(view);
    expect(tags.of(null)).toEqual(['a', 'b']);
    expect(tags.of(undefined)).toEqual(['a', 'b']);
    expect(tags.of('')).toEqual(['a', 'b']);
    expect(tags.of('s')).toEqual(['b']);
    expect(tags.uniform).toBe(false);
  });
});
