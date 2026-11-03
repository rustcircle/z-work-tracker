import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, advance, expectClean, open, tab } from './support';

// This computer's clock behind the newest change it has seen, in a real browser under the production CSP, against the IPC mock.
// ?clockBehind=<secs> puts the newest change seen that many seconds ahead of the clock: saved on LAPTOP, or with &clockBy=here on this
// computer, as when its clock was set back. The line shows from 120 s, and from 86400 s (a day, the furthest a new change may be dated past the
// clock) it says that changes made here can't be dated after it. ?seed=demo: the clock is 12 March 2026 15:20 UTC and My zone is Lisbon, which
// is on UTC until the end of March, so a change 5400 s ahead was saved at 16:50, one 7200 s ahead at 17:20 and one 172800 s ahead on 14 March at 15:20.

const line = (page: Page): Locator => page.getByTestId('clock-behind');
const snapshots = (page: Page): Promise<number> => page.evaluate(() => window.__mock.calls.filter((c) => c.cmd === 'get_snapshot').length);
/** The backend sends the page a new snapshot, as it does when something changed on its own. */
const sendSnapshot = (page: Page): Promise<void> => page.evaluate(() => window.__mockEmit('state-changed'));

const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

test.describe('the newest change seen is ahead of the clock', () => {
  test('/?clockBehind=5400 names the other computer, when it saved the change, and what to check', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');

    await expect(line(page)).toBeVisible();
    await expect(line(page)).toContainText("This computer's clock is 1 h 30 min behind a change saved on LAPTOP at ");
    await expect(line(page)).toContainText('one of them is wrong.');
    await expect(line(page)).toHaveText(
      "This computer's clock is 1 h 30 min behind a change saved on LAPTOP at 16:50. New changes here are still dated after it, so they count as the newest. Check the date and time on both computers: one of them is wrong.",
    );
    await expectClean(page, found);
  });

  test('/?clockBehind=7200&clockBy=here says the change was saved on this computer, so its clock was set back', async ({ page }) => {
    const found = await open(page, 'clockBehind=7200&clockBy=here');

    await expect(line(page)).toContainText('behind a change saved here at ');
    await expect(line(page)).toHaveText(
      "This computer's clock is 2 h behind a change saved here at 17:20, so it seems to have been set back. New changes are still dated after that one, so they count as the newest. Check this computer's date and time.",
    );
    await expectClean(page, found);
  });

  test('&clockBy=<name> names the computer that saved the change', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400&clockBy=Home%20PC');

    await expect(line(page)).toContainText('behind a change saved on Home PC at 16:50.');
    await expectClean(page, found);
  });

  test('is a status the page can find, always visible, with no way to dismiss it', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');

    const status = page.getByRole('status').filter({ hasText: "This computer's clock is" });
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute('data-testid', 'clock-behind');
    await expect(line(page).getByRole('button')).toHaveCount(0);
    await expectClean(page, found);
  });

  test('keeps the gap, which changes every minute, out of what a screen reader is told, and only that', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');

    await expect(line(page)).toHaveAttribute('role', 'status');
    await expect(line(page).locator('[aria-live]')).toHaveCount(1);
    await expect(line(page).locator('[aria-live="off"]')).toHaveText('1 h 30 min');
    await expectClean(page, found);
  });

  test('stays on every tab', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');

    for (const name of ['Analysis', 'Billing', 'Projects', 'Settings', 'Timeline']) {
      await tab(page, name);
      await expect(line(page)).toBeVisible();
    }
    await expectClean(page, found);
  });

  test('shows next to the lease line, which stays first', async ({ page }) => {
    const found = await open(page, 'lease=live&clockBehind=5400');

    await expect(page.getByTestId('lease-banner')).toBeVisible();
    await expect(line(page)).toBeVisible();
    await expect(page.locator('[data-testid="lease-banner"] + [data-testid="clock-behind"]')).toHaveCount(1);
    await expectClean(page, found);
  });
});

