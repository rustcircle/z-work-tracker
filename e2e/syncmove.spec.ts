import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOTS, expectClean, open, tab } from './support';

// Changing or adding a sync folder, with the data carried over. `?sync=1` seeds a OneDrive folder in use
// (data from two PCs) and a detected Google Drive folder.
const OLD = 'C:\\Users\\me\\OneDrive';
const NEW = 'G:\\My Drive';

const moves = (page: Page) => page.evaluate(() => window.__mock.calls.filter((c) => c.cmd === 'move_sync_target').map((c) => c.args));
const section = (page: Page) => page.getByRole('region', { name: 'Sync between devices' });

async function start(page: Page, query = 'seed=demo&sync=1') {
  const found = await open(page, query);
  await tab(page, 'Settings');
  await expect(section(page).getByRole('heading', { name: 'Sync between devices' })).toBeVisible();
  return found;
}

async function toConfirm(page: Page) {
  await section(page).getByRole('button', { name: /^Change folder C:/ }).click();
  await page.getByLabel(`Google Drive folder (${NEW})`).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('move-to')).toBeVisible();
}

test.describe('change the sync folder', () => {
  test('previews what moves, warns about every PC, copies with progress and verifies', async ({ page }) => {
    const found = await start(page);
    await page.evaluate(() => {
      window.__mock.moveDelayMs = 350;
    });
    await toConfirm(page);
    await expect(page.getByTestId('move-from')).toContainText('2 devices (Office PC, Mock PC): 4 projects, 12 tasks, 300 time segments');
    await expect(page.getByTestId('move-to')).toContainText('Nothing there yet');
    await expect(page.getByTestId('move-each-pc')).toContainText("Each PC needs switching. Other PCs keep using the old folder until you change them too");
    expect(await moves(page)).toEqual([]);
    await section(page).screenshot({ path: path.join(SHOTS, 'sync-change-folder.png') });

    await page.getByRole('button', { name: 'Copy and switch' }).click();
    await expect(page.getByTestId('move-progress')).toContainText(/Copying files: \d+ of \d+|Starting/);
    await expect(page.getByText(/Time tracking carries on/)).toBeVisible();
    // The rest of the app stays usable while it copies.
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeEnabled();
    await expect(page.getByTestId('move-summary')).toContainText('Copied 6 files, 0 already there, 0 ignored');
    await expect(page.getByText(/Checked by reading the copy back/)).toBeVisible();
    expect(await moves(page)).toEqual([{ from: OLD, to: NEW, provider: 'googleDrive', replacing: true }]);
    await expect(section(page).getByRole('heading', { name: 'Google Drive folder' })).toBeVisible();
    await expectClean(page, found);
  });

  test('merging into a folder that already has data says so', async ({ page }) => {
    await start(page);
    await page.evaluate((root) => {
      window.__mock.folders[root] = { devices: ['Home PC'], counts: { projects: 2, tasks: 5, segments: 90 }, available: true };
    }, NEW);
    await toConfirm(page);
    await expect(page.getByTestId('move-merge')).toHaveText('Existing data there will be merged, not overwritten.');
    await expect(page.getByTestId('move-to')).toContainText('1 device (Home PC)');
  });

  test('a previous folder that cannot be read switches anyway and offers Retry copy', async ({ page }) => {
    await start(page);
    await page.evaluate((root) => {
      window.__mock.folders[root]!.available = false;
    }, OLD);
    await toConfirm(page);
    await expect(page.getByTestId('move-source-missing')).toContainText("The previous folder can't be read. This will use the data on this computer, and you can retry the copy later.");
    await page.getByRole('button', { name: 'Switch folder' }).click();
    await expect(page.getByText(/couldn't be read, so the data on this computer was used/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    const pending = page.getByTestId('sync-pending');
    await expect(pending).toContainText("couldn't be read");

    await page.evaluate((root) => {
      window.__mock.folders[root]!.available = true;
    }, OLD);
    await pending.getByRole('button', { name: 'Retry copy' }).click();
    await expect(page.getByTestId('move-summary')).toContainText('Copied 3 files, 3 already there');
    await expect(page.getByTestId('sync-pending')).toHaveCount(0);
    expect(await moves(page)).toEqual([
      { from: OLD, to: NEW, provider: 'googleDrive', replacing: true },
      { from: OLD, to: NEW, provider: 'googleDrive', replacing: false },
    ]);
  });

  test('a failed copy leaves the old folder in use and says so', async ({ page }) => {
    await start(page);
    await page.evaluate((root) => {
      window.__mock.folders[root] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: true, failNext: true };
    }, NEW);
    await toConfirm(page);
    await page.getByRole('button', { name: 'Copy and switch' }).click();
    await expect(page.getByTestId('move-error')).toContainText('the folder is read-only');
    await expect(page.getByText('Sync is still using the old folder. Your data is safe.')).toBeVisible();
    expect(await page.evaluate(() => window.__mock.targets.map((t) => t.root))).toEqual([OLD]);
    await expect(section(page).getByText(`${OLD}\\zWorkTracker`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('move-summary')).toBeVisible();
    expect(await page.evaluate(() => window.__mock.targets.map((t) => t.root))).toEqual([NEW]);
  });

  test('is reachable by keyboard alone, and cancel makes no move', async ({ page }) => {
    await start(page);
    const change = section(page).getByRole('button', { name: /^Change folder C:/ });
    await change.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Choose the new sync folder' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page.getByLabel(`Google Drive folder (${NEW})`)).toBeChecked();
    await page.getByRole('button', { name: 'Continue' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('move-to')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sync-move')).toHaveCount(0);
    await expect(change).toBeFocused();
    expect(await moves(page)).toEqual([]);
  });

  for (const theme of ['solarizedLight', 'solarizedDark', 'dark']) {
    test(`confirmation is readable in ${theme}`, async ({ page }, testInfo) => {
      await start(page, `seed=demo&sync=1&theme=${theme}`);
      await page.evaluate((root) => {
        window.__mock.folders[root] = { devices: ['Home PC'], counts: { projects: 2, tasks: 5, segments: 90 }, available: false };
      }, NEW);
      await toConfirm(page);
      await section(page).screenshot({ path: testInfo.outputPath(`sync-change-folder-${theme}.png`) });
    });
  }
});
