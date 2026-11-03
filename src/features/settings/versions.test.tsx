// Settings > Versions (design test 67): the list by month with a badge per folder, what changed, a copy that can't be read, the two-step
// restore, read-only, and looking in another folder. It runs the whole app on the mock backend, which words things as the real one will.
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, screen, waitFor, within, type BoundFunctions, type queries } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { api } from '../../lib/api';
import { DEMO_NOW, demoState } from '../../mocks/demoSeed';
import { addVersion, handle, seedLease, seedVersions, type MockState } from '../../mocks/ipcMock';
import { parseIso, toIso } from '../../lib/tz';
import type { RestorePreview } from '../../lib/types';
import { groupByMonth, monthTitle, unreadable } from './VersionsSection';

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

/** Settings opened on the Versions section of a store with two folders and seven saved versions. */
async function open(tweak?: (s: MockState) => void, seeded = true) {
  const user = userEvent.setup();
  const s = demoState();
  if (seeded) seedVersions(s);
  tweak?.(s);
  state = s;
  bootApp(s);
  await user.click(await screen.findByRole('tab', { name: 'Settings' }));
  const region = within(await screen.findByRole('region', { name: 'Versions' }));
  return { user, region, s };
}

type Scope = BoundFunctions<typeof queries>;
const rows = (region: Scope) => region.getAllByTestId('version-row');
const rowOf = (region: Scope, when: string) => {
  const row = rows(region).find((r) => r.textContent?.includes(when));
  if (!row) throw new Error(`no version row for ${when}`);
  return within(row);
};

