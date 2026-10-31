// Analysis engine: turns the snapshot into additive aggregates for a period, in two stages.
//   prepare():  everything that cannot change while the clock ticks (closed segments). Memoised.
//   evaluate(): adds the segment running on this device (the live delta) to those aggregates.
// A tick therefore costs the live segment's work plus O(n) passes over compact numeric arrays,
// never a re-split of 50k segments. All wall-clock bucketing follows the zone's offset at each
// instant (tz.ts), so DST days keep their true length and a repeated hour lands in one bucket.
import { RateBook, taskDays, type TaskDay } from '../../lib/billing';
import { attributeSpan, windowsFor, type ShiftWindow } from '../../lib/shifts';
import { toSegs, type BandIndex, type Seg } from '../../lib/split';
import { addDays, hhmmToMinutes, instantOfWall, isZone, offsetAt, startOfDay, weekdayOf } from '../../lib/tz';
import type { Segment, Snapshot } from '../../lib/types';
import { dayNum, dayStr, periodOf, previousRange, weekdayIndex, type Period, type RangeSpec } from './range';

export const OUTSIDE = '__outside';
export const ALL_BANDS = 4;

export interface Filters {
  /** Empty means every project. */
  projectIds: readonly string[];
  taskIds: readonly string[];
  band: BandIndex | null;
  /** A shift id, or OUTSIDE for time in no shift window. */
  shiftKey: string | null;
}

export const NO_FILTERS: Filters = { projectIds: [], taskIds: [], band: null, shiftKey: null };
export const hasTimeFilter = (f: Filters): boolean => f.band !== null || f.shiftKey !== null;

export interface Params {
  zone: string;
  range: RangeSpec;
  filters: Filters;
  compare: boolean;
}

/** A stretch of logged time after clipping to the period and applying the filters. */
export interface SpanRec {
  taskId: string;
  projectId: string;
  start: number;
  end: number;
  /** The segment's own bounds before filters cut it, for start and finish times. */
  os: number;
  oe: number;
  live: boolean;
  /** Local day number of `start` in the analysis zone. */
  day: number;
}

export interface Gap {
  taskId: string;
  projectId: string;
  start: number;
  end: number;
}

export interface DayAgg {
  secs: number;
  band: number[];
  byProject: Map<string, number>;
  /** Earliest start and latest end, in minutes after midnight, of spans that started this day. */
  sMin: number;
  eMax: number;
  started: number;
}

export interface Agg {
  total: number;
  days: Map<number, DayAgg>;
  hour: Map<string, number[]>;
  band: Map<string, number[]>;
  weekdayHour: number[];
  byTask: Map<string, number>;
  byProject: Map<string, number>;
  /** Single-day periods only: seconds per `day * 24 + wall hour` per project. */
  hourly: Map<number, Map<string, number>> | null;
}

export interface WinAgg {
  worked: number;
  first: number;
  last: number;
  /** Flat start/end pairs of attributed pieces, for the union. */
  ivs: number[];
  byProject: Map<string, number>;
}

export interface ShiftAgg {
  win: Map<ShiftWindow, WinAgg>;
  outside: number;
  inByDay: Map<number, number>;
  outByDay: Map<number, number>;
  outByProject: Map<string, number>;
}

export interface Additive {
  agg: Agg;
  shift: ShiftAgg | null;
  /** Seconds of logged time inside the client's working hours. */
  overlap: number;
  bandsMy: number[] | null;
  bandsClient: number[] | null;
  dayTotals: Map<number, number>;
}

export interface Env {
  zone: string;
  myZone: string;
  clientZone: string | null;
  period: Period;
  ext: { from: number; to: number };
  windows: ShiftWindow[];
  maxWindow: number;
  clientWork: [number, number][] | null;
  hourly: boolean;
  full: boolean;
  filters: Filters;
  book: RateBook;
  snapshot: Snapshot;
}

export interface Dataset {
  period: Period;
  zone: string;
  spans: SpanRec[];
  /** Ascending session lengths in seconds. */
  lens: Float64Array;
  agg: Agg;
  rows: TaskDay[];
  gaps: Gap[];
  windows: ShiftWindow[];
  shift: ShiftAgg | null;
  overlap: number;
  bandsMy: number[] | null;
  bandsClient: number[] | null;
  dayTotals: Map<number, number>;
  liveCount: number;
}

