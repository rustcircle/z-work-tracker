// The mock backend's clock-behind view: what `Service::clock_behind` gives the page, as the e2e build and the component tests get it.
// The backend decides from the newest change seen and its own clock; the mock holds that change as `MockState.newestStamp`.
import { describe, expect, it } from 'vitest';

import { toIso } from '../lib/tz';
import type { ClockBehindView, Snapshot } from '../lib/types';
import { demoState } from './demoSeed';
import { OTHER_DEVICE_NAME, clockBehindOf, emptyState, handle, type MockState } from './ipcMock';

const snap = (s: MockState): Snapshot => handle(s, 'get_snapshot', {}) as Snapshot;

/** The mock with the newest change seen saved `ahead` seconds after its clock. */
function aheadBy(ahead: number, causeDevice: string | null = OTHER_DEVICE_NAME): MockState {
  const s = demoState();
  s.newestStamp = { at: s.now + ahead, causeDevice };
  return s;
}

describe('clockBehindOf', () => {
  it('is null while no change seen is ahead, which is how both seeds start', () => {
    expect(emptyState().newestStamp).toBeNull();
    expect(clockBehindOf(emptyState())).toBeNull();
    expect(demoState().newestStamp).toBeNull();
    expect(clockBehindOf(demoState())).toBeNull();
  });

  it('is null at 119 s, and the view at 120 s: the line is for a clock that is wrong, not one that drifts', () => {
    expect(clockBehindOf(aheadBy(119))).toBeNull();
    const s = aheadBy(120);
    expect(clockBehindOf(s)).toEqual<ClockBehindView>({ behindSecs: 120, newestAt: toIso(s.now + 120), causeDevice: 'LAPTOP', capped: false });
  });

  it('gives the gap, when the newest change was saved as the backend writes a time, and the computer that saved it', () => {
    const s = aheadBy(5400);
    expect(clockBehindOf(s)).toEqual<ClockBehindView>({ behindSecs: 5400, newestAt: '2026-03-12T16:50:00Z', causeDevice: 'LAPTOP', capped: false });
  });

  it('has no computer to name when the change ahead was saved here', () => {
    expect(clockBehindOf(aheadBy(7200, null))).toMatchObject({ behindSecs: 7200, causeDevice: null });
  });

  it('is capped from a day ahead, the furthest a new change may be dated past the clock: 86,399 s is not, 86,400 s is', () => {
    expect(clockBehindOf(aheadBy(86_399))).toMatchObject({ behindSecs: 86_399, capped: false });
    expect(clockBehindOf(aheadBy(86_400))).toMatchObject({ behindSecs: 86_400, capped: true });
    expect(clockBehindOf(aheadBy(172_800))).toEqual<ClockBehindView>({ behindSecs: 172_800, newestAt: '2026-03-14T15:20:00Z', causeDevice: 'LAPTOP', capped: true });
  });

  it('says whether it is capped for a change saved here too', () => {
    expect(clockBehindOf(aheadBy(172_800, null))).toMatchObject({ causeDevice: null, capped: true });
    expect(clockBehindOf(aheadBy(7200, null))).toMatchObject({ causeDevice: null, capped: false });
  });

  it('is null for a newest change that is not ahead of the clock at all', () => {
    expect(clockBehindOf(aheadBy(0))).toBeNull();
    expect(clockBehindOf(aheadBy(-3600))).toBeNull();
  });
});

describe('the snapshot', () => {
  it('always carries clockBehind, null when there is none, as the backend always sends it', () => {
    const got = snap(demoState());
    expect(got).toHaveProperty('clockBehind', null);
  });

  it('carries the view while the newest change seen is 120 s or more ahead', () => {
    const s = aheadBy(5400);
    expect(snap(s).clockBehind).toEqual({ behindSecs: 5400, newestAt: toIso(s.now + 5400), causeDevice: 'LAPTOP', capped: false });
    expect(snap(aheadBy(60)).clockBehind).toBeNull();
  });

  it('always carries capped inside the view, true from a day ahead', () => {
    expect(snap(aheadBy(172_800)).clockBehind).toEqual({ behindSecs: 172_800, newestAt: '2026-03-14T15:20:00Z', causeDevice: 'LAPTOP', capped: true });
    expect(snap(aheadBy(5400)).clockBehind).toHaveProperty('capped', false);
  });

  it('follows newestStamp as it is set and cleared', () => {
    const s = demoState();
    expect(snap(s).clockBehind).toBeNull();
    s.newestStamp = { at: s.now + 600, causeDevice: 'Home PC' };
    expect(snap(s).clockBehind).toMatchObject({ behindSecs: 600, causeDevice: 'Home PC' });
    s.newestStamp = null;
    expect(snap(s).clockBehind).toBeNull();
  });

  it('follows the mock clock: no longer capped once the gap is under a day, with no state to reset', () => {
    const s = aheadBy(90_000);
    expect(snap(s).clockBehind).toMatchObject({ behindSecs: 90_000, capped: true });
    s.now += 3600;
    expect(snap(s).clockBehind).toMatchObject({ behindSecs: 86_400, capped: true });
    s.now += 1;
    expect(snap(s).clockBehind).toMatchObject({ behindSecs: 86_399, capped: false });
  });

  it('follows the mock clock: the gap shrinks as time passes, and clears once the clock has caught up, with no state to reset', () => {
    const s = aheadBy(5400);
    s.now += 3600;
    expect(snap(s).clockBehind).toMatchObject({ behindSecs: 1800 });
    s.now += 1680;
    expect(snap(s).clockBehind).toMatchObject({ behindSecs: 120 });
    s.now += 1;
    expect(snap(s).clockBehind).toBeNull();
  });
});
