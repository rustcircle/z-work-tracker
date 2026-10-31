import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOTS, advance, card, expectClean, open, refresh, tab } from './support';

// Warm and cold launches, cold Resume, and editing a task at any time. The mock backend is the one in
// src/mocks: real behaviour of the Rust side is covered by its own tests and the native smoke script.
const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const newTask = (page: Page) => page.getByRole('button', { name: 'New task' }).click();
const form = (page: Page, name = 'New task') => page.getByRole('form', { name });
/** Backend commands the app sent since `from`, without the refreshes. */
const sent = (page: Page, from = 0) => page.evaluate((n) => window.__mock.calls.slice(n).map((c) => c.cmd).filter((c) => c !== 'get_snapshot'), from);
const callCount = (page: Page) => page.evaluate(() => window.__mock.calls.length);
const relaunch = async (page: Page, kind: 'quit' | 'crash') => {
  await page.evaluate((k) => window.__mockRelaunch(k), kind);
  await expect(card(page, 'Logo concepts').getByText('Paused', { exact: true })).toBeVisible();
};

test.describe('warm start copies the last task', () => {
  test('prefills a new form, is independent after editing, and Start works at once', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const before = await page.evaluate(() => JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-logo')));
    await newTask(page);
    const f = form(page);
    await expect(f.getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts');
    await expect(f.getByRole('combobox', { name: 'Project' })).toHaveValue('p-brand');
    await expect(f.getByRole('textbox', { name: 'Description' })).toContainText('Final artwork');
    await expect(f.getByTestId('copy-note')).toContainText('Copied from “Logo concepts”, Thu 12 Mar 2026');
    await expect(f.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();

    await f.getByRole('textbox', { name: 'Task name' }).fill('Logo concepts, second pass');
    await f.getByRole('textbox', { name: 'Description' }).pressSequentially(' Added line.');
    await f.getByRole('button', { name: 'Save draft' }).click();
    await expect(card(page, 'Logo concepts, second pass')).toBeVisible();
    const after = await page.evaluate(() => ({
      source: JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-logo')),
      copy: JSON.stringify(window.__mock.tasks.find((t) => t.name === 'Logo concepts, second pass')?.description),
    }));
    expect(after.source).toBe(before);
    expect(after.copy).toContain('Added line.');
    expect(after.copy).toContain('Final artwork');
    await expectClean(page, found);
  });

  test('Start blank clears the form', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await newTask(page);
    await form(page).getByRole('button', { name: 'Start blank' }).click();
    await expect(form(page).getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    await expect(form(page).getByTestId('copy-note')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('an archived source project is left empty with a clear message', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => {
      const p = window.__mock.projects.find((x) => x.id === 'p-brand');
      if (p) p.archived = true;
    });
    await refresh(page);
    await newTask(page);
    const f = form(page);
    await expect(f.getByRole('combobox', { name: 'Project' })).toHaveValue('');
    await expect(f.getByText(/“Brand refresh” of the copied task is archived, so choose a project/)).toBeVisible();
    await expect(f.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
    await f.getByRole('combobox', { name: 'Project' }).selectOption('p-web');
    await expect(f.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
    await expectClean(page, found);
  });

  test('hiding to the tray and showing the window again stays warm', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => window.__mockEmit('first-hide-notice', { running: true, taskName: 'Logo concepts' }));
    const dialog = page.getByRole('dialog', { name: 'zWorkTracker is still running' });
    await expect(dialog.getByTestId('hide-running')).toContainText('“Logo concepts” is still being timed');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await page.evaluate(() => window.__mockEmit('flush-edits'));
    await refresh(page); // the window is shown again and reads a fresh snapshot
    await newTask(page);
    await expect(form(page).getByRole('textbox', { name: 'Task name' })).toHaveValue('Logo concepts');
    expect(await page.evaluate(() => window.__mock.warm)).toBe(true);
    await expectClean(page, found);
  });
});

test.describe('cold start requires every field', () => {
  test('opens empty, all fields required, whitespace-only rejected', async ({ page }) => {
    const found = await open(page, 'seed=demo&launch=cold');
    await newTask(page);
    const f = form(page);
    await expect(f.getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    await expect(f.getByRole('textbox', { name: 'Task name' })).toBeFocused();
    await expect(f.getByRole('combobox', { name: 'Project' })).toHaveValue('');
    await expect(f.getByRole('textbox', { name: 'Description' })).toHaveText('');
    await expect(f.getByTestId('copy-note')).toHaveCount(0);
    const start = f.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeDisabled();
    await expect(f.getByText('To start, enter a task name, a project, a description and at least one tag.')).toBeVisible();
    await f.getByRole('textbox', { name: 'Task name' }).fill('Cold task');
    await f.getByRole('combobox', { name: 'Project' }).selectOption('p-web');
    await f.getByRole('textbox', { name: 'Description' }).pressSequentially('     ');
    await expect(f.getByText(/spaces-only description does not count/)).toBeVisible();
    await expect(start).toBeDisabled();
    await f.getByRole('textbox', { name: 'Description' }).pressSequentially('Real words');
    // Everything else is there, but the demo has tags, so a cold start needs one of them too.
    await expect(start).toBeDisabled();
    await expect(f.getByText('To start, enter at least one tag.')).toBeVisible();
    await f.getByRole('checkbox', { name: 'Concept' }).check();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(card(page, 'Cold task').getByText('Running', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.warm)).toBe(true);
    await expectClean(page, found);
  });

  test('saving with a missing field puts focus on the first invalid one', async ({ page }) => {
    const found = await open(page, 'seed=demo&launch=cold');
    await newTask(page);
    const f = form(page);
    await f.getByRole('button', { name: 'Save draft' }).click();
    await expect(f.getByRole('textbox', { name: 'Task name' })).toBeFocused();
    await f.getByRole('textbox', { name: 'Task name' }).fill('Named only');
    await f.getByRole('button', { name: 'Save draft' }).click();
    await expect(f.getByRole('combobox', { name: 'Project' })).toBeFocused();
    await expectClean(page, found);
  });

  test('a relaunch after a quit goes cold again, and the form opens empty', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await relaunch(page, 'quit');
    await expect(card(page, 'Logo concepts').getByText('Paused when the app was closed')).toBeVisible();
    await newTask(page);
    await expect(form(page).getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    await expect(form(page).getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__mock.warm)).toBe(false);
    await expectClean(page, found);
  });
});

test.describe('cold Resume', () => {
  test('opens the empty form for a new linked task, and Cancel changes and logs nothing', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await relaunch(page, 'quit');
    const segmentsBefore = await page.evaluate(() => JSON.stringify(window.__mock.segments));
    const mark = await callCount(page);
    await card(page, 'Logo concepts').getByRole('button', { name: 'Resume' }).click();
    const f = form(page, 'Continue Logo concepts');
    await expect(f.getByTestId('continue-note')).toContainText('Continuing “Logo concepts”');
    await expect(f.getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    await expect(f.getByRole('combobox', { name: 'Project' })).toHaveValue('');
    await expect(f.getByRole('textbox', { name: 'Description' })).toHaveText('');
    await f.getByRole('button', { name: 'Cancel' }).click();
    await expect(f).toHaveCount(0);
    const cmds = await sent(page, mark);
    expect(cmds.filter((c) => ['create_task', 'start_task', 'resume_task'].includes(c))).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify(window.__mock.segments))).toBe(segmentsBefore);
    await expectClean(page, found);
  });

  test('submitting creates a linked task and leaves the old one unchanged, with links both ways', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await relaunch(page, 'quit');
    const oldBefore = await page.evaluate(() => JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-logo')));
    await card(page, 'Logo concepts').getByRole('button', { name: 'Resume' }).click();
    const f = form(page, 'Continue Logo concepts');
    await f.getByRole('textbox', { name: 'Task name' }).fill('Logo concepts v2');
    await f.getByRole('combobox', { name: 'Project' }).selectOption('p-brand');
    await f.getByRole('textbox', { name: 'Description' }).pressSequentially('Second round');
    await expect(f.getByRole('button', { name: 'Start', exact: true })).toBeDisabled(); // a cold start needs a tag
    await f.getByRole('checkbox', { name: 'Revision' }).check();
    await f.getByRole('button', { name: 'Start', exact: true }).click();
    const fresh = card(page, 'Logo concepts v2');
    await expect(fresh.getByText('Running', { exact: true })).toBeVisible();
    await expect(fresh.getByText('Continued from')).toBeVisible();
    const state = await page.evaluate(() => ({
      calls: window.__mock.calls.map((c) => c.cmd).filter((c) => ['create_task', 'start_task', 'resume_task'].includes(c)),
      created: window.__mock.calls.find((c) => c.cmd === 'create_task')?.args,
      old: JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-logo')),
      open: window.__mock.segments.filter((s) => s.end === null).map((s) => s.taskId),
    }));
    expect(state.calls).toEqual(['create_task', 'start_task']);
    expect(state.created).toMatchObject({ input: { continuedFrom: 't-logo' } });
    // The old task: same name, description and state; only its pause reason may differ from before.
    expect(JSON.parse(state.old)).toEqual(JSON.parse(oldBefore));
    expect(state.open).toHaveLength(1);
    const old = card(page, 'Logo concepts');
    await expect(old.getByText('Continued by')).toBeVisible();
    await expect(old.getByRole('button', { name: 'Stop' })).toBeEnabled();
    // The link moves to the continuation, by keyboard too.
    await old.getByRole('button', { name: 'Logo concepts v2' }).focus();
    await page.keyboard.press('Enter');
    await expect(fresh).toBeFocused();
    // The timeline shows the link on the new task's entries.
    await tab(page, 'Timeline');
    await advance(page, 120);
    const entry = page.getByTestId('entry').filter({ has: page.getByText('Running', { exact: true }) }).first();
    await expect(entry.getByRole('button', { name: 'Logo concepts', exact: true })).toBeVisible();
    await entry.getByRole('button', { name: 'Logo concepts', exact: true }).click();
    await expect(old).toBeFocused();
    await expectClean(page, found);
  });

  test('the tray route opens the same form through the cold-resume event and starts nothing', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await relaunch(page, 'quit');
    const mark = await callCount(page);
    await page.evaluate(() => window.__mockEmit('cold-resume', { taskId: 't-logo' }));
    await expect(form(page, 'Continue Logo concepts')).toBeVisible();
    expect((await sent(page, mark)).filter((c) => ['create_task', 'start_task', 'resume_task'].includes(c))).toEqual([]);
    await expectClean(page, found);
  });

  test('after a crash the notice says so and Resume opens the form', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => window.__mockRelaunch('crash'));
    await expect(page.getByTestId('notice')).toContainText('The next start asks for every field.');
    const old = card(page, 'Logo concepts');
    await expect(old.getByText(/closed unexpectedly/)).toBeVisible();
    await old.getByRole('button', { name: 'Resume' }).click();
    await expect(form(page, 'Continue Logo concepts')).toBeVisible();
    await expectClean(page, found);
  });

  test('once warm, Resume continues a paused task directly', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' }).click();
    await expect(card(page, 'Brand guidelines').getByText('Running', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.calls.some((c) => c.cmd === 'resume_task'))).toBe(true);
    await expectClean(page, found);
  });
});

