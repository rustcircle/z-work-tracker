import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { MockTask } from '../src/mocks/ipcMock';
import type { PdfRequest, Snapshot } from '../src/lib/types';
import { SHOTS, advance, expectClean, open, refresh, tab } from './support';

// Billing tab, quote helper, device prefix and PDF timesheet. Seed p2 (12 March 2026, My zone Lisbon, active
// zone Lisbon): summaries A-001 (live) and A-002 (voided) exist, so the next reference is A-003.
// Hand-computed from the seed in the Lisbon zone, March 2026:
//   Brand refresh (USD, $80/h until 9 March, $90/h after, client zone New York): rows exact 28h 30m, billable 30h 00m,
//     including one 30 minute billable pause on 12 March (2h 05m exact, 2h 45m billable), and a running segment.
//   Website (EUR 60/h): 5 rows, exact 18h 25m, billable 18h 45m, EUR 1,125.00.
//   Packaging has no rate; Print run is fixed fee EUR 1,000.00.

const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const GUIDANCE = 'For your own guidance. Not an invoice, not a tax document.';

const calls = (page: Page, cmd: string): Promise<unknown[]> => page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

const snapshotOf = (page: Page): Promise<Snapshot> => page.evaluate(() => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<Snapshot> } }).__TAURI_INTERNALS__.invoke('get_snapshot'));

const unbilled = (page: Page): Locator => page.getByRole('region', { name: 'Unbilled time' });
const summaries = (page: Page): Locator => page.getByRole('region', { name: 'Summaries' });
const quote = (page: Page): Locator => page.getByRole('region', { name: 'Quote helper' });

async function openBilling(page: Page, query = 'seed=p2'): Promise<Awaited<ReturnType<typeof open>>> {
  const found = await open(page, query);
  await tab(page, 'Billing');
  await expect(page.getByRole('region', { name: 'Billing', exact: true })).toBeVisible();
  return found;
}

async function pickProject(page: Page, name: string): Promise<void> {
  await unbilled(page).getByLabel('Project', { exact: true }).selectOption({ label: name });
}

/** Four finished Poster jobs of 1, 2, 3 and 4 hours in Brand refresh, on days of their own in February (UTC = Lisbon then). */
async function addPosterJobs(page: Page, hours: number[]): Promise<void> {
  await page.evaluate((hs) => {
    const s = window.__mock;
    const names = ['Poster concepts', 'Poster draft', 'Poster revision', 'Poster final'];
    hs.forEach((h, i) => {
      const id = `t-poster-${i}`;
      const task: MockTask = { id, name: names[i] ?? `Poster ${i}`, projectId: 'p-brand', description: null, state: 'stopped', pauseReason: null, createdAt: '2026-02-01T09:00:00Z', stoppedAt: `2026-02-${String(10 + i)}T18:00:00Z`, runningElsewhere: null, continuedFrom: null, tags: [] };
      s.tasks.push(task);
      const day = `2026-02-${String(10 + i)}`;
      const end = new Date(Date.parse(`${day}T09:00:00Z`) + h * 3600_000).toISOString().slice(0, 19) + 'Z';
      s.segments.push({ id: `sg-poster-${i}`, taskId: id, deviceId: '11111111-1111-4111-8111-111111111111', start: `${day}T09:00:00Z`, end, provisionalEnd: null });
    });
  }, hours);
  await refresh(page);
}

