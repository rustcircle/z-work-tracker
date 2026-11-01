import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOTS, expectClean, open } from './support';

const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const BRAND = '#2563eb';

async function createProject(page: Page, name: string, hex: string): Promise<void> {
  await page.getByRole('tab', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByRole('textbox', { name: 'Project name' }).fill(name);
  await form.getByRole('textbox', { name: 'Hex' }).fill(hex);
  await form.getByRole('button', { name: 'Create project' }).click();
}

test.describe('replaced colours', () => {
  test('an exact clash is replaced and announced, never silently', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await createProject(page, 'Retail', BRAND);
    const notice = page.getByTestId('color-notice');
    await expect(notice).toContainText('Retail was saved with a different colour');
    await expect(notice).toContainText(BRAND);
    const got = await page.evaluate(() => window.__mock.projects.find((p) => p.name === 'Retail')?.color);
    expect(got).not.toBe(BRAND);
    await expect(notice).toContainText(got ?? 'missing');
    await expectClean(page, found);
  });

  test('Choose again lands in the colour choice; a similar colour only warns and is kept', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await createProject(page, 'Retail', BRAND);
    await page.getByTestId('color-notice').getByRole('button', { name: /Choose again/ }).click();
    const form = page.getByRole('form', { name: /Retail/ });
    await expect(form).toBeVisible();
    await expect.poll(() => form.evaluate((f) => f.contains(document.activeElement) && (document.activeElement as HTMLElement).getAttribute('aria-label') !== 'Project name')).toBe(true);
    await form.getByRole('textbox', { name: 'Hex' }).fill('#2564eb');
    await expect(form.getByTestId('cp-warn-similar')).toContainText('Close to Brand refresh');
    await form.getByRole('button', { name: /Save project/ }).click();
    await expect(page.getByTestId('color-notice')).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.projects.find((p) => p.name === 'Retail')?.color)).toBe('#2564eb');
    await expectClean(page, found);
  });

  test('tags follow the same rule inside their own kind', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Add tag' }).click();
    const form = page.getByRole('form', { name: 'New tag' });
    await form.getByRole('textbox', { name: 'Tag name' }).fill('Review');
    // The same colour as a project is fine for a tag; the same colour as another tag is replaced.
    await form.getByRole('textbox', { name: 'Hex' }).fill(BRAND);
    await form.getByRole('button', { name: 'Add tag' }).click();
    await expect(page.getByTestId('color-notice')).toHaveCount(0);
    await page.getByRole('button', { name: 'Add tag' }).click();
    const again = page.getByRole('form', { name: 'New tag' });
    await again.getByRole('textbox', { name: 'Tag name' }).fill('Polish');
    await again.getByRole('textbox', { name: 'Hex' }).fill(BRAND);
    await again.getByRole('button', { name: 'Add tag' }).click();
    await expect(page.getByTestId('color-notice')).toContainText('Polish was saved with a different colour');
    await expectClean(page, found);
  });

  for (const [theme, file] of THEMES) {
    test(`colour notice in ${theme}`, async ({ page }) => {
      await open(page, `seed=demo&theme=${theme}`);
      await createProject(page, 'Retail', BRAND);
      await expect(page.getByTestId('color-notice')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `gapfill-color-notice-${file}.png`) });
    });
  }
});

test.describe('Mica setting', () => {
  test('is disabled with its reason where Mica cannot show, and works where it can', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('tab', { name: 'Settings' }).click();
    const toggle = page.getByRole('switch', { name: 'Windows 11 Mica backdrop' });
    await expect(toggle).toBeDisabled();
    await expect(page.getByTestId('mica-setting')).toContainText('needs Windows 11');
    await expectClean(page, found);

    const second = await open(page, 'seed=demo&mica=1');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('switch', { name: 'Windows 11 Mica backdrop' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-mica', 'on');
    expect(await page.evaluate(() => window.__mock.mica)).toBe(true);
    // Solarized stays opaque even with the switch on.
    await page.getByRole('radio', { name: 'Solarized Dark' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-mica', 'on');
    await page.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-mica', 'on');
    await page.getByRole('switch', { name: 'Windows 11 Mica backdrop' }).uncheck();
    await expect(page.locator('html')).not.toHaveAttribute('data-mica', 'on');
    await expectClean(page, second);
  });

  for (const [theme, file] of THEMES) {
    test(`setting in ${theme}`, async ({ page }) => {
      await open(page, `seed=demo&mica=1&theme=${theme}`);
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByTestId('mica-setting').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, `gapfill-mica-setting-${file}.png`) });
    });
  }
});

