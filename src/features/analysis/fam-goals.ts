// Goals, budgets, money and the period forecast. All optional: each reports `configured` so the
// screen can invite the user to set them up instead of showing empty numbers.
import { centsFromNumerator, exactNumeratorsOf, numeratorsOf, type Numerators } from '../../lib/billing';
import { budgetDaily, liveDaily } from './engine';
import { activeDayNums, rowIndex, type Ctx } from './mctx';
import { bucketsOf, type Bucket, type Series } from './fam-volume';
import { dayNum, weekdayIndex } from './range';
import { ratio } from './stats';
import type { Currency } from '../../lib/types';

export interface Goals {
  daily: { target: number; refDay: number; secs: number; attainment: number; daysReached: number; daysCounted: number } | null;
  weekly: { target: number; weekStart: number; secs: number; attainment: number; weeks: { start: number; secs: number; attainment: number }[] } | null;
  configured: boolean;
}

export function goalsOf(ctx: Ctx): Goals {
  const { cur } = ctx;
  const s = ctx.snapshot.settings;
  const first = dayNum(cur.period.fromDay);
  const last = dayNum(cur.period.toDay);
  const ref = Math.min(last, ctx.today);
  const at = (n: number): number => cur.dayTotals.get(n) ?? 0;
  let daily: Goals['daily'] = null;
  if (s.dailyTargetHours && s.dailyTargetHours > 0) {
    const target = s.dailyTargetHours * 3600;
    let reached = 0;
    let counted = 0;
    for (let n = first; n <= Math.min(last, ctx.today); n += 1) {
      counted += 1;
      if (at(n) >= target) reached += 1;
    }
    daily = { target, refDay: ref, secs: at(ref), attainment: at(ref) / target, daysReached: reached, daysCounted: counted };
  }
  let weekly: Goals['weekly'] = null;
  if (s.weeklyTargetHours && s.weeklyTargetHours > 0) {
    const target = s.weeklyTargetHours * 3600;
    const weekOf = (n: number): number => n - weekdayIndex(n);
    const sumWeek = (start: number): number => {
      let t = 0;
      for (let i = 0; i < 7; i += 1) t += at(start + i);
      return t;
    };
    const weeks: { start: number; secs: number; attainment: number }[] = [];
    for (let w = weekOf(first); w <= weekOf(Math.min(last, ctx.today)); w += 7) weeks.push({ start: w, secs: sumWeek(w), attainment: sumWeek(w) / target });
    const start = weekOf(ref);
    weekly = { target, weekStart: start, secs: sumWeek(start), attainment: sumWeek(start) / target, weeks: weeks.slice(-12) };
  }
  return { daily, weekly, configured: daily !== null || weekly !== null };
}

// ------------------------------------------------------------------ budgets

export interface BudgetBurn {
  projectId: string;
  name: string;
  color: string;
  budgetSecs: number;
  loggedSecs: number;
  fraction: number;
  remainingSecs: number;
  /** Seconds per day over the last 28 days, today included. */
  pace: number | null;
  projectedFinish: number | null;
  state: 'over' | 'projected' | 'no-pace' | 'far';
  series: { dayNum: number; cum: number }[];
}

export const PACE_DAYS = 28;
const FAR_DAYS = 3650;

