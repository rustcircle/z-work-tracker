import { expect, test, type Locator, type Page } from '@playwright/test';

import { advance, expectClean, open, refresh } from './support';

// The Timeline's days side by side, in a real browser under the production CSP, against the IPC mock: the oldest day on
// the left and today on the right, the arrows that page back and forward, and how many days fit the window's width.
// The demo has 14 days with time, Feb 23 to Mar 12, and the page opens at 1360 px, where two days fit.
const DAYS = 'article[data-day]';
const shown = (page: Page): Promise<(string | null)[]> => page.locator(DAYS).evaluateAll((els) => els.map((e) => e.getAttribute('data-day')));
const earlier = (page: Page): Locator => page.getByRole('button', { name: 'Earlier days' });
const later = (page: Page): Locator => page.getByRole('button', { name: 'Later days' });
const left = async (loc: Locator): Promise<number> => (await loc.boundingBox())?.x ?? Number.NaN;
const top = async (loc: Locator): Promise<number> => (await loc.boundingBox())?.y ?? Number.NaN;
const TODAY = 'Thu 12 Mar 2026';
const YESTERDAY = 'Wed 11 Mar 2026';
const day = (page: Page, name: string): Locator => page.getByRole('article', { name });

test.describe('the Timeline days, side by side', () => {
  test('open with today on the right, older days to its left on the same row, and Later days off', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await expect(page.locator(DAYS)).toHaveCount(2);
    expect(await shown(page)).toEqual(['2026-03-11', '2026-03-12']);
    // On screen as well as in the page: yesterday is left of today, and they start on the same line.
    expect(await left(day(page, YESTERDAY))).toBeLessThan(await left(day(page, TODAY)));
    expect(await top(day(page, YESTERDAY))).toBeCloseTo(await top(day(page, TODAY)), 0);
    await expect(later(page)).toBeDisabled();
    await expect(earlier(page)).toBeEnabled();
    await expect(page.getByTestId('day-range')).toHaveText('Wed 11 Mar 2026 to Thu 12 Mar 2026');
    await expectClean(page, found);
  });

  test('every day keeps its header totals, per-project totals, axis, bands and entries', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    for (const name of [YESTERDAY, TODAY]) {
      const card = day(page, name);
      await expect(card.getByTestId('day-billable')).toContainText('h');
      await expect(card.getByRole('list', { name: 'Totals per project' })).toBeVisible();
      await expect(card.getByRole('group', { name: 'Lisbon time axis' })).toBeVisible();
      await expect(card.getByTestId('shift-band')).toHaveCount(2);
      await expect(card.getByRole('rowgroup', { name: 'Morning 06–12' })).toBeVisible();
      await expect(card.getByRole('rowgroup', { name: 'Afternoon 12–18' })).toBeVisible();
      expect(await card.getByTestId('entry').count()).toBeGreaterThan(0);
    }
    await expect(day(page, TODAY).getByTestId('block')).toHaveCount(3);
    await expect(day(page, TODAY).getByTestId('day-exact')).toContainText('3h 25m');
    await expectClean(page, found);
  });

  test('Show both gives each day its client axis', async ({ page }) => {
    const found = await open(page, 'seed=demo&showBoth=1');
    for (const name of [YESTERDAY, TODAY]) {
      await expect(day(page, name).getByRole('group', { name: 'New York time axis' })).toBeVisible();
      await expect(day(page, name).getByTestId('both-note')).toBeVisible();
    }
    await expectClean(page, found);
  });

  test('the arrows page back and forward by a page, one page being as many days as fit', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await earlier(page).click();
    expect(await shown(page)).toEqual(['2026-03-09', '2026-03-10']);
    await expect(page.getByTestId('day-range')).toHaveText('Mon 9 Mar 2026 to Tue 10 Mar 2026');
    await expect(later(page)).toBeEnabled();
    await earlier(page).click();
    expect(await shown(page)).toEqual(['2026-03-05', '2026-03-06']);
    await later(page).click();
    expect(await shown(page)).toEqual(['2026-03-09', '2026-03-10']);
    await later(page).click();
    expect(await shown(page)).toEqual(['2026-03-11', '2026-03-12']);
    await expect(later(page)).toBeDisabled();
    await expectClean(page, found);
  });

  test('the arrows are buttons that Tab reaches, and Enter and Space press, with the focus staying on them or passing to the other one when one turns off', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    // Plain buttons in the tab order, each with its name as a tooltip too.
    await expect(earlier(page)).toHaveJSProperty('tabIndex', 0);
    await expect(earlier(page)).toHaveAttribute('title', 'Earlier days');
    await expect(later(page)).toHaveAttribute('title', 'Later days');
    // Tab from the last control of the filter above them lands on Earlier days. Later days is off, so Tab skips it until it is on.
    await page.getByTestId('task-filter-timeline').getByRole('checkbox').last().focus();
    await page.keyboard.press('Tab');
    await expect(earlier(page)).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await shown(page)).toEqual(['2026-03-09', '2026-03-10']);
    await expect(earlier(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(later(page)).toBeFocused();
    await page.keyboard.press('Space');
    expect(await shown(page)).toEqual(['2026-03-11', '2026-03-12']);
    await expect(later(page)).toBeDisabled();
    // Later days turned itself off with the keyboard on it. A disabled button drops the focus to the page, so the other arrow has it.
    await expect(earlier(page)).toBeFocused();
    // The same at the other end: Enter on Earlier days all the way back, and Later days takes the focus when it turns off.
    for (let i = 0; i < 12 && (await earlier(page).isEnabled()); i += 1) await page.keyboard.press('Enter');
    await expect(earlier(page)).toBeDisabled();
    expect(await shown(page)).toEqual(['2026-02-23', '2026-02-24']);
    await expect(later(page)).toBeFocused();
    await expectClean(page, found);
  });

  test('a wider window shows more days and a narrower one fewer, at least one, today always rightmost', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    const found = await open(page, 'seed=demo');
    await expect(page.locator(DAYS)).toHaveCount(1);
    expect(await shown(page)).toEqual(['2026-03-12']);
    await expect(later(page)).toBeDisabled();
    // Resized in place, with no reload: the strip follows the window and keeps today on the right.
    await page.setViewportSize({ width: 1920, height: 1000 });
    await expect(page.locator(DAYS)).toHaveCount(3);
    expect(await shown(page)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    await page.setViewportSize({ width: 2560, height: 1200 });
    await expect(page.locator(DAYS)).toHaveCount(4);
    expect(await shown(page)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12']);
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(page.locator(DAYS)).toHaveCount(1);
    expect(await shown(page)).toEqual(['2026-03-12']);
    await expectClean(page, found);
  });

  test('a window resized after paging back keeps the day at the right edge', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await earlier(page).click();
    expect(await shown(page)).toEqual(['2026-03-09', '2026-03-10']);
    await page.setViewportSize({ width: 1920, height: 1000 });
    await expect(page.locator(DAYS)).toHaveCount(3);
    expect(await shown(page)).toEqual(['2026-03-06', '2026-03-09', '2026-03-10']);
    await expect(later(page)).toBeEnabled();
    await expectClean(page, found);
  });

  test('paging keeps the selection, and the bar says when it is on a day not shown', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const row = day(page, TODAY).locator('tr[data-testid="entry"]').first();
    await row.click();
    const bar = page.getByTestId('selection-bar');
    await expect(bar.getByTestId('selection-count')).toContainText('1 task selected');
    await expect(bar).not.toContainText('not on screen');
    await earlier(page).click();
    await expect(day(page, TODAY)).toHaveCount(0);
    await expect(bar.getByTestId('selection-count')).toContainText('1 task selected');
    await expect(bar).toContainText('1 of them is not on screen now');
    await later(page).click();
    await expect(day(page, TODAY).locator('tr[aria-selected="true"]').first()).toBeVisible();
    await expect(bar).not.toContainText('not on screen');
    await expectClean(page, found);
  });

  test('a task name with no spaces breaks inside its column, so it cannot stretch a day over the next one', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    const found = await open(page, 'seed=demo');
    await page.evaluate((name) => {
      const t = window.__mock.tasks.find((x) => x.id === 't-box');
      if (t) t.name = name;
    }, `https://example.com/${'a'.repeat(170)}`);
    await refresh(page);
    await expect(page.locator(DAYS)).toHaveCount(3);
    // Tuesday holds the long name. No day is wider than its own column, and none overlaps the next.
    for (const card of await page.locator(DAYS).all()) expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const [a, b] = [await page.getByRole('article', { name: 'Tue 10 Mar 2026' }).boundingBox(), await page.getByRole('article', { name: YESTERDAY }).boundingBox()];
    expect((a?.x ?? Number.NaN) + (a?.width ?? Number.NaN)).toBeLessThanOrEqual(b?.x ?? Number.NaN);
    await expectClean(page, found);
  });

  test('Hide earnings masks the amounts of the days paged to as well', async ({ page }) => {
    const found = await open(page, 'seed=demo&hide=1');
    await earlier(page).click();
    await earlier(page).click();
    expect(await shown(page)).toEqual(['2026-03-05', '2026-03-06']);
    await expect(day(page, 'Fri 6 Mar 2026').getByTestId('day-billable')).toContainText('h');
    await expect(page.locator('body')).not.toContainText(/[$€]\d/);
    await expectClean(page, found);
  });

  test('today keeps counting while it is paged away and back', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await expect(day(page, TODAY).getByTestId('day-exact')).toContainText('3h 25m');
    await earlier(page).click();
    await advance(page, 60);
    await later(page).click();
    await expect(day(page, TODAY).getByTestId('day-exact')).toContainText('3h 26m');
    await advance(page, 60);
    await expect(day(page, TODAY).getByTestId('day-exact')).toContainText('3h 27m');
    await expectClean(page, found);
  });
});
