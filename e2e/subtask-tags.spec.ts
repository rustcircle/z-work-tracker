import { expect, test, type Locator, type Page } from '@playwright/test';

import { card, expectClean, open } from './support';

// Subtask tags (1.4): the tags button on each item of a task card, the checklist it opens, and where the choice shows in Analysis.
// `?seed=many-tasks` has Brand guidelines with the tags Concept and Revision and two items with time in the default week
// (9-15 Mar 2026): Outline 290 min and Review 75 min. Against the mock backend, which follows the core's rules (the shared table
// fixtures/subtask-tags-parity.json is run on both sides); the real backend is covered by its own tests.
const SEED = 'seed=many-tasks';

const guide = (page: Page): Locator => card(page, 'Brand guidelines');
/** The button on an item's row, found by what it says: "Tags for Review: Same as task". */
const tagsButton = (page: Page, item: string, now: string): Locator => guide(page).getByRole('button', { name: `Tags for ${item}: ${now}`, exact: true });
const checklist = (page: Page, item: string): Locator => guide(page).getByRole('dialog', { name: `Tags for ${item}`, exact: true });
/** What the store holds for one item: its list, `null` for a reset, or `none` when no entry exists. */
const stored = (page: Page, item: string): Promise<string[] | null | 'none'> =>
  page.evaluate((id) => {
    const entry = window.__mock.tasks.find((t) => t.id === 't-guide')?.subtaskTags?.[id];
    return entry === undefined ? 'none' : entry.tags;
  }, item);
const sets = (page: Page): Promise<Record<string, unknown>[]> => page.evaluate(() => window.__mock.calls.filter((x) => x.cmd === 'set_subtask_tags').map((x) => x.args as Record<string, unknown>));