export function budgetsOf(ctx: Ctx): BudgetBurn[] {
  const proj = ctx.params.filters.projectIds.length ? new Set(ctx.params.filters.projectIds) : null;
  const closed = budgetDaily(ctx.snapshot, ctx.zones.active);
  const live = liveDaily(ctx.snapshot, ctx.zones.active, ctx.nowSec);
  const out: BudgetBurn[] = [];
  for (const p of ctx.snapshot.projects) {
    if (p.budgetHours === null || p.archived || (proj && !proj.has(p.id))) continue;
    const days = new Map(closed.get(p.id) ?? []);
    for (const [d, v] of live.get(p.id) ?? []) days.set(d, (days.get(d) ?? 0) + v);
    const keys = [...days.keys()].sort((a, b) => a - b);
    const budget = p.budgetHours * 3600;
    const series: { dayNum: number; cum: number }[] = [];
    let cum = 0;
    let recent = 0;
    for (const k of keys) {
      cum += days.get(k) as number;
      if (k > ctx.today - PACE_DAYS) recent += days.get(k) as number;
    }
    if (keys.length) {
      let acc = 0;
      const lastDay = Math.max(ctx.today, keys[keys.length - 1] as number);
      for (let n = keys[0] as number; n <= lastDay; n += 1) {
        acc += days.get(n) ?? 0;
        series.push({ dayNum: n, cum: acc });
      }
    }
    const pace = keys.length ? recent / PACE_DAYS : null;
    const remaining = budget - cum;
    let state: BudgetBurn['state'];
    let finish: number | null = null;
    if (remaining <= 0) state = 'over';
    else if (!pace || pace <= 0) state = 'no-pace';
    else {
      const need = Math.ceil(remaining / pace);
      if (need > FAR_DAYS) state = 'far';
      else {
        state = 'projected';
        finish = ctx.today + need;
      }
    }
    out.push({ projectId: p.id, name: p.name, color: p.color, budgetSecs: budget, loggedSecs: cum, fraction: budget > 0 ? cum / budget : 0, remainingSecs: remaining, pace, projectedFinish: finish, state, series });
  }
  return out.sort((a, b) => b.fraction - a.fraction);
}

// ------------------------------------------------------------------ money

export interface EarningsPoint {
  key: string;
  label: string;
  numerator: number;
  byProject: Map<string, number>;
}

export interface Money {
  available: boolean;
  numerators: Numerators;
  exactNumerators: Numerators;
  /** Rounding effect on money: billable minus exact numerators. */
  roundingMoney: Numerators;
  roundingSecs: number;
  roundingByProject: Map<string, number>;
  billableFlagSecs: number;
  nonBillableSecs: number;
  billableShare: number | null;
  /** Cents per exact hour, from the time that earned in that currency. */
  hourlyCents: Partial<Record<Currency, number>>;
  earnings: Partial<Record<Currency, EarningsPoint[]>>;
  byProject: Map<string, Numerators>;
  missingRate: string[];
  /** Buckets the earnings and flag series are laid out in: the chart's, or one per day for a single day. */
  buckets: Bucket[];
  flagSeries: { key: string; label: string; billable: number; nonBillable: number }[];
}

export function centsOf(numerator: number): number {
  return centsFromNumerator(numerator);
}

