import { expect, test, type Page } from '@playwright/test';

import { card, expectClean, open } from './support';

// Space never starts, pauses, resumes or stops a timer. The app is worked with the mouse, so a Space that lands on a timer button
// (one a click left focused, or one reached with Tab) must do nothing at all, held down or not, while Enter still presses it. Real
// Chromium and real key events: the browser presses a focused button for Space as the key comes up, and that is what this is about.

interface SpaceEvent {
  type: 'keydown' | 'keyup';
  repeat: boolean;
  prevented: boolean;
}

declare global {
  interface Window {
    __space: SpaceEvent[];
  }
}

const TIMER_COMMANDS = ['create_task', 'start_task', 'resume_task', 'pause_task', 'stop_task', 'request_remote_pause'];

/** The timer commands the page has sent so far, in order. */
const sent = (page: Page): Promise<string[]> => page.evaluate((all) => window.__mock.calls.map((c) => c.cmd).filter((c) => all.includes(c)), TIMER_COMMANDS);
const stateOf = (page: Page, id: string) => page.evaluate((i) => window.__mock.tasks.find((t) => t.id === i)?.state, id);
const taskCount = (page: Page) => page.evaluate(() => window.__mock.tasks.length);
/** Every task's state, every segment and every pause request, as the mock backend holds them: what a timer command could change. */
const world = (page: Page): Promise<string> => page.evaluate(() => JSON.stringify({ tasks: window.__mock.tasks.map((t) => [t.id, t.state]), segments: window.__mock.segments, requests: window.__mock.pauseRequests }));

/** Notes each Space key event once the app's own handlers are done with it: whether it was cancelled, and whether it was an auto-repeat. */
async function recordSpace(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__space = [];
    for (const type of ['keydown', 'keyup'] as const) {
      document.addEventListener(type, (e) => {
        if (e.code === 'Space') window.__space.push({ type, repeat: e.repeat, prevented: e.defaultPrevented });
      });
    }
  });
}
const forgetSpace = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__space = [];
  });

/** Space every way a keyboard sends it: pressed and let go, and held down while the keyboard repeats it. */
async function spaceEveryWay(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await page.keyboard.down('Space');
  for (let i = 0; i < 5; i += 1) await page.keyboard.down('Space');
  await page.keyboard.up('Space');
}

/** The Space events that reached the focused timer button were all cancelled, the repeats of a held key among them. */
async function expectSpaceRefused(page: Page): Promise<void> {
  const seen = await page.evaluate(() => window.__space);
  expect(seen.filter((e) => e.type === 'keydown' && !e.repeat).length, 'Space presses sent').toBeGreaterThanOrEqual(2);
  expect(seen.filter((e) => e.type === 'keydown' && e.repeat).length, 'auto-repeats sent').toBeGreaterThanOrEqual(4);
  expect(seen.filter((e) => e.type === 'keyup').length, 'Space releases sent').toBeGreaterThanOrEqual(2);
  expect(seen.filter((e) => !e.prevented), 'Space events the app left to the browser').toEqual([]);
}

const BUTTONS = [
  { button: 'Start', command: 'start_task', task: 'Social templates', id: 't-next', was: 'draft', then: 'running' },
  { button: 'Pause', command: 'pause_task', task: 'Logo concepts', id: 't-logo', was: 'running', then: 'paused' },
  { button: 'Resume', command: 'resume_task', task: 'Brand guidelines', id: 't-guide', was: 'paused', then: 'running' },
  { button: 'Stop', command: 'stop_task', task: 'Logo concepts', id: 't-logo', was: 'running', then: 'stopped' },
] as const;

