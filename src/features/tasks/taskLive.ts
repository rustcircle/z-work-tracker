// Live figures for the running task, recomputed each second from the task's own segments only.
import { exactNumeratorsOf, numeratorsOf, taskDays, type Numerators, type RateBook, type Rule } from '../../lib/billing';
import type { Seg } from '../../lib/split';
import { dayOf } from '../../lib/tz';
import type { RoundingVersion } from '../../lib/types';

export interface LiveFigures {
  /** Seconds since the open segment started. */
  sessionSecs: number;
  /** Today's exact seconds for the task in the zone, including the open segment. */
  exactSecs: number;
  /** The same, rounded once for the day. */
  billableSecs: number;
  exactNumerators: Numerators;
  billableNumerators: Numerators;
  rule: Rule | null;
  /** Rate in force right now; null cents means no rate set. */
  rate: { rateCents: number | null; currency: string | null };
}

/** `segs` are all of one task's segments with `end` already clamped to now for the open one. */
export function liveFigures(segs: readonly Seg[], nowSec: number, zone: string, book: RateBook, rounding: readonly RoundingVersion[]): LiveFigures {
  const open = segs.find((s) => s.live);
  const projectId = segs[0]?.projectId ?? '';
  const today = dayOf(nowSec, zone);
  const rows = taskDays(segs, zone, book, rounding).filter((r) => r.day === today);
  return {
    sessionSecs: open ? Math.max(0, nowSec - open.start) : 0,
    exactSecs: rows.reduce((n, r) => n + r.exactSecs, 0),
    billableSecs: rows.reduce((n, r) => n + r.billableSecs, 0),
    exactNumerators: exactNumeratorsOf(rows),
    billableNumerators: numeratorsOf(rows),
    rule: rows[0]?.rule ?? null,
    rate: book.at(projectId, nowSec),
  };
}
