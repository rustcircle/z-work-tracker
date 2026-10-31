import { clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../../components/ErrorBoundary';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { emptyState, relaunch, type MockState } from '../../mocks/ipcMock';
import type { Task } from '../../lib/types';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let state: MockState;
function boot(s: MockState) {
  state = s;
  return bootApp(s);
}
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const taskNamed = (name: string): Task => state.tasks.find((t) => t.name === name) as Task;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function coldProject(): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.projects.push({ id: 'p1', name: 'Brand refresh', color: '#2563eb', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', hasTasks: false });
  s.projects.push({ id: 'p2', name: 'Website', color: '#dc2626', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', hasTasks: false });
  return s;
}

function coldDemo(): MockState {
  const s = demoState();
  relaunch(s); // the running task pauses as "app quit" and the launch is cold
  return s;
}

describe('warm start: a new task copies the last one', () => {
  it('prefills project, name and description, says where from, and Start works at once', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts');
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
    expect(within(form).getByRole('textbox', { name: 'Description' })).toHaveTextContent('Final artwork');
    expect(within(form).getByTestId('copy-note')).toHaveTextContent('Copied from “Logo concepts”, Thu 12 Mar 2026');
    expect(within(form).getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(within(form).queryByText(/To start, enter/)).toBeNull();
    // Warm mode: the description may be blank, name and project stay mandatory.
    expect(within(form).getByText('Optional.')).toBeVisible();
  });

  it('is independent: editing the copy never changes the source, and the new task is its own record', async () => {
    const user = userEvent.setup();
    boot(demoState());
    const before = structuredClone(taskNamed('Logo concepts'));
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    const name = within(form).getByRole('textbox', { name: 'Task name' });
    await user.clear(name);
    await user.type(name, 'Logo concepts, round two');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), ' Extra line.');
    await user.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(state.tasks.some((t) => t.name === 'Logo concepts, round two')).toBe(true));
    const copy = taskNamed('Logo concepts, round two');
    expect(copy.id).not.toBe(before.id);
    expect(JSON.stringify(copy.description)).toContain('Extra line.');
    expect(JSON.stringify(copy.description)).toContain('Final artwork');
    expect(copy.state).toBe('draft');
    expect(copy.continuedFrom).toBeNull(); // a copy is not a continuation
    expect(taskNamed('Logo concepts')).toEqual(before);
    expect(calls('patch_task')).toEqual([]);
  });

  it('Start blank empties every field and drops the note', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.click(within(form).getByRole('button', { name: 'Start blank' }));
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('');
    expect(within(form).getByRole('textbox', { name: 'Description' })).toHaveTextContent('');
    expect(within(form).queryByTestId('copy-note')).toBeNull();
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('leaves the project empty and says why when the copied task\'s project is archived', async () => {
    const user = userEvent.setup();
    const s = demoState();
    const p = s.projects.find((x) => x.id === 'p-brand');
    if (p) p.archived = true;
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts');
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('');
    expect(within(form).getByText(/“Brand refresh” of the copied task is archived, so choose a project/)).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p-web');
    expect(within(form).getByRole('button', { name: 'Start' })).toBeEnabled();
  });
});

describe('cold start: every field is required', () => {
  it('opens empty, with no prefill, marks the description required and focuses the name', async () => {
    const user = userEvent.setup();
    boot(coldProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveFocus();
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('');
    expect(within(form).queryByTestId('copy-note')).toBeNull();
    expect(within(form).getByText('Required for the first start after launch.')).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  it('rejects a whitespace-only description inline and keeps Start disabled', async () => {
    const user = userEvent.setup();
    boot(coldProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Spaces');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p1');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), '   ');
    expect(await within(form).findByText(/spaces-only description does not count/)).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'x');
    await waitFor(() => expect(within(form).queryByText(/spaces-only/)).toBeNull());
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled(); // still no tag
    await user.click(within(form).getByRole('checkbox', { name: 'Admin' }));
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Start' })).toBeEnabled());
  });

  it('moves focus to the first invalid field when saving is attempted', async () => {
    const user = userEvent.setup();
    boot(coldProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.click(within(form).getByRole('button', { name: 'Save draft' }));
    expect(await within(form).findByText('Enter a task name.')).toBeVisible();
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveFocus();
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Named');
    await user.click(within(form).getByRole('button', { name: 'Save draft' }));
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveFocus();
    expect(calls('create_task')).toEqual([]);
  });

  it('a draft without a description cannot start from its card while cold, and says what to add', async () => {
    const s = coldProject();
    s.tasks.push({ id: 'd1', name: 'Bare draft', projectId: 'p1', description: null, state: 'draft', pauseReason: null, createdAt: '2026-03-01T00:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: null });
    boot(s);
    const c = within(await screen.findByRole('article', { name: 'Bare draft' }));
    expect(c.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(c.getByText(/The first start after launch needs description/)).toBeVisible();
  });

  it('turns warm once a task has started, and the form then copies it', async () => {
    const user = userEvent.setup();
    boot(coldProject());
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'First');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p1');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Do it');
    // The starter tags exist, so a cold start also needs one of them.
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.click(within(form).getByRole('checkbox', { name: 'Concept' }));
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(state.warm).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const next = screen.getByRole('form', { name: 'New task' });
    expect(within(next).getByRole('textbox', { name: 'Task name' })).toHaveValue('First');
    expect(within(next).getByTestId('copy-note')).toBeVisible();
    expect(within(next).getByRole('checkbox', { name: 'Concept' })).toBeChecked();
  });
});

describe('cold resume', () => {
  it('a start that fails keeps the form open, retries on the same task, and Cancel removes it', async () => {
    const user = userEvent.setup();
    boot(demoState());
    state.warm = false;
    state.lastWorked = null;
    for (const t of state.tasks) if (t.state === 'running') t.state = 'paused';
    state.segments.forEach((x) => { x.end ??= x.start; });
    const before = state.tasks.length;
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Retry me');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p-web');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Real text');
    await user.click(within(form).getByRole('checkbox', { name: 'Concept' }));
    state.failNext = ['start_task', 'start_task'];
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(state.tasks).toHaveLength(before + 1));
    await waitFor(() => expect(state.failNext).toEqual(['start_task']));
    expect(screen.getByRole('form', { name: 'New task' })).toBeTruthy();
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(state.failNext).toEqual([]));
    expect(state.tasks).toHaveLength(before + 1);
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(state.tasks).toHaveLength(before));
    expect(calls('resume_task')).toEqual([]);
  });


  it('opens the empty form labelled as continuing the old task, and Cancel logs nothing', async () => {
    const user = userEvent.setup();
    boot(coldDemo());
    const logo = within(await screen.findByRole('article', { name: 'Logo concepts' }));
    expect(logo.getByText(/Paused when the app was closed/)).toBeVisible();
    expect(logo.getByText(/After a restart, Resume asks for every field again/)).toBeVisible();
    await user.click(logo.getByRole('button', { name: 'Resume' }));
    const form = screen.getByRole('form', { name: 'Continue Logo concepts' });
    expect(within(form).getByTestId('continue-note')).toHaveTextContent('Continuing “Logo concepts”');
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    expect(within(form).getByRole('combobox', { name: 'Project' })).toHaveValue('');
    expect(within(form).getByRole('textbox', { name: 'Description' })).toHaveTextContent('');
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Continue Logo concepts' })).toBeNull();
    for (const c of ['create_task', 'start_task', 'resume_task']) expect(calls(c)).toEqual([]);
    expect(taskNamed('Logo concepts').state).toBe('paused');
  });

  it('submitting creates a new linked task and leaves the old one unchanged, paused and stoppable', async () => {
    const user = userEvent.setup();
    boot(coldDemo());
    const oldBefore = structuredClone(taskNamed('Logo concepts'));
    await user.click(within(await screen.findByRole('article', { name: 'Logo concepts' })).getByRole('button', { name: 'Resume' }));
    const form = screen.getByRole('form', { name: 'Continue Logo concepts' });
    await user.type(within(form).getByRole('textbox', { name: 'Task name' }), 'Logo concepts v2');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Project' }), 'p-brand');
    await user.type(within(form).getByRole('textbox', { name: 'Description' }), 'Second round');
    expect(within(form).getByRole('button', { name: 'Start' })).toBeDisabled(); // a cold start needs a tag too
    await user.click(within(form).getByRole('checkbox', { name: 'Revision' }));
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(calls('start_task')).toHaveLength(1));
    expect(calls('create_task')[0]).toMatchObject({ input: { name: 'Logo concepts v2', projectId: 'p-brand', continuedFrom: 't-logo', tags: ['tag-revision'] } });
    expect(calls('resume_task')).toEqual([]);
    const created = taskNamed('Logo concepts v2');
    expect(created.state).toBe('running');
    expect(created.continuedFrom).toBe('t-logo');
    expect(state.segments.filter((s) => s.taskId === created.id && s.end === null)).toHaveLength(1);
    // The old task keeps its own name, description and segments, stays paused and can still be stopped.
    const oldNow = taskNamed('Logo concepts');
    expect({ ...oldNow, pauseReason: null }).toEqual({ ...oldBefore, pauseReason: null });
    expect(oldNow.state).toBe('paused');
    const old = within(await screen.findByRole('article', { name: 'Logo concepts' }));
    expect(old.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(old.getByText('Continued by')).toBeVisible();
    expect(old.getByRole('button', { name: 'Logo concepts v2' })).toBeVisible();
    const fresh = within(screen.getByRole('article', { name: 'Logo concepts v2' }));
    expect(fresh.getByRole('button', { name: 'Logo concepts' })).toBeVisible();
    // Now warm, so Resume continues a paused task directly.
    await user.click(within(screen.getByRole('article', { name: 'Brand guidelines' })).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(calls('resume_task')).toHaveLength(1));
    expect(screen.queryByRole('form', { name: /Continue/ })).toBeNull();
  });

  it('is also the route for a task paused by crash recovery', async () => {
    const user = userEvent.setup();
    const s = demoState();
    const logo = s.tasks.find((t) => t.id === 't-logo');
    if (logo) {
      logo.state = 'paused';
      logo.pauseReason = { kind: 'crashRecovery' };
    }
    s.warm = false;
    s.lastWorked = null;
    boot(s);
    const c = within(await screen.findByRole('article', { name: 'Logo concepts' }));
    expect(c.getByText(/closed unexpectedly/)).toBeVisible();
    await user.click(c.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('form', { name: 'Continue Logo concepts' })).toBeVisible();
    expect(calls('resume_task')).toEqual([]);
  });

  it('the tray\'s cold-resume event opens the form and starts nothing', async () => {
    boot(coldDemo());
    await screen.findByRole('article', { name: 'Logo concepts' });
    await waitFor(async () => {
      await act(async () => {
        await emit('cold-resume', { taskId: 't-logo' });
      });
      expect(screen.getByRole('form', { name: 'Continue Logo concepts' })).toBeVisible();
    });
    for (const c of ['create_task', 'start_task', 'resume_task']) expect(calls(c)).toEqual([]);
  });

  it('Stop stays allowed while cold', async () => {
    const user = userEvent.setup();
    boot(coldDemo());
    await user.click(within(await screen.findByRole('article', { name: 'Logo concepts' })).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(taskNamed('Logo concepts').state).toBe('stopped'));
  });
});

