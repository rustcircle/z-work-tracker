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
