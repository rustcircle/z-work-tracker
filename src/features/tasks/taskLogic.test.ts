import { describe, expect, it } from 'vitest';

import type { Project, Task } from '../../lib/types';
import { controlsFor, pauseReasonText, validateTask } from './taskLogic';

const project = (o: Partial<Project> = {}): Project => ({ id: 'p1', name: 'Brand', color: '#2563eb', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '', hasTasks: false, ...o });
const task = (o: Partial<Task> = {}): Task => ({ id: 't1', name: 'Logo', projectId: 'p1', description: null, state: 'draft', pauseReason: null, createdAt: '', stoppedAt: null, runningElsewhere: null, ...o });
const enabled = (t: Task, p: Project | undefined = project()) => Object.entries(controlsFor(t, p)).filter(([, c]) => c.enabled).map(([k]) => k);

describe('validateTask', () => {
  it('needs a name and a project', () => {
    expect(validateTask({ name: '  ', projectId: '', description: null }, [project()]).ok).toBe(false);
    const e = validateTask({ name: '', projectId: 'p1', description: null }, [project()]);
    expect(e.name).toBe('Enter a task name.');
    expect(e.project).toBeNull();
    expect(validateTask({ name: 'x', projectId: '', description: null }, [project()]).project).toBe('Choose a project.');
    expect(validateTask({ name: 'x', projectId: 'p1', description: null }, [project()]).ok).toBe(true);
  });

  it('rejects an archived project unless it is the task\'s own', () => {
    const archived = project({ archived: true });
    expect(validateTask({ name: 'x', projectId: 'p1', description: null }, [archived]).ok).toBe(false);
    expect(validateTask({ name: 'x', projectId: 'p1', description: null }, [archived], 'p1').ok).toBe(true);
  });
});

describe('controlsFor', () => {
  it('enables exactly the right buttons per state', () => {
    expect(enabled(task({ state: 'draft' }))).toEqual(['start']);
    expect(enabled(task({ state: 'running' }))).toEqual(['pause', 'stop']);
    expect(enabled(task({ state: 'paused' }))).toEqual(['resume', 'stop']);
    expect(enabled(task({ state: 'stopped' }))).toEqual([]);
  });

  it('a task running on another device can only be stopped from here', () => {
    const t = task({ state: 'running', runningElsewhere: 'Office PC' });
    expect(enabled(t)).toEqual(['stop']);
    expect(controlsFor(t, project()).pause.why).toContain('Office PC');
  });

  it('blocks start and resume in an archived project and explains why', () => {
    const archived = project({ archived: true });
    expect(enabled(task({ state: 'draft' }), archived)).toEqual([]);
    expect(enabled(task({ state: 'paused' }), archived)).toEqual(['stop']);
    expect(controlsFor(task({ state: 'draft' }), archived).start.why).toContain('archived');
  });
});

describe('pauseReasonText', () => {
  const tasks = new Map([['t9', task({ id: 't9', name: 'Invoices' })]]);
  it('names the task that caused an auto-pause', () => {
    expect(pauseReasonText({ kind: 'autoPaused', byTaskId: 't9' }, tasks)).toBe('Auto-paused because "Invoices" was started.');
  });
  it('words each other reason', () => {
    expect(pauseReasonText({ kind: 'appQuit' }, tasks)).toContain('closed');
    expect(pauseReasonText({ kind: 'crashRecovery' }, tasks)).toContain('unexpectedly');
    expect(pauseReasonText({ kind: 'user' }, tasks)).toBe('Paused by you.');
    expect(pauseReasonText(null, tasks)).toBeNull();
  });
});
