// Phase 2 metrics: billable pauses, thinking and unconfirmed time, time by tag, fixed fees and budget status.
// Pauses and thinking come from the task-day rows (a billable pause is in no aggregate of worked time);
// tags, fixed fees and budgets come from the tasks and projects themselves.
import { MASK } from '../../lib/billing';
import { projectsAt } from '../../lib/liveFigures';
import { parseIso } from '../../lib/tz';
import type { BudgetStatus, Currency, Tag } from '../../lib/types';
import { bucketsOf, type Bucket, type Series } from './fam-volume';
import { rowIndex, type Ctx } from './mctx';
import { dayNum } from './range';
import { delta, ratio, type Delta } from './stats';
import { taskPassesTagFilter } from './tagFilter';
import type { TaskStat } from './fam-projects';

// ------------------------------------------------------------------ pauses, thinking, unconfirmed

export interface PiecePoint extends Bucket {
  pause: number;
  thinking: number;
}

export interface Pieces {
  /** Billable pause time in the period. Part of Billable, never of Exact. */
  pauseSecs: number;
  /** Time away that was kept as thinking. Part of Exact and Billable. */
  thinkingSecs: number;
  prevPauseSecs: number | null;
  prevThinkingSecs: number | null;
  /** False under a band or shift filter: pauses belong to Billable, which is off there. */
  pausesShown: boolean;
  pauseByProject: Map<string, number>;
  thinkingByProject: Map<string, number>;
  series: PiecePoint[];
  unconfirmed: { secs: number; count: number; shown: boolean };
  pauseDelta: Delta | null;
  thinkingDelta: Delta | null;
}

function sumRows(ds: Ctx['cur']): { pause: number; thinking: number; byPause: Map<string, number>; byThinking: Map<string, number>; byDay: Map<number, { pause: number; thinking: number }> } {
  let pause = 0;
  let thinking = 0;
  const byPause = new Map<string, number>();
  const byThinking = new Map<string, number>();
  const byDay = new Map<number, { pause: number; thinking: number }>();
  const dayCache = new Map<string, number>();
  for (const r of ds.rows) {
    if (r.pauseSecs === 0 && r.thinkingSecs === 0) continue;
    let n = dayCache.get(r.day);
    if (n === undefined) dayCache.set(r.day, (n = dayNum(r.day)));
    const d = byDay.get(n) ?? { pause: 0, thinking: 0 };
    d.pause += r.pauseSecs;
    d.thinking += r.thinkingSecs;
    byDay.set(n, d);
    pause += r.pauseSecs;
    thinking += r.thinkingSecs;
    if (r.pauseSecs > 0) byPause.set(r.projectId, (byPause.get(r.projectId) ?? 0) + r.pauseSecs);
    if (r.thinkingSecs > 0) byThinking.set(r.projectId, (byThinking.get(r.projectId) ?? 0) + r.thinkingSecs);
  }
  return { pause, thinking, byPause, byThinking, byDay };
}

const liveTagSets = new WeakMap<Ctx['snapshot'], ReadonlySet<string>>();
/** The ids of the tags that exist, worked out once per snapshot. */
function liveTagSet(ctx: Ctx): ReadonlySet<string> {
  let live = liveTagSets.get(ctx.snapshot);
  if (!live) liveTagSets.set(ctx.snapshot, (live = new Set(ctx.snapshot.tags.filter((t) => !t.deleted).map((t) => t.id))));
  return live;
}

/** Whether a task passes the project, task and tag filters (the band and shift filters cut time, not tasks). */
export function taskPasses(ctx: Ctx, taskId: string): boolean {
  const f = ctx.params.filters;
  const t = ctx.tasks.get(taskId);
  if (!t) return false;
  if (f.projectIds.length && !f.projectIds.includes(t.projectId)) return false;
  if (f.taskIds.length && !f.taskIds.includes(t.id)) return false;
  if (f.tagIds.length && !taskPassesTagFilter(t.tags, f.tagIds, liveTagSet(ctx))) return false;
  return true;
}

