import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOTS, advance, card, expectClean, open, refresh } from './support';

// Phase 2 on the task panel: tags, task-list items with their own time, templates, billed and unbilled
// time, unconfirmed time and the live ticker with pieces. Against the mock backend in src/mocks, which
// follows the Rust rules; the real backend is covered by its own tests.
const DEVICE = '11111111-1111-4111-8111-111111111111';

const newTask = (page: Page) => page.getByRole('button', { name: 'New task' }).click();
const form = (page: Page, name = 'New task') => page.getByRole('form', { name });
const calls = (page: Page, cmd: string) => page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args as Record<string, unknown>), cmd);
const subtasksOf = (page: Page, name: string) => card(page, name).getByRole('region', { name: 'Subtasks' });
const rowOf = (page: Page, name: string, text: string) => subtasksOf(page, name).getByRole('listitem').filter({ hasText: text });

test.describe('tags on the new-task form', () => {
  test('a cold start needs a tag: Start is disabled with the reason until one is chosen', async ({ page }) => {
    const found = await open(page, 'seed=p2&launch=cold');
    await newTask(page);
    const f = form(page);
    const start = f.getByRole('button', { name: 'Start', exact: true });
    await expect(f.getByText('To start, enter a task name, a project, a description and at least one tag.')).toBeVisible();
    await f.getByRole('textbox', { name: 'Task name' }).fill('Tagged cold task');
    await f.getByRole('combobox', { name: 'Project' }).selectOption('p-web');
    await f.getByRole('textbox', { name: 'Description' }).pressSequentially('Real words');
    await expect(start).toBeDisabled();
    await expect(f.getByText('To start, enter at least one tag.')).toBeVisible();
    await f.getByRole('checkbox', { name: 'Revision' }).check();
    await f.getByRole('checkbox', { name: 'Admin' }).check();
    await f.getByRole('checkbox', { name: 'Admin' }).uncheck();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(card(page, 'Tagged cold task').getByText('Running', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.tasks.find((t) => t.name === 'Tagged cold task')?.tags)).toEqual(['tag-revision']);
    await expect(card(page, 'Tagged cold task').getByTestId('tag-chip')).toHaveText('Revision');
    await expectClean(page, found);
  });

  test('when every tag has been deleted the cold list no longer has tags, and a start needs none', async ({ page }) => {
    const found = await open(page, 'seed=p2&launch=cold');
    await page.evaluate(() => window.__mock.tags.forEach((t) => (t.deleted = true)));
    await refresh(page);
    expect(await page.evaluate(() => window.__mock.warm)).toBe(false);
    await newTask(page);
    const f = form(page);
    await expect(f.getByRole('checkbox')).toHaveCount(0);
    await expect(f.getByText(/No tags yet/)).toBeVisible();
    await expect(f.getByText('To start, enter a task name, a project and a description.')).toBeVisible();
    await f.getByRole('textbox', { name: 'Task name' }).fill('No tags exist');
    await f.getByRole('combobox', { name: 'Project' }).selectOption('p-web');
    await f.getByRole('textbox', { name: 'Description' }).pressSequentially('Real words');
    await expect(f.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    await f.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(card(page, 'No tags exist').getByText('Running', { exact: true })).toBeVisible();
    await expectClean(page, found);
  });

  test('a warm start prefills the copied tags and resets the task list: unticked, no time', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await newTask(page);
    const f = form(page);
    await expect(f.getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    await expect(f.getByRole('checkbox', { name: 'Revision' })).not.toBeChecked();
    await f.getByRole('textbox', { name: 'Task name' }).fill('Logo concepts, second pass');
    await f.getByRole('button', { name: 'Save draft' }).click();
    const copy = card(page, 'Logo concepts, second pass');
    await expect(copy).toBeVisible();
    await expect(copy.getByTestId('tag-chip')).toHaveText('Concept');
    const rows = copy.getByRole('region', { name: 'Subtasks' }).getByRole('listitem');
    // Three items and the "no subtask" row, every item at 0s and none ticked.
    await expect(rows).toHaveCount(4);
    for (const text of ['Moodboard', 'Sketches', 'Final artwork']) await expect(rows.filter({ hasText: text }).getByText('0s')).toBeVisible();
    const items = await page.evaluate(() => {
      const t = window.__mock.tasks.find((x) => x.name === 'Logo concepts, second pass');
      return JSON.stringify(t?.description);
    });
    expect(items).not.toContain('"checked":true');
    expect(items).not.toContain('st-moodboard');
    // The original keeps its tick and its time.
    await expect(rowOf(page, 'Logo concepts', 'Moodboard').getByText('9h 40m')).toBeVisible();
    await expectClean(page, found);
  });

  test('editing tags autosaves, and clearing them all works', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await card(page, 'Brand guidelines').getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const f = form(page, 'Editing Brand guidelines');
    await expect(f.getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    await f.getByRole('checkbox', { name: 'Revision' }).uncheck();
    await expect(f.getByTestId('save-state')).toHaveText('Saved');
    await f.getByRole('checkbox', { name: 'Concept' }).uncheck();
    await expect.poll(async () => (await calls(page, 'patch_task')).length).toBe(2);
    expect(await calls(page, 'patch_task')).toEqual([
      { id: 't-guide', patch: { tags: ['tag-concept'] } },
      { id: 't-guide', patch: { tags: [] } },
    ]);
    await expect(card(page, 'Brand guidelines').getByTestId('tag-chip')).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.tasks.find((t) => t.id === 't-guide')?.tags)).toEqual([]);
    await f.getByRole('checkbox', { name: 'Client call' }).check();
    await expect(card(page, 'Brand guidelines').getByTestId('tag-chip')).toHaveText('Client call');
    await expectClean(page, found);
  });
});