interface Base {
  env: Env;
  spans: SpanRec[];
  lens: Float64Array;
  add: Additive;
  rowsByTask: Map<string, TaskDay[]>;
  spansByTask: Map<string, SpanRec[]>;
  rowsFlat: TaskDay[];
  gaps: Gap[];
}

export interface Prepared {
  snapshot: Snapshot;
  params: Params;
  cur: Base;
  prev: Base | null;
}

// ---------------------------------------------------------------- wall-clock walking

export const dayOfInstant = (sec: number, zone: string): number => Math.floor((sec + offsetAt(sec, zone)) / 86400);

/** Calls `cb` for each piece of `[start, end)` that sits inside one wall-clock hour of the zone. */
export function walkHours(start: number, end: number, zone: string, cb: (s: number, e: number, day: number, hour: number) => void): void {
  let cur = start;
  while (cur < end) {
    const off = offsetAt(cur, zone);
    const local = cur + off;
    const day = Math.floor(local / 86400);
    const inDay = local - day * 86400;
    const hour = Math.floor(inDay / 3600);
    let next = cur + 3600 - (inDay - hour * 3600);
    if (next > end) next = end;
    if (next - 1 > cur && offsetAt(next - 1, zone) !== off) {
      // The offset changes inside this piece: cut at the transition.
      let lo = cur;
      let hi = next - 1;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(mid, zone) === off) lo = mid;
        else hi = mid;
      }
      next = hi;
    }
    cb(cur, next, day, hour);
    cur = next;
  }
}

/** First instants after each local day, cached. */
export class DayClock {
  private cache = new Map<number, number>();
  constructor(readonly zone: string) {}
  after(day: number): number {
    let v = this.cache.get(day);
    if (v === undefined) {
      v = startOfDay(dayStr(day + 1), this.zone);
      this.cache.set(day, v);
    }
    return v;
  }
}

export function chunkDays(start: number, end: number, clock: DayClock, cb: (day: number, secs: number) => void): void {
  let cur = start;
  while (cur < end) {
    const day = dayOfInstant(cur, clock.zone);
    const nx = clock.after(day);
    const stop = nx > cur && nx < end ? nx : end;
    cb(day, stop - cur);
    cur = stop;
  }
}

const clocks = new Map<string, DayClock>();
export function clockFor(zone: string): DayClock {
  let c = clocks.get(zone);
  if (!c) {
    c = new DayClock(zone);
    clocks.set(zone, c);
  }
  return c;
}

// ---------------------------------------------------------------- spans

const segCache = new WeakMap<Snapshot, { closed: Seg[]; all: Seg[]; live: Segment[] }>();

function segsOf(snapshot: Snapshot) {
  let c = segCache.get(snapshot);
  if (!c) {
    const all = toSegs(snapshot, 0);
    const known = new Set(snapshot.tasks.map((t) => t.id));
    c = {
      all,
      closed: all.filter((s) => !s.live),
      live: snapshot.segments.filter((s) => s.end === null && s.provisionalEnd === null && known.has(s.taskId)),
    };
    segCache.set(snapshot, c);
  }
  return c;
}

export const closedSegs = (snapshot: Snapshot): Seg[] => segsOf(snapshot).closed;
export const liveSegs = (snapshot: Snapshot, nowSec: number): Seg[] => toSegs({ segments: segsOf(snapshot).live, tasks: snapshot.tasks }, nowSec);

function sortSpans(out: SpanRec[]): SpanRec[] {
  for (let i = 1; i < out.length; i += 1) {
    if ((out[i] as SpanRec).start < (out[i - 1] as SpanRec).start) return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return out;
}

function windowsNear(windows: readonly ShiftWindow[], maxWindow: number, start: number, end: number): ShiftWindow[] {
  let lo = 0;
  let hi = windows.length;
  const first = start - maxWindow;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((windows[mid] as ShiftWindow).start < first) lo = mid + 1;
    else hi = mid;
  }
  const out: ShiftWindow[] = [];
  for (let i = lo; i < windows.length; i += 1) {
    const w = windows[i] as ShiftWindow;
    if (w.start >= end) break;
    out.push(w);
  }
  return out;
}

