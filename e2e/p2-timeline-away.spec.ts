import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, card, expectClean, open, tab } from './support';

// Time away, billable pauses and the timeline marks, reminders, backups and the audit log. Every figure
// below is hand-computed from the `?seed=p2` data (see src/mocks/demoSeed.ts) and checked against the
// backend's rules as the mock models them; the real Rust backend is covered by its own tests.
//
// Seed facts (My zone Lisbon, UTC in March, so wall clock = UTC; now = Thu 12 Mar 2026 15:20):
//  - Logo concepts (USD 90.00/h) today: 00:00-00:40 (from the midnight-crossing segment), 09:05-10:30,
//    14:00 running with a PENDING gap 14:20-14:50 (idle), a billable pause 10:45-11:15.
//    Exact = 40 + 85 + 20 + 30 = 175 min; Billable = round up to 15 of (175 + 30) = 210 min.
//  - Box dieline 10 Mar has a thinking gap 15:00-15:25, Homepage layout 10 Mar a dropped gap 10:00-10:20.
//  - Logo concepts 9 Mar was corrected to end 11:05; Homepage layout 11 Mar has a segment added by hand.

const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const dialog = (page: Page): Locator => page.getByRole('dialog', { name: /You were away/ });
const banner = (page: Page): Locator => page.getByTestId('away-banner');
const today = (page: Page): Locator => card(page, 'Thu 12 Mar 2026');
const UNCONFIRMED = 'Unconfirmed: not counted until you confirm';

/**
 * Opens the p2 seed with the page clock stopped, so the running task's seconds stop moving and money
 * figures can be exact. The dialog opens by itself on return.
 */
async function openFrozen(page: Page, query = ''): Promise<Awaited<ReturnType<typeof open>>> {
  const found = await open(page, `seed=p2&away=show${query}`);
  await page.clock.pauseAt(new Date('2026-03-12T15:21:00Z'));
  return found;
}

/** Asks the app for a fresh snapshot, as the backend's state-changed event does, and waits for it. */
async function resync(page: Page): Promise<void> {
  const before = await page.evaluate(() => window.__mock.calls.length);
  await page.evaluate(() => window.__mockEmit('state-changed'));
  await expect.poll(() => page.evaluate((n) => window.__mock.calls.slice(n).filter((c) => c.cmd === 'get_snapshot').length, before)).toBeGreaterThan(0);
}

/** Like openFrozen, with the dialog put away and the snapshot taken at the stopped clock. */
async function openP2(page: Page, query = ''): Promise<Awaited<ReturnType<typeof open>>> {
  const found = await openFrozen(page, query);
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await resync(page);
  return found;
}

/** Fourteen days fit on the first page of the p2 seed; older ones only if the button is there. */
async function showAll(page: Page): Promise<void> {
  const more = page.getByRole('button', { name: /^Show older/ });
  while (await more.isVisible()) await more.click();
}

/** The seeded gaps' ids, so a test can plant more on the same running segment. */
const plantGap = (page: Page, id: string, start: string, end: string): Promise<void> =>
  page.evaluate(
    ([gid, s, e]) => {
      const seg = window.__mock.segments.find((x) => x.taskId === 't-logo' && x.end === null);
      if (!seg || gid === undefined || s === undefined || e === undefined) throw new Error('no running segment');
      window.__mock.gaps.push({ id: gid, segmentId: seg.id, taskId: 't-logo', deviceId: seg.deviceId, start: s, end: e, kind: 'sleep', decision: 'pending', decisionStamp: { at: e, by: seg.deviceId } });
    },
    [id, start, end],
  );