test.describe('subtasks', () => {
  test('each item shows its time, one is active, and the total is the items plus time with no subtask', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await expect(rowOf(page, 'Logo concepts', 'Moodboard').getByText('9h 40m')).toBeVisible();
    await expect(rowOf(page, 'Logo concepts', 'Sketches').getByText('Active')).toBeVisible();
    await expect(rowOf(page, 'Logo concepts', 'Final artwork').getByText('0s')).toBeVisible();
    await expect(subtasksOf(page, 'Logo concepts').getByText('Active', { exact: true })).toHaveCount(1);
    await expect(subtasksOf(page, 'Logo concepts').getByRole('button', { name: 'Make active' })).toHaveCount(2);
    await expect(page.getByTestId('subtask-total')).toContainText('Total worked 19h 55m');
    await expectClean(page, found);
  });

  test('switching while running splits the time at now; time with no subtask is counted and the total still adds up', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const logo = subtasksOf(page, 'Logo concepts');
    // Stop attributing time to an item: from now on time is "with no subtask".
    await logo.getByRole('button', { name: 'No subtask' }).click();
    await expect(rowOf(page, 'Logo concepts', 'Time with no subtask').getByText('Active')).toBeVisible();
    await advance(page, 10 * 60);
    await expect(page.getByTestId('no-subtask-time')).toHaveText(/^10m( \d\ds)?$/);
    await expect(page.getByTestId('subtask-total')).toContainText('Total worked 20h 05m');
    // Items keep what they had.
    await expect(rowOf(page, 'Logo concepts', 'Sketches').getByText('10h 15m')).toBeVisible();

    // Make an item active: the running piece closes now and a new one opens for it.
    await rowOf(page, 'Logo concepts', 'Final artwork').getByRole('button', { name: 'Make active' }).click();
    await expect(rowOf(page, 'Logo concepts', 'Final artwork').getByText('Active')).toBeVisible();
    await expect(rowOf(page, 'Logo concepts', 'Final artwork')).toBeFocused();
    await expect(logo.getByText('Active', { exact: true })).toHaveCount(1);
    const split = await page.evaluate(() => {
      const own = window.__mock.segments.filter((s) => s.taskId === 't-logo' && s.start >= '2026-03-12T15:20:00Z');
      return { now: window.__mock.now, own: own.map((s) => [s.start, s.end, s.subtaskId ?? null]) };
    });
    expect(split.own).toHaveLength(2);
    const [closed, fresh] = split.own as [[string, string | null, string | null], [string, string | null, string | null]];
    expect(closed[2]).toBeNull(); // the ten minutes belong to no subtask
    expect(closed[1]).toBe(fresh[0]); // split at the same instant
    expect(fresh[1]).toBeNull();
    expect(fresh[2]).toBe('st-final');
    await expect(page.getByTestId('no-subtask-time')).toHaveText(/^10m( \d\ds)?$/);
    await expect(page.getByTestId('subtask-total')).toContainText('Total worked 20h 05m');
    await expectClean(page, found);
  });
});

