import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { DEMO_NOW, SHOTS, dismissAway, expectClean, watch, type Violations } from './support';

// Phase 2 demo seed (?seed=p2), 12 March 2026 15:20 UTC, My zone Lisbon (UTC+0 in March). The default week is
// 9-15 March. The figures asserted here are derived in src/features/analysis/metrics.p2.test.ts:
//   Exact 22h 55m, Billable 24h 00m: the 30 min billable pause on 12 March is Billable only, rounding adds 35 min.
//   Thinking 25m (10 March), unconfirmed 30m (the pending away stretch in the running segment).
//   Print run (fixed fee, 1,000.00 EUR): 17h 15m billable over all time, so 57.97 an hour, 86% of the fee: a warning.
//   Tags (Billable): Concept 17h 15m, Revision 12h 30m, No tag 0h: they overlap (Brand guidelines has both).
const NOW = new Date(DEMO_NOW);

async function openAnalysis(page: Page, query = 'seed=p2'): Promise<Violations> {
  const found = await watch(page);
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(new Date(NOW.getTime() + 1000));
  await page.goto(`/?${query}`);
  await dismissAway(page);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Analysis', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Key figures' })).toBeVisible();
  return found;
}

const kpi = (page: Page, name: string): Locator => page.getByRole('article', { name, exact: true });
const card = (page: Page, title: string): Locator => page.locator('article.a-card', { has: page.getByRole('heading', { name: title, exact: true }) });
const controls = (page: Page): Locator => page.getByRole('group', { name: 'Analysis controls' });
/** Makes the mock hand out a fresh snapshot after the test edited its state: switch the zone and back. */
async function refreshZone(page: Page): Promise<void> {
  const zone = page.getByRole('region', { name: 'Analysis' });
  await zone.getByRole('button', { name: 'UTC', exact: true }).first().click();
  await zone.getByRole('button', { name: 'My time' }).first().click();
}
const shot = (name: string): string => path.join(SHOTS, name);

test.describe('billable pauses, thinking and unconfirmed time', () => {
  test('a billable pause is in Billable and not in Exact; thinking and unconfirmed time are reported apart', async ({ page }) => {
    const found = await openAnalysis(page);
    await expect(kpi(page, 'Total time')).toContainText('24h 00m');
    await expect(kpi(page, 'Total time')).toContainText('Billable 24h 00m (includes 30m billable pauses) · Exact 22h 55m');

    const pieces = card(page, 'Billable pauses and thinking');
    await expect(pieces.getByText('Billable pauses', { exact: true }).first()).toBeVisible();
    await expect(pieces.locator('.a-stat', { hasText: 'Billable pauses' })).toContainText('30m in Billable, not in Exact');
    await expect(pieces.locator('.a-stat', { hasText: 'Thinking time' })).toContainText('25m in Exact and Billable');
    await expect(pieces.locator('.a-stat', { hasText: 'Unconfirmed time' })).toContainText('30m counts nowhere until confirmed');

    // The rounding adjustment is Billable minus Exact: 1h 05m, of which 30m are the pause.
    const rounding = card(page, 'Rounding adjustment');
    await expect(rounding).toContainText('Billable time is 1h 05m more than Exact');
    await expect(rounding).toContainText('Of that, 30m is billable pauses and 35m is rounding up');

    // Exact leaves the pause out; the pause is not worked time.
    await controls(page).getByRole('radio', { name: 'Exact', exact: true }).click();
    await expect(kpi(page, 'Total time')).toContainText('22h 55m');
    await expect(kpi(page, 'Sessions')).toBeVisible();

    await controls(page).getByRole('radio', { name: 'Billable', exact: true }).click();
    await pieces.scrollIntoViewIfNeeded();
    await pieces.screenshot({ path: shot('analysis-p2-time.png') });

    // The info popover opens the glossary entry.
    await pieces.getByRole('button', { name: 'About Billable pause time' }).first().click();
    await expect(page.getByRole('note')).toContainText('not worked time');
    await expectClean(page, found);
  });

  test('billable pauses leave with Billable under a band filter', async ({ page }) => {
    const found = await openAnalysis(page);
    await page.getByRole('combobox', { name: 'Band' }).selectOption({ label: 'Morning (06-12)' });
    const pieces = card(page, 'Billable pauses and thinking');
    await expect(pieces.locator('.a-stat', { hasText: 'Billable pauses' })).toContainText('Hidden');
    await expect(pieces.locator('.a-stat', { hasText: 'Billable pauses' })).toContainText('Pauses belong to Billable, which is off under a band or shift filter');
    await expectClean(page, found);
  });
});