test.describe('time away: the dialog on return', () => {
  test('lists each pending stretch with task, times, length and kind, and says it counts nowhere', async ({ page }) => {
    const found = await openFrozen(page);
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByText(UNCONFIRMED)).toBeVisible();
    const rows = d.getByTestId('away-gap');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Logo concepts');
    await expect(rows.first()).toContainText('14:20–14:50 Lisbon time, 30m away');
    await expect(rows.first().getByText('Idle', { exact: true })).toBeVisible();
    await expect(d.getByRole('button', { name: /^Keep: Logo concepts/ })).toBeVisible();
    await expect(d.getByRole('button', { name: /^Drop: Logo concepts/ })).toBeVisible();
    await expect(d.getByRole('button', { name: /^Mark as thinking: Logo concepts/ })).toBeVisible();
    // One stretch: no "apply to all".
    await expect(d.getByRole('group', { name: /Apply one answer to all/ })).toHaveCount(0);
    await expectClean(page, found);
  });

  test('traps focus, Escape dismisses, and focus returns to what opened it', async ({ page }) => {
    const found = await openP2(page);
    await banner(page).getByRole('button', { name: 'Review time away' }).focus();
    await page.keyboard.press('Enter');
    const d = dialog(page);
    await expect(d).toBeVisible();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(banner(page).getByRole('button', { name: 'Review time away' })).toBeFocused();
    await expectClean(page, found);
  });

  test('dismissing leaves a banner and the totals say the time is unconfirmed and not counted', async ({ page }) => {
    const found = await openP2(page);
    await expect(banner(page)).toContainText(UNCONFIRMED);
    await expect(banner(page)).toContainText('30m of time away on Logo concepts');
    // Nothing of the 30 minutes is counted: 175 min exact, 210 billable (with the 30-minute pause).
    await expect(today(page).getByTestId('day-exact')).toContainText('2h 55m');
    await expect(today(page).getByTestId('day-billable')).toContainText('3h 30m');
    await expect(today(page).getByTestId('day-unconfirmed')).toContainText(UNCONFIRMED);
    await expect(today(page).getByTestId('day-unconfirmed')).toContainText('30m');
    await banner(page).getByRole('button', { name: 'Review time away' }).click();
    await expect(dialog(page)).toBeVisible();
    await expectClean(page, found);
  });

  test('Keep counts it as work: Exact and Billable both rise by 30 minutes', async ({ page }) => {
    const found = await openFrozen(page);
    await dialog(page).getByRole('button', { name: /^Keep: Logo concepts/ }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(banner(page)).toHaveCount(0);
    await expect(today(page).getByTestId('day-exact')).toContainText('3h 25m');
    await expect(today(page).getByTestId('day-exact')).toContainText('$307.50');
    await expect(today(page).getByTestId('day-billable')).toContainText('4h 00m');
    await expect(today(page).getByTestId('day-billable')).toContainText('$360.00');
    await expect(today(page).getByTestId('day-unconfirmed')).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.gaps.find((g) => g.id === 'gap-pending')?.decision)).toBe('keep');
    await expectClean(page, found);
  });

  test('Drop removes it: totals stay, and the stretch shows as Dropped', async ({ page }) => {
    const found = await openFrozen(page);
    await dialog(page).getByRole('button', { name: /^Drop: Logo concepts/ }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(banner(page)).toHaveCount(0);
    await expect(today(page).getByTestId('day-exact')).toContainText('2h 55m');
    await expect(today(page).getByTestId('day-billable')).toContainText('3h 30m');
    await expect(today(page).locator('[data-testid="entry"][data-kind="dropped"]')).toHaveCount(1);
    await expect(today(page).locator('[data-testid="entry"][data-kind="pending"]')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('Mark as thinking counts in Exact and Billable and is reported as thinking time', async ({ page }) => {
    const found = await openFrozen(page);
    await dialog(page).getByRole('button', { name: /^Mark as thinking: Logo concepts/ }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(today(page).getByTestId('day-exact')).toContainText('3h 25m');
    await expect(today(page).getByTestId('day-billable')).toContainText('4h 00m');
    await expect(today(page).getByTestId('day-thinking')).toContainText('includes 30m thinking');
    await expect(today(page).locator('[data-testid="entry"][data-kind="thinking"]')).toHaveCount(1);
    await expectClean(page, found);
  });

  test('several stretches: Apply to all answers every one, and only new ids reopen the dialog', async ({ page }) => {
    const found = await openP2(page);
    await plantGap(page, 'gap-two', '2026-03-12T14:55:00Z', '2026-03-12T15:05:00Z');
    await resync(page);
    // A pending id the dialog never asked about opens it again.
    const d = dialog(page);
    await expect(d).toBeVisible();
    await expect(d.getByTestId('away-gap')).toHaveCount(2);
    await expect(d.getByText('Sleep', { exact: true })).toBeVisible();
    await expect(banner(page)).toContainText('40m of time away');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    // The same ids again do not.
    await resync(page);
    await expect(d).toBeHidden();
    await banner(page).getByRole('button', { name: 'Review time away' }).click();
    await d.getByRole('button', { name: 'Drop all' }).click();
    await expect(d).toBeHidden();
    await expect(banner(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.gaps.filter((g) => g.decision === 'drop').map((g) => g.id).sort())).toEqual(['gap-drop', 'gap-pending', 'gap-two']);
    // The 30m pending and the 10m second stretch are both gone from the running segment: 175 - 10 = 165 min.
    await expect(today(page).getByTestId('day-exact')).toContainText('2h 45m');
    await expectClean(page, found);
  });

  test('a refused answer is shown in the dialog and nothing is lost', async ({ page }) => {
    const found = await openFrozen(page);
    await page.evaluate(() => {
      window.__mock.failNext = ['decide_gap'];
    });
    await dialog(page).getByRole('button', { name: /^Keep: Logo concepts/ }).click();
    await expect(dialog(page).getByRole('alert')).toContainText('mock: decide_gap failed');
    await expect(dialog(page).getByTestId('away-gap')).toHaveCount(1);
    await dialog(page).getByRole('button', { name: /^Keep: Logo concepts/ }).click();
    await expect(dialog(page)).toBeHidden();
    await expectClean(page, found);
  });
});

test.describe('billable pauses on the timeline', () => {
  test('a pause is in Billable and in earnings, never in Exact', async ({ page }) => {
    const found = await openP2(page);
    const t = today(page);
    await expect(t.getByTestId('day-pause')).toContainText('includes 30m billable pauses');
    // Exact 2h 55m = $262.50 at $90/h; Billable 3h 30m = $315.00: the pause (30m) and the 15-minute rounding.
    await expect(t.getByTestId('day-exact')).toContainText('2h 55m');
    await expect(t.getByTestId('day-exact')).toContainText('$262.50');
    await expect(t.getByTestId('day-billable')).toContainText('3h 30m');
    await expect(t.getByTestId('day-billable')).toContainText('$315.00');
    const row = t.locator('[data-testid="entry"][data-kind="billablePause"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('10:45');
    await expect(row).toContainText('Billable pause');
    await expect(row).toContainText('Waiting on the client call');
    await expect(row).toContainText('$45.00');
    await expect(row).toContainText('30m');
    await expectClean(page, found);
  });

  test('the Today and This week lines say what the pause adds', async ({ page }) => {
    const found = await openP2(page);
    await expect(page.getByTestId('summary-today')).toContainText('includes 30m billable pauses');
    await expect(page.getByTestId('summary-this')).toContainText('includes 30m billable pauses');
    await expectClean(page, found);
  });

  test('Hide earnings masks the pause and the fixed fee', async ({ page }) => {
    const found = await openP2(page, '&hide=1');
    const row = today(page).locator('[data-testid="entry"][data-kind="billablePause"]');
    await expect(row).not.toContainText('$');
    await expect(today(page).getByTestId('day-billable')).not.toContainText('$');
    await showAll(page);
    const fee = page.getByTestId('fixed-fee').first();
    await expect(fee).toContainText('Fixed fee');
    await expect(fee).not.toContainText('€');
    await expectClean(page, found);
  });
});

test.describe('timeline marks', () => {
  test('each kind of time looks different and says what it is in words', async ({ page }) => {
    const found = await openP2(page);
    const kinds = async (c: Locator): Promise<string[]> => c.locator('[data-testid="block"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind') ?? ''));
    expect(await kinds(today(page))).toEqual(expect.arrayContaining(['work', 'billablePause', 'pending']));
    const pending = today(page).locator('[data-testid="block"][data-kind="pending"]');
    await expect(pending).toHaveAttribute('aria-label', /unconfirmed time away, not counted until you confirm/);
    await expect(today(page).locator('[data-testid="block"][data-kind="billablePause"]')).toHaveAttribute('aria-label', /billable pause, billed but not worked/);
    // The patterns differ, not only the colours: border style and fill pattern tell the kinds apart.
    const look = (kind: string, extra = ''): Promise<string> =>
      today(page).locator(`[data-testid="block"][data-kind="${kind}"]${extra}`).first().evaluate((e) => `${getComputedStyle(e).borderTopStyle}|${getComputedStyle(e).borderTopWidth}|${getComputedStyle(e).backgroundImage}`);
    const looks = [await look('work', ':not([data-live])'), await look('billablePause'), await look('pending')];
    expect(new Set(looks).size).toBe(3);

    await showAll(page);
    const ten = card(page, 'Tue 10 Mar 2026');
    await expect(ten.locator('[data-testid="block"][data-kind="thinking"]')).toHaveCount(1);
    await expect(ten.locator('[data-testid="block"][data-kind="dropped"]')).toHaveCount(1);
    await expect(ten.getByTestId('day-thinking')).toContainText('includes 25m thinking');
    await expect(ten.locator('[data-testid="entry"][data-kind="dropped"]')).toContainText('Dropped: removed from your time');
    await expectClean(page, found);
  });

  test('the legend names every kind', async ({ page }) => {
    const found = await openP2(page);
    const legend = page.getByTestId('timeline-legend');
    for (const word of ['Work', 'Thinking', 'Billable pause', 'Unconfirmed', 'Dropped', 'Corrected', 'Added by hand']) await expect(legend.getByText(word, { exact: true })).toBeVisible();
    await expectClean(page, found);
  });

  test('corrected and hand-entered time keep the raw time in view', async ({ page }) => {
    const found = await openP2(page);
    await showAll(page);
    const nine = card(page, 'Mon 9 Mar 2026');
    await expect(nine.locator('[data-testid="block"][data-mark="corrected"]')).toHaveCount(1);
    await expect(nine.getByText('Recorded 09:00 to 11:20, corrected to 09:00 to 11:05.', { exact: false })).toBeVisible();
    await expect(nine.getByText('Stopped at 11:05, the timer ran on', { exact: false })).toBeVisible();
    const eleven = card(page, 'Wed 11 Mar 2026');
    await expect(eleven.locator('[data-testid="block"][data-mark="manual"]')).toHaveCount(1);
    await expect(eleven.getByText('Added by hand, 16:45 to 17:15.', { exact: false })).toBeVisible();
    // The backend's raw view carries no reason for hand-entered time; it is in the history of changes.
    await expect(eleven.getByText('The reason is in the history of changes.')).toBeVisible();
    await expectClean(page, found);
  });

  test('voided time is listed apart and counts nowhere', async ({ page }) => {
    const found = await openP2(page);
    const before = await today(page).getByTestId('day-exact').textContent();
    await page.evaluate(() => {
      const seg = window.__mock.segments.find((x) => x.taskId === 't-logo' && x.start === '2026-03-12T09:05:00Z');
      if (!seg) throw new Error('segment');
      seg.edit = { start: seg.start, end: seg.end ?? seg.start, voided: true, reason: 'Entered on the wrong task' };
    });
    await resync(page);
    const voided = today(page).getByTestId('voided');
    await expect(voided).toContainText('Logo concepts');
    await expect(voided).toContainText('recorded 09:05 to 10:30, voided and not counted');
    await expect(voided).toContainText('Entered on the wrong task');
    expect(await today(page).getByTestId('day-exact').textContent()).not.toBe(before);
    await expectClean(page, found);
  });

  test('a fixed-fee project says Fixed fee with the fee, not "No rate set"', async ({ page }) => {
    const found = await openP2(page);
    await showAll(page);
    const row = card(page, 'Wed 4 Mar 2026').locator('.proj-totals li', { hasText: 'Print run (fixed fee)' });
    await expect(row.getByTestId('fixed-fee')).toContainText('Fixed fee €1,000.00');
    await expect(row).not.toContainText('No rate set');
    await expectClean(page, found);
  });
});

test.describe('reminders', () => {
  test('a long run shows a banner with Pause and Keep running 1 h', async ({ page }) => {
    const found = await openP2(page);
    await expect(page.getByTestId('reminder-banner')).toHaveCount(0);
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Settings' }).getByRole('region', { name: 'Time away and reminders' });
    const field = section.getByLabel('Remind me when a task has run for (minutes)');
    await expect(field).toHaveValue('240');
    await field.fill('60');
    await section.getByRole('button', { name: 'Save' }).nth(1).click();
    const r = page.getByTestId('reminder-banner');
    await expect(r).toContainText('Logo concepts');
    await expect(r).toContainText('Running for 1 h 20 min since 14:00');
    await r.getByRole('button', { name: 'Keep running 1 h' }).click();
    await expect(r).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.reminderQuietUntil)).toBeGreaterThan(await page.evaluate(() => window.__mock.now));
    await expectClean(page, found);
  });

  test('running past the end of a shift names the shift, and Pause pauses that task', async ({ page }) => {
    const found = await openP2(page);
    await page.evaluate(() => {
      window.__mock.reminderOverride = { kind: 'pastShift', taskId: 't-logo', shift: 'Morning', ended: '2026-03-12T13:00:00Z' };
    });
    await resync(page);
    const r = page.getByTestId('reminder-banner');
    await expect(r).toContainText('Past the end of your Morning shift (13:00)');
    await r.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(r).toHaveCount(0);
    await expect(card(page, 'Logo concepts').getByText('Paused', { exact: true })).toBeVisible();
    await expectClean(page, found);
  });

  test('the settings check whole minutes and show the backend refusal', async ({ page }) => {
    const found = await openP2(page);
    await tab(page, 'Settings');
    const section = page.getByRole('region', { name: 'Settings' }).getByRole('region', { name: 'Time away and reminders' });
    await expect(section).toContainText('The app sends the system notification itself');
    const idle = section.getByLabel('Treat no activity as time away after (minutes)');
    await expect(idle).toHaveValue('10');
    for (const bad of ['abc', '-5', '1.5', '10081', '']) {
      await idle.fill(bad);
      await section.getByRole('button', { name: 'Save' }).first().click();
      await expect(section.getByRole('alert').first()).toContainText('Enter whole minutes from 0 to 10080');
    }
    expect(await page.evaluate(() => window.__mock.calls.filter((c) => c.cmd === 'set_setting').length)).toBe(0);
    await idle.fill('0');
    await section.getByRole('button', { name: 'Save' }).first().click();
    await expect(section.getByTestId('current-idleMinutes')).toContainText('Now: Off');
    await idle.fill('25');
    await page.evaluate(() => {
      window.__mock.failNext = ['set_setting'];
    });
    await section.getByRole('button', { name: 'Save' }).first().click();
    await expect(section.getByRole('alert').first()).toContainText('mock: set_setting failed');
    await section.getByRole('button', { name: 'Save' }).first().click();
    await expect(section.getByTestId('current-idleMinutes')).toContainText('Now: 25 minutes');
    const past = section.getByRole('switch', { name: /past the end of my shift/ });
    await expect(past).toBeChecked();
    await past.uncheck();
    await expect(past).not.toBeChecked();
    expect(await page.evaluate(() => window.__mock.settings.remindPastShift)).toBe(false);
    await expectClean(page, found);
  });
});

