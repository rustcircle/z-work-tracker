// What a task card shows about time, from the task's read model and its pieces. Pure, so it is easy to test.
//
// Worked time is work plus thinking. A billable pause is billable but was not worked, so it never counts
// here. Pending time away is in no piece at all: it is shown apart as unconfirmed and counted nowhere.
import { effectiveEnd } from '../../lib/split';
import { parseIso } from '../../lib/tz';
import type { Segment, Task } from '../../lib/types';

export interface SubtaskRow {
  id: string;
  text: string;
  checked: boolean;
  secs: number;
  active: boolean;
  /** Only saved items (those with an id) can carry time. */
  canActivate: boolean;
}

export interface TaskTime {
  /** Work and thinking, the sum of `subtasks[].secs` and `noSubtaskSecs`. */
  workedSecs: number;
  /** Time on pieces that belong to no item of the task list now (none chosen, or the item was removed). */
  noSubtaskSecs: number;
  subtasks: SubtaskRow[];
  /** True when the "No subtask" choice is the active one. */
  noneActive: boolean;
  /** Billed and unbilled both include billable pauses and thinking, before rounding. */
  billedSecs: number;
  unbilledSecs: number;
  pauseSecs: number;
  thinkingSecs: number;
  unconfirmedSecs: number;
  /** Time on pieces whose item is gone from the description, already part of `noSubtaskSecs`. */
  orphanSecs: number;
}

const isOpenHere = (s: Segment): boolean => s.end === null && s.provisionalEnd === null;

const byTask = new WeakMap<readonly Segment[], Map<string, Segment[]>>();
const NO_PIECES: readonly Segment[] = [];

/**
 * One task's pieces, in snapshot order. Grouped once per snapshot: each card filtering every segment for
 * itself costs cards times segments on every action.
 */
export function piecesOf(segments: readonly Segment[], taskId: string): readonly Segment[] {
  let groups = byTask.get(segments);
  if (!groups) {
    groups = new Map();
    for (const s of segments) {
      const list = groups.get(s.taskId);
      if (list) list.push(s);
      else groups.set(s.taskId, [s]);
    }
    byTask.set(segments, groups);
  }
  return groups.get(taskId) ?? NO_PIECES;
}

/** True while a piece is growing here, so the task's time depends on the clock. */
export const hasOpenPiece = (pieces: readonly Segment[]): boolean => pieces.some(isOpenHere);

/**
 * `pieces` are the task's own pieces from the snapshot. The snapshot's totals are as of `snapshotSec`;
 * a piece that is open on this device has grown by `nowSec - snapshotSec` since, so that growth is added
 * to the open piece's item and to the unbilled total, and the open piece itself is measured up to now.
 */
export function taskTime(task: Task, pieces: readonly Segment[], nowSec: number, snapshotSec: number): TaskTime {
  const growth = Math.max(0, nowSec - snapshotSec);
  const open = pieces.find((p) => isOpenHere(p) && (p.kind ?? 'work') !== 'billablePause');
  const ids = new Set(task.subtasks.map((i) => i.id).filter((i) => i !== ''));

  let none = 0;
  let orphan = 0;
  for (const p of pieces) {
    if ((p.kind ?? 'work') === 'billablePause') continue;
    if (p.subtaskId && ids.has(p.subtaskId)) continue;
    const secs = Math.max(0, effectiveEnd(p, nowSec) - parseIso(p.start));
    none += secs;
    if (p.subtaskId) orphan += secs;
  }

  const activeId = task.activeSubtask && ids.has(task.activeSubtask) ? task.activeSubtask : null;
  const subtasks = task.subtasks.map((i): SubtaskRow => ({
    id: i.id,
    text: i.text,
    checked: i.checked,
    secs: i.secs + (open && i.id !== '' && open.subtaskId === i.id ? growth : 0),
    active: activeId !== null && i.id === activeId,
    canActivate: i.id !== '',
  }));
  const withItems = subtasks.reduce((n, r) => n + r.secs, 0);

  return {
    workedSecs: none + withItems,
    noSubtaskSecs: none,
    subtasks,
    noneActive: activeId === null,
    billedSecs: task.billedSecs,
    unbilledSecs: task.unbilledSecs + (open ? growth : 0),
    pauseSecs: task.pauseSecs,
    thinkingSecs: task.thinkingSecs,
    unconfirmedSecs: task.unconfirmedSecs,
    orphanSecs: orphan,
  };
}
