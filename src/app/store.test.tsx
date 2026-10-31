// The clock ticks while the window can be seen, and only then. Time away is caught up on waking.
import { act, cleanup, render, screen } from '@testing-library/react';
import { emit } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyState, installMock } from '../mocks/ipcMock';
import { AppProvider, useApp, useAppState } from './store';

let hidden = false;
const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

function setHidden(value: boolean): void {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

function Clock() {
  const { nowSec } = useApp();
  return <span data-testid="now">{nowSec}</span>;
}

const shown = (): number => Number(screen.getByTestId('now').textContent);

async function start(): Promise<void> {
  const state = emptyState();
  installMock(state);
  render(<AppProvider fallback={() => <span>loading</span>}><Clock /></AppProvider>);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('the clock', () => {
  beforeEach(() => {
    hidden = false;
    vi.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z'), shouldAdvanceTime: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
    if (original) Object.defineProperty(Document.prototype, 'visibilityState', original);
  });

  it('ticks once a second while the page is visible', async () => {
    await start();
    const t0 = shown();
    await advance(5000);
    expect(shown()).toBe(t0 + 5);
  });

  it('sets no timer while the page is hidden, and is right the moment it is visible again', async () => {
    await start();
    const t0 = shown();
    act(() => setHidden(true));
    const pending = vi.getTimerCount();
    await advance(3_600_000);
    expect(shown()).toBe(t0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(pending);
    act(() => setHidden(false));
    expect(shown()).toBe(t0 + 3600);
    await advance(2000);
    expect(shown()).toBe(t0 + 3602);
  });

  it('also stops and wakes on what the backend says about the window', async () => {
    await start();
    const t0 = shown();
    await act(async () => {
      await emit('window-hidden');
      await vi.advanceTimersByTimeAsync(10);
    });
    await advance(60_000);
    expect(shown()).toBeLessThanOrEqual(t0 + 1);
    await act(async () => {
      await emit('window-shown');
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(shown()).toBeGreaterThanOrEqual(t0 + 60);
    const t1 = shown();
    await advance(3000);
    expect(shown()).toBe(t1 + 3);
  });

  it('wakes on focus even if no other signal came', async () => {
    await start();
    const t0 = shown();
    act(() => setHidden(true));
    hidden = false; // the signal for coming back never arrives
    await advance(10_000);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(shown()).toBe(t0 + 10);
    await advance(1000);
    expect(shown()).toBe(t0 + 11);
  });

  it('never leaves two timers running after repeated wakes', async () => {
    await start();
    const t0 = shown();
    for (let i = 0; i < 5; i += 1) act(() => void window.dispatchEvent(new Event('focus')));
    await advance(1000);
    expect(shown()).toBe(t0 + 1);
    const renders = vi.fn();
    cleanup();
    function Count() {
      const { nowSec } = useApp();
      renders();
      return <span>{nowSec}</span>;
    }
    installMock(emptyState());
    render(<AppProvider fallback={() => null}><Count /></AppProvider>);
    await advance(10);
    for (let i = 0; i < 5; i += 1) act(() => void window.dispatchEvent(new Event('focus')));
    renders.mockClear();
    for (let i = 0; i < 3; i += 1) await advance(1000);
    expect(renders.mock.calls.length).toBe(3);
  });
});

describe('useAppState', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z'), shouldAdvanceTime: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not re-render its reader on a tick, and does on a change of state', async () => {
    const renders = vi.fn();
    function Reader() {
      const { error, showError } = useAppState();
      renders();
      return (
        <button type="button" onClick={() => showError('boom')}>
          {error ?? 'fine'}
        </button>
      );
    }
    installMock(emptyState());
    render(<AppProvider fallback={() => null}><Reader /></AppProvider>);
    await advance(10);
    renders.mockClear();
    await advance(10_000);
    expect(renders).not.toHaveBeenCalled();
    act(() => screen.getByRole('button').click());
    expect(renders).toHaveBeenCalled();
    expect(screen.getByText('boom')).toBeTruthy();
  });
});
