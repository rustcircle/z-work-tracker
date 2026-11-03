// ClockBanner: the line that says this computer's clock is behind the newest change it has seen, in exact words. The words come first,
// as plain functions. Then the line runs on the mock backend with a real AppProvider, the way the page does: in the whole app, in the
// setup wizard (which stands in for the Shell), and with time passing on the page between two snapshots.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../app/store';
import { parseIso, toIso } from '../lib/tz';
import type { ClockBehindView } from '../lib/types';
import { demoState } from '../mocks/demoSeed';
import { clockBehindOf, emptyState, installMock, seedLease, type MockState } from '../mocks/ipcMock';
import { CLOCK_BEHIND_CAPPED_SECS, CLOCK_BEHIND_WARN_SECS, ClockBanner, behindSpan, clockBehindParts, clockBehindText } from './ClockBanner';
import { ageText } from './TakeOverDialog';
import { boot, polyfillDom } from './testKit';

afterEach(() => {
  cleanup();
  clearMocks();
});

/** The demo's clock: 12 March 2026 15:20 UTC. */
const NOW = parseIso('2026-03-12T15:20:00Z');

/** What the backend sends when the newest change seen was saved `ahead` seconds after `NOW`: capped from a day on. */
const view = (ahead: number, over: Partial<ClockBehindView> = {}): ClockBehindView => ({ behindSecs: ahead, newestAt: toIso(NOW + ahead), causeDevice: 'LAPTOP', capped: ahead >= 86_400, ...over });

const OTHER_COMPUTER =
  "This computer's clock is 1 h 30 min behind a change saved on LAPTOP at 16:50. New changes here are still dated after it, so they count as the newest. Check the date and time on both computers: one of them is wrong.";
const THIS_COMPUTER =
  "This computer's clock is 2 h behind a change saved here at 17:20, so it seems to have been set back. New changes are still dated after that one, so they count as the newest. Check this computer's date and time.";
const CAPPED_OTHER =
  "This computer's clock is 2 days behind a change saved on LAPTOP at 14 Mar 15:20. Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check the date and time on both computers.";
const CAPPED_THIS =
  "This computer's clock is 2 days behind a change saved here at 14 Mar 15:20, so it seems to have been set back. Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check this computer's date and time.";

describe('behindSpan', () => {
  it.each([
    [30, 'less than a minute'],
    [300, '5 min'],
    [3600, '1 h'],
    [5400, '1 h 30 min'],
    [86_400, '1 day'],
    [3 * 86_400 + 5, '3 days'],
  ])('behindSpan(%i) is %s', (secs, want) => {
    expect(behindSpan(secs)).toBe(want);
  });

  it.each([
    [0, 'less than a minute'],
    [59, 'less than a minute'],
    [60, '1 min'],
    [119, '1 min'],
    [59 * 60 + 59, '59 min'],
    [3600 + 60, '1 h 1 min'],
    [23 * 3600 + 59 * 60 + 59, '23 h 59 min'],
    [86_400 + 23 * 3600, '1 day'],
    [2 * 86_400 - 1, '1 day'],
    [2 * 86_400, '2 days'],
    [300 * 86_400, '300 days'],
    [-30, 'less than a minute'],
  ])('at the edge of a unit, behindSpan(%i) is %s', (secs, want) => {
    expect(behindSpan(secs)).toBe(want);
  });

  it('says what the lease line says for any gap, since both are the backend’s span_text words', () => {
    for (const edge of [60, 3600, 86_400, 2 * 86_400]) {
      for (const secs of [edge - 1, edge, edge + 1]) expect(behindSpan(secs), `${secs} s`).toBe(ageText(secs));
    }
    const differ: number[] = [];
    for (let secs = -5; secs <= 4 * 86_400; secs += 7) if (behindSpan(secs) !== ageText(secs)) differ.push(secs);
    expect(differ).toEqual([]);
  });
});

