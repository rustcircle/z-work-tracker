// The setup wizard while another computer holds the lease (design test 70, second half). The wizard stands in for the Shell, so it
// shows the lease line itself, with the way to take over. The steps that write data shared between computers say whose those are
// and write nothing; what belongs to this computer alone stays open.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { emptyState, loseLease, seedLease, type LeaseSeed, type MockState } from '../../mocks/ipcMock';
import { STEPS, type StepId } from './setupSteps';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

const NOTE = 'These follow LAPTOP. You can change them after taking over.';
const SHARED_WRITES = ['set_setting', 'set_rounding', 'create_project', 'set_rate', 'save_shift'];

/** A fresh store, with nothing connected. */
function fresh(at: StepId = 'welcome'): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.setupDone = false;
  s.syncPromptDone = false;
  s.clientZonePromptDone = false;
  s.settings = {};
  s.setupStep = STEPS.indexOf(at);
  return s;
}

/**
 * A store partway through setup whose connected folder says LAPTOP holds the lease. A saved step past the first is what keeps the
 * wizard up once a folder is connected, as it does when a folder is connected during setup.
 */
function behind(kind: LeaseSeed, at: StepId = 'theme'): MockState {
  const s = fresh(at);
  seedLease(s, kind);
  return s;
}

const cmds = (s: MockState) => s.calls.map((c) => c.cmd);
const wizard = () => screen.getByTestId('setup-wizard');
const step = () => wizard().getAttribute('data-step');
const next = (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: 'Next' }));

async function takeOver(u: ReturnType<typeof userEvent.setup>): Promise<void> {
  await u.click(await screen.findByRole('button', { name: 'Take over…' }));
  const first = await screen.findByRole('dialog', { name: /^Take over from/ });
  await waitFor(() => expect(within(first).getByRole('button', { name: 'Continue' })).toBeEnabled());
  await u.click(within(first).getByRole('button', { name: 'Continue' }));
  await u.click(within(await screen.findByRole('dialog', { name: 'Are you sure?' })).getByRole('button', { name: 'Take over' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /Take over from|Are you sure/ })).toBeNull());
}

describe('the lease line in the wizard', () => {
  it('is shown inside the wizard, which has no Shell, with the way to look again, and with no way to take over while the other computer looks in use', async () => {
    boot(behind('live'));
    await screen.findByTestId('setup-wizard');
    const line = await screen.findByTestId('lease-banner');
    expect(wizard()).toContainElement(line);
    expect(within(line).getByTestId('lease-text')).toHaveTextContent(/^Read-only\. LAPTOP is using zWorkTracker \(last seen 1 min ago\)\./);
    expect(within(line).getAllByRole('button').map((b) => b.textContent)).toEqual(['Check again']);
  });

  it('is shown inside the wizard with the way to look again and to take over, once the other computer looks inactive', async () => {
    boot(behind('stale'));
    await screen.findByTestId('setup-wizard');
    const line = await screen.findByTestId('lease-banner');
    expect(wizard()).toContainElement(line);
    expect(within(line).getByTestId('lease-text')).toHaveTextContent(/^Read-only\. LAPTOP looks inactive: nothing from it for 40 min\./);
    expect(within(line).getAllByRole('button').map((b) => b.textContent)).toEqual(['Check again', 'Take over…']);
  });

  it.each<LeaseSeed>(['live', 'stale', 'unknown'])('is shown when the lease is %s, and the shared steps follow the other computer', async (kind) => {
    const s = behind(kind, 'rules');
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(await screen.findByTestId('lease-banner')).toBeVisible();
    expect(wizard()).toHaveTextContent(NOTE);
  });

  it.each<LeaseSeed>(['mine', 'free', 'checking'])('is not shown when this computer may change things (%s)', async (kind) => {
    const s = behind(kind, 'rules');
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(step()).toBe('rules');
    expect(screen.queryByTestId('lease-banner')).toBeNull();
    expect(wizard()).not.toHaveTextContent(NOTE);
    expect(within(wizard()).getByRole('combobox', { name: 'Increment' })).toBeEnabled();
  });

  it('says so, and keeps every step open, when no folder can be read but nobody else held the lease', async () => {
    const s = behind('unknown-writable', 'rules');
    boot(s);
    await screen.findByTestId('setup-wizard');
    const line = await screen.findByTestId('lease-banner');
    expect(within(line).getByTestId('lease-text')).toHaveTextContent("The sync folder can't be reached, so this computer can't check whether another one is in use. You can keep working.");
    expect(wizard()).not.toHaveTextContent(NOTE);
    expect(within(wizard()).getByRole('combobox', { name: 'Increment' })).toBeEnabled();
  });

  it('is not shown with no folder, which is every first run', async () => {
    boot(fresh());
    await screen.findByTestId('setup-wizard');
    expect(screen.queryByTestId('lease-banner')).toBeNull();
  });
});

