// Volume, time series, time of day, weekday and calendar metrics.
import { addDays, offsetAt, shiftText, shiftsBetween } from '../../lib/tz';
import { BANDS } from '../../lib/split';
import type { Dataset } from './engine';
import { dayOfInstant } from './engine';
import { activeDayNums, billableTotal, elapsedDays, exactTotal, rowIndex, totalOf, type Basis, type Ctx } from './mctx';
import { dayNum, dayStr, mondayOf, MONTH_SHORT, WEEKDAY_NAMES, WEEKDAY_SHORT, weekdayIndex, type Period } from './range';
import { argMax, argMin, delta, ratio, type Delta } from './stats';

export interface Volume {
  exact: number;
  billable: number;
  /** The figure for the chosen basis. */
  primary: number;
  activeDays: number;
  elapsedDays: number;
  calendarDays: number;
  avgPerActiveDay: number | null;
  avgPerCalendarDay: number | null;
  perWeek: number | null;
  deltaTotal: Delta | null;
  deltaActive: Delta | null;
  deltaAvgActive: Delta | null;
  deltaBillable: Delta | null;
  prevPrimary: number | null;
}

export function volumeOf(ctx: Ctx): Volume {
  const { cur, prev, basis, today } = ctx;
  const exact = exactTotal(cur);
  const billable = ctx.billableAvailable ? billableTotal(cur) : exact;
  const primary = basis === 'billable' ? billable : exact;
  const active = activeDayNums(cur).length;
  const elapsed = elapsedDays(cur, today);
  const avgActive = active > 0 ? primary / active : null;
  const pPrimary = prev ? totalOf(prev, basis) : null;
  const pActive = prev ? activeDayNums(prev).length : null;
  const pAvg = prev && pActive ? totalOf(prev, basis) / pActive : null;
  return {
    exact,
    billable,
    primary,
    activeDays: active,
    elapsedDays: elapsed,
    calendarDays: cur.period.days,
    avgPerActiveDay: avgActive,
    avgPerCalendarDay: elapsed > 0 ? primary / elapsed : null,
    perWeek: elapsed >= 7 ? primary / (elapsed / 7) : null,
    deltaTotal: delta(primary, pPrimary),
    deltaActive: delta(active, pActive),
    deltaAvgActive: delta(avgActive, pAvg),
    deltaBillable: prev && ctx.billableAvailable ? delta(billable, billableTotal(prev)) : null,
    prevPrimary: pPrimary,
  };
}

// ------------------------------------------------------------------ series

export type Unit = 'hour' | 'day' | 'week' | 'month';

export interface Bucket {
  key: string;
  label: string;
  fromDay: number;
  toDay: number;
}

export function unitFor(days: number): Unit {
  return days === 1 ? 'hour' : days <= 62 ? 'day' : days <= 400 ? 'week' : 'month';
}

export function bucketsOf(period: Pick<Period, 'fromDay' | 'toDay' | 'days'>, unit: Unit): Bucket[] {
  const first = dayNum(period.fromDay);
  const last = dayNum(period.toDay);
  const out: Bucket[] = [];
  if (unit === 'hour') {
    for (let h = 0; h < 24; h += 1) out.push({ key: String(h), label: String(h).padStart(2, '0'), fromDay: first, toDay: first });
    return out;
  }
  if (unit === 'day') {
    for (let n = first; n <= last; n += 1) {
      const day = dayStr(n);
      out.push({ key: day, label: period.days <= 7 ? `${WEEKDAY_SHORT[weekdayIndex(n)]} ${Number(day.slice(8))}` : String(Number(day.slice(8))), fromDay: n, toDay: n });
    }
    return out;
  }
  if (unit === 'week') {
    let n = first;
    while (n <= last) {
      const end = Math.min(last, dayNum(addDays(mondayOf(dayStr(n)), 6)));
      const d = dayStr(n);
      out.push({ key: d, label: `${Number(d.slice(8))} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1]}`, fromDay: n, toDay: end });
      n = end + 1;
    }
    return out;
  }
  let n = first;
  while (n <= last) {
    const d = dayStr(n);
    const nextMonth = dayNum(`${Number(d.slice(5, 7)) === 12 ? Number(d.slice(0, 4)) + 1 : d.slice(0, 4)}-${String((Number(d.slice(5, 7)) % 12) + 1).padStart(2, '0')}-01`);
    const end = Math.min(last, nextMonth - 1);
    out.push({ key: d.slice(0, 7), label: `${MONTH_SHORT[Number(d.slice(5, 7)) - 1]}${d.slice(0, 4) === period.toDay.slice(0, 4) && d.slice(0, 4) === period.fromDay.slice(0, 4) ? '' : ` ${d.slice(2, 4)}`}`, fromDay: n, toDay: end });
    n = end + 1;
  }
  return out;
}

