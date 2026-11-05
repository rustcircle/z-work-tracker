// Task-list items of a TipTap document, the unit that can carry its own tracked time and some of the task's tags. Mirrors
// `subtasks.rs`: the backend assigns missing or repeated ids, a copy keeps the text but forgets ids and ticks, and the tags
// a piece of time counts under follow `effective` (`fixtures/subtask-tags-parity.json` pins both sides to the same table).
import type { RichDoc } from './types';

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const kids = (n: Json): Json[] => (Array.isArray(n.content) ? (n.content as unknown[]).map(asObj).filter((x): x is Json => x !== null) : []);
const isList = (t: unknown): boolean => t === 'orderedList' || t === 'bulletList' || t === 'taskList';

function inlineText(n: Json, out: string[]): void {
  if (n.type === 'text') {
    if (typeof n.text === 'string') out.push(n.text);
  } else if (n.type === 'hardBreak') out.push(' ');
  else for (const c of kids(n)) inlineText(c, out);
}

/**
 * The item's own text, without any nested list. A line break is a space, and so is the gap between two
 * paragraphs (a paste can put several in one item), so no two words run together.
 */
function itemText(item: Json): string {
  const parts: string[] = [];
  for (const c of kids(item)) {
    if (isList(c.type)) continue;
    const out: string[] = [];
    inlineText(c, out);
    const text = out.join('').trim();
    if (text !== '') parts.push(text);
  }
  return parts.join(' ');
}

export interface DocItem {
  id: string;
  text: string;
  checked: boolean;
}

/** Every task-list item in document order. A missing id reads as an empty string. */
export function subtaskItems(doc: RichDoc | undefined): DocItem[] {
  const out: DocItem[] = [];
  const walk = (n: Json): void => {
    if (n.type === 'taskItem') {
      const attrs = asObj(n.attrs);
      out.push({ id: typeof attrs?.subtaskId === 'string' ? attrs.subtaskId : '', text: itemText(n), checked: attrs?.checked === true });
    }
    for (const c of kids(n)) walk(c);
  };
  const root = asObj(doc);
  if (root) walk(root);
  return out;
}

function mapItems(node: Json, f: (attrs: Json, text: string) => void): void {
  if (node.type === 'taskItem') {
    const text = itemText(node);
    const attrs = asObj(node.attrs) ?? {};
    node.attrs = attrs;
    f(attrs, text);
  }
  if (Array.isArray(node.content)) for (const c of node.content as unknown[]) {
    const o = asObj(c);
    if (o) mapItems(o, f);
  }
}

/** For a copy: keeps the text, unticks everything and forgets ids, so no time carries over. */
export function resetSubtasks(doc: RichDoc): RichDoc {
  if (!doc) return doc;
  const out = structuredClone(doc) as Json;
  mapItems(out, (attrs) => {
    attrs.checked = false;
    delete attrs.subtaskId;
  });
  return out;
}

/**
 * Gives each item a stable id. An editor may send items back without one, so a missing id is recovered
 * from the previous version by text, then by position, and only then generated with `fresh`.
 */
export function assignSubtaskIds(doc: RichDoc, previous: RichDoc | undefined, fresh: () => string): RichDoc {
  if (!doc) return doc;
  const old = subtaskItems(previous);
  const used = subtaskItems(doc).map((i) => i.id).filter((i) => i !== '');
  const out = structuredClone(doc) as Json;
  let position = 0;
  const seen = new Set<string>();
  mapItems(out, (attrs, text) => {
    const here = position;
    position += 1;
    const current = attrs.subtaskId;
    // An id that an earlier item already holds (a pasted or duplicated item) is reassigned.
    if (typeof current === 'string' && current !== '' && !seen.has(current)) {
      seen.add(current);
      return;
    }
    const byText = old.find((o) => o.text === text && o.id !== '' && !used.includes(o.id));
    const placed = old[here];
    const byPlace = placed && placed.id !== '' && !used.includes(placed.id) ? placed : undefined;
    const id = (byText ?? byPlace)?.id ?? fresh();
    used.push(id);
    seen.add(id);
    attrs.subtaskId = id;
  });
  return out;
}

// ---------------------------------------------------------------- tags of a subtask (1.4)

/**
 * The tags a piece of a task's time counts under (`subtasks::effective`): the subtask's own list cut to the task's tags, in
 * the task's order, or with no list (`null`: "Same as task") the task's tags. Empty is "No tag". Every reader follows this, so
 * a tag taken off the task on a version that cannot touch the lists drops out of them here, and a list naming a tag twice
 * counts it once.
 */
export function effectiveTags(taskTags: readonly string[], own: readonly string[] | null | undefined): string[] {
  return own == null ? [...taskTags] : taskTags.filter((t) => own.includes(t));
}

/** A subtask's own tags as an editor shows them (`subtasks::shown`): the stored list cut to the task's tags, or `null` for "Same as task". */
export function shownTags(taskTags: readonly string[], stored: readonly string[] | null | undefined): string[] | null {
  return stored == null ? null : effectiveTags(taskTags, stored);
}

/** Tags are a set: their order is no change. */
export function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

/** Two states of a subtask's tags, as an editor shows them: `null` ("Same as task") is only the same as `null`, and lists are sets. */
export function sameOverride(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return sameTagSet(a, b);
}

/** What `effectiveTagsOf` reads of a task: the snapshot's task view has both (`Subtask.tags` is what the editor shows). */
export interface TaggedTask {
  tags: readonly string[];
  /** The items of the task's list now. A task read from an old file or a fixture may come without them. */
  subtasks?: readonly { id: string; tags?: readonly string[] | null }[];
}

/** The tags each piece of one task's time counts under, worked out once (`subtasks::EffectiveTags`). */
export interface TaskTagSets {
  /**
   * For time on `subtaskId`, or on none. Only an item still in the list keeps its own tags: time on one that is gone counts
   * under the task's tags, as time on no subtask does.
   */
  of(subtaskId: string | null | undefined): readonly string[];
  /** Every piece of the task counts under the task's own tags, so nothing needs splitting. */
  readonly uniform: boolean;
}

export function effectiveTagsOf(task: TaggedTask): TaskTagSets {
  const base = effectiveTags(task.tags, null);
  const own = new Map<string, string[]>();
  for (const item of task.subtasks ?? []) {
    if (item.id !== '' && item.tags != null) own.set(item.id, effectiveTags(task.tags, item.tags));
  }
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i]);
  return {
    of: (subtaskId) => (subtaskId != null ? own.get(subtaskId) : undefined) ?? base,
    uniform: [...own.values()].every((tags) => same(tags, base)),
  };
}