test.describe('editing at any time', () => {
  for (const [name, state] of [
    ['Social templates', 'draft'],
    ['Logo concepts', 'running'],
    ['Brand guidelines', 'paused'],
    ['Homepage layout', 'stopped'],
  ] as const) {
    test(`a ${state} task: one click, autosave, state and segments unchanged`, async ({ page }) => {
      const found = await open(page, 'seed=demo');
      const segs = await page.evaluate(() => JSON.stringify(window.__mock.segments));
      await card(page, name).getByRole('button', { name: `Edit ${name}` }).click();
      const input = page.getByRole('form', { name: `Editing ${name}` }).getByRole('textbox', { name: 'Task name' });
      await expect(input).toBeFocused();
      await input.pressSequentially(' (edited)');
      await expect(page.getByTestId('save-state')).toHaveText('Saved');
      expect(await page.evaluate((n) => window.__mock.tasks.find((t) => t.name === n)?.state, `${name} (edited)`)).toBe(state);
      expect(await page.evaluate(() => JSON.stringify(window.__mock.segments))).toBe(segs);
      await expect(page.getByRole('heading', { name: `${name} (edited)` })).toBeVisible();
      await expectClean(page, found);
    });
  }

  test('a running task keeps counting while it is edited, and the description can be cleared', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const logo = card(page, 'Logo concepts');
    const secs = async () => (await logo.locator('.ticker-clock').innerText()).split(':').reduce((n, x) => n * 60 + Number(x), 0);
    const before = await secs();
    await logo.getByRole('button', { name: 'Edit Logo concepts' }).click();
    const editing = page.getByRole('form', { name: 'Editing Logo concepts' });
    const desc = editing.getByRole('textbox', { name: 'Description' });
    await expect(desc).toContainText('Final artwork');
    await desc.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    expect(await page.evaluate(() => window.__mock.tasks.find((t) => t.id === 't-logo')?.description)).toBeNull();
    await advance(page, 30);
    await expect.poll(secs).toBeGreaterThanOrEqual(before + 30);
    expect(await page.evaluate(() => window.__mock.tasks.find((t) => t.id === 't-logo')?.state)).toBe('running');
    expect(await page.evaluate(() => window.__mock.calls.filter((c) => ['pause_task', 'stop_task', 'start_task', 'resume_task'].includes(c.cmd)).length)).toBe(0);
    await expectClean(page, found);
  });

  test('a blank name is not saved and the last valid name comes back', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Social templates').getByRole('button', { name: 'Edit Social templates' }).click();
    const input = page.getByRole('form', { name: 'Editing Social templates' }).getByRole('textbox', { name: 'Task name' });
    await input.fill('');
    await expect(page.getByText(/A task needs a name/)).toBeVisible();
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => window.__mock.calls.filter((c) => c.cmd === 'patch_task').length)).toBe(0);
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('Social templates');
    await expectClean(page, found);
  });

  test('a pending edit is saved when the backend asks for a flush', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Social templates').getByRole('button', { name: 'Edit Social templates' }).click();
    const input = page.getByRole('form', { name: 'Editing Social templates' }).getByRole('textbox', { name: 'Task name' });
    await input.pressSequentially(' now');
    await page.evaluate(() => window.__mockEmit('flush-edits'));
    await expect.poll(() => page.evaluate(() => window.__mock.tasks.find((t) => t.id === 't-next')?.name)).toBe('Social templates now');
    await expectClean(page, found);
  });

  test('editing from a timeline entry opens the editor on the task card', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.getByRole('button', { name: 'Edit task Homepage layout' }).first().click();
    const input = page.getByRole('form', { name: 'Editing Homepage layout' }).getByRole('textbox', { name: 'Task name' });
    await expect(input).toBeFocused();
    await input.pressSequentially(' (final)');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    // The timeline shows the current name, and an export started now is built from the same stored task.
    await expect(page.getByTestId('entry').filter({ hasText: 'Homepage layout (final)' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('button', { name: 'Export Excel' }).click();
    await expect(page.getByTestId('export-result')).toBeVisible();
    expect(await page.evaluate(() => ({ exports: window.__mock.exports.length, name: window.__mock.tasks.find((t) => t.id === 't-home')?.name }))).toEqual({ exports: 1, name: 'Homepage layout (final)' });
    await expectClean(page, found);
  });
});

