// What counts as time, for the mock backend. A port of `pieces.rs`: raw segments are never altered;
// corrections, away-time decisions and billable pauses are overlays turned into the pieces reports read.
import { RateBook, centsOfNumerators, numeratorsOf, roundSeconds, taskDays, totalCents, type Bill, type SpanLike } from '../lib/billing';
import { addDays, dayOf, parseIso, startOfDay } from '../lib/tz';
import type {
  BillablePause,
  BillingSummary,
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

/**
 * What counts of another device's open segment once someone asked it to pause (the backend's `end_of`): nothing after
 * the earliest request for that segment, whatever the other device says, and never before the segment began.
 * `end` is the last known moment; a segment of this device, or one nobody asked about, keeps it.
 */
export function capAtPauseRequest(end: number, seg: Pick<MockSegment, 'id' | 'start' | 'deviceId'>, requests: readonly { segmentId: string; at: string }[], thisDevice: string): number {
  if (seg.deviceId === thisDevice) return end;
  const asked = requests.filter((q) => q.segmentId === seg.id).map((q) => parseIso(q.at));
  if (asked.length === 0) return end;
  return Math.max(Math.min(end, Math.min(...asked)), parseIso(seg.start));
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
  /** Live summaries, whose pauses keep their time first, earliest summary first. */
  summaries?: readonly Pick<BillingSummary, 'id' | 'voided' | 'createdAt' | 'number' | 'pauseIds'>[];
  /** The pauses a new summary will list, which come next. */
  listedPauses?: readonly string[];
}

type Claim = { at: number; number: number; id: string };
const compareClaims = (a: Claim, b: Claim): number => a.at - b.at || a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The order of `pieces_for_summary`: on a live summary, then on the new one, then by start and id. */
function pauseOrder(input: PieceInput): (x: BillablePause, y: BillablePause) => number {
  const claims = new Map<string, Claim>();
  for (const b of input.summaries ?? []) {
    if (b.voided) continue;
    const claim = { at: parseIso(b.createdAt), number: b.number, id: b.id };
    for (const id of b.pauseIds) {
      const first = claims.get(id);
      if (!first || compareClaims(claim, first) < 0) claims.set(id, claim);
    }
  }
  const listed = new Set(input.listedPauses ?? []);
  return (x, y) => {
    const a = claims.get(x.id);
    const b = claims.get(y.id);
    if (a && b) {
      const by = compareClaims(a, b);
      if (by !== 0) return by;
    } else if (a || b) {
      return a ? -1 : 1;
    }
    if (listed.has(x.id) !== listed.has(y.id)) return listed.has(x.id) ? -1 : 1;
    return parseIso(x.start) - parseIso(y.start) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  };
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
  const livePauses = input.pauses.filter((p) => !p.deleted && input.liveTasks.has(p.taskId)).sort(pauseOrder(input));
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
export function rowsOf(data: BillingData, pieces: readonly Piece[], zone: string, bill?: Bill) {
  const project = new Map(data.tasks.map((t) => [t.id, t.projectId]));
  const spans: SpanLike[] = [];
  for (const p of pieces) {
    const projectId = project.get(p.taskId);
    // A piece of zero seconds still makes its row, like `task_days_of`: it lists and bills (as zero).
    if (projectId !== undefined) spans.push({ taskId: p.taskId, projectId, start: p.start, end: p.end, kind: p.kind });
  }
  const book = new RateBook(data.projects, data.rates);
  return taskDays(spans, zone, book, data.rounding, bill);
}

export interface SummaryInput extends BillingData {
  segments: readonly MockSegment[];
  gaps: readonly IdleGap[];
  pauses: readonly BillablePause[];
  tasksLive: readonly { id: string; projectId: string; name: string }[];
  billedSegments: ReadonlySet<string>;
  billedPauses: ReadonlySet<string>;
  summaries: readonly BillingSummary[];
}

function splitByDay(start: number, end: number, zone: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  let cur = start;
  for (;;) {
    const day = dayOf(cur, zone);
    const next = startOfDay(addDays(day, 1), zone);
    if (next >= end) {
      out.push([day, cur, end]);
      return out;
    }
    out.push([day, cur, next]);
    cur = next;
  }
}

const inOrder = <T,>(m: ReadonlyMap<string, T>): [string, T][] => [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));

/** Puts one summary's rows for one task on the days their time lies on now: `hold_rows` in summary.rs. */
function holdRows(rows: readonly SummaryRow[], lies: ReadonlyMap<string, ReadonlyMap<string, number>>, hold: (day: string, secs: number) => void): void {
  const counted = (r: SummaryRow): number => r.exactSecs + r.pauseSecs;
  const timeIn = (days: ReadonlyMap<string, number>): number => [...days.values()].reduce((n, v) => n + v, 0);
  const froze = new Map(rows.map((r) => [r.day, counted(r)]));
  const brought = new Map<string, number>();
  for (const [theirDay, here] of inOrder(lies)) {
    let over = timeIn(here) - (froze.get(theirDay) ?? 0);
    for (const [day, secs] of inOrder(here)) {
      const part = Math.min(Math.max(over, 0), secs);
      if (part > 0) brought.set(day, (brought.get(day) ?? 0) + part);
      over -= part;
    }
  }
  // What is left goes over the time that is left, so the shares add up to the amount.
  const shareOut = (amount: number, days: ReadonlyMap<string, number>): void => {
    let left = amount;
    let time = timeIn(days);
    for (const [day, secs] of inOrder(days)) {
      const share = Math.floor((left * secs) / time);
      hold(day, share);
      left -= share;
      time -= secs;
    }
  };
  const lost = (r: SummaryRow): number => {
    const here = lies.get(r.day);
    return Math.max(counted(r) - (here ? timeIn(here) : 0), 0);
  };
  const gone = rows.reduce((n, r) => n + lost(r), 0);
  // No more can have moved than was brought. Which row it left can't be told, so each gives up its part.
  const came = Math.min(timeIn(brought), gone);
  let moved = 0;
  for (const r of rows) {
    const here = lies.get(r.day);
    const leaves = came === 0 ? 0 : Math.floor((lost(r) * came) / gone);
    const stays = counted(r) === 0 ? r.billableSecs : Math.floor((r.billableSecs * (counted(r) - leaves)) / counted(r));
    moved += r.billableSecs - stays;
    shareOut(stays, here && here.size > 0 ? here : new Map([[r.day, 1]]));
  }
  shareOut(moved, brought);
}

/**
 * What live summaries already bill for each task-day of `zone`: the rows they froze, never worked out again. A row's
 * amount goes where its time lies now: over this zone's days for a summary made in another zone, and along with its
 * time when a correction from a device that hadn't seen the summary moved it to another day.
 */
function heldByTaskDay(summaries: readonly BillingSummary[], taskIds: ReadonlySet<string>, zone: string, all: readonly Piece[]): Map<string, number> {
  const piecesOf = new Map<string, Piece[]>();
  for (const p of all) piecesOf.set(p.sourceId, [...(piecesOf.get(p.sourceId) ?? []), p]);
  const held = new Map<string, number>();
  for (const b of summaries) {
    if (b.voided) continue;
    // Per task and day of the summary's zone, the seconds it lists now, on each day of this one. None of them is zero.
    const lies = new Map<string, Map<string, Map<string, number>>>();
    for (const id of new Set([...b.segmentIds, ...b.pauseIds])) {
      for (const p of piecesOf.get(id) ?? []) {
        const task = lies.get(p.taskId) ?? new Map<string, Map<string, number>>();
        lies.set(p.taskId, task);
        for (const [theirDay, s, e] of splitByDay(p.start, p.end, b.zone)) {
          const here = task.get(theirDay) ?? new Map<string, number>();
          task.set(theirDay, here);
          for (const [day, from, to] of splitByDay(s, e, zone)) {
            if (to > from) here.set(day, (here.get(day) ?? 0) + to - from);
          }
        }
      }
    }
    for (const taskId of new Set(b.rows.map((r) => r.taskId))) {
      if (!taskIds.has(taskId)) continue;
      holdRows(b.rows.filter((r) => r.taskId === taskId), lies.get(taskId) ?? new Map<string, Map<string, number>>(), (day, secs) => {
        held.set(`${taskId}|${day}`, (held.get(`${taskId}|${day}`) ?? 0) + secs);
      });
    }
  }
  return held;
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
  const out: SummaryPreview = { rows: [], totals: {}, segmentIds: [], pauseIds: [], exactSecs: 0, pauseSecs: 0, billableSecs: 0, runningExcluded: false, unconfirmedSecs: 0, partlyBilledRows: 0 };
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
  const all = computePieces({ segments: data.segments, gaps: data.gaps, pauses: data.pauses, liveTasks: taskIds, summaries: data.summaries, listedPauses: out.pauseIds }, (s) => parseIso(s.end ?? s.start));
  const isListed = (p: Piece): boolean => (p.kind === 'billablePause' ? listedPauses.has(p.sourceId) : listedSegments.has(p.sourceId));
  const isHeld = (p: Piece): boolean => (p.kind === 'billablePause' ? data.billedPauses.has(p.sourceId) : data.billedSegments.has(p.sourceId));
  const billing = { ...data, projects: [project], tasks };
  // A task-day rounds once, as a whole: what this summary lists and what live summaries hold. A row
  // bills what that comes to less what they already bill for it, and nothing issued goes back.
  const whole = new Map(rowsOf(billing, all.filter((p) => isListed(p) || isHeld(p)), req.zone).map((r) => [`${r.taskId}|${r.day}`, r.billableSecs]));
  const held = heldByTaskDay(data.summaries, taskIds, req.zone, all);
  const bill: Bill = (taskId, day, counted) => {
    if (counted === 0) return 0;
    const key = `${taskId}|${day}`;
    return Math.max(0, (whole.get(key) ?? counted) - (held.get(key) ?? 0));
  };
  const rows = rowsOf(billing, all.filter(isListed), req.zone, bill).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.day.localeCompare(b.day));
  const names = new Map(tasks.map((t) => [t.id, t.name]));
  out.totals = totalCents(rows);
  for (const r of rows) {
    out.exactSecs += r.exactSecs;
    out.pauseSecs += r.pauseSecs;
    out.billableSecs += r.billableSecs;
    if (r.billableSecs !== roundSeconds(r.exactSecs + r.pauseSecs, r.rule.incrementMinutes, r.rule.method)) out.partlyBilledRows += 1;
    out.rows.push({ taskId: r.taskId, taskName: names.get(r.taskId) ?? '', day: r.day, exactSecs: r.exactSecs, pauseSecs: r.pauseSecs, billableSecs: r.billableSecs, cents: totalCents([r]) } satisfies SummaryRow);
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
      for (const [c, v] of Object.entries(numeratorsOf([r]))) {
        const sum = (f.timeValueNumerators ??= {});
        sum[c as Currency] = (sum[c as Currency] ?? 0) + (v as number);
      }
    }
  }
  for (const p of data.projects) {
    const f = fig(p.id);
    f.timeValueCents = centsOfNumerators(f.timeValueNumerators ?? {});
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
