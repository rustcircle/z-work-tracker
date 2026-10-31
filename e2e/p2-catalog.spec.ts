import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { subtaskItems } from '../src/lib/subtasks';
import type { RichDoc } from '../src/lib/types';
import { SHOTS, expectClean, open, refresh, tab } from './support';

// Phase 2, the catalog: the colour picker (projects and tags), fixed-fee projects, budget alerts,
// tag management and templates. Everything here runs against the IPC mock (`?seed=p2`).

const THEMES = ['light', 'solarizedLight', 'solarizedDark', 'dark'] as const;

const newProjectForm = async (page: Page): Promise<Locator> => {
  await tab(page, 'Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  return page.getByRole('form', { name: 'New project' });
};
const area = (form: Locator): Locator => form.getByRole('slider', { name: 'Saturation and brightness' });
const hueSlider = (form: Locator): Locator => form.getByRole('slider', { name: 'Hue' });
const hexField = (form: Locator): Locator => form.getByRole('textbox', { name: 'Hex' });
const channel = (form: Locator, name: 'Red' | 'Green' | 'Blue'): Locator => form.getByRole('textbox', { name });
const projectRow = (page: Page, name: string): Locator => page.locator('li.project-row', { has: page.getByRole('heading', { name, exact: true }) });
const callsOf = (page: Page, cmd: string): Promise<{ input: Record<string, unknown> }[]> =>
  page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args as { input: Record<string, unknown> }), cmd);
/** Screenshot of the page area from the top of one element to the bottom of another, both scrolled into view. */
async function clipShot(page: Page, from: Locator, to: Locator, file: string): Promise<void> {
  await from.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('nothing to photograph');
  const x = Math.max(0, Math.min(a.x, b.x) - 12);
  const y = Math.max(0, a.y - 12);
  const right = Math.max(a.x + a.width, b.x + b.width) + 12;
  await page.screenshot({ path: path.join(SHOTS, file), clip: { x, y, width: right - x, height: Math.min(b.y + b.height + 12, 900) - y } });
}
const nums = (text: string | null): number[] => (text ?? '').match(/\d+/g)?.map(Number) ?? [];

