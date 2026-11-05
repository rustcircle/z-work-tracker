import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectClean, watch, type Violations } from './support';

// The ten screenshots of the Microsoft Store listing, 1920 x 1080, of three people's stores (src/mocks/storeSeed.ts) in the
// e2e build against the IPC mock. They are made on purpose, not by the normal run: the whole file is skipped unless
// ZWT_STORE_SHOTS is set, so it never touches the owner's folder from a plain `pnpm exec playwright test`.
//   ZWT_STORE_SHOTS=1 pnpm exec playwright test e2e/store-shots.spec.ts
// writes them to ~/msix-build/store-listing-screenshots-1.4.0/, or to ZWT_STORE_SHOTS_DIR when that is set. A folder of an earlier
// version is never named here, so it is never overwritten.
//   web developer   01 Timeline, 02 subtask tags, 03 Share of time by tag, 04 Billing
//   software engineer   05 Timeline with both zones, 06 Analysis, 07 Projects
//   data scientist  08 Share of time by subtask, 09 Goals and money, 10 Export (the PDF timesheet)
const ENABLED = Boolean(process.env.ZWT_STORE_SHOTS);
const OUT = process.env.ZWT_STORE_SHOTS_DIR ?? path.join(homedir(), 'msix-build', 'store-listing-screenshots-1.4.0');

// The moment the three stores stand at, as in storeSeed.ts (the page checks that the mock agrees): Friday 6 November 2026.
const STORE_NOW = '2026-11-06T16:40:00Z';
const SIZE = { width: 1920, height: 1080 };

async function openStore(page: Page, query: string): Promise<Violations> {
  const found = await watch(page);
  await page.clock.install({ time: new Date(STORE_NOW) });
  // Stood still, so the running task's clock reads the same in every run.
  await page.clock.pauseAt(new Date(Date.parse(STORE_NOW) + 1000));
  await page.goto(`/?${query}`);
  await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
  expect(await page.evaluate(() => window.__mock.now), 'the mock stands at the same moment as the page').toBe(Date.parse(STORE_NOW) / 1000);
  return found;
}

/** Takes the picture, and checks that it is what the Store wants: a PNG of exactly 1920 x 1080. */
async function shoot(page: Page, file: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Out of the way of every control, so nothing shows as hovered.
  await page.mouse.move(SIZE.width - 4, SIZE.height - 4);
  const png = await page.screenshot({ path: path.join(OUT, file), animations: 'disabled', caret: 'hide' });
  // The PNG header: width and height are the two 32-bit numbers after the signature and the IHDR tag.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${file} size`).toEqual([SIZE.width, SIZE.height]);
}

/** Scrolls the tab panel until `target` starts `offset` pixels under the panel's top edge, which leaves room for what sticks there. */
async function scrollTo(target: Locator, offset: number): Promise<void> {
  await target.evaluate((el, by) => {
    const panel = el.closest('.tabpanel');
    if (!(panel instanceof HTMLElement)) throw new Error('scrollTo: the element is not in a tab panel');
    panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - by;
  }, offset);
}

const tab = (page: Page, name: string): Promise<void> => page.getByRole('tab', { name, exact: true }).click();
const analysis = (page: Page): Locator => page.getByRole('region', { name: 'Analysis', exact: true });
const share = (page: Page): Locator => page.locator('article.a-card', { has: page.getByRole('heading', { name: 'Share of time', exact: true }) });
const section = (page: Page, id: string): Locator => page.locator(`section#analysis-${id}`);
/** The row of buttons that jumps to a section of Analysis sticks at the top of the panel; this is room for it. */
const NAV = 56;