describe('the list', () => {
  it('shows the versions newest first, by month, with device, reason in words, size and a badge for each folder', async () => {
    const { region } = await open();
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    expect(region.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['March 2026', 'February 2026', 'January 2026', 'December 2025']);
    expect(region.getByRole('list', { name: 'Versions from March 2026' }).querySelectorAll('li')).toHaveLength(4);
    const first = rowOf(region, 'Thu 12 Mar 2026, 14:25');
    expect(first.getByText('Automatic hourly copy')).toBeVisible();
    expect(first.getByText('Saved by Mock PC')).toBeVisible();
    expect(first.getByText('178 KB')).toBeVisible();
    // Two folders hold it: each is a choice of the copy to read, and the first is the one in use.
    expect(first.getByRole('button', { name: 'OneDrive' })).toHaveAttribute('aria-pressed', 'true');
    expect(first.getByRole('button', { name: 'Google Drive' })).toHaveAttribute('aria-pressed', 'false');
    const second = rowOf(region, 'Thu 12 Mar 2026, 10:20');
    expect(second.getByText('Copy when the app was closed')).toBeVisible();
    expect(second.getByText('Saved by LAPTOP')).toBeVisible();
    // Only one folder holds this one, so its badge is a plain label.
    const manual = rowOf(region, 'Wed 11 Mar 2026, 13:20');
    expect(manual.getByText('Saved by hand')).toBeVisible();
    expect(manual.getByText('OneDrive')).toBeVisible();
    expect(manual.queryByRole('button', { name: 'OneDrive' })).toBeNull();
    expect(region.getByTestId('versions-total')).toHaveTextContent(/^7 versions, newest first\. Together the copies take .* in your folders\.$/);
  });

  it('marks the copies that are kept for a year', async () => {
    const { region } = await open();
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    const before = rowOf(region, 'Tue 3 Mar 2026, 15:20');
    expect(before.getByText('Copy of the data before a restore')).toBeVisible();
    expect(before.getByText('Kept for a year')).toBeVisible();
    expect(rowOf(region, 'Sat 27 Dec 2025').getByText('Copy when a computer took over')).toBeVisible();
    expect(region.getAllByText('Kept for a year')).toHaveLength(2);
    expect(rowOf(region, 'Thu 12 Mar 2026, 14:25').queryByText('Kept for a year')).toBeNull();
  });

  it('words the retention and says that the cloud provider keeps its own earlier copies too', async () => {
    const { region } = await open();
    expect(region.getByText(/Saved copies of your data in your sync folders\. Any computer can restore from them, and uninstalling the app doesn't touch them\./)).toBeVisible();
    const how = region.getByTestId('versions-how');
    // Hourly is the usual rhythm, and the text says which other moments also save one, so it never claims it is the only one.
    expect(how).toHaveTextContent('normally at most once an hour. It also saves one when you close the app after changes, when you save one by hand, and around a restore or a take over.');
    expect(how).toHaveTextContent('Every copy is kept for 7 days, then one a day for 60 days, then one a month. Copies made around a restore or a take over are kept for a year.');
    expect(how).toHaveTextContent('Version history in OneDrive, Manage versions in Google Drive');
    expect(how).toHaveTextContent('second safety net');
  });

  it('puts a month and a zone together as the window does', () => {
    expect(monthTitle('2026-03')).toBe('March 2026');
    const v = (takenAt: string) => ({ name: takenAt, takenAt, deviceName: 'x', reason: 'auto', pinned: false, locations: [] });
    // 23:30 UTC on the last day of February is the first of March in Lisbon only after DST, and already March in Tokyo.
    expect(groupByMonth([v('2026-02-28T23:30:00Z'), v('2026-03-01T01:00:00Z')], 'Asia/Tokyo').map((g) => g.title)).toEqual(['March 2026']);
    expect(groupByMonth([v('2026-02-28T23:30:00Z'), v('2026-03-01T01:00:00Z')], 'UTC').map((g) => [g.title, g.items.length])).toEqual([
      ['March 2026', 1],
      ['February 2026', 1],
    ]);
  });
});

describe('what changed', () => {
  it('reads the change record of the copy in use, and folds it away again', async () => {
    const { user, region } = await open();
    const first = rowOf(region, 'Thu 12 Mar 2026, 14:25');
    const toggle = first.getByRole('button', { name: /^What changed/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(calls('read_version_changes')).toEqual([]);
    await user.click(toggle);
    const text = await first.findByTestId('version-changes');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(text).toHaveTextContent('zWorkTracker version saved 12 Mar 2026, 14:25 UTC');
    expect(text).toHaveTextContent('What was done, from the audit trail:');
    expect(text).toHaveTextContent('corrected a time segment on "Logo concepts": 09:00-10:00 became 09:10-10:00. Reason: started late');
    expect(calls('read_version_changes')).toEqual([{ root: ONE_DRIVE, name: '20260312T142500Z--11111111--auto' }]);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(first.queryByTestId('version-changes')).toBeNull();
  });

  it('reads the other folder\'s copy when that one is chosen', async () => {
    const { user, region } = await open();
    const first = rowOf(region, 'Thu 12 Mar 2026, 14:25');
    await user.click(first.getByRole('button', { name: 'Google Drive' }));
    expect(first.getByRole('button', { name: 'Google Drive' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(first.getByRole('button', { name: /^What changed/ }));
    await first.findByTestId('version-changes');
    expect(calls('read_version_changes').map((c) => c.root)).toEqual([DRIVE]);
  });
});

describe('a copy that can\'t be read', () => {
  const FORTY = 'Sat 31 Jan 2026, 15:20';

  it('says so in words and offers the copy in the other folder, which reads', async () => {
    const { user, region } = await open();
    const row = rowOf(region, FORTY);
    await user.click(row.getByRole('button', { name: 'Google Drive' }));
    await user.click(row.getByRole('button', { name: /^What changed/ }));
    const alert = await row.findByRole('alert');
    expect(alert).toHaveTextContent("This copy isn't readable here (it may still be syncing). Try the copy in OneDrive.");
    expect(row.getByText(/^Details: /)).toBeVisible();
    expect(row.queryByTestId('version-changes')).toBeNull();
    await user.click(row.getByRole('button', { name: 'Use the copy in OneDrive' }));
    const text = await row.findByTestId('version-changes');
    expect(text).toHaveTextContent('zWorkTracker version saved');
    expect(row.getByRole('button', { name: 'OneDrive' })).toHaveAttribute('aria-pressed', 'true');
    expect(row.queryByRole('alert')).toBeNull();
    expect(calls('read_version_changes').map((c) => c.root)).toEqual([DRIVE, ONE_DRIVE]);
  });

  it('does not suggest a copy that has failed already, and says when none can be read', async () => {
    const { user, region } = await open((s) => {
      for (const v of s.versions) if (v.name.startsWith('20260131')) v.failRead = true;
    });
    const row = rowOf(region, FORTY);
    await user.click(row.getByRole('button', { name: /^What changed/ }));
    expect(await row.findByRole('alert')).toHaveTextContent('Try the copy in Google Drive.');
    await user.click(row.getByRole('button', { name: 'Use the copy in Google Drive' }));
    await waitFor(() => expect(row.getByRole('alert')).toHaveTextContent('None of the copies of this version can be read here right now. They may still be syncing.'));
    expect(row.queryByRole('button', { name: /^Use the copy in/ })).toBeNull();
    await user.click(row.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls('read_version_changes')).toHaveLength(3));
  });

  it('words a version held in one folder only, which has no other copy to try', () => {
    const only = [{ root: ONE_DRIVE, provider: 'oneDrive' as const, bytes: 10 }];
    expect(unreadable(only, new Set([ONE_DRIVE]), ONE_DRIVE)).toEqual({ text: "This copy isn't readable here (it may still be syncing). Try again in a few minutes.", alternative: null });
  });
});

describe('restoring', () => {
  const MANUAL = 'Wed 11 Mar 2026, 13:20';
  const restoreButton = (region: Scope, when: string) => region.getByRole('button', { name: `Restore the version from ${when}` });

  it('shows what the version holds against what is here first, and sends nothing until the second step', async () => {
    const { user, region } = await open();
    await user.click(restoreButton(region, MANUAL));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    expect(within(dialog).getByText('Step 1 of 2')).toBeVisible();
    expect(within(dialog).getByText(/The version from Wed 11 Mar 2026, 13:20/)).toBeVisible();
    expect(within(dialog).getByTestId('restore-which')).toHaveTextContent('Saved by hand, from Mock PC.');
    expect(await within(dialog).findByTestId('restore-version-counts')).toHaveTextContent('4 projects, 5 tasks, 104 time segments');
    expect(within(dialog).getByTestId('restore-current-counts')).toHaveTextContent(/^\d+ projects?, \d+ tasks?, \d+ time segments?$/);
    expect(calls('preview_restore_version')).toEqual([{ root: ONE_DRIVE, name: '20260311T132000Z--11111111--manual' }]);
    // Leaving is the safe default.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('Step 2 of 2')).toBeVisible();
    expect(dialog).toHaveTextContent("This replaces the data on every computer that syncs with these folders. First, a copy of today's data is saved here and in your folders, so you can undo this by restoring that copy. A running task is paused. Changes from a computer on an older app version are skipped until it is updated, so update every computer first.");
    expect(within(dialog).getByRole('button', { name: 'Back' })).toHaveFocus();
    expect(calls('restore_version')).toEqual([]);
    // Back is the first step again, and Cancel leaves with nothing done.
    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByText('Step 1 of 2')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls('restore_version')).toEqual([]);
    expect(restoreButton(region, MANUAL)).toHaveFocus();
  });

  it('restores through the second step, tells where the notice is, and lists the copy made before', async () => {
    const { user, region } = await open();
    await user.click(restoreButton(region, MANUAL));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    await within(dialog).findByTestId('restore-version-counts');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls('restore_version')).toEqual([{ root: ONE_DRIVE, name: '20260311T132000Z--11111111--manual' }]);
    expect(await region.findByTestId('versions-result')).toHaveTextContent('Restored the version from Wed 11 Mar 2026, 13:20. The notices at the top of the window say what to expect.');
    expect((await screen.findAllByTestId('notice')).map((n) => n.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Restored the version from 11 Mar 2026, 13:20 UTC.')]));
    // The copy of the data from just before is a version of its own now, kept for a year.
    await waitFor(() => expect(rows(region)).toHaveLength(8));
    expect(rows(region)[0]).toHaveTextContent('Copy of the data before a restore');
  });

  it('offers the folder to restore from, and a copy that can\'t be read stops the restore until the other one is used', async () => {
    const { user, region } = await open();
    await user.click(restoreButton(region, 'Sat 31 Jan 2026, 15:20'));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    const from = within(dialog).getByRole('group', { name: 'Restore from' });
    expect(within(from).getByLabelText('OneDrive')).toBeChecked();
    await within(dialog).findByTestId('restore-version-counts');
    await user.click(within(from).getByLabelText('Google Drive'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("This copy isn't readable here (it may still be syncing). Try the copy in OneDrive.");
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Use the copy in OneDrive' }));
    await within(dialog).findByTestId('restore-version-counts');
    expect(within(dialog).getByLabelText('OneDrive')).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(calls('restore_version')).toEqual([{ root: ONE_DRIVE, name: '20260131T152000Z--11111111--auto' }]));
  });

  it('never lets the answer for one folder stand for another while that one is still being read', async () => {
    const { user, region } = await open();
    await user.click(restoreButton(region, 'Thu 12 Mar 2026, 10:20'));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    await within(dialog).findByTestId('restore-version-counts');
    // The other folder is slow to answer: until it does, there is nothing to go on with, and what was read from the first folder is not shown for it.
    let answer: (preview: RestorePreview) => void = () => undefined;
    vi.spyOn(api, 'previewRestoreVersion').mockImplementationOnce(
      () =>
        new Promise<RestorePreview>((resolve) => {
          answer = resolve;
        }),
    );
    await user.click(within(dialog).getByLabelText('Google Drive'));
    expect(await within(dialog).findByText('Looking inside the version…')).toBeVisible();
    expect(within(dialog).queryByTestId('restore-counts')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    act(() => answer({ name: '20260312T102000Z--22222222--quit', takenAt: '2026-03-12T10:20:00Z', reason: 'quit', version: { projects: 1, tasks: 2, segments: 3 }, current: { projects: 4, tasks: 5, segments: 6 }, warnings: [], blockedReason: null }));
    expect(await within(dialog).findByTestId('restore-version-counts')).toHaveTextContent('1 project, 2 tasks, 3 time segments');
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('restores from the other folder when that one is chosen', async () => {
    const { user, region } = await open();
    await user.click(restoreButton(region, 'Thu 12 Mar 2026, 10:20'));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    await within(dialog).findByTestId('restore-version-counts');
    await user.click(within(dialog).getByLabelText('Google Drive'));
    await within(dialog).findByTestId('restore-version-counts');
    expect(calls('preview_restore_version').map((c) => c.root)).toEqual([ONE_DRIVE, DRIVE]);
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(calls('restore_version')).toEqual([{ root: DRIVE, name: '20260312T102000Z--22222222--quit' }]));
  });

  it('shows what the backend says about records left out, and what stops a restore', async () => {
    const { user, region } = await open((s) => {
      for (const v of s.versions) {
        if (v.name.startsWith('20260312T142500Z')) v.warnings = ['1 task record could not be read.'];
        if (v.name.startsWith('20260311T132000Z')) v.blockedReason = 'This version was saved by a newer app. Update zWorkTracker first.';
      }
    });
    await user.click(restoreButton(region, 'Thu 12 Mar 2026, 14:25'));
    let dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    expect(await within(dialog).findByTestId('restore-warnings')).toHaveTextContent("These records couldn't be read, so a restore leaves them out:1 task record could not be read.");
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(restoreButton(region, MANUAL));
    dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    expect(await within(dialog).findByTestId('restore-blocked')).toHaveTextContent('This version was saved by a newer app. Update zWorkTracker first.');
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('keeps the second step open with the backend\'s refusal when the restore fails', async () => {
    const { user, region } = await open();
    await user.click(restoreButton(region, MANUAL));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    await within(dialog).findByTestId('restore-version-counts');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    // Both folders went away between the two steps, so there is nothing to restore from and nowhere to put the copy of today's data.
    state.folders[ONE_DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
    state.folders[DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
    expect(await within(dialog).findByTestId('restore-error')).toBeVisible();
    expect(within(dialog).getByText('Step 2 of 2')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'Restore this version?' })).toBeVisible();
  });
});

describe('while another computer is using the app', () => {
  it('switches Restore and Save a version now off, says why, and still lets the versions be read and looked for', async () => {
    const { user, region } = await open((s) => seedLease(s, 'live'));
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    expect(region.getByTestId('versions-read-only')).toHaveTextContent('Take over first to restore or save a version. LAPTOP is using zWorkTracker, so this computer is read-only.');
    for (const b of region.getAllByRole('button', { name: /^Restore the version from/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', 'Take over first to restore.');
    }
    expect(region.getByRole('button', { name: 'Save a version now' })).toBeDisabled();
    expect(region.getByRole('button', { name: 'Look in another folder…' })).toBeEnabled();
    const first = rowOf(region, 'Thu 12 Mar 2026, 14:25');
    await user.click(first.getByRole('button', { name: /^What changed/ }));
    expect(await first.findByTestId('version-changes')).toBeVisible();
    expect(calls('restore_version')).toEqual([]);
    expect(calls('save_version_now')).toEqual([]);
  });

  it('is writable as soon as this computer holds it', async () => {
    const { region } = await open((s) => seedLease(s, 'mine'));
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    expect(region.queryByTestId('versions-read-only')).toBeNull();
    expect(region.getByRole('button', { name: 'Save a version now' })).toBeEnabled();
    expect(region.getByRole('button', { name: 'Restore the version from Thu 12 Mar 2026, 14:25' })).toBeEnabled();
  });
});

describe('looking in another folder', () => {
  const PICKED = '/mock/picked-folder';

  it('lists the versions of a folder that is not connected, with its own badge, and stops looking when asked', async () => {
    const { user, region } = await open((s) => {
      addVersion(s, { takenAt: toIso(NOW - 100 * 86_400), deviceName: 'Mock PC', roots: [PICKED], bytes: 77_000, counts: { projects: 1, tasks: 1, segments: 3 } });
    });
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    expect(calls('list_versions').every((c) => c.extraRoot === undefined)).toBe(true);
    await user.click(region.getByRole('button', { name: 'Look in another folder…' }));
    await waitFor(() => expect(rows(region)).toHaveLength(8));
    expect(calls('list_versions').at(-1)).toEqual({ extraRoot: PICKED });
    expect(region.getByTestId('versions-extra')).toHaveTextContent(`Also looking in ${PICKED}.`);
    const found = rowOf(region, 'Tue 2 Dec 2025');
    expect(found.getByText('picked-folder')).toBeVisible();
    // It can be restored from there, like any other.
    expect(found.getByRole('button', { name: /^Restore the version from/ })).toBeEnabled();
    await user.click(region.getByRole('button', { name: 'Stop looking there' }));
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    expect(region.queryByTestId('versions-extra')).toBeNull();
  });

  it('does nothing when the picker is closed without a choice', async () => {
    const { user, region } = await open();
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    vi.spyOn(api, 'pickSyncFolder').mockResolvedValue(null);
    await user.click(region.getByRole('button', { name: 'Look in another folder…' }));
    expect(region.queryByTestId('versions-extra')).toBeNull();
    expect(calls('list_versions').every((c) => c.extraRoot === undefined)).toBe(true);
  });
});

describe('looking in another folder, when that folder is one that is connected (review R5)', () => {
  const unreadable = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };

  it('tells the folders failed instead of "No versions yet" when every one of them did, and the picked one is a connected one', async () => {
    const { user, region } = await open((s) => {
      handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
      s.folders[ONE_DRIVE] = unreadable;
    }, false);
    expect(await region.findByTestId('versions-folder-error')).toHaveTextContent("Couldn't look for versions in OneDrive: Folder not found.");
    vi.spyOn(api, 'pickSyncFolder').mockResolvedValue(ONE_DRIVE);
    await user.click(region.getByRole('button', { name: 'Look in another folder…' }));
    expect(await region.findByTestId('versions-extra')).toHaveTextContent(`Also looking in ${ONE_DRIVE}.`);
    await waitFor(() => expect(calls('list_versions').at(-1)).toEqual({ extraRoot: ONE_DRIVE }));
    // It is one folder, listed once: it failed, and nothing was found anywhere.
    expect(await region.findAllByTestId('versions-folder-error')).toHaveLength(1);
    expect(region.queryByTestId('versions-empty')).toBeNull();
  });

  it('still says there are none when one of the folders was read, and was empty', async () => {
    const { user, region } = await open((s) => {
      handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
      s.folders[ONE_DRIVE] = unreadable;
    }, false);
    await region.findByTestId('versions-folder-error');
    await user.click(region.getByRole('button', { name: 'Look in another folder…' }));
    await waitFor(() => expect(calls('list_versions').at(-1)).toEqual({ extraRoot: '/mock/picked-folder' }));
    expect(await region.findByTestId('versions-empty')).toBeVisible();
    expect(region.getAllByTestId('versions-folder-error')).toHaveLength(1);
  });

  it('tells both when the folder looked in by hand failed as well as the connected one', async () => {
    const { user, region } = await open((s) => {
      handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
      s.folders[ONE_DRIVE] = unreadable;
      s.folders['/mock/picked-folder'] = unreadable;
    }, false);
    await region.findByTestId('versions-folder-error');
    await user.click(region.getByRole('button', { name: 'Look in another folder…' }));
    await waitFor(() => expect(region.getAllByTestId('versions-folder-error')).toHaveLength(2));
    expect(region.queryByTestId('versions-empty')).toBeNull();
  });
});

describe('restoring with no folder connected, from a folder looked in by hand (review R3)', () => {
  const PICKED = '/mock/picked-folder';

  /** Versions with no folder connected, one found in a folder looked in by hand, and its restore at the second step. */
  async function atTheSecondStep() {
    const { user, region } = await open((s) => {
      addVersion(s, { takenAt: toIso(NOW - 100 * 86_400), deviceName: 'Mock PC', roots: [PICKED], bytes: 77_000, counts: { projects: 1, tasks: 1, segments: 3 } });
    }, false);
    await user.click(region.getByRole('button', { name: 'Look in another folder…' }));
    await waitFor(() => expect(rows(region)).toHaveLength(1));
    await user.click(region.getByRole('button', { name: /^Restore the version from/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Restore this version?' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled());
    await user.click(dialog.getByRole('button', { name: 'Continue' }));
    return { user, region, dialog };
  }

  it('says only what happens: a copy on this computer, and no copy in folders or change for other computers', async () => {
    const { dialog } = await atTheSecondStep();
    expect(dialog.getByText('Step 2 of 2')).toBeVisible();
    const text = (await screen.findByRole('dialog', { name: 'Restore this version?' })).textContent ?? '';
    expect(text).toContain("This replaces the data on this computer. First, a copy of today's data is saved on this computer (Settings, Backups), so you can undo this by restoring that copy. A running task is paused.");
    expect(text).not.toMatch(/in your folders|every computer|these folders|older app version/);
  });

  it('goes through, and the copy it promised is in the list of backups', async () => {
    const { user, region, dialog } = await atTheSecondStep();
    await user.click(dialog.getByRole('button', { name: 'Restore this version' }));
    expect(await region.findByTestId('versions-result')).toHaveTextContent('Restored the version from');
    expect(calls('restore_version')).toEqual([{ root: PICKED, name: expect.stringMatching(/^\d{8}T\d{6}Z--/) }]);
    expect(state.backups.some((b) => b.safety)).toBe(true);
    expect(state.versions.some((v) => v.reason === 'pre-restore')).toBe(false);
  });

  it('keeps the words about the folders and the other computers when a folder is connected', async () => {
    const { user, region } = await open();
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    await user.click(region.getByRole('button', { name: 'Restore the version from Thu 12 Mar 2026, 14:25' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Restore this version?' }));
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled());
    await user.click(dialog.getByRole('button', { name: 'Continue' }));
    expect(dialog.getByText(/^This replaces the data on every computer that syncs with these folders\. First, a copy of today's data is saved here and in your folders/)).toBeVisible();
  });
});

describe('saving a version by hand', () => {
  it('saves one and shows it at the top', async () => {
    const { user, region } = await open();
    await waitFor(() => expect(rows(region)).toHaveLength(7));
    await user.click(region.getByRole('button', { name: 'Save a version now' }));
    expect(await region.findByText('A version was saved.')).toBeVisible();
    expect(calls('save_version_now')).toHaveLength(1);
    await waitFor(() => expect(rows(region)).toHaveLength(8));
    expect(rows(region)[0]).toHaveTextContent('Saved by hand');
  });

  it('says what the backend refused', async () => {
    const { user, region } = await open((s) => {
      for (const t of s.targets) s.folders[t.root] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
    });
    await user.click(region.getByRole('button', { name: 'Save a version now' }));
    expect(await region.findByTestId('versions-result')).toHaveTextContent("Could not save a version: Couldn't save a version: no sync folder could be written.");
  });
});

describe('with no folder, no version, or a folder that can\'t be read', () => {
  it('says that no folder is connected, still offers to look in another, and offers no save', async () => {
    const { region } = await open(undefined, false);
    expect(region.getByTestId('versions-no-folder')).toHaveTextContent('Versions are saved in your sync folders, and none is connected.');
    expect(region.getByRole('button', { name: 'Connect a folder' })).toBeVisible();
    expect(region.getByRole('button', { name: 'Look in another folder…' })).toBeEnabled();
    expect(region.queryByRole('button', { name: 'Save a version now' })).toBeNull();
    expect(calls('list_versions')).toEqual([]);
  });

  it('says there are none yet when a folder is connected and holds none', async () => {
    const { region } = await open((s) => {
      handle(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
    }, false);
    expect(await region.findByTestId('versions-empty')).toHaveTextContent('No versions yet. A copy is saved after your data changes, normally at most once an hour.');
  });

  it('reports a folder that can\'t be read by name and lists what the other one holds', async () => {
    const { region } = await open((s) => {
      s.folders[DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
    });
    const error = await region.findByTestId('versions-folder-error');
    expect(error).toHaveTextContent("Couldn't look for versions in Google Drive: Folder not found. Is the drive connected and the desktop client running? The versions found in the other folders are listed.");
    // The copy only Google Drive held is not there, the rest is, with OneDrive alone.
    await waitFor(() => expect(rows(region)).toHaveLength(6));
    for (const row of rows(region)) expect(within(row).queryByText('Google Drive')).toBeNull();
  });

  it('warns about size without deleting anything', async () => {
    const { region } = await open((s) => {
      addVersion(s, { takenAt: toIso(NOW - 2 * 86_400), bytes: 2 * 1024 ** 3, counts: { projects: 1, tasks: 1, segments: 1 } });
    });
    expect(await region.findByTestId('versions-over-budget')).toHaveTextContent('The saved versions take more than 1 GB in total. Nothing is deleted because of that.');
    expect(region.getByTestId('versions-total')).toHaveTextContent(/take 4\.\d GB in your folders/);
  });
});

describe('Backups points to Versions', () => {
  it('says to use Versions to roll back every computer, but only with a folder connected', async () => {
    await open(undefined, false);
    expect(screen.queryByTestId('backups-use-versions')).toBeNull();
  });

  it('with a folder, says that a backup here does not roll back the other computers', async () => {
    await open();
    const backups = within(await screen.findByRole('region', { name: 'Backups' }));
    expect(backups.getByTestId('backups-use-versions')).toHaveTextContent("To roll back every computer, use Versions. Restoring a backup here doesn't roll back your other computers, and newer records in your sync folders merge back in.");
    expect(backups.queryByTestId('backups-packaged')).toBeNull();
  });

  it('in the Microsoft Store version, says that backups go when the app is uninstalled', async () => {
    await open((s) => {
      s.packaged = true;
    });
    const backups = within(await screen.findByRole('region', { name: 'Backups' }));
    expect(backups.getByTestId('backups-packaged')).toHaveTextContent('These stay in a private Windows folder and are removed if you uninstall the app.');
  });

  it('switches Restore off while another computer is using the app', async () => {
    const { user } = await open((s) => {
      seedLease(s, 'live');
      s.backups = [{ name: 'z-work-data-2026-03-11.json', bytes: 48_000, safety: false }];
    });
    const backups = within(await screen.findByRole('region', { name: 'Backups' }));
    const restore = await backups.findByRole('button', { name: 'Restore z-work-data-2026-03-11.json' });
    expect(restore).toBeDisabled();
    expect(backups.getByTestId('read-only-note')).toHaveTextContent('LAPTOP is using zWorkTracker, so this computer is read-only.');
    await user.click(restore);
    expect(calls('restore_backup')).toEqual([]);
  });
});
