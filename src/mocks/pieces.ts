// What counts as time, for the mock backend. A port of `pieces.rs`: raw segments are never altered;
// corrections, away-time decisions and billable pauses are overlays turned into the pieces reports read.
import { RateBook, centsFromNumerator, numeratorsOf, taskDays, type SpanLike } from '../lib/billing';
import { dayOf, parseIso } from '../lib/tz';
import type {
  BillablePause,
  BudgetStatus,
  Currency,
  IdleGap,
  PieceKind,
  Project,
  ProjectFigures,
  RateVersion,
  RoundingVersion,
  Segment,
  SummaryPreview,
  SummaryRequest,
  SummaryRow,
} from '../lib/types';

/** A recorded segment as the mock stores it: the view fields plus what a correction needs. */
export interface MockSegment extends Segment {
  manual?: boolean;
  edit?: { start: string; end: string; voided: boolean; reason: string } | null;
}

export interface Piece {
  id: string;
  sourceId: string;
  taskId: string;
  deviceId: string | null;
  start: number;
  end: number;
  open: boolean;
  kind: PieceKind;
  subtaskId: string | null;
}

/** The times that count, or null when voided. The end is null while running. */
export function effective(s: MockSegment): [number, number | null] | null {
  if (s.edit?.voided) return null;
  if (s.edit) return [parseIso(s.edit.start), parseIso(s.edit.end)];
  return [parseIso(s.start), s.end === null ? null : parseIso(s.end)];
}

type Span = [number, number];

function subtract(intervals: Span[], cut: Span): Span[] {
  const out: Span[] = [];
  for (const [s, e] of intervals) {
    if (cut[1] <= s || cut[0] >= e) {
      out.push([s, e]);
      continue;
    }
    if (cut[0] > s) out.push([s, cut[0]]);
    if (cut[1] < e) out.push([cut[1], e]);
  }
  return out;
}

export interface PieceInput {
  segments: readonly MockSegment[];
  gaps: readonly IdleGap[];
  pauses: readonly BillablePause[];
  liveTasks: ReadonlySet<string>;
}

