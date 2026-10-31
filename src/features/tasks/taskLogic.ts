// Pure rules for the task panel: form validation, which controls a card enables, and the wording of
// pause reasons. Kept free of React so it is easy to test.
import { docHasText } from '../../lib/docText';
import type { LaunchState, PauseReason, Project, RequiredField, RichDoc, Task } from '../../lib/types';

export interface TaskDraft {
  name: string;
  projectId: string;
  description: RichDoc;
}

export interface TaskErrors {
  name: string | null;
  project: string | null;
  description: string | null;
  /** Everything needed to Start is present. */
  ok: boolean;
  /** Name and project are present, which is all a draft needs. */
  draftOk: boolean;
}

/** Fields that must be filled before Start: name and project always, the rest as the launch requires. */
export function requiredToStart(launch: Pick<LaunchState, 'warm' | 'coldRequired'>): RequiredField[] {
  return launch.warm ? ['name', 'project'] : [...new Set<RequiredField>(['name', 'project', ...launch.coldRequired])];
}

export function validateTask(draft: TaskDraft, projects: readonly Project[], allowArchivedId: string | null = null, required: readonly RequiredField[] = ['name', 'project']): TaskErrors {
  const name = draft.name.trim() === '' ? 'Enter a task name.' : null;
  let project: string | null = null;
  if (draft.projectId === '') project = 'Choose a project.';
  else {
    const p = projects.find((x) => x.id === draft.projectId);
    if (!p) project = 'Choose a project.';
    else if (p.archived && p.id !== allowArchivedId) project = `Project "${p.name}" is archived. Restore it or pick another.`;
  }
  const description = required.includes('description') && !docHasText(draft.description) ? 'Describe the task. A blank or spaces-only description does not count.' : null;
  return { name, project, description, ok: name === null && project === null && description === null, draftOk: name === null && project === null };
}

/** Names of the fields still missing for Start, in the form's order. */
export function missingText(e: TaskErrors): string {
  const parts = [e.name ? 'a task name' : null, e.project ? 'a project' : null, e.description ? 'a description' : null].filter((x): x is string => x !== null);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Required fields a stored task still lacks, for a cold launch. */
export function coldMissing(task: Task, launch: Pick<LaunchState, 'warm' | 'coldRequired'>): RequiredField[] {
  if (launch.warm) return [];
  return requiredToStart(launch).filter((f) => (f === 'name' ? task.name.trim() === '' : f === 'project' ? task.projectId === '' : f === 'description' ? !docHasText(task.description) : false));
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
export function controlsFor(task: Task, project: Project | undefined, launch: Pick<LaunchState, 'warm' | 'coldRequired'> = { warm: true, coldRequired: [] }): Controls {
  const projectBlock = !project ? 'This task has no project.' : project.archived ? `Project "${project.name}" is archived. Restore it first.` : null;
  const wrongState = (needs: string) => off(`Only available when the task is ${needs}.`);
  switch (task.state) {
    case 'draft': {
      const missing = coldMissing(task, launch);
      const coldBlock = missing.length > 0 ? `The first start after launch needs ${missing.join(', ')}. Edit the task to add ${missing.length > 1 ? 'them' : 'it'}.` : null;
      return { start: projectBlock ? off(projectBlock) : coldBlock ? off(coldBlock) : on, pause: wrongState('running'), resume: wrongState('paused'), stop: off('Start the task first.') };
    }
    case 'running':
      if (task.runningElsewhere) {
        return { start: wrongState('a draft'), pause: off(`Running on ${task.runningElsewhere}. Pause it there.`), resume: wrongState('paused'), stop: on };
      }
      return { start: wrongState('a draft'), pause: on, resume: wrongState('paused'), stop: on };
    case 'paused':
      // Cold: Resume opens a form for a new linked task, so the old project does not matter.
      return { start: wrongState('a draft'), pause: wrongState('running'), resume: !launch.warm ? on : projectBlock ? off(projectBlock) : on, stop: on };
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
