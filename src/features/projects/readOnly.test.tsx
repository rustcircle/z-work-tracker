// Projects while another computer holds the lease: what changes shared data is off, with the reason; what is only looked at is not,
// and a form that was being filled in keeps what was typed for after a take over.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOnlyMessage } from '../../app/useReadOnly';
import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoP2State, demoState } from '../../mocks/demoSeed';
import { leaseView, loseLease, seedLease, type LeaseSeed, type MockState } from '../../mocks/ipcMock';

const WHY = readOnlyMessage('LAPTOP');

let state: MockState;
beforeEach(() => {
  polyfillDom();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  clearMocks();
  window.localStorage.clear();
});

const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const arrives = (change: () => unknown) =>
  act(async () => {
    await change();
    await emit('state-changed');
  });
const takeOver = () => {
  const holder = leaseView(state).holder;
  if (!holder) throw new Error('nobody holds the lease');
  return api.leaseTakeOver({ generation: holder.generation, beatSeq: holder.beatSeq }, 'live');
};

async function openProjects(s: MockState, lease: LeaseSeed) {
  state = s;
  seedLease(s, lease);
  const user = userEvent.setup();
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Projects' }));
  return user;
}
const rowOf = (name: string) => {
  const row = screen
    .getAllByRole('heading', { level: 3 })
    .find((h) => h.textContent === name)
    ?.closest('li');
  if (!row) throw new Error(`no project row for ${name}`);
  return within(row);
};

describe('the Projects tab', () => {
  it('can not create, archive, restore or delete while read-only, each saying why, and still opens an editor to look', async () => {
    const s = demoP2State();
    const user = await openProjects(s, 'live');
    expect(screen.getByRole('button', { name: 'New project' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New project' })).toHaveAttribute('title', WHY);
    expect(rowOf('Brand refresh').getByRole('button', { name: /^Archive/ })).toBeDisabled();
    expect(rowOf('Brand refresh').getByRole('button', { name: /^Archive/ })).toHaveAttribute('title', WHY);
    // Editing is only looking until Save, so the editor opens.
    const edit = rowOf('Brand refresh').getByRole('button', { name: /^Edit/ });
    expect(edit).toBeEnabled();
    await user.click(edit);
    const form = within(screen.getByRole('form', { name: 'Edit project Brand refresh' }));
    expect(form.getByRole('button', { name: 'Save project' })).toBeDisabled();
    expect(form.getByRole('button', { name: 'Save project' })).toHaveAttribute('title', WHY);
    expect(form.getByRole('status')).toHaveTextContent(WHY);
    for (const remove of form.getAllByRole('button', { name: /^Remove/ })) {
      expect(remove).toBeDisabled();
      expect(remove).toHaveAttribute('title', WHY);
    }
    expect(form.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(calls('update_project')).toEqual([]);
  });

  it('a project with no tasks can not be deleted, and a deleted-draft dialog already open says why', async () => {
    const s = demoState();
    s.projects.push({ id: 'p-new', name: 'Empty one', color: '#123456', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', hasTasks: false });
    const user = await openProjects(s, 'mine');
    await user.click(rowOf('Empty one').getByRole('button', { name: /^Delete/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this project?' });
    expect(within(dialog).getByRole('button', { name: 'Delete project' })).toBeEnabled();
    await arrives(() => loseLease(state));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete project' })).toBeDisabled());
    expect(within(dialog).getByText(WHY)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(rowOf('Empty one').getByRole('button', { name: /^Delete/ })).toBeDisabled();
    expect(calls('delete_project')).toEqual([]);
  });

  it('is as it always was with no folder', async () => {
    state = demoState();
    bootApp(state);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Projects' }));
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'New project' })).not.toHaveAttribute('title');
    expect(rowOf('Brand refresh').getByRole('button', { name: /^Archive/ })).toBeEnabled();
  });
});

describe('a project form', () => {
  it('keeps what was typed when the lease goes, can not be sent meanwhile, and saves after a take over', async () => {
    const s = demoState();
    const user = await openProjects(s, 'mine');
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const form = within(screen.getByRole('form', { name: 'New project' }));
    await user.type(form.getByRole('textbox', { name: 'Project name' }), 'Retail');
    await user.type(form.getByLabelText('Price'), '75');
    expect(form.getByRole('button', { name: 'Create project' })).toBeEnabled();

    await arrives(() => loseLease(s));
    await waitFor(() => expect(form.getByRole('button', { name: 'Create project' })).toBeDisabled());
    expect(form.getByRole('textbox', { name: 'Project name' })).toHaveValue('Retail');
    expect(form.getByLabelText('Price')).toHaveValue('75');
    expect(form.getByRole('status')).toHaveTextContent(WHY);
    // The button that opened it is off, but the form can still be left with its own Cancel.
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled();
    await user.type(form.getByRole('textbox', { name: 'Project name' }), ' shop{Enter}');
    expect(calls('create_project')).toEqual([]);
    expect(form.getByRole('textbox', { name: 'Project name' })).toHaveValue('Retail shop');

    await arrives(takeOver);
    await waitFor(() => expect(form.getByRole('button', { name: 'Create project' })).toBeEnabled());
    expect(form.queryByRole('status')).toBeNull();
    await user.click(form.getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(calls('create_project')).toHaveLength(1));
    expect(s.projects.find((p) => p.name === 'Retail shop')).toBeDefined();
    expect(calls('set_rate')).toHaveLength(1);
  });
});