export function computePieces(input: PieceInput, endOf: (s: MockSegment) => number): Piece[] {
  const gapsBySegment = new Map<string, { s: number; e: number; d: IdleGap['decision'] }[]>();
  for (const g of input.gaps) {
    const list = gapsBySegment.get(g.segmentId) ?? [];
    list.push({ s: parseIso(g.start), e: parseIso(g.end), d: g.decision });
    gapsBySegment.set(g.segmentId, list);
  }
  const out: Piece[] = [];
  const spans = new Map<string, Span[]>();
  for (const seg of input.segments) {
    if (!input.liveTasks.has(seg.taskId)) continue;
    const eff = effective(seg);
    if (!eff) continue;
    const start = eff[0];
    const open = eff[1] === null;
    const end = Math.max(eff[1] ?? endOf(seg), start);
    const list = spans.get(seg.taskId) ?? [];
    list.push([start, end]);
    spans.set(seg.taskId, list);
    const push = (n: number, s: number, e: number, kind: PieceKind, last: boolean): void => {
      out.push({
        id: n === 0 ? seg.id : `${seg.id}:${n}`,
        sourceId: seg.id,
        taskId: seg.taskId,
        deviceId: seg.deviceId,
        start: s,
        end: e,
        open: open && last,
        kind,
        subtaskId: seg.subtaskId ?? null,
      });
    };
    const gaps = (gapsBySegment.get(seg.id) ?? []).filter((g) => g.d !== 'keep');
    if (gaps.length === 0) {
      push(0, start, end, 'work', true);
      continue;
    }
    gaps.sort((a, b) => a.s - b.s || a.e - b.e);
    let cursor = start;
    let n = 0;
    for (const g of gaps) {
      const gs = Math.min(Math.max(g.s, cursor), end);
      const ge = Math.min(g.e, end);
      if (ge <= gs) continue;
      if (gs > cursor) {
        push(n, cursor, gs, 'work', false);
        n += 1;
      }
      if (g.d === 'thinking') {
        push(n, gs, ge, 'thinking', false);
        n += 1;
      }
      cursor = ge;
    }
    // An open segment always keeps a last piece, even if empty, so its timer has somewhere to run.
    if (cursor < end || open || n === 0) push(n, cursor, end, 'work', true);
  }
  // Sorted by a replicated key, so a span marked twice bills once, the same way on every device.
  const livePauses = input.pauses
    .filter((p) => !p.deleted && input.liveTasks.has(p.taskId))
    .sort((x, y) => parseIso(x.start) - parseIso(y.start) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const pausedSpans = new Map<string, Span[]>();
  for (const pause of livePauses) {
    // A pause never bills time that is already counted, or dropped, inside a segment.
    let free: Span[] = [[parseIso(pause.start), parseIso(pause.end)]];
    for (const span of spans.get(pause.taskId) ?? []) free = subtract(free, span);
    for (const span of pausedSpans.get(pause.taskId) ?? []) free = subtract(free, span);
    pausedSpans.set(pause.taskId, [...(pausedSpans.get(pause.taskId) ?? []), ...free]);
    free.forEach(([s, e], i) => {
      out.push({ id: `${pause.id}:${i}`, sourceId: pause.id, taskId: pause.taskId, deviceId: null, start: s, end: e, open: false, kind: 'billablePause', subtaskId: null });
    });
  }
  return out;
}

export const pieceSecs = (p: Piece): number => p.end - p.start;

/** Seconds away with no decision yet, per task. They count nowhere until confirmed. */
export function unconfirmedSecs(gaps: readonly IdleGap[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of gaps) {
    if (g.decision === 'pending') out.set(g.taskId, (out.get(g.taskId) ?? 0) + Math.max(0, parseIso(g.end) - parseIso(g.start)));
  }
  return out;
}

export interface TaskTotals {
  billedSecs: number;
  unbilledSecs: number;
  thinkingSecs: number;
  pauseSecs: number;
  subtaskSecs: Map<string, number>;
}

export function taskTotals(all: readonly Piece[], billedSegments: ReadonlySet<string>, billedPauses: ReadonlySet<string>): Map<string, TaskTotals> {
  const out = new Map<string, TaskTotals>();
  for (const p of all) {
    let t = out.get(p.taskId);
    if (!t) {
      t = { billedSecs: 0, unbilledSecs: 0, thinkingSecs: 0, pauseSecs: 0, subtaskSecs: new Map() };
      out.set(p.taskId, t);
    }
    const billed = p.kind === 'billablePause' ? billedPauses.has(p.sourceId) : billedSegments.has(p.sourceId);
    if (billed) t.billedSecs += pieceSecs(p);
    else t.unbilledSecs += pieceSecs(p);
    if (p.kind === 'thinking') t.thinkingSecs += pieceSecs(p);
    if (p.kind === 'billablePause') t.pauseSecs += pieceSecs(p);
    if (p.subtaskId && p.kind !== 'billablePause') t.subtaskSecs.set(p.subtaskId, (t.subtaskSecs.get(p.subtaskId) ?? 0) + pieceSecs(p));
  }
  return out;
}

export interface BillingData {
  projects: readonly (Pick<Project, 'id' | 'billable' | 'billingType'> & { budgetHours?: number | null; fixedFeeCents?: number | null; feeCurrency?: Currency | null })[];
  tasks: readonly { id: string; projectId: string }[];
  rates: readonly RateVersion[];
  rounding: readonly RoundingVersion[];
}

/** The task-day rows of the given pieces: the same figures every report and summary reads. */
export function rowsOf(data: BillingData, pieces: readonly Piece[], zone: string) {
  const project = new Map(data.tasks.map((t) => [t.id, t.projectId]));
  const spans: SpanLike[] = [];
  for (const p of pieces) {
    const projectId = project.get(p.taskId);
    // A piece of zero seconds still makes its row, like `task_days_of`: it lists and bills (as zero).
    if (projectId !== undefined) spans.push({ taskId: p.taskId, projectId, start: p.start, end: p.end, kind: p.kind });
  }
  const book = new RateBook(data.projects, data.rates);
  return taskDays(spans, zone, book, data.rounding);
}

const centsOf = (n: Partial<Record<Currency, number>>): Partial<Record<Currency, number>> =>
  Object.fromEntries(Object.entries(n).map(([c, v]) => [c, centsFromNumerator(v as number)]));

export interface SummaryInput extends BillingData {
  segments: readonly MockSegment[];
  gaps: readonly IdleGap[];
  pauses: readonly BillablePause[];
  tasksLive: readonly { id: string; projectId: string; name: string }[];
  billedSegments: ReadonlySet<string>;
  billedPauses: ReadonlySet<string>;
}

/** Unbilled, closed time of a project in a period. Time belongs to the day its segment started. */
export function summaryPreview(data: SummaryInput, req: SummaryRequest): SummaryPreview {
  const project = data.projects.find((p) => p.id === req.projectId);
  const tasks = data.tasksLive.filter((t) => t.projectId === req.projectId);
  const taskIds = new Set(tasks.map((t) => t.id));
  const inPeriod = (t: number): boolean => {
    const d = dayOf(t, req.zone);
    return d >= req.from && d <= req.to;
  };
  const out: SummaryPreview = { rows: [], totals: {}, segmentIds: [], pauseIds: [], exactSecs: 0, pauseSecs: 0, billableSecs: 0, runningExcluded: false, unconfirmedSecs: 0 };
  if (!project) return out;
  for (const s of data.segments) {
    const eff = effective(s);
    if (!eff || !taskIds.has(s.taskId) || !inPeriod(eff[0])) continue;
    if (eff[1] === null) {
      out.runningExcluded = true;
      continue;
    }
    if (!data.billedSegments.has(s.id)) {
      out.segmentIds.push(s.id);
    }
  }
  for (const p of data.pauses) {
    if (!p.deleted && taskIds.has(p.taskId) && inPeriod(parseIso(p.start)) && !data.billedPauses.has(p.id)) out.pauseIds.push(p.id);
  }
  const listedSegments = new Set(out.segmentIds);
  const listedPauses = new Set(out.pauseIds);
  for (const g of data.gaps) {
    if (g.decision === 'pending' && listedSegments.has(g.segmentId)) out.unconfirmedSecs += Math.max(0, parseIso(g.end) - parseIso(g.start));
  }
  // Pieces come from the whole store, so a pause never bills what an already billed segment covers,
  // and are then narrowed to what this summary lists.
  const pieces = computePieces({ segments: data.segments, gaps: data.gaps, pauses: data.pauses, liveTasks: taskIds }, (s) => parseIso(s.end ?? s.start)).filter((p) =>
    p.kind === 'billablePause' ? listedPauses.has(p.sourceId) : listedSegments.has(p.sourceId),
  );
  const rows = rowsOf({ ...data, projects: [project], tasks }, pieces, req.zone).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.day.localeCompare(b.day));
  const names = new Map(tasks.map((t) => [t.id, t.name]));
  for (const r of rows) {
    const cents = centsOf(numeratorsOf([r]));
    for (const [c, v] of Object.entries(cents)) out.totals[c as Currency] = (out.totals[c as Currency] ?? 0) + (v as number);
    out.exactSecs += r.exactSecs;
    out.pauseSecs += r.pauseSecs;
    out.billableSecs += r.billableSecs;
    out.rows.push({ taskId: r.taskId, taskName: names.get(r.taskId) ?? '', day: r.day, exactSecs: r.exactSecs, pauseSecs: r.pauseSecs, billableSecs: r.billableSecs, cents } satisfies SummaryRow);
  }
  return out;
}

