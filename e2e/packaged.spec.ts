import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOTS, expectClean, open, tab } from './support';

// The first run in the Microsoft Store build (design test 77), in a real browser under the production CSP, against the IPC mock.
// That build keeps its files in a private Windows folder that uninstalling removes, so the cloud folder step asks firmly for a
// folder, Skip and Finish with defaults ask once more, and the warning in the app stays until a folder is connected.
// ?packaged=1 is that build; ?firstRun=1 a fresh store, which shows the wizard. OneDrive and Google Drive are found but not connected.
//
// The last group is the wizard while another computer holds the lease (?lease=live, or ?lease=stale for one that looks inactive, which
// is the one take over is offered for): the wizard stands in for the Shell, so it shows the lease line itself.
const PACKAGED = 'seed=empty&firstRun=1&packaged=1';
const ONE_DRIVE = 'C:\\Users\\me\\OneDrive';
const GOOGLE_DRIVE = 'G:\\My Drive';

const STRONG =
  'Choose a cloud folder. The Microsoft Store version keeps its files privately, and Windows removes them when the app is uninstalled. A OneDrive or Google Drive folder is what keeps your hours safe. Two folders are better: pick both if you use both.';
const ASK_BODY = 'If you uninstall the app without one, your hours are gone. You can connect a folder later in Settings.';
const NOTE = 'These follow LAPTOP. You can change them after taking over.';

const wizard = (page: Page) => page.getByTestId('setup-wizard');
const onStep = (page: Page, id: string) => expect(wizard(page)).toHaveAttribute('data-step', id);
const question = (page: Page) => page.getByRole('dialog', { name: 'Continue without a folder?' });
const warning = (page: Page) => page.getByTestId('warning');
const sent = (page: Page, cmd: string) => page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

/** OneDrive and Google Drive are installed on this computer and signed in; neither holds zWorkTracker data yet. */
async function foldersFound(page: Page): Promise<void> {
  await page.evaluate(
    ({ one, google }) => {
      window.__mock.detected = [
        { provider: 'oneDrive', root: one, source: 'the OneDrive folder' },
        { provider: 'googleDrive', root: google, source: 'a mounted drive' },
      ];
    },
    { one: ONE_DRIVE, google: GOOGLE_DRIVE },
  );
  // The page takes in what changed in the backend, as it does when a state-changed event arrives.
  await page.evaluate(() => window.__mockEmit('state-changed'));
}

/** Next from the welcome step as far as `target`, one step at a time. */
async function walkTo(page: Page, target: string): Promise<void> {
  for (const id of ['theme', 'zones', 'rules', 'project', 'shifts', 'sync']) {
    await page.getByRole('button', { name: 'Next' }).click();
    await onStep(page, id);
    if (id === target) return;
    // Nothing before the folder step speaks of the folder.
    await expect(page.getByTestId('wizard-folder-urged')).toHaveCount(0);
  }
}

async function startPackaged(page: Page, query = PACKAGED) {
  const found = await open(page, query, false);
  await expect(wizard(page)).toBeVisible();
  await foldersFound(page);
  return found;
}

