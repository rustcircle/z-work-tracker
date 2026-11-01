// A budget that can't flake, because it counts instead of timing: the shared clock ticks every second, and
// the charts are only drawn again when a figure could have moved, once a minute with a task running.
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { buildInsights } from './insights';
import { analyze } from './metrics';

vi.mock('./insights', async (original) => {
  const real = await original<typeof import('./insights')>();
  return { ...real, buildInsights: vi.fn(real.buildInsights) };
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

vi.mock('./metrics', async (original) => {
  const real = await original<typeof import('./metrics')>();
  return { ...real, analyze: vi.fn(real.analyze) };
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

  it('reads the exact moment, not the start of the minute, so a segment that just started has length', async () => {
    // 37 seconds into a minute (the backend is a second behind the page's clock in these tests).
    vi.setSystemTime(new Date('2026-03-12T15:20:38Z'));
    const s = demoState();
    s.now += 37;
    boot(s);
    await advance(50);
    act(() => screen.getByRole('tab', { name: 'Analysis' }).click());
    await advance(50);
    const at = vi.mocked(analyze).mock.calls.map((c) => c[2]);
    expect(at.length).toBeGreaterThan(0);
    // A floor to the minute would have given 0.
    expect((at.at(-1) ?? 0) % 60).toBe(37);
  });

  it('computes again when a step of billable time falls due, not a minute late', async () => {
    boot(demoState());
    await advance(50);
    act(() => screen.getByRole('tab', { name: 'Analysis' }).click());
    await advance(50);
    vi.mocked(analyze).mockClear();
    // Logo concepts has counted 3h25m01s and rounds Up to 15 minutes: the step to 3h45m is due 4m59s from 15:20:01.
    for (let i = 0; i < 301; i += 1) await advance(1000);
    const due = Date.parse('2026-03-12T15:20:01Z') / 1000 + 300;
    const clocks = vi.mocked(analyze).mock.calls.map((c) => c[2]);
    expect(clocks.some((c) => c >= due && c <= due + 1)).toBe(true);
  });
});