describe('clockBehindText', () => {
  it('is null without a view, and for a snapshot that leaves the field out', () => {
    expect(clockBehindText(null, NOW, 'UTC')).toBeNull();
    expect(clockBehindText(undefined, NOW, 'UTC')).toBeNull();
  });

  it('is null when the newest change is 119 s ahead, and the words at 120 s: a clock that is wrong, not one that drifts', () => {
    expect(clockBehindText(view(119), NOW, 'UTC')).toBeNull();
    expect(clockBehindText(view(120), NOW, 'UTC')).toContain("This computer's clock is 2 min behind");
    expect(CLOCK_BEHIND_WARN_SECS).toBe(120);
  });

  it('says it for a change saved on another computer, in exactly these words', () => {
    expect(clockBehindText(view(5400), NOW, 'UTC')).toBe(OTHER_COMPUTER);
  });

  it('says it for a change saved on this computer, in exactly these words', () => {
    expect(clockBehindText(view(7200, { causeDevice: null }), NOW, 'UTC')).toBe(THIS_COMPUTER);
  });

  it('from a gap of a day says that changes made here can’t be dated after it, for another computer, in exactly these words', () => {
    expect(clockBehindText(view(172_800), NOW, 'UTC')).toBe(CAPPED_OTHER);
  });

  it('says the same of a change saved on this computer, after the sentence about the clock having been set back, and asks to check only this computer', () => {
    expect(clockBehindText(view(172_800, { causeDevice: null }), NOW, 'UTC')).toBe(CAPPED_THIS);
  });

  it('asks to check this computer only when the change was saved here, and both computers when it was saved on another', () => {
    const cant = "Changes made here can't be dated after it until the clock is fixed, so they may lose to it.";
    const here = clockBehindText(view(172_800, { causeDevice: null }), NOW, 'UTC');
    const other = clockBehindText(view(172_800, { causeDevice: 'LAPTOP' }), NOW, 'UTC');
    expect(here?.endsWith(`${cant} Check this computer's date and time.`)).toBe(true);
    expect(other?.endsWith(`${cant} Check the date and time on both computers.`)).toBe(true);
    expect(here).not.toContain('both computers');
    // Not only in the capped words: the plain words for this computer ask the same of it.
    expect(clockBehindText(view(7200, { causeDevice: null }), NOW, 'UTC')?.endsWith("Check this computer's date and time.")).toBe(true);
  });

  it('no longer says new changes count as the newest once they can’t be dated after the newest one', () => {
    for (const causeDevice of ['LAPTOP', null]) {
      const text = clockBehindText(view(172_800, { causeDevice }), NOW, 'UTC');
      expect(text, String(causeDevice)).not.toContain('count as the newest');
      expect(text, String(causeDevice)).toContain("Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check ");
    }
  });

  it('follows capped as the backend sent it: a gap of a day or more that the backend did not cap keeps the plain words', () => {
    expect(clockBehindText(view(172_800, { capped: false }), NOW, 'UTC')).toContain('so they count as the newest');
    expect(clockBehindText(view(172_800, { capped: false, causeDevice: null }), NOW, 'UTC')).toContain('so they count as the newest');
  });

  it('says the capped words only while the gap on the page clock is a day or more, whatever capped was when the snapshot came', () => {
    expect(CLOCK_BEHIND_CAPPED_SECS).toBe(86_400);
    for (const causeDevice of ['LAPTOP', null]) {
      const at = (gap: number) => clockBehindText(view(gap, { capped: true, causeDevice }), NOW, 'UTC') ?? '';
      expect(at(86_400), String(causeDevice)).toContain('so they may lose to it');
      expect(at(86_401), String(causeDevice)).toContain('so they may lose to it');
      expect(at(86_399), String(causeDevice)).toContain('so they count as the newest');
      expect(at(86_399), String(causeDevice)).not.toContain('may lose to it');
      expect(at(5400), String(causeDevice)).toContain('so they count as the newest');
    }
  });

  it('goes back from the capped words to the plain ones as the page clock moves a capped gap under a day, with no new view', () => {
    const capped = view(86_450, { capped: true });
    expect(clockBehindText(capped, NOW, 'UTC')).toContain('so they may lose to it');
    expect(clockBehindText(capped, NOW + 50, 'UTC')).toContain('so they may lose to it');
    const later = clockBehindText(capped, NOW + 60, 'UTC') ?? '';
    expect(later).toContain('is 23 h 59 min behind');
    expect(later).toContain('so they count as the newest');
    expect(later).not.toContain('may lose to it');
  });

  it('names the computer as the backend gave it', () => {
    expect(clockBehindText(view(5400, { causeDevice: 'Home PC' }), NOW, 'UTC')).toContain('a change saved on Home PC at 16:50.');
  });

  it('gives the time of the change on the wall clock of the zone it is told, and the day when it is not today', () => {
    // 16:50 UTC is 12:50 in New York, which is on summer time from 8 March.
    expect(clockBehindText(view(5400), NOW, 'America/New_York')).toContain('LAPTOP at 12:50.');
    // 23:30 UTC and a change 2 h ahead: 13 March 01:30 UTC, not today.
    const late = parseIso('2026-03-12T23:30:00Z');
    expect(clockBehindText({ behindSecs: 7200, newestAt: toIso(late + 7200), causeDevice: 'LAPTOP', capped: false }, late, 'UTC')).toContain('LAPTOP at 13 Mar 01:30.');
    expect(clockBehindText({ behindSecs: 7200, newestAt: toIso(late + 7200), causeDevice: null, capped: false }, late, 'UTC')).toContain('saved here at 13 Mar 01:30, so it seems');
  });

  it('works the gap out from the time of the change and the page clock, not from behindSecs, so a line left up for an hour moves on', () => {
    expect(clockBehindText(view(5400, { behindSecs: 1 }), NOW, 'UTC')).toContain('is 1 h 30 min behind');
    expect(clockBehindText(view(5400), NOW + 3600, 'UTC')).toContain('is 30 min behind');
    expect(clockBehindText(view(5400), NOW + 5400 - 119, 'UTC')).toBeNull();
  });

  it('counts days for a clock far behind', () => {
    expect(clockBehindText(view(300 * 86_400), NOW, 'UTC')).toContain('is 300 days behind');
  });

  it('says nothing for a time it cannot read, rather than NaN', () => {
    expect(clockBehindText(view(5400, { newestAt: 'soon' }), NOW, 'UTC')).toBeNull();
    expect(clockBehindText(view(5400, { newestAt: '' }), NOW, 'UTC')).toBeNull();
  });

  it.each([
    ['another computer', 5400, 'LAPTOP'],
    ['this computer', 5400, null],
    ['another computer, capped', 172_800, 'LAPTOP'],
    ['this computer, capped', 172_800, null],
  ])('puts no dash in the wording for %s', (_who, secs, causeDevice) => {
    expect(clockBehindText(view(secs, { causeDevice }), NOW, 'UTC')).not.toMatch(/[\u2013\u2014]/);
  });

  it.each([[119], [120]])('draws the line at the gap where the mock backend does (%i s ahead)', (ahead) => {
    const s = demoState();
    s.newestStamp = { at: s.now + ahead, causeDevice: 'LAPTOP' };
    const shown = ahead >= CLOCK_BEHIND_WARN_SECS;
    expect(clockBehindOf(s) !== null).toBe(shown);
    expect(clockBehindText(view(ahead), s.now, 'UTC') !== null).toBe(shown);
  });
});