test.describe('billing tab', () => {
  test('opens from the keyboard with arrow keys and carries the guidance label, with no tax, sent or paid fields', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await page.getByRole('tab', { name: 'Timeline' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const billing = page.getByRole('tab', { name: 'Billing' });
    await expect(billing).toBeFocused();
    await expect(billing).toHaveAttribute('aria-selected', 'true');
    const region = page.getByRole('region', { name: 'Billing', exact: true });
    await expect(region).toBeVisible();
    await expect(page.getByTestId('billing-guidance')).toHaveText(GUIDANCE);
    // The label is in every card of the tab.
    for (const card of [unbilled(page), summaries(page), quote(page)]) await expect(card.getByText(GUIDANCE)).toBeVisible();
    // No tax, sent or paid anywhere on the tab (the label's own "not a tax document" is the only mention).
    const text = (await region.innerText()).replace(new RegExp(GUIDANCE.replaceAll('.', '\\.'), 'g'), '');
    expect(text).not.toMatch(/\b(tax|vat|sent|paid|unpaid)\b/i);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Analysis' })).toHaveAttribute('aria-selected', 'true');
    await expectClean(page, found);
  });

  test('says how much time away has no answer and is left out of the summary', async ({ page }) => {
    await openBilling(page);
    await expect(unbilled(page).getByTestId('billing-unconfirmed')).toHaveCount(0);
    // The seed's pending gap sits in the running segment. Close that segment, then ask again.
    await page.evaluate(() => {
      const s = window.__mock;
      const gap = s.gaps.find((g) => g.id === 'gap-pending')!;
      const seg = s.segments.find((x) => x.id === gap.segmentId)!;
      seg.end = gap.end;
    });
    await pickProject(page, 'Website');
    await pickProject(page, 'Brand refresh');
    await expect(unbilled(page).getByTestId('billing-unconfirmed')).toContainText('of time away has no answer yet');
  });

  test('previews unbilled rows with exact, billable and pauses, and says a running segment is not included', async ({ page }) => {
    await openBilling(page);
    const card = unbilled(page);
    // Brand refresh has the most unbilled time and a client zone: both are the defaults.
    await expect(card.getByLabel('Project', { exact: true })).toHaveValue('p-brand');
    await expect(card.getByLabel('Days are cut in')).toHaveValue('America/New_York');
    await expect(card.getByRole('radio', { name: 'Month' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByText('March 2026', { exact: true })).toBeVisible();
    await card.getByLabel('Days are cut in').selectOption('Europe/Lisbon');
    const table = card.getByRole('table');
    const row = table.getByRole('row').filter({ hasText: 'Thu 12 Mar 2026' });
    await expect(row.getByRole('cell').nth(1)).toHaveText('Logo concepts');
    await expect(row.getByRole('cell').nth(2)).toHaveText('2h 05m');
    await expect(row.getByRole('cell').nth(3)).toHaveText('2h 45mincludes 30m billable pauses');
    await expect(row.getByRole('cell').nth(4)).toHaveText('$247.50');
    const total = table.getByRole('row').last();
    await expect(total.getByRole('cell').nth(0)).toHaveText('28h 30m');
    await expect(total.getByRole('cell').nth(1)).toHaveText('30h 00mincludes 30m billable pauses');
    await expect(total.getByRole('cell').nth(2)).toHaveText('$2,540.00');
    await expect(card.getByTestId('billing-running')).toContainText('A running segment is not included');
    await expect(card.getByTestId('billing-total-amount')).toContainText('$2,540.00');
    expect(await calls(page, 'summary_preview')).toContainEqual({ request: { projectId: 'p-brand', from: '2026-03-01', to: '2026-03-31', zone: 'Europe/Lisbon' } });
  });

  test('thinking time counts in the preview, like work', async ({ page }) => {
    await openBilling(page);
    await pickProject(page, 'Packaging');
    const card = unbilled(page);
    await card.getByLabel('Days are cut in').selectOption('Europe/Lisbon');
    const box = card.getByRole('table').getByRole('row').filter({ hasText: 'Tue 10 Mar 2026' });
    await expect(box.getByRole('cell').nth(2)).toHaveText('2h 30m');
    // Packaging has no rate, so there is no amount column and the preview says so.
    await expect(card.getByRole('columnheader', { name: 'Amount' })).toHaveCount(0);
    await expect(card.getByText('No hourly rate applies in this period, so there is no amount.')).toBeVisible();
    // The 25 minutes of thinking on that day are part of the 2h 30m: drop them and the row shrinks.
    await page.evaluate(() => {
      const gap = window.__mock.gaps.find((g) => g.id === 'gap-think');
      if (gap) gap.decision = 'drop';
    });
    await refresh(page);
    await expect(box.getByRole('cell').nth(2)).toHaveText('2h 05m');
  });

  test('a fixed-fee project earns no hourly amount and shows its fee, which Hide earnings masks', async ({ page }) => {
    await openBilling(page);
    await pickProject(page, 'Print run (fixed fee)');
    const card = unbilled(page);
    await expect(card.getByTestId('billing-fixed-fee')).toContainText('Fixed fee: no hourly amount');
    await expect(card.getByTestId('billing-fixed-fee')).toContainText('€1,000.00');
    await expect(card.getByRole('columnheader', { name: 'Amount' })).toHaveCount(0);
    await expect(card.getByRole('table').getByRole('row')).toHaveCount(5); // head, three days, total
    await page.getByRole('button', { name: 'Hide earnings' }).click();
    await expect(card.getByTestId('billing-fixed-fee')).toContainText('Fixed fee: no hourly amount');
    await expect(card.getByTestId('billing-fixed-fee')).not.toContainText('€');
    await expect(card.getByTestId('billing-fixed-fee')).toContainText('••••');
  });

  test('empty period: says there is no unbilled time, and sends no create request', async ({ page }) => {
    await openBilling(page);
    await pickProject(page, 'Website');
    const card = unbilled(page);
    await card.getByRole('button', { name: 'Previous period' }).click();
    await expect(card.getByText('February 2026', { exact: true })).toBeVisible();
    await expect(card.getByText('There is no unbilled time in that period.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Create summary' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
    expect(await calls(page, 'create_summary')).toEqual([]);
  });

  test('a backend refusal is shown inline, not lost', async ({ page }) => {
    await openBilling(page);
    await pickProject(page, 'Website');
    const card = unbilled(page);
    await expect(card.getByRole('button', { name: 'Create summary' })).toBeEnabled();
    await page.evaluate(() => {
      window.__mock.failNext = ['create_summary'];
    });
    await card.getByRole('button', { name: 'Create summary' }).click();
    await expect(card.getByRole('alert')).toContainText('create_summary failed');
    // Nothing was created.
    expect((await snapshotOf(page)).billing.summaries).toHaveLength(2);
  });

  test('creating without touching the selectors keeps the project and zone, and shows what was created', async ({ page }) => {
    const found = await openBilling(page);
    const card = unbilled(page);
    // Nothing is chosen: Brand refresh has the most unbilled time, so it is the default, with its client zone.
    await expect(card.getByLabel('Project')).toHaveValue('p-brand');
    await expect(card.getByLabel('Days are cut in')).toHaveValue('America/New_York');
    await card.getByRole('button', { name: 'Create summary' }).click();
    const created = card.getByTestId('billing-created');
    await expect(created).toContainText('Created A-003');
    await expect(card.getByText('There is no unbilled time in that period.')).toBeVisible();
    await expect(card.getByLabel('Project')).toHaveValue('p-brand');
    await expect(card.getByLabel('Days are cut in')).toHaveValue('America/New_York');
    await expect(created).toContainText('Created A-003');
    await expect(created).toBeFocused();
    expect((await calls(page, 'create_summary')).map((c) => (c as { request: { projectId: string } }).request.projectId)).toEqual(['p-brand']);
    await expectClean(page, found);
  });

  test('Create summary marks the time billed, gives the next reference, and Void returns it without reusing the number', async ({ page }) => {
    const found = await openBilling(page);
    await pickProject(page, 'Website');
    const card = unbilled(page);
    const stats = card.getByTestId('billing-project-totals');
    await expect(stats).toContainText('18h 25m unbilled');
    await expect(stats).toContainText('12h 10m on live summaries');
    await expect(card.getByTestId('billing-total-amount')).toContainText('€1,125.00');

    await card.getByRole('button', { name: 'Create summary' }).click();
    expect(await calls(page, 'create_summary')).toEqual([{ request: { projectId: 'p-web', from: '2026-03-01', to: '2026-03-31', zone: 'Europe/Lisbon' } }]);
    // A-001 is live and A-002 voided: the next number is 3.
    const created = card.getByTestId('billing-created');
    await expect(created).toContainText('Created A-003');
    await expect(created).toBeFocused();
    await expect(card.getByText('There is no unbilled time in that period.')).toBeVisible();
    await expect(stats).toContainText('0s unbilled');
    await expect(stats).toContainText('30h 35m on live summaries');

    // The task data behind the cards: billed grew by the period's exact time, unbilled is gone.
    const afterCreate = (await snapshotOf(page)).tasks.find((t) => t.id === 't-home');
    expect([afterCreate?.billedSecs, afterCreate?.unbilledSecs]).toEqual([110_100, 0]);

    const list = summaries(page).getByRole('list', { name: 'Billing summaries' });
    const first = list.getByRole('listitem').first();
    await expect(first).toHaveAccessibleName('A-003, live');
    await expect(first.getByText('Live', { exact: true })).toBeVisible();
    await expect(first).toContainText('€1,125.00');
    await expect(first).toContainText('Website');

    // Void asks first. Cancelling leaves everything as it was and returns focus to the Void button.
    const voidA3 = first.getByRole('button', { name: 'Void A-003' });
    await voidA3.click();
    const dialog = page.getByRole('dialog', { name: 'Void A-003?' });
    await expect(dialog).toContainText('returns to unbilled');
    await expect(dialog).toContainText('A-003 is not reused');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(voidA3).toBeFocused();
    expect(await calls(page, 'void_summary')).toEqual([]);

    await voidA3.click();
    await page.getByRole('dialog', { name: 'Void A-003?' }).getByRole('button', { name: 'Void summary' }).click();
    const rowId = await first.getAttribute('id');
    expect(await calls(page, 'void_summary')).toEqual([{ id: rowId?.slice('summary-'.length) }]);
    await expect(first).toHaveAccessibleName('A-003, voided');
    await expect(first.getByText('Voided', { exact: true })).toBeVisible();
    await expect(first).toBeFocused();
    await expect(first.getByRole('button', { name: 'Void A-003' })).toHaveCount(0);
    // The time is unbilled again.
    await expect(stats).toContainText('18h 25m unbilled');
    await expect(card.getByTestId('billing-total-amount')).toContainText('€1,125.00');
    const afterVoid = (await snapshotOf(page)).tasks.find((t) => t.id === 't-home');
    expect([afterVoid?.billedSecs, afterVoid?.unbilledSecs]).toEqual([43_800, 66_300]);

    // The number 3 is gone for good: the next summary is A-004.
    await card.getByRole('button', { name: 'Create summary' }).click();
    await expect(card.getByTestId('billing-created')).toContainText('Created A-004');
    await expect(list.getByRole('listitem').first()).toHaveAccessibleName('A-004, live');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expectClean(page, found);
  });

  test('Create summary and Void can be done with the keyboard alone, and focus lands where it should', async ({ page }) => {
    await openBilling(page);
    await pickProject(page, 'Website');
    const card = unbilled(page);
    await card.getByRole('button', { name: 'Create summary' }).focus();
    await page.keyboard.press('Enter');
    await expect(card.getByTestId('billing-created')).toContainText('Created A-003');
    await expect(card.getByTestId('billing-created')).toBeFocused();
    const first = summaries(page).getByRole('listitem').first();
    await first.getByRole('button', { name: 'Void A-003' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Void A-003?' });
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
    // Close, Cancel, Void summary: the dialog keeps the focus inside, and Tab wraps.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Void summary' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Void summary' }).focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAccessibleName('A-003, voided');
    await expect(first).toBeFocused();
    // Copy by keyboard.
    await summaries(page).getByRole('listitem', { name: 'A-001, live' }).getByRole('button', { name: 'Copy A-001' }).focus();
    await page.keyboard.press('Space');
    await expect(summaries(page).getByRole('listitem', { name: 'A-001, live' }).getByRole('status').filter({ hasText: /Copied|Copying/ })).toBeVisible();
  });

  test('the summary list is newest first and shows reference, project, period, status and totals', async ({ page }) => {
    await openBilling(page);
    const items = summaries(page).getByRole('list', { name: 'Billing summaries' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAccessibleName('A-002, voided');
    await expect(items.nth(1)).toHaveAccessibleName('A-001, live');
    const a1 = items.nth(1);
    await expect(a1).toContainText('Website');
    await expect(a1).toContainText('Mon 23 Feb 2026 to Fri 27 Feb 2026 (Europe/Lisbon)');
    await expect(a1).toContainText('Live');
    await expect(a1).toContainText('Billable 12h 30m');
    await expect(a1).toContainText('€750.00');
    await expect(items.nth(0)).toContainText('Voided');
    await expect(items.nth(0)).toContainText('The number A-002 is not reused');
    // Rows open on demand.
    await a1.getByText('3 rows').click();
    await expect(a1.getByRole('table')).toBeVisible();
  });

  test('Copy puts plain text on the clipboard and says so', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openBilling(page);
    const card = unbilled(page);
    await card.getByLabel('Days are cut in').selectOption('Europe/Lisbon');
    await card.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(card.getByText('Copied to the clipboard.')).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const lines = text.split('\n');
    expect(lines[0]).toBe(GUIDANCE);
    expect(lines).toContain('Project: Brand refresh');
    expect(lines).toContain('Period: Sun 1 Mar 2026 to Tue 31 Mar 2026 (Europe/Lisbon)');
    expect(lines).toContain('Thu 12 Mar 2026 | Logo concepts | exact 2h 05m | billable 2h 45m (includes 30m billable pauses) | $247.50');
    expect(lines).toContain('Total | exact 28h 30m | billable 30h 00m (includes 30m billable pauses) | $2,540.00');
    expect(lines).toContain('A running segment is not included.');
    expect(text).not.toMatch(/<|>/);

    // A saved summary copies with its reference and status.
    const a1 = summaries(page).getByRole('listitem', { name: 'A-001, live' });
    await a1.getByRole('button', { name: 'Copy A-001' }).click();
    await expect(a1.getByText('Copied to the clipboard.')).toBeVisible();
    const saved = await page.evaluate(() => navigator.clipboard.readText());
    expect(saved.split('\n').slice(0, 3)).toEqual([GUIDANCE, 'A-001 (Live)', 'Project: Website']);
    expect(saved).toContain('Total | exact 12h 10m | billable 12h 30m | €750.00');
  });

  test('when the clipboard is unavailable the text is offered selected, with a visible message', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });
    await openBilling(page);
    const card = unbilled(page);
    await card.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(card.getByText('Copying is not available here.')).toBeVisible();
    const box = card.getByRole('textbox', { name: 'Text to copy' });
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(new RegExp(`^${GUIDANCE.replaceAll('.', '\\.')}\\nProject: Brand refresh`));
    const selected = await box.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd).length === el.value.length);
    expect(selected).toBe(true);
  });

  test('Export CSV asks the backend for that summary and shows the saved path, or that it was cancelled', async ({ page }) => {
    await openBilling(page);
    const a1 = summaries(page).getByRole('listitem', { name: 'A-001, live' });
    await a1.getByRole('button', { name: 'Export CSV for A-001' }).click();
    expect(await calls(page, 'export_summary_csv')).toEqual([{ id: 'summary-1002' }]);
    await expect(a1.getByText('Saved to /mock/A-001.csv')).toBeVisible();
    // The save dialog was cancelled: the backend answers null.
    await page.evaluate(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      internals.invoke = (cmd, args, options) => (cmd === 'export_summary_csv' ? Promise.resolve(null) : original(cmd, args, options));
    });
    await a1.getByRole('button', { name: 'Export CSV for A-001' }).click();
    await expect(a1.getByText('Cancelled. Nothing was saved.')).toBeVisible();
  });

  test('Hide earnings masks every price in the tab, and the copied text leaves amounts out', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openBilling(page, 'seed=p2&hide=1');
    const region = page.getByRole('region', { name: 'Billing', exact: true });
    const card = unbilled(page);
    await expect(card.getByTestId('billing-total-amount')).toContainText('••••');
    await expect(card.getByRole('table').getByRole('row').nth(1).getByRole('cell').nth(4)).toHaveText('••••');
    await expect(summaries(page).getByRole('listitem', { name: 'A-001, live' })).toContainText('••••');
    await expect(region).not.toContainText(/[$€]\d/);
    await card.getByRole('button', { name: 'Copy', exact: true }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).not.toMatch(/[$€]\d/);
    expect(text).toContain('Amounts are left out because Hide earnings is on.');
    // Hours are not masked.
    await expect(card.getByRole('table').getByRole('row').last()).toContainText('30h 00m');
  });
});

test.describe('quote helper', () => {
  test('gives hours and an amount range at the current rate from four comparable tasks, labelled Estimate', async ({ page }) => {
    await openBilling(page);
    await addPosterJobs(page, [1, 2, 3, 4]);
    const q = quote(page);
    await expect(q.getByText('Enter a job name, or pick a tag, to look for similar finished tasks.')).toBeVisible();
    await q.getByLabel('Job name').fill('Poster');
    await q.getByLabel('Project (optional)').selectOption({ label: 'Brand refresh' });
    await expect(q.getByText('Estimate', { exact: true })).toBeVisible();
    await expect(q.getByText('Based on 4 comparable tasks.')).toBeVisible();
    const hours = q.locator('dl.bl-figs').first();
    await expect(hours.locator('div').nth(0)).toHaveText('Typical (median)2h 30m');
    await expect(hours.locator('div').nth(1)).toHaveText('Range1h 00m to 4h 00m');
    await expect(hours.locator('div').nth(2)).toHaveText('Middle half1h 45m to 3h 15m');
    // Brand refresh is $90/h since 9 March: 2.5 h is $225.00.
    const money = q.getByTestId('quote-amount');
    await expect(money).toContainText('$90.00/h');
    await expect(money.locator('dl > div').nth(0)).toHaveText('Typical (median)$225.00');
    await expect(money.locator('dl > div').nth(1)).toHaveText('Range$90.00 to $360.00');
    await expect(money.locator('dl > div').nth(2)).toHaveText('Middle half$157.50 to $292.50');
    // Every comparable task is listed with its hours.
    const items = q.getByRole('list', { name: 'Comparable tasks' }).getByRole('listitem');
    await expect(items).toHaveCount(4);
    await expect(items.filter({ hasText: 'Poster final' })).toContainText('4h 00m');
    await expect(items.filter({ hasText: 'Poster concepts' })).toContainText('1h 00m');
    await expect(items.filter({ hasText: 'Poster draft' })).toContainText('Shares “poster”');
  });

  test('three comparable tasks give a median and a range but no middle half; two are not enough data', async ({ page }) => {
    await openBilling(page);
    await addPosterJobs(page, [1, 2, 3]);
    const q = quote(page);
    await q.getByLabel('Job name').fill('Poster');
    await expect(q.getByText('Based on 3 comparable tasks.')).toBeVisible();
    await expect(q.locator('dl.bl-figs').first().locator('div').nth(2)).toHaveText('Middle halfNeeds 4 or more tasks');
    await expect(q.getByText('Pick a project to see an amount at its hourly rate.')).toBeVisible();

    await page.evaluate(() => {
      window.__mock.tasks.pop();
    });
    await refresh(page);
    await expect(q.getByTestId('quote-not-enough')).toHaveText('Not enough data. An estimate needs at least 3 comparable finished tasks; found 2.');
    await expect(q.getByText('Estimate', { exact: true })).toBeVisible();
    // Still listed, but no figures.
    await expect(q.getByRole('list', { name: 'Comparable tasks' }).getByRole('listitem')).toHaveCount(2);
    await expect(q.getByText('Typical (median)')).toHaveCount(0);
  });

  test('has no amount for a project without a rate or on a fixed fee, and says why', async ({ page }) => {
    await openBilling(page);
    await addPosterJobs(page, [1, 2, 3]);
    const q = quote(page);
    await q.getByLabel('Job name').fill('Poster');
    await q.getByLabel('Project (optional)').selectOption({ label: 'Packaging' });
    await expect(q.getByText('This project has no hourly rate yet, so there is no amount.')).toBeVisible();
    await q.getByLabel('Project (optional)').selectOption({ label: 'Print run (fixed fee)' });
    await expect(q.getByText('This project is fixed fee, so there is no hourly amount.')).toBeVisible();
    await q.getByLabel('Project (optional)').selectOption({ label: 'Admin' });
    await expect(q.getByText('This project is not billable, so there is no amount.')).toBeVisible();
    // The hours stay.
    await expect(q.getByText('Based on 3 comparable tasks.')).toBeVisible();
  });

  test('tags select comparable tasks, and "Only compare with tasks of this project" narrows them', async ({ page }) => {
    await openBilling(page);
    const q = quote(page);
    // Only Box dieline carries Concept among the finished tasks of the seed.
    await q.getByRole('checkbox', { name: 'Concept' }).check();
    await expect(q.getByTestId('quote-not-enough')).toContainText('found 1');
    await expect(q.getByRole('list', { name: 'Comparable tasks' }).getByRole('listitem')).toHaveCount(1);
    await expect(q.getByRole('list', { name: 'Comparable tasks' })).toContainText('Box dieline');
    await q.getByRole('checkbox', { name: 'Concept' }).uncheck();
    await expect(q.getByText('Enter a job name, or pick a tag, to look for similar finished tasks.')).toBeVisible();
    // The project-only switch needs a project.
    const only = q.getByRole('checkbox', { name: 'Only compare with tasks of this project' });
    await expect(only).toBeDisabled();
    await q.getByLabel('Project (optional)').selectOption({ label: 'Packaging' });
    await expect(only).toBeEnabled();
  });

  test('Hide earnings masks the amounts and not the hours', async ({ page }) => {
    await openBilling(page, 'seed=p2&hide=1');
    await addPosterJobs(page, [1, 2, 3, 4]);
    const q = quote(page);
    await q.getByLabel('Job name').fill('Poster');
    await q.getByLabel('Project (optional)').selectOption({ label: 'Brand refresh' });
    await expect(q.locator('dl.bl-figs').first().locator('div').nth(0)).toHaveText('Typical (median)2h 30m');
    const money = q.getByTestId('quote-amount');
    await expect(money).toContainText('••••/h');
    await expect(money.locator('dl > div').nth(0)).toHaveText('Typical (median)••••');
    await expect(q).not.toContainText(/[$€]\d/);
  });
});

test.describe('device prefix', () => {
  test('explains references, saves a new prefix in capitals, and the next summary uses it', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Billing references' });
    await expect(section).toContainText('<prefix>-<number>');
    await expect(section).toContainText('never reused');
    const input = section.getByLabel('Prefix of this device');
    await expect(input).toHaveValue('A');
    await expect(section.getByTestId('next-reference')).toContainText('A-003');
    await input.fill('pc2');
    await expect(input).toHaveValue('PC2');
    await expect(section.getByTestId('next-reference')).toContainText('PC2-001');
    await input.press('Enter');
    expect(await calls(page, 'set_device_prefix')).toEqual([{ prefix: 'PC2' }]);
    await expect(section.getByText('Prefix saved: PC2.')).toBeVisible();
    expect((await snapshotOf(page)).billing.prefix).toBe('PC2');

    // Time passes, so the new summary is the newest.
    await advance(page, 60);
    await tab(page, 'Billing');
    await pickProject(page, 'Website');
    await unbilled(page).getByRole('button', { name: 'Create summary' }).click();
    await expect(unbilled(page).getByTestId('billing-created')).toContainText('Created PC2-001');
    await expect(summaries(page).getByRole('listitem').first()).toHaveAccessibleName('PC2-001, live');
    await expectClean(page, found);
  });

  test('shows the backend refusal for a prefix that is not allowed, and keeps the old one', async ({ page }) => {
    await open(page, 'seed=p2');
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Billing references' });
    const input = section.getByLabel('Prefix of this device');
    await input.fill('toolong');
    await section.getByRole('button', { name: 'Save prefix' }).click();
    await expect(section.getByRole('alert')).toHaveText('a prefix is 1 to 4 letters or digits');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    expect((await snapshotOf(page)).billing.prefix).toBe('A');
    await input.fill('A');
    await expect(section.getByRole('button', { name: 'Save prefix' })).toBeDisabled();
  });

  test('warns when another device uses the same prefix', async ({ page }) => {
    await open(page, 'seed=p2');
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Billing references' });
    await expect(section.getByTestId('prefix-clash')).toHaveCount(0);
    await page.evaluate(() => {
      window.__mock.otherPrefixes = { 'Office PC': 'A', Laptop: 'A' };
    });
    await refresh(page);
    const clash = section.getByTestId('prefix-clash');
    await expect(clash).toContainText('another device uses the same prefix');
    await expect(clash).toContainText('References could repeat');
    await expect(clash.getByRole('listitem')).toHaveText(['Office PC', 'Laptop']);
  });
});

