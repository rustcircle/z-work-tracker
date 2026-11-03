// LeaseBanner: the line that says who may change the data, state by state and in exact words. Cloud folders sync late, so the words
// say what this computer has heard and not more. The tests run it on the mock backend with a real AppProvider, the way the page does.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../app/store';
import { toIso } from '../lib/tz';
import type { LeaseHolderView } from '../lib/types';
import { demoState } from '../mocks/demoSeed';
import { installMock, leaseView, seedLease, type LeaseSeed, type MockState } from '../mocks/ipcMock';
import { LeaseBanner, bannerKind, type BannerKind, type LeaseBannerProps } from './LeaseBanner';
import { OFFER_TAKE_OVER_TO_A_LIVE_HOLDER, UNNAMED_COMPUTER, ageText, holderName, takeOverOffered } from './TakeOverDialog';

afterEach(() => {
  cleanup();
  clearMocks();
});

/** A holder last heard from `quiet` seconds before the mock's clock. */
function quiet(s: MockState, secs: number, more: Partial<LeaseHolderView> = {}): Partial<LeaseHolderView> {
  return { lastSignAt: toIso(s.now - secs), ageSecs: secs, ...more };
}

function mount(s: MockState, props: LeaseBannerProps = {}) {
  installMock(s);
  return render(
    <AppProvider fallback={() => <p>loading</p>}>
      <LeaseBanner {...props} />
    </AppProvider>,
  );
}

const banner = (): Promise<HTMLElement> => screen.findByTestId('lease-banner');
const textOf = async (): Promise<string> => (await within(await banner()).findByTestId('lease-text')).textContent ?? '';
const buttonsOf = async (): Promise<string[]> => within(await banner()).queryAllByRole('button').map((b) => b.textContent ?? '');
/** Lets the page take in whatever the test changed in the mock, the way a state-changed event from the backend does. */
async function arrives(change: () => void): Promise<void> {
  change();
  await act(async () => {
    await emit('state-changed');
  });
}

describe('which states have a line', () => {
  it.each<[LeaseSeed | 'none']>([['none'], ['checking'], ['free'], ['mine']])('%s has none', async (kind) => {
    const s = demoState();
    if (kind !== 'none') seedLease(s, kind);
    mount(s);
    // The page has its first snapshot once the loading line is gone; the banner would be in the same render.
    await waitFor(() => expect(screen.queryByText('loading')).toBeNull());
    expect(screen.queryByTestId('lease-banner')).toBeNull();
    expect(bannerKind(leaseView(s))).toBeNull();
  });

  it.each<[LeaseSeed, BannerKind]>([
    ['live', 'live'],
    ['stale', 'stale'],
    ['unknown', 'unreachableReadOnly'],
    ['unknown-writable', 'unreachableWritable'],
  ])('%s has the %s line', async (kind, want) => {
    const s = demoState();
    seedLease(s, kind);
    mount(s);
    expect(await banner()).toBeVisible();
    expect(bannerKind(leaseView(s))).toBe(want);
  });

  it('is a status the page can find, with the lease state on it', async () => {
    const s = demoState();
    seedLease(s, 'live');
    mount(s);
    const el = await banner();
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('data-state', 'heldByOtherLive');
  });
});

describe('another computer holds it and looks in use', () => {
  it('says who, when it was last seen and that this one only looks, with the two buttons when D2 is on', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s, { offerToLive: true });
    expect(await textOf()).toBe("Read-only. LAPTOP is using zWorkTracker (last seen 2 min ago). You can look at everything here. Changes are off so the two computers don't overlap.");
    expect(await buttonsOf()).toEqual(['Check again', 'Take over…']);
  });

  it('says the same as shipped, with Check again only: take over is not offered for a computer in use', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s);
    expect(await textOf()).toBe("Read-only. LAPTOP is using zWorkTracker (last seen 2 min ago). You can look at everything here. Changes are off so the two computers don't overlap.");
    expect(await buttonsOf()).toEqual(['Check again']);
    expect(screen.queryByRole('button', { name: 'Take over…' })).toBeNull();
  });

  it('names the computer it is, and adds that its clock differs when the backend suspects so', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150, { deviceName: 'Home PC', clockSuspect: true }));
    mount(s);
    expect(await textOf()).toBe("Read-only. Home PC is using zWorkTracker (last seen 2 min ago). You can look at everything here. Changes are off so the two computers don't overlap. Its clock seems to differ from this computer's.");
  });

  it('says less, and nothing wrong, when there has been no sign of it at all', async () => {
    const s = demoState();
    seedLease(s, 'live', { lastSignAt: null, ageSecs: null });
    mount(s);
    expect(await textOf()).toBe("Read-only. LAPTOP is using zWorkTracker. You can look at everything here. Changes are off so the two computers don't overlap.");
  });

  it('counts the time since the last sign on the page clock, so a line left up for an hour does not still say 2 min', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s);
    expect(await textOf()).toContain('(last seen 2 min ago)');
    await arrives(() => {
      s.now += 3600;
    });
    await waitFor(() => expect(screen.getByTestId('lease-text').textContent).toContain('(last seen 1 h 2 min ago)'));
  });

  it('keeps the moving age out of what a screen reader is told, since it changes every minute', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s);
    const age = within(await banner()).getByText('2 min');
    expect(age).toHaveAttribute('aria-live', 'off');
  });
});