describe('clockBehindParts', () => {
  it('sets the gap, which moves by itself, between the rest of the words', () => {
    expect(clockBehindParts(view(5400), NOW, 'UTC')).toEqual({
      before: "This computer's clock is ",
      gap: '1 h 30 min',
      after: ' behind a change saved on LAPTOP at 16:50. New changes here are still dated after it, so they count as the newest. Check the date and time on both computers: one of them is wrong.',
    });
  });

  it('is the words of clockBehindText in every case, and null where that is', () => {
    for (const v of [view(5400), view(7200, { causeDevice: null }), view(172_800), view(172_800, { causeDevice: null })]) {
      const parts = clockBehindParts(v, NOW, 'UTC');
      expect(parts && parts.before + parts.gap + parts.after).toBe(clockBehindText(v, NOW, 'UTC'));
    }
    for (const v of [null, undefined, view(119), view(5400, { newestAt: 'soon' })]) expect(clockBehindParts(v, NOW, 'UTC')).toBeNull();
  });

  it('changes the gap alone as the page clock moves on: what comes before it and after it stays as it was', () => {
    const first = clockBehindParts(view(5400), NOW, 'UTC');
    const later = clockBehindParts(view(5400), NOW + 3600, 'UTC');
    expect(first?.gap).toBe('1 h 30 min');
    expect(later?.gap).toBe('30 min');
    expect({ before: later?.before, after: later?.after }).toEqual({ before: first?.before, after: first?.after });
  });
});