export function piecesOf(ctx: Ctx, series: Series): Pieces {
  const { cur, prev } = ctx;
  const now = sumRows(cur);
  const before = prev ? sumRows(prev) : null;
  const buckets: Bucket[] = series.unit === 'hour' ? bucketsOf(cur.period, 'day') : series.points;
  const points: PiecePoint[] = buckets.map((b) => {
    let pause = 0;
    let thinking = 0;
    for (let n = b.fromDay; n <= b.toDay; n += 1) {
      const d = now.byDay.get(n);
      if (d) {
        pause += d.pause;
        thinking += d.thinking;
      }
    }
    return { key: b.key, label: b.label, fromDay: b.fromDay, toDay: b.toDay, pause, thinking };
  });
  // Unconfirmed time sits in no piece. It is the pending away time whose stretch overlaps the period.
  let unconfirmedSecs = 0;
  let unconfirmedCount = 0;
  for (const g of ctx.snapshot.gaps) {
    if (g.decision !== 'pending' || !taskPasses(ctx, g.taskId)) continue;
    const secs = Math.min(parseIso(g.end), cur.period.to) - Math.max(parseIso(g.start), cur.period.from);
    if (secs > 0) {
      unconfirmedSecs += secs;
      unconfirmedCount += 1;
    }
  }
  const pausesShown = ctx.billableAvailable;
  return {
    pauseSecs: now.pause,
    thinkingSecs: now.thinking,
    prevPauseSecs: before ? before.pause : null,
    prevThinkingSecs: before ? before.thinking : null,
    pausesShown,
    pauseByProject: now.byPause,
    thinkingByProject: now.byThinking,
    series: points,
    unconfirmed: { secs: unconfirmedSecs, count: unconfirmedCount, shown: ctx.billableAvailable },
    pauseDelta: pausesShown && before ? delta(now.pause, before.pause) : null,
    thinkingDelta: before ? delta(now.thinking, before.thinking) : null,
  };
}

// ------------------------------------------------------------------ time by tag

export interface TagStat {
  /** The tag's id, or null for the row of tasks with no tag. */
  id: string | null;
  name: string;
  color: string;
  /** For the chosen basis. A task with several tags counts fully in each, so rows overlap. */
  secs: number;
  exact: number;
  billableSecs: number;
  taskCount: number;
  /** `secs` over the total time of all tasks with time. Shares of different tags overlap and can exceed 100% together. */
  share: number | null;
  prevSecs: number | null;
  delta: Delta | null;
}

export interface TagsView {
  /** Tags with time in the period, largest first. */
  stats: TagStat[];
  /** Time on tasks that carry no tag. Not a tag. */
  untagged: TagStat | null;
  /** Total time of the tasks counted, each task once: the denominator of every share. */
  total: number;
  /** The snapshot has at least one tag. */
  anyTags: boolean;
  /** Tasks with time that carry two or more tags: they sit in several rows. */
  multiTagTasks: number;
}

export const UNTAGGED_COLOR = '#6b7280';

export function tagsOf(ctx: Ctx, tasks: readonly TaskStat[]): TagsView {
  const live = new Map<string, Tag>(ctx.snapshot.tags.filter((t) => !t.deleted).map((t) => [t.id, t]));
  const useBill = ctx.basis === 'billable' && ctx.billableAvailable;
  const idx = ctx.prev ? rowIndex(ctx.prev.rows) : null;
  const prevOf = (taskId: string): number => (!ctx.prev || !idx ? 0 : useBill ? (idx.byTask.get(taskId) ?? 0) : (ctx.prev.agg.byTask.get(taskId) ?? 0));
  const by = new Map<string | null, TagStat>();
  const row = (id: string | null, name: string, color: string): TagStat => {
    let r = by.get(id);
    if (!r) {
      r = { id, name, color, secs: 0, exact: 0, billableSecs: 0, taskCount: 0, share: null, prevSecs: ctx.prev ? 0 : null, delta: null };
      by.set(id, r);
    }
    return r;
  };
  let total = 0;
  let multi = 0;
  for (const t of tasks) {
    total += t.secs;
    const task = ctx.tasks.get(t.id);
    const tags = (task?.tags ?? []).map((id) => live.get(id)).filter((x): x is Tag => x !== undefined);
    if (tags.length > 1) multi += 1;
    const targets = tags.length ? tags.map((g) => row(g.id, g.name, g.color)) : [row(null, 'No tag', UNTAGGED_COLOR)];
    for (const r of targets) {
      r.secs += t.secs;
      r.exact += t.exact;
      r.billableSecs += t.billableSecs;
      r.taskCount += 1;
      if (r.prevSecs !== null) r.prevSecs += prevOf(t.id);
    }
  }
  const all = [...by.values()];
  for (const r of all) {
    r.share = ratio(r.secs, total);
    r.delta = delta(r.secs, r.prevSecs);
  }
  const order = (a: TagStat, b: TagStat): number => b.secs - a.secs || a.name.localeCompare(b.name);
  return {
    stats: all.filter((r) => r.id !== null).sort(order),
    untagged: by.get(null) ?? null,
    total,
    anyTags: live.size > 0,
    multiTagTasks: multi,
  };
}

