// Pure rules for the task details dialog: which pauses a task has, which of them are marked billable,
// which audit entries belong to the task, and how an audit entry reads in plain words.
import { clock, dayLabel, formatDuration, shortDay } from '../../../components/format';
import { dayOf, parseIso } from '../../../lib/tz';
import type { AuditEntry, BillablePause, BillingSummary, IdleGap, RawSegment, Snapshot, Task } from '../../../lib/types';

export interface Span {
  start: number;
  end: number;
}

/**
 * The task's pauses: the gaps between consecutive effective segments (voided ones don't count), and the
 * gap from the last segment's end to the stop time when the task is stopped. A running segment ends the
 * list: nothing after it is a finished pause.
 */
export function derivePauses(segments: readonly RawSegment[], task: Pick<Task, 'id' | 'state' | 'stoppedAt'>): Span[] {
  const own = segments.filter((s) => s.taskId === task.id && !s.voided).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Span[] = [];
  let reach: number | null = null;
  for (const s of own) {
    const start = parseIso(s.start);
    if (reach !== null && start > reach) out.push({ start: reach, end: start });
    if (s.end === null) return out;
    reach = Math.max(reach ?? 0, parseIso(s.end));
  }
  if (task.state === 'stopped' && task.stoppedAt && reach !== null) {
    const stop = parseIso(task.stoppedAt);
    if (stop > reach) out.push({ start: reach, end: stop });
  }
  return out;
}

export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && a.end > b.start;

export interface PauseRow {
  span: Span;
  /** Billable pauses marked inside this gap (normally one). */
  marked: BillablePause[];
}

export interface PauseRows {
  rows: PauseRow[];
  /** Marked pauses that no longer match any gap, for example after a correction moved the segments. */
  orphans: BillablePause[];
}

export function pauseRows(spans: readonly Span[], pauses: readonly BillablePause[], taskId: string): PauseRows {
  const mine = pauses.filter((p) => p.taskId === taskId && !p.deleted).map((p) => ({ p, span: { start: parseIso(p.start), end: parseIso(p.end) } }));
  const rows = spans.map((span) => ({ span, marked: mine.filter((m) => overlaps(m.span, span)).map((m) => m.p) }));
  const orphans = mine.filter((m) => !spans.some((s) => overlaps(m.span, s))).map((m) => m.p);
  return { rows, orphans };
}

/** Ids of billing summaries' pauses that are live, so a billed pause can say why it can't change. */
export function billedPauseIds(summaries: readonly BillingSummary[]): Set<string> {
  return new Set(summaries.filter((b) => !b.voided).flatMap((b) => b.pauseIds));
}