describe('editing a task at any time', () => {
  const states: [string, string][] = [
    ['Social templates', 'draft'],
    ['Logo concepts', 'running'],
    ['Brand guidelines', 'paused'],
    ['Homepage layout', 'stopped'],
  ];

  for (const [name, taskState] of states) {
    it(`edits a ${taskState} task with one click and saves by itself`, async () => {
      const user = userEvent.setup();
      boot(demoState());
      await user.click(await screen.findByRole('button', { name: `Edit ${name}` }));
      const form = screen.getByRole('form', { name: `Editing ${name}` });
      const input = within(form).getByRole('textbox', { name: 'Task name' });
      expect(input).toHaveFocus();
      const before = structuredClone(taskNamed(name));
      await user.type(input, ' (renamed)');
      await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 2000 });
      expect(calls('patch_task')[0]).toEqual({ id: before.id, patch: { name: `${name} (renamed)` } });
      await waitFor(() => expect(within(form).getByTestId('save-state')).toHaveTextContent('Saved'));
      expect(taskNamed(`${name} (renamed)`).state).toBe(taskState);
      expect(await screen.findByRole('heading', { name: `${name} (renamed)` })).toBeVisible();
    });
  }

  it('waits about 600 ms after the last keystroke before saving', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Social templates' }));
    await user.type(screen.getByRole('textbox', { name: 'Task name' }), '!');
    await sleep(300);
    expect(calls('patch_task')).toEqual([]);
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 1500 });
  });

  it('saving a description on a stopped task sends only the description', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Homepage layout' }));
    await user.type(within(screen.getByRole('form', { name: 'Editing Homepage layout' })).getByRole('textbox', { name: 'Description' }), 'Hero section agreed.');
    await user.tab();
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1));
    expect(calls('patch_task')[0]).toMatchObject({ id: 't-home' });
    expect(Object.keys((calls('patch_task')[0] as { patch: object }).patch)).toEqual(['description']);
    expect(taskNamed('Homepage layout').projectId).toBe('p-web');
    expect(JSON.stringify(taskNamed('Homepage layout').description)).toContain('Hero section agreed.');
  });

  it('a failed save keeps the editor open with the draft, and retries by itself', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Logo concepts' }));
    const original = state.tasks.find((t) => t.name === 'Logo concepts') as (typeof state.tasks)[number];
    const box = screen.getByRole('textbox', { name: 'Task name' });
    state.failNext = ['patch_task', 'patch_task']; // blur, then Done
    await user.type(box, ' v2');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByTestId('save-state').dataset.kind).toBe('failed'));
    expect(screen.getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts v2');
    await waitFor(() => expect(state.tasks.find((t) => t.id === original.id)?.name).toBe('Logo concepts v2'), { timeout: 7000 });
  }, 10000);

  it('a running edit never touches segments, state or the timer', async () => {
    const user = userEvent.setup();
    boot(demoState());
    const segmentsBefore = structuredClone(state.segments);
    const clock = () => document.querySelector('.ticker-clock')?.textContent ?? '';
    await user.click(await screen.findByRole('button', { name: 'Edit Logo concepts' }));
    const start = clock();
    expect(start).toMatch(/^1:\d\d:\d\d$/);
    await user.type(screen.getByRole('textbox', { name: 'Task name' }), ' v1.1');
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 2000 });
    await sleep(1200);
    expect(state.segments).toEqual(segmentsBefore);
    expect(taskNamed('Logo concepts v1.1').state).toBe('running');
    for (const c of ['pause_task', 'stop_task', 'start_task', 'resume_task']) expect(calls(c)).toEqual([]);
    // The session clock kept counting; it did not reset.
    const secs = (t: string) => t.split(':').reduce((n, x) => n * 60 + Number(x), 0);
    expect(secs(clock())).toBeGreaterThanOrEqual(secs(start));
    expect(secs(clock())).toBeGreaterThan(4000);
  });

  it('does not save a blank name: it shows why, keeps the last valid name, and restores it on blur', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Social templates' }));
    const form = screen.getByRole('form', { name: 'Editing Social templates' });
    const input = within(form).getByRole('textbox', { name: 'Task name' });
    await user.clear(input);
    expect(await within(form).findByText(/A task needs a name/)).toBeVisible();
    await sleep(800);
    expect(calls('patch_task')).toEqual([]);
    await user.tab();
    await waitFor(() => expect(input).toHaveValue('Social templates'));
    expect(within(form).getByTestId('save-state')).toHaveTextContent('“Social templates” is kept');
    expect(calls('patch_task')).toEqual([]);
    expect(taskNamed('Social templates').name).toBe('Social templates');
  });

  it('Escape restores the last saved name', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Social templates' }));
    const input = screen.getByRole('textbox', { name: 'Task name' });
    await user.type(input, ' extra');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('Social templates');
    await sleep(800);
    expect(calls('patch_task')).toEqual([]);
  });

  it('keeps focus and the typed text through a clock tick and a fresh snapshot', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Social templates' }));
    const input = screen.getByRole('textbox', { name: 'Task name' });
    await user.type(input, ' draft');
    // Another device renames the task; a state-changed event refreshes the snapshot.
    taskNamed('Social templates').name = 'Renamed elsewhere';
    await act(async () => {
      await emit('state-changed');
    });
    await sleep(1300); // at least one tick of the app clock
    const same = screen.getByRole('textbox', { name: 'Task name' });
    expect(same).toBe(input);
    expect(same).toHaveFocus();
    expect(same).toHaveValue('Social templates draft');
  });

  it('flushes a pending edit at once when the backend asks, and when the page hides', async () => {
    const user = userEvent.setup();
    boot(demoState());
    await user.click(await screen.findByRole('button', { name: 'Edit Social templates' }));
    await user.type(screen.getByRole('textbox', { name: 'Task name' }), ' one');
    await act(async () => {
      await emit('flush-edits');
    });
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 400 });
    expect(calls('patch_task')[0]).toMatchObject({ patch: { name: 'Social templates one' } });

    await user.type(screen.getByRole('textbox', { name: 'Task name' }), ' two');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(calls('patch_task')).toHaveLength(2), { timeout: 400 });
    expect(calls('patch_task')[1]).toMatchObject({ patch: { name: 'Social templates one two' } });
  });

  it('edit from a timeline entry opens the same editor on the task card', async () => {
    const user = userEvent.setup();
    boot(demoState());
    const buttons = await screen.findAllByRole('button', { name: 'Edit task Logo concepts' });
    await user.click(buttons[0] as HTMLElement);
    const form = await screen.findByRole('form', { name: 'Editing Logo concepts' });
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveFocus();
  });

  it('a stopped task\'s edit shows in the timeline', async () => {
    const user = userEvent.setup();
    const s = demoState();
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'Edit Homepage layout' }));
    await user.type(screen.getByRole('textbox', { name: 'Task name' }), ' final');
    await waitFor(() => expect(calls('patch_task')).toHaveLength(1), { timeout: 2000 });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect((await screen.findAllByRole('button', { name: 'Edit task Homepage layout final' })).length).toBeGreaterThan(0);
  });
});

