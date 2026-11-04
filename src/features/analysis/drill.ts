// Drill-down: the tasks and segments behind one chart mark, after the active filters.
import { drillSpans, prepare, walkHours, type Params, type SpanRec } from './engine';
import { weekdayIndex } from './range';
import type { Snapshot } from '../../lib/types';

export interface DrillSel {
  title: string;
  /** Local day number, or the first of a run of days with `dayTo`. */
  day?: number;
  dayTo?: number;
  /** Wall-clock hour 0-23. */
  hour?: number;
  band?: number;
  /** 0 = Monday. */
  weekday?: number;
  projectId?: string;
  taskId?: string;
  /** Time on this subtask (an item of the task's list); `null` is the time on no subtask. Used with `taskId`. */
  subtaskId?: string | null;
  /** Only these tasks, such as the ones counted in one row of the Tags level. */
  taskIds?: readonly string[];
  /** Tasks that carry this tag (a task with two tags is behind both marks). `null` means tasks with no tag. */
  tagId?: string | null;
}

export interface DrillSegment {
  taskId: string;
  projectId: string;
  start: number;
  end: number;
  secs: number;
  live: boolean;
}

export interface DrillTask {
  taskId: string;
  projectId: string;
  secs: number;
  segments: number;
}

export interface DrillResult {
  totalSecs: number;
  tasks: DrillTask[];
  segments: DrillSegment[];
}

function matches(sel: DrillSel, day: number, hour: number): boolean {
  if (sel.day !== undefined && (day < sel.day || day > (sel.dayTo ?? sel.day))) return false;
  if (sel.hour !== undefined && sel.hour !== hour) return false;
  if (sel.band !== undefined && Math.floor(hour / 6) !== sel.band) return false;
  if (sel.weekday !== undefined && weekdayIndex(day) !== sel.weekday) return false;
  return true;
}

/** `taskTags` maps a task to its tag ids; it is needed only for a `tagId` selection. */
export function drillInto(spans: readonly SpanRec[], zone: string, sel: DrillSel, taskTags?: ReadonlyMap<string, readonly string[]>): DrillResult {
  const segments: DrillSegment[] = [];
  const byTask = new Map<string, DrillTask>();
  const only = sel.taskIds ? new Set(sel.taskIds) : null;
  let total = 0;
  for (const sp of spans) {
    if (sel.projectId && sp.projectId !== sel.projectId) continue;
    if (sel.taskId && sp.taskId !== sel.taskId) continue;
    if (sel.subtaskId !== undefined && sp.subtaskId !== sel.subtaskId) continue;
    if (only && !only.has(sp.taskId)) continue;
    if (sel.tagId !== undefined && taskTags) {
      const tags = taskTags.get(sp.taskId) ?? [];
      if (sel.tagId === null ? tags.length > 0 : !tags.includes(sel.tagId)) continue;
    }
    let cur: DrillSegment | null = null;
    walkHours(sp.start, sp.end, zone, (s, e, day, hour) => {
      if (!matches(sel, day, hour)) {
        cur = null;
        return;
      }
      if (cur && cur.end === s) {
        cur.end = e;
        cur.secs += e - s;
      } else {
        cur = { taskId: sp.taskId, projectId: sp.projectId, start: s, end: e, secs: e - s, live: sp.live };
        segments.push(cur);
      }
      total += e - s;
    });
  }
  for (const s of segments) {
    const t = byTask.get(s.taskId) ?? { taskId: s.taskId, projectId: s.projectId, secs: 0, segments: 0 };
    t.secs += s.secs;
    t.segments += 1;
    byTask.set(s.taskId, t);
  }
  return {
    totalSecs: total,
    tasks: [...byTask.values()].sort((a, b) => b.secs - a.secs),
    segments: segments.sort((a, b) => b.start - a.start),
  };
}

export function drill(snapshot: Snapshot, params: Params, nowSec: number, sel: DrillSel): DrillResult {
  return drillInto(drillSpans(prepare(snapshot, params), nowSec), params.zone, sel, new Map(snapshot.tasks.map((t) => [t.id, t.tags])));
}

