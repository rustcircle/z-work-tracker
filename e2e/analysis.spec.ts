import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { MockState } from '../src/mocks/ipcMock';

// Demo seed: 12 March 2026 15:20 UTC, Thursday. My zone Lisbon (UTC+0 in March), Client zone New York.
// The figures asserted here are derived by hand in src/features/analysis/demo.test.ts.
const SHOTS = process.env.APP_SHOTS_DIR ?? path.resolve(import.meta.dirname, '../../.stack/out/rust-expert');
const DEMO_NOW = new Date('2026-03-12T15:20:00Z');
const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;
const SECTIONS = ['overview', 'time', 'projects', 'tasks', 'focus', 'consistency', 'goals', 'shifts', 'zones'] as const;

declare global {
  interface Window {
    __mock: MockState;
  }
}

interface Violations {
  csp: string[];
  errors: string[];
}

async function watch(page: Page): Promise<Violations> {
  const found: Violations = { csp: [], errors: [] };
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      if (/content security policy/i.test(m.text())) found.csp.push(m.text());
      else if (m.type() === 'error') found.errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => found.errors.push(e.message));
  return found;
}

async function expectClean(page: Page, found: Violations): Promise<void> {
  const fromEvents = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect([...found.csp, ...fromEvents], 'CSP violations').toEqual([]);
  expect(found.errors, 'console errors').toEqual([]);
}

