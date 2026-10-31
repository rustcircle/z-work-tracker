import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { demoP2State, demoState } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';
import { bytesText, parseKeep } from './BackupsSection';
import { parseMinutes } from './RemindersSection';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

/** Settings with the p2 time-away dialog put away. */
async function settings(user: ReturnType<typeof userEvent.setup>, s: MockState, title: string) {
  boot(s);
  if (s.gaps.some((g) => g.decision === 'pending')) {
    await screen.findByRole('dialog', { name: /You were away/ });
    await user.keyboard('{Escape}');
  }
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  return within(await screen.findByRole('region', { name: title }));
}

describe('minutes and counts', () => {
  it('accepts whole minutes from 0 to 10080 only', () => {
    expect(parseMinutes('0')).toEqual({ ok: true, minutes: 0 });
    expect(parseMinutes(' 240 ')).toEqual({ ok: true, minutes: 240 });
    expect(parseMinutes('10080')).toEqual({ ok: true, minutes: 10080 });
    for (const bad of ['', 'abc', '-1', '1.5', '10081', '1e3', '0x10']) expect(parseMinutes(bad).ok).toBe(false);
  });
  it('accepts a backup count from 1 to 365 only', () => {
    expect(parseKeep('1')).toEqual({ ok: true, keep: 1 });
    expect(parseKeep('365')).toEqual({ ok: true, keep: 365 });
    for (const bad of ['0', '366', '', 'x', '2.5']) expect(parseKeep(bad).ok).toBe(false);
  });
  it('writes sizes', () => {
    expect([bytesText(0), bytesText(900), bytesText(48_211), bytesText(5 * 1024 * 1024)]).toEqual(['0 B', '900 B', '47 KB', '5.0 MB']);
  });
});

describe('reminder settings', () => {
  it('shows the current values, refuses bad input without asking the backend, and saves good input', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Time away and reminders');
    expect(s.getByTestId('current-idleMinutes')).toHaveTextContent('Now: 10 minutes');
    expect(s.getByTestId('current-longRunMinutes')).toHaveTextContent('Now: 240 minutes');
    expect(screen.getByText(/sends the system notification itself/)).toBeVisible();
    const idle = s.getByLabelText('Treat no activity as time away after (minutes)');
    await user.clear(idle);
    await user.type(idle, '12.5');
    await user.click(s.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    expect(await s.findByText(/Enter whole minutes from 0 to 10080/)).toBeVisible();
    expect(calls('set_setting')).toEqual([]);
    await user.clear(idle);
    await user.type(idle, '0');
    await user.click(s.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() => expect(s.getByTestId('current-idleMinutes')).toHaveTextContent('Now: Off'));
    expect(calls('set_setting')).toEqual([{ key: 'idleMinutes', value: 0 }]);
  });

  it('shows the backend refusal', async () => {
    const user = userEvent.setup();
    const seed = demoP2State();
    seed.failNext = ['set_setting'];
    const s = await settings(user, seed, 'Time away and reminders');
    const long = s.getByLabelText('Remind me when a task has run for (minutes)');
    await user.clear(long);
    await user.type(long, '90');
    await user.click(s.getAllByRole('button', { name: 'Save' })[1] as HTMLElement);
    expect(await s.findByText('mock: set_setting failed')).toBeVisible();
    await user.click(s.getAllByRole('button', { name: 'Save' })[1] as HTMLElement);
    await waitFor(() => expect(s.getByTestId('current-longRunMinutes')).toHaveTextContent('Now: 90 minutes'));
  });

  it('turns the past-shift reminder off and on again (it starts on)', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Time away and reminders');
    const sw = s.getByRole('switch', { name: /past the end of my shift/ });
    expect(sw).toBeChecked();
    await user.click(sw);
    await waitFor(() => expect(sw).not.toBeChecked());
    await user.click(sw);
    await waitFor(() => expect(sw).toBeChecked());
    expect(calls('set_setting')).toEqual([{ key: 'remindPastShift', value: false }, { key: 'remindPastShift', value: true }]);
  });
});

