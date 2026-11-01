// Time moves the screen only when something can change: a step of billable time, a completed minute of
// the running stretch, midnight, or new data. These tests count renders and timers instead of timing them.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { roundSeconds, type Rule } from '../lib/billing';
import { emptyState, installMock } from '../mocks/ipcMock';
import { nextMarkIn, nextStepIn, nextWake, useStepNow, EXACT_REFRESH_SECS } from './stepClock';
import { AppProvider } from './store';

describe('nextStepIn', () => {
  const methods = ['up', 'down', 'nearest'] as const;
  it.each([1, 5, 15, 30, 60])('names exactly the second billable time next changes (%i minute increment)', (minutes) => {
    const inc = minutes * 60;
    for (const method of methods) {
      const rule: Rule = { incrementMinutes: minutes, method };
      for (let counted = 0; counted <= inc * 2 + 3; counted += 1) {
        let d = 1;
        while (roundSeconds(counted + d, minutes, method) === roundSeconds(counted, minutes, method)) d += 1;
        expect(nextStepIn(counted, rule), `${method} ${minutes}m at ${counted}s`).toBe(d);
      }
    }
  });

  it('with Up, work that has just started is already on its first increment, and the next step is a whole increment away', () => {
    const rule: Rule = { incrementMinutes: 15, method: 'up' };
    expect(roundSeconds(1, 15, 'up')).toBe(900);
    expect(nextStepIn(1, rule)).toBe(900);
    expect(nextStepIn(900, rule)).toBe(1);
  });

  it('with rounding off, billable follows exact time and is refreshed once a minute, not each second', () => {
    expect(nextStepIn(1234, { incrementMinutes: 0, method: 'up' })).toBe(EXACT_REFRESH_SECS);
    expect(EXACT_REFRESH_SECS).toBe(60);
  });
});

describe('nextMarkIn and nextWake', () => {
  it('counts to the next whole minute of the running stretch, so a duration reads 5m and never a stale 4m 37s', () => {
    expect(nextMarkIn(1000, 1000)).toBe(60);
    expect(nextMarkIn(1059, 1000)).toBe(1);
    expect(nextMarkIn(1061, 1000)).toBe(59);
    expect(nextMarkIn(125, null)).toBe(55);
  });

  it('wakes at the soonest of a step, a minute mark and midnight', () => {
    const up: Rule = { incrementMinutes: 15, method: 'up' };
    expect(nextWake([{ counted: 899, rule: up }], 1000, 1000, null)).toBe(2);
    expect(nextWake([{ counted: 100, rule: up }], 1000, 1000, null)).toBe(60);
    expect(nextWake([{ counted: 100, rule: up }], 1000, 1000, 7)).toBe(7);
    expect(nextWake([], 1000, null, null)).toBeGreaterThanOrEqual(1);
  });
});

let hidden = false;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useStepNow', () => {
  beforeEach(() => {
    hidden = false;
    vi.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z'), shouldAdvanceTime: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  function Reader({ wake, onRender, dataKey }: { wake: number | null; onRender: () => void; dataKey: unknown }) {
    const now = useStepNow(dataKey, () => wake);
    onRender();
    return <span data-testid="step">{now}</span>;
  }
  const shown = (): number => Number(screen.getByTestId('step').textContent);

  it('renders only when the wake it asked for arrives, and not at all when nothing runs', async () => {
    const renders = vi.fn();
    installMock(emptyState());
    const { rerender } = render(<AppProvider fallback={() => null}><Reader wake={null} onRender={renders} dataKey="a" /></AppProvider>);
    await advance(10);
    renders.mockClear();
    await advance(600_000);
    expect(renders).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(3);
    // Something starts running, wanting a look every 300 s. That arrives as new data, which re-arms the timer.
    rerender(<AppProvider fallback={() => null}><Reader wake={300} onRender={renders} dataKey="b" /></AppProvider>);
    await advance(10);
    const t0 = shown();
    renders.mockClear();
    await advance(299_000);
    expect(renders).not.toHaveBeenCalled();
    await advance(2000);
    expect(shown()).toBeGreaterThanOrEqual(t0 + 300);
    expect(renders.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('sets no timer while the window is hidden and reads the clock the moment it is visible again', async () => {
    installMock(emptyState());
    render(<AppProvider fallback={() => null}><Reader wake={10} onRender={() => undefined} dataKey="a" /></AppProvider>);
    await advance(10);
    const t0 = shown();
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(3_600_000);
    expect(shown()).toBeLessThanOrEqual(t0 + 10);
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(shown()).toBeGreaterThanOrEqual(t0 + 3600);
  });

  it('reads the clock again when the data changes', async () => {
    installMock(emptyState());
    const { rerender } = render(<AppProvider fallback={() => null}><Reader wake={null} onRender={() => undefined} dataKey="a" /></AppProvider>);
    await advance(10);
    const t0 = shown();
    await advance(5000);
    expect(shown()).toBe(t0);
    rerender(<AppProvider fallback={() => null}><Reader wake={null} onRender={() => undefined} dataKey="b" /></AppProvider>);
    expect(shown()).toBeGreaterThanOrEqual(t0 + 5);
  });
});