test.describe('a gap of a day or more', () => {
  test('/?clockBehind=172800 says that changes made here can’t be dated after it, so they may lose to it', async ({ page }) => {
    const found = await open(page, 'clockBehind=172800');

    await expect(line(page)).toBeVisible();
    await expect(line(page)).toContainText("Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check the date and time on both computers.");
    await expect(line(page)).not.toContainText('so they count as the newest');
    await expect(line(page)).toHaveText(
      "This computer's clock is 2 days behind a change saved on LAPTOP at 14 Mar 15:20. Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check the date and time on both computers.",
    );
    await expect(line(page).locator('[aria-live="off"]')).toHaveText('2 days');
    await expectClean(page, found);
  });

  test('/?clockBehind=172800&clockBy=here says it of a change saved on this computer', async ({ page }) => {
    const found = await open(page, 'clockBehind=172800&clockBy=here');

    // A change saved here leaves no other computer to check: only this one.
    await expect(line(page)).toHaveText(
      "This computer's clock is 2 days behind a change saved here at 14 Mar 15:20, so it seems to have been set back. Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check this computer's date and time.",
    );
    await expect(line(page)).not.toContainText('both computers');
    await expectClean(page, found);
  });

  test('86399 s, a day less a second, still says that new changes count as the newest', async ({ page }) => {
    const found = await open(page, 'clockBehind=86399');

    await expect(line(page)).toContainText('so they count as the newest.');
    await expect(line(page)).not.toContainText('so they may lose to it');
    await expectClean(page, found);
  });

  test('86400 s, a whole day, says they may lose to it', async ({ page }) => {
    const found = await open(page, 'clockBehind=86400');

    await expect(line(page)).toContainText('so they may lose to it.');
    await expect(line(page)).not.toContainText('so they count as the newest');
    await expectClean(page, found);
  });

  test('goes back to the plain words from the next snapshot once the gap is under a day', async ({ page }) => {
    const found = await open(page, 'clockBehind=90000');
    await expect(line(page)).toContainText('so they may lose to it.');

    // An hour passes on both clocks and the backend sends a snapshot: 23 hours and a few minutes are left.
    await advance(page, 3700);
    await sendSnapshot(page);
    await expect(line(page)).toContainText('is 23 h 58 min behind');
    await expect(line(page)).toContainText('so they count as the newest.');
    await expectClean(page, found);
  });

  test('goes back to the plain words by itself when the page clock moves the gap under a day, with no new snapshot', async ({ page }) => {
    // 86450 s ahead is capped. Two minutes on the page clock leave 86330 s, and a change made then can be dated after the newest one again.
    const found = await open(page, 'clockBehind=86450&clockBy=here');
    await expect(line(page)).toContainText("so they may lose to it. Check this computer's date and time.");
    const before = await snapshots(page);

    await page.clock.fastForward(120 * 1000);
    await expect(line(page)).toContainText('is 23 h 58 min behind');
    await expect(line(page)).toContainText("so they count as the newest. Check this computer's date and time.");
    await expect(line(page)).not.toContainText('so they may lose to it');
    expect(await snapshots(page)).toBe(before);
    await expectClean(page, found);
  });
});

test.describe('the time of the change', () => {
  test('is on the wall clock of My zone, also when the zone bar shows Client time', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');
    await expect(line(page)).toContainText('saved on LAPTOP at 16:50.');

    // Client time is New York, on summer time since 8 March: the change was saved at 12:50 there, hours before the clock it is compared with.
    const bar = page.getByTestId('active-zone-bar');
    await bar.getByRole('button', { name: 'Client time' }).click();
    await expect(bar.getByRole('button', { name: 'Client time' })).toHaveAttribute('aria-pressed', 'true');
    await expect(line(page)).toContainText('saved on LAPTOP at 16:50.');
    await expect(line(page)).not.toContainText('12:50');
    await expectClean(page, found);
  });
});