test.describe('screenshots', () => {
  test('cold form, warm copy, cold resume and inline edit', async ({ page }) => {
    const found = await open(page, 'seed=demo&launch=cold');
    await newTask(page);
    await expect(form(page).getByRole('textbox', { name: 'Task name' })).toBeFocused();
    await page.screenshot({ path: path.join(SHOTS, 'launch-cold-form.png') });
    await expectClean(page, found);

    const warm = await open(page, 'seed=demo');
    await newTask(page);
    await expect(form(page).getByTestId('copy-note')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'launch-warm-copy.png') });
    await expectClean(page, warm);

    const resume = await open(page, 'seed=demo&launch=cold');
    await card(page, 'Logo concepts').getByRole('button', { name: 'Resume' }).click();
    await expect(form(page, 'Continue Logo concepts')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'launch-cold-resume.png') });
    await expectClean(page, resume);

    const edit = await open(page, 'seed=demo');
    await card(page, 'Logo concepts').getByRole('button', { name: 'Edit Logo concepts' }).click();
    await page.getByRole('form', { name: 'Editing Logo concepts' }).getByRole('textbox', { name: 'Task name' }).pressSequentially(' v2');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    await page.screenshot({ path: path.join(SHOTS, 'task-inline-edit.png') });
    await expectClean(page, edit);
  });

  for (const [theme, file] of THEMES) {
    test(`launch forms in ${file}`, async ({ page }) => {
      const found = await open(page, `seed=demo&launch=cold&theme=${theme}`);
      await card(page, 'Logo concepts').getByRole('button', { name: 'Resume' }).click();
      await expect(form(page, 'Continue Logo concepts')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `launch-cold-resume-${file}.png`) });
      await expectClean(page, found);
    });
  }
});
