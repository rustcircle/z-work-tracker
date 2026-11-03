// Shift analytics and the two-zone view. Neutral by design: figures and labels, no scores.
// Attribution is lib/shifts attributeSpan: each moment goes to one window, the earliest-started.
import type { ShiftWindow } from '../../lib/shifts';
import { gapPeriods, gapText, shiftText, shiftsBetween } from '../../lib/tz';
import { chunkDays, clockFor, OUTSIDE } from './engine';
import type { Ctx } from './mctx';
import { dayNum } from './range';
import { ratio } from './stats';

const LATE_TOLERANCE_SECS = 60;

/** Share of the window that has already happened inside the period: 0 when nothing is due yet. */
function dueBounds(w: ShiftWindow, ctx: Ctx): { s: number; e: number } | null {
  const s = Math.max(w.start, ctx.cur.period.from);
  const e = Math.min(w.end, ctx.cur.period.to, ctx.nowSec);
  return e > s ? { s, e } : null;
}

export function shiftsExist(ctx: Ctx): boolean {
  return ctx.snapshot.shifts.some((v) => !v.deleted && !v.retired);
}

/** Scheduled seconds (breaks excluded) per day, only for the part of each window that is due. */
export function scheduleByDay(ctx: Ctx): { exists: boolean; byDay: Map<number, number> } {
  const byDay = new Map<number, number>();
  const exists = shiftsExist(ctx);
  if (!exists) return { exists, byDay };
  const clock = clockFor(ctx.zones.active);
  for (const w of ctx.cur.windows) {
    const b = dueBounds(w, ctx);
    if (!b) continue;
    const weight = w.scheduledSecs / (w.end - w.start);
    chunkDays(b.s, b.e, clock, (d, secs) => byDay.set(d, (byDay.get(d) ?? 0) + secs * weight));
  }
  return { exists, byDay };
}

export interface ShiftStat {
  shiftId: string;
  name: string;
  color: string;
  zone: string;
  windows: number;
  scheduled: number;
  worked: number;
  attainment: number | null;
  /** Share of the due window time (breaks included) with any logged time. */
  coverage: number | null;
  measured: number;
  lateStarts: number;
  avgLate: number | null;
  earlyFinishes: number;
  avgEarly: number | null;
  byProject: Map<string, number>;
  clientHours: boolean;
}

export interface Shifts {
  configured: boolean;
  stats: ShiftStat[];
  scheduled: number;
  worked: number;
  outside: number;
  outsideShare: number | null;
  attainment: number | null;
  overtime: { secs: number; days: number };
  byDay: { dayNum: number; inShift: number; outside: number; scheduled: number }[];
  outsideByProject: Map<string, number>;
}

