// Earnings step with billable time; only the running task's elapsed clock ticks each second.
// The demo store starts at 15:20:01 UTC with "Logo concepts" counted at 3h25m01s today, rounded Up to 15
// minutes: Billable is 3h30m (USD 315.00) until counted time passes 3h30m, which is 4 minutes 59 seconds on.
import { act, cleanup, screen, within } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const ticker = () => within(screen.getByRole('article', { name: 'Logo concepts' }));
const todayLine = (): string => screen.getByTestId('summary-today').textContent ?? '';

describe('earnings and the clock', () => {
  beforeEach(() => {
    polyfillDom();
    vi.useFakeTimers({ now: new Date('2026-03-12T15:20:01Z') });
  });
  afterEach(() => {
    cleanup();
    clearMocks();
    vi.useRealTimers();
  });

  it('shows only the Billable amount: no exact accrual, no per-minute rate', async () => {
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
  });

  it('the amount holds still while seconds pass, and the session clock keeps counting', async () => {
    boot(demoState());
    await advance(100);
    const clock = (): string => ticker().getByTestId('session-clock').textContent ?? '';
    const seen = new Set<string>();
    const amounts = new Set<string>();
    for (let i = 0; i < 120; i += 1) {
      await advance(1000);
      seen.add(clock());
      amounts.add(ticker().getByTestId('billable-now').textContent ?? '');
    }
    expect(seen.size).toBe(120);
    expect([...amounts]).toEqual(['$315.00']);
    expect(todayLine()).toContain('$315.00');
  });

  it('steps up when billable time steps, in the ticker and in the totals together', async () => {
    boot(demoState());
    await advance(100);
    // React sets the next timer after each render, so the test moves a second at a time like the clock does.
    const run = async (secs: number): Promise<void> => {
      for (let i = 0; i < secs; i += 1) await advance(1000);
    };
    await run(4 * 60);
    expect(ticker().getByTestId('billable-now')).toHaveTextContent('$315.00');
    await run(70);
    expect(ticker().getByTestId('billable-now')).toHaveTextContent('$337.50');
    expect(todayLine()).toContain('$337.50');
    expect(within(screen.getByRole('article', { name: 'Thu 12 Mar 2026' })).getByTestId('day-billable')).toHaveTextContent('3h 45m');
  });

  it('does nothing while the window is hidden, and is right the moment it shows again', async () => {
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
    Reflect.deleteProperty(document, 'visibilityState');
  });
});
