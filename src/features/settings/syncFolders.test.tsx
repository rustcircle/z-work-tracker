// Settings > Sync between devices with two folders (design test 68): each folder has a state of its own, a failing one is reported and
// does not take the other down with it, and the wording about lag, errors, the lease and a packaged build is the backend's.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within, type BoundFunctions, type queries } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { DEMO_NOW, demoState } from '../../mocks/demoSeed';
import { handle, seedJoinPending, seedLease, seedVersions, type LeaseSeed, type MockState } from '../../mocks/ipcMock';
import { parseIso, toIso } from '../../lib/tz';
import type { SyncTargetView, TargetStatus } from '../../lib/types';
import { folderHealth, folderName, spanWords, whenLabel } from './syncText';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

const ONE_DRIVE = 'C:\\Users\\me\\OneDrive';
const DRIVE = 'G:\\My Drive';
const NOW = parseIso(DEMO_NOW);

let state: MockState;
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);

/** Settings opened on Sync between devices. `folders` says how many of OneDrive and Google Drive are connected. */
async function open(folders: 0 | 1 | 2, tweak?: (s: MockState) => void) {
  const user = userEvent.setup();
  const s = demoState();
  if (folders >= 1) handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
  if (folders >= 2) handle(s, 'add_sync_target', { provider: 'googleDrive', root: DRIVE });
  tweak?.(s);
  state = s;
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  const region = within(await screen.findByRole('region', { name: 'Sync between devices' }));
  return { user, region };
}

type Scope = BoundFunctions<typeof queries>;
const folderItem = (region: Scope, heading: string) => {
  const item = region.getByRole('heading', { name: heading }).closest('li');
  if (!item) throw new Error(`no folder ${heading}`);
  return within(item);
};
const target = (s: MockState, root: string) => {
  const t = s.targets.find((x) => x.root === root);
  if (!t) throw new Error(`no folder ${root}`);
  return t;
};