export interface SeriesPoint extends Bucket {
  exact: number;
  billable: number;
  /** For the chosen basis (hour buckets are always exact). */
  secs: number;
  byProject: Map<string, number>;
  prev: number | null;
  target: number | null;
}

export interface Marker {
  index: number;
  text: string;
  zone: string;
}

export interface Series {
  unit: Unit;
  points: SeriesPoint[];
  markers: Marker[];
  maxSecs: number;
  note: string | null;
}

function pointOf(ds: Dataset, b: Bucket, unit: Unit, basis: Basis, billableOk: boolean): { exact: number; billable: number; byExact: Map<string, number>; byBillable: Map<string, number> } {
  const byExact = new Map<string, number>();
  const byBillable = new Map<string, number>();
  let exact = 0;
  let billable = 0;
  if (unit === 'hour') {
    const m = ds.agg.hourly?.get(b.fromDay * 24 + Number(b.key));
    if (m) for (const [p, v] of m) {
      byExact.set(p, v);
      byBillable.set(p, v);
      exact += v;
    }
    return { exact, billable: exact, byExact, byBillable };
  }
  const idx = billableOk || basis === 'billable' ? rowIndex(ds.rows) : null;
  for (let n = b.fromDay; n <= b.toDay; n += 1) {
    const a = ds.agg.days.get(n);
    if (a) {
      exact += a.secs;
      for (const [p, v] of a.byProject) byExact.set(p, (byExact.get(p) ?? 0) + v);
    }
    const rb = idx?.byDay.get(n);
    if (rb) for (const [p, v] of rb) {
      byBillable.set(p, (byBillable.get(p) ?? 0) + v);
      billable += v;
    }
  }
  return { exact, billable: billableOk ? billable : exact, byExact, byBillable: billableOk ? byBillable : byExact };
}

export function seriesOf(ctx: Ctx): Series {
  const { cur, prev, basis } = ctx;
  const unit = unitFor(cur.period.days);
  const buckets = bucketsOf(cur.period, unit);
  const prevBuckets = prev ? bucketsOf(prev.period, unit) : [];
  const useBillable = basis === 'billable' && unit !== 'hour';
  const daily = ctx.snapshot.settings.dailyTargetHours;
  const weekly = ctx.snapshot.settings.weeklyTargetHours;
  const points: SeriesPoint[] = buckets.map((b, i) => {
    const v = pointOf(cur, b, unit, basis, ctx.billableAvailable);
    const pb = prevBuckets[i];
    const pv = prev && pb ? pointOf(prev, pb, unit, basis, ctx.billableAvailable) : null;
    const len = b.toDay - b.fromDay + 1;
    let target: number | null = null;
    if (unit === 'day' && daily) target = daily * 3600;
    else if ((unit === 'week' || unit === 'month') && weekly) target = (weekly * 3600 * len) / 7;
    return {
      ...b,
      exact: v.exact,
      billable: v.billable,
      secs: useBillable ? v.billable : v.exact,
      byProject: useBillable ? v.byBillable : v.byExact,
      prev: pv ? (useBillable ? pv.billable : pv.exact) : null,
      target,
    };
  });
  const markers: Marker[] = [];
  const zonesSeen = new Set<string>();
  for (const zone of [ctx.zones.active, ctx.zones.client]) {
    if (!zone || zonesSeen.has(zone)) continue;
    zonesSeen.add(zone);
    for (const change of shiftsBetween(cur.period.from, cur.period.to, zone)) {
      const d = dayOfInstant(change.at, ctx.zones.active);
      let index = buckets.findIndex((b) => d >= b.fromDay && d <= b.toDay);
      if (unit === 'hour') index = Math.floor(((((change.at + offsetAt(change.at, ctx.zones.active)) % 86400) + 86400) % 86400) / 3600);
      if (index >= 0) markers.push({ index, text: shiftText(change), zone });
    }
  }
  return {
    unit,
    points,
    markers,
    maxSecs: Math.max(0, ...points.map((p) => Math.max(p.secs, p.prev ?? 0, p.target ?? 0))),
    note: unit === 'hour' ? 'Hour buckets show Exact time.' : null,
  };
}

