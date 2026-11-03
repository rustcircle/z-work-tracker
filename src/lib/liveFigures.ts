// A project's all-time figures, carried forward from the snapshot's to now. The backend works them out once per
// snapshot, and a running task makes no new one, so a figure read as it stands stops at the moment the task started
// or last changed. Only the running tasks' own days can have moved, so only those are worked out again.
import { effectiveEnd } from './split';
import { RateBook, centsOfNumerators, numeratorsOf, taskDays, type Numerators, type SpanLike } from './billing';
import { parseIso } from './tz';
import type { BudgetStatus, Currency, Project, ProjectFigures, Segment, Snapshot } from './types';

const levelOf = (percent: number): BudgetStatus['level'] => (percent >= 100 ? 100 : percent >= 80 ? 80 : 0);
const isOpenHere = (s: Segment): boolean => s.end === null && s.provisionalEnd === null;

type Sums = Pick<ProjectFigures, 'exactSecs' | 'pauseSecs' | 'thinkingSecs' | 'billableSecs'> & { numerators: Numerators };

function sumsAt(pieces: readonly Segment[], projectId: string, at: number, zone: string, book: RateBook, snapshot: Snapshot): Sums {
  const spans: SpanLike[] = pieces.map((p) => {
    const start = parseIso(p.start);
    return { taskId: p.taskId, projectId, start, end: Math.max(effectiveEnd(p, at), start), kind: p.kind ?? 'work' };
  });
  const rows = taskDays(spans, zone, book, snapshot.rounding);
  const out: Sums = { exactSecs: 0, pauseSecs: 0, thinkingSecs: 0, billableSecs: 0, numerators: numeratorsOf(rows) };
  for (const r of rows) {
    out.exactSecs += r.exactSecs;
    out.pauseSecs += r.pauseSecs;
    out.thinkingSecs += r.thinkingSecs;
    out.billableSecs += r.billableSecs;
  }
  return out;
}

/** The exact value a figure holds, or its cents when that's all it has. */
function numeratorsIn(f: ProjectFigures): Numerators {
  if (f.timeValueNumerators) return { ...f.timeValueNumerators };
  return Object.fromEntries(Object.entries(f.timeValueCents).map(([c, cents]) => [c, cents * 3600]));
}

/** The rules of the backend's `project_figures`, so a figure carried forward reads what a new snapshot would say. */
function withBudget(p: Project, f: ProjectFigures): ProjectFigures {
  const fee = p.billingType === 'fixedFee' ? (p.fixedFeeCents ?? null) : null;
  const effectiveHourlyCents = fee !== null && f.billableSecs > 0 ? Math.floor((fee * 3600) / f.billableSecs) : null;
  let budget: BudgetStatus | null = null;
  if (p.budgetHours && p.budgetHours > 0) {
    const percent = Math.floor((f.billableSecs / (p.budgetHours * 3600)) * 100);
    budget = { basis: 'hours', percent, level: levelOf(percent), needsTargetRate: false };
  } else if (fee !== null && fee > 0) {
    const value = p.feeCurrency ? f.timeValueCents[p.feeCurrency] : undefined;
    const percent = value === undefined ? 0 : Math.floor((value * 100) / fee);
    budget = { basis: 'fee', percent, level: levelOf(percent), needsTargetRate: value === undefined };
  }
  return { ...f, effectiveHourlyCents, budget };
}

/** The snapshot's projects with their figures as of `nowSec`: the same array when nothing is running here, or at the snapshot's own moment. */
export function projectsAt(snapshot: Snapshot, nowSec: number): readonly Project[] {
  const then = parseIso(snapshot.now);
  if (nowSec <= then) return snapshot.projects;
  const open = new Set(snapshot.segments.filter(isOpenHere).map((s) => s.taskId));
  if (open.size === 0) return snapshot.projects;
  const projectOf = new Map(snapshot.tasks.filter((t) => open.has(t.id)).map((t) => [t.id, t.projectId]));
  const moving = new Set(projectOf.values());
  const counted = snapshot.projects.filter((p) => moving.has(p.id) && (p.budgetHours !== null || p.billingType === 'fixedFee'));
  if (counted.length === 0) return snapshot.projects;

  // These figures value time at the rate history even on a fixed-fee project, as the backend's do.
  const book = new RateBook(counted.map((p) => ({ ...p, billingType: 'hourly' as const, billable: true })), snapshot.rates);
  const zone = snapshot.systemZone;
  const ahead = new Map<string, ProjectFigures>();
  for (const p of counted) {
    let f: ProjectFigures = { ...p.figures };
    const numerators = numeratorsIn(p.figures);
    for (const [taskId, projectId] of projectOf) {
      if (projectId !== p.id) continue;
      const pieces = snapshot.segments.filter((s) => s.taskId === taskId);
      const before = sumsAt(pieces, p.id, then, zone, book, snapshot);
      const after = sumsAt(pieces, p.id, nowSec, zone, book, snapshot);
      f = {
        ...f,
        exactSecs: f.exactSecs + after.exactSecs - before.exactSecs,
        pauseSecs: f.pauseSecs + after.pauseSecs - before.pauseSecs,
        thinkingSecs: f.thinkingSecs + after.thinkingSecs - before.thinkingSecs,
        billableSecs: f.billableSecs + after.billableSecs - before.billableSecs,
      };
      for (const [c, n] of Object.entries(after.numerators)) {
        const k = c as Currency;
        numerators[k] = (numerators[k] ?? 0) + n - (before.numerators[k] ?? 0);
      }
    }
    // Rounded once, here, so it reads what a new snapshot would and not the sum of three rounded figures.
    f = { ...f, timeValueCents: centsOfNumerators(numerators) };
    if (Object.keys(numerators).length > 0) f.timeValueNumerators = numerators;
    ahead.set(p.id, withBudget(p, f));
  }
  return snapshot.projects.map((p) => {
    const f = ahead.get(p.id);
    return f ? { ...p, figures: f } : p;
  });
}
