import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { DEVICE_ID, emptyState, type MockState } from '../../mocks/ipcMock';
import { fullProject } from '../../mocks/factories';
import { STEPS } from './setupSteps';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

function fresh(): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.setupDone = false;
  s.syncPromptDone = false;
  s.clientZonePromptDone = false;
  s.settings = {};
  return s;
}
const cmds = (s: MockState) => s.calls.map((c) => c.cmd);
const wizard = () => screen.getByTestId('setup-wizard');
const step = () => wizard().getAttribute('data-step');
const heading = () => within(wizard()).getByRole('heading', { level: 1 });

/** A second computer: a detected OneDrive folder that already holds this user's data. */
function secondPc(): MockState {
  const s = fresh();
  const root = 'C:\\Users\\u\\OneDrive\\zWorkTracker';
  s.detected = [{ provider: 'oneDrive', root, source: 'the OneDrive folder' }];
  s.folders[root] = {
    devices: ['Office PC'],
    counts: { projects: 2, tasks: 5, segments: 40 },
    available: true,
    data: {
      projects: [fullProject({ id: 'p-office', name: 'Office project', color: '#2563eb' })],
      settings: { ...s.settings, myZone: 'Europe/Lisbon' },
      rounding: [{ id: 'r1', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp: { at: '2026-01-01T00:00:00Z', by: DEVICE_ID } }],
      shifts: [],
    },
  };
  return s;
}

