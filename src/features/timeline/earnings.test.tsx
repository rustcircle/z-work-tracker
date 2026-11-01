// Earnings step with billable time; only the running task's elapsed clock ticks each second.
// The demo store starts at 15:20:01 UTC with "Logo concepts" counted at 3h25m01s today, rounded Up to 15
// minutes: Billable is 3h30m (USD 315.00) until counted time passes 3h30m, which is 4 minutes 59 seconds on.
import { act, cleanup, screen, within } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';

// Vitest does not stop a test body that runs out of time. Left going, its act() calls overlap the next test's, which
// leaves React's act depth above zero, and from then on no render flushes: amounts freeze and new trees stay empty.
// So the hook after each test waits for that test's whole body, including an act already on its way, and a loop stops
// at its next tick once its test has timed out, so the wait is short. A timeout then fails the one test it happened in.
let body: Promise<unknown> = Promise.resolve();
const whole =
  (run: (context: TestContext) => Promise<void>) =>
  (context: TestContext): Promise<void> => {
    const running = run(context);
    body = running.catch(() => undefined);
    return running;
  };
/** Far longer than what is left of a body once it has timed out, even on a machine slow enough for that to happen. */
const BODY_ENDS_MS = 60_000;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const tick = async (signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  await advance(1000);
};

const realTimeout = globalThis.setTimeout;

const ticker = () => within(screen.getByRole('article', { name: 'Logo concepts' }));
const todayLine = (): string => screen.getByTestId('summary-today').textContent ?? '';

/** A new tree renders and its clock goes on, unlike the empty or frozen ones that overlapping act() calls leave. */
const rendersAndCounts = async (signal: AbortSignal): Promise<void> => {
  const errors = vi.spyOn(console, 'error');
  boot(demoState());
  await advance(100);
  const clock = () => ticker().getByTestId('session-clock').textContent;
  const started = clock();
  for (let i = 0; i < 3; i += 1) await tick(signal);
  expect(clock()).not.toBe(started);
  expect(errors.mock.calls.flat().join(' ')).not.toMatch(/overlapping act/);
  errors.mockRestore();
};