test.describe('fixed fee and budget status', () => {
  test('a fixed-fee project shows its effective hourly rate instead of "No rate set"', async ({ page }) => {
    const found = await openAnalysis(page);
    await expect(kpi(page, 'Fixed fee')).toContainText('€57.97 per hour');
    const fixed = card(page, 'Fixed-fee projects');
    const row = fixed.getByRole('row', { name: /Print run/ });
    await expect(row).toContainText('€1,000.00');
    await expect(row).toContainText('17h 15m');
    await expect(row).toContainText('€57.97 per hour');
    await expect(row).toContainText('86%');
    // Packaging has no rate; the fixed-fee project is not listed as missing one.
    const invite = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'No rate set', exact: true }) });
    await expect(invite).toContainText('Packaging');
    await expect(invite).not.toContainText('Print run');
    await fixed.scrollIntoViewIfNeeded();
    await fixed.screenshot({ path: shot('analysis-fixed-fee.png') });
    await expectClean(page, found);
  });

  test('budget status says the level in words: warning at 80%, within budget below', async ({ page }) => {
    const found = await openAnalysis(page);
    const budget = card(page, 'Budget status');
    await expect(budget.getByTestId('budget-level-p-print')).toContainText('Warning: 80% reached');
    await expect(budget.getByTestId('budget-level-p-web')).toContainText('Within budget');
    await expect(budget.locator('li', { hasText: 'Print run' })).toContainText('86% used');
    await expect(budget.locator('li', { hasText: 'Print run' })).toContainText('Basis: fee');
    await expect(budget.locator('li', { hasText: 'Website' })).toContainText('Basis: hours');
    await expect(budget.getByRole('img', { name: /Print run \(fixed fee\): 86% of the fixed fee used\. Warning: 80% reached/ })).toBeVisible();
    await budget.scrollIntoViewIfNeeded();
    await budget.screenshot({ path: shot('analysis-budget.png') });
    await expectClean(page, found);
  });

  test('a fixed fee without a price per hour says it cannot be measured', async ({ page }) => {
    const found = await openAnalysis(page);
    await page.evaluate(() => {
      const p = window.__mock.projects.find((x) => x.id === 'p-print');
      if (p) p.billingType = 'fixedFee';
      window.__mock.rates = window.__mock.rates.filter((r) => r.projectId !== 'p-print');
    });
    await refreshZone(page);
    const budget = card(page, 'Budget status');
    await expect(budget).toContainText('A fixed fee needs a price per hour to measure against');
    await expect(budget.getByRole('button', { name: 'Set a rate for Print run (fixed fee)' })).toBeVisible();
    await expectClean(page, found);
  });

  test('Hide earnings masks the fee, the rate and the insights', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=p2&hide=1');
    await expect(kpi(page, 'Fixed fee')).toContainText('••••');
    await expect(kpi(page, 'Fixed fee')).not.toContainText(/[€$]\d/);
    const fixed = card(page, 'Fixed-fee projects');
    await expect(fixed).toContainText('••••');
    await expect(fixed).not.toContainText(/[€$]\d/);
    await expect(card(page, 'Budget status')).not.toContainText(/[€$]\d/);
    await expect(page.getByRole('article', { name: 'Insights' })).not.toContainText(/[€$]\d/);
    await expect(page.locator('#analysis-goals')).not.toContainText(/[€$]\d/);
    await expect(page.locator('#analysis-projects')).not.toContainText(/[€$]\d/);
    await expectClean(page, found);
  });
});