describe('continuation links on the timeline', () => {
  it('shows Continued from and Continued by on entries and moves to that task', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.tasks.push({ id: 't-v2', name: 'Logo v2', projectId: 'p-brand', description: null, state: 'paused', pauseReason: { kind: 'user' }, createdAt: '2026-03-12T10:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: 't-guide' });
    s.segments.push({ id: 'seg-v2', taskId: 't-v2', deviceId: '11111111-1111-4111-8111-111111111111', start: '2026-03-12T10:40:00Z', end: '2026-03-12T11:10:00Z', provisionalEnd: null });
    boot(s);
    const day = await screen.findByRole('article', { name: 'Thu 12 Mar 2026', hidden: false });
    const entry = within(day).getAllByTestId('entry').find((e) => e.textContent?.includes('Logo v2')) as HTMLElement;
    const from = within(entry).getByRole('button', { name: 'Brand guidelines' });
    expect(entry).toHaveTextContent('Continued from');
    await user.click(from);
    await waitFor(() => expect(screen.getByRole('article', { name: 'Brand guidelines' })).toHaveFocus());
    // And the other way: entries of the earlier task point at its continuation.
    const earlier = (await screen.findAllByTestId('entry')).find((e) => e.textContent?.includes('Brand guidelines') && e.textContent?.includes('Continued by')) as HTMLElement;
    expect(within(earlier).getByRole('button', { name: 'Logo v2' })).toBeVisible();
  });
});

describe('error boundary', () => {
  function Boom(): never {
    throw new Error('boom');
  }
  it('replaces a crashed window with a plain message and a Reload button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('Your data is safe');
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('renders its children when nothing fails', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeVisible();
  });
});