describe('earnings and the clock', () => {
  beforeEach(() => {
    polyfillDom();
    vi.useFakeTimers({ now: new Date('2026-03-12T15:20:01Z') });
  });
  afterEach(async () => {
    await body;
    cleanup();
    clearMocks();
    vi.useRealTimers();
    // Set by a body that may never have got as far as putting it back.
    Reflect.deleteProperty(document, 'visibilityState');
  }, BODY_ENDS_MS);

  it('shows only the Billable amount: no exact accrual, no per-minute rate', whole(async () => {
    boot(demoState());
    await advance(100);
    expect(ticker().getByTestId('billable-now')).toHaveTextContent('$315.00');
    expect(document.body.textContent).not.toMatch(/Exact accrual/i);
    expect(document.body.textContent).not.toMatch(/\/min\b/);
    expect(document.body.textContent).not.toMatch(/running \+/);
    expect(todayLine()).toContain('$315.00');
    // The exact duration stays; the exact amount is gone from the day totals.
    const today = screen.getByRole('article', { name: 'Thu 12 Mar 2026' });
    expect(within(today).getByTestId('day-exact').textContent).not.toMatch(/[$€]/);
  }));

  it('the Timeline rows carry no exact amount at all: no column, no per-row figure, no tooltip earnings', whole(async () => {
    boot(demoState());
    await advance(100);
    const today = screen.getByRole('article', { name: 'Thu 12 Mar 2026' });
    expect(within(today).queryByRole('columnheader', { name: /Earnings/ })).toBeNull();
    for (const row of within(today).getAllByTestId('entry')) expect(row.textContent).not.toMatch(/[$€]\d/);
    expect(document.body.textContent).not.toMatch(/Exact earnings|Earnings \(exact\)/);
    // The running row's amount used to move each minute; now nothing in the rows can.
    const before = within(today).getAllByTestId('entry').map((r) => r.textContent);
    await advance(61_000);
    expect(within(screen.getByRole('article', { name: 'Thu 12 Mar 2026' })).getAllByTestId('entry').map((r) => (r.textContent ?? '').replace(/\d+h \d+m|\d+m|\d{2}:\d{2}/g, '')).every((t) => !/[$€]\d/.test(t))).toBe(true);
    expect(before.length).toBeGreaterThan(0);
    // The Billable amount stays in the day's totals.
    expect(todayLine()).toContain('$315.00');
  }));

  it('the amount holds still while seconds pass, and the session clock keeps counting', whole(async ({ signal }) => {
    boot(demoState());
    await advance(100);
    // Finding the card by role walks the whole page, about 20 times what a tick costs, so find it once.
    const logo = ticker();
    const clock = (): string => logo.getByTestId('session-clock').textContent ?? '';
    const seen = new Set<string>();
    const amounts = new Set<string>();
    for (let i = 0; i < 120; i += 1) {
      await tick(signal);
      seen.add(clock());
      amounts.add(logo.getByTestId('billable-now').textContent ?? '');
    }
    expect(seen.size).toBe(120);
    expect([...amounts]).toEqual(['$315.00']);
    expect(todayLine()).toContain('$315.00');
  }));

  it('steps up when billable time steps, in the ticker and in the totals together', whole(async ({ signal }) => {
    boot(demoState());
    await advance(100);
    // React sets the next timer after each render, so the test moves a second at a time like the clock does.
    const run = async (secs: number): Promise<void> => {
      for (let i = 0; i < secs; i += 1) await tick(signal);
    };
    await run(4 * 60);
    expect(ticker().getByTestId('billable-now')).toHaveTextContent('$315.00');
    await run(70);
    expect(ticker().getByTestId('billable-now')).toHaveTextContent('$337.50');
    expect(todayLine()).toContain('$337.50');
    expect(within(screen.getByRole('article', { name: 'Thu 12 Mar 2026' })).getByTestId('day-billable')).toHaveTextContent('3h 45m');
  }));

  it('does nothing while the window is hidden, and is right the moment it shows again', whole(async () => {
    boot(demoState());
    await advance(100);
    const timers = vi.getTimerCount();
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(30 * 60_000);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // 30 more minutes counted: 3h25 + 30m = 3h55m, rounded up to 4h00m.
    expect(ticker().getByTestId('billable-now')).toHaveTextContent('$360.00');
  }));

  describe('after a test runs out of time', () => {
    it.fails('stand-in: a body that outlasts its limit', whole(async ({ signal }) => {
      boot(demoState());
      await advance(100);
      for (let i = 0; i < 20_000; i += 1) await tick(signal);
    }), 50);

    it('the next test still renders, and its amounts still step', whole(async ({ signal }) => {
      const errors = vi.spyOn(console, 'error');
      boot(demoState());
      await advance(100);
      expect(ticker().getByTestId('billable-now')).toHaveTextContent('$315.00');
      for (let i = 0; i < 310; i += 1) await tick(signal);
      expect(ticker().getByTestId('billable-now')).toHaveTextContent('$337.50');
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/overlapping act/);
      errors.mockRestore();
    }));

    it.fails('stand-in: an act still on its way when the limit passes', whole(async () => {
      boot(demoState());
      await advance(100);
      await act(async () => {
        await new Promise((resolve) => realTimeout(resolve, 300));
      });
    }), 50);

    it('the next test still renders, as that act has ended first', whole(async ({ signal }) => {
      await rendersAndCounts(signal);
    }));

    it.fails('stand-in: a hidden window left behind when the limit passes', whole(async () => {
      boot(demoState());
      await advance(100);
      await act(async () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      throw new Error('stopped here, like a test out of time');
    }));

    it('the next test still sees a window that shows', whole(async ({ signal }) => {
      expect(document.visibilityState).toBe('visible');
      await rendersAndCounts(signal);
    }));
  });
});
