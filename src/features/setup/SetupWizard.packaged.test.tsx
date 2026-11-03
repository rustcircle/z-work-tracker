// The setup wizard in the Microsoft Store build (design test 70, first half). That build keeps its files in a private Windows folder
// that uninstalling removes, so the cloud folder step asks firmly for a folder, says what skipping means and asks before it lets go.
// Two folders are recommended there, never required. The installer build keeps its words and gains one sentence.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { emptyState, handle, type MockState } from '../../mocks/ipcMock';
import { STEPS, type StepId } from './setupSteps';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

const ONE_DRIVE = 'C:\\Users\\me\\OneDrive';
const GOOGLE_DRIVE = 'G:\\My Drive';

const STRONG =
  'Choose a cloud folder. The Microsoft Store version keeps its files privately, and Windows removes them when the app is uninstalled. A OneDrive or Google Drive folder is what keeps your hours safe. Two folders are better: pick both if you use both.';
const ASK_BODY = 'If you uninstall the app without one, your hours are gone. You can connect a folder later in Settings.';

/** A first computer: a fresh store with OneDrive and Google Drive installed, and nothing connected. */
function fresh(packaged: boolean, at: StepId = 'welcome'): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.setupDone = false;
  s.syncPromptDone = false;
  s.clientZonePromptDone = false;
  s.settings = {};
  s.packaged = packaged;
  s.setupStep = STEPS.indexOf(at);
  s.detected = [
    { provider: 'oneDrive', root: ONE_DRIVE, source: 'the OneDrive folder' },
    { provider: 'googleDrive', root: GOOGLE_DRIVE, source: 'a mounted drive' },
  ];
  return s;
}

const cmds = (s: MockState) => s.calls.map((c) => c.cmd);
const wizard = () => screen.getByTestId('setup-wizard');
const step = () => wizard().getAttribute('data-step');
const question = () => screen.queryByRole('dialog', { name: 'Continue without a folder?' });
const asked = () => screen.findByRole('dialog', { name: 'Continue without a folder?' });

describe('the cloud folder step in the Microsoft Store build', () => {
  it('asks for a cloud folder in firm words, recommends two, and requires neither', async () => {
    const s = fresh(true, 'sync');
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(step()).toBe('sync');
    expect(screen.getByTestId('wizard-folder-urged')).toHaveTextContent(STRONG);
    expect(screen.getByTestId('wizard-progress')).toHaveTextContent(/^Step \d+ of \d+ \(recommended\)$/);
    expect(within(wizard()).queryByText(/^Optional\./)).toBeNull();
    // Both folders can be ticked, nothing is ticked for the person, and the step can still be left.
    const boxes = within(wizard()).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled();
    expect(s.targets).toEqual([]);
  });

  it('connects one folder and moves on without asking, and a second is a choice and not a demand', async () => {
    const user = userEvent.setup();
    const s = fresh(true, 'sync');
    boot(s);
    await screen.findByTestId('setup-wizard');
    await user.click(within(wizard()).getByRole('checkbox', { name: /OneDrive folder/ }));
    await user.click(screen.getByRole('button', { name: 'Connect folder' }));
    await waitFor(() => expect(step()).toBe('autostart'));
    expect(s.targets.map((t) => t.root)).toEqual([ONE_DRIVE]);
    expect(question()).toBeNull();
  });

  it('connects both folders when both are ticked', async () => {
    const user = userEvent.setup();
    const s = fresh(true, 'sync');
    boot(s);
    await screen.findByTestId('setup-wizard');
    await user.click(within(wizard()).getByRole('checkbox', { name: /OneDrive folder/ }));
    await user.click(within(wizard()).getByRole('checkbox', { name: /Google Drive folder/ }));
    await user.click(screen.getByRole('button', { name: 'Connect 2 folders' }));
    await waitFor(() => expect(step()).toBe('autostart'));
    expect(s.targets.map((t) => t.root)).toEqual([ONE_DRIVE, GOOGLE_DRIVE]);
    expect(question()).toBeNull();
  });

  it('asks before Skip lets go of it: Cancel and Escape stay, the confirm button goes on', async () => {
    const user = userEvent.setup();
    const s = fresh(true, 'sync');
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    const dialog = await asked();
    expect(dialog).toHaveTextContent(ASK_BODY);
    // Nothing has moved, and nothing was written.
    expect(step()).toBe('sync');
    expect(cmds(s)).not.toContain('add_sync_target');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(question()).toBeNull();
    expect(step()).toBe('sync');

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await asked();
    await user.keyboard('{Escape}');
    expect(question()).toBeNull();
    expect(step()).toBe('sync');

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await user.click(within(await asked()).getByRole('button', { name: 'Continue without a folder' }));
    await waitFor(() => expect(step()).toBe('autostart'));
    expect(question()).toBeNull();
    expect(s.targets).toEqual([]);
  });

  it('asks when Finish with defaults would end setup before the folder step, and Cancel keeps the person in setup', async () => {
    const user = userEvent.setup();
    const s = fresh(true);
    boot(s);
    await user.click(await screen.findByTestId('finish-defaults'));
    const dialog = await asked();
    expect(dialog).toHaveTextContent(ASK_BODY);
    expect(cmds(s)).not.toContain('finish_setup');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(question()).toBeNull();
    expect(step()).toBe('welcome');
    expect(s.setupDone).toBe(false);

    await user.click(screen.getByTestId('finish-defaults'));
    await user.click(within(await asked()).getByRole('button', { name: 'Continue without a folder' }));
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(s.setupDone).toBe(true);
    // The Store build's warning is the backend's, and Finish with defaults leaves it up.
    expect(screen.getByTestId('warning')).toHaveTextContent('keeps its data in a private Windows folder');
  });

  it('does not ask again once the folder step is behind', async () => {
    const user = userEvent.setup();
    const s = fresh(true, 'autostart');
    boot(s);
    await user.click(await screen.findByTestId('finish-defaults'));
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(question()).toBeNull();
    expect(s.setupDone).toBe(true);
  });

  it('does not ask a computer that already has a folder, and does not show it the step', async () => {
    const user = userEvent.setup();
    // Partway through setup, as it is when the folder was connected during it.
    const s = fresh(true, 'theme');
    handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
    boot(s);
    await screen.findByTestId('setup-wizard');
    // The step is answered by the connection, so it is not walked through.
    while (step() !== 'summary') await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByTestId('wizard-folder-urged')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByTestId('finish-defaults'));
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(question()).toBeNull();
    expect(s.setupDone).toBe(true);
  });

  it('puts the same question to someone running setup again with no folder, and not to Exit setup', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.packaged = true;
    s.targets = [];
    s.detected = fresh(true).detected;
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Run setup again' }));
    await user.click(screen.getByRole('button', { name: 'Run setup' }));
    while (step() !== 'sync') await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('wizard-folder-urged')).toHaveTextContent(STRONG);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await asked();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    // Leaving a rerun changes nothing, so it is not the question's business.
    await user.click(screen.getByTestId('finish-defaults'));
    await screen.findByRole('tab', { name: 'Settings' });
    expect(question()).toBeNull();
    expect(cmds(s)).not.toContain('finish_setup');
  });
});

