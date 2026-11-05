// The tags a piece of time counts under in Analysis, and a task's time split by them. Since 1.4 a subtask can carry some
// of its task's tags (`effectiveTagsOf`, lib/subtasks.ts), so what a task's time counts under is no longer one set: time on
// a subtask with tags of its own counts under those. A task none of whose subtasks differs from the task is one set and
// every figure is worked out as before.
//
// `tagPartsOf` is the TypeScript side of `tag_parts` in analytics.rs: the Excel Analytics Tags sheet and this screen give
// the same figures, which analyticsParity.test.ts pins.
import type { TaskDay } from '../../lib/billing';
import { effectiveTagsOf, type TaskTagSets } from '../../lib/subtasks';
import { addDays, dayOf, startOfDay } from '../../lib/tz';
import type { Tag, Task } from '../../lib/types';
import type { SpanRec } from './engine';

const sets = new WeakMap<Task, TaskTagSets>();

/** A task's tag sets, worked out once per task of a snapshot (which is never changed, only replaced). */
export function tagSetsOf(task: Task): TaskTagSets {
  let hit = sets.get(task);
  if (!hit) sets.set(task, (hit = effectiveTagsOf(task)));
  return hit;
}

/**
 * What a piece of time is counted under: its task and, when it was logged on an item still in the task's list, that item.
 * `live` are the ids of the tags that exist, which every reader counts under (a deleted tag counts nowhere).
 */
export interface Tagging {
  /** The tags the time counts under, in the task's order, deleted ones included. Empty for a task that is not known. */
  of(taskId: string, subtaskId: string | null): readonly string[];
  readonly live: ReadonlySet<string>;
}

export function taggingOf(tasks: Iterable<Task>, tags: Iterable<Tag>): Tagging {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const live = new Set<string>();
  for (const t of tags) if (!t.deleted) live.add(t.id);
  return {
    of: (taskId, subtaskId) => {
      const task = byId.get(taskId);
      return task ? tagSetsOf(task).of(subtaskId) : [];
    },
    live,
  };
}

/** A task's time under one set of tags. */
export interface TagPart {
  /** The tags it counts under, in the task's order, deleted ones included. */
  tags: readonly string[];
  exact: number;
  billable: number;
}

/** What `tagPartsOf` reads of the dataset it splits: the task's spans and the task-day rows of the period. */
export interface TagPartsInput {
  sets: TaskTagSets;
  /** The task's pieces that make its rows, each apart: worked, thinking and billable pause, closed and running, after the filters and cut to the period. */
  pieces: readonly SpanRec[];
  rows: readonly TaskDay[];
  zone: string;
  /** The task's figures, which the parts add up to. */
  exact: number;
  billable: number;
  /** False under a band or shift filter: Billable is not worked out, and equals Exact. */
  billableAvailable: boolean;
}

const key = (tags: readonly string[]): string => tags.join('\u0000');

/**
 * A task's time split by the tags each piece counts under. One part with the task's tags when no subtask counts differently.
 *
 * Exact time is that of the worked pieces. Billable time is that of each task-day row's pieces, the row's rounding going onto
 * the latest piece first (by start, end and the piece's id, as the core orders them), and onto the one before when that would
 * take a piece below nothing, as `allocate` does onto rate buckets in lib/billing.ts. The parts add up to the task's figures.
 * A piece cut by midnight is two pieces, one per row.
 */
export function tagPartsOf(input: TagPartsInput): TagPart[] {
  const { sets: tagSets, pieces, rows, zone } = input;
  const whole: TagPart[] = [{ tags: tagSets.of(null), exact: input.exact, billable: input.billable }];
  if (tagSets.uniform) return whole;
  const parts = new Map<string, TagPart>();
  const part = (tags: readonly string[]): TagPart => {
    const k = key(tags);
    let p = parts.get(k);
    if (!p) parts.set(k, (p = { tags, exact: 0, billable: 0 }));
    return p;
  };
  const midnights = new Map<string, number>();
  const nextMidnight = (day: string): number => {
    let v = midnights.get(day);
    if (v === undefined) midnights.set(day, (v = startOfDay(addDays(day, 1), zone)));
    return v;
  };
  const byDay = new Map<string, { start: number; end: number; id: string; tags: readonly string[] }[]>();
  for (const sp of pieces) {
    const tags = tagSets.of(sp.subtaskId);
    if (sp.kind !== 'billablePause') part(tags).exact += sp.end - sp.start;
    for (let cur = sp.start; cur < sp.end; ) {
      const day = dayOf(cur, zone);
      const stop = Math.min(nextMidnight(day), sp.end);
      const list = byDay.get(day);
      const cut = { start: cur, end: stop, id: sp.id ?? '', tags };
      if (list) list.push(cut);
      else byDay.set(day, [cut]);
      cur = stop;
    }
  }
  if (input.billableAvailable) {
    for (const row of rows) {
      const list = byDay.get(row.day);
      if (!list) continue;
      // The core's order: by start, end and then the piece's id, so the rounding lands on the same piece.
      list.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const secs = list.map((x) => x.end - x.start);
      let diff = row.billableSecs - secs.reduce((n, s) => n + s, 0);
      for (let i = secs.length - 1; i >= 0 && diff !== 0; i -= 1) {
        const applied = Math.max(diff, -(secs[i] as number));
        secs[i] = (secs[i] as number) + applied;
        diff -= applied;
      }
      list.forEach((x, i) => (part(x.tags).billable += secs[i] as number));
    }
  } else {
    for (const p of parts.values()) p.billable = p.exact;
  }
  const reached = [...parts.values()].filter((p) => p.exact > 0 || p.billable > 0);
  return reached.length > 0 ? reached : whole;
}