test.describe('filter screenshots', () => {
  for (const [theme, file] of THEMES) {
    test(`task rail and Timeline filters in ${theme}`, async ({ page }) => {
      await open(page, `seed=p2&theme=${theme}`);
      await page.getByRole('searchbox', { name: /Search timeline/ }).fill('logo');
      await page.getByRole('checkbox', { name: /Filter timeline by tag Concept/ }).check().catch(() => undefined);
      await expect(page.getByTestId('task-filter-status').first()).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `gapfill-filters-${file}.png`) });
    });
  }
});

test.describe('tag shortcut', () => {
  test('New tag goes to Settings > Tags, keeps the unsaved task, ticks the new tag and comes back', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    await form.getByRole('textbox', { name: 'Task name' }).fill('Unsaved logo task');
    await form.getByRole('textbox', { name: 'Description' }).pressSequentially('Typed but not saved');
    await form.getByRole('button', { name: 'New tag' }).click();
    await expect(page.getByRole('tab', { name: 'Settings', selected: true })).toBeVisible();
    const editor = page.getByRole('form', { name: 'New tag' });
    await expect(editor.getByRole('textbox', { name: 'Tag name' })).toBeFocused();
    await expect(page.getByTestId('back-to-task-bar')).toContainText('What you typed there is kept');
    // The unsaved task is still in the rail while Settings is open.
    await expect(form.getByRole('textbox', { name: 'Task name' })).toHaveValue('Unsaved logo task');
    await editor.getByRole('textbox', { name: 'Tag name' }).fill('Sketch');
    await page.keyboard.press('Enter');
    const back = page.getByRole('button', { name: 'Back to task' });
    await expect(back).toBeFocused();
    await expect(page.getByTestId('back-to-task-bar')).toContainText('Tag added and ticked');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Timeline', selected: true })).toBeVisible();
    await expect(form.getByRole('checkbox', { name: 'Sketch' })).toBeChecked();
    // The cursor is back in the task's tag picker.
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('fieldset.tag-picker') !== null)).toBe(true);
    await expect(form.getByRole('textbox', { name: 'Task name' })).toHaveValue('Unsaved logo task');
    await expect(form.getByRole('textbox', { name: 'Description' })).toContainText('Typed but not saved');
    await expect(page.getByTestId('back-to-task-bar')).toHaveCount(0);
    await expectClean(page, found);
  });

  for (const [theme, file] of THEMES) {
    test(`way back to the task in ${theme}`, async ({ page }) => {
      await open(page, `seed=demo&theme=${theme}`);
      await page.getByRole('button', { name: 'New task' }).click();
      await page.getByRole('form', { name: 'New task' }).getByRole('button', { name: 'New tag' }).click();
      await expect(page.getByTestId('back-to-task-bar')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `gapfill-tag-shortcut-${file}.png`) });
    });
  }
});

test.describe('keyboard', () => {
  test('the heatmaps drill down from the keyboard with one tab stop', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('tab', { name: 'Analysis' }).click();
    const heat = page.getByRole('group', { name: /^Heatmap of logged time by weekday and hour/ });
    await heat.scrollIntoViewIfNeeded();
    const stops = heat.locator('[role="button"][tabindex="0"]');
    await expect(stops).toHaveCount(1);
    await stops.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(stops).toHaveCount(1);
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: /^Drill-down:/ });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    const cal = page.getByRole('group', { name: /^Calendar heatmap/ });
    await cal.scrollIntoViewIfNeeded();
    await expect(cal.locator('[role="button"][tabindex="0"]')).toHaveCount(1);
    await cal.locator('[role="button"][tabindex="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: /^Drill-down:/ })).toBeVisible();
    await expectClean(page, found);
  });

  test('radio groups answer arrow keys: theme, analysis range, colours', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Light', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarizedLight');
    await page.keyboard.press('End');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.keyboard.press('Home');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('tab', { name: 'Projects' }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    const colours = page.getByRole('form', { name: 'New project' }).getByRole('radiogroup', { name: /colour/i });
    await colours.getByRole('radio').first().focus();
    await page.keyboard.press('End');
    await expect(colours.getByRole('radio').last()).toBeFocused();
    await expect(colours.getByRole('radio').last()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(colours.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('tab', { name: 'Analysis' }).click();
    const range = page.getByRole('radiogroup', { name: 'Range' });
    await range.getByRole('radio', { checked: true }).focus();
    await page.keyboard.press('Home');
    await expect(range.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(range.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    await expectClean(page, found);
  });

  test('shift colours are a radio group with arrow keys too', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Add shift|New shift/ }).first().click();
    const colours = page.getByRole('radiogroup').filter({ has: page.getByRole('radio', { name: /^Colour #/ }) }).last();
    await colours.getByRole('radio').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(colours.getByRole('radio').nth(1)).toBeFocused();
    await expect(colours.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    await expectClean(page, found);
  });
});