describe('another computer holds it and looks inactive', () => {
  it('says how long nothing has come from it, and that its cloud app may simply not have synced', async () => {
    const s = demoState();
    seedLease(s, 'stale', quiet(s, 40 * 60));
    mount(s);
    expect(await textOf()).toBe('Read-only. LAPTOP looks inactive: nothing from it for 40 min. It may be off, or its cloud app may simply not have synced yet.');
    expect(await buttonsOf()).toEqual(['Check again', 'Take over…']);
  });

  it('counts hours and days the way the backend does', async () => {
    const s = demoState();
    seedLease(s, 'stale', quiet(s, 3 * 3600 + 5 * 60));
    mount(s);
    expect(await textOf()).toContain('nothing from it for 3 h 5 min.');
    await arrives(() => seedLease(s, 'stale', quiet(s, 3 * 86_400 + 600)));
    await waitFor(() => expect(screen.getByTestId('lease-text').textContent).toContain('nothing from it for 3 days.'));
  });

  it('adds the clock sentence here too', async () => {
    const s = demoState();
    seedLease(s, 'stale', quiet(s, 40 * 60, { clockSuspect: true }));
    mount(s);
    expect(await textOf()).toBe("Read-only. LAPTOP looks inactive: nothing from it for 40 min. It may be off, or its cloud app may simply not have synced yet. Its clock seems to differ from this computer's.");
  });
});

describe('no folder can be read', () => {
  it('is read-only when another computer held it lately, and offers to work here anyway', async () => {
    const s = demoState();
    seedLease(s, 'unknown', quiet(s, 2 * 3600));
    mount(s);
    expect(await textOf()).toBe("Read-only. The sync folder can't be reached, and LAPTOP was last using zWorkTracker 2 h ago.");
    expect(await buttonsOf()).toEqual(['Check again', 'Work here anyway…']);
  });

  it('is writable when nobody held it, and says so without any button', async () => {
    const s = demoState();
    seedLease(s, 'unknown-writable');
    mount(s);
    expect(await textOf()).toBe("The sync folder can't be reached, so this computer can't check whether another one is in use. You can keep working. Everything merges when the folder is back.");
    expect(await buttonsOf()).toEqual([]);
  });
});

describe('the backend’s extra line', () => {
  it('goes under the words, on a line of its own', async () => {
    const s = demoState();
    seedLease(s, 'stale', quiet(s, 40 * 60));
    s.lease = { ...s.lease, note: 'The folder G:\\My Drive can’t be read.' };
    mount(s);
    const note = await screen.findByTestId('lease-note');
    expect(note).toHaveTextContent('The folder G:\\My Drive can’t be read.');
    expect(note).toHaveStyle({ display: 'block' });
    expect(await textOf()).toMatch(/simply not have synced yet\. The folder G:\\My Drive can’t be read\.$/);
  });

  it('is not shown when there is none', async () => {
    const s = demoState();
    seedLease(s, 'live');
    mount(s);
    await banner();
    expect(screen.queryByTestId('lease-note')).toBeNull();
  });
});

describe('Check again', () => {
  it('asks the backend to look afresh, and the line follows what it finds', async () => {
    const s = demoState();
    seedLease(s, 'stale', quiet(s, 40 * 60));
    mount(s);
    const user = userEvent.setup();
    await banner();
    // The other computer let go while this page was not looking.
    s.lease = { ...s.lease, state: 'free', readOnly: false, holder: null };
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByTestId('lease-banner')).toBeNull());
    expect(s.calls.filter((c) => c.cmd === 'sync_now')).toHaveLength(1);
  });

  it('shows the line again as it was when nothing has changed, and changes nothing else', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s);
    const user = userEvent.setup();
    await banner();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(s.calls.some((c) => c.cmd === 'sync_now')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled());
    expect(await textOf()).toContain('LAPTOP is using zWorkTracker');
    expect(s.calls.some((c) => c.cmd === 'lease_take_over')).toBe(false);
  });
});

