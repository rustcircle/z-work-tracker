// The Analysis tag filter in one place: which time a choice of tags keeps. The engine (every filtered figure), the count of
// pending away time and anything else that filters by tag all ask here, so they cannot disagree.
//
// The rule, from the owner: no tag chosen is the same as every tag, nothing is filtered. With tags chosen, only the time that
// counts under ANY of them is kept (OR). The extra choice "No tag" stands for the time that counts under no tag, and joins the
// others the same way: "No tag" alone keeps the untagged time, "No tag" with a tag keeps the untagged time and the time that
// counts under that tag. Time counts under its task's tags, except time on a subtask that has tags of its own (1.4), which
// counts under those. A task whose subtasks all count under its own tags is kept or left out whole, as before.
import type { Snapshot, Tag } from '../../lib/types';
import { taggingOf } from './tagSets';

/**
 * The choice "No tag", kept in `Filters.tagIds` beside the ids of real tags (the way `OUTSIDE` stands for "outside any
 * shift" in the shift filter), so a filter that has it is a filter like any other: it counts as filtered, clears with
 * the others, and is part of the key the engine caches on.
 */
export const NO_TAG = '__no-tag';

/** The ids of the live tags among a task's tags. A deleted tag no longer counts: a task left with none has no tag. */
export function liveTagsOf(taskTags: readonly string[], live: ReadonlySet<string>): string[] {
  return taskTags.filter((id) => live.has(id));
}

/** Whether time that counts under these tags is kept by the chosen tags (which may include `NO_TAG`). A task's own tags, or a subtask's. */
export function taskPassesTagFilter(taskTags: readonly string[], chosen: readonly string[], live: ReadonlySet<string>): boolean {
  if (chosen.length === 0) return true;
  const mine = liveTagsOf(taskTags, live);
  if (mine.length === 0) return chosen.includes(NO_TAG);
  return mine.some((id) => chosen.includes(id));
}

/**
 * The words for a choice of tags: "Tasks with any selected tag", and so on. Controls writes them under the tag filter.
 * While some subtask has tags of its own (`subtaskTags`) a task is no longer kept or left out whole, so it says time.
 */
export function tagFilterHint(chosen: readonly string[], subtaskTags = false): string {
  const none = chosen.includes(NO_TAG);
  const tags = chosen.some((id) => id !== NO_TAG);
  const what = subtaskTags ? 'Time' : 'Tasks';
  if (!none && !tags) return 'All tasks';
  if (none && !tags) return `${what} with no tag`;
  return none ? `${what} with any selected tag, or with no tag` : `${what} with any selected tag`;
}

/** What the tag filter keeps, after its choice: whole tasks, or with subtask tags the time each piece counts under. */
export const TAG_FILTER_KEEPS = 'whole tasks are kept, so Billable stays available.';
export const TAG_FILTER_KEEPS_BY_SUBTASK = 'a subtask counts under its own tags, and Billable rounds the time that is kept.';

/** Whether any subtask of any task has tags of its own. Until one does, the tag filter keeps whole tasks, as before 1.4. */
export function anySubtaskTags(tasks: Snapshot['tasks']): boolean {
  return tasks.some((t) => (t.subtasks ?? []).some((i) => i.tags != null));
}

/** Whether time on a task and one of its subtasks (`null` for none) is kept by the chosen tags. */
export type TagPass = (taskId: string, subtaskId: string | null) => boolean;

/** The filter for a snapshot's tasks, with the tags as they are in it: the tags each piece counts under are worked out once. */
export function tagPassOf(tasks: Snapshot['tasks'], tags: readonly Tag[], chosen: readonly string[]): TagPass {
  const tagging = taggingOf(tasks, tags);
  const known = new Set(tasks.map((t) => t.id));
  return (taskId, subtaskId) => known.has(taskId) && taskPassesTagFilter(tagging.of(taskId, subtaskId), chosen, tagging.live);
}