// ------------------------------------------------------------------ time of day

export interface TimeOfDay {
  bands: { band: number; name: string; secs: number; share: number | null; avgPerActiveDay: number | null; byProject: Map<string, number> }[];
  mostBand: number | null;
  leastBand: number | null;
  hours: { secs: number[]; avgPerActiveDay: (number | null)[]; byProject: Map<string, number[]>; peak: number | null };
  heat: { cells: number[]; max: number };
  weekdays: { index: number; name: string; secs: number; occurrences: number; avgSecs: number | null }[];
  mostWeekday: number | null;
  leastWeekday: number | null;
  calendar: { year: number; days: { day: string; dayNum: number; secs: number }[]; max: number };
}

export function timeOfDayOf(ctx: Ctx): TimeOfDay {
  const { cur } = ctx;
  const total = cur.agg.total;
  const active = activeDayNums(cur).length;
  const bandSecs = [0, 0, 0, 0];
  const bandBy: Map<string, number>[] = [new Map(), new Map(), new Map(), new Map()];
  for (const [p, arr] of cur.agg.band) {
    arr.forEach((v, b) => {
      bandSecs[b] = (bandSecs[b] as number) + v;
      if (v > 0) (bandBy[b] as Map<string, number>).set(p, v);
    });
  }
  const hourSecs = new Array<number>(24).fill(0);
  for (const arr of cur.agg.hour.values()) arr.forEach((v, h) => (hourSecs[h] = (hourSecs[h] as number) + v));
  const wd = new Array<number>(7).fill(0);
  cur.agg.weekdayHour.forEach((v, i) => (wd[Math.floor(i / 24)] = (wd[Math.floor(i / 24)] as number) + v));
  const occ = new Array<number>(7).fill(0);
  const first = dayNum(cur.period.fromDay);
  for (let n = first; n <= Math.min(dayNum(cur.period.toDay), ctx.today); n += 1) occ[weekdayIndex(n)] = (occ[weekdayIndex(n)] as number) + 1;
  const withData = wd.map((v, i) => ((occ[i] as number) > 0 ? v : 0));
  const year = Number(cur.period.toDay.slice(0, 4));
  const y0 = dayNum(`${year}-01-01`);
  const y1 = dayNum(`${year}-12-31`);
  const days: { day: string; dayNum: number; secs: number }[] = [];
  let max = 0;
  for (let n = y0; n <= y1; n += 1) {
    const secs = cur.dayTotals.get(n) ?? 0;
    max = Math.max(max, secs);
    days.push({ day: dayStr(n), dayNum: n, secs });
  }
  return {
    bands: BANDS.map((name, band) => ({
      band,
      name,
      secs: bandSecs[band] as number,
      share: ratio(bandSecs[band] as number, total),
      avgPerActiveDay: active > 0 ? (bandSecs[band] as number) / active : null,
      byProject: bandBy[band] as Map<string, number>,
    })),
    mostBand: total > 0 ? argMax(bandSecs) : null,
    leastBand: total > 0 ? argMin(bandSecs) : null,
    hours: {
      secs: hourSecs,
      avgPerActiveDay: hourSecs.map((v) => (active > 0 ? v / active : null)),
      byProject: cur.agg.hour,
      peak: total > 0 ? argMax(hourSecs) : null,
    },
    heat: { cells: cur.agg.weekdayHour, max: Math.max(0, ...cur.agg.weekdayHour) },
    weekdays: WEEKDAY_NAMES.map((name, index) => ({ index, name, secs: wd[index] as number, occurrences: occ[index] as number, avgSecs: (occ[index] as number) > 0 ? (wd[index] as number) / (occ[index] as number) : null })),
    mostWeekday: total > 0 ? argMax(withData) : null,
    leastWeekday: total > 0 && occ.some((o) => o > 0) ? argMin(withData.map((v, i) => ((occ[i] as number) > 0 ? v : Number.POSITIVE_INFINITY))) : null,
    calendar: { year, days, max },
  };
}
