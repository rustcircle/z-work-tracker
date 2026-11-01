import path from 'node:path';

import { expect, test } from '@playwright/test';

import { SHOTS, advance, card, expectClean, open, refresh, tab } from './support';

// The demo seed: 12 March 2026 15:20 UTC, My zone Lisbon, Client zone New York.
const THEMES = [
  ['light', 'light'],
  ['solarizedLight', 'solarized-light'],
  ['solarizedDark', 'solarized-dark'],
  ['dark', 'dark'],
] as const;

test.describe('full flow on an empty store', () => {
  test('project with colour, task with a numbered list, start, pause, resume, stop', async ({ page }) => {
    const found = await open(page, 'seed=empty');
    await expect(page.getByText('Nothing is logged yet')).toBeVisible();

    // Project with a chosen colour.
    await tab(page, 'Projects');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Brand refresh');
    await page.getByRole('radio', { name: 'Colour #dc2626' }).click();
    await page.getByRole('textbox', { name: 'Price', exact: true }).fill('90');
    await page.getByRole('combobox', { name: 'Currency' }).selectOption('USD');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name: 'Brand refresh' })).toBeVisible();
    expect(await page.evaluate(() => window.__mock.projects.map((p) => [p.name, p.color]))).toEqual([['Brand refresh', '#dc2626']]);
    expect(await page.evaluate(() => window.__mock.rates.map((r) => [r.rateCents, r.currency]))).toEqual([[9000, 'USD']]);

    // Task with a numbered list; Start stays disabled until it is valid.
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    await expect(form.getByRole('button', { name: 'Start' })).toBeDisabled();
    await expect(form.getByText('To start, enter a task name, a project, a description and at least one tag.')).toBeVisible();
    await form.getByRole('textbox', { name: 'Task name' }).fill('Logo concepts');
    await form.getByRole('combobox', { name: 'Project' }).selectOption({ label: 'Brand refresh' });
    await form.getByRole('button', { name: 'Numbered list' }).click();
    await form.getByRole('textbox', { name: 'Description' }).pressSequentially('Moodboard\nSketches\nFinal artwork');
    await expect(form.getByRole('button', { name: 'Start' })).toBeDisabled();
    await expect(form.getByText('To start, enter at least one tag.')).toBeVisible();
    await form.getByRole('checkbox', { name: 'Concept' }).check();
    await expect(form.getByRole('button', { name: 'Start' })).toBeEnabled();
    await form.getByRole('button', { name: 'Start' }).click();

    const logo = card(page, 'Logo concepts');
    await expect(logo.getByText('Running', { exact: true })).toBeVisible();
    const description = await page.evaluate(() => JSON.stringify(window.__mock.tasks[0]?.description));
    expect(description).toContain('"type":"orderedList"');
    expect(description).toContain('Final artwork');
    await expect(logo.getByRole('button', { name: 'Pause' })).toBeEnabled();
    await expect(logo.getByRole('button', { name: 'Start' })).toBeDisabled();

    // Run for 25 minutes: the ticker steps and a block appears in the project's colour.
    await advance(page, 25 * 60);
    await expect(logo.getByText('0:25:0')).toBeVisible();
    await expect(logo.getByText('Billable now')).toBeVisible();
    await logo.getByRole('button', { name: 'Pause' }).click();
    await expect(logo.getByText('Paused by you.')).toBeVisible();
    await expect(logo.getByRole('button', { name: 'Resume' })).toBeEnabled();

    await tab(page, 'Timeline');
    const block = page.getByTestId('block').first();
    await expect(block).toBeVisible();
    await expect(block).toHaveCSS('background-color', 'rgb(220, 38, 38)');
    await expect(page.getByTestId('summary-today')).toContainText('$');

    await logo.getByRole('button', { name: 'Resume' }).click();
    await expect(logo.getByText('Running', { exact: true })).toBeVisible();
    await advance(page, 5 * 60);
    await logo.getByRole('button', { name: 'Stop' }).click();
    await expect(logo.getByText('Stopped', { exact: true })).toBeVisible();
    for (const n of ['Start', 'Pause', 'Resume', 'Stop']) await expect(logo.getByRole('button', { name: n })).toBeDisabled();
    expect(await page.evaluate(() => window.__mock.calls.map((c) => c.cmd).filter((c) => /_task$/.test(c)))).toEqual(['create_task', 'start_task', 'pause_task', 'resume_task', 'stop_task']);
    await expectClean(page, found);
  });

  test('starting a second task shows the auto-pause toast and the reason on the first', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await card(page, 'Social templates').getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Paused "Logo concepts" because you started "Social templates"' })).toBeVisible();
    await expect(card(page, 'Logo concepts').getByText('Auto-paused because "Social templates" was started.')).toBeVisible();
    await expect(card(page, 'Logo concepts').getByRole('button', { name: 'Resume' })).toBeEnabled();
    await expectClean(page, found);
  });

  test('the theme persists in the backend and applies to the page', async ({ page }) => {
    const found = await open(page, 'seed=empty');
    await tab(page, 'Settings');
    await page.getByRole('radio', { name: 'Solarized Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarizedDark');
    expect(await page.evaluate(() => window.__mock.theme)).toBe('solarizedDark');
    await tab(page, 'Timeline');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'solarizedDark');
    await expectClean(page, found);
  });
});