test.describe('PDF timesheet', () => {
  async function openPdf(page: Page, query = 'seed=p2'): Promise<Locator> {
    await open(page, query);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('radio', { name: 'PDF timesheet (.pdf)' }).click();
    return dialog;
  }
  const pdfCalls = async (page: Page): Promise<PdfRequest[]> => (await calls(page, 'export_pdf')).map((c) => (c as { request: PdfRequest }).request);

  test('sends the exact request: project, period, the client zone by default, title, prices and no logo', async ({ page }) => {
    const dialog = await openPdf(page);
    await expect(dialog.getByText('Text outside Western European characters prints as ?')).toBeVisible();
    await dialog.getByLabel('Project', { exact: true }).selectOption({ label: 'Brand refresh' });
    await expect(dialog.getByLabel('Days are cut in')).toHaveValue('America/New_York');
    await expect(dialog.getByLabel('Title')).toHaveValue('Timesheet: Brand refresh');
    await expect(dialog.getByRole('switch', { name: 'Include prices' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    expect(await pdfCalls(page)).toEqual([{ projectId: 'p-brand', from: '2026-03-01', to: '2026-03-31', zone: 'America/New_York', title: 'Timesheet: Brand refresh', includePrices: true, useLogo: false }]);
    await expect(dialog.getByTestId('pdf-result')).toContainText('Saved to /mock/timesheet-2026-03-01-to-2026-03-31.pdf');
  });

  test('all projects, a custom period, a title of the user, prices off', async ({ page }) => {
    const dialog = await openPdf(page);
    await expect(dialog.getByLabel('Title')).toHaveValue('Timesheet');
    await expect(dialog.getByLabel('Days are cut in')).toHaveValue('America/New_York'); // the Client zone setting of the demo
    await dialog.getByRole('radio', { name: 'Custom' }).click();
    await dialog.getByLabel('From').fill('2026-02-23');
    await dialog.getByLabel('To').fill('2026-03-06');
    await dialog.getByLabel('Title').fill('Hours, February to March – Müller');
    await dialog.getByRole('switch', { name: 'Include prices' }).uncheck();
    await dialog.getByLabel('Days are cut in').selectOption('Europe/Lisbon');
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    expect(await pdfCalls(page)).toEqual([{ projectId: null, from: '2026-02-23', to: '2026-03-06', zone: 'Europe/Lisbon', title: 'Hours, February to March – Müller', includePrices: false, useLogo: false }]);
  });

  test('Hide earnings means no prices unless turned on here, with a visible note', async ({ page }) => {
    const dialog = await openPdf(page, 'seed=p2&hide=1');
    const prices = dialog.getByRole('switch', { name: 'Include prices' });
    await expect(prices).not.toBeChecked();
    await expect(dialog.getByTestId('pdf-prices-note')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    expect((await pdfCalls(page)).map((r) => r.includePrices)).toEqual([false]);
    await prices.check();
    await expect(dialog.getByTestId('pdf-prices-note')).toContainText('Earnings are hidden on screen, but this PDF will contain prices');
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    expect((await pdfCalls(page)).map((r) => r.includePrices)).toEqual([false, true]);
  });

  test('choose and remove the logo; the request asks for it only while one is saved and switched on', async ({ page }) => {
    const dialog = await openPdf(page);
    const logo = dialog.getByRole('switch', { name: 'Print the logo' });
    await expect(logo).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Remove logo' })).toBeDisabled();
    await expect(dialog.getByText('No logo yet.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Choose logo' }).click();
    expect(await calls(page, 'pick_pdf_logo')).toHaveLength(1);
    await expect(logo).toBeEnabled();
    await expect(logo).toBeChecked();
    await expect(dialog.getByText('A logo is saved on this computer.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    await logo.uncheck();
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    await logo.check();
    await dialog.getByRole('button', { name: 'Remove logo' }).click();
    expect(await calls(page, 'clear_pdf_logo')).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: 'Choose logo' })).toBeFocused();
    await expect(logo).toBeDisabled();
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    expect((await pdfCalls(page)).map((r) => r.useLogo)).toEqual([true, false, false]);
  });

  test('says Cancelled when the save dialog is cancelled, and shows a failure inline', async ({ page }) => {
    const dialog = await openPdf(page);
    await page.evaluate(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = internals.invoke;
      internals.invoke = (cmd, args, options) => (cmd === 'export_pdf' ? Promise.resolve(null) : original(cmd, args, options));
    });
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    await expect(dialog.getByTestId('pdf-result')).toHaveText('Cancelled');
    await page.evaluate(() => {
      window.__mock.failNext = ['pick_pdf_logo'];
    });
    await dialog.getByRole('button', { name: 'Choose logo' }).click();
    await expect(dialog.getByRole('alert')).toContainText('pick_pdf_logo failed');
  });

  test('the Excel and CSV exports still work and are unchanged', async ({ page }) => {
    await open(page, 'seed=p2');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog.getByRole('radio', { name: 'Excel (.xlsx)' })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: 'Export Excel' }).click();
    await expect(dialog.getByTestId('export-result')).toContainText('/mock/export.xlsx');
    await dialog.getByRole('radio', { name: 'CSV (.csv)' }).click();
    await dialog.getByRole('button', { name: 'Export CSV' }).click();
    await expect(dialog.getByTestId('export-result')).toContainText('/mock/export.csv');
    expect(await calls(page, 'export_pdf')).toEqual([]);
  });
});

