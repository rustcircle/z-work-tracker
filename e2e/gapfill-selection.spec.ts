import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, expectClean, open } from './support';

const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const day = (page: Page, name: string): Locator => page.getByRole('article', { name });
const rows = (page: Page): Locator => page.locator('tr[data-testid="entry"][data-row-id]');
const selected = (page: Page): Locator => page.locator('tr[data-testid="entry"][aria-selected="true"]');
const bar = (page: Page): Locator => page.getByTestId('selection-bar');
const TODAY = 'Thu 12 Mar 2026';
const YESTERDAY = 'Wed 11 Mar 2026';
const TUE = 'Tue 10 Mar 2026';
const taskDays = async (loc: Locator): Promise<string[]> => [...new Set(await loc.evaluateAll((els) => els.map((e) => e.getAttribute('data-sel-key') ?? '')))].sort();
const exportsOf = (page: Page) => page.evaluate(() => window.__mock.exports.map((e) => ({ kind: e.kind, request: e.request })));

test.describe('selecting Timeline entries', () => {
  test('click selects, Ctrl+click toggles, Shift+click selects the range across days; none of it opens or times anything', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const callsBefore = await page.evaluate(() => window.__mock.calls.length);
    const yesterday = day(page, YESTERDAY).locator('tr[data-testid="entry"]');
    await yesterday.first().click();
    await expect(bar(page).getByTestId('selection-count')).toContainText('1 task selected');
    await expect(yesterday.first()).toHaveAttribute('aria-selected', 'true');
    await expect(yesterday.first().getByTestId('sel-mark-on')).toBeVisible();

    // Ctrl+click (Cmd on a Mac, where Control+click is a right click) on a row of another day adds it.
    await day(page, TUE).locator('tr[data-testid="entry"]').first().click({ modifiers: ['ControlOrMeta'] });
    await expect(bar(page).getByTestId('selection-count')).toContainText('2 tasks selected');
    // And toggles it off again.
    await day(page, TUE).locator('tr[data-testid="entry"]').first().click({ modifiers: ['ControlOrMeta'] });
    await expect(bar(page).getByTestId('selection-count')).toContainText('1 task selected');

    // Shift+click: from the anchor (the last one clicked on its own, yesterday's first) to the last row of
    // Tuesday, in screen order.
    await yesterday.first().click();
    await day(page, TUE).locator('tr[data-testid="entry"]').last().click({ modifiers: ['Shift'] });
    const all = await taskDays(rows(page));
    const picked = await taskDays(selected(page));
    expect(picked.length).toBeGreaterThanOrEqual(2);
    // The range is contiguous on screen: every task-day between the anchor and the target is in.
    const order = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-sel-key') ?? ''));
    const first = order.indexOf(await yesterday.first().getAttribute('data-sel-key') as string);
    const lastRow = order.lastIndexOf(await day(page, TUE).locator('tr[data-testid="entry"]').last().getAttribute('data-sel-key') as string);
    expect(new Set(order.slice(first, lastRow + 1))).toEqual(new Set(picked));
    expect(all.length).toBeGreaterThan(picked.length);

    // Nothing was opened, started or sent while selecting.
    await expect(page.getByRole('textbox', { name: 'Task name' })).toHaveCount(0);
    const cmds = await page.evaluate((n) => window.__mock.calls.slice(n).map((c) => c.cmd), callsBefore);
    expect(cmds).toEqual([]);
    await expectClean(page, found);
  });

  test('a task-day with several rows is selected whole, and says so', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const logo = day(page, TODAY).locator('tr[data-testid="entry"]', { hasText: 'Logo concepts' });
    const n = await logo.count();
    expect(n).toBeGreaterThan(1);
    await expect(logo.first().getByTestId('entry-siblings')).toContainText(`One of ${n} rows`);
    await logo.nth(1).click();
    await expect(day(page, TODAY).locator('tr[aria-selected="true"]')).toHaveCount(n);
    await expect(bar(page).getByTestId('selection-count')).toContainText('1 task selected');
    await expectClean(page, found);
  });

  test('the edit and open controls stay one click and never select', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const row = day(page, YESTERDAY).locator('tr[data-testid="entry"]').first();
    await row.getByRole('button', { name: /^Edit task/ }).click();
    await expect(page.getByRole('form', { name: /Edit|Description|Task/ }).first()).toBeVisible();
    await expect(selected(page)).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    await row.getByRole('button', { name: /^(?!Edit)/ }).first().click();
    await expect(selected(page)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('keyboard: one tab stop, arrows, Space, Ctrl+Space, Shift+Arrow, Ctrl+A, Escape, and a live count', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const live = page.getByTestId('selection-live');
    const stop = page.locator('tr[data-testid="entry"][tabindex="0"]');
    await expect(stop).toHaveCount(1);
    await stop.focus();
    const keyAt = async (i: number) => rows(page).nth(i).getAttribute('data-sel-key');
    const order = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-sel-key') ?? ''));
    const p1 = order.findIndex((k) => k !== order[0]);
    const p2 = order.findIndex((k, i) => i > p1 && k !== order[p1]);
    const p3 = order.findIndex((k, i) => i > p2 && k !== order[p2]);
    for (let i = 0; i < p1; i += 1) await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(p1)).toBeFocused();
    await page.keyboard.press('Space');
    expect(await taskDays(selected(page))).toEqual([await keyAt(p1)]);
    await expect(live).toContainText('1 task selected');
    for (let i = p1; i < p2; i += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+Space');
    expect((await taskDays(selected(page))).length).toBe(2);
    await expect(live).toContainText('2 tasks selected');
    for (let i = p2; i < p3; i += 1) await page.keyboard.press('Shift+ArrowDown');
    const picked = await taskDays(selected(page));
    expect(picked).toContain(await keyAt(p2));
    expect(picked).toContain(await keyAt(p3));
    await page.keyboard.press('Escape');
    await expect(selected(page)).toHaveCount(0);
    await expect(live).toContainText('Selection cleared');
    await rows(page).nth(p1).focus();
    await page.keyboard.press('Control+a');
    expect(await selected(page).count()).toBe(await rows(page).count());
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Escape');
    await expectClean(page, found);
  });

  test('filters: the selection survives, the bar says how many are not on screen, and clearing the filter brings them back', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await day(page, TODAY).locator('tr[data-testid="entry"]').first().click();
    await day(page, YESTERDAY).locator('tr[data-testid="entry"]').first().click({ modifiers: ['ControlOrMeta'] });
    await expect(bar(page).getByTestId('selection-count')).toContainText('2 tasks selected');
    await page.getByRole('searchbox', { name: /Search timeline/ }).fill('qqqqqq');
    await expect(rows(page)).toHaveCount(0);
    await expect(bar(page)).toContainText('2 of them are not on screen');
    await expect(bar(page).getByTestId('selection-count')).toContainText('2 tasks selected');
    await page.getByTestId('task-filter-timeline').getByRole('button', { name: 'Clear filter' }).click();
    await expect(rows(page).first()).toBeVisible();
    await expect(bar(page)).not.toContainText('not on screen');
    await expectClean(page, found);
  });

  test('exporting a multi-day task for one day only sends that task-day, with no analytics and no totals', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    // Logo concepts has time on several days; only today's is selected.
    await day(page, TODAY).locator('tr[data-testid="entry"]', { hasText: 'Logo concepts' }).first().click();
    await bar(page).getByRole('button', { name: 'Export selected' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog.getByRole('radio', { name: 'Selected (1)' })).toBeChecked();
    await expect(dialog.getByTestId('selection-scope-note')).toContainText('analysis sheets are left out');
    await dialog.getByRole('button', { name: 'Export Excel' }).click();
    await expect(dialog.getByTestId('export-result')).toBeVisible();
    const sent = await exportsOf(page);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.selection).toEqual([{ taskId: 't-logo', day: '2026-03-12' }]);
    expect(sent[0]?.request.analytics).toEqual([]);
    expect(Object.keys(sent[0]?.request ?? {}).sort()).toEqual(['analytics', 'clientZone', 'dayZone', 'includeEarnings', 'myZone', 'segmentShifts', 'selection']);
    await expectClean(page, found);
  });

  test('nothing selected: the Selected scope is blocked in the dialog, and nothing is sent', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog.getByRole('radio', { name: 'All in period' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Selected (0)' }).click();
    await expect(dialog.getByTestId('selection-empty')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Export Excel' })).toBeDisabled();
    expect(await exportsOf(page)).toHaveLength(0);
    await expectClean(page, found);
  });

  test('Hide earnings masks the selection total', async ({ page }) => {
    const found = await open(page, 'seed=demo&hide=1');
    await day(page, YESTERDAY).locator('tr[data-testid="entry"]').first().click();
    await expect(bar(page).getByTestId('selection-total')).toContainText('••••');
    await expect(bar(page).getByTestId('selection-total')).not.toContainText('$');
    await expectClean(page, found);
  });
});

test.describe('screenshots: selection and export scope', () => {
  for (const [theme, file] of THEMES) {
    test(`timeline with a selection and the bar, ${file}`, async ({ page }) => {
      const found = await open(page, `seed=demo&theme=${theme}`);
      await day(page, TODAY).locator('tr[data-testid="entry"]').nth(1).click();
      await day(page, YESTERDAY).locator('tr[data-testid="entry"]').first().click({ modifiers: ['ControlOrMeta'] });
      await expect(bar(page)).toBeVisible();
      await day(page, YESTERDAY).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, `gapfill-selection-${file}.png`) });
      await expectClean(page, found);
    });

    test(`export dialog with the scope, ${file}`, async ({ page }) => {
      const found = await open(page, `seed=demo&theme=${theme}`);
      await day(page, YESTERDAY).locator('tr[data-testid="entry"]').first().click();
      await bar(page).getByRole('button', { name: 'Export selected' }).click();
      await expect(page.getByTestId('selection-scope-note')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `gapfill-export-scope-${file}.png`) });
      await expectClean(page, found);
    });
  }
});
