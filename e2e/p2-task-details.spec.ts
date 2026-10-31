import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { Snapshot } from '../src/lib/types';
import { SHOTS, card, expectClean, open } from './support';

// ?seed=p2: 12 March 2026 15:20 UTC, active zone Lisbon (UTC+0 until 29 March, so wall time reads as UTC).

/** The backend mock's current snapshot, read through the same IPC the app uses. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } };
    return (await w.__TAURI_INTERNALS__.invoke('get_snapshot')) as never;
  });
}

async function openDetails(page: Page, task: string, tabName?: string): Promise<Locator> {
  await card(page, task).getByRole('button', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Details: ${task}` })).toBeVisible();
  if (tabName) await dialog.getByRole('tab', { name: tabName }).click();
  return dialog;
}

const row = (dialog: Locator, text: string | RegExp): Locator => dialog.getByRole('listitem').filter({ hasText: text }).last();

async function fillWall(dialog: Locator, prefix: string, day: string, time: string): Promise<void> {
  await dialog.getByLabel(`${prefix} date`, { exact: true }).fill(day);
  await dialog.getByLabel(`${prefix} time`, { exact: true }).fill(time);
}

const shot = (dialog: Locator, name: string): Promise<Buffer> => dialog.screenshot({ path: path.join(SHOTS, name) });

test.describe('Add time', () => {
  test('adds time by hand, warns about an overlap and adds anyway, refuses an end in the future', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const dialog = await openDetails(page, 'Homepage layout');

    // A plain entry.
    await fillWall(dialog, 'Start', '2026-03-11', '18:00');
    await fillWall(dialog, 'End', '2026-03-11', '18:30');
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('Phone call with the client');
    await shot(dialog, 'task-add-time.png');
    await dialog.getByRole('button', { name: 'Add time' }).click();
    await expect(dialog.getByText('Added 30m to this task: 11 Mar 18:00 to 18:30.')).toBeVisible();
    expect((await snapshot(page)).rawSegments.filter((s) => s.manual).map((s) => [s.start, s.end])).toContainEqual(['2026-03-11T18:00:00Z', '2026-03-11T18:30:00Z']);

    // An overlap: warn, change nothing, then add anyway.
    await fillWall(dialog, 'Start', '2026-03-11', '15:00');
    await fillWall(dialog, 'End', '2026-03-11', '15:30');
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('A second job at the same time');
    await dialog.getByRole('button', { name: 'Add time' }).click();
    const warning = dialog.getByRole('alert');
    await expect(warning).toContainText(/overlaps time already logged on/i);
    await expect(warning).toContainText('Homepage layout');
    expect((await snapshot(page)).rawSegments.some((s) => s.manual && s.start === '2026-03-11T15:00:00Z')).toBe(false);
    await warning.getByRole('button', { name: 'Add anyway' }).click();
    await expect(dialog.getByText('Added 30m to this task: 11 Mar 15:00 to 15:30.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add anyway' })).toHaveCount(0);
    expect((await snapshot(page)).rawSegments.some((s) => s.manual && s.start === '2026-03-11T15:00:00Z')).toBe(true);

    // An end in the future is refused inline, with no way around it.
    const before = (await snapshot(page)).rawSegments.length;
    await fillWall(dialog, 'Start', '2026-03-12', '15:00');
    await fillWall(dialog, 'End', '2026-03-12', '16:00');
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('Later today');
    await dialog.getByRole('button', { name: 'Add time' }).click();
    await expect(dialog.getByRole('alert')).toHaveText("The end can't be in the future.");
    await expect(dialog.getByRole('button', { name: 'Add anyway' })).toHaveCount(0);
    expect((await snapshot(page)).rawSegments).toHaveLength(before);
    await expectClean(page, found);
  });

  test('reads the wall clock in the active zone: a New York entry lands four hours later in UTC', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    await page.getByRole('button', { name: 'Client time' }).click(); // Client zone is New York
    const dialog = await openDetails(page, 'Homepage layout');
    await expect(dialog.getByText(/Times are in New York, EDT, UTC-4/)).toBeVisible();
    await fillWall(dialog, 'Start', '2026-03-11', '14:00');
    await fillWall(dialog, 'End', '2026-03-11', '14:45');
    await dialog.getByRole('textbox', { name: 'Reason' }).fill('Timezone check');
    await dialog.getByRole('button', { name: 'Add time' }).click();
    await expect(dialog.getByText(/Added 45m/)).toBeVisible();
    expect((await snapshot(page)).rawSegments.filter((s) => s.manual).map((s) => [s.start, s.end])).toContainEqual(['2026-03-11T18:00:00Z', '2026-03-11T18:45:00Z']);
    await expectClean(page, found);
  });
});

test.describe('Corrections and History', () => {
  test('a correction keeps the recorded time beside it; a void and a restore each take a reason', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const dialog = await openDetails(page, 'Logo concepts', 'Corrections');
    const corrected = row(dialog, /Corrected/);
    await expect(corrected).toContainText('Counts as09:00 to 11:05');
    await expect(corrected).toContainText('Recorded09:00 to 11:20');
    await expect(corrected).toContainText('Reason: Stopped at 11:05, the timer ran on');
    await expect(row(dialog, 'to now')).toContainText('Still running. Pause or stop the task before you correct this time.');
    await expect(row(dialog, 'to now').getByRole('button', { name: 'Correct' })).toHaveCount(0);
    await corrected.scrollIntoViewIfNeeded();
    await corrected.getByRole('button', { name: 'Restore' }).click();
    await corrected.getByRole('textbox', { name: 'Reason' }).fill('The timer was right');
    await shot(dialog, 'task-corrections.png');
    await corrected.getByRole('button', { name: 'Cancel' }).click();

    // Correct a stopped task's time, then void and restore a hand-entered one.
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    const home = await openDetails(page, 'Homepage layout', 'Corrections');
    const manual = row(home, 'Added by hand');
    await expect(manual).toContainText('16:45 to 17:15');
    await manual.getByRole('button', { name: 'Void' }).click();
    const voidForm = manual.getByRole('form', { name: /^Void / });
    await voidForm.getByRole('button', { name: 'Confirm void' }).click();
    await expect(voidForm.getByText('Say why, so the history makes sense later.')).toBeVisible();
    await voidForm.getByRole('textbox', { name: 'Reason' }).fill('Entered twice');
    await voidForm.getByRole('button', { name: 'Confirm void' }).click();
    const voided = row(home, /Voided/);
    await expect(voided).toContainText('Counts asNot counted');
    await expect(voided).toContainText('Recorded16:45 to 17:15');
    await expect(voided.getByRole('button', { name: 'Void' })).toHaveCount(0);
    expect((await snapshot(page)).rawSegments.filter((s) => s.voided)).toHaveLength(1);

    await voided.getByRole('button', { name: 'Restore' }).click();
    const restoreForm = voided.getByRole('form', { name: /^Restore / });
    await restoreForm.getByRole('textbox', { name: 'Reason' }).fill('It was real after all');
    await restoreForm.getByRole('button', { name: 'Confirm restore' }).click();
    await expect(home.getByText(/Restored .* to the recorded time\./)).toBeVisible();
    expect((await snapshot(page)).rawSegments.filter((s) => s.voided)).toHaveLength(0);
    await expectClean(page, found);
  });

  test('offers Correct anyway on an overlap and keeps the raw time next to the result', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const dialog = await openDetails(page, 'Homepage layout', 'Corrections');
    const target = row(dialog, /Wed 11 Mar 2026.*14:00 to 16:30/);
    await target.getByRole('button', { name: 'Correct' }).click();
    const form = target.getByRole('form', { name: /^Correct / });
    await form.getByLabel('New end time').fill('17:10');
    await form.getByRole('textbox', { name: 'Reason' }).fill('Ran over');
    await form.getByRole('button', { name: 'Save correction' }).click();
    await expect(form.getByRole('alert')).toContainText(/overlaps time already logged on/i);
    await form.getByRole('button', { name: 'Correct anyway' }).click();
    const after = row(dialog, /Wed 11 Mar 2026.*Corrected/);
    await expect(after).toContainText('Counts as14:00 to 17:10');
    await expect(after).toContainText('Recorded14:00 to 16:30');
    await expectClean(page, found);
  });

  test('a billed row explains why it cannot change and offers no action', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const dialog = await openDetails(page, 'Homepage layout', 'Corrections');
    const billed = dialog.getByRole('listitem').filter({ has: page.locator('.badge-success', { hasText: 'Billed' }) });
    expect(await billed.count()).toBeGreaterThan(0);
    for (const r of await billed.all()) {
      await expect(r).toContainText('This time is on a billing summary; void that summary first.');
      await expect(r.getByRole('button', { name: /^(Correct|Void|Restore)$/ })).toHaveCount(0);
    }
    await expectClean(page, found);
  });

  test('History lists the task entries with reasons and before and after, and one segment on its row', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const dialog = await openDetails(page, 'Logo concepts', 'History');
    const list = dialog.getByRole('list', { name: 'History of this task' });
    const corrected = list.getByRole('listitem').filter({ hasText: 'Time corrected' });
    await expect(corrected).toContainText('9 Mar 09:00 to 11:20 became 9 Mar 09:00 to 11:05');
    await expect(corrected).toContainText('Reason: Stopped at 11:05, the timer ran on');
    await expect(list.getByRole('listitem').filter({ hasText: 'Pause billed' })).toContainText('Waiting on the client call');
    await shot(dialog, 'task-history.png');

    await dialog.getByRole('tab', { name: 'Corrections' }).click();
    const seg = row(dialog, /Corrected/);
    await seg.getByRole('button', { name: 'History' }).click();
    const own = seg.getByRole('list', { name: /^History of / });
    await expect(own.getByRole('listitem')).toHaveCount(1);
    await expect(own).toContainText('Time corrected');
    await expectClean(page, found);
  });
});

test.describe('Pauses', () => {
  const pauseRow = (dialog: Locator): Locator => row(dialog, /Tue 3 Mar 2026.*11:20 to 11:35/); // Homepage layout, 3 March

  test('bills a pause: Billable grows, Exact and the logged time do not; Undo reverses it', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const homeCard = card(page, 'Homepage layout');
    const loggedText = await homeCard.getByText(/logged$/).textContent();
    const base = await snapshot(page);
    const baseTask = base.tasks.find((t) => t.id === 't-home');
    const baseProject = base.projects.find((p) => p.id === 'p-web');
    expect(baseTask?.pauseSecs).toBe(0);

    const dialog = await openDetails(page, 'Homepage layout', 'Pauses');
    const target = pauseRow(dialog);
    await expect(target).toContainText('Tue 3 Mar 2026');
    await expect(target).toContainText('15m');
    await target.getByRole('textbox').fill('Waiting for the client');
    await target.getByRole('button', { name: 'Bill this pause' }).click();
    await expect(target).toContainText('Billed as pause');
    await expect(target).toContainText('Note: Waiting for the client');
    await expect(dialog.getByText(/Billable pause time on this task:/)).toContainText('15m');
    await expect(dialog.getByRole('definition').filter({ hasText: '15m' }).first()).toBeVisible();
    await shot(dialog, 'task-pauses.png');

    const marked = await snapshot(page);
    expect(marked.tasks.find((t) => t.id === 't-home')?.pauseSecs).toBe(900);
    expect(marked.projects.find((p) => p.id === 'p-web')?.figures.pauseSecs).toBe((baseProject?.figures.pauseSecs ?? 0) + 900);
    expect(marked.projects.find((p) => p.id === 'p-web')?.figures.billableSecs).toBeGreaterThan(baseProject?.figures.billableSecs ?? 0);
    expect(marked.projects.find((p) => p.id === 'p-web')?.figures.exactSecs).toBe(baseProject?.figures.exactSecs);
    expect(marked.rawSegments.filter((s) => s.taskId === 't-home').map((s) => [s.start, s.end])).toEqual(base.rawSegments.filter((s) => s.taskId === 't-home').map((s) => [s.start, s.end]));

    await target.getByRole('button', { name: 'Undo' }).click();
    await expect(target.getByRole('button', { name: 'Bill this pause' })).toBeVisible();
    const undone = await snapshot(page);
    expect(undone.tasks.find((t) => t.id === 't-home')?.pauseSecs).toBe(0);
    expect(undone.projects.find((p) => p.id === 'p-web')?.figures).toEqual(baseProject?.figures);

    await dialog.getByRole('button', { name: 'Close' }).first().click();
    expect(await homeCard.getByText(/logged$/).textContent()).toBe(loggedText);
    await expectClean(page, found);
  });

  test('a pause on a billing summary shows why it cannot change', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    // Mark the pause and put it on a summary through the backend, as another window or device would.
    const dialog = await openDetails(page, 'Homepage layout', 'Pauses');
    await pauseRow(dialog).getByRole('button', { name: 'Bill this pause' }).click();
    await expect(pauseRow(dialog)).toContainText('Billed as pause');
    await page.evaluate(async () => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
      await w.__TAURI_INTERNALS__.invoke('create_summary', { request: { projectId: 'p-web', from: '2026-03-03', to: '2026-03-03', zone: 'Europe/Lisbon' } });
    });
    await page.evaluate(() => window.__mockEmit('state-changed'));
    await dialog.getByRole('tab', { name: 'Corrections' }).click();
    await dialog.getByRole('tab', { name: 'Pauses' }).click();
    await expect(pauseRow(dialog)).toContainText('This time is on a billing summary; void that summary first.');
    await expect(pauseRow(dialog).getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('Time away', () => {
  test('a pending decision counts nowhere until decided; changing it later moves unconfirmed and thinking time', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const dialog = await openDetails(page, 'Logo concepts', 'Time away');
    await expect(dialog.getByText('Unconfirmed: not counted until you confirm.')).toBeVisible();
    const gap = row(dialog, '14:20 to 14:50');
    await expect(gap).toContainText('Idle');
    await expect(gap).toContainText('30m');
    await expect(gap).toContainText('Waiting for your decision');
    const task = async () => (await snapshot(page)).tasks.find((t) => t.id === 't-logo');
    const start = await task();
    expect(start?.unconfirmedSecs).toBe(1800);

    await gap.getByRole('button', { name: 'Mark as thinking' }).click();
    await expect(gap).toContainText('Thinking time');
    await expect(dialog.getByText('Unconfirmed: not counted until you confirm.')).toHaveCount(0);
    const thinking = await task();
    expect(thinking?.unconfirmedSecs).toBe(0);
    expect(thinking?.thinkingSecs).toBe((start?.thinkingSecs ?? 0) + 1800);

    await gap.getByRole('button', { name: 'Drop' }).click();
    await expect(gap).toContainText('Dropped');
    expect((await task())?.thinkingSecs).toBe(start?.thinkingSecs);
    await gap.getByRole('button', { name: 'Keep' }).click();
    await expect(gap).toContainText('Kept');
    expect((await snapshot(page)).gaps.find((g) => g.id === 'gap-pending')?.decision).toBe('keep');
    await expectClean(page, found);
  });
});

test.describe('Keyboard', () => {
  test('the dialog works without a mouse: focus moves in, tabs follow the arrows, a decision is made, Escape closes and focus returns', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const button = card(page, 'Logo concepts').getByRole('button', { name: 'Details' });
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: 'Add time' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(dialog.getByRole('tab', { name: 'Time away', selected: true })).toBeFocused();
    await page.keyboard.press('Tab'); // out of the tab list and into the panel
    const gap = row(dialog, '14:20 to 14:50');
    await expect(gap.getByRole('button', { name: 'Keep' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(gap).toContainText('Kept');
    expect((await snapshot(page)).gaps.find((g) => g.id === 'gap-pending')?.decision).toBe('keep');
    // Focus never leaves the dialog while it is open.
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    await expectClean(page, found);
  });
});
