// Derived rounding and earnings, matching `z-work-core`'s billing.rs. Pinned on both sides by
// fixtures/billing-fixtures.json. Nothing here is stored.
// Rules: a row is one task on one day in the zone. Its exact time is rounded once; larger totals
// are sums of rows. Earnings keep the exact numerator (rate cents x seconds) and round half up to
// cents only at the total shown. Currencies are never added together. The rounding difference goes
// to the last rate in force that day, moving back to earlier buckets if it would go below zero.
import { addDays, dayOf, startOfDay } from './tz';
import type { Currency, PieceKind, Project, RateVersion, RoundMethod, RoundingVersion, Stamp } from './types';
import { parseIso } from './tz';

export const DEFAULT_INCREMENT_MINUTES = 15;
export const DEFAULT_METHOD: RoundMethod = 'up';

export function roundSeconds(exact: number, incrementMinutes: number, method: RoundMethod): number {
  if (incrementMinutes === 0) return exact;
  const inc = incrementMinutes * 60;
  const rem = exact % inc;
  const down = exact - rem;
  if (method === 'down') return down;
  if (method === 'up') return rem === 0 ? down : down + inc;
  return rem * 2 >= inc ? down + inc : down;
}

/** `round(numerator / 3600)` half up, exact for all safe integers. */
export function centsFromNumerator(numerator: number): number {
  const rem = numerator % 3600;
  const q = (numerator - rem) / 3600;
  return rem >= 1800 ? q + 1 : q;
}

export interface Rule {
  incrementMinutes: number;
  method: RoundMethod;
}

/** The order used by the Rust core: effective date, then the edit stamp, then the id. */
function compareStamped(a: { stamp: Stamp; id: string }, b: { stamp: Stamp; id: string }): number {
  if (a.stamp.at !== b.stamp.at) return a.stamp.at < b.stamp.at ? -1 : 1;
  if (a.stamp.by !== b.stamp.by) return a.stamp.by < b.stamp.by ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function newerVersion<T extends { effectiveFrom: string; stamp: Stamp; id: string }>(a: T, b: T): boolean {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom > b.effectiveFrom;
  return compareStamped(a, b) > 0;
}

export function ruleFor(rounding: readonly RoundingVersion[], projectId: string, day: string): Rule {
  let own: RoundingVersion | null = null;
  let global: RoundingVersion | null = null;
  for (const r of rounding) {
    if (r.deleted || r.effectiveFrom > day) continue;
    if (r.projectId === projectId) {
      if (!own || newerVersion(r, own)) own = r;
    } else if (r.projectId === null) {
      if (!global || newerVersion(r, global)) global = r;
    }
  }
  const chosen = own ?? global;
  return chosen
    ? { incrementMinutes: chosen.incrementMinutes, method: chosen.method }
    : { incrementMinutes: DEFAULT_INCREMENT_MINUTES, method: DEFAULT_METHOD };
}

export const isCurrency = (c: string): c is Currency => c === 'EUR' || c === 'USD';

interface CompiledRate {
  from: number;
  id: string;
  stamp: Stamp;
  rateCents: number | null;
  currency: Currency;
}

export class RateBook {
  private byProject = new Map<string, CompiledRate[]>();

  /** A project earns hourly money only when it is billable and hourly: a fixed-fee project earns its fee. */
  constructor(projects: readonly (Pick<Project, 'id' | 'billable'> & { billingType?: Project['billingType'] })[], rates: readonly RateVersion[]) {
    const billable = new Set(projects.filter((p) => p.billable && (p.billingType ?? 'hourly') === 'hourly').map((p) => p.id));
    for (const r of rates) {
      if (r.deleted || !isCurrency(r.currency) || !billable.has(r.projectId)) continue;
      const list = this.byProject.get(r.projectId) ?? [];
      list.push({ from: parseIso(r.effectiveFrom), id: r.id, stamp: r.stamp, rateCents: r.rateCents, currency: r.currency });
      this.byProject.set(r.projectId, list);
    }
    for (const list of this.byProject.values()) {
      list.sort((a, b) => a.from - b.from || compareStamped(a, b));
    }
  }

  /** The version in force at `sec`, or null when the project has no rate yet. */
  at(projectId: string, sec: number): { rateCents: number | null; currency: Currency | null } {
    const list = this.byProject.get(projectId);
    if (list) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const r = list[i] as CompiledRate;
        if (r.from <= sec) return r.rateCents === null ? { rateCents: null, currency: null } : { rateCents: r.rateCents, currency: r.currency };
      }
    }
    return { rateCents: null, currency: null };
  }

  /** Slices `[start, end)` at rate changes. */
  split(projectId: string, start: number, end: number): RatePiece[] {
    const list = this.byProject.get(projectId) ?? [];
    const out: RatePiece[] = [];
    let cur = start;
    for (;;) {
      const v = this.at(projectId, cur);
      let next = end;
      for (const r of list) {
        if (r.from > cur) {
          next = Math.min(r.from, end);
          break;
        }
      }
      out.push({ start: cur, end: next, rateCents: v.rateCents, currency: v.currency });
      if (next >= end) return out;
      cur = next;
    }
  }
}

export interface RatePiece {
  start: number;
  end: number;
  rateCents: number | null;
  currency: Currency | null;
}

export interface Bucket {
  rateCents: number | null;
  currency: Currency | null;
  exactSecs: number;
  billableSecs: number;
}

