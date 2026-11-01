// When does Analysis next need the time? Its figures count a running segment up to "now", and billable time moves
// in steps, so the screen looks at the clock again when a step of a running task's day falls due, when a minute of
// the running stretch completes (so "5m" is never a stale "4m"), at midnight, or when the data changes. It never
// reads the clock by the second, and it reads it at the exact moment (not the start of the minute), so a segment
// that has just started is not zero-length and the first step of rounding Up shows at once.
import { nextWake, type LiveRow } from '../../app/stepClock';
import { ruleFor } from '../../lib/billing';
import { dayBounds, dayOf, parseIso } from '../../lib/tz';
import type { Snapshot } from '../../lib/types';

/** Seconds until the next moment Analysis should read the clock again. With nothing running only midnight changes what it says. */
export function analysisWake(snapshot: Pick<Snapshot, 'segments' | 'tasks' | 'rounding'>, zone: string, at: number): number {
  const live = snapshot.segments.filter((s) => s.end === null && s.provisionalEnd === null);
  const day = dayOf(at, zone);
  const bounds = dayBounds(day, zone);
  if (live.length === 0) return Math.max(1, bounds.end - at);
  const projectOf = new Map(snapshot.tasks.map((t) => [t.id, t.projectId] as const));
  const liveTasks = new Set(live.map((s) => s.taskId));
  // What each running task has counted on today's date, closed and running pieces alike. Only today's row is growing:
  // a segment that began yesterday has stopped adding to yesterday's.
  const counted = new Map<string, number>();
  for (const s of snapshot.segments) {
    if (!liveTasks.has(s.taskId)) continue;
    const from = Math.max(parseIso(s.start), bounds.start);
    const to = Math.min(s.end === null ? at : parseIso(s.end), bounds.end);
    if (to > from) counted.set(s.taskId, (counted.get(s.taskId) ?? 0) + (to - from));
  }
  const rows: LiveRow[] = [...counted].map(([taskId, secs]) => ({ counted: secs, rule: ruleFor(snapshot.rounding, projectOf.get(taskId) ?? '', day) }));
  const anchor = Math.min(...live.map((s) => parseIso(s.start)));
  return nextWake(rows, at, anchor, bounds.end - at);
}