function unionLength(ivs: readonly number[]): number {
  const pairs: [number, number][] = [];
  for (let i = 0; i < ivs.length; i += 2) pairs.push([ivs[i] as number, ivs[i + 1] as number]);
  pairs.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = 0;
  let curE = 0;
  pairs.forEach(([s, e], i) => {
    if (i === 0 || s > curE) {
      total += curE - curS;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  });
  return total + (curE - curS);
}

export function shiftsOf(ctx: Ctx): Shifts {
  const { cur } = ctx;
  const configured = shiftsExist(ctx);
  const agg = cur.shift;
  const stats = new Map<string, ShiftStat>();
  const dueLen = new Map<string, number>();
  const lateSum = new Map<string, number>();
  const earlySum = new Map<string, number>();
  for (const w of cur.windows) {
    if (w.end <= cur.period.from || w.start >= cur.period.to) continue;
    let st = stats.get(w.shiftId);
    if (!st) {
      st = {
        shiftId: w.shiftId,
        name: w.name,
        color: w.color,
        zone: w.zone,
        windows: 0,
        scheduled: 0,
        worked: 0,
        attainment: null,
        coverage: null,
        measured: 0,
        lateStarts: 0,
        avgLate: null,
        earlyFinishes: 0,
        avgEarly: null,
        byProject: new Map(),
        clientHours: ctx.zones.client !== null && w.zone === ctx.zones.client,
      };
      stats.set(w.shiftId, st);
    }
    st.windows += 1;
    const due = dueBounds(w, ctx);
    if (due) {
      st.scheduled += (w.scheduledSecs * (due.e - due.s)) / (w.end - w.start);
      dueLen.set(w.shiftId, (dueLen.get(w.shiftId) ?? 0) + (due.e - due.s));
    }
    const wa = agg?.win.get(w);
    if (wa) {
      st.worked += wa.worked;
      for (const [p, v] of wa.byProject) st.byProject.set(p, (st.byProject.get(p) ?? 0) + v);
      st.coverage = (st.coverage ?? 0) + unionLength(wa.ivs);
      if (w.start >= cur.period.from && w.end <= Math.min(cur.period.to, ctx.nowSec)) {
        st.measured += 1;
        const late = wa.first - w.start;
        if (late > LATE_TOLERANCE_SECS) {
          st.lateStarts += 1;
          lateSum.set(w.shiftId, (lateSum.get(w.shiftId) ?? 0) + late);
        }
        const early = w.end - wa.last;
        if (early > LATE_TOLERANCE_SECS) {
          st.earlyFinishes += 1;
          earlySum.set(w.shiftId, (earlySum.get(w.shiftId) ?? 0) + early);
        }
      }
    }
  }
  const list = [...stats.values()];
  for (const st of list) {
    st.attainment = ratio(st.worked, st.scheduled);
    st.coverage = st.coverage === null ? ratio(0, dueLen.get(st.shiftId) ?? 0) : ratio(st.coverage, dueLen.get(st.shiftId) ?? 0);
    st.avgLate = st.lateStarts ? (lateSum.get(st.shiftId) as number) / st.lateStarts : null;
    st.avgEarly = st.earlyFinishes ? (earlySum.get(st.shiftId) as number) / st.earlyFinishes : null;
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  const scheduled = list.reduce((n, s) => n + s.scheduled, 0);
  const worked = list.reduce((n, s) => n + s.worked, 0);
  const sched = scheduleByDay(ctx);
  const first = dayNum(cur.period.fromDay);
  const byDay: Shifts['byDay'] = [];
  let overSecs = 0;
  let overDays = 0;
  for (let i = 0; i < cur.period.days; i += 1) {
    const n = first + i;
    const inShift = agg?.inByDay.get(n) ?? 0;
    const outside = agg?.outByDay.get(n) ?? 0;
    byDay.push({ dayNum: n, inShift, outside, scheduled: sched.byDay.get(n) ?? 0 });
    const over = (cur.dayTotals.get(n) ?? 0) - (sched.byDay.get(n) ?? 0);
    if (n <= ctx.today && over > 0) {
      overSecs += over;
      overDays += 1;
    }
  }
  const outside = agg?.outside ?? 0;
  return {
    configured,
    stats: list,
    scheduled,
    worked,
    outside,
    outsideShare: ratio(outside, outside + worked),
    attainment: ratio(worked, scheduled),
    overtime: { secs: overSecs, days: overDays },
    byDay,
    outsideByProject: agg?.outByProject ?? new Map(),
  };
}

export { OUTSIDE };

// ------------------------------------------------------------------ zones

export interface ZonesView {
  available: boolean;
  my: string;
  client: string | null;
  bandsMy: number[];
  bandsClient: number[];
  totalSecs: number;
  overlapSecs: number;
  overlapShare: number | null;
  workText: string;
  gaps: { start: number; end: number; gapSecs: number }[];
  gapNote: string | null;
  markers: string[];
}

export function zonesOf(ctx: Ctx): ZonesView {
  const { cur, zones } = ctx;
  const sumBands = (): number[] => {
    const out = [0, 0, 0, 0];
    for (const arr of cur.agg.band.values()) arr.forEach((v, i) => (out[i] = (out[i] as number) + v));
    return out;
  };
  const client = zones.client;
  const bandsMy = zones.my === zones.active ? sumBands() : (cur.bandsMy ?? [0, 0, 0, 0]);
  const bandsClient = client === null ? [0, 0, 0, 0] : client === zones.active ? sumBands() : (cur.bandsClient ?? [0, 0, 0, 0]);
  const gaps = client ? gapPeriods(cur.period.from, cur.period.to, zones.my, client).map((g) => ({ start: g.start, end: g.end, gapSecs: g.gap })) : [];
  const markers: string[] = [];
  for (const z of new Set([zones.active, zones.my, client].filter((x): x is string => x !== null))) {
    for (const c of shiftsBetween(cur.period.from, cur.period.to, z)) markers.push(shiftText(c));
  }
  return {
    available: client !== null,
    my: zones.my,
    client,
    bandsMy,
    bandsClient,
    totalSecs: cur.agg.total,
    overlapSecs: cur.overlap,
    overlapShare: ratio(cur.overlap, cur.agg.total),
    workText: `${ctx.snapshot.settings.clientWorkStart ?? '09:00'}-${ctx.snapshot.settings.clientWorkEnd ?? '17:00'}, every day`,
    gaps,
    gapNote: client ? gapText(Math.min(ctx.nowSec, cur.period.to - 1), zones.my, client) : null,
    markers,
  };
}
