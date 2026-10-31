// Shared context for the metric families.
import type { RateBook, TaskDay } from '../../lib/billing';
import type { Project, Snapshot, Task } from '../../lib/types';
import type { Dataset, Params } from './engine';
import { dayNum } from './range';

export type Basis = 'billable' | 'exact';

export interface Ctx {
  snapshot: Snapshot;
  params: Params;
  /** The basis actually used: billable falls back to exact when a band or shift filter is on. */
  basis: Basis;
  billableAvailable: boolean;
  cur: Dataset;
  prev: Dataset | null;
  nowSec: number;
  zones: { my: string; client: string | null; active: string };
  /** Local day number of "now" in the active zone. */
  today: number;
  projects: Map<string, Project>;
  tasks: Map<string, Task>;
  book: RateBook;
}

export interface RowIndex {
  byDay: Map<number, Map<string, number>>;
  byProject: Map<string, number>;
  byTask: Map<string, number>;
  /** Billable seconds of all rows. */
  total: number;
  /** Rounding adjustment (billable minus exact) per project. */
  adjByProject: Map<string, number>;
  days: Map<string, Set<number>>;
}

const cache = new WeakMap<readonly TaskDay[], RowIndex>();

export function rowIndex(rows: readonly TaskDay[]): RowIndex {
  const hit = cache.get(rows);
  if (hit) return hit;
  const idx: RowIndex = { byDay: new Map(), byProject: new Map(), byTask: new Map(), total: 0, adjByProject: new Map(), days: new Map() };
  const dayCache = new Map<string, number>();
  for (const r of rows) {
    let d = dayCache.get(r.day);
    if (d === undefined) dayCache.set(r.day, (d = dayNum(r.day)));
    let m = idx.byDay.get(d);
    if (!m) idx.byDay.set(d, (m = new Map()));
    m.set(r.projectId, (m.get(r.projectId) ?? 0) + r.billableSecs);
    idx.byProject.set(r.projectId, (idx.byProject.get(r.projectId) ?? 0) + r.billableSecs);
    idx.byTask.set(r.taskId, (idx.byTask.get(r.taskId) ?? 0) + r.billableSecs);
    idx.adjByProject.set(r.projectId, (idx.adjByProject.get(r.projectId) ?? 0) + r.billableSecs - r.exactSecs);
    idx.total += r.billableSecs;
    let set = idx.days.get(r.taskId);
    if (!set) idx.days.set(r.taskId, (set = new Set()));
    set.add(d);
  }
  cache.set(rows, idx);
  return idx;
}

export const exactTotal = (ds: Dataset): number => ds.agg.total;
export const billableTotal = (ds: Dataset): number => rowIndex(ds.rows).total;
export const totalOf = (ds: Dataset, basis: Basis): number => (basis === 'billable' ? billableTotal(ds) : exactTotal(ds));

export function activeDayNums(ds: Dataset): number[] {
  const out: number[] = [];
  for (const [d, a] of ds.agg.days) if (a.secs > 0) out.push(d);
  return out.sort((a, b) => a - b);
}

/** Period days that have started by now (the running day counts). */
export function elapsedDays(ds: Dataset, today: number): number {
  const first = dayNum(ds.period.fromDay);
  return Math.max(0, Math.min(ds.period.days, today - first + 1));
}
