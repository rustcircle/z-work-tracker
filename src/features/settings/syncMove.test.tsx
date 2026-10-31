import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoState, DEMO_NOW } from '../../mocks/demoSeed';
import type { MockState } from '../../mocks/ipcMock';
import { parseIso, toIso } from '../../lib/tz';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

const OLD = 'C:\\Users\\me\\OneDrive';
const NEW = 'G:\\My Drive';

let state: MockState;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

/** A synced OneDrive folder with data from two PCs, a detected Google Drive folder, and Settings open. */
async function setup(tweak?: (s: MockState) => void) {
  const user = userEvent.setup();
  const s = demoState();
  s.targets = [
    {
      provider: 'oneDrive',
      root: OLD,
      folder: `${OLD}\\zWorkTracker`,
      status: { lastWrittenAt: toIso(parseIso(DEMO_NOW) - 120), lastReadAt: toIso(parseIso(DEMO_NOW) - 60), lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 1 },
    },
  ];
  s.detected = [{ provider: 'googleDrive', root: NEW, source: 'a mounted drive' }];
  s.folders = { [OLD]: { devices: ['Office PC', 'Mock PC'], counts: { projects: 4, tasks: 12, segments: 300 }, available: true } };
  tweak?.(s);
  state = s;
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  return { user, panel: () => screen.getByTestId('sync-move') };
}

async function toConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Change folder C:/ }));
  await user.click(await screen.findByLabelText(`Google Drive folder (${NEW})`));
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByTestId('move-to');
}