/** The demo with the newest change seen saved `secs` after its clock, on LAPTOP unless `causeDevice` says otherwise. */
function ahead(secs: number, causeDevice: string | null = 'LAPTOP'): MockState {
  const s = demoState();
  s.newestStamp = { at: s.now + secs, causeDevice };
  return s;
}

/** Lets the page take in whatever the test changed in the mock, the way a state-changed event from the backend does. */
async function arrives(change: () => void): Promise<void> {
  change();
  await act(async () => {
    await emit('state-changed');
  });
}

describe('the line in the app', () => {
  beforeEach(polyfillDom);

  it('is a status among the banners above the tabs, with a warning look and the words for another computer', async () => {
    boot(ahead(5400));
    const line = await screen.findByTestId('clock-behind');
    expect(line).toBeVisible();
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveClass('banner', 'banner-warning');
    expect(line.parentElement).toHaveClass('banners');
    expect(line.textContent).toBe(OTHER_COMPUTER);
    expect(line.compareDocumentPosition(screen.getByRole('tablist', { name: 'Sections' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has the words for this computer when the change ahead was saved here', async () => {
    boot(ahead(7200, null));
    expect((await screen.findByTestId('clock-behind')).textContent).toBe(THIS_COMPUTER);
  });

  it('gives the time of the change in My zone, not in the zone the Timeline is showing', async () => {
    // Client time is picked in the zone bar, a setting that stays: America/New_York, on summer time since 8 March. My zone is Lisbon, on UTC.
    const s = ahead(5400);
    s.settings.activeZone = 'America/New_York';
    boot(s);
    const line = await screen.findByTestId('clock-behind');
    // 16:50 UTC. In New York it would read 12:50, hours before the clock the person is told to compare it with.
    expect(line.textContent).toBe(OTHER_COMPUTER);
    expect(line.textContent).toContain('saved on LAPTOP at 16:50.');
    expect(line.textContent).not.toContain('12:50');
  });

  it('keeps My zone for the time of the change when the zone bar shows UTC, and for a change saved here', async () => {
    const s = ahead(7200, null);
    s.settings.activeZone = 'UTC';
    s.settings.myZone = 'America/New_York';
    boot(s);
    // 17:20 UTC is 13:20 in New York, My zone here.
    expect((await screen.findByTestId('clock-behind')).textContent).toContain('saved here at 13:20, so it seems to have been set back.');
  });

  it('says changes made here can’t be dated after it from a gap of a day, for another computer and for this one', async () => {
    boot(ahead(172_800));
    expect((await screen.findByTestId('clock-behind')).textContent).toBe(CAPPED_OTHER);
  });

  it('says the same of a change saved here', async () => {
    boot(ahead(172_800, null));
    expect((await screen.findByTestId('clock-behind')).textContent).toBe(CAPPED_THIS);
  });

  it('goes back to the plain words when a snapshot says the gap is under a day', async () => {
    const s = ahead(90_000);
    boot(s);
    expect((await screen.findByTestId('clock-behind')).textContent).toContain('so they may lose to it.');
    await arrives(() => {
      s.now += 3700;
    });
    await waitFor(() => expect(screen.getByTestId('clock-behind').textContent).toContain('is 23 h 58 min behind'));
    expect(screen.getByTestId('clock-behind').textContent).toContain('so they count as the newest.');
    expect(screen.getByTestId('clock-behind').textContent).not.toContain('may lose to it');
  });

  it('keeps the moving gap out of what a screen reader is told, since it changes every minute, and only that', async () => {
    boot(ahead(5400));
    const line = await screen.findByTestId('clock-behind');
    expect(line).toHaveAttribute('role', 'status');
    expect(within(line).getByText('1 h 30 min')).toHaveAttribute('aria-live', 'off');
    expect(line.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(line.textContent).toBe(OTHER_COMPUTER);
  });

  it('has no dismiss button: it stays while it applies, as the backend’s warnings do', async () => {
    boot(ahead(5400));
    expect(within(await screen.findByTestId('clock-behind')).queryAllByRole('button')).toEqual([]);
  });

  it('is not there without a view from the backend', async () => {
    boot(demoState());
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.queryByTestId('clock-behind')).toBeNull();
  });

  it('is not there for a gap under 120 s', async () => {
    boot(ahead(119));
    await screen.findByRole('tab', { name: 'Timeline' });
    expect(screen.queryByTestId('clock-behind')).toBeNull();
  });

  it('sits right after the lease line, which comes first, and before the tabs', async () => {
    const s = ahead(5400);
    seedLease(s, 'live');
    boot(s);
    const lease = await screen.findByTestId('lease-banner');
    const clock = await screen.findByTestId('clock-behind');
    expect(clock.parentElement).toBe(lease.parentElement);
    expect(lease.nextElementSibling).toBe(clock);
  });

  it('stays on every tab', async () => {
    const user = userEvent.setup();
    boot(ahead(5400));
    await screen.findByTestId('clock-behind');
    for (const name of ['Billing', 'Settings', 'Timeline']) {
      await user.click(screen.getByRole('tab', { name }));
      expect(screen.getByTestId('clock-behind')).toBeVisible();
    }
  });

  it('follows the backend: the words change with who saved the change, and the line goes once the clock is right', async () => {
    const s = ahead(5400);
    boot(s);
    expect((await screen.findByTestId('clock-behind')).textContent).toContain('saved on LAPTOP at 16:50.');
    await arrives(() => {
      s.newestStamp = { at: s.now + 5400, causeDevice: null };
    });
    await waitFor(() => expect(screen.getByTestId('clock-behind').textContent).toContain('saved here at 16:50, so it seems to have been set back.'));
    await arrives(() => {
      s.newestStamp = null;
    });
    await waitFor(() => expect(screen.queryByTestId('clock-behind')).toBeNull());
  });

  it('counts the gap on the page clock when new data arrives, so a line left up for an hour does not still say 1 h 30 min', async () => {
    const s = ahead(5400);
    boot(s);
    expect((await screen.findByTestId('clock-behind')).textContent).toContain('is 1 h 30 min behind');
    await arrives(() => {
      s.now += 3600;
    });
    await waitFor(() => expect(screen.getByTestId('clock-behind').textContent).toContain('is 30 min behind'));
    await arrives(() => {
      s.now += 1700;
    });
    await waitFor(() => expect(screen.queryByTestId('clock-behind')).toBeNull());
  });
});

/** A store nobody has set up yet, which opens the wizard in place of the Shell. */
function fresh(): MockState {
  const s = emptyState('2026-03-12T15:20:00Z');
  s.setupDone = false;
  s.syncPromptDone = false;
  s.clientZonePromptDone = false;
  s.settings = {};
  return s;
}

describe('the line in the setup wizard, which does not render the Shell', () => {
  beforeEach(polyfillDom);

  it('shows on the first start, above the progress line, with the same words', async () => {
    const s = fresh();
    s.newestStamp = { at: s.now + 5400, causeDevice: 'LAPTOP' };
    boot(s);
    const wizard = await screen.findByTestId('setup-wizard');
    const line = within(wizard).getByTestId('clock-behind');
    expect(line).toHaveAttribute('role', 'status');
    expect(line.textContent).toBe(OTHER_COMPUTER);
    expect(screen.queryByRole('tab', { name: 'Timeline' })).toBeNull();
    expect(line.compareDocumentPosition(within(wizard).getByTestId('wizard-progress')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not there when nothing is ahead', async () => {
    boot(fresh());
    const wizard = await screen.findByTestId('setup-wizard');
    expect(within(wizard).queryByTestId('clock-behind')).toBeNull();
  });
});

/** Someone who updated before the setup wizard existed and still owes the one-time prompt about sync folders: the app shows that, not the Shell. */
function legacyPrompt(secs: number | null, causeDevice: string | null = 'LAPTOP'): MockState {
  const s = secs === null ? demoState() : ahead(secs, causeDevice);
  s.syncPromptDone = false;
  s.targets = [];
  return s;
}

describe('the line on the one-time sync prompt, which does not render the Shell either', () => {
  beforeEach(polyfillDom);

  it('shows above the question, with the same words, as a status among the banners', async () => {
    boot(legacyPrompt(5400));
    const question = await screen.findByRole('heading', { name: 'Keep your devices in sync?' });
    const line = screen.getByTestId('clock-behind');
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveClass('banner', 'banner-warning');
    expect(line.parentElement).toHaveClass('banners');
    expect(line.textContent).toBe(OTHER_COMPUTER);
    expect(screen.queryByRole('tab', { name: 'Timeline' })).toBeNull();
    expect(line.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(line).queryAllByRole('button')).toEqual([]);
  });

  it('says it of a change saved here', async () => {
    boot(legacyPrompt(7200, null));
    expect((await screen.findByTestId('clock-behind')).textContent).toBe(THIS_COMPUTER);
  });

  it('has the capped words from a gap of a day, for another computer and for this one', async () => {
    boot(legacyPrompt(172_800));
    expect((await screen.findByTestId('clock-behind')).textContent).toBe(CAPPED_OTHER);
    cleanup();
    boot(legacyPrompt(172_800, null));
    await waitFor(() => expect(screen.getByTestId('clock-behind').textContent).toBe(CAPPED_THIS));
  });

  it('is not there when nothing is ahead, or the gap is under 120 s', async () => {
    boot(legacyPrompt(null));
    await screen.findByRole('heading', { name: 'Keep your devices in sync?' });
    expect(screen.queryByTestId('clock-behind')).toBeNull();
    cleanup();
    boot(legacyPrompt(119));
    await screen.findByRole('heading', { name: 'Keep your devices in sync?' });
    expect(screen.queryByTestId('clock-behind')).toBeNull();
  });
});

describe('time passing on the page between two snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-12T15:20:00Z'), shouldAdvanceTime: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const words = (): string | null => screen.queryByTestId('clock-behind')?.textContent ?? null;
  /** The part set apart from what a screen reader is told: the one that moves. */
  const gap = (): string | null => screen.queryByTestId('clock-behind')?.querySelector('[aria-live="off"]')?.textContent ?? null;

  it('moves on each minute and goes away by itself once the page clock has caught up, with no new snapshot', async () => {
    // 330 s ahead: 5 min at first, then 4, 3 and 2 min as the page clock moves, and under 120 s after the fourth minute.
    const s = ahead(330);
    installMock(s);
    render(
      <AppProvider fallback={() => <p>loading</p>}>
        <ClockBanner />
      </AppProvider>,
    );
    await advance(10);
    expect(words()).toContain('is 5 min behind');
    expect(gap()).toBe('5 min');
    for (const left of ['4 min', '3 min', '2 min']) {
      await advance(60_000);
      expect(words(), left).toContain(`is ${left} behind`);
      expect(gap(), left).toBe(left);
    }
    await advance(60_000);
    expect(words()).toBeNull();
    // Nothing asked the backend again: the page worked it out from its own clock.
    expect(s.calls.filter((c) => c.cmd === 'get_snapshot')).toHaveLength(1);
  });

  it('goes back from the words for a gap of a day to the plain ones once the page clock has moved it under a day, with no new snapshot', async () => {
    // 86450 s ahead: the backend says capped. A minute later 86390 s are left, and a change made now can be dated after the newest one again.
    const s = ahead(86_450, null);
    installMock(s);
    render(
      <AppProvider fallback={() => <p>loading</p>}>
        <ClockBanner />
      </AppProvider>,
    );
    await advance(10);
    expect(gap()).toBe('1 day');
    expect(words()).toContain("Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check this computer's date and time.");
    await advance(60_000);
    expect(gap()).toBe('23 h 59 min');
    expect(words()).toContain("so they count as the newest. Check this computer's date and time.");
    expect(words()).not.toContain('may lose to it');
    expect(s.calls.filter((c) => c.cmd === 'get_snapshot')).toHaveLength(1);
  });
});
