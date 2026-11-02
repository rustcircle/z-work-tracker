import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { SHOTS, advance, card, expectClean, open, refresh } from './support';

// Deleting a task, in a real browser under the production CSP, against the IPC mock: from a Timeline entry to its
// Details, through the review and the last dialog, with real mouse clicks and real keys. ?seed=demo: 12 March 2026,
// active zone Lisbon (UTC+0 until 29 March, so wall time reads as UTC). Homepage layout is a stopped task with an
// hour or two on eight days; Logo concepts is running.

const WED = 'Wed 11 Mar 2026';
const TUE = 'Tue 10 Mar 2026';
const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

const day = (page: Page, name: string): Locator => page.getByRole('article', { name });
const entriesOf = (scope: Page | Locator, page: Page, name: string): Locator => scope.getByTestId('entry').filter({ has: page.getByRole('button', { name, exact: true }) });
const bar = (page: Page): Locator => page.getByTestId('selection-bar');
const deletes = (page: Page): Promise<number> => page.evaluate(() => window.__mock.calls.filter((c) => c.cmd === 'delete_task').length);
const taskIds = (page: Page): Promise<string[]> => page.evaluate(() => window.__mock.tasks.map((t) => t.id));
/** "1h 05m" or "45m", as minutes. */
const minutes = (text: string): number => Number(/(\d+)h/.exec(text)?.[1] ?? 0) * 60 + Number(/(\d+)m/.exec(text)?.[1] ?? 0);

/** What the mock holds of a task, worked out apart from the page: seconds logged and the days (UTC, as Lisbon is in March). */
const loggedOf = (page: Page, id: string): Promise<{ secs: number; days: number }> =>
  page.evaluate((taskId) => {
    const days = new Set<string>();
    let secs = 0;
    for (const s of window.__mock.segments) {
      if (s.taskId !== taskId || s.end === null) continue;
      secs += (Date.parse(s.end) - Date.parse(s.start)) / 1000;
      days.add(s.start.slice(0, 10));
    }
    return { secs, days: days.size };
  }, id);