export interface TaskDay {
  taskId: string;
  projectId: string;
  day: string;
  firstStart: number;
  exactSecs: number;
  /** Pauses marked as still working. Part of billable, never of exact. */
  pauseSecs: number;
  /** Away time marked as thinking. Part of exact and billable, reported separately. */
  thinkingSecs: number;
  billableSecs: number;
  rule: Rule;
  /** Real time rounded down to nothing (Nearest or Down only). The row stays. */
  roundedToZero: boolean;
  /** No exact time at all. The row stays at 0. */
  zeroExact: boolean;
  buckets: Bucket[];
}

export interface SpanLike {
  taskId: string;
  projectId: string;
  start: number;
  end: number;
  /** Missing means work. */
  kind?: PieceKind;
}

function nextMidnight(day: string, zone: string, cache: Map<string, number>): number {
  let v = cache.get(day);
  if (v === undefined) {
    v = startOfDay(addDays(day, 1), zone);
    cache.set(day, v);
  }
  return v;
}

function allocate(buckets: Bucket[], diff: number): void {
  let left = diff;
  for (let i = buckets.length - 1; i >= 0 && left !== 0; i -= 1) {
    const b = buckets[i] as Bucket;
    const applied = Math.max(left, -b.billableSecs);
    b.billableSecs += applied;
    left -= applied;
  }
}

/**
 * One row per task per day in `zone`, in no particular order. A billable pause adds to billable only:
 * the row's exact time plus its pauses is rounded once. Thinking counts in exact like any work.
 */
export function taskDays(spans: readonly SpanLike[], zone: string, book: RateBook, rounding: readonly RoundingVersion[]): TaskDay[] {
  const midnight = new Map<string, number>();
  const acc = new Map<string, { taskId: string; projectId: string; day: string; first: number | null; pause: number; thinking: number; pieces: (RatePiece & { pause: boolean })[] }>();
  for (const s of spans) {
    const isPause = s.kind === 'billablePause';
    let cur = s.start;
    for (;;) {
      const day = dayOf(cur, zone);
      const next = nextMidnight(day, zone, midnight);
      const stop = next >= s.end ? s.end : next;
      const key = `${s.taskId}|${day}`;
      let row = acc.get(key);
      if (!row) {
        row = { taskId: s.taskId, projectId: s.projectId, day, first: null, pause: 0, thinking: 0, pieces: [] };
        acc.set(key, row);
      }
      if (!isPause) row.first = row.first === null ? cur : Math.min(row.first, cur);
      if (isPause) row.pause += stop - cur;
      else if (s.kind === 'thinking') row.thinking += stop - cur;
      for (const p of book.split(s.projectId, cur, stop)) row.pieces.push({ ...p, pause: isPause });
      if (stop >= s.end) break;
      cur = stop;
    }
  }
  const rows: TaskDay[] = [];
  for (const row of acc.values()) {
    row.pieces.sort((a, b) => a.start - b.start);
    const buckets: Bucket[] = [];
    for (const p of row.pieces) {
      const secs = p.end - p.start;
      const exact = p.pause ? 0 : secs;
      const last = buckets[buckets.length - 1];
      if (last && last.rateCents === p.rateCents && last.currency === p.currency) {
        last.exactSecs += exact;
        last.billableSecs += secs;
      } else {
        buckets.push({ rateCents: p.rateCents, currency: p.currency, exactSecs: exact, billableSecs: secs });
      }
    }
    const exactSecs = buckets.reduce((n, b) => n + b.exactSecs, 0);
    const counted = exactSecs + row.pause;
    const rule = ruleFor(rounding, row.projectId, row.day);
    const billableSecs = roundSeconds(counted, rule.incrementMinutes, rule.method);
    allocate(buckets, billableSecs - counted);
    rows.push({
      taskId: row.taskId,
      projectId: row.projectId,
      day: row.day,
      firstStart: row.first ?? 0,
      exactSecs,
      pauseSecs: row.pause,
      thinkingSecs: row.thinking,
      billableSecs,
      rule,
      roundedToZero: counted > 0 && billableSecs === 0,
      zeroExact: counted === 0,
      buckets,
    });
  }
  return rows;
}

export type Numerators = Partial<Record<Currency, number>>;

/** Exact numerators per currency from billable time. */
export function numeratorsOf(rows: readonly TaskDay[]): Numerators {
  const out: Numerators = {};
  for (const r of rows) {
    for (const b of r.buckets) {
      if (b.rateCents !== null && b.currency) out[b.currency] = (out[b.currency] ?? 0) + b.rateCents * b.billableSecs;
    }
  }
  return out;
}

/** Exact numerators per currency from exact (unrounded) time: what the live ticker's exact figure shows. */
export function exactNumeratorsOf(rows: readonly TaskDay[]): Numerators {
  const out: Numerators = {};
  for (const r of rows) {
    for (const b of r.buckets) {
      if (b.rateCents !== null && b.currency) out[b.currency] = (out[b.currency] ?? 0) + b.rateCents * b.exactSecs;
    }
  }
  return out;
}

export function money(currency: Currency, cents: number): string {
  const symbol = currency === 'EUR' ? '€' : '$';
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  return `${symbol}${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
}

/** "€12.00 + $3.50", currencies side by side, rounded only here. */
export function moneyTotals(n: Numerators): string {
  const parts = (['EUR', 'USD'] as const).filter((c) => n[c] !== undefined).map((c) => money(c, centsFromNumerator(n[c] as number)));
  return parts.join(' + ');
}

export const MASK = '••••';
