// Orchestrates the metric families for one analysis request.
import { RateBook } from '../../lib/billing';
import { dayOfInstant, evaluate, hasTimeFilter, prepare, resolveZones, type Evaluated, type Params } from './engine';
import { consistencyOf, focusOf, type Consistency, type Focus } from './fam-focus';
import { budgetsOf, forecastOf, goalsOf, moneyOf, type BudgetBurn, type Forecast, type Goals, type Money } from './fam-goals';
import { projectsOf, tasksOf, type ProjectStat, type Tasks } from './fam-projects';
import { shiftsOf, zonesOf, type Shifts, type ZonesView } from './fam-shifts';
import { bucketsOf, seriesOf, timeOfDayOf, volumeOf, type Bucket, type Series, type TimeOfDay, type Volume } from './fam-volume';
import type { Basis, Ctx } from './mctx';
import { periodOf, previousRange, type Period } from './range';
import type { Snapshot } from '../../lib/types';

export type { Basis } from './mctx';

export interface Metrics {
  period: Period;
  prevPeriod: Period | null;
  zone: string;
  zones: Ctx['zones'];
  /** The basis in use; billable falls back to exact under a band or shift filter. */
  basis: Basis;
  requestedBasis: Basis;
  billableAvailable: boolean;
  /** True when any rounding rule is not "exact", so Billable can differ from Exact. */
  roundingActive: boolean;
  liveCount: number;
  hasData: boolean;
  volume: Volume;
  series: Series;
  /** Day-based buckets: the chart's own, or one per day when the chart is hourly. */
  dayBuckets: Bucket[];
  time: TimeOfDay;
  projects: ProjectStat[];
  tasks: Tasks;
  focus: Focus;
  consistency: Consistency;
  goals: Goals;
  budgets: BudgetBurn[];
  money: Money;
  forecast: Forecast;
  shifts: Shifts;
  zonesView: ZonesView;
}

function roundingIsActive(snapshot: Snapshot): boolean {
  const rows = snapshot.rounding.filter((r) => !r.deleted);
  return rows.length === 0 || rows.some((r) => r.incrementMinutes > 0);
}

export function computeMetrics(snapshot: Snapshot, params: Params, ev: Evaluated, nowSec: number, requested: Basis): Metrics {
  const z = resolveZones(snapshot);
  const billableAvailable = !hasTimeFilter(params.filters);
  const basis: Basis = billableAvailable ? requested : 'exact';
  const ctx: Ctx = {
    snapshot,
    params,
    basis,
    billableAvailable,
    cur: ev.cur,
    prev: ev.prev,
    nowSec,
    zones: { my: z.my, client: z.client, active: params.zone },
    today: dayOfInstant(nowSec, params.zone),
    projects: new Map(snapshot.projects.map((p) => [p.id, p])),
    tasks: new Map(snapshot.tasks.map((t) => [t.id, t])),
    book: new RateBook(snapshot.projects, snapshot.rates),
  };
  const volume = volumeOf(ctx);
  const series = seriesOf(ctx);
  const time = timeOfDayOf(ctx);
  const money = moneyOf(ctx, series);
  return {
    period: ev.cur.period,
    prevPeriod: ev.prev ? ev.prev.period : null,
    zone: params.zone,
    zones: ctx.zones,
    basis,
    requestedBasis: requested,
    billableAvailable,
    roundingActive: roundingIsActive(snapshot),
    liveCount: ev.cur.liveCount,
    hasData: ev.cur.agg.total > 0,
    volume,
    series,
    dayBuckets: series.unit === 'hour' ? bucketsOf(ev.cur.period, 'day') : series.points,
    time,
    projects: projectsOf(ctx),
    tasks: tasksOf(ctx),
    focus: focusOf(ctx),
    consistency: consistencyOf(
      ctx,
      time.weekdays.map((w) => w.avgSecs),
    ),
    goals: goalsOf(ctx),
    budgets: budgetsOf(ctx),
    money,
    forecast: forecastOf(ctx, volume.primary),
    shifts: shiftsOf(ctx),
    zonesView: zonesOf(ctx),
  };
}

/** Prepare (memoised on the snapshot), add the live delta and compute every metric. */
export function analyze(snapshot: Snapshot, params: Params, nowSec: number, basis: Basis = 'billable'): Metrics {
  const ev = evaluate(prepare(snapshot, params), nowSec);
  return computeMetrics(snapshot, params, ev, nowSec, basis);
}

export { periodOf, previousRange };