test.describe('the Microsoft Store build, first run', () => {
  test('asks for a cloud folder firmly, asks again before it is skipped, and the warning stays until a folder is connected', async ({ page }) => {
    const found = await startPackaged(page);
    await walkTo(page, 'sync');

    // The step: firm words, both folders offered and neither ticked, "recommended" and not "optional".
    await expect(page.getByTestId('wizard-folder-urged')).toHaveText(STRONG);
    await expect(page.getByTestId('wizard-progress')).toHaveText(/^Step \d+ of \d+ \(recommended\)$/);
    await expect(wizard(page).getByRole('checkbox')).toHaveCount(2);
    for (const box of await wizard(page).getByRole('checkbox').all()) await expect(box).not.toBeChecked();
    await wizard(page).screenshot({ path: path.join(SHOTS, 'u4-wizard-folder-step-packaged.png') });

    // Skip asks first; Cancel leaves everything as it was.
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(question(page)).toBeVisible();
    await expect(question(page)).toContainText(ASK_BODY);
    await expect(question(page).getByRole('button', { name: 'Continue without a folder' })).toBeVisible();
    await onStep(page, 'sync');
    await page.screenshot({ path: path.join(SHOTS, 'u4-wizard-continue-without-folder.png') });
    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(question(page)).toHaveCount(0);
    await onStep(page, 'sync');
    expect(await sent(page, 'add_sync_target')).toEqual([]);

    // Continue without a folder: setup goes on.
    await page.getByRole('button', { name: 'Skip' }).click();
    await question(page).getByRole('button', { name: 'Continue without a folder' }).click();
    await onStep(page, 'autostart');
    await page.getByRole('button', { name: 'Next' }).click();
    await onStep(page, 'summary');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(wizard(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.targets.length)).toBe(0);

    // The warning is in the app, on every tab and after a relaunch.
    await expect(warning(page)).toHaveCount(1);
    await expect(warning(page)).toContainText('keeps its data in a private Windows folder');
    await expect(warning(page)).toContainText('Uninstalling the app deletes that folder and your hours with it.');
    for (const name of ['Analysis', 'Billing', 'Projects', 'Settings', 'Timeline']) {
      await tab(page, name);
      await expect(warning(page)).toBeVisible();
    }
    await page.evaluate(() => window.__mockRelaunch('quit'));
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(warning(page)).toBeVisible();

    // In Settings the same warning is above the folders. One folder is enough: the warning goes with it.
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Sync between devices' });
    await expect(section.getByTestId('packaged-no-folder')).toBeVisible();
    await section.getByRole('button', { name: 'Add a folder' }).click();
    await section.getByLabel(`OneDrive folder (${ONE_DRIVE})`).check();
    await section.getByRole('button', { name: 'Connect folder' }).click();
    await expect(warning(page)).toHaveCount(0);
    await expect(section.getByTestId('packaged-no-folder')).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.targets.map((t) => t.root))).toEqual([ONE_DRIVE]);
    await expectClean(page, found);
  });

  test('connecting both folders in the wizard goes on without a question, and no warning is left in the app', async ({ page }) => {
    const found = await startPackaged(page);
    await walkTo(page, 'sync');
    await wizard(page).getByLabel(`OneDrive folder (${ONE_DRIVE})`).check();
    await wizard(page).getByLabel(`Google Drive folder (${GOOGLE_DRIVE})`).check();
    await page.getByRole('button', { name: 'Connect 2 folders' }).click();
    await onStep(page, 'autostart');
    await expect(question(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.targets.map((t) => t.root))).toEqual([ONE_DRIVE, GOOGLE_DRIVE]);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(warning(page)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('one folder is enough: it is connected and the step goes on, with no second request', async ({ page }) => {
    const found = await startPackaged(page);
    await walkTo(page, 'sync');
    await wizard(page).getByLabel(`Google Drive folder (${GOOGLE_DRIVE})`).check();
    await page.getByRole('button', { name: 'Connect folder' }).click();
    await onStep(page, 'autostart');
    await expect(question(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.targets.map((t) => t.root))).toEqual([GOOGLE_DRIVE]);
    await expectClean(page, found);
  });

  test('Finish with defaults on the first step asks the same question, and Cancel keeps the person in setup', async ({ page }) => {
    const found = await startPackaged(page);
    await page.getByTestId('finish-defaults').click();
    await expect(question(page)).toBeVisible();
    await expect(question(page)).toContainText(ASK_BODY);
    expect(await sent(page, 'finish_setup')).toEqual([]);
    await question(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(question(page)).toHaveCount(0);
    await onStep(page, 'welcome');

    await page.getByTestId('finish-defaults').click();
    await question(page).getByRole('button', { name: 'Continue without a folder' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    expect(await sent(page, 'finish_setup')).toHaveLength(1);
    await expect(warning(page)).toContainText('keeps its data in a private Windows folder');
    await expectClean(page, found);
  });

  test('the step says nothing about Start with Windows starting hidden in the tray', async ({ page }) => {
    const found = await startPackaged(page, `${PACKAGED}&step=8`);
    await onStep(page, 'autostart');
    await expect(wizard(page)).toContainText('zWorkTracker opens when you sign in to Windows.');
    await expect(wizard(page)).not.toContainText(/system tray|hidden/i);
    // Windows has the last word in this build, and the step says so.
    await expect(wizard(page)).toContainText('This is the Microsoft Store version, so Windows has the last word on this switch.');
    await expectClean(page, found);
  });
});

test.describe('the installer build, first run', () => {
  test('keeps its words, adds the sentence about two folders, and lets Skip go without a question', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=1&step=7', false);
    await onStep(page, 'sync');
    await foldersFound(page);
    await expect(page.getByTestId('wizard-folder-urged')).toHaveCount(0);
    await expect(wizard(page)).toContainText(
      'Optional. To use zWorkTracker on two computers, it can write its data into a OneDrive or Google Drive folder. Nothing is switched on unless you tick a folder and connect it. Connecting both OneDrive and Google Drive keeps a working copy in each.',
    );
    await expect(page.getByTestId('wizard-progress')).toHaveText(/\(optional\)$/);
    await page.getByRole('button', { name: 'Skip' }).click();
    await onStep(page, 'autostart');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(warning(page)).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('the wizard while another computer holds the lease', () => {
  // ?lease=live connects a OneDrive folder and says LAPTOP held the lease 90 seconds ago, ?lease=stale 40 minutes ago. A saved step past
  // the first keeps the wizard up, as it is when a folder was connected during setup: 2 is the theme, 4 the time rule.
  const liveAt = (savedStep: number) => `seed=empty&firstRun=1&step=${savedStep}&lease=live`;
  const staleAt = (savedStep: number) => `seed=empty&firstRun=1&step=${savedStep}&lease=stale`;
  const SHARED_WRITES = ['set_setting', 'set_rounding', 'create_project', 'set_rate', 'save_shift'];

  test('shows the lease line, says the shared steps follow the other computer, and writes none of them', async ({ page }) => {
    const found = await open(page, liveAt(2), false);
    await onStep(page, 'theme');
    const line = wizard(page).getByTestId('lease-banner');
    await expect(line).toBeVisible();
    await expect(line.getByTestId('lease-text')).toHaveText("Read-only. LAPTOP is using zWorkTracker (last seen 1 min ago). You can look at everything here. Changes are off so the two computers don't overlap.");
    // Take over is offered once the other computer looks inactive, not while it looks in use.
    await expect(line.getByRole('button')).toHaveText(['Check again']);
    // The theme is this computer's own.
    await expect(wizard(page).getByText(NOTE)).toHaveCount(0);
    await expect(wizard(page).getByRole('radio', { name: 'Dark', exact: true })).toBeEnabled();

    for (const id of ['zones', 'rules', 'project', 'shifts']) {
      await page.getByRole('button', { name: 'Next' }).click();
      await onStep(page, id);
      await expect(wizard(page).getByText(NOTE)).toBeVisible();
      if (id === 'zones') {
        await expect(page.getByRole('button', { name: 'Change my zone' })).toBeDisabled();
        await wizard(page).screenshot({ path: path.join(SHOTS, 'u4-wizard-read-only.png') });
      }
      if (id === 'rules') await expect(wizard(page).getByRole('combobox', { name: 'Increment' })).toHaveCount(0);
      if (id === 'project') await expect(wizard(page).getByRole('textbox', { name: 'Project name' })).toHaveCount(0);
      if (id === 'shifts') await expect(wizard(page).getByRole('checkbox')).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Next' }).click();
    await onStep(page, 'autostart');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    const calls = await page.evaluate(() => window.__mock.calls.map((c) => c.cmd));
    expect(calls.filter((c) => SHARED_WRITES.includes(c))).toEqual([]);
    expect(calls).toContain('finish_setup');
    await expectClean(page, found);
  });

  test('taking over from the line in the wizard gives the controls back, once the other computer looks inactive', async ({ page }) => {
    const found = await open(page, staleAt(4), false);
    await onStep(page, 'rules');
    await expect(wizard(page).getByRole('combobox', { name: 'Increment' })).toHaveCount(0);
    await expect(wizard(page).getByTestId('lease-banner').getByRole('button')).toHaveText(['Check again', 'Take over…']);
    await wizard(page).getByRole('button', { name: 'Take over…' }).click();
    await page.getByRole('dialog', { name: 'Take over from LAPTOP?' }).getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('dialog', { name: 'Are you sure?' }).getByRole('button', { name: 'Take over' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(wizard(page).getByTestId('lease-banner')).toHaveCount(0);
    await expect(wizard(page).getByText(NOTE)).toHaveCount(0);
    await wizard(page).getByRole('combobox', { name: 'Increment' }).selectOption('30');
    await page.getByRole('button', { name: 'Next' }).click();
    await onStep(page, 'project');
    await expect(wizard(page).getByRole('textbox', { name: 'Project name' })).toBeEnabled();
    expect(await page.evaluate(() => window.__mock.rounding.at(-1)?.incrementMinutes)).toBe(30);
    await expectClean(page, found);
  });
});