/** Segments clipped to `[from, to)` with the project, task, band and shift filters applied. */
export function buildSpans(segs: readonly Seg[], from: number, to: number, env: Pick<Env, 'filters' | 'zone' | 'windows' | 'maxWindow'>): SpanRec[] {
  const f = env.filters;
  const proj = f.projectIds.length ? new Set(f.projectIds) : null;
  const task = f.taskIds.length ? new Set(f.taskIds) : null;
  const timeFilter = hasTimeFilter(f);
  const out: SpanRec[] = [];
  for (const s of segs) {
    if (proj && !proj.has(s.projectId)) continue;
    if (task && !task.has(s.taskId)) continue;
    const a = Math.max(s.start, from);
    const b = Math.min(s.end, to);
    if (b <= a) continue;
    if (!timeFilter) {
      out.push({ taskId: s.taskId, projectId: s.projectId, start: a, end: b, os: s.start, oe: s.end, live: s.live, day: dayOfInstant(a, env.zone) });
      continue;
    }
    let parts: [number, number][] = [[a, b]];
    if (f.shiftKey !== null) {
      const next: [number, number][] = [];
      for (const [x, y] of parts) {
        for (const at of attributeSpan(x, y, windowsNear(env.windows, env.maxWindow, x, y))) {
          const key = at.window ? at.window.shiftId : OUTSIDE;
          if (key !== f.shiftKey) continue;
          const last = next[next.length - 1];
          if (last && last[1] === at.start) last[1] = at.end;
          else next.push([at.start, at.end]);
        }
      }
      parts = next;
    }
    if (f.band !== null) {
      const next: [number, number][] = [];
      for (const [x, y] of parts) {
        walkHours(x, y, env.zone, (ps, pe, _d, hour) => {
          if (Math.floor(hour / 6) !== f.band) return;
          const last = next[next.length - 1];
          if (last && last[1] === ps) last[1] = pe;
          else next.push([ps, pe]);
        });
      }
      parts = next;
    }
    for (const [x, y] of parts) out.push({ taskId: s.taskId, projectId: s.projectId, start: x, end: y, os: x, oe: y, live: s.live, day: dayOfInstant(x, env.zone) });
  }
  return sortSpans(out);
}