describe('D2: take over is offered to a holder that looks in use only when the switch is on', () => {
  it('is off as shipped (the owner asked for take over when the holder looks dead), and the one switch is named', () => {
    expect(OFFER_TAKE_OVER_TO_A_LIVE_HOLDER).toBe(false);
  });

  it.each([
    // looksLive, offerToLive, offered
    [true, true, true],
    [true, false, false],
    [false, true, true],
    [false, false, true],
  ])('takeOverOffered(looksLive %s, offerToLive %s) is %s', (looksLive, offerToLive, want) => {
    expect(takeOverOffered(looksLive, offerToLive)).toBe(want);
  });

  it('switched off, a live holder gets Check again only, and an inactive one still gets Take over', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s, { offerToLive: false });
    expect(await textOf()).toContain('LAPTOP is using zWorkTracker');
    expect(await buttonsOf()).toEqual(['Check again']);
    await arrives(() => seedLease(s, 'stale', quiet(s, 40 * 60)));
    await waitFor(() => expect(screen.getByTestId('lease-text').textContent).toContain('looks inactive'));
    expect(await buttonsOf()).toEqual(['Check again', 'Take over…']);
  });

  it('as shipped (no props), a live holder gets Check again only, and an inactive one gets Take over…', async () => {
    const s = demoState();
    seedLease(s, 'live', quiet(s, 150));
    mount(s);
    expect(await textOf()).toContain('LAPTOP is using zWorkTracker');
    expect(await buttonsOf()).toEqual(['Check again']);
    await arrives(() => seedLease(s, 'stale', quiet(s, 40 * 60)));
    await waitFor(() => expect(screen.getByTestId('lease-text').textContent).toContain('looks inactive'));
    expect(await buttonsOf()).toEqual(['Check again', 'Take over…']);
  });

  it('switched off, work-here-anyway is still offered when no folder can be read, since there is nothing to see', async () => {
    const s = demoState();
    seedLease(s, 'unknown');
    mount(s, { offerToLive: false });
    await banner();
    expect(await buttonsOf()).toEqual(['Check again', 'Work here anyway…']);
  });
});

describe('words shared with the backend', () => {
  it.each([
    [0, 'less than a minute'],
    [59, 'less than a minute'],
    [60, '1 min'],
    [59 * 60 + 59, '59 min'],
    [3600, '1 h'],
    [3600 + 60, '1 h 1 min'],
    [23 * 3600 + 59 * 60, '23 h 59 min'],
    [86_400, '1 day'],
    [86_400 + 23 * 3600, '1 day'],
    [2 * 86_400, '2 days'],
    [40 * 86_400, '40 days'],
    [-30, 'less than a minute'],
  ])('ageText(%i) is %s, as span_text', (secs, want) => {
    expect(ageText(secs)).toBe(want);
  });

  it('calls a computer with no name what the backend’s refusal calls it', () => {
    expect(UNNAMED_COMPUTER).toBe('Another computer');
    expect(holderName(null)).toBe('Another computer');
    expect(holderName({ deviceId: 'd', deviceName: '   ', generation: 1, beatSeq: 1, lastSignAt: null, ageSecs: null, clockSuspect: false })).toBe('Another computer');
    expect(holderName({ deviceId: 'd', deviceName: ' LAPTOP ', generation: 1, beatSeq: 1, lastSignAt: null, ageSecs: null, clockSuspect: false })).toBe('LAPTOP');
  });

  it.each<LeaseSeed>(['live', 'stale', 'unknown', 'unknown-writable'])('puts no dash in the %s wording', async (kind) => {
    const s = demoState();
    seedLease(s, kind);
    mount(s);
    expect(await textOf()).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('QC-9: a holder in use, with take over off, says how to get out', () => {
  it('names quitting, Release now and Pause it from here, and when Take over appears', async () => {
    const s = demoState();
    seedLease(s, 'live');
    mount(s);
    const how = await within(await banner()).findByTestId('lease-how');
    expect(how).toHaveTextContent('quit it or press Release now there, or ask it to pause its task with Pause it from here. Take over appears once nothing has come from it for 15 minutes.');
  });

  it('is not shown when Take over is on offer', async () => {
    const s = demoState();
    seedLease(s, 'live');
    mount(s, { offerToLive: true });
    await banner();
    expect(screen.queryByTestId('lease-how')).toBeNull();
  });
});