describe('the steps that write shared data, while another computer holds the lease', () => {
  it('say whose they are, offer no way to change them, and write nothing; the rest of setup goes on', async () => {
    const user = userEvent.setup();
    const s = behind('live');
    boot(s);
    await screen.findByTestId('setup-wizard');
    // The theme belongs to this computer alone, so it stays open.
    expect(step()).toBe('theme');
    expect(wizard()).not.toHaveTextContent(NOTE);
    expect(within(wizard()).getByRole('radio', { name: /^Dark$/ })).toBeEnabled();
    await next(user);

    expect(step()).toBe('zones');
    expect(within(wizard()).getByText(NOTE)).toBeVisible();
    // What the zones are now is still shown, but there is no way to change them.
    expect(screen.getByTestId('wizard-my-zone')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change my zone' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose client zone' })).toBeDisabled();
    await next(user);

    expect(step()).toBe('rules');
    expect(within(wizard()).getByText(NOTE)).toBeVisible();
    expect(within(wizard()).queryByRole('combobox', { name: 'Increment' })).toBeNull();
    // The rule in force is shown, as it stands.
    expect(screen.getByTestId('rule-sentence')).toHaveTextContent(/blocks of 15 minutes/);
    await next(user);

    expect(step()).toBe('project');
    expect(within(wizard()).getByText(NOTE)).toBeVisible();
    expect(within(wizard()).queryByRole('textbox', { name: 'Project name' })).toBeNull();
    await next(user);

    expect(step()).toBe('shifts');
    expect(within(wizard()).getByText(NOTE)).toBeVisible();
    expect(within(wizard()).queryByRole('checkbox')).toBeNull();
    await next(user);

    // The folder is connected, so that step is not asked; Start with Windows is this computer's own.
    expect(step()).toBe('autostart');
    expect(wizard()).not.toHaveTextContent(NOTE);
    await next(user);
    expect(step()).toBe('summary');
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await screen.findByRole('tab', { name: 'Timeline' });

    expect(cmds(s).filter((c) => SHARED_WRITES.includes(c))).toEqual([]);
    expect(cmds(s)).toContain('finish_setup');
    expect(s.setupDone).toBe(true);
    expect(s.projects).toEqual([]);
    expect(s.shifts).toEqual([]);
    expect(s.rounding).toEqual([]);
  });

  it('use the name of the computer that holds the lease', async () => {
    const s = behind('live', 'zones');
    s.lease = { ...s.lease, holder: s.lease.holder && { ...s.lease.holder, deviceName: 'Office PC' } };
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(await within(wizard()).findByText('These follow Office PC. You can change them after taking over.')).toBeVisible();
  });

  it('write nothing that was typed before another computer took the lease partway through the step', async () => {
    const user = userEvent.setup();
    const s = behind('mine', 'project');
    boot(s);
    await screen.findByTestId('setup-wizard');
    await user.type(await screen.findByRole('textbox', { name: 'Project name' }), 'Brand refresh');
    await act(async () => {
      loseLease(s);
      await emit('state-changed');
    });
    expect(await within(wizard()).findByText(NOTE)).toBeVisible();
    expect(within(wizard()).queryByRole('textbox', { name: 'Project name' })).toBeNull();
    await next(user);
    await waitFor(() => expect(step()).toBe('shifts'));
    expect(cmds(s)).not.toContain('create_project');
    expect(s.projects).toEqual([]);
  });

  it('give the controls back when this computer takes over from the line in the wizard', async () => {
    const user = userEvent.setup();
    const s = behind('stale', 'rules');
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(within(wizard()).queryByRole('combobox', { name: 'Increment' })).toBeNull();

    await takeOver(user);
    await waitFor(() => expect(screen.queryByTestId('lease-banner')).toBeNull());
    expect(wizard()).not.toHaveTextContent(NOTE);
    const increment = within(wizard()).getByRole('combobox', { name: 'Increment' });
    await user.selectOptions(increment, '30');
    await next(user);
    await waitFor(() => expect(step()).toBe('project'));
    expect(s.rounding.at(-1)).toMatchObject({ incrementMinutes: 30 });
    expect(within(wizard()).getByRole('textbox', { name: 'Project name' })).toBeEnabled();
  });
});
