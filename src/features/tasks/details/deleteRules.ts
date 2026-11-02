// Rules for deleting a task from its Details, kept free of React so each is easy to test: what stops the delete right
// now, what it takes with it, and the words that say so. The snapshot only shows what the page last heard of. The
// backend checks the same rules again in the same step as the delete, and has the last word.
import { listOf } from '../../../components/format';
import { RateBook, numeratorsOf, taskDays, type Numerators, type SpanLike } from '../../../lib/billing';
import { effectiveEnd } from '../../../lib/split';
import { parseIso } from '../../../lib/tz';
import type { Snapshot, Task } from '../../../lib/types';

/**
 * Why a task can't be deleted yet, in the order the backend checks them. Only a timer running on this computer stops it:
 * one running on another of the person's computers doesn't (see `runningElsewhere`).
 */
export type DeleteBlock =
  | { kind: 'running' }
  /** The references of the live billing summaries that list the task's time. */
  | { kind: 'summary'; references: string[] };

/**
 * The references of the live summaries that list any of this task's time, in order. A summary lists time by task, by
 * recorded segment and by billable pause, and a voided one lists nothing: its time is unbilled again.
 */
export function summariesListing(snapshot: Pick<Snapshot, 'rawSegments' | 'pauses' | 'billing'>, taskId: string): string[] {
  const segments = new Set(snapshot.rawSegments.filter((s) => s.taskId === taskId).map((s) => s.id));
  const pauses = new Set(snapshot.pauses.filter((p) => p.taskId === taskId).map((p) => p.id));
  const listing = snapshot.billing.summaries.filter((b) => !b.voided && (b.rows.some((r) => r.taskId === taskId) || b.segmentIds.some((id) => segments.has(id)) || b.pauseIds.some((id) => pauses.has(id))));
  return [...new Set(listing.map((b) => b.reference))].sort();
}

/**
 * The other computer a task is running on, as the snapshot shows it, or null when it is not running on one. `device` is
 * that computer's name, when the snapshot has it. This doesn't stop a delete: the timer there stops when that computer
 * next syncs, and the time it has logged goes with the task.
 */
export function runningElsewhere(snapshot: Pick<Snapshot, 'deviceId' | 'rawSegments'>, task: Pick<Task, 'id' | 'runningElsewhere'>): { device: string | null } | null {
  const elsewhere = task.runningElsewhere !== null || snapshot.rawSegments.some((s) => s.taskId === task.id && s.rawEnd === null && s.deviceId !== snapshot.deviceId);
  return elsewhere ? { device: task.runningElsewhere } : null;
}

/** What stops the task being deleted now, as the snapshot shows it. Empty when nothing the page can see does. */
export function deleteBlocks(snapshot: Pick<Snapshot, 'deviceId' | 'rawSegments' | 'pauses' | 'billing'>, task: Pick<Task, 'id' | 'state' | 'runningElsewhere'>): DeleteBlock[] {
  const blocks: DeleteBlock[] = [];
  // A timer open on this computer, or a task the snapshot calls running with no open segment to say where.
  const openHere = snapshot.rawSegments.some((s) => s.taskId === task.id && s.rawEnd === null && s.deviceId === snapshot.deviceId);
  if (openHere || (task.state === 'running' && runningElsewhere(snapshot, task) === null)) blocks.push({ kind: 'running' });
  const references = summariesListing(snapshot, task.id);
  if (references.length > 0) blocks.push({ kind: 'summary', references });
  return blocks;
}

/** What a block says to the person, with how to get past it. */
export function blockText(block: DeleteBlock): string {
  switch (block.kind) {
    case 'running':
      return 'This task is running. Pause or stop it first, then delete it.';
    case 'summary':
      return block.references.length === 1
        ? `This task's time is on billing summary ${block.references[0]}. Void that summary first, then delete the task.`
        : `This task's time is on billing summaries ${listOf(block.references)}. Void those summaries first, then delete the task.`;
  }
}

/**
 * What the review says about a task that is running on another of the person's computers: where, that its time so far is
 * deleted too, and that the timer there stops when that computer next syncs. `device` is its name, when it is known.
 */
export function elsewhereText(device: string | null): string {
  const where = device ?? 'your other PC';
  return `It is running on ${where} right now. The time it has logged there so far is deleted too, and ${device === null ? 'that PC' : where}'s timer stops the next time it syncs.`;
}

/** What goes with a task, worked out the way the Timeline works it out, so the figures agree with what the person sees there. */
export interface Footprint {
  /** Time on live summaries and not, before rounding. A billable pause and thinking time are in it. */
  loggedSecs: number;
  /** Time away that is still waiting for an answer. It counts nowhere, and goes too. */
  unconfirmedSecs: number;
  /** Days with counted time in the zone shown: the task's entries on the Timeline. */
  days: number;
  /** The Billable earnings of those days, rounded as the Timeline rounds them. Empty when the task earns nothing. */
  billable: Numerators;
  /** Tasks that continue this one. They stay, without the link. */
  continuedBy: Task[];
}

export function footprint(snapshot: Pick<Snapshot, 'segments' | 'tasks' | 'projects' | 'rates' | 'rounding' | 'now'>, task: Task, zone: string): Footprint {
  const now = parseIso(snapshot.now);
  const spans: SpanLike[] = snapshot.segments
    .filter((s) => s.taskId === task.id)
    .map((s) => ({ taskId: s.taskId, projectId: task.projectId, start: parseIso(s.start), end: effectiveEnd(s, now), kind: s.kind ?? 'work' }));
  const rows = taskDays(spans, zone, new RateBook(snapshot.projects, snapshot.rates), snapshot.rounding);
  return {
    loggedSecs: task.billedSecs + task.unbilledSecs,
    unconfirmedSecs: task.unconfirmedSecs,
    days: rows.filter((r) => r.exactSecs + r.pauseSecs > 0).length,
    billable: numeratorsOf(rows),
    continuedBy: snapshot.tasks.filter((t) => t.continuedFrom === task.id),
  };
}