describe('first-run wizard', () => {
  it('opens on a fresh store, replaces the one-time prompts and shows nothing of the app behind it', async () => {
    boot(fresh());
    await screen.findByTestId('setup-wizard');
    expect(step()).toBe('welcome');
    expect(heading()).toHaveTextContent('Welcome');
    expect(heading()).toHaveFocus();
    expect(screen.queryByRole('tab', { name: 'Timeline' })).toBeNull();
    // Neither the sync opt-in nor the client zone question appears next to it.
    expect(screen.queryByText(/Sync between your computers/i)).toBeNull();
    expect(screen.getByTestId('wizard-progress')).toHaveTextContent(/^Step 1 of /);
  });

  it('finishes in one click from the first step, keeps every default and writes no setting', async () => {
    const user = userEvent.setup();
    const s = fresh();
    boot(s);
    await user.click(await screen.findByTestId('finish-defaults'));
    await waitFor(() => expect(screen.queryByTestId('setup-wizard')).toBeNull());
    expect(await screen.findByRole('tab', { name: 'Timeline' })).toBeVisible();
    expect(cmds(s)).toContain('finish_setup');
    expect(cmds(s).filter((c) => ['set_setting', 'set_rounding', 'create_project', 'save_shift', 'add_sync_target', 'set_autostart', 'set_theme'].includes(c))).toEqual([]);
    expect(s.setupDone).toBe(true);
    expect(s.tasks).toEqual([]);
    expect(s.segments).toEqual([]);
    // No stray prompt afterwards: the one-time prompts count as answered.
    expect(screen.queryByText(/Sync between your computers/i)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is shown once: it does not come back after finishing, and an existing user never sees it', async () => {
    const user = userEvent.setup();
    const s = fresh();
    const first = boot(s);
    await user.click(await screen.findByTestId('finish-defaults'));
    await screen.findByRole('tab', { name: 'Timeline' });
    first.unmount();
    boot(s);
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
    clearMocks();
    boot(emptyState());
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
  });

  it('walks every step with Next, saves the step as it goes, and ends on a summary of the defaults', async () => {
    const user = userEvent.setup();
    const s = fresh();
    boot(s);
    await screen.findByTestId('setup-wizard');
    const seen: string[] = [];
    while (step() !== 'summary') {
      seen.push(step() ?? '');
      if (step() === 'sync') await user.click(screen.getByRole('button', { name: 'Skip' }));
      else await user.click(screen.getByRole('button', { name: 'Next' }));
    }
    expect(step()).toBe('summary');
    expect(seen).toEqual(['welcome', 'theme', 'zones', 'rules', 'project', 'shifts', 'sync', 'autostart']);
    const summary = within(screen.getByTestId('wizard-summary'));
    expect(summary.getByText('None yet')).toBeVisible();
    expect(s.setupStep).toBe(STEPS.indexOf('summary'));
    // Nothing was ticked, typed or chosen, so nothing but the step was written.
    expect(cmds(s).filter((c) => ['create_project', 'save_shift', 'add_sync_target', 'set_rounding'].includes(c))).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await screen.findByRole('tab', { name: 'Timeline' });
  });

  it('goes back, and skips without changing anything', async () => {
    const user = userEvent.setup();
    const s = fresh();
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(step()).toBe('theme');
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(step()).toBe('zones');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(step()).toBe('theme');
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeNull();
  });

  it('never turns anything on without a tick: sync lists detected folders unticked, shifts start unticked', async () => {
    const user = userEvent.setup();
    const s = fresh();
    s.detected = [{ provider: 'oneDrive', root: 'C:\\OneDrive\\x', source: 'the OneDrive folder' }];
    boot(s);
    await screen.findByTestId('setup-wizard');
    while (step() !== 'shifts') await user.click(screen.getByRole('button', { name: 'Next' }));
    for (const box of within(screen.getByRole('list', { name: 'Shift presets' })).getAllByRole('checkbox')) expect(box).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('sync');
    for (const box of within(wizard()).getAllByRole('checkbox')) expect(box).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(step()).toBe('autostart');
    expect(s.targets).toEqual([]);
    expect(s.autostart).toBe(false);
  });

  it('writes the time rule, the first project with its price, and ticked shifts through the normal commands', async () => {
    const user = userEvent.setup();
    const s = fresh();
    boot(s);
    await screen.findByTestId('setup-wizard');
    while (step() !== 'rules') await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('rule-sentence')).toHaveTextContent(/blocks of 15 minutes/);
    await user.selectOptions(within(wizard()).getByRole('combobox', { name: 'Increment' }), '30');
    expect(screen.getByTestId('rule-sentence')).toHaveTextContent(/blocks of 30 minutes/);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('project');
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'Brand refresh');
    await user.type(screen.getByRole('textbox', { name: 'Price per hour' }), '60');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('shifts');
    expect(s.projects.map((p) => p.name)).toEqual(['Brand refresh']);
    await user.click(within(screen.getByRole('list', { name: 'Shift presets' })).getByRole('checkbox', { name: /Morning/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('sync');
    expect(s.shifts.map((v) => v.name)).toEqual(['Morning']);
    expect(s.rounding.at(-1)).toMatchObject({ incrementMinutes: 30, method: 'up' });
    expect(s.rates.some((r) => r.rateCents === 6000)).toBe(true);
    // Going back over the project step does not create it twice.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(step()).toBe('project');
    expect(screen.getByTestId('project-made')).toBeVisible();
    expect(s.projects).toHaveLength(1);
  });

  it('refuses a duplicate project name on the step, with the reason, and goes nowhere', async () => {
    const user = userEvent.setup();
    const s = emptyState('2026-03-12T15:20:00Z');
    s.projects.push(fullProject({ id: 'p1', name: 'Taken', color: '#2563eb' }));
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Run setup again' }));
    await user.click(screen.getByRole('button', { name: 'Run setup' }));
    while (step() !== 'project') await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByRole('textbox', { name: 'Project name' }), 'taken');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('project');
    expect(await screen.findByText(/already/i)).toBeVisible();
    expect(s.projects).toHaveLength(1);
  });

  it('resumes at the saved step after an interruption', async () => {
    const s = fresh();
    s.setupStep = STEPS.indexOf('shifts');
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(step()).toBe('shifts');
    expect(heading()).toHaveTextContent('Work shifts');
  });

  it('second computer: offers the folder first with counts, connects it, and skips what the merged data answers', async () => {
    const user = userEvent.setup();
    const s = secondPc();
    boot(s);
    await screen.findByTestId('setup-wizard');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('connect');
    expect(await screen.findByTestId('connect-counts')).toHaveTextContent('2 projects, 5 tasks, 40 time segments from Office PC');
    expect(s.targets).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Connect and bring it in' }));
    await waitFor(() => expect(step()).toBe('theme'));
    expect(s.targets).toHaveLength(1);
    // Still on screen although the backend now counts the sync prompt as answered.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Zones, rules and the project are answered by the merged data; the device-local theme was asked.
    expect(step()).toBe('shifts');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Sync is answered by the connection, Start with Windows is this device's own question.
    expect(step()).toBe('autostart');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('summary');
    expect(within(screen.getByTestId('wizard-summary')).getByText('Office project')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
  });

  it('second computer: Not now keeps the whole walk-through and connects nothing', async () => {
    const user = userEvent.setup();
    const s = secondPc();
    boot(s);
    await screen.findByTestId('setup-wizard');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByTestId('connect-offer');
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(step()).toBe('theme');
    expect(s.targets).toEqual([]);
    expect(s.projects).toEqual([]);
  });

  it('a folder with no data is not offered first', async () => {
    const user = userEvent.setup();
    const s = fresh();
    s.detected = [{ provider: 'oneDrive', root: 'C:\\OneDrive\\empty', source: 'the OneDrive folder' }];
    boot(s);
    await screen.findByTestId('setup-wizard');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('theme');
  });

  it('keeps the old one-time prompts for someone who updated before the wizard existed', async () => {
    const s = emptyState('2026-03-12T15:20:00Z');
    s.syncPromptDone = false;
    boot(s);
    expect(await screen.findByRole('heading', { name: /sync/i })).toBeVisible();
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
  });
});

describe('run setup again', () => {
  it('asks first, shows every step, changes nothing on Skip and Back, and leaves the saved step alone', async () => {
    const user = userEvent.setup();
    const s = emptyState('2026-03-12T15:20:00Z');
    s.projects.push(fullProject({ id: 'p1', name: 'Existing', color: '#2563eb' }));
    s.settings.myZone = 'Europe/Lisbon';
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Run setup again' }));
    const dialog = screen.getByRole('dialog', { name: 'Run setup again?' });
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('setup-wizard')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Run setup again' }));
    await user.click(screen.getByRole('button', { name: 'Run setup' }));
    expect(step()).toBe('welcome');
    // Every step is shown again, including the ones the data already answers.
    expect(screen.getByTestId('wizard-progress')).toHaveTextContent(`Step 1 of ${STEPS.length - 1}`);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(step()).toBe('zones');
    expect(cmds(s)).not.toContain('set_setup_step');
    await user.click(screen.getByTestId('finish-defaults'));
    await screen.findByRole('tab', { name: 'Settings' });
    expect(cmds(s)).not.toContain('finish_setup');
    expect(s.projects).toHaveLength(1);
    expect(s.settings.myZone).toBe('Europe/Lisbon');
  });
});