test.describe('Space on a task card', () => {
  for (const b of BUTTONS) {
    test(`${b.button}: a click the backend refused leaves it focused, and Space does nothing while Enter presses it`, async ({ page }) => {
      const found = await open(page, 'seed=demo', true, true);
      await recordSpace(page);
      await page.evaluate((cmd) => {
        window.__mock.failNext = [cmd];
      }, b.command);
      const button = card(page, b.task).getByRole('button', { name: b.button, exact: true });
      await button.click();
      // The refusal is shown and nothing changed. The mouse left the button focused and ready, which is the case the owner met.
      await expect(page.getByRole('alert').filter({ hasText: `mock: ${b.command} failed` })).toBeVisible();
      await expect(button).toBeFocused();
      await expect(button).toBeEnabled();
      expect(await sent(page)).toEqual([b.command]);
      expect(await stateOf(page, b.id)).toBe(b.was);
      const before = await world(page);

      await forgetSpace(page);
      await spaceEveryWay(page);

      expect(await sent(page)).toEqual([b.command]);
      expect(await world(page)).toBe(before);
      await expect(button).toBeFocused();
      await expectSpaceRefused(page);

      // The keyboard still works the button: Enter sends the command again, once.
      await page.keyboard.press('Enter');
      await expect.poll(() => stateOf(page, b.id)).toBe(b.then);
      expect(await sent(page)).toEqual([b.command, b.command]);
      await expectClean(page, found);
    });
  }

  test('after the mouse starts, pauses and resumes a task, Space and a held Space change nothing', async ({ page }) => {
    const found = await open(page, 'seed=demo', true, true);
    await recordSpace(page);
    const mine = card(page, 'Social templates');
    const button = (name: string) => mine.getByRole('button', { name, exact: true });
    const steps = [
      { click: 'Start', state: 'running', live: 'Pause' },
      { click: 'Pause', state: 'paused', live: 'Resume' },
      { click: 'Resume', state: 'running', live: 'Stop' },
    ] as const;
    for (const step of steps) {
      await button(step.click).click();
      await expect(mine).toHaveAttribute('data-state', step.state);
      const settled = await world(page);
      const commands = await sent(page);

      // Space where the click left the keyboard focus,
      await spaceEveryWay(page);
      expect(await sent(page), `after ${step.click}, Space`).toEqual(commands);
      expect(await world(page), `after ${step.click}, Space`).toBe(settled);

      // and on the button that is live now, which is where Tab would have taken it.
      await button(step.live).focus();
      await forgetSpace(page);
      await spaceEveryWay(page);
      expect(await sent(page), `after ${step.click}, Space on ${step.live}`).toEqual(commands);
      expect(await world(page), `after ${step.click}, Space on ${step.live}`).toBe(settled);
      await expectSpaceRefused(page);
    }
    await expectClean(page, found);
  });
});

test.describe('Space elsewhere that starts or ends a timer', () => {
  test('Start in the new task form ignores Space, Space still types in its fields, and Enter starts the task', async ({ page }) => {
    const found = await open(page, 'seed=demo', true, true);
    await recordSpace(page);
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    const name = form.getByRole('textbox', { name: 'Task name' });
    await name.fill('');
    await page.keyboard.type('Logo round two');
    await expect(name).toHaveValue('Logo round two');

    const start = form.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeEnabled();
    const [tasks, commands] = [await taskCount(page), await sent(page)];
    await start.focus();
    await forgetSpace(page);
    await spaceEveryWay(page);
    expect(await sent(page)).toEqual(commands);
    expect(await taskCount(page)).toBe(tasks);
    await expect(start).toBeFocused();
    await expectSpaceRefused(page);

    await page.keyboard.press('Enter');
    await expect.poll(() => taskCount(page)).toBe(tasks + 1);
    expect(await sent(page)).toEqual(['create_task', 'start_task']);
    await expectClean(page, found);
  });

  test('Pause in the forgotten-timer reminder ignores Space, and Enter pauses the task', async ({ page }) => {
    const found = await open(page, 'seed=demo', true, true);
    await recordSpace(page);
    await page.evaluate(async () => {
      window.__mock.reminderOverride = { kind: 'pastShift', taskId: 't-logo', shift: 'Morning', ended: '2026-03-12T13:00:00Z' };
      await window.__mockEmit('state-changed');
    });
    const banner = page.getByTestId('reminder-banner');
    const pause = banner.getByRole('button', { name: 'Pause', exact: true });
    await expect(pause).toBeVisible();
    const before = await world(page);
    await pause.focus();
    await forgetSpace(page);
    await spaceEveryWay(page);
    expect(await sent(page)).toEqual([]);
    expect(await world(page)).toBe(before);
    await expect(pause).toBeFocused();
    await expectSpaceRefused(page);

    await page.keyboard.press('Enter');
    await expect.poll(() => stateOf(page, 't-logo')).toBe('paused');
    await expect(banner).toBeHidden();
    expect(await sent(page)).toEqual(['pause_task']);
    await expectClean(page, found);
  });

  test('Pause it from here ignores Space, and Enter sends the one request', async ({ page }) => {
    const found = await open(page, 'seed=demo', true, true);
    await recordSpace(page);
    await page.evaluate(async () => {
      const task = window.__mock.tasks.find((t) => t.id === 't-logo');
      const running = window.__mock.segments.find((s) => s.taskId === 't-logo' && s.end === null);
      if (task && running) {
        running.deviceId = 'other-device';
        task.runningElsewhere = 'Office PC';
      }
      await window.__mockEmit('state-changed');
    });
    const logo = card(page, 'Logo concepts');
    const ask = logo.getByRole('button', { name: /Pause it from here/ });
    await expect(ask).toBeVisible();
    const before = await world(page);
    await ask.focus();
    await forgetSpace(page);
    await spaceEveryWay(page);
    expect(await sent(page)).toEqual([]);
    expect(await world(page)).toBe(before);
    await expect(ask).toBeFocused();
    await expectSpaceRefused(page);

    await page.keyboard.press('Enter');
    await expect(logo.getByText('Pause requested')).toBeVisible();
    expect(await sent(page)).toEqual(['request_remote_pause']);
    await expectClean(page, found);
  });
});
