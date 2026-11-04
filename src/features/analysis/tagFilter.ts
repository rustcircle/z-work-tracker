// The Analysis tag filter in one place: which tasks a choice of tags keeps. The engine (every filtered figure), the
// count of pending away time and anything else that filters by tag all ask here, so they cannot disagree.
//
// The rule, from the owner: no tag chosen is the same as every tag, nothing is filtered. With tags chosen, only the
// time of tasks that carry ANY of them is kept (OR), as whole tasks. The extra choice "No tag" stands for the tasks
// that carry no tag, and joins the others the same way: "No tag" alone keeps the untagged tasks, "No tag" with a tag
// keeps the untagged tasks and the tasks carrying that tag. A subtask has no tags of its own: its time belongs to its
// task, so it is kept or left out with the task.

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

/** Whether a task with these tags is kept by the chosen tags (which may include `NO_TAG`). */
export function taskPassesTagFilter(taskTags: readonly string[], chosen: readonly string[], live: ReadonlySet<string>): boolean {
  if (chosen.length === 0) return true;
  const mine = liveTagsOf(taskTags, live);
  if (mine.length === 0) return chosen.includes(NO_TAG);
  return mine.some((id) => chosen.includes(id));
}

/** The words for a choice of tags: "Tasks with any selected tag", and so on. Controls writes them under the tag filter. */
export function tagFilterHint(chosen: readonly string[]): string {
  const none = chosen.includes(NO_TAG);
  const tags = chosen.some((id) => id !== NO_TAG);
  if (!none && !tags) return 'All tasks';
  if (none && !tags) return 'Tasks with no tag';
  return none ? 'Tasks with any selected tag, or with no tag' : 'Tasks with any selected tag';
}