test.describe('the colour picker', () => {
  test('keyboard: arrows, Shift, Home/End and Page keys on the area and the hue slider', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await hexField(form).fill('#ff0000');
    await expect(area(form)).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
    await area(form).focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(hexField(form)).toHaveValue('#e60000');
    await page.keyboard.press('ArrowLeft');
    await expect(area(form)).toHaveAttribute('aria-valuetext', 'Saturation 99%, brightness 90%');
    await page.keyboard.press('Home');
    await expect(hexField(form)).toHaveValue('#e6e6e6');
    await page.keyboard.press('End');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    await expect(hexField(form)).toHaveValue('#ff0000');

    await hueSlider(form).focus();
    await expect(hueSlider(form)).toHaveAttribute('aria-valuemax', '360');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(hueSlider(form)).toHaveAttribute('aria-valuenow', '15');
    await expect(hueSlider(form)).toHaveAttribute('aria-valuetext', '15 degrees');
    await page.keyboard.press('PageUp');
    await expect(hueSlider(form)).toHaveAttribute('aria-valuenow', '45');
    await expect(hexField(form)).toHaveValue('#ffbf00');
    await page.keyboard.press('Home');
    await expect(hexField(form)).toHaveValue('#ff0000');
    await page.keyboard.press('End');
    await expect(hueSlider(form)).toHaveAttribute('aria-valuenow', '360');
    // The area and the hue are in the tab order, in that order, and take no part in the form's Enter.
    await area(form).focus();
    await page.keyboard.press('Tab');
    await expect(hueSlider(form)).toBeFocused();
    await expectClean(page, found);
  });

  test('pointer: a click and a drag on the area and the hue slider', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await hexField(form).fill('#ff0000');
    const box = await area(form).boundingBox();
    if (!box) throw new Error('no area');
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => nums(await area(form).getAttribute('aria-valuetext'))).toEqual(expect.arrayContaining([expect.any(Number)]));
    const [s, v] = nums(await area(form).getAttribute('aria-valuetext'));
    expect(s).toBeGreaterThanOrEqual(73);
    expect(s).toBeLessThanOrEqual(77);
    expect(v).toBeGreaterThanOrEqual(48);
    expect(v).toBeLessThanOrEqual(52);
    // A drag that leaves the area still follows the pointer and stops at the edge.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 80, box.y - 60, { steps: 4 });
    await page.mouse.up();
    await expect(area(form)).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');

    const hue = await hueSlider(form).boundingBox();
    if (!hue) throw new Error('no hue');
    await page.mouse.click(hue.x + hue.width / 3, hue.y + hue.height / 2);
    const h = Number(await hueSlider(form).getAttribute('aria-valuenow'));
    expect(h).toBeGreaterThanOrEqual(116);
    expect(h).toBeLessThanOrEqual(124);
    await expect(hexField(form)).not.toHaveValue('#ff0000');
    await expectClean(page, found);
  });

  test('hex, RGB and the area stay in step; invalid input is explained and changes nothing', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await hexField(form).fill('#1A2B3C');
    await expect(channel(form, 'Red')).toHaveValue('26');
    await expect(channel(form, 'Green')).toHaveValue('43');
    await expect(channel(form, 'Blue')).toHaveValue('60');
    await channel(form, 'Red').fill('255');
    await expect(hexField(form)).toHaveValue('#ff2b3c');
    // Shorthand waits until the field is left.
    await hexField(form).fill('abc');
    await expect(hexField(form)).toHaveValue('abc');
    await hexField(form).blur();
    await expect(hexField(form)).toHaveValue('#aabbcc');
    await expect(channel(form, 'Blue')).toHaveValue('204');

    await hexField(form).fill('not a colour');
    await expect(form.getByRole('alert').filter({ hasText: 'Enter a colour like #1a2b3c.' })).toBeVisible();
    await expect(hexField(form)).toHaveAttribute('aria-invalid', 'true');
    await expect(channel(form, 'Red')).toHaveValue('170');
    await hexField(form).blur();
    await expect(hexField(form)).toHaveValue('#aabbcc');
    await channel(form, 'Green').fill('300');
    await expect(form.getByRole('alert').filter({ hasText: 'Use a whole number from 0 to 255.' })).toBeVisible();
    await expect(hexField(form)).toHaveValue('#aabbcc');
    await channel(form, 'Green').blur();
    await expect(channel(form, 'Green')).toHaveValue('187');
    await expectClean(page, found);
  });

  test('a picked project colour reaches the project row, the timeline, the Analysis legend and the stored data as #rrggbb', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Projects');
    await page.getByRole('button', { name: /^Edit Brand refresh/ }).click();
    const form = page.getByRole('form', { name: 'Edit project Brand refresh' });
    await hexField(form).fill('#12AB34');
    await expect(form.locator('.cp-preview')).toHaveCSS('background-color', 'rgb(18, 171, 52)');
    await form.getByRole('button', { name: 'Save project' }).click();
    await expect(form).toBeHidden();

    const sent = await callsOf(page, 'update_project');
    expect(sent.at(-1)?.input).toMatchObject({ color: '#12ab34', billingType: 'hourly' });
    expect(await page.evaluate(() => window.__mock.projects.find((p) => p.id === 'p-brand')?.color)).toBe('#12ab34');
    await expect(projectRow(page, 'Brand refresh').locator('.swatch')).toHaveCSS('background-color', 'rgb(18, 171, 52)');

    await tab(page, 'Timeline');
    const block = page.locator('[data-testid="block"][data-project="p-brand"]').first();
    await expect(block).toBeVisible();
    await expect(block).toHaveCSS('background-color', 'rgb(18, 171, 52)');
    // The chip text colour is computed: white on this green fails 4.5, black passes.
    await expect(block).toHaveCSS('color', 'rgb(0, 0, 0)');

    await tab(page, 'Analysis');
    await expect(page.getByRole('heading', { name: 'Analysis', level: 1 })).toBeVisible();
    await expect(page.locator('rect.a-swatch-box[fill="#12ab34"]').first()).toBeVisible();
    await expectClean(page, found);
  });

  test('a picked tag colour reaches the tag chip and the stored data', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Settings');
    const tags = page.getByRole('region', { name: 'Tags' });
    await tags.getByRole('button', { name: 'Edit tag Revision' }).click();
    const form = tags.getByRole('form', { name: 'Edit tag Revision' });
    await hexField(form).fill('#c0ffee');
    await form.getByRole('button', { name: 'Save tag' }).click();
    await expect(form).toBeHidden();
    expect(await page.evaluate(() => window.__mock.tags.find((t) => t.id === 'tag-revision')?.color)).toBe('#c0ffee');
    const chip = tags.getByRole('listitem').filter({ hasText: 'Revision' }).locator('.chip');
    await expect(chip).toHaveCSS('background-color', 'rgb(192, 255, 238)');
    await expect(chip).toHaveCSS('color', 'rgb(0, 0, 0)');
    // A refresh from the backend (a new snapshot) keeps it.
    await refresh(page);
    await expect(tags.getByRole('listitem').filter({ hasText: 'Revision' }).locator('.chip')).toHaveCSS('background-color', 'rgb(192, 255, 238)');
    await expectClean(page, found);
  });

  test('recently used colours: offered next time, and nothing breaks when storage throws', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    let form = await newProjectForm(page);
    await expect(form.getByRole('group', { name: 'Recently used colours' })).toHaveCount(0);
    await form.getByRole('textbox', { name: 'Project name' }).fill('Retail');
    await hexField(form).fill('#445566');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: 'Retail', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New project' }).click();
    form = page.getByRole('form', { name: 'New project' });
    await form.getByRole('button', { name: 'Recent colour #445566' }).click();
    await expect(hexField(form)).toHaveValue('#445566');
    await expectClean(page, found);

    // A second page where localStorage is blocked entirely.
    const blocked = await page.context().newPage();
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    const foundBlocked = await open(blocked, 'seed=p2');
    expect(await blocked.evaluate(() => { try { return typeof window.localStorage; } catch { return 'blocked'; } })).toBe('blocked');
    const blockedForm = await newProjectForm(blocked);
    await blockedForm.getByRole('textbox', { name: 'Project name' }).fill('Retail 2');
    await blockedForm.getByRole('radio', { name: 'Colour #db2777' }).click();
    await hexField(blockedForm).fill('#778899');
    await blockedForm.getByRole('button', { name: 'Create project' }).click();
    await expect(blocked.getByRole('heading', { name: 'Retail 2', exact: true })).toBeVisible();
    expect(await blocked.evaluate(() => window.__mock.projects.find((p) => p.name === 'Retail 2')?.color)).toBe('#778899');
    await expectClean(blocked, foundBlocked);
    await blocked.close();
  });

  test('warnings about a similar colour or low contrast are gentle and never block saving', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await form.getByRole('textbox', { name: 'Project name' }).fill('Lookalike');
    await hexField(form).fill('#2564eb');
    await expect(form.getByTestId('cp-warn-similar')).toContainText('Close to Brand refresh (#2563eb)');
    await hexField(form).fill('#fff9c4');
    await expect(form.getByTestId('cp-warn-contrast')).toContainText('Low contrast against the Light theme background');
    await expect(form.getByTestId('cp-warn-similar')).toHaveCount(0);
    await hexField(form).fill('#2564eb');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: 'Lookalike', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.projects.find((p) => p.name === 'Lookalike')?.color)).toBe('#2564eb');

    // The contrast warning follows the theme: near-black is fine on light and not on dark.
    await page.getByRole('button', { name: 'New project' }).click();
    const again = page.getByRole('form', { name: 'New project' });
    await hexField(again).fill('#1b1c20');
    await expect(again.getByTestId('cp-warn-contrast')).toHaveCount(0);
    await expectClean(page, found);

    const dark = await open(page, 'seed=p2&theme=dark');
    const darkForm = await newProjectForm(page);
    await hexField(darkForm).fill('#1b1c20');
    await expect(darkForm.getByTestId('cp-warn-contrast')).toContainText('Low contrast against the Dark theme background');
    await darkForm.getByRole('textbox', { name: 'Project name' }).fill('Hard to see');
    await darkForm.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: 'Hard to see', exact: true })).toBeVisible();
    await expectClean(page, dark);
  });

  test('a backend refusal is shown as text next to the form and the form stays open', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await form.getByRole('textbox', { name: 'Project name' }).fill('Doomed');
    await page.evaluate(() => {
      window.__mock.failNext = ['create_project'];
    });
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(form.getByTestId('project-error')).toHaveText('mock: create_project failed');
    await expect(form.getByRole('textbox', { name: 'Project name' })).toHaveValue('Doomed');
    // The retry goes through.
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(form).toBeHidden();
    expect(await page.evaluate(() => window.__mock.projects.some((p) => p.name === 'Doomed'))).toBe(true);
    expect(found.errors.filter((e) => !/Failed to load resource|mock: create_project failed/.test(e))).toEqual([]);
  });

  test('the picker looks right in all four themes', async ({ page }, info) => {
    for (const theme of THEMES) {
      const found = await open(page, `seed=p2&theme=${theme}`);
      const form = await newProjectForm(page);
      await hexField(form).fill('#d946ef');
      await form.screenshot({ path: path.join(info.outputDir, `color-picker-${theme}.png`) });
      await expect(form.getByRole('slider', { name: 'Hue' })).toBeVisible();
      await expectClean(page, found);
    }
  });
});