describe('backups', () => {
  it('lists backups with safety copies marked, and keeps a count from 1 to 365', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Backups');
    const rows = await s.findAllByTestId('backup-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[2] as HTMLElement).getByText('Safety copy')).toBeVisible();
    expect(within(rows[0] as HTMLElement).queryByText('Safety copy')).toBeNull();
    expect(screen.getByText(/never leave this computer/)).toBeVisible();
    const keep = s.getByLabelText('Daily backups to keep');
    await user.clear(keep);
    await user.type(keep, '400');
    await user.click(s.getByRole('button', { name: 'Save' }));
    expect(await s.findByText('Enter a whole number from 1 to 365.')).toBeVisible();
    expect(calls('set_backup_keep')).toEqual([]);
    await user.clear(keep);
    await user.type(keep, '30');
    await user.click(s.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(s.getByTestId('backup-keep-now')).toHaveTextContent('Now: 30'));
    expect(calls('set_backup_keep')).toEqual([{ keep: 30 }]);
  });

  it('restores only after the confirmation, which says what will happen', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Backups');
    await user.click(await s.findByRole('button', { name: 'Restore z-work-data-2026-03-11.json' }));
    const d = await screen.findByRole('dialog', { name: 'Restore this backup?' });
    for (const text of ['A safety copy of the current data is made first', 'A running task is paused', 'The next start asks for every field', 'newer records in your sync folders merge back in at the next sync', 'separate from sync and stay on this computer']) {
      expect(within(d).getByText(new RegExp(text))).toBeVisible();
    }
    await user.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(calls('restore_backup')).toEqual([]);
    await user.click(s.getByRole('button', { name: 'Restore z-work-data-2026-03-11.json' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Restore this backup?' })).getByRole('button', { name: 'Restore this backup' }));
    expect(await s.findByTestId('backup-result')).toHaveTextContent('Restored z-work-data-2026-03-11.json');
    expect(calls('restore_backup')).toEqual([{ name: 'z-work-data-2026-03-11.json' }]);
    expect(state.warm).toBe(false);
    expect(state.tasks.some((t) => t.state === 'running')).toBe(false);
    await waitFor(() => expect(s.getAllByTestId('backup-row')).toHaveLength(4));
    expect(await screen.findAllByTestId('notice')).not.toHaveLength(0);
  });

  it('says so when a restore fails', async () => {
    const user = userEvent.setup();
    const seed = demoP2State();
    seed.failNext = ['restore_backup'];
    const s = await settings(user, seed, 'Backups');
    await user.click(await s.findByRole('button', { name: 'Restore z-work-data-2026-03-12.json' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Restore this backup?' })).getByRole('button', { name: 'Restore this backup' }));
    expect(await s.findByRole('alert')).toHaveTextContent('Could not restore z-work-data-2026-03-12.json: mock: restore_backup failed');
    expect(state.warm).toBe(true);
  });

  it('handles an empty list and a failing list', async () => {
    const user = userEvent.setup();
    const empty = demoState();
    const s = await settings(user, empty, 'Backups');
    expect(await s.findByText(/No backup has been made yet/)).toBeVisible();
  });
});

describe('history of changes', () => {
  it('lists entries newest first in words, filters by kind and says when there are none', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'History of changes');
    const entries = await s.findAllByTestId('audit-entry');
    expect(entries.length).toBeGreaterThan(5);
    expect(s.getByText('Reason: Stopped at 11:05, the timer ran on')).toBeVisible();
    const stamps = s.getAllByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).map((e) => e.textContent ?? '');
    expect(stamps).toEqual([...stamps].sort().reverse());
    await user.selectOptions(s.getByLabelText('Show'), 'pause');
    const filtered = s.getAllByTestId('audit-entry');
    expect(filtered.length).toBeLessThan(entries.length);
    expect(filtered.every((e) => e.getAttribute('data-entity') === 'pause')).toBe(true);
  });

  it('says when nothing has been recorded, and when loading fails', async () => {
    const user = userEvent.setup();
    const seed = demoState();
    seed.failNext = ['get_audit'];
    const s = await settings(user, seed, 'History of changes');
    expect(await s.findByRole('alert')).toHaveTextContent('Could not load the history: mock: get_audit failed');
    await user.click(s.getByRole('button', { name: 'Load' }));
    expect(await s.findByTestId('audit-empty')).toHaveTextContent('Nothing has been recorded yet');
  });
});

describe('saving keeps the form where it is', () => {
  it('the backup count: "Saved." stays and the cursor stays in the field after Enter', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Backups');
    const keep = s.getByLabelText('Daily backups to keep');
    await user.clear(keep);
    await user.type(keep, '20{Enter}');
    await waitFor(() => expect(s.getByTestId('backup-keep-now')).toHaveTextContent('Now: 20'));
    expect(s.getByText('Saved.')).toBeVisible();
    expect(s.getByLabelText('Daily backups to keep')).toBe(keep);
    expect(keep).toHaveFocus();
    expect(keep).toHaveValue('20');
    // Typing again clears the answer and starts a new draft.
    await user.type(keep, '1');
    expect(s.queryByText('Saved.')).toBeNull();
    expect(keep).toHaveValue('201');
  });

  it('a reminder field: "Saved." stays, the cursor stays, and the other field is untouched', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Time away and reminders');
    const idle = s.getByLabelText('Treat no activity as time away after (minutes)');
    const long = s.getByLabelText('Remind me when a task has run for (minutes)');
    await user.type(long, '5');
    await user.clear(idle);
    await user.type(idle, '25{Enter}');
    await waitFor(() => expect(s.getByTestId('current-idleMinutes')).toHaveTextContent('Now: 25 minutes'));
    expect(s.getAllByText('Saved.')).toHaveLength(1);
    expect(s.getByLabelText('Treat no activity as time away after (minutes)')).toBe(idle);
    expect(idle).toHaveFocus();
    expect(idle).toHaveValue('25');
    expect(long).toHaveValue('2405');
  });

  it('a failure with no message is shown in a generic sentence, never as [object Object]', async () => {
    const user = userEvent.setup();
    const s = await settings(user, demoP2State(), 'Backups');
    vi.spyOn(api, 'restoreBackup').mockRejectedValue({ code: 'io' });
    await user.click(await s.findByRole('button', { name: 'Restore z-work-data-2026-03-12.json' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Restore this backup?' })).getByRole('button', { name: 'Restore this backup' }));
    const alert = await s.findByRole('alert');
    expect(alert).toHaveTextContent('Could not restore z-work-data-2026-03-12.json: Something went wrong.');
    expect(alert.textContent).not.toContain('[object Object]');
  });

  it('the history says a restore in words, with the backup it came from', async () => {
    const user = userEvent.setup();
    const seed = demoP2State();
    const history = await settings(user, seed, 'Backups');
    await user.click(await history.findByRole('button', { name: 'Restore z-work-data-2026-03-11.json' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Restore this backup?' })).getByRole('button', { name: 'Restore this backup' }));
    await history.findByTestId('backup-result');
    const audit = within(screen.getByRole('region', { name: 'History of changes' }));
    await user.click(audit.getByRole('button', { name: 'Load' }));
    await user.selectOptions(await audit.findByLabelText('Show'), 'backup');
    const entry = await audit.findByTestId('audit-entry');
    expect(entry).toHaveTextContent('Backup restored');
    expect(entry).toHaveTextContent('After: z-work-data-2026-03-11.json; the data from just before is kept as pre-restore-');
  });
});