describe('setup run again by someone who already has a folder in the Store build', () => {
  it('is not urged: the step is optional, offers a second folder, and Skip goes without a question', async () => {
    const user = userEvent.setup();
    const s = demoState();
    s.packaged = true;
    s.detected = fresh(true).detected;
    handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
    boot(s);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Run setup again' }));
    await user.click(screen.getByRole('button', { name: 'Run setup' }));
    while (step() !== 'sync') await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.queryByTestId('wizard-folder-urged')).toBeNull();
    expect(within(wizard()).getByText(/^Optional\. To use zWorkTracker on two computers/)).toHaveTextContent('Connecting both OneDrive and Google Drive keeps a working copy in each.');
    expect(screen.getByTestId('wizard-progress')).toHaveTextContent(/\(optional\)$/);
    // Only the folder that is not connected yet is offered.
    expect(within(wizard()).getAllByRole('checkbox')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(step()).toBe('autostart'));
    expect(question()).toBeNull();
  });
});

describe('the cloud folder step in the installer build', () => {
  it('keeps its words, adds the sentence about two folders, and calls the step optional', async () => {
    const s = fresh(false, 'sync');
    boot(s);
    await screen.findByTestId('setup-wizard');
    expect(step()).toBe('sync');
    expect(screen.queryByTestId('wizard-folder-urged')).toBeNull();
    const body = within(wizard()).getByText(/^Optional\. To use zWorkTracker on two computers/);
    expect(body).toHaveTextContent(
      'Optional. To use zWorkTracker on two computers, it can write its data into a OneDrive or Google Drive folder. Nothing is switched on unless you tick a folder and connect it. Connecting both OneDrive and Google Drive keeps a working copy in each.',
    );
    expect(screen.getByTestId('wizard-progress')).toHaveTextContent(/^Step \d+ of \d+ \(optional\)$/);
  });

  it('lets Skip and Finish with defaults go without a question', async () => {
    const user = userEvent.setup();
    const s = fresh(false, 'sync');
    boot(s);
    await user.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(step()).toBe('autostart'));
    expect(question()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByTestId('finish-defaults'));
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(question()).toBeNull();
    expect(screen.queryByTestId('warning')).toBeNull();
  });
});

describe('the Start with Windows step', () => {
  it('does not say the app starts hidden in the system tray: it opens when you sign in', async () => {
    for (const packaged of [false, true]) {
      const s = fresh(packaged, 'autostart');
      const view = boot(s);
      await screen.findByTestId('setup-wizard');
      expect(step()).toBe('autostart');
      const text = wizard().textContent ?? '';
      expect(text).not.toMatch(/system tray|hidden/i);
      expect(text).toContain('zWorkTracker opens when you sign in to Windows');
      expect(text).toContain('It changes only this computer.');
      view.unmount();
      clearMocks();
    }
  });
});