test.describe('choosing the tags of a subtask on its row', () => {
  test('with the mouse: a subset is saved at once and shown as chips, and its sibling keeps following the task', async ({ page }) => {
    const found = await open(page, SEED);
    // Every item starts on "Same as task".
    for (const item of ['Outline', 'Review']) await expect(tagsButton(page, item, 'Same as task')).toBeVisible();
    await tagsButton(page, 'Review', 'Same as task').click();
    await expect(tagsButton(page, 'Review', 'Same as task')).toHaveAttribute('aria-expanded', 'true');
    const list = checklist(page, 'Review');
    await expect(list.getByRole('button', { name: 'Same as task' })).toHaveAttribute('aria-pressed', 'true');
    for (const tag of ['Concept', 'Revision']) await expect(list.getByRole('checkbox', { name: tag })).toBeChecked();
    await expect(list.getByRole('checkbox', { name: 'Admin' })).toHaveCount(0);
    await list.getByRole('checkbox', { name: 'Concept' }).uncheck();
    await expect(tagsButton(page, 'Review', 'Revision')).toBeVisible();
    await expect(tagsButton(page, 'Review', 'Revision')).toContainText('Revision');
    await expect(list.getByRole('checkbox', { name: 'Concept' })).not.toBeChecked();
    await expect(list.getByRole('button', { name: 'Same as task' })).toHaveAttribute('aria-pressed', 'false');
    expect(await stored(page, 'st-review')).toEqual(['tag-revision']);
    expect(await sets(page)).toEqual([{ taskId: 't-guide', subtaskId: 'st-review', tags: ['tag-revision'], expected: { tags: null } }]);
    // Outline was not touched, and the list closes with a press elsewhere.
    expect(await stored(page, 'st-outline')).toBe('none');
    await expect(tagsButton(page, 'Outline', 'Same as task')).toBeVisible();
    await page.getByRole('heading', { name: 'Tasks', level: 2 }).click();
    await expect(list).toHaveCount(0);
    await expectClean(page, found);
  });

  test('with the keyboard: Enter opens the list, the arrows move, Space and Enter tick, Escape closes and gives focus back', async ({ page }) => {
    const found = await open(page, SEED);
    const button = tagsButton(page, 'Review', 'Same as task');
    await button.focus();
    await page.keyboard.press('Enter');
    const list = checklist(page, 'Review');
    await expect(list).toBeVisible();
    // Focus goes into the list, to Same as task; the arrow keys go on to the one button for all, then the tags.
    await expect(list.getByRole('button', { name: 'Same as task' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('button', { name: 'Deselect all' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('checkbox', { name: 'Concept' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(list.getByRole('checkbox', { name: 'Concept' })).not.toBeChecked();
    await expect.poll(() => stored(page, 'st-review')).toEqual(['tag-revision']);
    // Focus stays on the checkbox through the save, so the next arrow key and Enter go on from there.
    await expect(list.getByRole('checkbox', { name: 'Concept' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(list.getByRole('checkbox', { name: 'Revision' })).not.toBeChecked();
    await expect.poll(() => stored(page, 'st-review')).toEqual([]);
    await expect(list.getByRole('button', { name: 'Select all' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(tagsButton(page, 'Review', 'No tag')).toBeFocused();
    expect((await sets(page)).map((a) => a.tags)).toEqual([['tag-revision'], []]);
    await expectClean(page, found);
  });

  test('"Deselect all" makes an item No tag, "Select all" ticks every tag as a list of its own, one button for both', async ({ page }) => {
    const found = await open(page, SEED);
    await tagsButton(page, 'Outline', 'Same as task').click();
    const list = checklist(page, 'Outline');
    await list.getByRole('button', { name: 'Deselect all' }).click();
    await expect(tagsButton(page, 'Outline', 'No tag')).toContainText('No tag');
    for (const tag of ['Concept', 'Revision']) await expect(list.getByRole('checkbox', { name: tag })).not.toBeChecked();
    expect(await stored(page, 'st-outline')).toEqual([]);
    await expect(list.getByRole('button', { name: 'Deselect all' })).toHaveCount(0);
    await list.getByRole('button', { name: 'Select all' }).click();
    await expect(tagsButton(page, 'Outline', 'Concept, Revision')).toBeVisible();
    for (const tag of ['Concept', 'Revision']) await expect(list.getByRole('checkbox', { name: tag })).toBeChecked();
    // Every tag is a list, not "Same as task": the item keeps these if the task is given another tag later.
    expect(await stored(page, 'st-outline')).toEqual(['tag-concept', 'tag-revision']);
    await expect(list.getByRole('button', { name: 'Same as task' })).toHaveAttribute('aria-pressed', 'false');
    await expect(list.getByRole('button', { name: 'Deselect all' })).toBeVisible();
    await expectClean(page, found);
  });

  test('"Same as task" puts an item back, with the mouse and with the keyboard', async ({ page }) => {
    const found = await open(page, SEED);
    await tagsButton(page, 'Review', 'Same as task').click();
    const list = checklist(page, 'Review');
    await list.getByRole('checkbox', { name: 'Revision' }).uncheck();
    await expect(tagsButton(page, 'Review', 'Concept')).toBeVisible();
    await list.getByRole('button', { name: 'Same as task' }).click();
    await expect(tagsButton(page, 'Review', 'Same as task')).toBeVisible();
    for (const tag of ['Concept', 'Revision']) await expect(list.getByRole('checkbox', { name: tag })).toBeChecked();
    // The reset is an entry of its own, which is how it reaches the other computers.
    expect(await stored(page, 'st-review')).toBeNull();
    // With the keyboard: untick, then Home goes to Same as task and Space presses it.
    await list.getByRole('checkbox', { name: 'Concept' }).focus();
    await page.keyboard.press('Space');
    await expect.poll(() => stored(page, 'st-review')).toEqual(['tag-revision']);
    await page.keyboard.press('Home');
    await expect(list.getByRole('button', { name: 'Same as task' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => stored(page, 'st-review')).toBeNull();
    await page.keyboard.press('Escape');
    await expect(tagsButton(page, 'Review', 'Same as task')).toBeFocused();
    expect((await sets(page)).map((a) => a.tags)).toEqual([['tag-concept'], null, ['tag-revision'], null]);
    await expectClean(page, found);
  });

  test('while another computer holds the lease the button is off with the reason, and no list opens', async ({ page }) => {
    const found = await open(page, `${SEED}&lease=live`);
    const button = tagsButton(page, 'Review', 'Same as task');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /is using zWorkTracker, so this computer is read-only/);
    await button.click({ force: true });
    await expect(checklist(page, 'Review')).toHaveCount(0);
    expect(await sets(page)).toEqual([]);
    await expectClean(page, found);
  });
});

// ---------------------------------------------------------------- Analysis

const controls = (page: Page): Locator => page.getByRole('group', { name: 'Analysis controls' });
const share = (page: Page): Locator => page.locator('article.a-card', { has: page.getByRole('heading', { name: 'Share of time', exact: true }) });

/** The rows of the Tags level as written: name and minutes. */
async function tagRows(page: Page): Promise<Record<string, number>> {
  const rows = await share(page)
    .locator('ul.a-share-legend > li')
    .evaluateAll((items) => items.map((li) => [li.querySelector('.a-share-name')?.textContent ?? '', li.querySelector('.a-share-hm')?.textContent ?? ''] as const));
  return Object.fromEntries(
    rows.map(([name, hm]) => {
      const m = /^(?:(\d+)h )?(\d+)m$/.exec(hm);
      if (!m) throw new Error(`not a duration: "${hm}"`);
      return [name, Number(m[1] ?? 0) * 60 + Number(m[2])];
    }),
  );
}

/** The Analysis tab on Exact time and the Tags level of Share of time, which start again each time the tab is opened. */
async function showTags(page: Page): Promise<Record<string, number>> {
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Analysis', level: 1 })).toBeVisible();
  await controls(page).getByRole('radio', { name: 'Exact', exact: true }).click();
  await share(page).getByRole('radiogroup', { name: 'Share of time by' }).getByRole('radio', { name: 'Tags', exact: true }).click();
  await expect(share(page).locator('ul.a-share-legend')).toHaveAttribute('aria-label', 'Share of time legend, tags');
  return tagRows(page);
}

test.describe('where the choice shows in Analysis', () => {
  test('Share of time at the Tags level splits a task by the tags of its subtasks, and a row opens just that time', async ({ page }) => {
    const found = await open(page, SEED);
    const whole = await showTags(page);
    expect(Object.keys(whole)).toContain('Concept + Revision');
    const total = Object.values(whole).reduce((n, v) => n + v, 0);

    // Review, 75 minutes in the default week, counts under Revision alone; Outline keeps following the task.
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await tagsButton(page, 'Review', 'Same as task').click();
    await checklist(page, 'Review').getByRole('checkbox', { name: 'Concept' }).uncheck();
    await expect(tagsButton(page, 'Review', 'Revision')).toBeVisible();
    const split = await showTags(page);
    // The rows still add up to the same total, and exactly Review's 75 minutes moved from one row to the other.
    expect(Object.values(split).reduce((n, v) => n + v, 0)).toBe(total);
    expect(split['Revision']).toBe((whole['Revision'] ?? 0) + 75);
    expect(split['Concept + Revision']).toBe((whole['Concept + Revision'] ?? 0) - 75);
    for (const name of Object.keys(whole)) if (name !== 'Revision' && name !== 'Concept + Revision') expect(split[name], name).toBe(whole[name]);

    // The row for Revision opens the time under Revision alone: Review's 75 minutes among the tasks behind it.
    await share(page).locator('ul.a-share-legend > li').filter({ hasText: /^Revision/ }).getByRole('button').click();
    const panel = page.getByRole('dialog', { name: 'Drill-down: Revision' });
    await expect(panel).toBeVisible();
    await expect(panel.locator('.a-drill-tasks li').filter({ hasText: 'Brand guidelines' })).toContainText('1h 15m');
    await expect(panel.locator('.a-drill-tasks li').filter({ hasText: 'Homepage layout' })).toBeVisible();
    await expectClean(page, found);
  });

  test('the tag filter keeps only the time under a chosen tag, a subtask with tags of its own counting under those', async ({ page }) => {
    const found = await open(page, SEED);
    await tagsButton(page, 'Review', 'Same as task').click();
    await checklist(page, 'Review').getByRole('checkbox', { name: 'Concept' }).uncheck();
    await expect(tagsButton(page, 'Review', 'Revision')).toBeVisible();
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await controls(page).getByRole('radio', { name: 'Exact', exact: true }).click();
    const tagFilter = page.getByRole('group', { name: 'Tag filter' });
    // With a subtask on tags of its own, the words say it is time that is kept, and why Billable stays.
    await expect(tagFilter.locator('.a-tag-hint')).toHaveText('All tasks; a subtask counts under its own tags, and Billable rounds the time that is kept.');
    const centre = share(page).locator('.a-donut-total');
    // The centre of the donut is SVG text, so its words are read as text content.
    const all = (await centre.textContent()) ?? '';
    await tagFilter.getByRole('checkbox', { name: 'Concept' }).check();
    await expect(tagFilter.locator('.a-tag-hint')).toHaveText('Time with any selected tag; a subtask counts under its own tags, and Billable rounds the time that is kept.');
    await expect(centre).not.toHaveText(all);
    await share(page).getByRole('radiogroup', { name: 'Share of time by' }).getByRole('radio', { name: 'Tasks', exact: true }).click();
    // Brand guidelines is kept by its Outline time, 290 minutes, and not by Review's 75, which counts under Revision alone.
    const guideRow = share(page).locator('ul.a-share-legend > li').filter({ hasText: 'Brand guidelines' });
    await expect(guideRow.locator('.a-share-hm')).toHaveText(/^\d+h \d\d?m$/);
    const minutes = async (row: Locator): Promise<number> => {
      const m = /^(?:(\d+)h )?(\d+)m$/.exec((await row.locator('.a-share-hm').innerText()).trim());
      return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : Number.NaN;
    };
    const kept = await minutes(guideRow);
    await tagFilter.getByRole('checkbox', { name: 'Concept' }).uncheck();
    await tagFilter.getByRole('checkbox', { name: 'Revision' }).check();
    expect(await minutes(guideRow)).toBe(kept + 75);
    await expectClean(page, found);
  });
});