const hm = (secs: number): string => `${Math.floor(secs / 3600)}h ${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;

/** From a Timeline entry of the task, as a person goes: its name takes them to its card, and the card has Details. */
async function openDetails(page: Page, name: string, onDay = WED): Promise<Locator> {
  await entriesOf(day(page, onDay), page, name).first().getByRole('button', { name, exact: true }).click();
  await expect(card(page, name)).toBeFocused();
  await card(page, name).getByRole('button', { name: 'Details' }).click();
  const details = page.getByRole('dialog', { name: `Details: ${name}` });
  await expect(details).toBeVisible();
  return details;
}
const review = (page: Page): Locator => page.getByRole('dialog', { name: 'Delete this task?' });
const last = (page: Page, name: string): Locator => page.getByRole('dialog', { name: `Delete “${name}” for good?` });

test.describe('deleting a task', () => {
  test('from a Timeline entry, through Details and two dialogs, takes the task, its entries, its totals and its place in the selection', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const name = 'Homepage layout';
    const rows = entriesOf(page, page, name);
    const before = await rows.count();
    expect(before).toBeGreaterThan(5);
    const wed = day(page, WED);
    const wedBefore = minutes(await wed.getByTestId('day-exact').innerText());
    const wedOwn = (await entriesOf(wed, page, name).locator('td.num').allInnerTexts()).map(minutes).reduce((n, m) => n + m, 0);
    expect(wedOwn).toBeGreaterThan(0);
    // Two entries of this task and one of another are selected.
    await entriesOf(wed, page, name).first().click();
    await entriesOf(day(page, TUE), page, name).first().click({ modifiers: ['ControlOrMeta'] });
    await wed.getByTestId('entry').filter({ hasNot: page.getByRole('button', { name, exact: true }) }).first().click({ modifiers: ['ControlOrMeta'] });
    await expect(bar(page).getByTestId('selection-count')).toContainText('3 tasks selected');
    await expect(page.getByRole('button', { name: 'Export (3 selected)' })).toBeVisible();

    const details = await openDetails(page, name);
    // The red button is under the tabs, and not on the row or the card.
    await expect(wed.getByRole('button', { name: /delete/i })).toHaveCount(0);
    await expect(card(page, name).getByRole('button', { name: /delete/i })).toHaveCount(0);
    const trigger = details.getByRole('button', { name: 'Delete task' });
    await expect(trigger).toBeEnabled();
    await expect(trigger).toHaveCSS('background-color', 'rgb(185, 28, 28)');
    await trigger.click();

    // The review: the task, what goes, the whole task, and no way back but a backup.
    const first = review(page);
    await expect(first).toBeVisible();
    const logged = await loggedOf(page, 't-home');
    await expect(first).toContainText('“Homepage layout” in Website will be deleted from Mock PC and from synced devices, with everything logged on it.');
    await expect(first.getByLabel('What goes with it')).toContainText(`${hm(logged.secs)} on ${logged.days} days`);
    await expect(first.getByLabel('What goes with it')).toContainText(/Earnings\s*€[\d,]+\.\d\d/);
    await expect(first).toContainText("This removes the whole task and all its time, not only one day's entry.");
    await expect(first).toContainText("This can't be undone in the app. The only way back is to restore a backup made before the delete (Settings, Backups)");
    await expect(first.getByRole('button', { name: 'Keep it' })).toBeFocused();
    // Enter does nothing on Keep it, nor on Continue; Space does nothing on Continue.
    await advance(page, 2);
    await page.keyboard.press('Enter');
    await expect(first).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(first.getByRole('button', { name: 'Continue' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(first).toBeVisible();
    await expect(last(page, name)).toHaveCount(0);
    await first.getByRole('button', { name: 'Continue' }).click();

    // The last dialog.
    const second = last(page, name);
    await expect(second).toBeVisible();
    await expect(first).toHaveCount(0);
    await expect(second.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await expect(second).toContainText(`This deletes “Homepage layout” and the ${hm(logged.secs)} logged on it from Mock PC and from synced devices.`);
    await advance(page, 2);
    await page.keyboard.press('Enter');
    await expect(second).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(second.getByRole('button', { name: 'Delete task' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    await expect(second).toBeVisible();
    expect(await deletes(page)).toBe(0);
    expect(await taskIds(page)).toContain('t-home');

    // A real click deletes.
    await second.getByRole('button', { name: 'Delete task' }).click();
    await expect(second).toHaveCount(0);
    await expect(details).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card(page, name)).toHaveCount(0);
    expect(await deletes(page)).toBe(1);
    expect(await taskIds(page)).not.toContain('t-home');
    await expect(page.getByText('Deleted “Homepage layout” and everything logged on it.')).toBeVisible();
    // The entries are gone from every day, and the totals of the day are the others'.
    await expect(entriesOf(page, page, name)).toHaveCount(0);
    expect(minutes(await wed.getByTestId('day-exact').innerText())).toBe(wedBefore - wedOwn);
    // The selection kept the one entry of another task, and the bar says so.
    await expect(bar(page).getByTestId('selection-count')).toContainText('1 task selected');
    await expect(page.getByRole('button', { name: 'Export (1 selected)' })).toBeVisible();
    const kept = page.locator('tr[data-testid="entry"][aria-selected="true"]');
    expect(await kept.count()).toBeGreaterThan(0);
    await expect(kept.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expectClean(page, found);
  });

  test('a long tab runs under nothing: the delete section sits below it, and what is in the tab can still be clicked', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    const details = await openDetails(page, 'Homepage layout');
    await details.getByRole('tab', { name: 'Corrections' }).click();
    const panel = details.getByRole('tabpanel');
    // The panel is as tall as what it holds, so the section after it can't lie over the list.
    const fits = await panel.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
    expect(fits).toBe(true);
    const section = details.getByRole('region', { name: 'Delete this task' });
    const [p, d] = await Promise.all([panel.boundingBox(), section.boundingBox()]);
    if (!p || !d) throw new Error('no box');
    expect(d.y).toBeGreaterThanOrEqual(p.y + p.height - 1);
    // The last row's button, the one nearest the section, takes a click.
    const last = details.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Correct' }) }).last();
    await last.getByRole('button', { name: 'Correct' }).click();
    await expect(last.getByRole('form', { name: /^Correct / })).toBeVisible();
    await expectClean(page, found);
  });

  test('Keep it and Esc back out of either dialog and change nothing; the next try starts at the review', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const name = 'Brand guidelines';
    const details = await openDetails(page, name, WED);
    const trigger = details.getByRole('button', { name: 'Delete task' });
    await trigger.click();
    await review(page).getByRole('button', { name: 'Keep it' }).click();
    await expect(review(page)).toHaveCount(0);
    await expect(details).toBeVisible();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(review(page)).toHaveCount(0);
    await expect(details).toBeVisible();

    await trigger.click();
    await review(page).getByRole('button', { name: 'Continue' }).click();
    await expect(last(page, name)).toBeVisible();
    await last(page, name).getByRole('button', { name: 'Keep it' }).click();
    await expect(last(page, name)).toHaveCount(0);
    await expect(details).toBeVisible();

    await trigger.click();
    await review(page).getByRole('button', { name: 'Continue' }).click();
    await expect(last(page, name)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(last(page, name)).toHaveCount(0);
    await expect(details).toBeVisible();
    // Esc did not also close the Details underneath, and the next try begins again at the review.
    await trigger.click();
    await expect(review(page)).toBeVisible();
    await expect(last(page, name)).toHaveCount(0);
    expect(await deletes(page)).toBe(0);
    expect(await taskIds(page)).toContain('t-guide');
    await expectClean(page, found);
  });

  test('a double click on Continue does not reach Delete task, and the second click of a run does nothing on it', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const name = 'Box dieline';
    const details = await openDetails(page, name, TUE);
    await details.getByRole('button', { name: 'Delete task' }).click();
    await advance(page, 2);
    await review(page).getByRole('button', { name: 'Continue' }).dblclick();
    const second = last(page, name);
    // The second click landed beside the next dialog, or on its button that was not ready, and decided nothing.
    await page.waitForTimeout(300);
    await expect(second).toBeVisible();
    const del = second.getByRole('button', { name: 'Delete task' });
    // The button that came up under the double click has not had its second yet.
    await expect(del).toBeDisabled();
    await page.waitForTimeout(300);
    expect(await deletes(page)).toBe(0);
    // Ready a second on, a press counted as the second or third of a run still does nothing, wherever it was begun.
    await advance(page, 2);
    await expect(del).toBeEnabled();
    const box = await del.boundingBox();
    if (!box) throw new Error('no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (const clickCount of [2, 3]) {
      await page.mouse.down({ clickCount });
      await page.mouse.up({ clickCount });
    }
    await page.waitForTimeout(300);
    expect(await deletes(page)).toBe(0);
    await expect(second).toBeVisible();
    // A click on its own deletes.
    await del.click();
    await expect(second).toHaveCount(0);
    expect(await deletes(page)).toBe(1);
    await expectClean(page, found);
  });

  test('a task that is running, or has time on a live summary, cannot be deleted, and the page says why beside the button', async ({ page }) => {
    const found = await open(page, 'seed=p2');
    // Running here.
    const running = await openDetails(page, 'Logo concepts', 'Thu 12 Mar 2026');
    await expect(running.getByRole('button', { name: 'Delete task' })).toBeDisabled();
    await expect(running.getByText('This task is running. Pause or stop it first, then delete it.')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'task-delete-blocked-running.png') });
    await page.keyboard.press('Escape');
    await expect(running).toHaveCount(0);
    // On summary A-001.
    const billed = await openDetails(page, 'Homepage layout');
    await expect(billed.getByRole('button', { name: 'Delete task' })).toBeDisabled();
    await expect(billed.getByText("This task's time is on billing summary A-001. Void that summary first, then delete the task.")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'task-delete-blocked-summary.png') });
    await billed.getByRole('button', { name: 'Open Billing' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Billing', selected: true })).toBeVisible();
    expect(await deletes(page)).toBe(0);
    // A task whose summary is voided can go: Box dieline is on A-002, which the seed voided.
    await page.getByRole('tab', { name: 'Timeline' }).click();
    const free = await openDetails(page, 'Box dieline', 'Tue 10 Mar 2026');
    await expect(free.getByRole('button', { name: 'Delete task' })).toBeEnabled();
    await expectClean(page, found);
  });

  test('a task running on another of your PCs can be deleted: the dialogs say where it runs, that its time so far goes too, and that its timer stops when that PC syncs', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const name = 'Logo concepts';
    // Its timer is open on Office PC, and this computer has none.
    await page.evaluate(() => {
      const open = window.__mock.segments.find((x) => x.taskId === 't-logo' && x.end === null);
      const t = window.__mock.tasks.find((x) => x.id === 't-logo');
      if (open && t) {
        open.deviceId = 'other-device';
        t.runningElsewhere = 'Office PC';
      }
    });
    await refresh(page);
    const details = await openDetails(page, name, 'Thu 12 Mar 2026');
    const trigger = details.getByRole('button', { name: 'Delete task' });
    await expect(trigger).toBeEnabled();
    await expect(details.getByTestId('delete-blocked')).toHaveCount(0);
    await trigger.click();
    const said = "It is running on Office PC right now. The time it has logged there so far is deleted too, and Office PC's timer stops the next time it syncs.";
    await expect(review(page)).toContainText(said);
    await page.screenshot({ path: path.join(SHOTS, 'task-delete-review-elsewhere.png') });
    await advance(page, 2);
    await review(page).getByRole('button', { name: 'Continue' }).click();
    const second = last(page, name);
    await expect(second).toContainText(said);
    await advance(page, 2);
    await second.getByRole('button', { name: 'Delete task' }).click();
    await expect(second).toHaveCount(0);
    await expect(card(page, name)).toHaveCount(0);
    expect(await deletes(page)).toBe(1);
    expect(await taskIds(page)).not.toContain('t-logo');
    expect(await page.evaluate(() => window.__mock.segments.some((x) => x.taskId === 't-logo'))).toBe(false);
    await expectClean(page, found);
  });

  test('the backend has the last word: a refusal the page could not see is shown in the banner and beside the button', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const name = 'Box dieline';
    const details = await openDetails(page, name, TUE);
    await details.getByRole('button', { name: 'Delete task' }).click();
    await advance(page, 2);
    await review(page).getByRole('button', { name: 'Continue' }).click();
    await advance(page, 2);
    // A timer opens on this computer (the mock's own device id), and this page has not heard.
    await page.evaluate(() => {
      window.__mock.segments.push({ id: 'here-now', taskId: 't-box', deviceId: '11111111-1111-4111-8111-111111111111', start: '2026-03-12T14:00:00Z', end: null, provisionalEnd: null });
    });
    await last(page, name).getByRole('button', { name: 'Delete task' }).click();
    const message = 'this task is running; pause or stop it before deleting it';
    await expect(page.locator('.banner-error')).toContainText(message);
    await expect(details.getByRole('alert')).toHaveText('This task is running; pause or stop it before deleting it.');
    await expect(last(page, name)).toHaveCount(0);
    await expect(details).toBeVisible();
    expect(await taskIds(page)).toContain('t-box');
    await expectClean(page, found);
  });

  test('a long name with no spaces wraps inside both dialogs, title included', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const long = `https://example.com/${'a'.repeat(170)}`;
    await page.evaluate((name) => {
      const t = window.__mock.tasks.find((x) => x.id === 't-box');
      if (t) t.name = name;
    }, long);
    await refresh(page);
    const details = await openDetails(page, long, TUE);
    await details.getByRole('button', { name: 'Delete task' }).click();
    await advance(page, 2);
    const fits = (dialog: Locator) =>
      dialog.evaluate((el) => {
        const body = el.querySelector('.modal-body');
        const title = el.querySelector('h2');
        return { body: (body?.scrollWidth ?? 0) <= (body?.clientWidth ?? 0), title: (title?.scrollWidth ?? 0) <= el.clientWidth };
      });
    expect(await fits(review(page))).toEqual({ body: true, title: true });
    await review(page).getByRole('button', { name: 'Continue' }).click();
    const second = last(page, long);
    await expect(second).toBeVisible();
    expect(await fits(second)).toEqual({ body: true, title: true });
    await page.screenshot({ path: path.join(SHOTS, 'task-delete-long-name.png') });
    await expectClean(page, found);
  });

  test('Hide earnings masks the amount in the review', async ({ page }) => {
    const found = await open(page, 'seed=demo&hide=1');
    const details = await openDetails(page, 'Homepage layout');
    await details.getByRole('button', { name: 'Delete task' }).click();
    const figures = review(page).getByLabel('What goes with it');
    await expect(figures).toContainText('Earnings••••');
    expect(await review(page).innerText()).not.toMatch(/[€$]\s?\d/);
    await expect(figures).toContainText(/Time logged\s*\d+h \d\dm on \d+ days/);
    await expectClean(page, found);
  });
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a tap goes on like a click, so a task can be deleted by touch though not by key', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const name = 'Box dieline';
    const details = await openDetails(page, name, TUE);
    await details.getByRole('button', { name: 'Delete task' }).tap();
    await expect(review(page)).toBeVisible();
    await advance(page, 2);
    await review(page).getByRole('button', { name: 'Continue' }).tap();
    const second = last(page, name);
    await expect(second).toBeVisible();
    await advance(page, 2);
    expect(await deletes(page)).toBe(0);
    await second.getByRole('button', { name: 'Delete task' }).tap();
    await expect(second).toHaveCount(0);
    await expect(card(page, name)).toHaveCount(0);
    expect(await deletes(page)).toBe(1);
    expect(await taskIds(page)).not.toContain('t-box');
    await expectClean(page, found);
  });
});

