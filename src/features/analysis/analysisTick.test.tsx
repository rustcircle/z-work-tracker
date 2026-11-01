// A budget that can't flake, because it counts instead of timing: the shared clock ticks every second, and
// the charts are only drawn again when a figure could have moved, once a minute with a task running.
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { buildInsights } from './insights';

vi.mock('./insights', async (original) => {
  const real = await original<typeof import('./insights')>();
  return { ...real, buildInsights: vi.fn(real.buildInsights) };
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('Analysis and the clock', () => {
  beforeEach(() => {
    polyfillDom();
    vi.useFakeTimers({ now: new Date('2026-03-12T15:20:01Z') });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('draws the charts once a minute with a task running, not once per second', async () => {
    boot(demoState());
    await advance(50);
    act(() => screen.getByRole('tab', { name: 'Analysis' }).click());
    await advance(50);
    // Line up with a step of the clock, then count one second at a time.
    await advance(60_000);
    const draws = vi.mocked(buildInsights);
    draws.mockClear();
    for (let i = 0; i < 150; i += 1) await advance(1000);
    // 150 seconds hold two or three minute steps, against 150 ticks.
    expect(draws.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(draws.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