test.describe('fixed-fee projects', () => {
  test('the form offers Hourly or Fixed fee and checks the fee like the backend', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await form.getByRole('textbox', { name: 'Project name' }).fill('Brochure');
    await expect(form.getByRole('radio', { name: 'Hourly' })).toBeChecked();
    await form.getByRole('radio', { name: 'Fixed fee' }).click();
    await expect(form.getByTestId('fixed-fee-yardstick')).toContainText('only as a yardstick');
    await expect(form.getByTestId('needs-target-rate')).toContainText('A fixed fee needs a price per hour to measure your time against it');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(form.getByText('Enter the fixed fee, like 1000 or 1000.50.')).toBeVisible();
    await form.getByRole('textbox', { name: 'Fee' }).fill('10000000001');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(form.getByText('The fee can be at most 10,000,000,000.00.')).toBeVisible();
    await form.getByRole('textbox', { name: 'Fee' }).fill('12.345');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(form.getByRole('textbox', { name: 'Fee' })).toHaveAttribute('aria-invalid', 'true');
    expect(await callsOf(page, 'create_project')).toEqual([]);

    await form.getByRole('textbox', { name: 'Fee' }).fill('2500.50');
    await form.getByRole('combobox', { name: 'Fee currency' }).selectOption('USD');
    await form.getByRole('textbox', { name: 'Price' }).fill('45');
    await clipShot(page, form.getByText('Billing type', { exact: true }).first(), form.locator('fieldset', { hasText: 'Price per hour, to measure the fee against' }), 'project-form-fixed-fee.png');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(projectRow(page, 'Brochure').getByText('Fixed fee $2,500.50')).toBeVisible();
    const sent = await callsOf(page, 'create_project');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ name: 'Brochure', color: expect.stringMatching(/^#[0-9a-f]{6}$/), billable: true, budgetHours: null, clientZone: null, billingType: 'fixedFee', fixedFeeCents: 250_050, feeCurrency: 'USD' });
    const rate = await callsOf(page, 'set_rate');
    expect(rate.at(-1)?.input).toMatchObject({ rateCents: 4500, currency: 'USD' });
    await expect(projectRow(page, 'Brochure').getByText(/No rate set/)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('an hourly project sends billingType hourly and no fee', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const form = await newProjectForm(page);
    await form.getByRole('textbox', { name: 'Project name' }).fill('Hourly one');
    await form.getByRole('textbox', { name: 'Price' }).fill('70');
    await form.getByRole('button', { name: 'Create project' }).click();
    await expect(projectRow(page, 'Hourly one').getByText('€70.00/h')).toBeVisible();
    const input = (await callsOf(page, 'create_project'))[0]?.input ?? {};
    expect(input.billingType).toBe('hourly');
    expect(Object.keys(input).sort()).toEqual(['billable', 'billingType', 'budgetHours', 'clientZone', 'color', 'name']);
    await expectClean(page, found);
  });

  test('the Projects tab shows the fee, the effective hourly rate and the budget; Hide earnings masks them', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Projects');
    const row = projectRow(page, 'Print run (fixed fee)');
    await expect(row.getByText('Fixed fee €1,000.00')).toBeVisible();
    await expect(row.getByText(/Effective hourly rate €\d+\.\d\d\/h/)).toBeVisible();
    await expect(row.getByText('Measured at €50.00/h')).toBeVisible();
    await expect(row.getByText(/No rate set/)).toHaveCount(0);
    await expectClean(page, found);

    const hidden = await open(page, 'seed=p2&hide=1');
    await tab(page, 'Projects');
    const masked = projectRow(page, 'Print run (fixed fee)');
    await expect(masked.getByText('Fixed fee ••••')).toBeVisible();
    await expect(masked.getByText(/Effective hourly rate ••••\/h/)).toBeVisible();
    await expect(masked.getByTestId('budget')).toContainText('•••• of the fixed fee');
    await expect(masked.getByTestId('budget')).toContainText('80% warning');
    await expect(masked).not.toContainText('€');
    await expect(masked).not.toContainText('86%');
    await expectClean(page, hidden);
  });
});

test.describe('budget alerts on the project', () => {
  test('86% of the fee reads "80% warning" with a labelled bar', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Projects');
    const row = projectRow(page, 'Print run (fixed fee)');
    const budget = row.getByTestId('budget');
    await expect(budget).toContainText('Budget used');
    await expect(budget).toContainText('86% of the fixed fee');
    await expect(budget).toContainText('80% warning');
    await expect(row.getByRole('meter', { name: 'Budget used, Print run (fixed fee)' })).toHaveAttribute('aria-valuetext', '86% of the fixed fee, 80% warning');
    await row.scrollIntoViewIfNeeded();
    await row.screenshot({ path: path.join(SHOTS, 'project-budget-alert.png') });
    await expectClean(page, found);
  });

  test('levels 0, 80 and 100 and the missing price per hour', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Projects');
    const row = projectRow(page, 'Print run (fixed fee)');
    const setFee = async (cents: number): Promise<void> => {
      await page.evaluate((c) => {
        const p = window.__mock.projects.find((x) => x.id === 'p-print');
        if (p) p.fixedFeeCents = c;
      }, cents);
      await refresh(page);
    };

    await setFee(50_000); // 862.50 of 500.00 is 172%
    await expect(row.getByTestId('budget')).toHaveAttribute('data-level', '100');
    await expect(row.getByTestId('budget')).toContainText('172% of the fixed fee');
    await expect(row.getByTestId('budget')).toContainText('100% over');
    await expect(row.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');

    await setFee(10_000_000); // under 1%
    await expect(row.getByTestId('budget')).toHaveAttribute('data-level', '0');
    await expect(row.getByTestId('budget')).toContainText('0% of the fixed fee');
    await expect(row.getByTestId('budget')).not.toContainText('warning');
    await expect(row.getByTestId('budget')).not.toContainText('over');

    await setFee(100_000);
    await expect(row.getByTestId('budget')).toHaveAttribute('data-level', '80');

    await page.evaluate(() => {
      window.__mock.rates = window.__mock.rates.filter((r) => r.projectId !== 'p-print');
    });
    await refresh(page);
    await expect(row.getByTestId('budget-need')).toContainText('A fixed fee needs a price per hour to measure your time against it');
    await expect(row.getByRole('meter')).toHaveCount(0);
    await row.getByRole('button', { name: /Set a price per hour/ }).click();
    const form = page.getByRole('form', { name: 'Edit project Print run (fixed fee)' });
    await expect(form.getByTestId('needs-target-rate')).toBeVisible();
    await form.getByRole('textbox', { name: 'Price' }).fill('50');
    // A price that starts today values no earlier time; one that applies from the start of the year does.
    await form.getByRole('radio', { name: 'Applies from a date' }).check();
    await form.getByLabel('From date').fill('2026-01-01');
    await form.getByRole('button', { name: 'Save project' }).click();
    await page.getByRole('dialog', { name: 'Change past figures?' }).getByRole('button', { name: 'Apply to past dates' }).click();
    await expect(row.getByTestId('budget')).toContainText('86% of the fixed fee');
    await expectClean(page, found);
  });

  test('an hours budget crosses 80 and 100 and says "of N h"; hours are not masked by Hide earnings', async ({ page }) => {
    const found = await open(page, 'seed=p2&hide=1');
    await tab(page, 'Projects');
    const row = projectRow(page, 'Website');
    const read = async (): Promise<number> => nums(await row.getByTestId('budget').textContent()).find((n) => n !== 40) ?? -1;
    await expect(row.getByTestId('budget')).toContainText('% of 40 h');
    const percent40 = await read();
    expect(percent40).toBeGreaterThan(0);
    const setBudget = async (hours: number): Promise<void> => {
      await page.evaluate((h) => {
        const p = window.__mock.projects.find((x) => x.id === 'p-web');
        if (p) p.budgetHours = h;
      }, hours);
      await refresh(page);
    };
    // Billable hours are about percent40 * 0.4 h; a budget of 0.9 times that is at least 100%, 0.85 times is about 117%.
    const hours = (percent40 / 100) * 40;
    await setBudget(Math.floor(hours * 0.9));
    await expect(row.getByTestId('budget')).toHaveAttribute('data-level', '100');
    await expect(row.getByTestId('budget')).toContainText('100% over');
    await setBudget(Math.ceil(hours / 0.9));
    await expect(row.getByTestId('budget')).toHaveAttribute('data-level', '80');
    await expect(row.getByTestId('budget')).toContainText('80% warning');
    await setBudget(Math.ceil(hours * 4));
    await expect(row.getByTestId('budget')).toHaveAttribute('data-level', '0');
    await expectClean(page, found);
  });
});