test.describe('time on a card', () => {
  test('pending time away is shown as unconfirmed and counts nowhere', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const logo = card(page, 'Logo concepts');
    await expect(logo.getByText('Unconfirmed: not counted until you confirm')).toBeVisible();
    await expect(logo.getByTestId('unconfirmed-line')).toContainText('30m');
    // The open piece began when the pending gap ended: a session of 30 minutes, not 80.
    await expect(logo.locator('.ticker-clock')).toHaveText(/^0:(29:5\d|30:[0-5]\d)$/);
    await expect(card(page, 'Homepage layout').getByTestId('unconfirmed-line')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('billed and unbilled time after a summary, and the pauses a total includes', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await expect(card(page, 'Homepage layout').getByTestId('billed-line')).toHaveText('Billed 12h 10m, unbilled 18h 25m');
    await expect(card(page, 'Logo concepts').getByTestId('billed-line')).toContainText('includes 30m billable pauses');
    await expect(card(page, 'Box dieline').getByTestId('thinking-line')).toHaveText('Thinking time 25m, counted as worked time');
    // Voiding the summary returns its time to unbilled (the mock follows the Rust rule).
    await page.evaluate(() => window.__mock.summaries.forEach((s) => { if (s.reference === 'A-001') s.voided = true; }));
    await refresh(page);
    await expect(card(page, 'Homepage layout').getByTestId('billed-line')).toHaveText('Billed 0s, unbilled 30h 35m');
    await expectClean(page, found);
  });

  test('the ticker keeps a billable pause out of Exact and counts it in Billable', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const logo = card(page, 'Logo concepts');
    const exact = logo.locator('.ticker-grid > div').filter({ hasText: 'Today, exact' });
    const billable = logo.locator('.ticker-grid > div').filter({ hasText: 'Today, billable' });
    await expect(exact.locator('dd')).toContainText(/^2h 5[45]m/);
    await expect(exact).not.toContainText('billable pauses');
    await expect(billable.locator('dd')).toContainText(/^3h 30m/);
    await expect(billable).toContainText('includes 30m billable pauses');
    await expectClean(page, found);
  });

  test('a fixed-fee project shows Fixed fee instead of No rate set, and Hide earnings masks it', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await page.evaluate((device) => {
      const t = window.__mock.tasks.find((x) => x.id === 't-print');
      if (t) {
        t.state = 'running';
        t.stoppedAt = null;
      }
      window.__mock.segments.push({ id: 'seg-print-open', taskId: 't-print', deviceId: device, start: '2026-03-12T14:30:00Z', end: null, provisionalEnd: null });
    }, DEVICE);
    await refresh(page);
    const print = card(page, 'Print proofs');
    await expect(print.getByText(/^Fixed fee: /)).toHaveText('Fixed fee: €1,000.00. Hourly earnings are not counted.');
    await expect(print.getByText('No rate set')).toHaveCount(0);
    await page.evaluate(() => { window.__mock.hideEarnings = true; });
    await refresh(page);
    await expect(card(page, 'Print proofs').getByText(/^Fixed fee: /)).toHaveText('Fixed fee: ••••. Hourly earnings are not counted.');
    await expectClean(page, found);
  });
});

test.describe('templates', () => {
  test('From template fills the form, and Save as template stores a task as one', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await newTask(page);
    const f = form(page);
    await f.getByRole('combobox', { name: 'From template' }).selectOption({ label: 'Logo job' });
    await expect(f.getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo job');
    await expect(f.getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
    await expect(f.getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    await expect(f.getByRole('textbox', { name: 'Description' })).toContainText('Three directions, one round of changes.');
    await expect(f.getByRole('status').filter({ hasText: 'Filled in from the template' })).toBeVisible();
    expect(await calls(page, 'create_task')).toEqual([]);
    await f.getByRole('button', { name: 'Cancel' }).click();
    expect(await calls(page, 'create_task')).toEqual([]);

    await card(page, 'Brand guidelines').getByRole('button', { name: 'Edit Brand guidelines' }).click();
    const editor = form(page, 'Editing Brand guidelines');
    await editor.getByRole('button', { name: 'Save as template' }).click();
    await expect(editor.getByText(/Saved as template “Brand guidelines”/)).toBeVisible();
    const saved = await page.evaluate(() => window.__mock.templates.find((t) => t.name === 'Brand guidelines'));
    expect(saved).toMatchObject({ projectId: 'p-brand', tags: ['tag-concept', 'tag-revision'] });
    await editor.getByRole('button', { name: 'Done' }).click();
    await newTask(page);
    await expect(form(page).getByRole('combobox', { name: 'From template' }).getByRole('option', { name: 'Brand guidelines' })).toHaveCount(1);
    await expectClean(page, found);
  });
});

test.describe('screenshots', () => {
  const shot = (page: Page, file: string) => page.screenshot({ path: path.join(SHOTS, file) });

  test('subtasks, tags form, template form and the billed card', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await card(page, 'Logo concepts').scrollIntoViewIfNeeded();
    await shot(page, 'task-subtasks.png');

    await newTask(page);
    await expect(form(page).getByRole('checkbox', { name: 'Concept' })).toBeChecked();
    await shot(page, 'task-tags-form.png');

    await form(page).getByRole('combobox', { name: 'From template' }).selectOption({ label: 'Logo job' });
    await expect(form(page).getByText(/Filled in from the template/)).toBeVisible();
    await shot(page, 'task-from-template.png');
    await form(page).getByRole('button', { name: 'Cancel' }).click();

    const home = card(page, 'Homepage layout');
    await home.scrollIntoViewIfNeeded();
    await expect(home.getByTestId('billed-line')).toBeVisible();
    await shot(page, 'task-card-billed.png');
    await expectClean(page, found);
  });
});
