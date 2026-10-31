import { describe, expect, it } from 'vitest';

import type { Project, RequiredField, Task } from '../../lib/types';
import { fullProject, fullTask } from '../../mocks/factories';
import { coldMissing, controlsFor, missingText, pauseReasonText, requiredToStart, validateTask } from './taskLogic';

const project = (o: Partial<Project> = {}): Project => fullProject({ id: 'p1', name: 'Brand', createdAt: '', hasTasks: false, ...o });
const task = (o: Partial<Task> = {}): Task => fullTask({ id: 't1', name: 'Logo', projectId: 'p1', createdAt: '', ...o });
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

describe('required fields are data-driven, tags included', () => {
  const tags = [
    { id: 'tg1', deleted: false },
    { id: 'tg2', deleted: true },
  ];
  const draft = { name: 'x', projectId: 'p1', description: null };

  it('tags are required only when the launch lists them, and need a live tag', () => {
    expect(validateTask(draft, [project()], null, ['name', 'project'], tags).ok).toBe(true);
    const e = validateTask(draft, [project()], null, ['name', 'project', 'tags'], tags);
    expect(e.ok).toBe(false);
    expect(e.tags).toBe('Choose at least one tag.');
    expect(e.draftOk).toBe(true); // a draft never needs them
    expect(validateTask({ ...draft, tags: ['tg1'] }, [project()], null, ['name', 'project', 'tags'], tags).ok).toBe(true);
    // A deleted tag, or an id nobody knows, is no tag.
    expect(validateTask({ ...draft, tags: ['tg2'] }, [project()], null, ['name', 'project', 'tags'], tags).ok).toBe(false);
    expect(validateTask({ ...draft, tags: ['nope'] }, [project()], null, ['name', 'project', 'tags'], tags).ok).toBe(false);
  });

  it('words what is missing from the list, in the form order', () => {
    const all = validateTask({ name: '', projectId: '', description: null }, [project()], null, ['name', 'project', 'description', 'tags'], tags);
    expect(missingText(all)).toBe('a task name, a project, a description and at least one tag');
    const some = validateTask({ name: 'x', projectId: '', description: null }, [project()], null, ['name', 'project', 'tags'], tags);
    expect(missingText(some)).toBe('a project and at least one tag');
    expect(missingText(validateTask({ ...draft, description: null }, [project()], null, ['name', 'project', 'description', 'tags'], tags))).toBe('a description and at least one tag');
    expect(missingText(validateTask({ ...draft, tags: ['tg1'] }, [project()], null, ['name', 'project', 'tags'], tags))).toBe('');
  });

  it('requiredToStart follows coldRequired, so a launch without tags in the list needs none', () => {
    expect(requiredToStart({ warm: false, coldRequired: ['name', 'project', 'description'] })).toEqual(['name', 'project', 'description']);
    expect(requiredToStart({ warm: false, coldRequired: ['name', 'project', 'description', 'tags'] })).toEqual(['name', 'project', 'description', 'tags']);
    expect(requiredToStart({ warm: true, coldRequired: ['name', 'project', 'description', 'tags'] })).toEqual(['name', 'project']);
  });

  it('a stored draft lacking a tag cannot start cold, and says so', () => {
    const cold = { warm: false, coldRequired: ['name', 'project', 'description', 'tags'] as RequiredField[] };
    const d = task({ state: 'draft', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] } });
    expect(coldMissing(d, cold, tags)).toEqual(['tags']);
    expect(controlsFor(d, project(), cold, tags).start.enabled).toBe(false);
    expect(controlsFor(d, project(), cold, tags).start.why).toContain('needs tags');
    expect(controlsFor({ ...d, tags: ['tg1'] }, project(), cold, tags).start.enabled).toBe(true);
    expect(coldMissing(d, { warm: true, coldRequired: cold.coldRequired }, tags)).toEqual([]);
  });
});
