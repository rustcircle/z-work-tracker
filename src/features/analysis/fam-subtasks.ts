// Time per subtask (an item of a task's list), for the Subtasks level of the Share of time donut.
//
// A subtask's time is the worked time of the stretches logged on it, after the same filters and period as every other
// figure. The time of a task on no item (none was chosen, or the item has since been taken out of the list) is a row
// of its own, `id: null`, so a task's rows always add up to the task. Under Billable the task's rounded time has no
// per-item split, so it is shared among the rows in proportion to their worked time: the rows add up to the task's
// Billable time, and the donut keeps one total at every level.
import type { TaskStat } from './fam-projects';
import type { Ctx } from './mctx';

export interface SubtaskStat {
  taskId: string;
  /** The item's id, or null for the task's time on no item. */
  id: string | null;
  /** The item's text. Empty for the row of time on no item. */
  name: string;
  /** Worked time of the item, from the segments. */
  exact: number;
  /** The task's Billable time, shared out by worked time. */
  billableSecs: number;
  /** For the chosen basis. */
  secs: number;
}

/** What the legend writes for an item that has no text. */
export const UNTITLED_SUBTASK = 'Untitled subtask';

/** One entry per task with time and, for a task that has items, one per item with time. Rows add up to each task's `secs`. */
export function subtasksOf(ctx: Ctx, tasks: readonly TaskStat[]): SubtaskStat[] {
  // Worked seconds on each item. Time on no item is the rest of the task, so spans without an item are not visited again.
  const onItem = new Map<string, Map<string, number>>();
  for (const sp of ctx.cur.spans) {
    if (sp.subtaskId === null) continue;
    const len = sp.end - sp.start;
    if (len <= 0) continue;
    let items = onItem.get(sp.taskId);
    if (!items) onItem.set(sp.taskId, (items = new Map()));
    items.set(sp.subtaskId, (items.get(sp.subtaskId) ?? 0) + len);
  }
  const out: SubtaskStat[] = [];
  for (const t of tasks) {
    if (t.exact <= 0) continue;
    const items = onItem.get(t.id);
    // The names are only looked up for a task that has time on an item, which most tasks never do.
    const texts = items ? new Map((ctx.tasks.get(t.id)?.subtasks ?? []).map((i) => [i.id, i.text])) : null;
    const parts: { id: string | null; name: string; exact: number }[] = [];
    let used = 0;
    for (const [id, exact] of items ?? []) {
      used += exact;
      const text = (texts?.get(id) ?? '').trim();
      parts.push({ id, name: text === '' ? UNTITLED_SUBTASK : text, exact });
    }
    const none = t.exact - used;
    if (none > 0) parts.push({ id: null, name: '', exact: none });
    for (const p of parts) {
      const part = p.exact / t.exact;
      out.push({ taskId: t.id, id: p.id, name: p.name, exact: p.exact, billableSecs: t.billableSecs * part, secs: t.secs * part });
    }
  }
  return out;
}
