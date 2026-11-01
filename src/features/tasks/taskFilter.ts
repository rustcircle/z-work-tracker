// One task filter for the task list, the Timeline and Analysis: free text against the name and the
// description's plain text (case and accent insensitive), AND a project, AND tags (any of those chosen).
import { docPlainText, foldText } from '../../lib/docText';
import type { Project, Task } from '../../lib/types';

export interface TaskFilter {
  /** What was typed. Words are matched in order as one phrase, after folding case and accents. */
  text: string;
  /** Empty means every project. */
  projectId: string;
  /** Empty means every task; otherwise tasks that carry at least one of these tags. */
  tagIds: readonly string[];
}

export const NO_TASK_FILTER: TaskFilter = { text: '', projectId: '', tagIds: [] };

export const isTaskFilterActive = (f: TaskFilter): boolean => f.text.trim() !== '' || f.projectId !== '' || f.tagIds.length > 0;

/** The text a task is searched in: name, description and its project's name, folded. Built once per task list. */
const haystacks = new WeakMap<readonly Task[], Map<string, string>>();

function haystackOf(tasks: readonly Task[], projects: ReadonlyMap<string, Project>): Map<string, string> {
  let map = haystacks.get(tasks);
  if (!map) {
    map = new Map(tasks.map((t) => [t.id, foldText(`${t.name} ${docPlainText(t.description)} ${projects.get(t.projectId)?.name ?? ''}`)]));
    haystacks.set(tasks, map);
  }
  return map;
}

/**
 * The ids of the tasks that pass, or null when the filter is off (nothing is hidden). `tasks` should be
 * the snapshot's own array: the folded text is kept against it until the next snapshot.
 */
export function matchingTaskIds(tasks: readonly Task[], projects: ReadonlyMap<string, Project>, f: TaskFilter): Set<string> | null {
  if (!isTaskFilterActive(f)) return null;
  const needle = foldText(f.text.trim()).replace(/\s+/g, ' ');
  const text = needle === '' ? null : haystackOf(tasks, projects);
  const out = new Set<string>();
  for (const t of tasks) {
    if (f.projectId !== '' && t.projectId !== f.projectId) continue;
    if (f.tagIds.length > 0 && !t.tags.some((id) => f.tagIds.includes(id))) continue;
    if (text && !(text.get(t.id) ?? '').includes(needle)) continue;
    out.add(t.id);
  }
  return out;
}