test.describe('timeline with the demo data', () => {
  test('draws proportional days, shift bands and the live total', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const today = page.getByRole('article', { name: 'Thu 12 Mar 2026' });
    await expect(today.getByTestId('shift-band')).toHaveCount(2);
    await expect(today.getByTestId('block')).toHaveCount(3);
    await expect(page.getByTestId('summary-today')).toContainText('$315.00');
    // Only the Billable amount is shown: no per-minute rate, no exact amount creeping up.
    await expect(page.getByTestId('summary-today')).not.toContainText('/min');
    await expect(page.getByText('Exact accrual')).toHaveCount(0);
    await expect(today.getByTestId('day-billable')).toContainText('3h 30m');
    await expect(today.getByTestId('day-exact')).toContainText('3h 25m');
    await expect(today.getByTestId('day-exact')).not.toContainText('$');
    // Live: a minute later the exact total grows by a minute and nothing else breaks.
    await advance(page, 60);
    await expect(today.getByTestId('day-exact')).toContainText('3h 26m');
    await expectClean(page, found);
  });

  test('older days are paginated', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    await page.evaluate(() => {
      // Ten more days of history before the demo data.
      for (let i = 0; i < 10; i += 1) {
        const day = `2026-02-${String(10 + i).padStart(2, '0')}`;
        window.__mock.segments.push({ id: `old${i}`, taskId: 't-box', deviceId: '11111111-1111-4111-8111-111111111111', start: `${day}T10:00:00Z`, end: `${day}T11:00:00Z`, provisionalEnd: null });
      }
    });
    await refresh(page);
    const days = page.getByRole('article').filter({ has: page.getByTestId('block') });
    await expect(days).toHaveCount(14);
    await page.getByRole('button', { name: 'Show older (10 more days)' }).click();
    await expect(days).toHaveCount(24);
    await expect(page.getByRole('button', { name: /Show older/ })).toHaveCount(0);
    await expectClean(page, found);
  });

  test('Show both adds the client axis, both times per entry and the overlap', async ({ page }) => {
    const found = await open(page, 'seed=demo&showBoth=1');
    const today = page.getByRole('article', { name: 'Thu 12 Mar 2026' });
    await expect(today.getByTestId('work-window')).toHaveCount(1);
    await expect(today.getByTestId('both-note')).toContainText('New York is 4h behind you on this date');
    await expect(today.getByTestId('overlap')).toContainText('1h 20m');
    await expect(today.getByText('14:00–15:20 Lisbon / 10:00–11:20 New York')).toBeVisible();
    // The first entry started on the 11th in New York, so it carries a date marker.
    await expect(today.getByText('00:00–00:40 Lisbon / 11 Mar 20:00–20:40 New York')).toBeVisible();
    await expectClean(page, found);
  });

  test('hide earnings masks amounts across the timeline', async ({ page }) => {
    const found = await open(page, 'seed=demo&hide=1');
    await expect(page.getByTestId('summary-today')).toContainText('••••');
    await expect(page.locator('body')).not.toContainText(/[$€]\d/);
    await expectClean(page, found);
  });

  test('a day with a clock change keeps its true length', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    // 8 March 2026: New York clocks went forward, so that day is 23 hours long. Log time on it.
    await page.evaluate(() => {
      const m = window.__mock;
      m.segments.push({ id: 'dst', taskId: 't-box', deviceId: '11111111-1111-4111-8111-111111111111', start: '2026-03-08T12:00:00Z', end: '2026-03-08T13:30:00Z', provisionalEnd: null });
    });
    await refresh(page);
    await page.getByRole('button', { name: 'Client time' }).click();
    await page.getByRole('button', { name: /Show older/ }).click();
    const day = page.getByRole('article', { name: 'Sun 8 Mar 2026' });
    await expect(day.getByText('23-hour day')).toBeVisible();
    await expect(day.getByText('New York clocks went forward 1h, 8 Mar')).toBeVisible();
    await expectClean(page, found);
  });
});

