// Timeline data model. Closed segments are split and rated once per snapshot and zone; the running
// segment is re-split every second, and only the days it touches are rebuilt (see `dayData`).
import { exactNumeratorsOf, numeratorsOf, taskDays, type Numerators, type RateBook, type SpanLike, type TaskDay } from '../../lib/billing';
import { effectiveEnd, splitAll, type BandIndex, type Piece, type Seg } from '../../lib/split';
import { addDays, dayOf, hhmmToMinutes, instantOfWall, parseIso, weekdayOf } from '../../lib/tz';
import type { GapKind, PieceKind, RawSegment, RoundingVersion, Snapshot } from '../../lib/types';
import { assignLanes } from './axisGeometry';

/**
 * What a stretch of the timeline is. The first three are counted time (the backend's pieces); `pending`
 * and `dropped` are time away that counts nowhere, drawn from `snapshot.gaps`.
 */
export type SegKind = PieceKind | 'pending' | 'dropped';

/** A `Seg` that knows its kind. Plain `Seg`s (old fixtures, tests) are work. */
export interface TlSeg extends Seg {
  kind: SegKind;
  /** The recorded segment this came from, to find its correction. */
  segmentId: string;
  /** Sleep or idle, for time away. */
  gapKind?: GapKind;
}

const isTl = (s: Seg): s is TlSeg => 'kind' in s;
export const kindOf = (s: Seg): SegKind => (isTl(s) ? s.kind : 'work');
export const segmentIdOf = (s: Seg): string => (isTl(s) ? s.segmentId : s.id);
export const gapKindOf = (s: Seg): GapKind | undefined => (isTl(s) ? s.gapKind : undefined);
/** True for time that counts nowhere. */
export const isAway = (k: SegKind): k is 'pending' | 'dropped' => k === 'pending' || k === 'dropped';

/**
 * The timeline's segments: the backend's pieces with their kind, plus time away that is pending or
 * dropped (it is in no piece). `toSegs` in lib/split.ts does the same for the pieces alone.
 */
export function timelineSegs(snapshot: Pick<Snapshot, 'segments' | 'tasks' | 'gaps'>): TlSeg[] {
  const projectOf = new Map(snapshot.tasks.map((t) => [t.id, t.projectId] as const));
  const out: TlSeg[] = [];
  for (const s of snapshot.segments) {
    const projectId = projectOf.get(s.taskId);
    if (projectId === undefined) continue;
    out.push({
      id: s.id,
      taskId: s.taskId,
      projectId,
      deviceId: s.deviceId,
      start: parseIso(s.start),
      end: effectiveEnd(s, 0),
      live: s.end === null && s.provisionalEnd === null,
      remoteOpen: s.end === null && s.provisionalEnd !== null,
      kind: s.kind ?? 'work',
      segmentId: s.segmentId ?? s.id,
    });
  }
  for (const g of snapshot.gaps) {
    const projectId = projectOf.get(g.taskId);
    if (projectId === undefined || (g.decision !== 'pending' && g.decision !== 'drop')) continue;
    const start = parseIso(g.start);
    out.push({
      id: `gap:${g.id}`,
      taskId: g.taskId,
      projectId,
      deviceId: g.deviceId,
      start,
      end: Math.max(parseIso(g.end), start),
      live: false,
      remoteOpen: false,
      kind: g.decision === 'pending' ? 'pending' : 'dropped',
      segmentId: g.segmentId,
      gapKind: g.kind,
    });
  }
  return out;
}

/** Counted time only: what rounding, billable and earnings are computed from. */
function spansOf(segs: readonly Seg[]): SpanLike[] {
  const out: SpanLike[] = [];
  for (const s of segs) {
    const kind = kindOf(s);
    if (!isAway(kind)) out.push({ taskId: s.taskId, projectId: s.projectId, start: s.start, end: s.end, kind });
  }
  return out;
}

/** Corrections and hand-entered time by recorded segment id; voided segments are listed apart. */
export interface RawIndex {
  marks: ReadonlyMap<string, RawSegment>;
  /** Voided segments by the day (in `zone`) they were recorded on. */
  voided: ReadonlyMap<string, readonly RawSegment[]>;
}

export function rawIndex(raws: readonly RawSegment[], zone: string): RawIndex {
  const marks = new Map<string, RawSegment>();
  const voided = new Map<string, RawSegment[]>();
  for (const r of raws) {
    if (r.voided) {
      const day = dayOf(parseIso(r.rawStart), zone);
      const list = voided.get(day);
      if (list) list.push(r);
      else voided.set(day, [r]);
    } else if (r.corrected || r.manual) marks.set(r.id, r);
  }
  return { marks, voided };
}

export interface DayData {
  day: string;
  pieces: readonly Piece[];
  rows: readonly TaskDay[];
}

