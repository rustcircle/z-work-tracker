// Complete `Project` and `Task` values for tests that build read-model objects by hand. A field left out
// takes the value a fresh store would give it.
import type { Project, ProjectFigures, Task } from '../lib/types';

export const NO_FIGURES: ProjectFigures = { exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget: null };

export function fullProject(p: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    name: p.id,
    color: '#2563eb',
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