/** Opens the app with a frozen clock and shows the Analysis tab (clicking its tab when a shell exists). */
async function openAnalysis(page: Page, query = 'seed=demo'): Promise<Violations> {
  const found = await watch(page);
  await page.clock.install({ time: DEMO_NOW });
  await page.clock.pauseAt(new Date(DEMO_NOW.getTime() + 1000));
  await page.goto(`/?${query}`);
  const tab = page.getByRole('tab', { name: 'Analysis' });
  if (await tab.count()) await tab.click();
  await expect(page.getByRole('heading', { name: 'Analysis', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Key figures' })).toBeVisible();
  return found;
}

const kpi = (page: Page, name: string): Locator => page.getByRole('article', { name, exact: true });
const controls = (page: Page): Locator => page.getByRole('group', { name: 'Analysis controls' });
const range = (page: Page, name: string): Promise<void> => controls(page).getByRole('radio', { name, exact: true }).click();
const section = (page: Page, id: string): Locator => page.locator(`#analysis-${id}`);
const card = (page: Page, title: string): Locator => page.locator('article.a-card', { has: page.getByRole('heading', { name: title, exact: true }) });

test.describe('figures against the demo fixture', () => {
  test('default week: totals, sessions, earnings and the comparison period', async ({ page }) => {
    const found = await openAnalysis(page);
    await expect(page.getByText('9 Mar – 15 Mar 2026', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Comparing with 2 Mar – 8 Mar 2026' })).toBeVisible();
    // Exact 23h 30m; Billable (15 min, up, once per task per day) 24h 15m.
    await expect(kpi(page, 'Total time')).toContainText('24h 15m');
    await expect(kpi(page, 'Total time')).toContainText('Billable 24h 15m · Exact 23h 30m');
    await expect(kpi(page, 'Active days')).toContainText('4 of 4');
    await expect(kpi(page, 'Sessions')).toContainText('13');
    // Website 22,500 billable s at EUR 60; Brand refresh 54,000 s at USD 90.
    await expect(kpi(page, 'Earnings')).toContainText('€375.00 + $1,350.00');
    await expect(page.getByText('Projection', { exact: true })).toBeVisible();
    await expectClean(page, found);
  });

  test('range switching: day, month, quarter, year, custom, previous and next', async ({ page }) => {
    const found = await openAnalysis(page);
    await range(page, 'Day');
    await expect(page.getByText('Thu 12 Mar 2026', { exact: true })).toBeVisible();
    await expect(kpi(page, 'Total time')).toContainText('3h 30m');
    await expect(kpi(page, 'Total time')).toContainText('Exact 3h 25m');

    await range(page, 'Month');
    await expect(page.getByText('March 2026', { exact: true })).toBeVisible();
    await controls(page).getByRole('radio', { name: 'Exact', exact: true }).click();
    await expect(kpi(page, 'Total time')).toContainText('57h 55m');

    await range(page, 'Week');
    await controls(page).getByRole('button', { name: 'Previous period' }).click();
    await expect(page.getByText('2 Mar – 8 Mar 2026', { exact: true })).toBeVisible();
    await expect(kpi(page, 'Total time')).toContainText('34h 25m');
    await controls(page).getByRole('button', { name: 'Next period' }).click();
    await expect(kpi(page, 'Total time')).toContainText('23h 30m');

    await range(page, 'Quarter');
    await expect(page.getByText('Q1 2026', { exact: true })).toBeVisible();
    await range(page, 'Year');
    await expect(page.getByText('2026', { exact: true }).first()).toBeVisible();
    await range(page, 'Custom');
    await page.getByLabel('From', { exact: true }).fill('2026-03-09');
    await page.getByLabel('To', { exact: true }).fill('2026-03-10');
    await expect(kpi(page, 'Total time')).toContainText('12h 10m');
    await expectClean(page, found);
  });

  test('project, band and shift filters change the figures; billable steps aside for time filters', async ({ page }) => {
    const found = await openAnalysis(page);
    await page.getByText('Projects: all').click();
    await page.getByRole('checkbox', { name: 'Website' }).check();
    await expect(kpi(page, 'Total time')).toContainText('6h 15m');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(kpi(page, 'Total time')).toContainText('24h 15m');

    await page.getByRole('combobox', { name: 'Band' }).selectOption({ label: 'Morning (06-12)' });
    await expect(kpi(page, 'Total time')).toContainText('9h 40m');
    await expect(controls(page).getByRole('radio', { name: 'Billable', exact: true })).toBeDisabled();
    await expect(page.getByText('Billable is off while a band or shift filter is on.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();

    await page.getByRole('combobox', { name: 'Shift' }).selectOption({ label: 'Morning' });
    await expect(kpi(page, 'Total time')).toBeVisible();
    await expectClean(page, found);
  });

  test('drill-down lists the tasks and segments behind a bar, in both zones', async ({ page }) => {
    const found = await openAnalysis(page);
    await card(page, 'Hours over time').getByRole('button', { name: /^Mon 9:/ }).click();
    const panel = page.getByRole('dialog', { name: 'Drill-down: Mon 9 Mar' });
    await expect(panel).toBeVisible();
    const tasks = panel.locator('.a-drill-tasks');
    await expect(tasks.getByText('Logo concepts')).toBeVisible();
    await expect(tasks.getByText('Brand guidelines')).toBeVisible();
    await expect(panel).toContainText('6h 05m exact');
    await expect(panel).toContainText('Segments (Lisbon / New York)');
    await expect(panel.getByText(/09:00-11:20/).first()).toBeVisible();
    // New York is on daylight time from 8 March (UTC-4), so 09:00-11:20 Lisbon is 05:00-07:20 there.
    await expect(panel.getByText(/05:00-07:20/).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // A project slice and a band bar drill down too.
    await card(page, 'Hours per band').getByRole('button', { name: /^Morning:/ }).click();
    await expect(page.getByRole('dialog', { name: 'Drill-down: Morning band' })).toContainText('9h 40m exact');
    await expectClean(page, found);
  });
});

test.describe('glossary, insights, privacy and sections', () => {
  test('glossary search and info popovers state Exact or Billable', async ({ page }) => {
    const found = await openAnalysis(page);
    await kpi(page, 'Total time').getByRole('button', { name: /About Total time/ }).click();
    await expect(page.getByRole('note')).toContainText('Follows the Basis switch');
    await page.getByRole('button', { name: 'Metrics glossary' }).click();
    const dialog = page.getByRole('dialog', { name: 'Metrics glossary' });
    await dialog.getByRole('searchbox', { name: 'Search metrics' }).fill('repeated hour');
    await expect(dialog.getByRole('heading', { name: /Hour-of-day histogram/ })).toBeVisible();
    await expect(dialog).toContainText('Uses Exact');
    await dialog.getByRole('searchbox', { name: 'Search metrics' }).fill('rounding');
    await expect(dialog).toContainText('Uses Billable');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expectClean(page, found);
  });

  test('insights are written from named metrics', async ({ page }) => {
    const found = await openAnalysis(page);
    const insights = page.getByRole('article', { name: 'Insights' });
    await expect(insights).toContainText('You logged 24h 15m (billable) in 9 Mar – 15 Mar 2026');
    await expect(insights.getByRole('button', { name: 'Metric volume.total' })).toBeVisible();
    await expectClean(page, found);
  });

  test('Hide earnings masks the amounts in cards, insights and tooltips', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=demo&hide=1');
    await expect(kpi(page, 'Earnings')).toContainText('••••');
    await expect(page.getByRole('article', { name: 'Insights' })).not.toContainText(/[€$]\d/);
    await expect(section(page, 'goals')).not.toContainText(/[€$]\d/);
    await expectClean(page, found);
  });

  test('charts: every required chart is present and has a data table', async ({ page }) => {
    const found = await openAnalysis(page);
    for (const label of [
      /^Hours per (day|week|month|hour) for .*, stacked by project/,
      /^Calendar heatmap/,
      /^Hours per band/,
      /^Hours by hour of day/,
      /^Heatmap of logged time/,
      /^Share of time per project/,
      /^Projects ranked by time/,
      /^Stacked area of project time/,
      /^Top tasks by time/,
      /^Number of sessions by length/,
      /^Worked and paused time/,
      /^Focus ratio over time/,
      /^Context switches per day/,
      /^Typical start and finish/,
      /^Daily target|^Weekly target/,
      /^Cumulative hours on/,
      /^Billable time on billable/,
      /^Earnings in/,
      /^Scheduled and worked hours per shift/,
      /^Hours by band in Lisbon/,
    ]) {
      await expect(page.getByRole('img', { name: label }).first(), String(label)).toBeAttached();
    }
    const table = card(page, 'Hours over time');
    await table.getByText('View data').click();
    await expect(table.getByRole('table')).toContainText('Mon 9');
    await expectClean(page, found);
  });

  test('empty store shows invitations, never NaN or blank axes', async ({ page }) => {
    const found = await openAnalysis(page, 'seed=empty');
    await expect(page.getByText('No logged time here')).toBeVisible();
    await expect(page.getByText('No time logged in this period').first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText('NaN');
    await expect(page.getByText('Set up goals, budgets and rates')).toBeVisible();
    await expect(page.getByText('No shifts set up yet')).toBeVisible();
    await expect(page.getByText('No client zone set')).toBeVisible();
    await expectClean(page, found);
  });

  test('the running segment is included and the page stays responsive', async ({ page }) => {
    const found = await openAnalysis(page);
    await expect(page.getByText('The running task is included')).toBeVisible();
    await page.clock.fastForward(5 * 60_000);
    await expect(kpi(page, 'Total time')).toContainText('Exact 23h 35m');
    await expectClean(page, found);
  });
});

test.describe('screenshots in all four themes', () => {
  for (const [theme, slug] of THEMES) {
    test(`sections in ${slug}`, async ({ page }) => {
      const found = await openAnalysis(page, `seed=demo&theme=${theme}`);
      await range(page, 'Month');
      await expect(page.getByText('March 2026', { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `analysis-top-${slug}.png`) });
      // A tall window so each section is captured whole, without the sticky bars over it.
      await page.setViewportSize({ width: 1360, height: 7000 });
      await page.waitForTimeout(300);
      for (const id of SECTIONS) await section(page, id).screenshot({ path: path.join(SHOTS, `analysis-${id}-${slug}.png`) });
      await expectClean(page, found);
    });
  }
});