export interface ClosedModel {
  zone: string;
  pieces: Map<string, Piece[]>;
  rows: Map<string, TaskDay[]>;
  /** Days with logged time, newest first. */
  days: string[];
  cache: Map<string, DayData>;
  /** Segments open on this device (end == start here; the overlay stretches them to now). */
  liveSegs: Seg[];
  liveTaskIds: ReadonlySet<string>;
  /** Counted time of the tasks that are running, needed to re-round their rows. */
  liveTaskSpans: SpanLike[];
}

function group<T extends { day: string }>(items: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.day);
    if (list) list.push(it);
    else m.set(it.day, [it]);
  }
  return m;
}

const hasLength = (p: Piece): boolean => p.end > p.start;

export function buildClosed(base: readonly Seg[], zone: string, book: RateBook, rounding: readonly RoundingVersion[]): ClosedModel {
  const liveSegs = base.filter((s) => s.live);
  const liveTaskIds = new Set(liveSegs.map((s) => s.taskId));
  const closedSegs = base.filter((s) => !s.live);
  const pieces = group(splitAll(closedSegs, zone).filter(hasLength));
  const rows = group(taskDays(spansOf(closedSegs), zone, book, rounding));
  const days = [...pieces.keys()].sort().reverse();
  return { zone, pieces, rows, days, cache: new Map(), liveSegs, liveTaskIds, liveTaskSpans: spansOf(closedSegs.filter((s) => liveTaskIds.has(s.taskId))) };
}

export interface LiveOverlay {
  pieces: Map<string, Piece[]>;
  rows: Map<string, TaskDay[]>;
}

const NO_OVERLAY: LiveOverlay = { pieces: new Map(), rows: new Map() };

/** Re-splits only the running segments, and re-rounds only the running tasks on the days they touch. */
export function buildOverlay(closed: ClosedModel, nowSec: number, book: RateBook, rounding: readonly RoundingVersion[]): LiveOverlay {
  if (closed.liveSegs.length === 0) return NO_OVERLAY;
  const live = closed.liveSegs.map((s) => ({ ...s, end: Math.max(nowSec, s.start) }));
  const pieces = group(splitAll(live, closed.zone).filter(hasLength));
  if (pieces.size === 0) return NO_OVERLAY;
  const rows = group(taskDays([...closed.liveTaskSpans, ...spansOf(live)], closed.zone, book, rounding).filter((r) => pieces.has(r.day)));
  return { pieces, rows };
}

const EMPTY: readonly never[] = [];

/** The data for one day. Days the overlay does not touch return one cached object per snapshot. */
export function dayData(closed: ClosedModel, overlay: LiveOverlay, day: string): DayData {
  const live = overlay.pieces.get(day);
  if (!live) {
    let d = closed.cache.get(day);
    if (!d) {
      d = { day, pieces: closed.pieces.get(day) ?? EMPTY, rows: closed.rows.get(day) ?? EMPTY };
      closed.cache.set(day, d);
    }
    return d;
  }
  return {
    day,
    pieces: [...(closed.pieces.get(day) ?? EMPTY), ...live],
    rows: [...(closed.rows.get(day) ?? EMPTY).filter((r) => !closed.liveTaskIds.has(r.taskId)), ...(overlay.rows.get(day) ?? EMPTY)],
  };
}

/** All days to list, newest first: logged days plus today when something is running. */
export function allDays(closed: ClosedModel, overlay: LiveOverlay): string[] {
  const extra = [...overlay.pieces.keys()].filter((d) => !closed.pieces.has(d));
  return extra.length === 0 ? closed.days : [...new Set([...extra, ...closed.days])].sort().reverse();
}

export interface Totals {
  exactSecs: number;
  billableSecs: number;
  /** Billable pauses: in billable, never in exact. */
  pauseSecs: number;
  /** Away time marked as thinking: in both, reported on its own. */
  thinkingSecs: number;
  billable: Numerators;
  exact: Numerators;
  /** Some row used an increment, so billable can differ from exact. */
  rounded: boolean;
}

/** Billable can differ from exact: rounding is on or the period holds a billable pause. */
export const differs = (t: Pick<Totals, 'rounded' | 'pauseSecs'>): boolean => t.rounded || t.pauseSecs > 0;

export function totalsOf(rows: readonly TaskDay[]): Totals {
  let exactSecs = 0;
  let billableSecs = 0;
  let pauseSecs = 0;
  let thinkingSecs = 0;
  let rounded = false;
  for (const r of rows) {
    exactSecs += r.exactSecs;
    billableSecs += r.billableSecs;
    pauseSecs += r.pauseSecs;
    thinkingSecs += r.thinkingSecs;
    if (r.rule.incrementMinutes > 0) rounded = true;
  }
  return { exactSecs, billableSecs, pauseSecs, thinkingSecs, billable: numeratorsOf(rows), exact: exactNumeratorsOf(rows), rounded };
}

export interface ProjectTotal {
  projectId: string;
  exactSecs: number;
  billableSecs: number;
  pauseSecs: number;
  billable: Numerators;
  /** At least some of the time had a rate in force. */
  hasRate: boolean;
}

