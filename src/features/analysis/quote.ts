// Quote helper: a rough estimate for a new job from the user's own finished tasks. Pure; nothing is stored.
//
// Comparable tasks. Only stopped tasks count. Each is scored against the new job by two signals:
//   tag score  = shared tags / tags on either side            (Jaccard, 0 to 1)
//   name score = shared name tokens / tokens on either side   (Jaccard, 0 to 1)
// A name is cut into tokens by lowercasing and splitting on anything that is not a letter or digit;
// tokens under 3 characters and common filler words (STOP_WORDS) are dropped. The two scores are
// averaged with equal weight, but a signal the new job does not have is left out, not counted as a
// miss: a job with no tags is scored on its name alone, a job with only tags on its tags alone.
// A task scores at least MIN_SCORE to be comparable; the best MAX_COMPARABLES are kept (ties: more
// recently stopped first, then by id, so the result never depends on input order).
//
// Hours. A task's figure is its billable time: its rows from `taskDays` over all its pieces, so
// rounding (once per task and day, in the given zone) and billable pauses are exactly what billing
// would show. Billable, not exact. A comparable task with no billable time says nothing about how
// long such a job takes, so it is left out and counted in `skippedZero`.
//
// Statistics. Quantiles use linear interpolation between closest ranks (the "R-7" method, the
// default of NumPy and Excel's QUARTILE.INC): for sorted values x[0..n-1] and fraction p, the
// position is h = (n - 1) * p and the value is x[floor(h)] + (h - floor(h)) * (x[ceil(h)] - x[floor(h)]).
// The median is p = 0.5. The middle half (p25 to p75) is shown only from 4 tasks on. Seconds are
// rounded to whole seconds after interpolation. Below 3 comparable tasks there is no estimate.
//
// Amount. Hours times the project's rate in force now (`RateBook`), each end rounded half up to
// cents. No amount when no project is chosen, the project is fixed fee or not billable, or it has
// no hourly rate yet; the reason is returned.
import { RateBook, centsFromNumerator, taskDays, type SpanLike } from '../../lib/billing';
import { parseIso } from '../../lib/tz';
import type { Currency, Snapshot } from '../../lib/types';

export const MIN_SAMPLE = 3;
export const MIN_SCORE = 0.25;
export const MAX_COMPARABLES = 10;
/** The middle half is only meaningful with a few tasks. */
export const MIN_FOR_QUARTILES = 4;

/** Words that say nothing about what a job is. Anything under 3 characters is dropped separately. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'this', 'that', 'these', 'those', 'are', 'was', 'were', 'been', 'has', 'have', 'had',
  'not', 'but', 'you', 'your', 'our', 'its', 'his', 'her', 'their', 'all', 'any', 'can', 'will', 'per', 'via', 'new', 'old', 'also', 'some', 'than',
  'then', 'them', 'they', 'what', 'when', 'where', 'who', 'how', 'out', 'off', 'task', 'job', 'work', 'project',
]);

export function nameTokens(name: string): string[] {
  const seen = new Set<string>();
  for (const t of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if ([...t].length >= 3 && !STOP_WORDS.has(t)) seen.add(t);
  }
  return [...seen];
}

export type QuoteData = Pick<Snapshot, 'tasks' | 'segments' | 'projects' | 'rates' | 'rounding'>;

export interface QuoteInput {
  name: string;
  /** Tag ids. */
  tags: readonly string[];
  /** The project the job is for: its rate prices the estimate. */
  projectId: string | null;
  /** Compare only with tasks of that project. Ignored without a project. */
  sameProjectOnly?: boolean;
}

export interface Comparable {
  taskId: string;
  name: string;
  projectId: string;
  score: number;
  sharedTags: string[];
  sharedTokens: string[];
  billableSecs: number;
  stoppedAt: string | null;
}

export type NoAmountReason = 'noProject' | 'fixedFee' | 'notBillable' | 'noRate';

export type QuoteAmount =
  | { kind: 'none'; reason: NoAmountReason }
  | { kind: 'amount'; currency: Currency; rateCents: number; minCents: number; medianCents: number; maxCents: number; p25Cents: number | null; p75Cents: number | null };

interface Common {
  comparables: Comparable[];
  /** Matching tasks left out because they have no billable time. */
  skippedZero: number;
}

export type QuoteResult =
  /** Nothing to compare with: no usable name word and no tag. */
  | { kind: 'noCriteria' }
  | ({ kind: 'notEnoughData'; n: number; needed: number } & Common)
  | ({
      kind: 'estimate';
      n: number;
      medianSecs: number;
      minSecs: number;
      maxSecs: number;
      /** Only from MIN_FOR_QUARTILES tasks on. */
      p25Secs: number | null;
      p75Secs: number | null;
      amount: QuoteAmount;
    } & Common);

/** Linear-interpolation quantile (R-7) of ascending values, rounded to whole seconds. */
export function quantile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sortedAsc[lo] as number;
  const b = sortedAsc[hi] as number;
  return Math.round(a + (h - lo) * (b - a));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): { score: number; shared: string[] } {
  const shared = [...a].filter((x) => b.has(x));
  const union = a.size + b.size - shared.length;
  return { score: union === 0 ? 0 : shared.length / union, shared };
}