// ------------------------------------------------------------------ fixed fee and budget status

export interface FixedFeeStat {
  projectId: string;
  name: string;
  color: string;
  archived: boolean;
  feeCents: number | null;
  currency: Currency | null;
  /** Fee over all billable hours of the project, cents per hour. Null before any billable time. */
  effectiveHourlyCents: number | null;
  /** All-time figures from the project, for the hours the rate is measured over. */
  billableSecs: number;
  exactSecs: number;
  pauseSecs: number;
}

export function fixedFeeOf(ctx: Ctx): FixedFeeStat[] {
  const proj = ctx.params.filters.projectIds.length ? new Set(ctx.params.filters.projectIds) : null;
  const out: FixedFeeStat[] = [];
  for (const p of projectsAt(ctx.snapshot, ctx.nowSec)) {
    if (p.billingType !== 'fixedFee' || (proj && !proj.has(p.id))) continue;
    const used = (ctx.cur.agg.byProject.get(p.id) ?? 0) > 0;
    if (p.archived && !used) continue;
    out.push({
      projectId: p.id,
      name: p.name,
      color: p.color,
      archived: p.archived,
      feeCents: p.fixedFeeCents,
      currency: p.feeCurrency,
      effectiveHourlyCents: p.figures.effectiveHourlyCents,
      billableSecs: p.figures.billableSecs,
      exactSecs: p.figures.exactSecs,
      pauseSecs: p.figures.pauseSecs,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface BudgetAlert extends BudgetStatus {
  projectId: string;
  name: string;
  color: string;
  billingType: 'hourly' | 'fixedFee';
  budgetHours: number | null;
  feeCents: number | null;
  currency: Currency | null;
}

/**
 * The percent of a budget used, as text. The percent of a fixed fee is money (time at the rates against the fee),
 * so it hides with the fee while earnings are hidden, as it does on the Projects tab. A percent of hours is not money.
 */
export const budgetPercentText = (hide: boolean, b: Pick<BudgetStatus, 'basis' | 'percent'>): string => (hide && b.basis === 'fee' ? MASK : `${b.percent}%`);

/** Budget status as the project reports it: 80% warns, 100% is over. All-time, so no date range applies. */
export function budgetAlertsOf(ctx: Ctx): BudgetAlert[] {
  const proj = ctx.params.filters.projectIds.length ? new Set(ctx.params.filters.projectIds) : null;
  const out: BudgetAlert[] = [];
  for (const p of projectsAt(ctx.snapshot, ctx.nowSec)) {
    const b = p.figures.budget;
    if (!b || p.archived || (proj && !proj.has(p.id))) continue;
    out.push({ ...b, projectId: p.id, name: p.name, color: p.color, billingType: p.billingType, budgetHours: p.budgetHours, feeCents: p.fixedFeeCents, currency: p.feeCurrency });
  }
  // Over first, then warnings, then by how far along; a budget that can't be measured goes last.
  return out.sort((a, b) => Number(a.needsTargetRate) - Number(b.needsTargetRate) || b.level - a.level || b.percent - a.percent || a.name.localeCompare(b.name));
}