export function clipSpans(spans: readonly SpanRec[], from: number, to: number, zone: string): SpanRec[] {
  const out: SpanRec[] = [];
  for (const s of spans) {
    if (s.end <= from || s.start >= to) continue;
    if (s.start >= from && s.end <= to) out.push(s);
    else {
      const start = Math.max(s.start, from);
      out.push({ ...s, start, end: Math.min(s.end, to), day: dayOfInstant(start, zone) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- aggregates

export function newAgg(hourly: boolean): Agg {
  return {
    total: 0,
    days: new Map(),
    hour: new Map(),
    band: new Map(),
    weekdayHour: new Array<number>(168).fill(0),
    byTask: new Map(),
    byProject: new Map(),
    hourly: hourly ? new Map() : null,
  };
}

function newDay(): DayAgg {
  return { secs: 0, band: [0, 0, 0, 0], byProject: new Map(), sMin: Number.POSITIVE_INFINITY, eMax: Number.NEGATIVE_INFINITY, started: 0 };
}

const bump = <K,>(m: Map<K, number>, k: K, v: number): void => void m.set(k, (m.get(k) ?? 0) + v);

function accumulate(agg: Agg, spans: readonly SpanRec[], zone: string, from: number, to: number): void {
  for (const sp of spans) {
    const p = sp.projectId;
    let hourArr = agg.hour.get(p);
    if (!hourArr) agg.hour.set(p, (hourArr = new Array<number>(24).fill(0)));
    let bandArr = agg.band.get(p);
    if (!bandArr) agg.band.set(p, (bandArr = [0, 0, 0, 0]));
    let lastDay = Number.NaN;
    let da: DayAgg | undefined;
    walkHours(sp.start, sp.end, zone, (s, e, day, hour) => {
      const len = e - s;
      if (len <= 0) return;
      agg.total += len;
      if (day !== lastDay) {
        da = agg.days.get(day);
        if (!da) agg.days.set(day, (da = newDay()));
        lastDay = day;
      }
      const d = da as DayAgg;
      const b = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
      d.secs += len;
      d.band[b] = (d.band[b] as number) + len;
      bump(d.byProject, p, len);
      (hourArr as number[])[hour] = ((hourArr as number[])[hour] as number) + len;
      (bandArr as number[])[b] = ((bandArr as number[])[b] as number) + len;
      const wi = weekdayIndex(day) * 24 + hour;
      agg.weekdayHour[wi] = (agg.weekdayHour[wi] as number) + len;
      bump(agg.byTask, sp.taskId, len);
      bump(agg.byProject, p, len);
      if (agg.hourly) {
        const k = day * 24 + hour;
        let m = agg.hourly.get(k);
        if (!m) agg.hourly.set(k, (m = new Map()));
        bump(m, p, len);
      }
    });
    if (sp.os >= from && sp.os < to) {
      const local = sp.os + offsetAt(sp.os, zone);
      const day = Math.floor(local / 86400);
      let d = agg.days.get(day);
      if (!d) agg.days.set(day, (d = newDay()));
      const eLocal = sp.oe + offsetAt(sp.oe, zone);
      d.sMin = Math.min(d.sMin, (local - day * 86400) / 60);
      d.eMax = Math.max(d.eMax, (eLocal - day * 86400) / 60);
      d.started += 1;
    }
  }
}

function addArrays(a: readonly number[], b: readonly number[]): number[] {
  return a.map((v, i) => v + (b[i] as number));
}

function mergeMapNum<K>(a: Map<K, number>, b: Map<K, number>): Map<K, number> {
  if (b.size === 0) return a;
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

function mergeArrMap(a: Map<string, number[]>, b: Map<string, number[]>): Map<string, number[]> {
  if (b.size === 0) return a;
  const out = new Map(a);
  for (const [k, v] of b) {
    const cur = out.get(k);
    out.set(k, cur ? addArrays(cur, v) : v);
  }
  return out;
}

function mergeDay(a: DayAgg, b: DayAgg): DayAgg {
  return {
    secs: a.secs + b.secs,
    band: addArrays(a.band, b.band),
    byProject: mergeMapNum(a.byProject, b.byProject),
    sMin: Math.min(a.sMin, b.sMin),
    eMax: Math.max(a.eMax, b.eMax),
    started: a.started + b.started,
  };
}

function mergeAgg(a: Agg, b: Agg): Agg {
  if (b.total === 0 && b.days.size === 0) return a;
  const days = new Map(a.days);
  for (const [k, v] of b.days) {
    const cur = days.get(k);
    days.set(k, cur ? mergeDay(cur, v) : v);
  }
  let hourly = a.hourly;
  if (a.hourly && b.hourly) {
    hourly = new Map(a.hourly);
    for (const [k, v] of b.hourly) hourly.set(k, mergeMapNum(hourly.get(k) ?? new Map<string, number>(), v));
  }
  return {
    total: a.total + b.total,
    days,
    hour: mergeArrMap(a.hour, b.hour),
    band: mergeArrMap(a.band, b.band),
    weekdayHour: addArrays(a.weekdayHour, b.weekdayHour),
    byTask: mergeMapNum(a.byTask, b.byTask),
    byProject: mergeMapNum(a.byProject, b.byProject),
    hourly,
  };
}

function newShiftAgg(): ShiftAgg {
  return { win: new Map(), outside: 0, inByDay: new Map(), outByDay: new Map(), outByProject: new Map() };
}

function accumulateShifts(sa: ShiftAgg, spans: readonly SpanRec[], env: Env): void {
  const clock = clockFor(env.zone);
  for (const sp of spans) {
    for (const at of attributeSpan(sp.start, sp.end, windowsNear(env.windows, env.maxWindow, sp.start, sp.end))) {
      const len = at.end - at.start;
      if (len <= 0) continue;
      if (at.window) {
        let w = sa.win.get(at.window);
        if (!w) sa.win.set(at.window, (w = { worked: 0, first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY, ivs: [], byProject: new Map() }));
        w.worked += len;
        w.first = Math.min(w.first, at.start);
        w.last = Math.max(w.last, at.end);
        w.ivs.push(at.start, at.end);
        bump(w.byProject, sp.projectId, len);
        chunkDays(at.start, at.end, clock, (d, s) => bump(sa.inByDay, d, s));
      } else {
        sa.outside += len;
        bump(sa.outByProject, sp.projectId, len);
        chunkDays(at.start, at.end, clock, (d, s) => bump(sa.outByDay, d, s));
      }
    }
  }
}

function mergeShift(a: ShiftAgg, b: ShiftAgg): ShiftAgg {
  if (b.win.size === 0 && b.outside === 0) return a;
  const win = new Map(a.win);
  for (const [k, v] of b.win) {
    const cur = win.get(k);
    win.set(
      k,
      cur
        ? { worked: cur.worked + v.worked, first: Math.min(cur.first, v.first), last: Math.max(cur.last, v.last), ivs: [...cur.ivs, ...v.ivs], byProject: mergeMapNum(cur.byProject, v.byProject) }
        : v,
    );
  }
  return {
    win,
    outside: a.outside + b.outside,
    inByDay: mergeMapNum(a.inByDay, b.inByDay),
    outByDay: mergeMapNum(a.outByDay, b.outByDay),
    outByProject: mergeMapNum(a.outByProject, b.outByProject),
  };
}

/** Client working hours, Monday to Friday in the client's zone, as ascending instant pairs. */
export function clientWorkWindows(snapshot: Snapshot, clientZone: string, from: number, to: number): [number, number][] {
  const startMin = hhmmToMinutes(snapshot.settings.clientWorkStart ?? '09:00');
  const endMin = hhmmToMinutes(snapshot.settings.clientWorkEnd ?? '17:00');
  const out: [number, number][] = [];
  if (endMin <= startMin) return out;
  const first = dayOfInstant(from, clientZone) - 1;
  const last = dayOfInstant(to, clientZone) + 1;
  for (let d = first; d <= last; d += 1) {
    const day = dayStr(d);
    if (weekdayOf(day) > 5) continue;
    out.push([instantOfWall(day, startMin, clientZone), instantOfWall(day, endMin, clientZone)]);
  }
  return out;
}

function overlapSecs(spans: readonly SpanRec[], work: readonly [number, number][]): number {
  let total = 0;
  for (const sp of spans) {
    let lo = 0;
    let hi = work.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((work[mid] as [number, number])[1] <= sp.start) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < work.length; i += 1) {
      const [ws, we] = work[i] as [number, number];
      if (ws >= sp.end) break;
      total += Math.min(we, sp.end) - Math.max(ws, sp.start);
    }
  }
  return total;
}

export function bandsOf(spans: readonly SpanRec[], zone: string): number[] {
  const out = [0, 0, 0, 0];
  for (const sp of spans) {
    walkHours(sp.start, sp.end, zone, (s, e, _d, hour) => {
      const b = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
      out[b] = (out[b] as number) + (e - s);
    });
  }
  return out;
}

function dayTotalsOf(spans: readonly SpanRec[], zone: string): Map<number, number> {
  const clock = clockFor(zone);
  const out = new Map<number, number>();
  for (const sp of spans) chunkDays(sp.start, sp.end, clock, (d, s) => out.set(d, (out.get(d) ?? 0) + s));
  return out;
}

function additiveOf(spans: readonly SpanRec[], ext: readonly SpanRec[], env: Env): Additive {
  const { from, to } = env.period;
  const agg = newAgg(env.hourly);
  accumulate(agg, spans, env.zone, from, to);
  let shift: ShiftAgg | null = null;
  if (env.full && env.windows.length > 0) {
    shift = newShiftAgg();
    accumulateShifts(shift, spans, env);
  }
  const wantMy = env.full && env.myZone !== env.zone;
  const wantClient = env.full && env.clientZone !== null;
  return {
    agg,
    shift,
    overlap: env.full && env.clientWork ? overlapSecs(spans, env.clientWork) : 0,
    bandsMy: wantMy ? bandsOf(spans, env.myZone) : null,
    bandsClient: wantClient ? bandsOf(spans, env.clientZone as string) : null,
    dayTotals: env.full ? dayTotalsOf(ext, env.zone) : new Map(),
  };
}

function mergeAdditive(a: Additive, b: Additive): Additive {
  return {
    agg: mergeAgg(a.agg, b.agg),
    shift: a.shift && b.shift ? mergeShift(a.shift, b.shift) : a.shift,
    overlap: a.overlap + b.overlap,
    bandsMy: a.bandsMy && b.bandsMy ? addArrays(a.bandsMy, b.bandsMy) : a.bandsMy,
    bandsClient: a.bandsClient && b.bandsClient ? addArrays(a.bandsClient, b.bandsClient) : a.bandsClient,
    dayTotals: mergeMapNum(a.dayTotals, b.dayTotals),
  };
}

// ---------------------------------------------------------------- pause gaps

/**
 * Paused time: the gap between consecutive segments of one task, plus the last segment's end to
 * the task's stop time. A task that is still paused has an open gap, which is not counted.
 */
export function pauseGaps(snapshot: Snapshot): Gap[] {
  const byTask = new Map<string, Seg[]>();
  for (const s of segsOf(snapshot).all) {
    const list = byTask.get(s.taskId);
    if (list) list.push(s);
    else byTask.set(s.taskId, [s]);
  }
  const out: Gap[] = [];
  for (const t of snapshot.tasks) {
    const list = byTask.get(t.id);
    if (!list) continue;
    list.sort((a, b) => a.start - b.start);
    let maxEnd = (list[0] as Seg).end;
    for (let i = 1; i < list.length; i += 1) {
      const s = list[i] as Seg;
      if (s.start > maxEnd) out.push({ taskId: t.id, projectId: t.projectId, start: maxEnd, end: s.start });
      maxEnd = Math.max(maxEnd, s.end);
    }
    if (t.state === 'stopped' && t.stoppedAt) {
      const stop = Math.floor(Date.parse(t.stoppedAt) / 1000);
      if (stop > maxEnd) out.push({ taskId: t.id, projectId: t.projectId, start: maxEnd, end: stop });
    }
  }
  return out;
}

function gapsFor(snapshot: Snapshot, env: Env): Gap[] {
  const f = env.filters;
  const proj = f.projectIds.length ? new Set(f.projectIds) : null;
  const task = f.taskIds.length ? new Set(f.taskIds) : null;
  const { from, to } = env.period;
  const out: Gap[] = [];
  for (const g of cachedGaps(snapshot)) {
    if (g.start < from || g.start >= to) continue;
    if (proj && !proj.has(g.projectId)) continue;
    if (task && !task.has(g.taskId)) continue;
    if (f.band !== null) {
      let hour = 0;
      walkHours(g.start, g.start + 1, env.zone, (_s, _e, _d, h) => (hour = h));
      if (Math.floor(hour / 6) !== f.band) continue;
    }
    if (f.shiftKey !== null) {
      const at = attributeSpan(g.start, g.start + 1, windowsNear(env.windows, env.maxWindow, g.start, g.start + 1))[0];
      if ((at?.window ? at.window.shiftId : OUTSIDE) !== f.shiftKey) continue;
    }
    out.push(g);
  }
  return out;
}

const gapCache = new WeakMap<Snapshot, Gap[]>();
function cachedGaps(snapshot: Snapshot): Gap[] {
  let g = gapCache.get(snapshot);
  if (!g) gapCache.set(snapshot, (g = pauseGaps(snapshot)));
  return g;
}

// ---------------------------------------------------------------- prepare and evaluate

function extWindow(period: Period, zone: string): { from: number; to: number } {
  const year = period.toDay.slice(0, 4);
  return {
    from: Math.min(period.from, startOfDay(addDays(`${period.fromDay.slice(0, 4)}-01-01`, -7), zone)),
    to: Math.max(period.to, startOfDay(addDays(`${year}-12-31`, 8), zone)),
  };
}

function makeEnv(snapshot: Snapshot, params: Params, period: Period, full: boolean, my: string, client: string | null): Env {
  const ext = full ? extWindow(period, params.zone) : { from: period.from, to: period.to };
  const windows = windowsFor(snapshot.shifts, ext.from, ext.to);
  return {
    zone: params.zone,
    myZone: my,
    clientZone: client,
    period,
    ext,
    windows,
    maxWindow: windows.reduce((m, w) => Math.max(m, w.end - w.start), 0),
    clientWork: full && client ? clientWorkWindows(snapshot, client, period.from, period.to) : null,
    hourly: period.days === 1,
    full,
    filters: params.filters,
    book: new RateBook(snapshot.projects, snapshot.rates),
    snapshot,
  };
}

function groupBy<T extends { taskId: string }>(items: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const l = m.get(it.taskId);
    if (l) l.push(it);
    else m.set(it.taskId, [it]);
  }
  return m;
}

function prepareBase(snapshot: Snapshot, params: Params, period: Period, full: boolean, my: string, client: string | null): Base {
  const env = makeEnv(snapshot, params, period, full, my, client);
  const ext = buildSpans(closedSegs(snapshot), env.ext.from, env.ext.to, env);
  const spans = full ? clipSpans(ext, period.from, period.to, params.zone) : ext;
  const rows = taskDays(spans, params.zone, env.book, snapshot.rounding);
  const lens = Float64Array.from(spans, (s) => s.end - s.start).sort();
  return {
    env,
    spans,
    lens,
    add: additiveOf(spans, ext, env),
    rowsByTask: groupBy(rows),
    spansByTask: groupBy(spans),
    rowsFlat: rows,
    gaps: gapsFor(snapshot, env),
  };
}

/** My zone and client zone as the app resolves them: settings, else the system zone, else UTC. */
export function resolveZones(snapshot: Snapshot): { my: string; client: string | null } {
  const ok = (z: string | null | undefined): string | null => (z && isZone(z) ? z : null);
  return { my: ok(snapshot.settings.myZone) ?? ok(snapshot.systemZone) ?? 'UTC', client: ok(snapshot.settings.clientZone) };
}

const prepCache = new WeakMap<Snapshot, Map<string, Prepared>>();

export function paramsKey(p: Params): string {
  return JSON.stringify([p.zone, p.range, p.filters, p.compare]);
}

export function prepare(snapshot: Snapshot, params: Params): Prepared {
  const key = paramsKey(params);
  let per = prepCache.get(snapshot);
  if (!per) prepCache.set(snapshot, (per = new Map()));
  const hit = per.get(key);
  if (hit) return hit;
  const z = resolveZones(snapshot);
  const period = periodOf(params.range, params.zone);
  const cur = prepareBase(snapshot, params, period, true, z.my, z.client);
  const prev = params.compare ? prepareBase(snapshot, params, periodOf(previousRange(params.range), params.zone), false, z.my, z.client) : null;
  const prep: Prepared = { snapshot, params, cur, prev };
  if (per.size >= 6) per.delete(per.keys().next().value as string);
  per.set(key, prep);
  return prep;
}

function evaluateBase(base: Base, snapshot: Snapshot, zone: string, nowSec: number): Dataset {
  const env = base.env;
  const liveAll = liveSegs(snapshot, nowSec);
  const extLive = liveAll.length ? buildSpans(liveAll, env.ext.from, env.ext.to, env) : [];
  const live = env.full ? clipSpans(extLive, env.period.from, env.period.to, zone) : extLive;
  if (extLive.length === 0) {
    return {
      period: env.period,
      zone,
      spans: base.spans,
      lens: base.lens,
      agg: base.add.agg,
      rows: base.rowsFlat,
      gaps: base.gaps,
      windows: env.windows,
      shift: base.add.shift,
      overlap: base.add.overlap,
      bandsMy: base.add.bandsMy,
      bandsClient: base.add.bandsClient,
      dayTotals: base.add.dayTotals,
      liveCount: 0,
    };
  }
  const delta = additiveOf(live, extLive, env);
  const add = mergeAdditive(base.add, delta);
  const spans = live.length ? sortSpans([...base.spans, ...live]) : base.spans;
  let lens = base.lens;
  if (live.length) {
    const extra = Float64Array.from(live, (s) => s.end - s.start).sort();
    const merged = new Float64Array(lens.length + extra.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < lens.length || j < extra.length) {
      const takeLeft = j >= extra.length || (i < lens.length && (lens[i] as number) <= (extra[j] as number));
      merged[k++] = takeLeft ? (lens[i++] as number) : (extra[j++] as number);
    }
    lens = merged;
  }
  let rows = base.rowsFlat;
  if (live.length) {
    const tasks = new Set(live.map((s) => s.taskId));
    const keep = base.rowsFlat.filter((r) => !tasks.has(r.taskId));
    for (const t of tasks) {
      const closed = base.spansByTask.get(t) ?? [];
      const mine = live.filter((s) => s.taskId === t);
      for (const r of taskDays([...closed, ...mine], zone, env.book, snapshot.rounding)) keep.push(r);
    }
    rows = keep;
  }
  return {
    period: env.period,
    zone,
    spans,
    lens,
    agg: add.agg,
    rows,
    gaps: base.gaps,
    windows: env.windows,
    shift: add.shift,
    overlap: add.overlap,
    bandsMy: add.bandsMy,
    bandsClient: add.bandsClient,
    dayTotals: add.dayTotals,
    liveCount: live.length,
  };
}

export interface Evaluated {
  cur: Dataset;
  prev: Dataset | null;
}

export function evaluate(prep: Prepared, nowSec: number): Evaluated {
  return {
    cur: evaluateBase(prep.cur, prep.snapshot, prep.params.zone, nowSec),
    prev: prep.prev ? evaluateBase(prep.prev, prep.snapshot, prep.params.zone, nowSec) : null,
  };
}

/** True when a segment running on this device could change the numbers of this period. */
export function hasLiveIn(snapshot: Snapshot, period: Period, nowSec: number): boolean {
  return segsOf(snapshot).live.length > 0 && nowSec > period.from;
}

export { dayNum, dayStr };

const firstCache = new WeakMap<Snapshot, Map<string, number>>();
/** Earliest segment start per task, over all time. */
export function taskFirstStarts(snapshot: Snapshot): Map<string, number> {
  let m = firstCache.get(snapshot);
  if (!m) {
    m = new Map();
    for (const s of segsOf(snapshot).all) {
      const cur = m.get(s.taskId);
      if (cur === undefined || s.start < cur) m.set(s.taskId, s.start);
    }
    firstCache.set(snapshot, m);
  }
  return m;
}

const budgetCache = new WeakMap<Snapshot, Map<string, Map<string, Map<number, number>>>>();
/** All-time exact seconds per local day for each project with a budget, from closed segments. */
export function budgetDaily(snapshot: Snapshot, zone: string): Map<string, Map<number, number>> {
  let per = budgetCache.get(snapshot);
  if (!per) budgetCache.set(snapshot, (per = new Map()));
  const hit = per.get(zone);
  if (hit) return hit;
  const budgeted = new Set(snapshot.projects.filter((p) => p.budgetHours !== null).map((p) => p.id));
  const out = new Map<string, Map<number, number>>();
  const clock = clockFor(zone);
  for (const s of closedSegs(snapshot)) {
    if (!budgeted.has(s.projectId)) continue;
    let m = out.get(s.projectId);
    if (!m) out.set(s.projectId, (m = new Map()));
    const days = m;
    chunkDays(s.start, s.end, clock, (d, secs) => days.set(d, (days.get(d) ?? 0) + secs));
  }
  per.set(zone, out);
  return out;
}

/** The running segments' share of each day, per project, for the budget projects. */
export function liveDaily(snapshot: Snapshot, zone: string, nowSec: number): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  const clock = clockFor(zone);
  for (const s of liveSegs(snapshot, nowSec)) {
    let m = out.get(s.projectId);
    if (!m) out.set(s.projectId, (m = new Map()));
    const days = m;
    chunkDays(s.start, s.end, clock, (d, secs) => days.set(d, (days.get(d) ?? 0) + secs));
  }
  return out;
}