test.describe('Settings: tags', () => {
  test('list, add, rename, recolour, delete with a confirmation that explains the effect', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Settings');
    const tags = page.getByRole('region', { name: 'Tags' });
    await expect(tags.getByRole('listitem')).toHaveCount(4);
    await tags.scrollIntoViewIfNeeded();

    // Add.
    await tags.getByRole('button', { name: 'Add tag' }).click();
    const add = tags.getByRole('form', { name: 'New tag' });
    await add.getByRole('textbox', { name: 'Tag name' }).fill('Print');
    await hexField(add).fill('#00AAFF');
    await add.getByRole('button', { name: 'Add tag' }).click();
    await expect(tags.getByRole('listitem')).toHaveCount(5);
    await expect(tags.getByRole('button', { name: 'Add tag' })).toBeFocused();
    expect(await page.evaluate(() => window.__mock.tags.find((t) => t.name === 'Print')?.color)).toBe('#00aaff');
    expect((await callsOf(page, 'save_tag')).at(-1)).toMatchObject({ input: { id: null, name: 'Print', color: '#00aaff' } });

    // Rename and recolour.
    await tags.getByRole('button', { name: 'Edit tag Print' }).click();
    const edit = tags.getByRole('form', { name: 'Edit tag Print' });
    await edit.getByRole('textbox', { name: 'Tag name' }).fill('Prepress');
    await edit.getByRole('radio', { name: 'Colour #059669' }).click();
    await edit.getByRole('button', { name: 'Save tag' }).click();
    await expect(tags.getByRole('listitem').filter({ hasText: 'Prepress' })).toContainText('#059669');
    expect(await page.evaluate(() => window.__mock.tags.filter((t) => t.name === 'Print').length)).toBe(0);

    // Duplicate names are refused, before and after the page knows about them.
    await tags.getByRole('button', { name: 'Add tag' }).click();
    const dup = tags.getByRole('form', { name: 'New tag' });
    await dup.getByRole('textbox', { name: 'Tag name' }).fill('admin');
    await dup.getByRole('button', { name: 'Add tag' }).click();
    await expect(dup.getByText(/A tag named “admin” already exists/)).toBeVisible();
    await dup.getByRole('textbox', { name: 'Tag name' }).fill('Fresh');
    await page.evaluate(() => {
      window.__mock.tags.push({ id: 'tag-sneaky', name: 'Fresh', color: '#101010', deleted: false, stamp: { at: '', by: '' } });
    });
    await dup.getByRole('button', { name: 'Add tag' }).click();
    await expect(dup.getByRole('alert').filter({ hasText: 'a tag named "Fresh" already exists' })).toBeVisible();
    await dup.getByRole('button', { name: 'Cancel' }).click();
    await tags.screenshot({ path: path.join(SHOTS, 'settings-tags.png') });

    // Delete, after a confirmation.
    await tags.getByRole('button', { name: 'Delete tag Concept' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this tag?' });
    await expect(dialog).toContainText('Tasks keep no tag of that name afterwards');
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(tags.getByText('Concept', { exact: true })).toBeVisible();
    await tags.getByRole('button', { name: 'Delete tag Concept' }).click();
    await page.getByRole('dialog', { name: 'Delete this tag?' }).getByRole('button', { name: 'Delete tag' }).click();
    await expect(tags.getByText('Concept', { exact: true })).toHaveCount(0);
    expect((await callsOf(page, 'delete_tag')).length).toBe(1);
    expect(await page.evaluate(() => window.__mock.tags.find((t) => t.id === 'tag-concept')?.deleted)).toBe(true);
    await expectClean(page, found);
  });
});

test.describe('Settings: templates', () => {
  test('list, create from scratch with a task list, edit, delete', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await tab(page, 'Settings');
    const templates = page.getByRole('region', { name: 'Templates' });
    await templates.scrollIntoViewIfNeeded();
    await expect(templates.getByRole('heading', { name: 'Logo job' })).toBeVisible();
    await expect(templates.getByText(/3 task-list items: Moodboard, Sketches, Final artwork/)).toBeVisible();

    await templates.getByRole('button', { name: 'New template' }).click();
    const form = templates.getByRole('form', { name: 'New template' });
    await form.getByRole('button', { name: 'Create template' }).click();
    await expect(form.getByText('Enter a template name.')).toBeVisible();
    await form.getByRole('textbox', { name: 'Template name' }).fill('Packaging job');
    await form.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'Packaging' });
    await form.getByRole('checkbox', { name: 'Revision' }).check();
    await form.getByRole('button', { name: 'Task list' }).click();
    // The toolbar button hands the caret to the new first item (a moment later), so typing goes straight into it.
    await expect(form.getByRole('textbox', { name: 'Template text' })).toBeFocused();
    await page.keyboard.type('Dieline');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Proof');
    await form.getByRole('button', { name: 'Create template' }).click();
    await expect(templates.getByRole('heading', { name: 'Packaging job' })).toBeVisible();
    await expect(templates.getByRole('button', { name: 'New template' })).toBeFocused();
    const saved = await page.evaluate(() => JSON.stringify(window.__mock.templates.find((t) => t.name === 'Packaging job')));
    expect(saved).toContain('"projectId":"p-pack"');
    expect(saved).toContain('"tags":["tag-revision"]');
    const doc = (JSON.parse(saved) as { description: RichDoc }).description;
    expect(subtaskItems(doc).map((i) => [i.text, i.checked])).toEqual([['Dieline', false], ['Proof', false]]);

    await templates.getByRole('button', { name: 'Edit template Packaging job' }).click();
    const edit = templates.getByRole('form', { name: 'Edit template Packaging job' });
    await expect(edit.getByRole('textbox', { name: 'Template text' })).toContainText('Dieline');
    await edit.getByRole('textbox', { name: 'Template name' }).fill('Packaging job v2');
    await templates.screenshot({ path: path.join(SHOTS, 'settings-templates.png') });
    await edit.getByRole('button', { name: 'Save template' }).click();
    await expect(templates.getByRole('heading', { name: 'Packaging job v2' })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.templates.filter((t) => !t.deleted).length)).toBe(2);

    await templates.getByRole('button', { name: 'Delete template Packaging job v2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this template?' });
    await expect(dialog).toContainText('Tasks already made from it are not changed');
    await dialog.getByRole('button', { name: 'Delete template' }).click();
    await expect(templates.getByRole('heading', { name: 'Packaging job v2' })).toHaveCount(0);
    expect((await callsOf(page, 'delete_template')).length).toBe(1);
    await expectClean(page, found);
  });
});

test('screenshot: the colour picker in the project form', async ({ page }) => {
  const found = await open(page, 'seed=p2');
  await tab(page, 'Projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByRole('textbox', { name: 'Project name' }).fill('Annual report');
  await hexField(form).fill('#e11d9c');
  await form.getByRole('textbox', { name: 'Project name' }).focus();
  await clipShot(page, form.getByText('Project name', { exact: true }).first(), form.getByText('Billable project'), 'color-picker.png');
  await expectClean(page, found);
});
