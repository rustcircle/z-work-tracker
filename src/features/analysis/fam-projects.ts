// Project and task metrics. Totals follow the chosen basis (Billable rows or Exact time).
import { parseIso } from '../../lib/tz';
import { taskFirstStarts } from './engine';
import { rowIndex, type Ctx } from './mctx';
import { delta, mean, median, ratio, type Delta } from './stats';

export interface ProjectStat {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  billable: boolean;
  exact: number;
  billableSecs: number;
  /** For the chosen basis. */
  secs: number;
  share: number | null;
  prevSecs: number | null;
  delta: Delta | null;
  taskCount: number;
  avgPerTask: number | null;
  rank: number;
  /** 'none' means a billable hourly project with no rate: shown as "No rate set", never as zero. 'fixed' is a fixed-fee project, which earns its fee, not an hourly rate. */
  rate: 'set' | 'none' | 'fixed' | 'not-billable';
  adjSecs: number;
}

export function projectsOf(ctx: Ctx): ProjectStat[] {
  const { cur, prev, basis } = ctx;
  const idx = rowIndex(cur.rows);
  const pIdx = prev ? rowIndex(prev.rows) : null;
  const useBill = basis === 'billable' && ctx.billableAvailable;
  const ids = new Set<string>([...cur.agg.byProject.keys()]);
  const taskCount = new Map<string, number>();
  for (const t of cur.agg.byTask.keys()) {
    const task = ctx.tasks.get(t);
    if (task) taskCount.set(task.projectId, (taskCount.get(task.projectId) ?? 0) + 1);
  }
  const pick = (exactMap: Map<string, number>, billMap: Map<string, number> | undefined, id: string): number =>
    useBill ? (billMap?.get(id) ?? 0) : (exactMap.get(id) ?? 0);
  const total = [...ids].reduce((n, id) => n + pick(cur.agg.byProject, idx.byProject, id), 0);
  const refSec = Math.min(ctx.nowSec, cur.period.to - 1);
  const list: ProjectStat[] = [];
  for (const id of ids) {
    const p = ctx.projects.get(id);
    if (!p) continue;
    const secs = pick(cur.agg.byProject, idx.byProject, id);
    const prevSecs = prev && pIdx ? pick(prev.agg.byProject, pIdx.byProject, id) : null;
    const tc = taskCount.get(id) ?? 0;
    list.push({
      id,
      name: p.name,
      color: p.color,
      archived: p.archived,
      billable: p.billable,
      exact: cur.agg.byProject.get(id) ?? 0,
      billableSecs: ctx.billableAvailable ? (idx.byProject.get(id) ?? 0) : (cur.agg.byProject.get(id) ?? 0),
      secs,
      share: ratio(secs, total),
      prevSecs,
      delta: delta(secs, prevSecs),
      taskCount: tc,
      avgPerTask: tc > 0 ? secs / tc : null,
      rank: 0,
      rate: !p.billable ? 'not-billable' : p.billingType === 'fixedFee' ? 'fixed' : ctx.book.at(id, refSec).rateCents === null ? 'none' : 'set',
      adjSecs: idx.adjByProject.get(id) ?? 0,
    });
  }
  list.sort((a, b) => b.secs - a.secs || a.name.localeCompare(b.name));
  list.forEach((p, i) => (p.rank = i + 1));
  return list;
}

export interface TaskStat {
  id: string;
  name: string;
  projectId: string;
  exact: number;
  billableSecs: number;
  secs: number;
  /** Distinct days with time in the period, in the active zone. */
  days: number;
  state: string;
  firstStart: number | null;
  stoppedAt: number | null;
  /** First start to stop, for tasks stopped in the period. */
  ageSecs: number | null;
}

export interface Tasks {
  completed: number;
  inProgress: number;
  withTime: number;
  avg: number | null;
  median: number | null;
  longest: TaskStat | null;
  ageAvg: number | null;
  ageMedian: number | null;
  ageLongest: number | null;
  multiDay: number;
  top: TaskStat[];
  list: TaskStat[];
}

export function tasksOf(ctx: Ctx): Tasks {
  const { cur } = ctx;
  const idx = rowIndex(cur.rows);
  const firsts = taskFirstStarts(ctx.snapshot);
  const f = ctx.params.filters;
  const proj = f.projectIds.length ? new Set(f.projectIds) : null;
  const only = f.taskIds.length ? new Set(f.taskIds) : null;
  const useBill = ctx.basis === 'billable' && ctx.billableAvailable;
  const list: TaskStat[] = [];
  for (const [id, exact] of cur.agg.byTask) {
    const t = ctx.tasks.get(id);
    if (!t) continue;
    const billableSecs = ctx.billableAvailable ? (idx.byTask.get(id) ?? 0) : exact;
    list.push({
      id,
      name: t.name,
      projectId: t.projectId,
      exact,
      billableSecs,
      secs: useBill ? billableSecs : exact,
      days: idx.days.get(id)?.size ?? 0,
      state: t.state,
      firstStart: firsts.get(id) ?? null,
      stoppedAt: t.stoppedAt ? parseIso(t.stoppedAt) : null,
      ageSecs: null,
    });
  }
  list.sort((a, b) => b.secs - a.secs || a.name.localeCompare(b.name));
  const byId = new Map(list.map((t) => [t.id, t]));
  const ages: number[] = [];
  let completed = 0;
  for (const t of ctx.snapshot.tasks) {
    if (t.state !== 'stopped' || !t.stoppedAt) continue;
    if (proj && !proj.has(t.projectId)) continue;
    if (only && !only.has(t.id)) continue;
    const stop = parseIso(t.stoppedAt);
    if (stop < cur.period.from || stop >= cur.period.to) continue;
    completed += 1;
    const first = firsts.get(t.id);
    if (first !== undefined && stop >= first) {
      const age = stop - first;
      ages.push(age);
      const stat = byId.get(t.id);
      if (stat) stat.ageSecs = age;
    }
  }
  const secs = list.map((t) => t.exact);
  return {
    completed,
    inProgress: list.filter((t) => t.state === 'running' || t.state === 'paused').length,
    withTime: list.length,
    avg: mean(secs),
    median: median(secs),
    longest: list.reduce<TaskStat | null>((best, t) => (!best || t.exact > best.exact ? t : best), null),
    ageAvg: mean(ages),
    ageMedian: median(ages),
    ageLongest: ages.length ? Math.max(...ages) : null,
    multiDay: list.filter((t) => t.days >= 2).length,
    top: list.slice(0, 10),
    list,
  };
}