test.describe('tags', () => {
  test('the tag chart overlaps and is never totalled; the data table has no total row', async ({ page }) => {
    const found = await openAnalysis(page);
    const tags = card(page, 'Time by tag');
    await expect(tags.getByRole('img', { name: /Time by tag\. A task with two tags counts fully in each/ })).toBeVisible();
    await expect(tags.getByRole('button', { name: 'Concept: 17h 15m · 72%' })).toBeVisible();
    await expect(tags.getByRole('button', { name: 'Revision: 12h 30m · 52%' })).toBeVisible();
    await expect(tags).toContainText('Shares are of the total time of all tasks (24h 00m) and overlap, so they can add up to more than 100%');
    await expect(tags).toContainText('There is no total across tags');
    await tags.getByText('View data').click();
    const rows = tags.getByRole('table').getByRole('row');
    // Header, Concept, Revision, Admin: no total row.
    await expect(rows).toHaveCount(4);
    await expect(tags.getByRole('rowheader')).toHaveText(['Concept', 'Revision', 'Admin']);
    await page.locator('#analysis-tags').scrollIntoViewIfNeeded();
    await page.locator('#analysis-tags').screenshot({ path: shot('analysis-tags.png') });
    await expectClean(page, found);
  });

  test('the tag filter keeps whole tasks, so Billable stays available; drill-down shows the tags', async ({ page }) => {
    const found = await openAnalysis(page);
    const tagFilter = page.getByRole('group', { name: 'Tag filter' });
    await tagFilter.getByRole('checkbox', { name: 'Revision' }).check();
    await expect(tagFilter).toContainText('Tasks with any selected tag');
    await expect(kpi(page, 'Total time')).toContainText('12h 30m');
    await expect(controls(page).getByRole('radio', { name: 'Billable', exact: true })).toBeEnabled();
    await expect(page.getByText('Billable is off while a band or shift filter is on.')).toBeHidden();
    // Whole tasks stay whole: Brand guidelines keeps its Concept tag, so Concept is still in the chart.
    await expect(card(page, 'Time by tag').getByRole('button', { name: /^Concept:/ })).toBeVisible();

    await card(page, 'Time by tag').getByRole('button', { name: /^Revision:/ }).click();
    const panel = page.getByRole('dialog', { name: 'Drill-down: Tag: Revision' });
    await expect(panel).toBeVisible();
    const guide = panel.locator('.a-drill-tasks li', { hasText: 'Brand guidelines' });
    await expect(guide).toContainText('Concept');
    await expect(guide).toContainText('Revision');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(kpi(page, 'Total time')).toContainText('24h 00m');
    await expectClean(page, found);
  });
});

test.describe('glossary', () => {
  test('search finds the new entries', async ({ page }) => {
    const found = await openAnalysis(page);
    await page.getByRole('button', { name: 'Metrics glossary' }).click();
    const dialog = page.getByRole('dialog', { name: 'Metrics glossary' });
    const search = dialog.getByRole('searchbox', { name: 'Search metrics' });
    for (const [query, heading] of [
      ['billable pause', 'Billable pause time'],
      ['thinking', 'Thinking time'],
      ['unconfirmed', 'Unconfirmed time'],
      ['subtask', 'Subtask time'],
      ['by tag', 'Time by tag'],
      ['fixed fee', 'Effective hourly rate on a fixed fee'],
      ['budget used', 'Budget used'],
      ['billed', 'Billed and unbilled time'],
      ['rounding adjustment', 'Rounding adjustment'],
    ] as const) {
      await search.fill(query);
      await expect(dialog.getByRole('heading', { name: new RegExp(heading) }).first()).toBeVisible();
    }
    await search.fill('rounding adjustment');
    await expect(dialog).toContainText('rounding plus the billable pauses');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expectClean(page, found);
  });
});