test.describe('Store screenshots', () => {
  test.skip(!ENABLED, 'set ZWT_STORE_SHOTS=1 to make the Store screenshots');
  test.use({ viewport: SIZE, deviceScaleFactor: 1 });

  // ---------------------------------------------------------------- the web developer

  test('01 web developer: the Timeline, three days side by side', async ({ page }) => {
    const found = await openStore(page, 'seed=store-web');
    await expect(page.locator('article[data-day]')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Later days' })).toBeDisabled();
    await shoot(page, '01-web-developer-timeline.png');
    await expectClean(page, found);
  });

  test('02 web developer: the tags of a subtask', async ({ page }) => {
    const found = await openStore(page, 'seed=store-web');
    const card = page.getByRole('article', { name: 'Checkout flow', exact: true });
    await card.getByRole('button', { name: 'Tags for Payment API: Backend', exact: true }).click();
    const list = card.getByRole('dialog', { name: 'Tags for Payment API', exact: true });
    await expect(list.getByRole('checkbox', { name: 'Backend' })).toBeChecked();
    await expect(list.getByRole('checkbox', { name: 'Frontend' })).not.toBeChecked();
    await shoot(page, '02-web-developer-subtask-tags.png');
    await expectClean(page, found);
  });

  test('03 web developer: Share of time by tag', async ({ page }) => {
    const found = await openStore(page, 'seed=store-web');
    await tab(page, 'Analysis');
    await expect(analysis(page)).toBeVisible();
    await share(page).getByRole('radiogroup', { name: 'Share of time by' }).getByRole('radio', { name: 'Tags', exact: true }).click();
    await expect(share(page).locator('ul.a-share-legend')).toHaveAttribute('aria-label', 'Share of time legend, tags');
    await scrollTo(section(page, 'projects'), NAV);
    await shoot(page, '03-web-developer-share-of-time-tags.png');
    await expectClean(page, found);
  });

  test('04 web developer: Billing, unbilled time and the summaries already issued', async ({ page }) => {
    const found = await openStore(page, 'seed=store-web');
    await tab(page, 'Billing');
    await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption({ label: 'Online store rebuild' });
    await expect(page.getByRole('list', { name: 'Billing summaries' })).toBeVisible();
    // The title and the notice above go off the top, and the summaries already issued come up under the unbilled rows.
    await scrollTo(page.getByRole('heading', { name: 'Summaries', level: 3, exact: true }), 650);
    await shoot(page, '04-web-developer-billing.png');
    await expectClean(page, found);
  });

  // ---------------------------------------------------------------- the software engineer

  test('05 software engineer: the Timeline with both time zones', async ({ page }) => {
    const found = await openStore(page, 'seed=store-swe&showBoth=1');
    await expect(page.locator('article[data-day]')).toHaveCount(3);
    await expect(page.getByRole('article', { name: 'Fri 6 Nov 2026' }).getByRole('group', { name: 'Los Angeles time axis' })).toBeVisible();
    await shoot(page, '05-software-engineer-timeline-two-zones.png');
    await expectClean(page, found);
  });

  test('06 software engineer: Analysis', async ({ page }) => {
    const found = await openStore(page, 'seed=store-swe');
    await tab(page, 'Analysis');
    await expect(page.getByRole('list', { name: 'Key figures' })).toBeVisible();
    await shoot(page, '06-software-engineer-analysis.png');
    await expectClean(page, found);
  });

  test('07 software engineer: Projects, with budgets and a fixed fee', async ({ page }) => {
    const found = await openStore(page, 'seed=store-swe');
    await tab(page, 'Projects');
    await expect(page.getByRole('heading', { name: 'Projects', level: 2 })).toBeVisible();
    await shoot(page, '07-software-engineer-projects.png');
    await expectClean(page, found);
  });

  // ---------------------------------------------------------------- the data scientist

  test('08 data scientist: Share of time by subtask', async ({ page }) => {
    const found = await openStore(page, 'seed=store-data');
    await tab(page, 'Analysis');
    await page.getByRole('group', { name: 'Analysis controls' }).getByRole('combobox', { name: 'Task', exact: true }).selectOption({ label: 'Churn model v2' });
    // One task chosen: the card opens on its subtasks by itself.
    await expect(share(page).getByRole('radio', { name: 'Subtasks', exact: true })).toBeChecked();
    await scrollTo(section(page, 'projects'), NAV);
    await shoot(page, '08-data-scientist-share-of-time-subtasks.png');
    await expectClean(page, found);
  });

  test('09 data scientist: Goals and money', async ({ page }) => {
    const found = await openStore(page, 'seed=store-data');
    await tab(page, 'Analysis');
    await expect(analysis(page)).toBeVisible();
    await scrollTo(section(page, 'goals'), NAV);
    await shoot(page, '09-data-scientist-goals-and-money.png');
    await expectClean(page, found);
  });

  test('10 data scientist: Export, on the PDF timesheet', async ({ page }) => {
    const found = await openStore(page, 'seed=store-data');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: /PDF timesheet/ }).click();
    await expect(dialog.getByRole('textbox', { name: 'Title' })).toBeVisible();
    await shoot(page, '10-data-scientist-export.png');
    await expectClean(page, found);
  });
});