test.describe('the dialogs in every theme', () => {
  for (const [theme, label] of THEMES) {
    test(`the Details, the review and the last dialog read well in ${label}`, async ({ page }) => {
      const found = await open(page, `seed=demo&theme=${theme}`);
      const name = 'Homepage layout';
      const details = await openDetails(page, name);
      await details.getByRole('button', { name: 'Delete task' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, `task-delete-details-${label}.png`) });
      await details.getByRole('button', { name: 'Delete task' }).click();
      await expect(review(page)).toBeVisible();
      await advance(page, 2);
      await page.screenshot({ path: path.join(SHOTS, `task-delete-review-${label}.png`) });
      await review(page).getByRole('button', { name: 'Continue' }).click();
      await expect(last(page, name)).toBeVisible();
      await advance(page, 2);
      await expect(last(page, name).getByRole('button', { name: 'Delete task' })).toBeEnabled();
      await page.screenshot({ path: path.join(SHOTS, `task-delete-last-${label}.png`) });
      // The danger button is readable on its own colour: the text token is the page background, the fill is the danger colour.
      const colours = await last(page, name)
        .getByRole('button', { name: 'Delete task' })
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return { color: s.color, background: s.backgroundColor };
        });
      expect(colours.color).not.toBe(colours.background);
      await expectClean(page, found);
    });
  }
});