const levelOf = (percent: number): 0 | 80 | 100 => (percent >= 100 ? 100 : percent >= 80 ? 80 : 0);

/** Per project, from the task-day rows of the given zone. Fixed-fee time is valued at the rate history. */
export function projectFigures(data: BillingData, input: PieceInput, zone: string, endOf: (s: MockSegment) => number): Map<string, ProjectFigures> {
  const wanted = new Set(data.projects.filter((p) => (p.budgetHours ?? null) !== null || p.billingType === 'fixedFee').map((p) => p.id));
  const out = new Map<string, ProjectFigures>();
  const fig = (id: string): ProjectFigures => {
    let f = out.get(id);
    if (!f) {
      f = { exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget: null };
      out.set(id, f);
    }
    return f;
  };
  if (wanted.size > 0) {
    const hourly = data.projects.filter((p) => wanted.has(p.id)).map((p) => ({ ...p, billingType: 'hourly' as const, billable: true }));
    const tasks = data.tasks.filter((t) => wanted.has(t.projectId));
    const live = new Set(tasks.map((t) => t.id));
    const pieces = computePieces({ ...input, liveTasks: live, segments: input.segments.filter((s) => live.has(s.taskId)) }, endOf);
    for (const r of rowsOf({ ...data, projects: hourly, tasks }, pieces, zone)) {
      const f = fig(r.projectId);
      f.exactSecs += r.exactSecs;
      f.pauseSecs += r.pauseSecs;
      f.thinkingSecs += r.thinkingSecs;
      f.billableSecs += r.billableSecs;
      for (const [c, v] of Object.entries(centsOf(numeratorsOf([r])))) f.timeValueCents[c as Currency] = (f.timeValueCents[c as Currency] ?? 0) + (v as number);
    }
  }
  for (const p of data.projects) {
    const f = fig(p.id);
    const fee = p.billingType === 'fixedFee' ? (p.fixedFeeCents ?? null) : null;
    if (fee !== null && f.billableSecs > 0) f.effectiveHourlyCents = Math.floor((fee * 3600) / f.billableSecs);
    let budget: BudgetStatus | null = null;
    if (p.budgetHours && p.budgetHours > 0) {
      const percent = Math.floor((f.billableSecs / (p.budgetHours * 3600)) * 100);
      budget = { basis: 'hours', percent, level: levelOf(percent), needsTargetRate: false };
    } else if (fee !== null && fee > 0) {
      const value = p.feeCurrency ? f.timeValueCents[p.feeCurrency] : undefined;
      const percent = value === undefined ? 0 : Math.floor((value * 100) / fee);
      budget = { basis: 'fee', percent, level: levelOf(percent), needsTargetRate: value === undefined };
    }
    f.budget = budget;
  }
  return out;
}
