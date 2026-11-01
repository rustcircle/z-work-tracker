import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOTS, expectClean, open } from './support';

const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const wizard = (page: Page) => page.getByTestId('setup-wizard');
const step = (page: Page) => wizard(page).getAttribute('data-step');
const next = (page: Page) => page.getByRole('button', { name: 'Next' }).click();
const cmds = (page: Page) => page.evaluate(() => window.__mock.calls.map((c) => c.cmd));
const FRESH = 'seed=empty&firstRun=1';

test.describe('first-run setup', () => {
  test('shows on a fresh store, finishes in one click with defaults, and is not shown again', async ({ page }) => {
    const found = await open(page, FRESH, false);
    await expect(wizard(page)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeFocused();
    // No other one-time prompt next to it.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveCount(0);

    await page.getByTestId('finish-defaults').click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(wizard(page)).toHaveCount(0);
    expect(await cmds(page)).toContain('finish_setup');
    // Defaults stay: nothing was written but the finish.
    const written = (await cmds(page)).filter((c) => ['set_setting', 'set_rounding', 'create_project', 'save_shift', 'add_sync_target', 'set_autostart'].includes(c));
    expect(written).toEqual([]);

    // A relaunch of the same store does not bring it back, and neither does a sync prompt.
    await page.evaluate(() => window.__mockRelaunch('quit'));
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(wizard(page)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('keyboard only: Tab reaches Next, Enter moves on, focus lands on the new step heading', async ({ page }) => {
    const found = await open(page, FRESH, false);
    await expect(wizard(page)).toBeVisible();
    const nextButton = page.getByRole('button', { name: 'Next' });
    await nextButton.focus();
    await page.keyboard.press('Enter');
    expect(await step(page)).toBe('theme');
    await expect(page.getByRole('heading', { level: 1, name: 'Theme' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('heading', { level: 1, name: 'Theme' })).not.toBeFocused();
    await expectClean(page, found);
  });

  test('walks every step, writes the choices through the normal commands, and ends on the summary', async ({ page }) => {
    const found = await open(page, FRESH, false);
    await next(page); // welcome
    // Theme: the page changes as soon as one is chosen.
    await page.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await next(page);
    expect(await step(page)).toBe('zones');
    await next(page);
    expect(await step(page)).toBe('rules');
    await page.getByRole('combobox', { name: 'Increment' }).selectOption('30');
    await expect(page.getByTestId('rule-sentence')).toContainText('30 minutes');
    await next(page);
    expect(await step(page)).toBe('project');
    await page.getByRole('textbox', { name: 'Project name' }).fill('Brand refresh');
    await page.getByRole('textbox', { name: 'Price per hour' }).fill('75');
    await next(page);
    expect(await step(page)).toBe('shifts');
    await page.getByRole('checkbox', { name: /Morning/ }).check();
    await next(page);
    expect(await step(page)).toBe('sync');
    await page.getByRole('button', { name: 'Skip' }).click();
    expect(await step(page)).toBe('autostart');
    await next(page);
    expect(await step(page)).toBe('summary');
    await expect(page.getByTestId('wizard-summary')).toContainText('Brand refresh');
    await expect(page.getByTestId('wizard-summary')).toContainText('Morning');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    const state = await page.evaluate(() => ({
      projects: window.__mock.projects.map((p) => p.name),
      rates: window.__mock.rates.map((r) => r.rateCents),
      rounding: window.__mock.rounding.map((r) => [r.incrementMinutes, r.method]),
      shifts: window.__mock.shifts.map((s) => s.name),
      theme: window.__mock.theme,
      autostart: window.__mock.autostart,
      targets: window.__mock.targets.length,
      tasks: window.__mock.tasks.length,
    }));
    expect(state).toEqual({ projects: ['Brand refresh'], rates: [7500], rounding: [[30, 'up']], shifts: ['Morning'], theme: 'dark', autostart: false, targets: 0, tasks: 0 });
    await expectClean(page, found);
  });

  test('resumes at the step it was left on', async ({ page }) => {
    const found = await open(page, `${FRESH}&step=6`, false);
    await expect(wizard(page)).toBeVisible();
    expect(await step(page)).toBe('shifts');
    await expect(page.getByTestId('wizard-progress')).toContainText('Step 6 of');
    await page.getByRole('button', { name: 'Back' }).click();
    expect(await step(page)).toBe('project');
    // The saved step follows the user.
    expect(await page.evaluate(() => window.__mock.setupStep)).toBe(5);
    await expectClean(page, found);
  });

  test('second computer: connects the folder first, shows what it holds, and skips what the data answers', async ({ page }) => {
    const found = await open(page, `${FRESH}&pc=2`, false);
    await next(page);
    expect(await step(page)).toBe('connect');
    await expect(page.getByTestId('connect-counts')).toContainText('1 project, 6 tasks, 48 time segments from Office PC');
    expect(await page.evaluate(() => window.__mock.targets.length)).toBe(0);
    await page.getByRole('button', { name: 'Connect and bring it in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Theme' })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.targets.length)).toBe(1);
    await next(page);
    // Zones, rules, the project and sync are answered by the merged data.
    expect(await step(page)).toBe('shifts');
    await next(page);
    expect(await step(page)).toBe('autostart');
    await next(page);
    await expect(page.getByTestId('wizard-summary')).toContainText('Office project');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('the old one-time prompts still show for someone who updated, and the wizard does not', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=legacy', false);
    await expect(wizard(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /sync/i }).first()).toBeVisible();
    await expectClean(page, found);
  });

  test('Run setup again asks first, shows every step, and leaves the data alone', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const before = await page.evaluate(() => JSON.stringify({ p: window.__mock.projects, t: window.__mock.tasks, s: window.__mock.segments, set: window.__mock.settings }));
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Run setup again' }).click();
    await expect(page.getByRole('dialog', { name: 'Run setup again?' })).toBeVisible();
    await page.getByRole('button', { name: 'Run setup', exact: true }).click();
    await expect(wizard(page)).toBeVisible();
    await next(page);
    await page.getByRole('button', { name: 'Skip' }).click();
    expect(await step(page)).toBe('zones');
    await page.getByTestId('finish-defaults').click();
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    const after = await page.evaluate(() => JSON.stringify({ p: window.__mock.projects, t: window.__mock.tasks, s: window.__mock.segments, set: window.__mock.settings }));
    expect(after).toBe(before);
    await expectClean(page, found);
  });
});

test.describe('wizard screenshots', () => {
  for (const [theme, file] of THEMES) {
    test(`every step in ${theme}`, async ({ page }) => {
      await open(page, `${FRESH}&pc=2&theme=${theme}`, false);
      await expect(wizard(page)).toBeVisible();
      const shoot = async (name: string) => page.screenshot({ path: path.join(SHOTS, `gapfill-wizard-${name}-${file}.png`) });
      await shoot('welcome');
      await next(page);
      await expect(page.getByTestId('connect-counts')).toBeVisible();
      await shoot('connect');
      await page.getByRole('button', { name: 'Not now' }).click();
      await shoot('theme');
      await next(page);
      await shoot('zones');
      await next(page);
      await shoot('rules');
      await next(page);
      await page.getByRole('textbox', { name: 'Project name' }).fill('Brand refresh');
      await page.getByRole('textbox', { name: 'Price per hour' }).fill('75');
      await shoot('project');
      await next(page);
      await page.getByRole('checkbox', { name: /Morning/ }).check();
      await shoot('shifts');
      await next(page);
      await shoot('sync');
      await page.getByRole('button', { name: 'Skip' }).click();
      await shoot('autostart');
      await next(page);
      await shoot('summary');
    });
  }
});