describe('change the sync folder', () => {
  it('explains when sync runs, with no stale timings', async () => {
    await setup();
    const text = (await screen.findByTestId('sync-when')).textContent ?? '';
    expect(text).toContain('every 30 minutes');
    expect(text).toContain('when the app starts and when it quits');
    expect(text).toContain('retried');
    expect(text).not.toMatch(/3 minutes|focus/i);
  });

  it('shows what will move, warns about every PC, copies with progress and summarises the result', async () => {
    const { user } = await setup((s) => {
      s.moveDelayMs = 40;
    });
    await user.click(await screen.findByRole('button', { name: /^Change folder C:/ }));
    const panel = screen.getByTestId('sync-move');
    expect(within(panel).getByRole('heading', { name: 'Choose the new sync folder' })).toHaveFocus();
    expect(calls('move_sync_target')).toEqual([]);
    await user.click(screen.getByLabelText(`Google Drive folder (${NEW})`));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByTestId('move-from')).toHaveTextContent(`${OLD}2 devices (Office PC, Mock PC): 4 projects, 12 tasks, 300 time segments`);
    expect(screen.getByTestId('move-to')).toHaveTextContent(`${NEW}Nothing there yet`);
    expect(screen.getByTestId('move-local')).toHaveTextContent(/\d+ projects?, \d+ tasks?, \d+ time segments?/);
    expect(screen.queryByTestId('move-merge')).toBeNull();
    expect(screen.getByText('The old folder is not changed or deleted. It stops being written to, and you can remove it yourself.')).toBeVisible();
    expect(screen.getByTestId('move-each-pc')).toBeVisible();
    expect(screen.getByTestId('move-each-pc')).toHaveTextContent("Each PC needs switching. Other PCs keep using the old folder until you change them too, and PCs on different folders don't see each other's changes.");
    expect(calls('preview_sync_move')).toEqual([{ from: OLD, to: NEW }]);
    expect(calls('move_sync_target')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Copy and switch' }));
    const progress = await screen.findByTestId('move-progress');
    expect(progress).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText(/Time tracking carries on/)).toBeVisible();
    await waitFor(() => expect(progress).toHaveTextContent(/of \d+/));

    const summary = await screen.findByTestId('move-summary');
    expect(summary).toHaveTextContent('Copied 6 files, 0 already there, 0 ignored. The folder now holds');
    expect(summary).toHaveTextContent('4 projects, 12 tasks, 300 time segments');
    expect(screen.getByText(/Checked by reading the copy back/)).toBeVisible();
    expect(calls('move_sync_target')).toEqual([{ from: OLD, to: NEW, provider: 'googleDrive', replacing: true }]);
    expect(state.targets.map((t) => t.root)).toEqual([NEW]);
    expect(await screen.findByRole('heading', { name: 'Google Drive folder' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('sync-move')).toBeNull();
  });

  it('says existing data in the new folder is merged, not overwritten', async () => {
    const { user } = await setup((s) => {
      s.folders[NEW] = { devices: ['Home PC'], counts: { projects: 2, tasks: 5, segments: 90 }, available: true };
    });
    await toConfirm(user);
    expect(screen.getByTestId('move-merge')).toHaveTextContent('Existing data there will be merged, not overwritten.');
    expect(screen.getByTestId('move-to')).toHaveTextContent('1 device (Home PC): 2 projects, 5 tasks, 90 time segments');
    await user.click(screen.getByRole('button', { name: 'Copy and switch' }));
    expect(await screen.findByTestId('move-summary')).toHaveTextContent('Copied 6 files, 0 already there');
    expect(state.folders[NEW]?.devices.sort()).toEqual(['Home PC', 'Mock PC', 'Office PC']);
  });

  it('switches when the previous folder cannot be read, owes a copy, and clears it on Retry copy', async () => {
    const { user } = await setup((s) => {
      s.folders[OLD] = { devices: ['Office PC'], counts: { projects: 4, tasks: 12, segments: 300 }, available: false };
    });
    await toConfirm(user);
    expect(screen.getByTestId('move-source-missing')).toHaveTextContent("The previous folder can't be read. This will use the data on this computer, and you can retry the copy later.");
    await user.click(screen.getByRole('button', { name: 'Switch folder' }));
    expect(await screen.findByText(/The previous folder couldn't be read, so the data on this computer was used/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    const pending = await screen.findByTestId('sync-pending');
    expect(pending).toHaveTextContent(`The previous folder (${OLD}) couldn't be read`);
    expect(state.pendingCopy).toEqual({ from: OLD, to: NEW });

    // The drive is back: the retry copies from the previous folder into the target that is already in use.
    state.folders[OLD] = { devices: ['Office PC'], counts: { projects: 4, tasks: 12, segments: 300 }, available: true };
    await user.click(within(pending).getByRole('button', { name: 'Retry copy' }));
    expect(await screen.findByTestId('move-summary')).toHaveTextContent('Copied 3 files');
    expect(calls('move_sync_target').at(-1)).toEqual({ from: OLD, to: NEW, provider: 'googleDrive', replacing: false });
    await waitFor(() => expect(screen.queryByTestId('sync-pending')).toBeNull());
    expect(state.pendingCopy).toBeNull();
    expect(state.targets.map((t) => t.root)).toEqual([NEW]);
  });

  it('keeps the old folder when the copy fails, says so, and succeeds on Try again', async () => {
    const { user } = await setup((s) => {
      s.folders[NEW] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: true, failNext: true };
    });
    await toConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Copy and switch' }));
    const error = await screen.findByTestId('move-error');
    expect(error).toHaveTextContent('Could not write to G:\\My Drive: the folder is read-only.');
    expect(screen.getByText('Sync is still using the old folder. Your data is safe.')).toBeVisible();
    expect(state.targets.map((t) => t.root)).toEqual([OLD]);
    expect(state.pendingCopy).toBeNull();
    expect(screen.getByText(`${OLD}\\zWorkTracker`, { selector: '.sync-path' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('move-summary')).toBeVisible();
    expect(calls('move_sync_target')).toHaveLength(2);
    expect(state.targets.map((t) => t.root)).toEqual([NEW]);
  });

  it('makes no move when cancelled, at either step', async () => {
    const { user } = await setup();
    await user.click(await screen.findByRole('button', { name: /^Change folder C:/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('sync-move')).toBeNull();
    await toConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('sync-move')).toBeNull();
    expect(calls('move_sync_target')).toEqual([]);
    expect(state.targets.map((t) => t.root)).toEqual([OLD]);
    // Focus returns to the button that opened the flow.
    expect(screen.getByRole('button', { name: /^Change folder C:/ })).toHaveFocus();
  });

  it('adds a second folder, keeping the first, through the same flow', async () => {
    const { user } = await setup();
    await user.click(await screen.findByRole('button', { name: 'Add a folder' }));
    await user.click(await screen.findByLabelText(`Google Drive folder (${NEW})`));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Add this sync folder?' })).toBeVisible();
    expect(screen.getByTestId('move-each-pc')).toHaveTextContent('Each PC needs the same change');
    await user.click(screen.getByRole('button', { name: 'Copy and add' }));
    expect(await screen.findByTestId('move-summary')).toBeVisible();
    expect(calls('move_sync_target')).toEqual([{ from: OLD, to: NEW, provider: 'googleDrive', replacing: false }]);
    expect(state.targets.map((t) => t.root)).toEqual([OLD, NEW]);
  });

  it('keeps the first connect flow when no folder is connected yet', async () => {
    const { user } = await setup((s) => {
      s.targets = [];
      s.folders = {};
    });
    await user.click(await screen.findByRole('button', { name: 'Add a folder' }));
    expect(await screen.findByRole('button', { name: 'Connect folder' })).toBeDisabled();
    expect(screen.queryByTestId('sync-move')).toBeNull();
  });
});
