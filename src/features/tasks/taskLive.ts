// Live figures for the running task, recomputed each second from the task's own pieces only.
//
// Only work and thinking count as worked time. A billable pause is billable and earns money, but it is
// never in Exact (`taskDays` keeps it out). Time away that is pending or dropped is in no piece at all.
import { exactNumeratorsOf, numeratorsOf, taskDays, type Numerators, type RateBook, type Rule, type SpanLike } from '../../lib/billing';
import { effectiveEnd } from '../../lib/split';
import { dayOf, parseIso } from '../../lib/tz';
import type { RoundingVersion, Segment } from '../../lib/types';

/** One piece of one task with numeric instants. `end` is already clamped to now for the open one. */
export type LiveSpan = SpanLike & { live: boolean };

export interface LiveFigures {
  /** Seconds since the open piece started: the current stretch of work, which a subtask switch restarts. */
  sessionSecs: number;
  /** Today's exact seconds for the task in the zone, including the open piece. Never includes a pause. */
  exactSecs: number;
  /** The same, with billable pauses, rounded once for the day. */
  billableSecs: number;
  /** Today's billable pauses and thinking time, both already inside `billableSecs` / `exactSecs`. */
  pauseSecs: number;
  thinkingSecs: number;
  exactNumerators: Numerators;
  billableNumerators: Numerators;
  rule: Rule | null;
  /** Rate in force right now; null cents means no rate set. */
  rate: { rateCents: number | null; currency: string | null };
}

/** The task's pieces as spans for `taskDays`, the open one measured up to `nowSec`. */
export function liveSpans(pieces: readonly Segment[], projectId: string, nowSec: number): LiveSpan[] {
  return pieces.map((p) => {
    const start = parseIso(p.start);
    const live = p.end === null && p.provisionalEnd === null;
    return { taskId: p.taskId, projectId, start, end: Math.max(effectiveEnd(p, nowSec), start), live, kind: p.kind ?? 'work' };
  });
}

/** `spans` are all of one task's pieces with `end` already clamped to now for the open one. */
export function liveFigures(spans: readonly LiveSpan[], nowSec: number, zone: string, book: RateBook, rounding: readonly RoundingVersion[]): LiveFigures {
  const open = spans.find((s) => s.live && s.kind !== 'billablePause');
  const projectId = spans[0]?.projectId ?? '';
  const today = dayOf(nowSec, zone);
  const rows = taskDays(spans, zone, book, rounding).filter((r) => r.day === today);
  return {
    sessionSecs: open ? Math.max(0, nowSec - open.start) : 0,
    exactSecs: rows.reduce((n, r) => n + r.exactSecs, 0),
    billableSecs: rows.reduce((n, r) => n + r.billableSecs, 0),
    pauseSecs: rows.reduce((n, r) => n + r.pauseSecs, 0),
    thinkingSecs: rows.reduce((n, r) => n + r.thinkingSecs, 0),
    exactNumerators: exactNumeratorsOf(rows),
    billableNumerators: numeratorsOf(rows),
    rule: rows[0]?.rule ?? null,
    rate: book.at(projectId, nowSec),
  };
}