test.describe('backups', () => {
  const section = (page: Page): Locator => page.getByRole('region', { name: 'Settings' }).getByRole('region', { name: 'Backups' });

  test('lists the backups, marks safety copies and sets how many to keep', async ({ page }) => {
    const found = await openP2(page);
    await tab(page, 'Settings');
    const s = section(page);
    await expect(s).toContainText('Backups are separate from sync');
    await expect(s).toContainText('never leave this computer');
    const rows = s.getByTestId('backup-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('z-work-data-2026-03-12.json');
    await expect(rows.nth(0)).toContainText('47 KB');
    await expect(rows.nth(0).getByText('Safety copy')).toHaveCount(0);
    await expect(rows.nth(2)).toContainText('pre-restore-2026-03-05T10-00-00.json');
    await expect(rows.nth(2).getByText('Safety copy')).toBeVisible();
    await expect(s.getByTestId('backup-keep-now')).toContainText('Now: 30');
    const keep = s.getByLabel('Daily backups to keep');
    for (const bad of ['0', '366', 'x', '2.5']) {
      await keep.fill(bad);
      await s.getByRole('button', { name: 'Save' }).click();
      await expect(s.getByRole('alert')).toContainText('Enter a whole number from 1 to 365.');
    }
    await keep.fill('20');
    await s.getByRole('button', { name: 'Save' }).click();
    await expect(s.getByTestId('backup-keep-now')).toContainText('Now: 20');
    expect(await page.evaluate(() => window.__mock.backupKeep)).toBe(20);
    await expectClean(page, found);
  });

  test('restore asks first, states what happens, then pauses the task and goes cold', async ({ page }) => {
    const found = await openP2(page);
    await tab(page, 'Settings');
    const s = section(page);
    await s.getByRole('button', { name: 'Restore z-work-data-2026-03-11.json' }).click();
    const confirm = page.getByRole('dialog', { name: 'Restore this backup?' });
    await expect(confirm).toContainText('A safety copy of the current data is made first');
    await expect(confirm).toContainText('A running task is paused');
    await expect(confirm).toContainText('The next start asks for every field');
    await expect(confirm).toContainText('With sync on, newer records in your sync folders merge back in at the next sync');
    await expect(confirm).toContainText('separate from sync and stay on this computer');
    // Nothing happens until the button is pressed; Cancel changes nothing.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => window.__mock.calls.filter((c) => c.cmd === 'restore_backup').length)).toBe(0);
    await s.getByRole('button', { name: 'Restore z-work-data-2026-03-11.json' }).click();
    await confirm.getByRole('button', { name: 'Restore this backup' }).click();
    await expect(s.getByTestId('backup-result')).toContainText('Restored z-work-data-2026-03-11.json');
    await expect(page.getByTestId('notice').first()).toContainText('Restored z-work-data-2026-03-11.json');
    // A new safety copy of the data from just before is now in the list, newest first.
    await expect(s.getByTestId('backup-row')).toHaveCount(4);
    await expect(s.getByTestId('backup-row').first()).toContainText('pre-restore-');
    await expect(s.getByTestId('backup-row').first().getByText('Safety copy')).toBeVisible();
    const after = await page.evaluate(() => ({ warm: window.__mock.warm, running: window.__mock.tasks.filter((t) => t.state === 'running').length }));
    expect(after).toEqual({ warm: false, running: 0 });
    // The next start asks for every field: a new task form copies nothing and Start waits for them.
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    await expect(form.getByRole('textbox', { name: 'Task name' })).toHaveValue('');
    await expect(form.getByTestId('copy-note')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
    await expectClean(page, found);
  });

  test('a failed restore says why and changes nothing', async ({ page }) => {
    const found = await openP2(page);
    await tab(page, 'Settings');
    const s = section(page);
    await page.evaluate(() => {
      window.__mock.failNext = ['restore_backup'];
    });
    await s.getByRole('button', { name: 'Restore z-work-data-2026-03-12.json' }).click();
    await page.getByRole('dialog', { name: 'Restore this backup?' }).getByRole('button', { name: 'Restore this backup' }).click();
    await expect(s.getByTestId('backup-result')).toContainText('Could not restore z-work-data-2026-03-12.json: mock: restore_backup failed');
    expect(await page.evaluate(() => window.__mock.warm)).toBe(true);
    await expectClean(page, found);
  });
});

test.describe('history of changes', () => {
  const section = (page: Page): Locator => page.getByRole('region', { name: 'Settings' }).getByRole('region', { name: 'History of changes' });

  test('lists the log newest first in plain words and filters by kind', async ({ page }) => {
    const found = await openP2(page);
    await tab(page, 'Settings');
    const s = section(page);
    const entries = s.getByTestId('audit-entry');
    await expect(entries.first()).toBeVisible();
    const all = await entries.count();
    expect(all).toBeGreaterThanOrEqual(6);
    await expect(s.getByTestId('audit-count')).toContainText(`${all} entries, newest first`);
    // Times come out newest first.
    const whens = await entries.locator('.tabular').first().evaluateAll((e) => e.map((n) => n.textContent ?? ''));
    expect(whens.length).toBe(1);
    const stamps = await s.locator('.audit-head .tabular').allTextContents();
    expect(stamps).toEqual([...stamps].sort().reverse());
    await expect(s.getByText('Time entry corrected', { exact: false }).first()).toBeVisible();
    await expect(s.getByText('Reason: Stopped at 11:05, the timer ran on')).toBeVisible();
    await expect(s.getByText('Before: recorded 2026-03-09 09:00 to 11:20. After: 2026-03-09 09:00 to 11:05 (recorded 2026-03-09 09:00 to 11:20).')).toBeVisible();
    await expect(s.getByText('Billing summary created').first()).toBeVisible();
    await expect(s.getByText('Billable pause marked billable')).toBeVisible();
    await s.getByLabel('Show').selectOption('summary');
    const filtered = await entries.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThan(all);
    expect(await entries.evaluateAll((els) => els.every((e) => e.getAttribute('data-entity') === 'summary'))).toBe(true);
    await expectClean(page, found);
  });

  test('Load brings in what happened since, and a failure is shown', async ({ page }) => {
    const found = await openFrozen(page);
    await dialog(page).getByRole('button', { name: /^Drop: Logo concepts/ }).click();
    await tab(page, 'Settings');
    const s = section(page);
    await expect(s.getByText('Time away answered').first()).toBeVisible();
    await expect(s.getByText('Before: waiting for an answer. After: dropped.').first()).toBeVisible();
    await page.evaluate(() => {
      window.__mock.failNext = ['get_audit'];
    });
    await s.getByRole('button', { name: 'Load' }).click();
    await expect(s.getByRole('alert')).toContainText('Could not load the history: mock: get_audit failed');
    await s.getByRole('button', { name: 'Load' }).click();
    await expect(s.getByRole('alert')).toHaveCount(0);
    await expect(s.getByTestId('audit-entry').first()).toBeVisible();
    await expectClean(page, found);
  });

  test('an empty log says so', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await tab(page, 'Settings');
    await expect(section(page).getByTestId('audit-empty')).toContainText('Nothing has been recorded yet');
    await expectClean(page, found);
  });
});

test.describe('screenshots', () => {
  for (const [theme, slug] of THEMES) {
    test(`time away dialog, ${slug}`, async ({ page }) => {
      await open(page, `seed=p2&away=show&theme=${theme}`);
      await expect(dialog(page)).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `timeaway-dialog-${slug}.png`) });
    });
  }

  test('banner, timeline and reminder', async ({ page }) => {
    await openP2(page);
    await page.screenshot({ path: path.join(SHOTS, 'timeaway-banner.png'), clip: { x: 0, y: 0, width: 1360, height: 260 } });
    await showAll(page);
    // The app scrolls inside its own panel, so the timeline is shot card by card.
    await today(page).scrollIntoViewIfNeeded();
    await page.getByTestId('timeline-legend').screenshot({ path: path.join(SHOTS, 'timeline-p2-legend.png') });
    for (const [day, slug] of [['Thu 12 Mar 2026', '12'], ['Tue 10 Mar 2026', '10'], ['Mon 9 Mar 2026', '9'], ['Wed 11 Mar 2026', '11']] as const) {
      await card(page, day).screenshot({ path: path.join(SHOTS, `timeline-p2-${slug}-mar.png`) });
    }
    await page.evaluate(() => {
      window.__mock.reminderOverride = { kind: 'pastShift', taskId: 't-logo', shift: 'Morning', ended: '2026-03-12T13:00:00Z' };
    });
    await resync(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(SHOTS, 'reminder-banner.png'), clip: { x: 0, y: 0, width: 1360, height: 260 } });
  });

  test('settings sections', async ({ page }) => {
    await openP2(page);
    await tab(page, 'Settings');
    const region = page.getByRole('region', { name: 'Settings' });
    await region.getByRole('region', { name: 'Time away and reminders' }).screenshot({ path: path.join(SHOTS, 'settings-reminders.png') });
    const backups = region.getByRole('region', { name: 'Backups' });
    await expect(backups.getByTestId('backup-row')).toHaveCount(3);
    await backups.screenshot({ path: path.join(SHOTS, 'settings-backups.png') });
    await backups.getByRole('button', { name: 'Restore z-work-data-2026-03-11.json' }).click();
    await page.screenshot({ path: path.join(SHOTS, 'settings-restore-confirm.png') });
    await page.keyboard.press('Escape');
    const audit = region.getByRole('region', { name: 'History of changes' });
    await expect(audit.getByTestId('audit-entry').first()).toBeVisible();
    await audit.screenshot({ path: path.join(SHOTS, 'settings-audit.png') });
  });
});
