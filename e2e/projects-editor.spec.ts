import { expect, test, type Locator, type Page } from '@playwright/test';

import { expectClean, open, refresh, tab } from './support';

// The project editor in a real browser: the ticker's "Set a rate" while Projects is open, unsaved changes, removing a price version,
// Hide earnings, and a project made while its price is refused. Everything runs against the IPC mock.

const ASK = 'Leave without saving?';
const editor = (page: Page, name: string): Locator => page.getByRole('form', { name: `Edit project ${name}` });
const callsOf = (page: Page, cmd: string): Promise<Record<string, unknown>[]> =>
  page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args as Record<string, unknown>), cmd);

test.describe('the project editor', () => {
  test('"Set a rate" in the ticker opens the editor while Projects is shown, and asks before it replaces a changed one', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => {
      window.__mock.rates = window.__mock.rates.filter((r) => r.projectId !== 'p-brand');
    });
    await refresh(page);
    await tab(page, 'Projects');
    const setRate = page.locator('.ticker').getByRole('button', { name: 'Set a rate' });
    await setRate.click();
    await expect(editor(page, 'Brand refresh')).toBeVisible();

    await page.getByRole('button', { name: 'Edit Website' }).click();
    await expect(editor(page, 'Website')).toBeVisible();
    await expect(editor(page, 'Brand refresh')).toHaveCount(0);
    await editor(page, 'Website').getByRole('textbox', { name: 'Project name' }).fill('Website 2');
    await setRate.click();
    const ask = page.getByRole('dialog', { name: ASK });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    await expect(editor(page, 'Website')).toBeVisible();
    await expect(editor(page, 'Website').getByRole('textbox', { name: 'Project name' })).toHaveValue('Website 2');
    await setRate.click();
    await page.getByRole('dialog', { name: ASK }).getByRole('button', { name: 'Leave and discard' }).click();
    await expect(editor(page, 'Brand refresh')).toBeVisible();
    await expect(editor(page, 'Website')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('a changed editor asks before another tab replaces it; an unchanged one does not', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'Edit Website' }).click();
    await tab(page, 'Timeline');
    await expect(page.getByRole('dialog', { name: ASK })).toHaveCount(0);
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'Edit Website' }).click();
    await editor(page, 'Website').getByRole('textbox', { name: 'Budget hours' }).fill('41');
    await tab(page, 'Billing');
    await expect(page.getByRole('dialog', { name: ASK })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: ASK })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
    await expect(editor(page, 'Website').getByRole('textbox', { name: 'Budget hours' })).toHaveValue('41');
    await expectClean(page, found);
  });

  test('closing a changed editor, closing a changed New project form, and archiving the project of a changed editor all ask first', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await tab(page, 'Projects');
    const ask = page.getByRole('dialog', { name: ASK });
    const name = (form: Locator): Locator => form.getByRole('textbox', { name: 'Project name' });
    await page.getByRole('button', { name: 'Edit Website' }).click();
    await name(editor(page, 'Website')).fill('Website 2');

    await page.getByRole('button', { name: 'Edit Website' }).click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    await expect(name(editor(page, 'Website'))).toHaveValue('Website 2');

    await page.getByRole('button', { name: 'Archive Website' }).click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    expect(await callsOf(page, 'set_project_archived')).toEqual([]);
    await expect(name(editor(page, 'Website'))).toHaveValue('Website 2');

    await page.getByRole('button', { name: 'New project' }).click();
    const create = page.getByRole('form', { name: 'New project' });
    await name(create).fill('Retail');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    await expect(name(create)).toHaveValue('Retail');

    // Leave and discard on the editor: it is gone, and it opens again as it was saved.
    await page.getByRole('button', { name: 'Edit Website' }).click();
    await ask.getByRole('button', { name: 'Leave and discard' }).click();
    await expect(editor(page, 'Website')).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit Website' }).click();
    await expect(name(editor(page, 'Website'))).toHaveValue('Website');
    await expectClean(page, found);
  });

  test('a project that is not billable still lists its prices, so one the sync warning names can be removed', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => {
      const web = window.__mock.projects.find((p) => p.id === 'p-web');
      if (web) web.billable = false;
      window.__mock.rates.push({ id: 'r-far', projectId: 'p-web', effectiveFrom: '2099-01-01T00:00:00Z', rateCents: 6500, currency: 'EUR', deleted: false, stamp: { at: '2026-01-01T00:00:00Z', by: 'e2e' } });
    });
    await refresh(page);
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'Edit Website' }).click();
    const form = editor(page, 'Website');
    await expect(form.getByRole('heading', { name: 'Rate history' })).toBeVisible();
    await form.getByRole('button', { name: 'Remove the price from 2099-01-01' }).click();
    await page.getByRole('dialog', { name: 'Remove this price?' }).getByRole('button', { name: 'Remove price' }).click();
    await expect(form.getByRole('button', { name: 'Remove the price from 2099-01-01' })).toHaveCount(0);
    expect(await callsOf(page, 'delete_rate_version')).toEqual([{ id: 'r-far', confirmRetroactive: true }]);
    await expectClean(page, found);
  });

  test('removing a price: the question says what changes, and the price before applies again', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'Edit Brand refresh' }).click();
    const form = editor(page, 'Brand refresh');
    await expect(form.getByRole('textbox', { name: 'Price' })).toHaveValue('90');
    await form.getByRole('button', { name: 'Remove the price from 2026-03-09' }).click();
    const ask = page.getByRole('dialog', { name: 'Remove this price?' });
    await expect(ask).toContainText('Past earnings change, except what is on billing summaries');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    expect(await callsOf(page, 'delete_rate_version')).toEqual([]);
    // The older version ends where this one starts, and the question says so.
    await form.getByRole('button', { name: 'Remove the price from 2026-01-01' }).click();
    await expect(page.getByRole('dialog', { name: 'Remove this price?' })).toContainText('until Mon 9 Mar 2026');
    await page.getByRole('dialog', { name: 'Remove this price?' }).getByRole('button', { name: 'Cancel' }).click();

    await form.getByRole('button', { name: 'Remove the price from 2026-03-09' }).click();
    await page.getByRole('dialog', { name: 'Remove this price?' }).getByRole('button', { name: 'Remove price' }).click();
    await expect(form.getByRole('button', { name: 'Remove the price from 2026-03-09' })).toHaveCount(0);
    await expect(form.getByRole('textbox', { name: 'Price' })).toHaveValue('80');
    expect(await callsOf(page, 'delete_rate_version')).toEqual([{ id: 'r2', confirmRetroactive: true }]);
    // The focus stays in the form, at the history, so a keyboard user does not lose their place.
    await expect(form.getByRole('heading', { name: 'Rate history' })).toBeFocused();
    await expectClean(page, found);
  });

  test('Hide earnings masks the saved fee and price until Change is pressed', async ({ page }) => {
    const found = await open(page, 'seed=p2&hide=1');
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'Edit Print run (fixed fee)' }).click();
    const form = editor(page, 'Print run (fixed fee)');
    await expect(form.getByRole('textbox', { name: 'Fee' })).toHaveValue('••••');
    await expect(form.getByRole('textbox', { name: 'Price' })).toHaveValue('••••');
    await expect(form.getByText('Rate hidden').first()).toBeVisible();
    await form.getByRole('button', { name: 'Change the fee' }).click();
    await expect(form.getByRole('textbox', { name: 'Fee' })).toHaveValue('1000');
    await expect(form.getByRole('textbox', { name: 'Fee' })).toBeFocused();
    await expect(form.getByRole('textbox', { name: 'Price' })).toHaveValue('••••');
    await form.getByRole('textbox', { name: 'Fee' }).fill('1200');
    await form.getByRole('button', { name: 'Save project' }).click();
    await expect(form).toHaveCount(0);
    const update = (await callsOf(page, 'update_project')).at(-1) as { input: Record<string, unknown> };
    expect(update.input).toMatchObject({ fixedFeeCents: 120_000, feeCurrency: 'EUR', billingType: 'fixedFee' });
    expect(await callsOf(page, 'set_rate')).toEqual([]);
    await expectClean(page, found);
  });

  test('a project made while its price is refused goes on as that project, and the price can be put right', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const form = page.getByRole('form', { name: 'New project' });
    await form.getByRole('textbox', { name: 'Project name' }).fill('Retail');
    await form.getByRole('textbox', { name: 'Price' }).fill('70');
    await form.getByRole('radio', { name: 'Applies from a date' }).check();
    const date = form.getByLabel('From date');
    await expect(date).toHaveAttribute('min', '2000-01-01');
    await expect(date).toHaveAttribute('max', '2100-01-01');
    await date.fill('2150-06-01');
    await form.getByRole('button', { name: 'Create project' }).click();

    const again = editor(page, 'Retail');
    await expect(again.getByTestId('project-error')).toHaveText("The project was saved, but the price was not: the price's start date must be between 2000-01-01 and 2100-01-01.");
    await expect(again.getByRole('button', { name: 'Save project' })).toBeVisible();
    await expect(again.getByText(/already exists/)).toHaveCount(0);

    await again.getByLabel('From date').fill('2026-04-01');
    await again.getByRole('button', { name: 'Save project' }).click();
    await expect(again).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.projects.filter((p) => p.name === 'Retail').length)).toBe(1);
    expect(await callsOf(page, 'create_project')).toHaveLength(1);
    const retail = await page.evaluate(() => {
      const id = window.__mock.projects.find((p) => p.name === 'Retail')?.id;
      return window.__mock.rates.filter((r) => r.projectId === id && !r.deleted).map((r) => r.rateCents);
    });
    expect(retail).toEqual([7000]);
    await expectClean(page, found);
  });
});
