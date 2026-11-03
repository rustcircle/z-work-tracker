import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, card, expectClean, open, tab } from './support';

// Who may change the data, in a real browser under the production CSP, against the IPC mock: the banner for each lease state, the
// take over dialog with its two questions, and what the page does with what the backend answers. ?lease=live is another computer
// (LAPTOP) that was last heard from 90 seconds ago, ?lease=stale the same 40 minutes ago, ?lease=unknown no folder can be read after
// LAPTOP held it two hours ago. ?seed=demo: Logo concepts is running here, Brand guidelines is paused, Social templates is a draft.

const banner = (page: Page): Locator => page.getByTestId('lease-banner');
const words = (page: Page): Locator => page.getByTestId('lease-text');
const sent = (page: Page, cmd: string): Promise<unknown[]> => page.evaluate((c) => window.__mock.calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);
const firstQuestion = (page: Page, title = 'Take over from LAPTOP?'): Locator => page.getByRole('dialog', { name: title });
const secondQuestion = (page: Page): Locator => page.getByRole('dialog', { name: 'Are you sure?' });

test.describe('another computer holds it and looks in use (?lease=live)', () => {
  // Take over is offered once the other computer looks inactive (15 minutes without a sign), so the page has none for one in use. The
  // way past one in use is to ask it to pause, or to quit it or press Release now there. Taking over a live holder (D2 on) is covered by the
  // component tests with `offerToLive`, and by the core tests, as this bundle is the one that ships.
  test('shows the banner with Check again only, and keeps Start off', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=live');

    await expect(banner(page)).toBeVisible();
    await expect(words(page)).toHaveText("Read-only. LAPTOP is using zWorkTracker (last seen 1 min ago). You can look at everything here. Changes are off so the two computers don't overlap.");
    await expect(banner(page).getByRole('button')).toHaveText(['Check again']);
    await expect(banner(page).getByRole('button', { name: 'Take over…' })).toHaveCount(0);
    // The page shows early what the backend would refuse.
    await expect(card(page, 'Social templates').getByRole('button', { name: 'Start' })).toBeDisabled();
    await expect(card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' })).toBeDisabled();
    await expectClean(page, found);
  });

  test('offers Take over once the other computer has said nothing for 15 minutes', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=live');
    await expect(banner(page).getByRole('button')).toHaveText(['Check again']);
    await page.evaluate(() => {
      const m = window.__mock;
      if (m.lease.holder) m.lease = { ...m.lease, state: 'heldByOtherStale', holder: { ...m.lease.holder, lastSignAt: `${new Date((m.now - 20 * 60) * 1000).toISOString().slice(0, 19)}Z` } };
      void window.__mockEmit('state-changed');
    });
    await expect(words(page)).toContainText('LAPTOP looks inactive: nothing from it for 20 min.');
    await expect(banner(page).getByRole('button')).toHaveText(['Check again', 'Take over…']);
    await expectClean(page, found);
  });

  test('stays on every tab', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=live');
    for (const name of ['Analysis', 'Billing', 'Projects', 'Settings', 'Timeline']) {
      await tab(page, name);
      await expect(banner(page)).toBeVisible();
    }
    await expectClean(page, found);
  });

  test('a holder that was heard from again while the dialog was open sends the person back to the first question, with nothing taken over and nothing more to go on to', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');
    await banner(page).getByRole('button', { name: 'Take over…' }).click();
    await firstQuestion(page).getByRole('button', { name: 'Continue' }).click();
    await page.evaluate(() => {
      window.__mock.takeOverNext = 'changed';
    });
    await secondQuestion(page).getByRole('button', { name: 'Take over' }).click();

    const again = firstQuestion(page);
    await expect(again).toBeVisible();
    await expect(again.getByTestId('takeover-changed')).toHaveText('Nothing was taken over. Things changed while this was open, so here is how it stands now.');
    await expect(again).toContainText("It looks like it's still in use. Take over is offered once it looks inactive.");
    await expect(again.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(again.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByOtherLive');
    await expect(words(page)).toContainText('LAPTOP is using zWorkTracker');
    await expect(banner(page).getByRole('button', { name: 'Take over…' })).toHaveCount(0);

    await again.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sent(page, 'lease_take_over')).toEqual([{ expected: { generation: 4, beatSeq: 83 }, mode: 'stale' }]);
    await expectClean(page, found);
  });
});