test.describe('first run', () => {
  test('asks about sync before anything is enabled, and about the client zone once', async ({ page }) => {
    const found = await open(page, 'seed=empty&firstRun=legacy', false);
    // Nothing detected yet: a guide explains what is needed instead of a silent default.
    await expect(page.getByTestId('sync-guide')).toContainText('No OneDrive or Google Drive folder was found');
    await page.evaluate(() => {
      window.__mock.detected.push({ provider: 'oneDrive', root: 'C:\\Users\\me\\OneDrive', source: 'the OneDrive setting' });
    });
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByRole('heading', { name: 'Keep your devices in sync?' })).toBeVisible();
    await expect(page.getByLabel('OneDrive folder (C:\\Users\\me\\OneDrive)')).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Connect folder' })).toBeDisabled();
    expect(await page.evaluate(() => window.__mock.targets.length)).toBe(0);
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('dialog', { name: 'Do you work with a client in another time zone?' })).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => [window.__mock.syncPromptDone, window.__mock.clientZonePromptDone, window.__mock.settings.clientZone ?? null])).toEqual([true, true, null]);
    await expectClean(page, found);
  });
});

test.describe('screenshots', () => {
  for (const [theme, file] of THEMES) {
    test(`timeline in ${file}`, async ({ page }) => {
      const found = await open(page, `seed=demo&theme=${theme}`);
      await expect(page.getByTestId('shift-band').first()).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `timeline-${file}.png`) });
      await expectClean(page, found);
    });
  }

  test('timeline show both', async ({ page }) => {
    const found = await open(page, 'seed=demo&showBoth=1');
    await expect(page.getByTestId('work-window').first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'timeline-show-both.png') });
    await expectClean(page, found);
  });

  test('timeline live earnings', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    // Crossing a 15-minute step: the Billable amount steps from $315.00 to $337.50, with no rate or ticker beside it.
    await advance(page, 7 * 60 + 12);
    await expect(page.getByTestId('summary-today')).toContainText('$337.50');
    await page.screenshot({ path: path.join(SHOTS, 'timeline-live-earnings.png') });
    await expectClean(page, found);
  });

  test('timeline shift bands', async ({ page }) => {
    const found = await open(page, 'seed=demo');
    const day = page.getByRole('article', { name: 'Wed 11 Mar 2026' });
    await expect(day.getByTestId('shift-band')).toHaveCount(2);
    await day.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'timeline-shift-bands.png') });
    await expectClean(page, found);
  });
});