export function moneyOf(ctx: Ctx, series: Series): Money {
  const { cur } = ctx;
  const empty: Money = {
    available: false,
    numerators: {},
    exactNumerators: {},
    roundingMoney: {},
    roundingSecs: 0,
    roundingByProject: new Map(),
    billableFlagSecs: 0,
    nonBillableSecs: 0,
    billableShare: null,
    hourlyCents: {},
    earnings: {},
    byProject: new Map(),
    missingRate: [],
    buckets: [],
    flagSeries: [],
  };
  if (!ctx.billableAvailable) return empty;
  const idx = rowIndex(cur.rows);
  const numerators = numeratorsOf(cur.rows);
  const exactNumerators = exactNumeratorsOf(cur.rows);
  const roundingMoney: Numerators = {};
  for (const c of ['EUR', 'USD'] as const) {
    if (numerators[c] !== undefined) roundingMoney[c] = (numerators[c] as number) - (exactNumerators[c] as number);
  }
  // Hour buckets have no Billable figure, so a single day is laid out as one bucket.
  const buckets: Bucket[] = series.unit === 'hour' ? bucketsOf(cur.period, 'day') : series.points;
  const bucketOf = new Map<number, number>();
  buckets.forEach((p, i) => {
    for (let n = p.fromDay; n <= p.toDay; n += 1) bucketOf.set(n, i);
  });
  const earnings: Partial<Record<Currency, EarningsPoint[]>> = {};
  const byProject = new Map<string, Numerators>();
  const exactSecs: Partial<Record<Currency, number>> = {};
  const dayCache = new Map<string, number>();
  const flag = buckets.map(() => ({ billable: 0, nonBillable: 0 }));
  let flagged = 0;
  let nonFlagged = 0;
  const billableOf = new Map<string, boolean>(ctx.snapshot.projects.map((p) => [p.id, p.billable]));
  for (const r of cur.rows) {
    let n = dayCache.get(r.day);
    if (n === undefined) dayCache.set(r.day, (n = dayNum(r.day)));
    const bi = bucketOf.get(n);
    const isB = billableOf.get(r.projectId) === true;
    if (isB) flagged += r.billableSecs;
    else nonFlagged += r.billableSecs;
    if (bi !== undefined) {
      const f = flag[bi] as { billable: number; nonBillable: number };
      if (isB) f.billable += r.billableSecs;
      else f.nonBillable += r.billableSecs;
    }
    for (const b of r.buckets) {
      if (b.rateCents === null || !b.currency) continue;
      const num = b.rateCents * b.billableSecs;
      exactSecs[b.currency] = (exactSecs[b.currency] ?? 0) + b.exactSecs;
      const pn = byProject.get(r.projectId) ?? {};
      pn[b.currency] = (pn[b.currency] ?? 0) + num;
      byProject.set(r.projectId, pn);
      if (bi === undefined) continue;
      let list = earnings[b.currency];
      if (!list) {
        list = buckets.map((p) => ({ key: p.key, label: p.label, numerator: 0, byProject: new Map<string, number>() }));
        earnings[b.currency] = list;
      }
      const pt = list[bi] as EarningsPoint;
      pt.numerator += num;
      pt.byProject.set(r.projectId, (pt.byProject.get(r.projectId) ?? 0) + num);
    }
  }
  const hourlyCents: Partial<Record<Currency, number>> = {};
  for (const c of ['EUR', 'USD'] as const) {
    const es = exactSecs[c];
    const num = numerators[c];
    if (es && num !== undefined) hourlyCents[c] = Math.floor((2 * num + es) / (2 * es));
  }
  const missing: string[] = [];
  for (const [id, secs] of cur.agg.byProject) {
    const p = ctx.projects.get(id);
    if (p?.billable && secs > 0 && !byProject.has(id)) missing.push(id);
  }
  let adj = 0;
  for (const v of idx.adjByProject.values()) adj += v;
  return {
    available: true,
    numerators,
    exactNumerators,
    roundingMoney,
    roundingSecs: adj,
    roundingByProject: idx.adjByProject,
    billableFlagSecs: flagged,
    nonBillableSecs: nonFlagged,
    billableShare: ratio(flagged, flagged + nonFlagged),
    hourlyCents,
    earnings,
    byProject,
    missingRate: missing,
    buckets,
    flagSeries: buckets.map((p, i) => ({ key: p.key, label: p.label, ...(flag[i] as { billable: number; nonBillable: number }) })),
  };
}

// ------------------------------------------------------------------ forecast

export interface Forecast {
  available: boolean;
  reason: string | null;
  logged: number;
  projected: number | null;
  elapsedFraction: number | null;
  basisText: string | null;
  target: number | null;
}

export function forecastOf(ctx: Ctx, logged: number): Forecast {
  const { cur } = ctx;
  const none = (reason: string): Forecast => ({ available: false, reason, logged, projected: null, elapsedFraction: null, basisText: null, target: null });
  if (cur.period.days < 7) return none('Projections need a period of at least 7 days.');
  if (ctx.nowSec < cur.period.from) return none('This period has not started.');
  if (ctx.nowSec >= cur.period.to) return none('This period is over.');
  const fraction = (ctx.nowSec - cur.period.from) / (cur.period.to - cur.period.from);
  const active = activeDayNums(cur).length;
  if (active < 2 || fraction < 0.2) return none('Not enough data');
  const projected = logged / fraction;
  const weekly = ctx.snapshot.settings.weeklyTargetHours;
  return {
    available: true,
    reason: null,
    logged,
    projected,
    elapsedFraction: fraction,
    basisText: `${(logged / 3600).toFixed(1)} h logged over ${(fraction * 100).toFixed(0)}% of the period (${active} active days), extended linearly`,
    target: weekly ? (weekly * 3600 * cur.period.days) / 7 : null,
  };
}