describe('two folders', () => {
  it('lists both, the first as the main one and the second as its copy, each with a state of its own', async () => {
    const { region } = await open(2);
    const one = folderItem(region, 'OneDrive folder');
    const two = folderItem(region, 'Google Drive folder');
    expect(one.getByText('Main')).toBeVisible();
    expect(two.getByText('Second copy')).toBeVisible();
    expect(one.getByText('Working')).toBeVisible();
    expect(two.getByText('Working')).toBeVisible();
    expect(one.getByTestId('sync-written')).toHaveTextContent('Written to OneDrive folder, just now');
    expect(two.getByTestId('sync-written')).toHaveTextContent('Written to Google Drive folder, just now');
    // Each folder has its own Change folder and Remove.
    expect(one.getByRole('button', { name: `Change folder ${ONE_DRIVE}` })).toBeEnabled();
    expect(two.getByRole('button', { name: `Remove ${DRIVE} (keeps files)` })).toBeEnabled();
  });

  it('is Add a folder with none connected', async () => {
    const none = await open(0);
    expect(none.region.getByRole('button', { name: 'Add a folder' })).toBeVisible();
    expect(none.region.queryByRole('button', { name: 'Add a second folder' })).toBeNull();
  });

  it('is Add a second folder with one, which keeps the first and adds the other through the same flow', async () => {
    const { user, region } = await open(1, (s) => {
      s.detected = [{ provider: 'googleDrive', root: DRIVE, source: 'a mounted drive' }];
    });
    expect(region.queryByRole('button', { name: 'Add a folder' })).toBeNull();
    expect(region.getByText('A second folder keeps a working copy in each. If one has a problem, the other carries on.')).toBeVisible();
    expect(region.queryByText('Main')).toBeNull();
    await user.click(region.getByRole('button', { name: 'Add a second folder' }));
    await user.click(await screen.findByLabelText(`Google Drive folder (${DRIVE})`));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Copy and add' }));
    await screen.findByTestId('move-summary');
    expect(calls('move_sync_target')).toEqual([{ from: ONE_DRIVE, to: DRIVE, provider: 'googleDrive', replacing: false }]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add a second folder' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Add a folder' })).toBeNull();
  });

  it('hides the button at two', async () => {
    const { region } = await open(2);
    expect(region.queryByRole('button', { name: /^Add a (second )?folder$/ })).toBeNull();
    expect(region.queryByText(/A second folder keeps a working copy/)).toBeNull();
  });

  it('says nothing of which computer is in use while no folder is connected', async () => {
    const { region } = await open(0);
    expect(region.queryByTestId('sync-one-at-a-time')).toBeNull();
  });

  it('says that only one computer at a time can make changes, and that this is a best effort', async () => {
    const { region } = await open(1);
    expect(region.getByTestId('sync-one-at-a-time')).toHaveTextContent(
      "Only one computer at a time can make changes. This is a best effort: cloud folders update late and can't lock anything, so two computers may both make changes for a few minutes. If that happens, nothing is lost: the changes merge.",
    );
  });

  it('says the other folder becomes the main one when the main one is removed, and removes only the one asked', async () => {
    const { user, region } = await open(2);
    await user.click(folderItem(region, 'OneDrive folder').getByRole('button', { name: `Remove ${ONE_DRIVE} (keeps files)` }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop syncing with this folder?' });
    expect(within(dialog).getByText('The other folder becomes the main one.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Remove folder' }));
    await waitFor(() => expect(state.targets.map((t) => t.root)).toEqual([DRIVE]));
    expect(calls('remove_sync_target')).toEqual([{ root: ONE_DRIVE }]);
  });

  it('does not say it for the second folder', async () => {
    const { user, region } = await open(2);
    await user.click(folderItem(region, 'Google Drive folder').getByRole('button', { name: `Remove ${DRIVE} (keeps files)` }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop syncing with this folder?' });
    expect(within(dialog).queryByText('The other folder becomes the main one.')).toBeNull();
  });
});

describe('one folder failing does not take the other with it', () => {
  it('marks the failing folder as a problem with its error, and says the other carries on', async () => {
    const { region } = await open(2, (s) => {
      Object.assign(target(s, DRIVE).status, { lastError: 'Folder not found. Is the drive connected and the desktop client running?', lastErrorAt: toIso(NOW - 120) });
    });
    const one = folderItem(region, 'OneDrive folder');
    const two = folderItem(region, 'Google Drive folder');
    expect(two.getByText('Problem')).toBeVisible();
    expect(two.getByRole('alert')).toHaveTextContent('Last error (2 min ago): Folder not found. Is the drive connected and the desktop client running?');
    expect(one.getByText('Working')).toBeVisible();
    expect(one.queryByRole('alert')).toBeNull();
    expect(region.getByTestId('sync-one-failing')).toHaveTextContent('Google Drive folder has a problem. OneDrive folder carries on, so your data keeps syncing there.');
    expect(region.queryByTestId('sync-all-failing')).toBeNull();
  });

  it('reports every kind of error of a folder on its own line: data, the note about which computer is in use, and versions', async () => {
    const { region } = await open(2, (s) => {
      Object.assign(target(s, ONE_DRIVE).status, {
        lastError: 'disk full',
        lastErrorAt: toIso(NOW - 3600),
        leaseError: 'not responding',
        lastVersionError: 'the folder is full',
      });
    });
    const one = folderItem(region, 'OneDrive folder');
    const alerts = one.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual([
      'Last error (1 h ago): disk full',
      "The note about which computer is in use couldn't be written here: not responding",
      "A version couldn't be saved in this folder: the folder is full",
    ]);
    expect(one.getByText('Problem')).toBeVisible();
    expect(folderItem(region, 'Google Drive folder').getByText('Working')).toBeVisible();
  });

  it('says that no folder works, and that the data is safe here, when both fail', async () => {
    const { region } = await open(2, (s) => {
      for (const t of s.targets) Object.assign(t.status, { lastError: 'offline', lastErrorAt: toIso(NOW) });
    });
    expect(region.getAllByText('Problem')).toHaveLength(2);
    expect(region.getByTestId('sync-all-failing')).toHaveTextContent('No folder is working right now. Your data is safe on this computer, and syncing carries on when a folder works again.');
    expect(region.queryByTestId('sync-one-failing')).toBeNull();
  });

  it('shows a folder that can\'t be read right now as a problem, in words, when it has no error of its own', async () => {
    const { region } = await open(2, (s) => {
      s.folders[DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
    });
    const two = folderItem(region, 'Google Drive folder');
    expect(two.getByText('Problem')).toBeVisible();
    expect(two.getByTestId('sync-unreachable')).toHaveTextContent("This folder can't be read right now. Is the drive connected and the desktop client running?");
    expect(folderItem(region, 'OneDrive folder').getByText('Working')).toBeVisible();
    expect(region.getByTestId('sync-one-failing')).toHaveTextContent('carries on');
  });

  it('does not say the same thing twice when the folder has an error of its own', async () => {
    const { region } = await open(2, (s) => {
      s.folders[DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
      Object.assign(target(s, DRIVE).status, { lastError: 'Folder not found.', lastErrorAt: toIso(NOW) });
    });
    expect(within(folderItem(region, 'Google Drive folder').getByRole('alert')).getByText(/Folder not found\./)).toBeVisible();
    expect(region.queryByTestId('sync-unreachable')).toBeNull();
  });
});

describe('what each folder says about the lease, the versions and being behind', () => {
  it('writes when the note about which computer is in use and the last version were saved, and how much the versions take', async () => {
    const { region } = await open(2, (s) => {
      Object.assign(target(s, ONE_DRIVE).status, { lastLeaseAt: toIso(NOW - 120), lastVersionAt: toIso(NOW - 3300), versionsBytes: 182_400 });
      Object.assign(target(s, DRIVE).status, { lastLeaseAt: toIso(NOW - 125), lastVersionAt: toIso(NOW - 3300), versionsBytes: 2_621_440 });
    });
    const one = folderItem(region, 'OneDrive folder');
    expect(one.getByTestId('sync-versions')).toHaveTextContent('Last version saved here 55 min ago. Saved versions here take 178 KB.');
    expect(one.getByTestId('sync-lease-at')).toHaveTextContent('The note about which computer is in use was written here 2 min ago.');
    expect(folderItem(region, 'Google Drive folder').getByTestId('sync-versions')).toHaveTextContent('Saved versions here take 2.5 MB.');
  });

  it('writes nothing about them when the backend has nothing to say', async () => {
    const { region } = await open(2);
    expect(region.queryByTestId('sync-versions')).toBeNull();
    expect(region.queryByTestId('sync-lease-at')).toBeNull();
    expect(region.queryByTestId('sync-lag')).toBeNull();
  });

  it('says how far behind a folder\'s copy of another computer is, and that its cloud app may be paused', async () => {
    const { region } = await open(2, (s) => {
      Object.assign(target(s, DRIVE).status, { lagSecs: 3 * 3600 + 120 });
    });
    const two = folderItem(region, 'Google Drive folder');
    expect(two.getByTestId('sync-lag')).toHaveTextContent("This folder's copy of another computer's data is 3 h behind the other folder. Its cloud app may be paused.");
    expect(two.getByText('Behind')).toBeVisible();
    expect(folderItem(region, 'OneDrive folder').queryByTestId('sync-lag')).toBeNull();
  });

  it('does not call a folder behind for a lag of nothing', async () => {
    const { region } = await open(2, (s) => {
      Object.assign(target(s, DRIVE).status, { lagSecs: 0 });
    });
    expect(region.queryByTestId('sync-lag')).toBeNull();
    expect(folderItem(region, 'Google Drive folder').getByText('Working')).toBeVisible();
  });

  it('keeps the words of the backend\'s own warnings for a folder', async () => {
    const { region } = await open(2, (s) => {
      Object.assign(target(s, ONE_DRIVE).status, { warnings: ['Skipped LAPTOP: it holds data from before a restored version. Update and sync that device.'] });
    });
    expect(folderItem(region, 'OneDrive folder').getByRole('status')).toHaveTextContent('Skipped LAPTOP: it holds data from before a restored version. Update and sync that device.');
  });
});

describe('the words', () => {
  const status: TargetStatus = { lastWrittenAt: null, lastReadAt: null, lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 0 };
  const view = (over: Partial<TargetStatus>): SyncTargetView => ({ provider: 'oneDrive', root: ONE_DRIVE, folder: ONE_DRIVE, status: { ...status, ...over } });

  it('names a folder by its provider or by the last part of the path the user chose', () => {
    expect(folderName('oneDrive', ONE_DRIVE)).toBe('OneDrive');
    expect(folderName('googleDrive', DRIVE)).toBe('Google Drive');
    expect(folderName('custom', 'D:\\Backups\\Hours\\')).toBe('Hours');
    expect(folderName('custom', '/Users/me/Dropbox')).toBe('Dropbox');
    expect(folderName('custom', '')).toBe('Chosen folder');
  });

  it('judges a folder on its own', () => {
    expect(folderHealth(view({ lastWrittenAt: '2026-03-12T15:00:00Z' }), false)).toEqual({ tone: 'success', label: 'Working' });
    expect(folderHealth(view({}), false)).toEqual({ tone: 'neutral', label: 'Not synced yet' });
    expect(folderHealth(view({ lastWrittenAt: 'x', lagSecs: 3700 }), false)).toEqual({ tone: 'warning', label: 'Behind' });
    expect(folderHealth(view({ lastWrittenAt: 'x' }), true)).toEqual({ tone: 'danger', label: 'Problem' });
    expect(folderHealth(view({ lastWrittenAt: 'x', lastError: 'e' }), false).label).toBe('Problem');
    expect(folderHealth(view({ lastWrittenAt: 'x', leaseError: 'e' }), false).label).toBe('Problem');
    expect(folderHealth(view({ lastWrittenAt: 'x', lastVersionError: 'e', lagSecs: 9000 }), false).label).toBe('Problem');
  });

  it('writes a length of time short', () => {
    expect([0, 30, 59 * 60, 89 * 60, 90 * 60, 3 * 3600, 47 * 3600, 48 * 3600, 5 * 86_400].map(spanWords)).toEqual(['1 min', '1 min', '59 min', '89 min', '2 h', '3 h', '47 h', '2 d', '5 d']);
  });

  it('writes a time on the wall clock of the zone', () => {
    expect(whenLabel(parseIso('2026-03-12T15:20:00Z'), 'Europe/Lisbon')).toBe('Thu 12 Mar 2026, 15:20');
    expect(whenLabel(parseIso('2026-03-12T23:30:00Z'), 'Asia/Tokyo')).toBe('Fri 13 Mar 2026, 08:30');
  });
});

describe('the Microsoft Store version', () => {
  it('warns strongly with no folder, and asks for a cloud folder', async () => {
    const { region } = await open(0, (s) => {
      s.packaged = true;
    });
    const warning = region.getByTestId('packaged-no-folder');
    expect(warning).toHaveTextContent(
      'Choose a cloud folder. This copy of zWorkTracker keeps its data in a private Windows folder. Uninstalling the app deletes that folder and your hours with it. Connect a OneDrive or Google Drive folder below. Two folders are better: pick both if you use both.',
    );
    expect(warning).toHaveClass('field-warning');
    expect(region.getByRole('button', { name: 'Add a folder' })).toBeVisible();
  });

  it('says nothing of it in an installer build', async () => {
    const { region } = await open(0);
    expect(region.queryByTestId('packaged-no-folder')).toBeNull();
    expect(region.getByText('Sync is off. This device keeps its data only on this computer.')).toBeVisible();
  });

  it('says nothing of it once a folder is connected', async () => {
    const { region } = await open(1, (s) => {
      s.packaged = true;
    });
    expect(region.queryByTestId('packaged-no-folder')).toBeNull();
  });

  it('shows the warning at the top of the window as well, until a folder is connected', async () => {
    await open(0, (s) => {
      s.packaged = true;
    });
    expect((await screen.findAllByTestId('warning')).map((w) => w.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Uninstalling the app deletes that folder and your hours with it.')]),
    );
  });

  it('asks again before the last folder is removed, and says what uninstalling then does', async () => {
    const { user, region } = await open(1, (s) => {
      s.packaged = true;
    });
    await user.click(region.getByRole('button', { name: `Remove ${ONE_DRIVE} (keeps files)` }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop syncing with this folder?' });
    expect(within(dialog).getByTestId('remove-last-folder')).toHaveTextContent('This is the Microsoft Store version. Without a folder, your hours are kept only in a private Windows folder, and uninstalling the app deletes it.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(state.targets).toHaveLength(1);
  });

  it('says it of the last folder only in the Store version', async () => {
    const { user, region } = await open(1);
    await user.click(region.getByRole('button', { name: `Remove ${ONE_DRIVE} (keeps files)` }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop syncing with this folder?' });
    expect(within(dialog).queryByTestId('remove-last-folder')).toBeNull();
  });
});

describe('a folder that holds a restored version while this computer has data from before it', () => {
  it('asks what to do and reads and writes nothing in the meantime, in the words of the design', async () => {
    const { region } = await open(1, (s) => seedJoinPending(s));
    const panel = region.getByTestId('sync-join');
    expect(panel).toHaveTextContent("This folder's data was restored from the version of Mon 9 Mar 2026, 15:20 on LAPTOP. This computer has data from before that.");
    expect(panel).toHaveTextContent('Until you choose, nothing is read from this folder or written to it.');
    expect(within(panel).getByRole('button', { name: 'Follow the restored data' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: "Keep this computer's data too" })).toBeEnabled();
    expect(panel).toHaveTextContent('Rolled-back items may return on every computer.');
    expect(panel).toHaveTextContent('What is here now is kept as a safety copy on this computer and as a version in your sync folders.');
    expect(calls('resolve_join')).toEqual([]);
  });

  it('follows the restored data, with the copies kept, and the question goes away', async () => {
    const { user, region } = await open(1, (s) => seedJoinPending(s));
    await user.click(within(region.getByTestId('sync-join')).getByRole('button', { name: 'Follow the restored data' }));
    await waitFor(() => expect(region.queryByTestId('sync-join')).toBeNull());
    expect(calls('resolve_join')).toEqual([{ root: ONE_DRIVE, choice: 'follow' }]);
    expect((await screen.findAllByTestId('notice')).map((n) => n.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('LAPTOP restored the version from 9 Mar 2026, 15:20 UTC. This computer now follows it.')]));
  });

  it('keeps this computer\'s data too, and says that rolled-back items may return', async () => {
    const { user, region } = await open(1, (s) => seedJoinPending(s));
    await user.click(within(region.getByTestId('sync-join')).getByRole('button', { name: "Keep this computer's data too" }));
    await waitFor(() => expect(region.queryByTestId('sync-join')).toBeNull());
    expect(calls('resolve_join')).toEqual([{ root: ONE_DRIVE, choice: 'keep' }]);
    expect((await screen.findAllByTestId('notice')).map((n) => n.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Rolled-back items may return on every computer.')]));
  });

  it('is shown under the folder it is about, and for no other', async () => {
    const { region } = await open(2, (s) => {
      seedVersions(s);
      s.joinPending = { root: DRIVE, takenFrom: '20260309T152000Z--22222222--auto', at: toIso(NOW - 86_400), deviceName: 'LAPTOP' };
    });
    expect(folderItem(region, 'Google Drive folder').getByTestId('sync-join')).toBeVisible();
    expect(folderItem(region, 'OneDrive folder').queryByTestId('sync-join')).toBeNull();
  });

  it('can be answered while another computer is using the app', async () => {
    const { user, region } = await open(1, (s) => {
      s.lease = { state: 'heldByOtherLive', readOnly: true, holder: { deviceId: '2', deviceName: 'LAPTOP', generation: 4, beatSeq: 3, lastSignAt: toIso(NOW - 60), ageSecs: 60, clockSuspect: false }, generation: 4, note: null, reachableRoots: [], unreachableRoots: [] };
      seedJoinPending(s);
    });
    await user.click(within(region.getByTestId('sync-join')).getByRole('button', { name: 'Follow the restored data' }));
    await waitFor(() => expect(calls('resolve_join')).toHaveLength(1));
    await waitFor(() => expect(region.queryByTestId('sync-join')).toBeNull());
  });
});

/** `epoch::ASK_BEFORE_MOVE`: what a move into a folder past a restore is refused with. */
const ASK_BEFORE_MOVE =
  'A folder in this move holds data restored from a saved version, and this computer has data from before that, so nothing was copied. Choose what to do in Settings, under Sync between devices, then try again.';

describe('a folder a move stopped at because it holds a restore (review R1)', () => {
  /** The backend refuses like `restores_before_move`: the question it leaves is about the destination, which is not connected, and nothing is sent. */
  const refuseOnce = () =>
    vi.spyOn(api, 'moveSyncTarget').mockImplementationOnce(() => {
      seedJoinPending(state, { root: DRIVE });
      return Promise.reject({ code: 'conflict', message: ASK_BEFORE_MOVE });
    });
  const toTheDrive = async (user: ReturnType<typeof userEvent.setup>, region: Scope) => {
    await user.click(region.getByRole('button', { name: 'Add a second folder' }));
    await user.click(await screen.findByLabelText(`Google Drive folder (${DRIVE})`));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Copy and add' }));
  };
  const withTheDriveFound = (s: MockState) => {
    s.detected = [{ provider: 'googleDrive', root: DRIVE, source: 'a mounted drive' }];
  };

  it('offers the choice in the section, says the folder is the one being moved to, and answers for that folder', async () => {
    const { user, region } = await open(1, (s) => seedJoinPending(s, { root: DRIVE }));
    const where = region.getByTestId('sync-join-destination');
    expect(where).toHaveTextContent(DRIVE);
    expect(where).toHaveTextContent("This folder isn't connected yet.");
    expect(where).toHaveTextContent('so the move stopped and nothing was copied.');
    expect(where).toHaveTextContent('the version of Mon 9 Mar 2026, 15:20 on LAPTOP');
    expect(where).toHaveTextContent('Choose what to do, then move to this folder again.');
    expect(within(where).getByRole('button', { name: 'Follow the restored data' })).toBeEnabled();
    expect(within(where).getByRole('button', { name: "Keep this computer's data too" })).toBeEnabled();
    expect(where).toHaveTextContent('What is here now is kept as a safety copy on this computer and as a version in your sync folders.');
    // The folder that is connected has no question of its own.
    expect(folderItem(region, 'OneDrive folder').queryByTestId('sync-join')).toBeNull();
    await user.click(within(where).getByRole('button', { name: "Keep this computer's data too" }));
    await waitFor(() => expect(region.queryByTestId('sync-join-destination')).toBeNull());
    expect(calls('resolve_join')).toEqual([{ root: DRIVE, choice: 'keep' }]);
    expect(state.targets.map((t) => t.root)).toEqual([ONE_DRIVE]);
  });

  it('says the copy of what is here is on this computer only, when no folder is connected to hold a version', async () => {
    // The only folder was removed after the move was refused: the question is still there, and there is no folder for a version.
    const { region } = await open(0, (s) => {
      s.joinPending = { root: DRIVE, takenFrom: '20260309T152000Z--22222222--auto', at: toIso(NOW - 86_400), deviceName: 'LAPTOP' };
    });
    const where = region.getByTestId('sync-join-destination');
    expect(where).toHaveTextContent('What is here now is kept as a safety copy on this computer.');
    expect(where).not.toHaveTextContent('sync folders');
    expect(within(where).getByRole('button', { name: 'Follow the restored data' })).toBeEnabled();
  });

  it('is drawn once, under the folder, when the folder it is about is connected, and not as a destination', async () => {
    const connected = await open(1, (s) => seedJoinPending(s));
    expect(connected.region.queryByTestId('sync-join-destination')).toBeNull();
    expect(connected.region.getAllByTestId('sync-join')).toHaveLength(1);
  });

  it('a move refused for a restore offers the choice, and the retried move goes through once it is answered', async () => {
    const { user, region } = await open(1, withTheDriveFound);
    refuseOnce();
    await toTheDrive(user, region);
    expect(await screen.findByTestId('move-error')).toHaveTextContent(ASK_BEFORE_MOVE);
    // The choice the message points to is there, with no other action to bring it up.
    const where = await region.findByTestId('sync-join-destination');
    expect(where).toHaveTextContent(DRIVE);
    expect(state.targets.map((t) => t.root)).toEqual([ONE_DRIVE]);
    await user.click(within(where).getByRole('button', { name: 'Follow the restored data' }));
    await waitFor(() => expect(region.queryByTestId('sync-join-destination')).toBeNull());
    expect(calls('resolve_join')).toEqual([{ root: DRIVE, choice: 'follow' }]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('move-summary')).toBeVisible();
    expect(state.targets.map((t) => t.root)).toEqual([ONE_DRIVE, DRIVE]);
  });

  it('shows a refusal that leaves no question as it is: the backend\'s words, and no choice', async () => {
    const { user, region } = await open(1, withTheDriveFound);
    vi.spyOn(api, 'moveSyncTarget').mockRejectedValueOnce({ code: 'conflict', message: 'A restored version has just reached this computer, so nothing was copied. Sync now, then try again.' });
    await toTheDrive(user, region);
    expect(await screen.findByTestId('move-error')).toHaveTextContent('A restored version has just reached this computer, so nothing was copied. Sync now, then try again.');
    expect(region.queryByTestId('sync-join-destination')).toBeNull();
    expect(region.queryByTestId('sync-join')).toBeNull();
    expect(region.queryByRole('button', { name: 'Follow the restored data' })).toBeNull();
  });

  it('keeps the question after the move panel is closed, until it is answered', async () => {
    const { user, region } = await open(1, withTheDriveFound);
    refuseOnce();
    await toTheDrive(user, region);
    await screen.findByTestId('move-error');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('sync-move')).toBeNull();
    expect(region.getByTestId('sync-join-destination')).toBeVisible();
  });
});

describe('this computer holds the lease (design 4.4: a line in Sync between devices only, and Release now)', () => {
  /** Holding the lease, with Logo concepts, which the demo has running here, paused: a running timer keeps a computer in use. */
  const heldAndIdle = (s: MockState) => {
    seedLease(s, 'mine');
    handle(s, 'pause_task', { id: 't-logo' });
  };

  it('says that this computer is the one making changes, and when it lets go by itself, and offers Release now', async () => {
    const { region } = await open(1, heldAndIdle);
    const held = region.getByTestId('sync-held-by-me');
    expect(held).toHaveTextContent('This computer is the one making changes.');
    expect(held).toHaveTextContent('It lets go by itself after 15 minutes with no change and no timer running, and when you quit.');
    expect(held).toHaveTextContent('Release now lets another computer start straight away, without taking over.');
    expect(within(held).getByRole('button', { name: 'Release now' })).toBeEnabled();
    expect(calls('lease_release')).toEqual([]);
  });

  it('sends lease_release when Release now is pressed, and the line goes once this computer has let go', async () => {
    const { user, region } = await open(1, heldAndIdle);
    await user.click(within(region.getByTestId('sync-held-by-me')).getByRole('button', { name: 'Release now' }));
    await waitFor(() => expect(region.queryByTestId('sync-held-by-me')).toBeNull());
    expect(calls('lease_release')).toHaveLength(1);
    expect(state.lease.state).toBe('free');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the backend\'s refusal beside the button while a task is timing here, and goes on holding', async () => {
    const { user, region } = await open(1, (s) => seedLease(s, 'mine'));
    const held = region.getByTestId('sync-held-by-me');
    await user.click(within(held).getByRole('button', { name: 'Release now' }));
    const problem = await within(held).findByRole('alert');
    expect(problem).toHaveTextContent('Could not release: a task is running here, so this computer is still in use. Pause it first.');
    expect(calls('lease_release')).toHaveLength(1);
    expect(state.lease.state).toBe('heldByMe');
    expect(within(held).getByRole('button', { name: 'Release now' })).toBeEnabled();
    // Paused, the same press works, and the refusal is gone with the line.
    handle(state, 'pause_task', { id: 't-logo' });
    await user.click(within(held).getByRole('button', { name: 'Release now' }));
    await waitFor(() => expect(region.queryByTestId('sync-held-by-me')).toBeNull());
    expect(state.lease.state).toBe('free');
  });

  it('is off while it is let go of, so it is not pressed twice', async () => {
    const { user, region } = await open(1, heldAndIdle);
    let finish: () => void = () => undefined;
    const real = api.leaseRelease;
    vi.spyOn(api, 'leaseRelease').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = () => real().then(resolve, reject);
        }),
    );
    const press = within(region.getByTestId('sync-held-by-me')).getByRole('button', { name: 'Release now' });
    await user.click(press);
    expect(within(region.getByTestId('sync-held-by-me')).getByRole('button', { name: 'Releasing…' })).toBeDisabled();
    await user.click(within(region.getByTestId('sync-held-by-me')).getByRole('button', { name: 'Releasing…' }));
    finish();
    await waitFor(() => expect(region.queryByTestId('sync-held-by-me')).toBeNull());
    expect(calls('lease_release')).toHaveLength(1);
  });

  it.each<LeaseSeed>(['free', 'checking', 'live', 'stale', 'unknown', 'unknown-writable'])('says nothing of it when the lease is %s', async (kind) => {
    const { region } = await open(1, (s) => seedLease(s, kind));
    expect(region.queryByTestId('sync-held-by-me')).toBeNull();
    expect(region.queryByRole('button', { name: 'Release now' })).toBeNull();
  });

  it('says nothing of it with no folder connected', async () => {
    const { region } = await open(0);
    expect(region.queryByTestId('sync-held-by-me')).toBeNull();
    expect(region.queryByRole('button', { name: 'Release now' })).toBeNull();
  });
});