/** Billable seconds per stopped task, from its closed pieces. */
function billableByTask(data: QuoteData, taskIds: ReadonlySet<string>, zone: string): Map<string, number> {
  const projectOf = new Map(data.tasks.map((t) => [t.id, t.projectId]));
  const spans: SpanLike[] = [];
  for (const s of data.segments) {
    if (!taskIds.has(s.taskId) || s.end === null) continue;
    const projectId = projectOf.get(s.taskId);
    if (projectId === undefined) continue;
    const start = parseIso(s.start);
    const end = parseIso(s.end);
    if (end > start) spans.push({ taskId: s.taskId, projectId, start, end, kind: s.kind });
  }
  const out = new Map<string, number>();
  const book = new RateBook(data.projects, data.rates);
  for (const row of taskDays(spans, zone, book, data.rounding)) out.set(row.taskId, (out.get(row.taskId) ?? 0) + row.billableSecs);
  return out;
}

function amountFor(data: QuoteData, projectId: string | null, nowSec: number, stats: { min: number; median: number; max: number; p25: number | null; p75: number | null }): QuoteAmount {
  if (projectId === null) return { kind: 'none', reason: 'noProject' };
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) return { kind: 'none', reason: 'noProject' };
  if (project.billingType === 'fixedFee') return { kind: 'none', reason: 'fixedFee' };
  if (!project.billable) return { kind: 'none', reason: 'notBillable' };
  const at = new RateBook(data.projects, data.rates).at(projectId, nowSec);
  if (at.rateCents === null || at.currency === null) return { kind: 'none', reason: 'noRate' };
  const rate = at.rateCents;
  const cents = (secs: number): number => centsFromNumerator(rate * secs);
  return {
    kind: 'amount',
    currency: at.currency,
    rateCents: rate,
    minCents: cents(stats.min),
    medianCents: cents(stats.median),
    maxCents: cents(stats.max),
    p25Cents: stats.p25 === null ? null : cents(stats.p25),
    p75Cents: stats.p75 === null ? null : cents(stats.p75),
  };
}

/**
 * Compares a new job with finished tasks. `zone` decides which day a piece of time belongs to (and so
 * how it rounds); `nowSec` picks the rate in force.
 */
export function quoteFor(data: QuoteData, input: QuoteInput, zone: string, nowSec: number): QuoteResult {
  const wantTokens = new Set(nameTokens(input.name));
  const wantTags = new Set(input.tags);
  if (wantTokens.size === 0 && wantTags.size === 0) return { kind: 'noCriteria' };

  const scored: Omit<Comparable, 'billableSecs'>[] = [];
  for (const t of data.tasks) {
    if (t.state !== 'stopped') continue;
    if (input.sameProjectOnly && input.projectId !== null && t.projectId !== input.projectId) continue;
    const tags = jaccard(wantTags, new Set(t.tags));
    const words = jaccard(wantTokens, new Set(nameTokens(t.name)));
    const parts: number[] = [];
    if (wantTags.size > 0) parts.push(tags.score);
    if (wantTokens.size > 0) parts.push(words.score);
    const score = parts.reduce((a, b) => a + b, 0) / parts.length;
    if (score < MIN_SCORE) continue;
    scored.push({ taskId: t.id, name: t.name, projectId: t.projectId, score, sharedTags: tags.shared, sharedTokens: words.shared, stoppedAt: t.stoppedAt });
  }

  const billable = billableByTask(data, new Set(scored.map((s) => s.taskId)), zone);
  const withTime: Comparable[] = [];
  let skippedZero = 0;
  for (const s of scored) {
    const billableSecs = billable.get(s.taskId) ?? 0;
    if (billableSecs > 0) withTime.push({ ...s, billableSecs });
    else skippedZero += 1;
  }
  withTime.sort((a, b) => b.score - a.score || (b.stoppedAt ?? '').localeCompare(a.stoppedAt ?? '') || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const comparables = withTime.slice(0, MAX_COMPARABLES);

  const n = comparables.length;
  if (n < MIN_SAMPLE) return { kind: 'notEnoughData', n, needed: MIN_SAMPLE, comparables, skippedZero };

  const values = comparables.map((c) => c.billableSecs).sort((a, b) => a - b);
  const quartiles = n >= MIN_FOR_QUARTILES;
  const stats = {
    min: values[0] as number,
    median: quantile(values, 0.5),
    max: values[n - 1] as number,
    p25: quartiles ? quantile(values, 0.25) : null,
    p75: quartiles ? quantile(values, 0.75) : null,
  };
  return {
    kind: 'estimate',
    n,
    medianSecs: stats.median,
    minSecs: stats.min,
    maxSecs: stats.max,
    p25Secs: stats.p25,
    p75Secs: stats.p75,
    amount: amountFor(data, input.projectId, nowSec, stats),
    comparables,
    skippedZero,
  };
}