test.describe('screenshots', () => {
  test.use({ viewport: { width: 1360, height: 2250 } });

  for (const [theme, file] of THEMES) {
    test(`billing in ${file}`, async ({ page }) => {
      await openBilling(page, `seed=p2&theme=${theme}`);
      await unbilled(page).getByLabel('Days are cut in').selectOption('Europe/Lisbon');
      await expect(unbilled(page).getByRole('table')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `billing-${file}.png`) });
    });
  }

  test('quote helper', async ({ page }) => {
    await openBilling(page);
    await addPosterJobs(page, [1, 2, 3, 4]);
    const q = quote(page);
    await q.getByLabel('Job name').fill('Poster');
    await q.getByLabel('Project (optional)').selectOption({ label: 'Brand refresh' });
    await expect(q.getByText('Based on 4 comparable tasks.')).toBeVisible();
    await q.screenshot({ path: path.join(SHOTS, 'billing-quote.png') });
  });

  test('PDF export dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 1100 });
    const dialog = await (async () => {
      await open(page, 'seed=p2');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const d = page.getByRole('dialog', { name: 'Export' });
      await d.getByRole('radio', { name: 'PDF timesheet (.pdf)' }).click();
      return d;
    })();
    await dialog.getByLabel('Project', { exact: true }).selectOption({ label: 'Brand refresh' });
    await dialog.getByRole('button', { name: 'Choose logo' }).click();
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    await expect(dialog.getByTestId('pdf-result')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'export-pdf.png') });
  });

  test('settings: billing prefix with a clash warning', async ({ page }) => {
    await open(page, 'seed=p2');
    await tab(page, 'Settings');
    await page.evaluate(() => {
      window.__mock.otherPrefixes = { 'Office PC': 'A' };
    });
    await refresh(page);
    const section = page.getByRole('region', { name: 'Billing references' });
    await expect(section.getByTestId('prefix-clash')).toBeVisible();
    await section.screenshot({ path: path.join(SHOTS, 'settings-billing-prefix.png') });
  });
});
