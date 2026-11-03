import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, expectClean, open, tab } from './support';

// Settings > Versions against the mock backend (design test 76): browse the saved versions, read what changed, restore one in two
// steps. `?versions=1` seeds two folders (OneDrive and Google Drive) holding seven versions between them. One of them has a Google Drive
// copy that can't be read, and two are kept for a year.
const ONE_DRIVE = 'C:\\Users\\me\\OneDrive';
const DRIVE = 'G:\\My Drive';

const versions = (page: Page): Locator => page.getByRole('region', { name: 'Versions' });
const rows = (page: Page): Locator => versions(page).getByTestId('version-row');
const rowAt = (page: Page, when: string): Locator => rows(page).filter({ hasText: when });
const mockCalls = (page: Page, cmd: string) => page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

async function start(page: Page, query = 'seed=demo&versions=1') {
  const found = await open(page, query);
  await tab(page, 'Settings');
  await expect(versions(page).getByRole('heading', { name: 'Versions' })).toBeVisible();
  return found;
}

test.describe('browse the saved versions', () => {
  test('lists them newest first by month, with the reason in words and a badge for each folder', async ({ page }) => {
    const found = await start(page);
    await expect(rows(page)).toHaveCount(7);
    await expect(versions(page).getByRole('heading', { level: 4 })).toHaveText(['March 2026', 'February 2026', 'January 2026', 'December 2025']);
    const first = rowAt(page, 'Thu 12 Mar 2026, 14:25');
    await expect(first).toContainText('Automatic hourly copy');
    await expect(first).toContainText('Saved by Mock PC');
    await expect(first.getByRole('button', { name: 'OneDrive' })).toHaveAttribute('aria-pressed', 'true');
    await expect(first.getByRole('button', { name: 'Google Drive' })).toHaveAttribute('aria-pressed', 'false');
    // One folder only: a plain label, not a choice.
    await expect(rowAt(page, 'Wed 11 Mar 2026, 13:20').getByRole('button', { name: 'OneDrive' })).toHaveCount(0);
    // Copies made before a restore or a take over are kept for a year, and say so.
    await expect(versions(page).getByText('Kept for a year', { exact: true })).toHaveCount(2);
    await expect(versions(page).getByTestId('versions-how')).toContainText('Version history in OneDrive, Manage versions in Google Drive');
    await versions(page).screenshot({ path: path.join(SHOTS, 'versions-list.png') });
    await expectClean(page, found);
  });

  test('reads what changed in a version, and folds it away again', async ({ page }) => {
    const found = await start(page);
    const first = rowAt(page, 'Thu 12 Mar 2026, 14:25');
    const toggle = first.getByRole('button', { name: /^What changed/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const text = first.getByTestId('version-changes');
    await expect(text).toContainText('zWorkTracker version saved 12 Mar 2026, 14:25 UTC');
    await expect(text).toContainText('corrected a time segment on "Logo concepts": 09:00-10:00 became 09:10-10:00. Reason: started late');
    expect(await mockCalls(page, 'read_version_changes')).toEqual([{ root: ONE_DRIVE, name: '20260312T142500Z--11111111--auto' }]);
    await toggle.click();
    await expect(first.getByTestId('version-changes')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('a copy that can\'t be read says so, and the copy in the other folder reads', async ({ page }) => {
    const found = await start(page);
    const row = rowAt(page, 'Sat 31 Jan 2026, 15:20');
    await row.getByRole('button', { name: 'Google Drive' }).click();
    await row.getByRole('button', { name: /^What changed/ }).click();
    await expect(row.getByRole('alert')).toContainText("This copy isn't readable here (it may still be syncing). Try the copy in OneDrive.");
    await versions(page).screenshot({ path: path.join(SHOTS, 'versions-unreadable.png') });
    await row.getByRole('button', { name: 'Use the copy in OneDrive' }).click();
    await expect(row.getByTestId('version-changes')).toContainText('zWorkTracker version saved');
    await expect(row.getByRole('alert')).toHaveCount(0);
    expect((await mockCalls(page, 'read_version_changes')).map((c) => (c as { root: string }).root)).toEqual([DRIVE, ONE_DRIVE]);
    await expectClean(page, found);
  });

  test('looks in a folder that is not connected', async ({ page }) => {
    const found = await start(page);
    await page.evaluate(() => {
      window.__mock.versions.push({
        name: '20251202T152000Z--11111111--auto',
        takenAt: '2025-12-02T15:20:00Z',
        deviceName: 'Mock PC',
        reason: 'auto',
        pinned: false,
        locations: [{ root: '/mock/picked-folder', provider: 'custom', bytes: 77_000 }],
        changes: 'zWorkTracker version saved 2 Dec 2025, 15:20 UTC',
        counts: { projects: 1, tasks: 1, segments: 3 },
      });
    });
    await expect(rows(page)).toHaveCount(7);
    await versions(page).getByRole('button', { name: 'Look in another folder…' }).click();
    await expect(rows(page)).toHaveCount(8);
    await expect(versions(page).getByTestId('versions-extra')).toContainText('Also looking in /mock/picked-folder.');
    await expect(rowAt(page, 'Tue 2 Dec 2025')).toContainText('picked-folder');
    await versions(page).getByRole('button', { name: 'Stop looking there' }).click();
    await expect(rows(page)).toHaveCount(7);
    await expectClean(page, found);
  });
});

test.describe('restore a version', () => {
  test('asks in two steps, restores, shows the notice, and lists the copy of the data from before', async ({ page }) => {
    const found = await start(page);
    const when = 'Wed 11 Mar 2026, 13:20';
    await versions(page).getByRole('button', { name: `Restore the version from ${when}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
    await expect(dialog).toContainText('Step 1 of 2');
    await expect(dialog.getByTestId('restore-version-counts')).toHaveText('4 projects, 5 tasks, 104 time segments');
    await expect(dialog.getByTestId('restore-current-counts')).toContainText('time segments');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.screenshot({ path: path.join(SHOTS, 'versions-restore-step1.png') });
    expect(await mockCalls(page, 'restore_version')).toEqual([]);

    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog).toContainText('Step 2 of 2');
    await expect(dialog).toContainText("This replaces the data on every computer that syncs with these folders. First, a copy of today's data is saved here and in your folders, so you can undo this by restoring that copy.");
    await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();
    expect(await mockCalls(page, 'restore_version')).toEqual([]);
    await dialog.screenshot({ path: path.join(SHOTS, 'versions-restore-step2.png') });

    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await expect(dialog).toBeHidden();
    expect(await mockCalls(page, 'restore_version')).toEqual([{ root: ONE_DRIVE, name: '20260311T132000Z--11111111--manual' }]);
    await expect(versions(page).getByTestId('versions-result')).toContainText(`Restored the version from ${when}.`);
    await expect(page.getByTestId('notice').filter({ hasText: 'Restored the version from 11 Mar 2026, 13:20 UTC.' })).toBeVisible();
    // The copy of the data from just before is a version of its own, at the top, kept for a year.
    await expect(rows(page)).toHaveCount(8);
    await expect(rows(page).first()).toContainText('Copy of the data before a restore');
    await expect(rows(page).first()).toContainText('Kept for a year');
    await expectClean(page, found);
  });

  test('the history of changes says it in words', async ({ page }) => {
    const found = await start(page);
    await versions(page).getByRole('button', { name: 'Restore the version from Wed 11 Mar 2026, 13:20' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await expect(dialog).toBeHidden();
    const entry = page.getByRole('region', { name: 'History of changes' }).locator('[data-entity="version"]');
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('Saved version restored by this computer (Mock PC)');
    await expect(entry).toContainText('the version of 2026-03-11 13:20 (saved by hand)');
    await expect(entry).toContainText('the data from just before is kept as');
    await expectClean(page, found);
  });

  test('can restore from the copy in the other folder', async ({ page }) => {
    const found = await start(page);
    await versions(page).getByRole('button', { name: 'Restore the version from Thu 12 Mar 2026, 10:20' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
    await dialog.getByLabel('Google Drive').check();
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await expect(dialog).toBeHidden();
    expect(await mockCalls(page, 'restore_version')).toEqual([{ root: DRIVE, name: '20260312T102000Z--22222222--quit' }]);
    await expectClean(page, found);
  });

  test('stops at the first step when the copy can\'t be read, and goes on with the other one', async ({ page }) => {
    const found = await start(page);
    await versions(page).getByRole('button', { name: 'Restore the version from Sat 31 Jan 2026, 15:20' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
    await expect(dialog.getByTestId('restore-version-counts')).toBeVisible();
    await dialog.getByLabel('Google Drive').check();
    await expect(dialog.getByRole('alert')).toContainText("This copy isn't readable here (it may still be syncing). Try the copy in OneDrive.");
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Use the copy in OneDrive' }).click();
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await mockCalls(page, 'restore_version')).toEqual([]);
    await expectClean(page, found);
  });

  test('while another computer is using the app, Restore and Save are off and say why', async ({ page }) => {
    const found = await start(page, 'seed=demo&versions=1&lease=live');
    await expect(rows(page)).toHaveCount(7);
    await expect(versions(page).getByTestId('versions-read-only')).toContainText('Take over first to restore or save a version.');
    for (const button of await versions(page).getByRole('button', { name: /^Restore the version from/ }).all()) await expect(button).toBeDisabled();
    await expect(versions(page).getByRole('button', { name: 'Save a version now' })).toBeDisabled();
    // Reading is allowed.
    await rowAt(page, 'Thu 12 Mar 2026, 14:25').getByRole('button', { name: /^What changed/ }).click();
    await expect(rowAt(page, 'Thu 12 Mar 2026, 14:25').getByTestId('version-changes')).toBeVisible();
    await versions(page).screenshot({ path: path.join(SHOTS, 'versions-read-only.png') });
    await expectClean(page, found);
  });
});

test.describe('save a version by hand', () => {
  test('saves one and lists it first', async ({ page }) => {
    const found = await start(page);
    await versions(page).getByRole('button', { name: 'Save a version now' }).click();
    await expect(versions(page).getByTestId('versions-result')).toHaveText('A version was saved.');
    await expect(rows(page)).toHaveCount(8);
    await expect(rows(page).first()).toContainText('Saved by hand');
    await expectClean(page, found);
  });
});

test.describe('Start with Windows in the Microsoft Store version', () => {
  test('says Windows turned it off, and opens the Startup settings of Windows', async ({ page }) => {
    const found = await open(page, 'seed=demo&packaged=1&autostart=offByUser');
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Start with Windows' });
    await expect(section.getByRole('switch', { name: 'Start zWorkTracker when I sign in to Windows' })).toBeDisabled();
    await expect(section.getByTestId('autostart-note')).toHaveText('You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.');
    await section.getByRole('button', { name: 'Open Startup settings' }).click();
    await expect.poll(async () => (await mockCalls(page, 'open_startup_settings')).length).toBe(1);
    await expectClean(page, found);
  });

  test('a policy that keeps it on is shown as on and can\'t be changed', async ({ page }) => {
    const found = await open(page, 'seed=demo&packaged=1&autostart=onByPolicy');
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Start with Windows' });
    const toggle = section.getByRole('switch', { name: 'Start zWorkTracker when I sign in to Windows' });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(section.getByTestId('autostart-note')).toHaveText('A policy on this computer keeps this on.');
    await expect(section.getByRole('button', { name: 'Open Startup settings' })).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('restoring with no folder connected, from a folder looked in by hand', () => {
  test('says only what happens: a copy on this computer, and no change for other computers', async ({ page }) => {
    const found = await start(page, 'seed=demo');
    await page.evaluate(() => {
      window.__mock.versions.push({
        name: '20251202T152000Z--11111111--auto',
        takenAt: '2025-12-02T15:20:00Z',
        deviceName: 'Mock PC',
        reason: 'auto',
        pinned: false,
        locations: [{ root: '/mock/picked-folder', provider: 'custom', bytes: 77_000 }],
        changes: 'zWorkTracker version saved 2 Dec 2025, 15:20 UTC',
        counts: { projects: 1, tasks: 1, segments: 3 },
      });
    });
    await expect(versions(page).getByTestId('versions-no-folder')).toBeVisible();
    await versions(page).getByRole('button', { name: 'Look in another folder…' }).click();
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().getByRole('button', { name: /^Restore the version from/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog).toContainText("This replaces the data on this computer. First, a copy of today's data is saved on this computer (Settings, Backups), so you can undo this by restoring that copy. A running task is paused.");
    await expect(dialog).not.toContainText('in your folders');
    await expect(dialog).not.toContainText('every computer');
    await expect(dialog.getByRole('button', { name: 'Back' })).toBeFocused();
    await dialog.screenshot({ path: path.join(SHOTS, 'versions-restore-no-folder.png') });

    await dialog.getByRole('button', { name: 'Restore this version' }).click();
    await expect(dialog).toBeHidden();
    expect(await mockCalls(page, 'restore_version')).toEqual([{ root: '/mock/picked-folder', name: '20251202T152000Z--11111111--auto' }]);
    // The copy it promised is a backup on this computer.
    expect(await page.evaluate(() => window.__mock.backups.some((b) => b.safety))).toBe(true);
    await expectClean(page, found);
  });
});

test.describe('a folder a move stopped at because it holds a restore', () => {
  const sync = (page: Page): Locator => page.getByRole('region', { name: 'Sync between devices' });

  test('asks what to do in Sync between devices, even though the folder is not connected, and the move goes through once it is answered', async ({ page }) => {
    const found = await start(page, 'seed=demo&sync=1');
    // The backend refuses like `restores_before_move`: the move is stopped and the question is left on the destination, which is not connected.
    await page.evaluate(() => {
      window.__mock.failNext = ['move_sync_target'];
      window.__mock.joinPending = { root: 'G:\\My Drive', takenFrom: '20260309T152000Z--22222222--auto', at: '2026-03-09T15:20:00Z', deviceName: 'LAPTOP' };
    });
    await sync(page).getByRole('button', { name: 'Add a second folder' }).click();
    await page.getByLabel(`Google Drive folder (${DRIVE})`).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Copy and add' }).click();
    await expect(page.getByTestId('move-error')).toBeVisible();

    const where = sync(page).getByTestId('sync-join-destination');
    await expect(where).toContainText(DRIVE);
    await expect(where).toContainText("This folder isn't connected yet.");
    await expect(where).toContainText('so the move stopped and nothing was copied. Choose what to do, then move to this folder again.');
    await sync(page).screenshot({ path: path.join(SHOTS, 'sync-join-destination.png') });
    await where.getByRole('button', { name: 'Follow the restored data' }).click();
    await expect(where).toHaveCount(0);
    expect(await mockCalls(page, 'resolve_join')).toEqual([{ root: DRIVE, choice: 'follow' }]);

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('move-summary')).toBeVisible();
    expect(await page.evaluate(() => window.__mock.targets.map((t) => t.root))).toEqual([ONE_DRIVE, DRIVE]);
    await expectClean(page, found);
  });
});