export function billedSegmentIds(rawSegments: readonly RawSegment[]): Set<string> {
  return new Set(rawSegments.filter((s) => s.billed).map((s) => s.id));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

interface SegState {
  start: string;
  end: string | null;
  voided: boolean;
}

/** The effective state a segment audit record describes: its correction if any, else the recorded times. */
function segState(v: unknown): SegState | null {
  if (!isRecord(v) || typeof v.rawStart !== 'string') return null;
  const edit = v.edit;
  if (isRecord(edit) && typeof edit.start === 'string') return { start: edit.start, end: typeof edit.end === 'string' ? edit.end : null, voided: edit.voided === true };
  return { start: v.rawStart, end: typeof v.rawEnd === 'string' ? v.rawEnd : null, voided: false };
}

function rangeOf(v: unknown): Span | null {
  if (!isRecord(v) || typeof v.start !== 'string' || typeof v.end !== 'string') return null;
  const start = parseIso(v.start);
  const end = parseIso(v.end);
  return Number.isNaN(start) || Number.isNaN(end) ? null : { start, end };
}

/** "9 Mar 09:00 to 11:05", with the second day when the span crosses midnight. */
export function spanText(startSec: number, endSec: number | null, zone: string): string {
  const d1 = dayOf(startSec, zone);
  if (endSec === null) return `${shortDay(d1)} ${clock(startSec, zone)} to now`;
  const d2 = dayOf(endSec, zone);
  return d1 === d2 ? `${shortDay(d1)} ${clock(startSec, zone)} to ${clock(endSec, zone)}` : `${shortDay(d1)} ${clock(startSec, zone)} to ${shortDay(d2)} ${clock(endSec, zone)}`;
}

const stateText = (s: SegState, zone: string): string => (s.voided ? 'not counted' : spanText(parseIso(s.start), s.end === null ? null : parseIso(s.end), zone));

const DECISION_WORDS: Record<string, string> = { pending: 'waiting for your decision', keep: 'kept', drop: 'dropped', thinking: 'thinking time' };
const decisionOf = (v: unknown): string | null => (isRecord(v) && typeof v.decision === 'string' ? (DECISION_WORDS[v.decision] ?? v.decision) : null);

export interface AuditLine {
  id: string;
  /** When it happened, in the active zone. */
  when: string;
  /** What happened, in plain words. */
  what: string;
  /** What it happened to ("Time on 9 Mar 09:00 to 11:35"). */
  about: string;
  /** Before and after, where they say something useful. */
  change: string | null;
  reason: string;
  /** Recorded on another device. */
  elsewhere: boolean;
}

export interface AuditLookup {
  zone: string;
  deviceId: string;
  rawSegments: readonly RawSegment[];
  gaps: readonly IdleGap[];
}

export function describeAudit(e: AuditEntry, look: AuditLookup): AuditLine {
  const { zone } = look;
  const at = parseIso(e.at);
  const when = `${shortDay(dayOf(at, zone))} ${clock(at, zone)}`;
  const base = { id: e.id, when, reason: e.reason, elsewhere: e.by !== look.deviceId };
  const before = segState(e.before);
  const after = segState(e.after);
  const seg = look.rawSegments.find((s) => s.id === e.entityId);
  const gap = look.gaps.find((g) => g.id === e.entityId);
  const segAbout = seg ? `Time on ${spanText(parseIso(seg.rawStart), seg.rawEnd === null ? null : parseIso(seg.rawEnd), zone)}` : 'Recorded time';
  const gapRange = rangeOf(e.after) ?? rangeOf(e.before);
  const gapAbout = gap ? `Time away ${spanText(parseIso(gap.start), parseIso(gap.end), zone)}` : gapRange ? `Time away ${spanText(gapRange.start, gapRange.end, zone)}` : 'Time away';
  const pauseRange = rangeOf(e.after) ?? rangeOf(e.before);
  const pauseAbout = pauseRange ? `Pause ${spanText(pauseRange.start, pauseRange.end, zone)} (${formatDuration(pauseRange.end - pauseRange.start)})` : 'Pause';

  switch (e.action) {
    case 'manualEntry':
      return { ...base, what: 'Time added by hand', about: segAbout, change: after ? `Added ${stateText(after, zone)}` : null };
    case 'correct':
      return { ...base, what: 'Time corrected', about: segAbout, change: before && after ? `${stateText(before, zone)} became ${stateText(after, zone)}` : null };
    case 'void':
      return { ...base, what: 'Time voided', about: segAbout, change: before ? `${stateText(before, zone)} no longer counts` : null };
    case 'restore':
      return { ...base, what: 'Time restored to the recorded times', about: segAbout, change: before && after ? `${stateText(before, zone)} became ${stateText(after, zone)}` : null };
    case 'detected':
      return { ...base, what: 'Time away detected', about: gapAbout, change: null };
    case 'decide': {
      const from = decisionOf(e.before);
      const to = decisionOf(e.after);
      return { ...base, what: 'Time away decision', about: gapAbout, change: from && to ? `${from} became ${to}` : to };
    }
    case 'markBillable':
      return { ...base, what: 'Pause billed', about: pauseAbout, change: null };
    case 'unmarkBillable':
      return { ...base, what: 'Pause no longer billed', about: pauseAbout, change: null };
    default:
      return { ...base, what: e.action, about: seg ? segAbout : gap ? gapAbout : e.entity, change: null };
  }
}

/** The task a pause's audit record names. Records made before the id was kept do not name one. */
function namedTask(e: AuditEntry): string | null {
  for (const v of [e.after, e.before]) if (isRecord(v) && typeof v.taskId === 'string') return v.taskId;
  return null;
}

/** The audit entries of one task: its segments, its time away, and its billable pauses. */
export function taskAudit(entries: readonly AuditEntry[], snapshot: Pick<Snapshot, 'rawSegments' | 'gaps' | 'pauses'>, taskId: string, gapSpans: readonly Span[]): AuditEntry[] {
  const own = new Set<string>();
  for (const s of snapshot.rawSegments) if (s.taskId === taskId) own.add(s.id);
  for (const g of snapshot.gaps) if (g.taskId === taskId) own.add(g.id);
  const otherPauses = new Set<string>();
  for (const p of snapshot.pauses) {
    if (p.taskId === taskId) own.add(p.id);
    else otherPauses.add(p.id);
  }
  return entries.filter((e) => {
    if (own.has(e.entityId)) return true;
    // An unmarked pause is gone from the snapshot, and so is the pause of a task that was deleted, so they are matched
    // by the time range they covered. A record that names another task is that task's, whatever its time lines up with.
    if (e.entity !== 'pause' || otherPauses.has(e.entityId)) return false;
    const named = namedTask(e);
    if (named !== null && named !== taskId) return false;
    const r = rangeOf(e.after) ?? rangeOf(e.before);
    return r !== null && gapSpans.some((s) => overlaps(r, s));
  });
}

/** `Thu 12 Mar 2026` for the start day of a span, and the other day when it ends on another. */
export function dayText(span: Span, zone: string): string {
  const d1 = dayOf(span.start, zone);
  const d2 = dayOf(span.end, zone);
  return d1 === d2 ? dayLabel(d1) : `${dayLabel(d1)} to ${dayLabel(d2)}`;
}

export function timesText(span: Span, zone: string): string {
  const d1 = dayOf(span.start, zone);
  const d2 = dayOf(span.end, zone);
  return d1 === d2 ? `${clock(span.start, zone)} to ${clock(span.end, zone)}` : `${clock(span.start, zone)} to ${shortDay(d2)} ${clock(span.end, zone)}`;
}