test.describe('no line', () => {
  test('/?clockBehind=60 shows none: a clock that drifts by a minute is not wrong', async ({ page }) => {
    const found = await open(page, 'clockBehind=60');

    await expect(line(page)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('a gap of a few minutes shows the line, with its gap and the time of the change', async ({ page }) => {
    const found = await open(page, 'clockBehind=330');

    await expect(line(page)).toContainText("This computer's clock is 5 min behind a change saved on LAPTOP at 15:25.");
    await expectClean(page, found);
  });

  test('is not there without the parameter', async ({ page }) => {
    const found = await open(page, 'seed=demo');

    await expect(line(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: "This computer's clock" })).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('the line follows the clock', () => {
  test('is gone from the next snapshot once the clock is right, and says so for a gap that shrinks', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');
    await expect(line(page)).toContainText('is 1 h 30 min behind');

    // An hour passes on both clocks and the backend sends a snapshot: 30 minutes are left.
    await advance(page, 3600);
    await sendSnapshot(page);
    await expect(line(page)).toContainText('is 30 min behind');

    // The person sets the clock right: the newest change seen is no longer ahead.
    await page.evaluate(() => {
      window.__mock.newestStamp = null;
    });
    await sendSnapshot(page);
    await expect(line(page)).toHaveCount(0);
    await expectClean(page, found);
  });

  test('goes away by itself once the page clock has caught up, without asking the backend again', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');
    await expect(line(page)).toBeVisible();
    const before = await snapshots(page);

    // The window is left closed to the tray for longer than the gap; the page reads its clock when it wakes.
    await page.clock.fastForward(5400 * 1000);
    await expect(line(page)).toHaveCount(0);
    expect(await snapshots(page)).toBe(before);
    await expectClean(page, found);
  });

  test('a snapshot that still says the gap is there brings it back', async ({ page }) => {
    const found = await open(page, 'clockBehind=5400');
    await page.clock.fastForward(5400 * 1000);
    await expect(line(page)).toHaveCount(0);

    // The backend's clock did not move, so it still sees the newest change 90 minutes ahead.
    await sendSnapshot(page);
    await expect(line(page)).toContainText('is 1 h 30 min behind');
    await expectClean(page, found);
  });
});

test.describe('the setup wizard, which does not render the Shell', () => {
  test('shows the line on a first start, and it is still there when setup is done', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=1&clockBehind=5400', false);

    const wizard = page.getByTestId('setup-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard.getByTestId('clock-behind')).toContainText("This computer's clock is 1 h 30 min behind a change saved on LAPTOP at ");
    await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveCount(0);

    await page.getByTestId('finish-defaults').click();
    await expect(page.getByRole('tab', { name: 'Timeline' })).toBeVisible();
    await expect(wizard).toHaveCount(0);
    await expect(line(page)).toContainText('one of them is wrong.');
    await expectClean(page, found);
  });

  test('is not in the wizard of a first start with nothing ahead', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=1', false);

    await expect(page.getByTestId('setup-wizard')).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('the one-time sync prompt, which does not render the Shell either', () => {
  test('shows the line above the question that someone who updated before the wizard existed has still to answer', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=legacy&clockBehind=5400', false);

    await expect(page.getByRole('heading', { name: 'Keep your devices in sync?' })).toBeVisible();
    await expect(line(page)).toBeVisible();
    await expect(line(page)).toHaveAttribute('role', 'status');
    await expect(line(page)).toContainText("This computer's clock is 1 h 30 min behind a change saved on LAPTOP at ");
    await expect(line(page).getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Timeline' })).toHaveCount(0);
    await expectClean(page, found);
  });

  test('is not there when nothing is ahead', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=legacy', false);

    await expect(page.getByRole('heading', { name: 'Keep your devices in sync?' })).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    await expectClean(page, found);
  });
});

test.describe('screenshots', () => {
  for (const [theme, file] of THEMES) {
    test(`the line in ${theme}`, async ({ page }) => {
      const found = await open(page, `clockBehind=5400&theme=${theme}`);
      await expect(line(page)).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `clock-behind-${file}.png`) });
      await expectClean(page, found);
    });
  }

  test('the line for a gap of a day or more in dark', async ({ page }) => {
    const found = await open(page, 'clockBehind=172800&theme=dark');
    await expect(line(page)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'clock-behind-capped-dark.png') });
    await expectClean(page, found);
  });

  test('the line next to the lease line in dark', async ({ page }) => {
    const found = await open(page, 'lease=live&clockBehind=7200&clockBy=here&theme=dark');
    await expect(line(page)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'clock-behind-with-lease-dark.png') });
    await expectClean(page, found);
  });
});
