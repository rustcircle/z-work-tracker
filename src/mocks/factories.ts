// Complete `Project` and `Task` values for tests that build read-model objects by hand. A field left out
// takes the value a fresh store would give it.
import { suggestColor } from '../lib/color';
import type { Project, ProjectFigures, Task } from '../lib/types';

export const NO_FIGURES: ProjectFigures = { exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget: null };

/** A fixed-seed generator, so the colours handed out are the same in every run. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const handedOut: string[] = [];
const random = seeded(7);

/** The next default colour: curated first, then generated, never one already handed out by this factory. */
export function nextProjectColor(): string {
  const color = suggestColor(handedOut, random);
  handedOut.push(color);
  return color;
}

export function fullProject(p: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: p.id,
    color: p.color ?? nextProjectColor(),
    archived: false,
    billable: true,
    budgetHours: null,
    clientZone: null,
    createdAt: '2026-01-01T00:00:00Z',
    hasTasks: true,
    billingType: 'hourly',
    fixedFeeCents: null,
    feeCurrency: null,
    figures: NO_FIGURES,
    ...p,
  };
}

export function fullTask(t: Partial<Task> & Pick<Task, 'id' | 'projectId'>): Task {
  return {
    name: t.id,
    description: null,
    state: 'draft',
    pauseReason: null,
    createdAt: '2026-01-01T00:00:00Z',
    stoppedAt: null,
    runningElsewhere: null,
    continuedFrom: null,
    tags: [],
    activeSubtask: null,
    subtasks: [],
    billedSecs: 0,
    unbilledSecs: 0,
    thinkingSecs: 0,
    pauseSecs: 0,
    unconfirmedSecs: 0,
    ...t,
  };
}
