// Pure rules for the task panel: form validation, which controls a card enables, and the wording of
// pause reasons. Kept free of React so it is easy to test.
import type { PauseReason, Project, RichDoc, Task } from '../../lib/types';

export interface TaskDraft {
  name: string;
  projectId: string;
  description: RichDoc;
}

export interface TaskErrors {
  name: string | null;
  project: string | null;
  ok: boolean;
}

export function validateTask(draft: TaskDraft, projects: readonly Project[], allowArchivedId: string | null = null): TaskErrors {
  const name = draft.name.trim() === '' ? 'Enter a task name.' : null;
  let project: string | null = null;
  if (draft.projectId === '') project = 'Choose a project.';
  else {
    const p = projects.find((x) => x.id === draft.projectId);
    if (!p) project = 'Choose a project.';
    else if (p.archived && p.id !== allowArchivedId) project = `Project "${p.name}" is archived. Restore it or pick another.`;
  }
  return { name, project, ok: name === null && project === null };
}

export interface Control {
  enabled: boolean;
  why: string | null;
}

export interface Controls {
  start: Control;
  pause: Control;
  resume: Control;
  stop: Control;
}

const on: Control = { enabled: true, why: null };
const off = (why: string): Control => ({ enabled: false, why });

/** Exactly one of the four buttons set is live per state, as the spec lays out. */
export function controlsFor(task: Task, project: Project | undefined): Controls {
  const projectBlock = !project ? 'This task has no project.' : project.archived ? `Project "${project.name}" is archived. Restore it first.` : null;
  const wrongState = (needs: string) => off(`Only available when the task is ${needs}.`);
  switch (task.state) {
    case 'draft':
      return { start: projectBlock ? off(projectBlock) : on, pause: wrongState('running'), resume: wrongState('paused'), stop: off('Start the task first.') };
    case 'running':
      if (task.runningElsewhere) {
        return { start: wrongState('a draft'), pause: off(`Running on ${task.runningElsewhere}. Pause it there.`), resume: wrongState('paused'), stop: on };
      }
      return { start: wrongState('a draft'), pause: on, resume: wrongState('paused'), stop: on };
    case 'paused':
      return { start: wrongState('a draft'), pause: wrongState('running'), resume: projectBlock ? off(projectBlock) : on, stop: on };
    case 'stopped':
      return { start: off('This task is finished.'), pause: off('This task is finished.'), resume: off('This task is finished.'), stop: off('This task is finished.') };
  }
}

export function pauseReasonText(reason: PauseReason | null, tasks: ReadonlyMap<string, Task>): string | null {
  if (!reason) return null;
  switch (reason.kind) {
    case 'user':
      return 'Paused by you.';
    case 'autoPaused': {
      const by = tasks.get(reason.byTaskId);
      return `Auto-paused because "${by?.name ?? 'another task'}" was started.`;
    }
    case 'appQuit':
      return 'Paused when the app was closed. Time stopped at that moment.';
    case 'crashRecovery':
      return 'Paused after the app closed unexpectedly. Time counts up to the last moment the app was seen running.';
    case 'syncReconciled':
      return 'Paused while merging with another device.';
  }
}

export const STATE_LABEL: Record<Task['state'], string> = { draft: 'Draft', running: 'Running', paused: 'Paused', stopped: 'Stopped' };