export function projectTotals(rows: readonly TaskDay[]): ProjectTotal[] {
  const by = new Map<string, TaskDay[]>();
  for (const r of rows) {
    const list = by.get(r.projectId);
    if (list) list.push(r);
    else by.set(r.projectId, [r]);
  }
  return [...by.entries()]
    .map(([projectId, list]) => ({
      projectId,
      exactSecs: list.reduce((n, r) => n + r.exactSecs, 0),
      billableSecs: list.reduce((n, r) => n + r.billableSecs, 0),
      pauseSecs: list.reduce((n, r) => n + r.pauseSecs, 0),
      billable: numeratorsOf(list),
      hasRate: list.some((r) => r.buckets.some((b) => b.rateCents !== null)),
    }))
    .sort((a, b) => b.billableSecs - a.billableSecs || b.exactSecs - a.exactSecs || (a.projectId < b.projectId ? -1 : 1));
}

/** Exact numerators for `[start, end)` of a project, split at rate changes. */
export function pieceNumerators(book: RateBook, projectId: string, start: number, end: number): Numerators {
  const out: Numerators = {};
  if (end <= start) return out;
  for (const p of book.split(projectId, start, end)) {
    if (p.rateCents !== null && p.currency) out[p.currency] = (out[p.currency] ?? 0) + p.rateCents * (p.end - p.start);
  }
  return out;
}

export interface Entry {
  key: string;
  segId: string;
  /** The recorded segment (or pause record) this came from. */
  segmentId: string;
  kind: SegKind;
  gapKind: GapKind | undefined;
  taskId: string;
  projectId: string;
  band: BandIndex;
  start: number;
  end: number;
  live: boolean;
  /** Exact earnings of this entry. */
  numerators: Numerators;
}

export function entriesOf(pieces: readonly Piece[], book: RateBook): Entry[] {
  return pieces
    .map((p) => ({
      key: `${p.seg.id}:${p.start}`,
      segId: p.seg.id,
      segmentId: segmentIdOf(p.seg),
      kind: kindOf(p.seg),
      gapKind: gapKindOf(p.seg),
      taskId: p.seg.taskId,
      projectId: p.seg.projectId,
      band: p.band,
      start: p.start,
      end: p.end,
      live: p.seg.live,
      numerators: isAway(kindOf(p.seg)) ? {} : pieceNumerators(book, p.seg.projectId, p.start, p.end),
    }))
    .sort((a, b) => a.start - b.start || (a.key < b.key ? -1 : 1));
}

export interface Block {
  key: string;
  segId: string;
  segmentId: string;
  kind: SegKind;
  gapKind: GapKind | undefined;
  taskId: string;
  projectId: string;
  start: number;
  end: number;
  live: boolean;
  lane: number;
}

/** One block per segment per day (band pieces merged), stacked into lanes if segments overlap. */
export function blocksOf(pieces: readonly Piece[]): { blocks: Block[]; lanes: number } {
  const by = new Map<string, Block>();
  for (const p of pieces) {
    const b = by.get(p.seg.id);
    if (b) {
      b.start = Math.min(b.start, p.start);
      b.end = Math.max(b.end, p.end);
    } else {
      by.set(p.seg.id, { key: p.seg.id, segId: p.seg.id, segmentId: segmentIdOf(p.seg), kind: kindOf(p.seg), gapKind: gapKindOf(p.seg), taskId: p.seg.taskId, projectId: p.seg.projectId, start: p.start, end: p.end, live: p.seg.live, lane: 0 });
    }
  }
  const blocks = [...by.values()].sort((a, b) => a.start - b.start);
  const { lanes, count } = assignLanes(blocks);
  blocks.forEach((b, i) => {
    b.lane = lanes[i] ?? 0;
  });
  return { blocks, lanes: count };
}

export interface Window {
  start: number;
  end: number;
}

/** The client's working hours on every client-zone date that touches `[start, end)`, clipped to it. */
export function workWindows(start: number, end: number, zone: string, workStart: string, workEnd: string): Window[] {
  const s = hhmmToMinutes(workStart);
  const e = hhmmToMinutes(workEnd);
  const out: Window[] = [];
  for (let d = addDays(dayOf(start, zone), -1); d <= dayOf(Math.max(start, end - 1), zone); d = addDays(d, 1)) {
    const a = instantOfWall(d, s, zone);
    const b = instantOfWall(e <= s ? addDays(d, 1) : d, e, zone);
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi > lo) out.push({ start: lo, end: hi });
  }
  return out;
}

export function overlapSecs(pieces: readonly { start: number; end: number }[], windows: readonly Window[]): number {
  let n = 0;
  for (const p of pieces) {
    for (const w of windows) n += Math.max(0, Math.min(p.end, w.end) - Math.max(p.start, w.start));
  }
  return n;
}

/** Monday of the week containing `day`. */
export const weekStart = (day: string): string => addDays(day, -(weekdayOf(day) - 1));