test.describe('another computer holds it and looks inactive (?lease=stale)', () => {
  test('takes over through both questions and is then writable', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');

    await expect(banner(page)).toBeVisible();
    // The page shows early what the backend would refuse.
    await expect(card(page, 'Social templates').getByRole('button', { name: 'Start' })).toBeDisabled();
    await expect(card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' })).toBeDisabled();

    await banner(page).getByRole('button', { name: 'Take over…' }).click();
    const first = firstQuestion(page);
    await expect(first).toBeVisible();
    await expect(first.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(first).toContainText(/Last sign of LAPTOP: 4\d min ago \(14:40\)\./);
    await expect(first).toContainText("It looks inactive, but this can simply mean its cloud app hasn't synced yet.");
    await expect(first).not.toContainText('still in use');
    expect(await sent(page, 'lease_take_over')).toEqual([]);

    await first.getByRole('button', { name: 'Continue' }).click();
    const second = secondQuestion(page);
    await expect(second).toBeVisible();
    await expect(second.getByRole('button', { name: 'Back' })).toBeFocused();
    await expect(second).toContainText("After this, LAPTOP becomes read-only as soon as it hears about it. That can take a few minutes, and if it's offline, until it reconnects. Until then both computers could make changes. They merge; nothing is deleted.");
    expect(await sent(page, 'lease_take_over')).toEqual([]);

    await second.getByRole('button', { name: 'Take over' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
    expect(await sent(page, 'lease_take_over')).toEqual([{ expected: { generation: 4, beatSeq: 83 }, mode: 'stale' }]);
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByMe');
    await expect(page.getByTestId('notice').filter({ hasText: 'You took over from LAPTOP.' })).toBeVisible();

    // Writable now: the same controls work.
    await expect(card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' })).toBeEnabled();
    await card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' }).click();
    await expect(card(page, 'Brand guidelines').getByText('Running', { exact: true })).toBeVisible();
    await expectClean(page, found);
  });

  test('a newer record of the same inactive holder sends the person back to the first question, and the take over then goes through for it', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');
    await banner(page).getByRole('button', { name: 'Take over…' }).click();
    await firstQuestion(page).getByRole('button', { name: 'Continue' }).click();
    // Its cloud app delivers a newer record of LAPTOP's, and it is still an old one: the beat moves on, and the holder still looks inactive.
    await page.evaluate(() => {
      const m = window.__mock;
      if (m.lease.holder) m.lease = { ...m.lease, holder: { ...m.lease.holder, beatSeq: m.lease.holder.beatSeq + 1 } };
    });
    await secondQuestion(page).getByRole('button', { name: 'Take over' }).click();

    const again = firstQuestion(page);
    await expect(again).toBeVisible();
    await expect(again.getByTestId('takeover-changed')).toHaveText('Nothing was taken over. Things changed while this was open, so here is how it stands now.');
    await expect(again).toContainText("It looks inactive, but this can simply mean its cloud app hasn't synced yet.");
    await expect(again.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByOtherStale');

    await again.getByRole('button', { name: 'Continue' }).click();
    await secondQuestion(page).getByRole('button', { name: 'Take over' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sent(page, 'lease_take_over')).toEqual([
      { expected: { generation: 4, beatSeq: 83 }, mode: 'stale' },
      { expected: { generation: 4, beatSeq: 84 }, mode: 'stale' },
    ]);
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByMe');
    await expectClean(page, found);
  });

  test('says how long, that its cloud app may simply not have synced, and backs out without sending anything', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');

    await expect(words(page)).toHaveText('Read-only. LAPTOP looks inactive: nothing from it for 40 min. It may be off, or its cloud app may simply not have synced yet.');
    await expect(banner(page).getByRole('button')).toHaveText(['Check again', 'Take over…']);

    await banner(page).getByRole('button', { name: 'Take over…' }).click();
    const first = firstQuestion(page);
    await expect(first).toContainText(/Last sign of LAPTOP: 4\d min ago \(14:40\)\./);
    await expect(first).toContainText("It looks inactive, but this can simply mean its cloud app hasn't synced yet.");
    await expect(first).not.toContainText('still in use');
    await expect(first.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(banner(page).getByRole('button', { name: 'Take over…' })).toBeFocused();
    expect(await sent(page, 'lease_take_over')).toEqual([]);
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByOtherStale');
    await expectClean(page, found);
  });

  test('names the running task that would be closed, and when', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');
    await page.evaluate(() => {
      const m = window.__mock;
      const mail = m.tasks.find((t) => t.id === 't-mail');
      if (mail) {
        mail.state = 'running';
        mail.pauseReason = null;
        mail.runningElsewhere = 'LAPTOP';
      }
      m.segments.push({ id: 'seg-laptop', taskId: 't-mail', deviceId: '22222222-2222-4222-8222-222222222222', start: '2026-03-12T12:20:00Z', end: null, provisionalEnd: '2026-03-12T14:50:00Z' });
    });
    await banner(page).getByRole('button', { name: 'Take over…' }).click();
    await expect(firstQuestion(page)).toContainText(
      '"Email and invoices" is shown as running there. It will close at 14:50, the last moment that computer is known to have been running. That is written in the audit trail. If LAPTOP really kept working, its time comes back when it next syncs.',
    );
    await firstQuestion(page).getByRole('button', { name: 'Continue' }).click();
    await secondQuestion(page).getByRole('button', { name: 'Take over' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('notice').filter({ hasText: 'You took over from LAPTOP. 1 running task was closed at its last known time.' })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.segments.find((s) => s.id === 'seg-laptop')?.edit?.end)).toBe('2026-03-12T14:50:00Z');
    await expectClean(page, found);
  });

  test('the whole thing can be done from the keyboard, one deliberate key at a time', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');
    await banner(page).getByRole('button', { name: 'Take over…' }).focus();
    await page.keyboard.press('Enter');
    const first = firstQuestion(page);
    await expect(first.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(first.getByRole('button', { name: 'Continue' })).toBeFocused();
    await page.keyboard.press('Enter');
    const second = secondQuestion(page);
    await expect(second.getByRole('button', { name: 'Back' })).toBeFocused();
    expect(await sent(page, 'lease_take_over')).toEqual([]);
    await page.keyboard.press('Tab');
    await expect(second.getByRole('button', { name: 'Take over' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sent(page, 'lease_take_over')).toHaveLength(1);
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByMe');
    await expectClean(page, found);
  });

  test('Check again follows what the folders say now', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=stale');
    await page.evaluate(() => {
      window.__mock.lease = { ...window.__mock.lease, state: 'free', readOnly: false, holder: null };
    });
    await banner(page).getByRole('button', { name: 'Check again' }).click();
    await expect(banner(page)).toHaveCount(0);
    expect(await sent(page, 'sync_now')).toHaveLength(1);
    await expect(card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' })).toBeEnabled();
    await expectClean(page, found);
  });
});

test.describe('no folder can be read (?lease=unknown)', () => {
  test('says so, offers to work here anyway in other words, and then lets this computer write while it cannot check', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=unknown');

    await expect(words(page)).toHaveText("Read-only. The sync folder can't be reached, and LAPTOP was last using zWorkTracker 2 h ago.");
    await expect(banner(page).getByRole('button')).toHaveText(['Check again', 'Work here anyway…']);
    await expect(card(page, 'Social templates').getByRole('button', { name: 'Start' })).toBeDisabled();

    await banner(page).getByRole('button', { name: 'Work here anyway…' }).click();
    const first = firstQuestion(page, 'Work here anyway?');
    await expect(first).toBeVisible();
    await expect(first.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(first).toContainText("The sync folder can't be reached, so this computer can't tell whether LAPTOP is still using zWorkTracker.");
    await expect(first).toContainText(/Last sign of LAPTOP: 2 h ago \(13:20\)\./);
    await expect(first).toContainText('If you go on, this computer can make changes now, without waiting for the folder.');
    await first.getByRole('button', { name: 'Continue' }).click();

    const second = secondQuestion(page);
    await expect(second).toContainText(
      'Until the folder can be reached, LAPTOP may be making changes too. They merge; nothing is deleted. Once the folder is back, this computer takes over from LAPTOP, and anything LAPTOP left running is closed at its last known time. If another computer took over in the meantime, this one goes back to read-only. What you did here is kept and will merge.',
    );
    expect(await sent(page, 'lease_take_over')).toEqual([]);
    await second.getByRole('button', { name: 'Work here anyway' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sent(page, 'lease_take_over')).toEqual([{ expected: { generation: 4, beatSeq: 0 }, mode: 'offline' }]);

    // Writable, and still honest that nothing can be checked.
    await expect(words(page)).toHaveText("The sync folder can't be reached, so this computer can't check whether another one is in use. You can keep working. Everything merges when the folder is back.");
    await expect(banner(page).getByRole('button')).toHaveCount(0);
    await expect(card(page, 'Brand guidelines').getByRole('button', { name: 'Resume' })).toBeEnabled();

    // The folder comes back: this computer holds the lease, and there is nothing more to say.
    await page.evaluate(() => {
      const m = window.__mock;
      for (const t of m.targets) m.folders[t.root] = { ...(m.folders[t.root] ?? { devices: [], counts: { projects: 0, tasks: 0, segments: 0 } }), available: true };
      void window.__mockEmit('state-changed');
    });
    await expect(banner(page)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('nothing is sent when the person backs out', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=unknown');
    await banner(page).getByRole('button', { name: 'Work here anyway…' }).click();
    await firstQuestion(page, 'Work here anyway?').getByRole('button', { name: 'Continue' }).click();
    await secondQuestion(page).getByRole('button', { name: 'Back' }).click();
    await expect(firstQuestion(page, 'Work here anyway?')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await sent(page, 'lease_take_over')).toEqual([]);
    await expect(words(page)).toContainText("The sync folder can't be reached, and LAPTOP was last using zWorkTracker");
    await expectClean(page, found);
  });

  test('a folder that is back and a holder gone: the banner has nothing to say', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=unknown-writable');
    await expect(words(page)).toHaveText("The sync folder can't be reached, so this computer can't check whether another one is in use. You can keep working. Everything merges when the folder is back.");
    await expect(card(page, 'Social templates').getByRole('button', { name: 'Start' })).toBeEnabled();
    await expectClean(page, found);
  });
});

test.describe('no lease, no line', () => {
  for (const kind of ['free', 'mine', 'checking']) {
    test(`?lease=${kind} shows none`, async ({ page }) => {
      const found = await open(page, `seed=demo&lease=${kind}`);
      await expect(banner(page)).toHaveCount(0);
      await expect(card(page, 'Social templates').getByRole('button', { name: 'Start' })).toBeEnabled();
      await expectClean(page, found);
    });
  }

  test('with no folder at all there is none either', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await expect(banner(page)).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('this computer holds it (?lease=mine)', () => {
  const sync = (page: Page): Locator => page.getByRole('region', { name: 'Sync between devices' });

  test('Settings says so beside Sync and nowhere else, Release now is refused while a timer runs here, and lets go once it is paused', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=mine');
    // Logo concepts is running here in the demo, which keeps this computer in use. No banner: the line is in Settings only.
    await expect(banner(page)).toHaveCount(0);
    await tab(page, 'Settings');
    const held = sync(page).getByTestId('sync-held-by-me');
    await expect(held).toContainText('This computer is the one making changes.');
    await expect(held).toContainText('It lets go by itself after 15 minutes with no change and no timer running, and when you quit.');

    await held.getByRole('button', { name: 'Release now' }).click();
    await expect(held.getByRole('alert')).toHaveText('Could not release: a task is running here, so this computer is still in use. Pause it first.');
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('heldByMe');
    await page.screenshot({ path: path.join(SHOTS, 'lease-release-refused.png') });

    await tab(page, 'Timeline');
    await card(page, 'Logo concepts').getByRole('button', { name: 'Pause' }).click();
    await expect(card(page, 'Logo concepts').getByRole('button', { name: 'Resume' })).toBeVisible();
    await tab(page, 'Settings');
    await sync(page).getByTestId('sync-held-by-me').getByRole('button', { name: 'Release now' }).click();
    await expect(sync(page).getByTestId('sync-held-by-me')).toHaveCount(0);
    expect(await sent(page, 'lease_release')).toHaveLength(2);
    expect(await page.evaluate(() => window.__mock.lease.state)).toBe('free');
    await expectClean(page, found);
  });

  test('is not there when nobody holds it', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=free');
    await tab(page, 'Settings');
    await expect(sync(page)).toBeVisible();
    await expect(sync(page).getByTestId('sync-held-by-me')).toHaveCount(0);
    await expect(sync(page).getByRole('button', { name: 'Release now' })).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('words refused because another computer took the lease', () => {
  test('wait in a notice with the editor closed, and are sent by themselves when this computer takes over', async ({ page }) => {
    const found = await open(page, 'seed=demo&lease=mine');
    const stored = (): Promise<string> => page.evaluate(() => JSON.stringify(window.__mock.tasks.find((t) => t.id === 't-guide')?.description));
    const form = page.getByRole('form', { name: 'Editing Brand guidelines' });
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    await form.getByRole('textbox', { name: 'Description' }).click();
    await page.keyboard.type(' unsent words');
    // LAPTOP takes the lease before the autosave goes.
    await page.evaluate(() => {
      window.__mockLeaseLost();
    });
    await page.clock.runFor(1000);
    await expect(form.getByTestId('save-state')).toContainText('Not saved: LAPTOP is using zWorkTracker. Take over to save.');
    await page.getByRole('button', { name: 'Edit Brand guidelines' }).click();
    await expect(form).toHaveCount(0);
    const notice = page.getByTestId('unsent-banner');
    await expect(notice).toContainText("can't be saved: LAPTOP is using zWorkTracker, so this computer is read-only. Take over from the banner to work here.");
    expect(await stored()).not.toContain('unsent words');

    // LAPTOP was heard from a moment ago, so there is no way to take over from it yet. It says nothing for 20 minutes, and there is.
    await expect(banner(page).getByRole('button', { name: 'Take over…' })).toHaveCount(0);
    await page.evaluate(() => {
      const m = window.__mock;
      if (m.lease.holder) m.lease = { ...m.lease, state: 'heldByOtherStale', holder: { ...m.lease.holder, lastSignAt: `${new Date((m.now - 20 * 60) * 1000).toISOString().slice(0, 19)}Z` } };
      void window.__mockEmit('state-changed');
    });
    await banner(page).getByRole('button', { name: 'Take over…' }).click();
    await firstQuestion(page).getByRole('button', { name: 'Continue' }).click();
    await secondQuestion(page).getByRole('button', { name: 'Take over' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Nothing else is pressed: the words go, and the notice that said to take over goes with them.
    await page.clock.runFor(1000);
    await expect(notice).toHaveCount(0);
    expect(await stored()).toContain('unsent words');
    await expectClean(page, found);
  });
});

test.describe('screenshots', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`the banner for a computer in use in ${theme}`, async ({ page }) => {
      const found = await open(page, `seed=demo&lease=live&theme=${theme}`);
      await expect(banner(page)).toBeVisible();
      await expect(banner(page).getByRole('button')).toHaveText(['Check again']);
      await page.screenshot({ path: path.join(SHOTS, `lease-banner-live-${theme}.png`) });
      await expectClean(page, found);
    });

    test(`the banner and both questions for an inactive computer in ${theme}`, async ({ page }) => {
      const found = await open(page, `seed=demo&lease=stale&theme=${theme}`);
      await expect(banner(page)).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `lease-banner-stale-${theme}.png`) });
      await banner(page).getByRole('button', { name: 'Take over…' }).click();
      await expect(firstQuestion(page).getByRole('button', { name: 'Continue' })).toBeEnabled();
      await page.screenshot({ path: path.join(SHOTS, `lease-take-over-1-${theme}.png`) });
      await firstQuestion(page).getByRole('button', { name: 'Continue' }).click();
      await expect(secondQuestion(page)).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `lease-take-over-2-${theme}.png`) });
      await expectClean(page, found);
    });
  }
});
