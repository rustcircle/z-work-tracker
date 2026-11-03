// TakeOverDialog: two questions, and nothing is sent to take over until the second one is answered. Backing out of either changes
// nothing; a holder that came back to life while the dialog was open sends the page back to the first question; with no folder to
// read the same two questions are asked in other words. Run on the mock backend with a real AppProvider, as the page does.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../app/store';
import { api } from '../lib/api';
import { toIso } from '../lib/tz';
import type { LeaseHolderView, TakeOverPreview, TakeOverResult } from '../lib/types';
import { demoState } from '../mocks/demoSeed';
import { OTHER_DEVICE_ID, installMock, seedLease, type LeaseSeed, type MockState } from '../mocks/ipcMock';
import { LeaseBanner, type LeaseBannerProps } from './LeaseBanner';

afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

/** LAPTOP holds the lease, last heard of `quietSecs` ago, and shows "Email and invoices" as running since three hours ago. */
function laptop(kind: LeaseSeed = 'live', more: Partial<LeaseHolderView> = {}, quietSecs = 150): MockState {
  const s = demoState();
  const t = s.tasks.find((x) => x.id === 't-mail');
  if (!t) throw new Error('no task');
  t.state = 'running';
  t.pauseReason = null;
  t.runningElsewhere = 'LAPTOP';
  s.segments.push({ id: 'seg-laptop', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: toIso(s.now - 3 * 3600), end: null, provisionalEnd: toIso(s.now - 30 * 60) });
  seedLease(s, kind, { lastSignAt: toIso(s.now - quietSecs), ageSecs: quietSecs, ...more });
  return s;
}

function mount(s: MockState, props: LeaseBannerProps = {}): User {
  installMock(s);
  render(
    <AppProvider fallback={() => <p>loading</p>}>
      <LeaseBanner {...props} />
    </AppProvider>,
  );
  return userEvent.setup();
}

const calls = (s: MockState, cmd: string) => s.calls.filter((c) => c.cmd === cmd);
const dialogNamed = (name: string | RegExp): Promise<HTMLElement> => screen.findByRole('dialog', { name });
const press = (dialog: HTMLElement, name: string): HTMLElement => within(dialog).getByRole('button', { name });
/** Opens the dialog from the banner, as a person does, and waits until the folders have been read for it. */
async function open(s: MockState, u: User, button = 'Take over…', title: string | RegExp = /^(Take over from|Work here anyway)/): Promise<HTMLElement> {
  await u.click(await screen.findByRole('button', { name: button }));
  const dialog = await dialogNamed(title);
  await waitFor(() => expect(calls(s, 'lease_preview_take_over')).toHaveLength(1));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeEnabled());
  return dialog;
}

/** The paragraph of the dialog that starts with `start`. */
function para(dialog: HTMLElement, start: string): HTMLElement {
  const hit = [...dialog.querySelectorAll('p')].find((p) => (p.textContent ?? '').startsWith(start));
  if (!hit) throw new Error(`no paragraph starts with "${start}"`);
  return hit;
}
const textOf = (dialog: HTMLElement): string => (dialog.querySelector('.modal-body')?.textContent ?? '').trim();

describe('the first question', () => {
  it('names the computer, when it was last seen, and says it looks inactive but may simply not have synced', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await open(s, u);
    expect(within(dialog).getByRole('heading', { name: 'Take over from LAPTOP?' })).toBeVisible();
    expect(para(dialog, 'Last sign of LAPTOP')).toHaveTextContent('Last sign of LAPTOP: 40 min ago (14:40).');
    expect(para(dialog, 'It looks inactive')).toHaveTextContent("It looks inactive, but this can simply mean its cloud app hasn't synced yet.");
    expect(within(dialog).queryByText(/still in use/)).toBeNull();
  });

  it('says in stronger words that a holder that looks in use will stop only within a few minutes of hearing (D2 on)', async () => {
    const s = laptop('live');
    const u = mount(s, { offerToLive: true });
    const dialog = await open(s, u);
    expect(para(dialog, 'Last sign of LAPTOP')).toHaveTextContent('Last sign of LAPTOP: 2 min ago (15:17).');
    expect(para(dialog, "It looks like it's still in use.")).toHaveTextContent("It looks like it's still in use. It will stop within a few minutes of hearing about this.");
    expect(within(dialog).queryByText(/looks inactive/)).toBeNull();
  });

  it('adds that its clock seems to differ when the backend suspects so', async () => {
    const s = laptop('stale', { clockSuspect: true }, 40 * 60);
    const u = mount(s);
    const dialog = await open(s, u);
    expect(para(dialog, 'Last sign of LAPTOP')).toHaveTextContent('Last sign of LAPTOP: 40 min ago (14:40), and its clock seems to differ from this one.');
  });

  it('puts the date in when the last sign was not today', async () => {
    const s = laptop('stale', {}, 30 * 3600);
    const u = mount(s);
    const dialog = await open(s, u);
    expect(para(dialog, 'Last sign of LAPTOP')).toHaveTextContent('Last sign of LAPTOP: 1 day ago (11 Mar 09:20).');
  });

  it('says which running task would be closed, at what time, and that it is written in the audit trail', async () => {
    // Inactive for 20 minutes: the last sign of LAPTOP, 15:00, is later than what its task last reported (14:50), so it is where the task closes.
    const s = laptop('stale', {}, 20 * 60);
    const u = mount(s);
    const dialog = await open(s, u);
    expect(textOf(dialog)).toContain(
      '"Email and invoices" is shown as running there. It will close at 15:00, the last moment that computer is known to have been running. That is written in the audit trail. If LAPTOP really kept working, its time comes back when it next syncs.',
    );
  });

  it('lists several, each with its end', async () => {
    const s = laptop('stale', {}, 20 * 60);
    s.segments.push({ id: 'seg-laptop-2', taskId: 't-guide', deviceId: OTHER_DEVICE_ID, start: toIso(s.now - 2 * 3600), end: null, provisionalEnd: toIso(s.now - 45 * 60) });
    const g = s.tasks.find((x) => x.id === 't-guide');
    if (g) g.runningElsewhere = 'LAPTOP';
    const u = mount(s);
    const dialog = await open(s, u);
    expect(within(dialog).getByText('2 tasks are shown as running there. Each will close at the last moment that computer is known to have been running:')).toBeVisible();
    const items = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(expect.arrayContaining(['"Email and invoices" at 15:00', '"Brand guidelines" at 15:00']));
    expect(textOf(dialog)).toContain('That is written in the audit trail. If LAPTOP really kept working, that time comes back when it next syncs.');
  });

  it('says nothing about tasks when none is shown as running there', async () => {
    const s = demoState();
    seedLease(s, 'stale');
    const u = mount(s);
    const dialog = await open(s, u);
    expect(textOf(dialog)).not.toMatch(/shown as running|audit trail/);
  });

  it('has Cancel focused and Continue, in that order, and sends nothing to take over', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await open(s, u);
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent || b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Close dialog', 'Cancel', 'Continue']);
    expect(press(dialog, 'Cancel')).toHaveFocus();
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
  });

  it('shows that it is looking while the folders are read, with Cancel already focused', async () => {
    const s = laptop('stale', {}, 40 * 60);
    let release: (v: TakeOverPreview) => void = () => undefined;
    vi.spyOn(api, 'leasePreviewTakeOver').mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const u = mount(s);
    await u.click(await screen.findByRole('button', { name: 'Take over…' }));
    const dialog = await dialogNamed('Take over from LAPTOP?');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Reading the sync folders…');
    expect(press(dialog, 'Cancel')).toHaveFocus();
    expect(press(dialog, 'Continue')).toBeDisabled();
    release({ holder: { deviceId: OTHER_DEVICE_ID, deviceName: 'LAPTOP', generation: 4, beatSeq: 83, lastSignAt: toIso(s.now - 2400), ageSecs: 2400, clockSuspect: false }, live: false, unreachable: false, segments: [] });
    await waitFor(() => expect(press(dialog, 'Continue')).toBeEnabled());
  });

  it('says so, and offers another try, when the folders could not be looked at', async () => {
    const s = laptop('stale', {}, 40 * 60);
    s.failNext = ['lease_preview_take_over'];
    const u = mount(s);
    await u.click(await screen.findByRole('button', { name: 'Take over…' }));
    const dialog = await dialogNamed('Take over from LAPTOP?');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't look at the sync folders: mock: lease_preview_take_over failed");
    expect(within(dialog).queryByRole('button', { name: 'Continue' })).toBeNull();
    await u.click(press(dialog, 'Try again'));
    await waitFor(() => expect(press(dialog, 'Continue')).toBeEnabled());
    expect(calls(s, 'lease_preview_take_over')).toHaveLength(2);
  });
});

describe('backing out of the first question', () => {
  it('Cancel closes it, sends nothing to take over, and leaves the line and the focus where they were', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await open(s, u);
    await u.click(press(dialog, 'Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
    expect(screen.getByTestId('lease-banner')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Take over…' })).toHaveFocus();
  });

  it('Esc does the same', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    await open(s, u);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
  });

  it('and a fresh opening reads the folders afresh and starts at the first question', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    await dialogNamed('Are you sure?');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await u.click(screen.getByRole('button', { name: 'Take over…' }));
    await dialogNamed('Take over from LAPTOP?');
    await waitFor(() => expect(calls(s, 'lease_preview_take_over')).toHaveLength(2));
  });
});

describe('the second question', () => {
  async function toSecond(s: MockState, u: User): Promise<HTMLElement> {
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    return dialogNamed('Are you sure?');
  }

  it('says what happens next, that it can take minutes, and that both computers could change things meanwhile', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await toSecond(s, u);
    expect(textOf(dialog)).toBe("After this, LAPTOP becomes read-only as soon as it hears about it. That can take a few minutes, and if it's offline, until it reconnects. Until then both computers could make changes. They merge; nothing is deleted.");
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
  });

  it('has Back focused, then Take over, and still has sent nothing', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await toSecond(s, u);
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent || b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Close dialog', 'Back', 'Take over']);
    expect(press(dialog, 'Back')).toHaveFocus();
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
  });

  it('Back returns to the first question with Cancel focused, and sends nothing', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await toSecond(s, u);
    await u.click(press(dialog, 'Back'));
    const first = await dialogNamed('Take over from LAPTOP?');
    expect(press(first, 'Cancel')).toHaveFocus();
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
    // The first question was not read again.
    expect(calls(s, 'lease_preview_take_over')).toHaveLength(1);
  });

  it('Esc leaves the whole dialog and sends nothing', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    await toSecond(s, u);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
  });

  it('is the only thing that sends: Take over names the holder it was shown, and the mode (D2 on, a holder in use)', async () => {
    const s = laptop('live');
    const u = mount(s, { offerToLive: true });
    const dialog = await toSecond(s, u);
    await u.click(press(dialog, 'Take over'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toEqual([{ cmd: 'lease_take_over', args: { expected: { generation: 4, beatSeq: 83 }, mode: 'live' } }]);
  });

  it('sends the mode stale for a holder that looks inactive', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await toSecond(s, u);
    await u.click(press(dialog, 'Take over'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')[0]?.args).toEqual({ expected: { generation: 4, beatSeq: 83 }, mode: 'stale' });
    // One call, as for a holder in use with D2 on.
    expect(calls(s, 'lease_take_over')).toHaveLength(1);
  });

  it('ignores the second click of a double click on Continue that lands on it, but not a key press or a single click', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await toSecond(s, u);
    fireEvent.click(press(dialog, 'Take over'), { detail: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Are you sure?' })).toBeVisible();
    // A key press on a button clicks with a count of 0.
    fireEvent.click(press(dialog, 'Take over'), { detail: 0 });
    await waitFor(() => expect(calls(s, 'lease_take_over')).toHaveLength(1));
  });

  it('cannot be left, or pressed again, while the take over is on its way, and closes when it is done', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const dialog = await toSecond(s, u);
    let finish: (r: TakeOverResult) => void = () => undefined;
    vi.spyOn(api, 'leaseTakeOver').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await u.click(press(dialog, 'Take over'));
    const take = await within(dialog).findByRole('button', { name: 'Taking over…' });
    expect(take).toBeDisabled();
    expect(press(dialog, 'Back')).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Close dialog' })).toBeNull();
    await u.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Are you sure?' })).toBeVisible();
    fireEvent.click(take);
    expect(api.leaseTakeOver).toHaveBeenCalledTimes(1);
    const snapshot = await api.getSnapshot();
    await act(async () => {
      finish({ outcome: 'done', preview: null, snapshot: { ...snapshot, lease: { ...snapshot.lease, state: 'heldByMe', readOnly: false, holder: null } } });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByTestId('lease-banner')).toBeNull();
  });
});

describe('what comes back', () => {
  it('done: the dialog and the line are gone, this computer holds it, and the old holder’s task is closed at its last known time', async () => {
    // Inactive for 20 minutes: its last sign is where its task closes, as it is later than what the task last reported.
    const s = laptop('stale', {}, 20 * 60);
    const u = mount(s);
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('lease-banner')).toBeNull());
    expect(s.lease.state).toBe('heldByMe');
    expect(s.segments.find((x) => x.id === 'seg-laptop')?.edit).toMatchObject({ end: toIso(s.now - 20 * 60) });
    expect(s.notices.map((n) => n.message)).toContain('You took over from LAPTOP. 1 running task was closed at its last known time.');
  });

  it('changed, the holder still looks inactive: back at the first question with the fresh view, then the take over goes through for the new beat', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    // Its cloud app delivers a newer record of LAPTOP's, and it is still an old one: the beat moves on, and the holder still looks inactive.
    if (s.lease.holder) s.lease = { ...s.lease, holder: { ...s.lease.holder, beatSeq: s.lease.holder.beatSeq + 1 } };
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    const again = await dialogNamed('Take over from LAPTOP?');
    expect(within(again).getByTestId('takeover-changed')).toHaveTextContent('Nothing was taken over. Things changed while this was open, so here is how it stands now.');
    expect(para(again, 'It looks inactive')).toBeVisible();
    expect(press(again, 'Cancel')).toHaveFocus();
    expect(calls(s, 'lease_take_over')).toHaveLength(1);
    expect(s.lease.state).toBe('heldByOtherStale');
    // Asking again names the new beat, and now it goes through.
    await u.click(press(again, 'Continue'));
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over').map((c) => c.args)).toEqual([
      { expected: { generation: 4, beatSeq: 83 }, mode: 'stale' },
      { expected: { generation: 4, beatSeq: 84 }, mode: 'stale' },
    ]);
    expect(s.lease.state).toBe('heldByMe');
  });

  it('changed, the holder came back to life (D2 on): back at the first question with the fresh view and a line saying nothing was taken over, then the take over can go through', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s, { offerToLive: true });
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    // LAPTOP is heard from again while the dialog is open.
    s.takeOverNext = 'changed';
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    const again = await dialogNamed('Take over from LAPTOP?');
    expect(within(again).getByTestId('takeover-changed')).toHaveTextContent('Nothing was taken over. Things changed while this was open, so here is how it stands now.');
    expect(para(again, "It looks like it's still in use.")).toBeVisible();
    expect(para(again, 'Last sign of LAPTOP')).toHaveTextContent('Last sign of LAPTOP: ');
    expect(press(again, 'Cancel')).toHaveFocus();
    // The line behind it follows.
    expect(screen.getByTestId('lease-text').textContent).toContain('LAPTOP is using zWorkTracker');
    expect(calls(s, 'lease_take_over')).toHaveLength(1);
    expect(s.lease.state).toBe('heldByOtherLive');
    // Asking again names the new beat, and now it goes through.
    await u.click(press(again, 'Continue'));
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over').map((c) => c.args)).toEqual([
      { expected: { generation: 4, beatSeq: 83 }, mode: 'stale' },
      { expected: { generation: 4, beatSeq: 84 }, mode: 'live' },
    ]);
    expect(s.lease.state).toBe('heldByMe');
  });

  it('unreachable: says that nothing changed and why, stays on the second question, and can try again', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    s.takeOverNext = 'unreachable';
    const sure = await dialogNamed('Are you sure?');
    await u.click(press(sure, 'Take over'));
    expect(await within(sure).findByRole('alert')).toHaveTextContent(
      "Nothing was changed. The sync folder couldn't be written to just now, so this computer did not take over. Check that the folder is available, then try again.",
    );
    expect(s.lease.state).toBe('heldByOtherStale');
    expect(screen.getByRole('dialog', { name: 'Are you sure?' })).toBeVisible();
    expect(press(sure, 'Take over')).toBeEnabled();
    // Back clears it; trying again goes through.
    await u.click(press(sure, 'Back'));
    await u.click(press(await dialogNamed('Take over from LAPTOP?'), 'Continue'));
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(s.lease.state).toBe('heldByMe');
  });

  it('a failure of the call itself is shown in the dialog, in the backend’s words, and nothing is lost', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    s.failNext = ['lease_take_over'];
    const sure = await dialogNamed('Are you sure?');
    await u.click(press(sure, 'Take over'));
    expect(await within(sure).findByRole('alert')).toHaveTextContent('mock: lease_take_over failed');
    expect(press(sure, 'Take over')).toBeEnabled();
    expect(s.lease.state).toBe('heldByOtherStale');
  });

  it('nobody holds it any more: the dialog says so at once, even while it is being read, and has only Close', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    const first = await open(s, u);
    expect(press(first, 'Continue')).toBeEnabled();
    // LAPTOP quit while the dialog was open.
    await act(async () => {
      s.lease = { ...s.lease, state: 'free', readOnly: false, holder: null };
      await emit('state-changed');
    });
    const gone = await dialogNamed('Nothing to take over');
    expect(textOf(gone)).toBe('No other computer is using zWorkTracker now, so this computer can make changes.');
    expect(press(gone, 'Close')).toHaveFocus();
    expect(within(gone).queryByRole('button', { name: 'Continue' })).toBeNull();
    await u.click(press(gone, 'Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
  });
});

describe('with no folder to read', () => {
  it('asks the same two questions in other words, and works here without waiting for the folder', async () => {
    const s = laptop('unknown', {}, 2 * 3600);
    const u = mount(s);
    const first = await open(s, u, 'Work here anyway…', 'Work here anyway?');
    expect(textOf(first)).toBe(
      "The sync folder can't be reached, so this computer can't tell whether LAPTOP is still using zWorkTracker.Last sign of LAPTOP: 2 h ago (13:20).If you go on, this computer can make changes now, without waiting for the folder.",
    );
    expect(within(first).queryByText(/shown as running/)).toBeNull();
    expect(press(first, 'Cancel')).toHaveFocus();
    await u.click(press(first, 'Continue'));
    const sure = await dialogNamed('Are you sure?');
    expect(textOf(sure)).toBe(
      'Until the folder can be reached, LAPTOP may be making changes too. They merge; nothing is deleted. Once the folder is back, this computer takes over from LAPTOP, and anything LAPTOP left running is closed at its last known time. If another computer took over in the meantime, this one goes back to read-only. What you did here is kept and will merge.',
    );
    expect(press(sure, 'Back')).toHaveFocus();
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
    await u.click(press(sure, 'Work here anyway'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toEqual([{ cmd: 'lease_take_over', args: { expected: { generation: 4, beatSeq: 0 }, mode: 'offline' } }]);
    // Writable now, still without a folder, and nothing of LAPTOP's was closed yet.
    await waitFor(() => expect(screen.getByTestId('lease-text').textContent).toMatch(/^The sync folder can't be reached, so this computer can't check whether another one is in use\./));
    expect(screen.queryByRole('button', { name: 'Work here anyway…' })).toBeNull();
    expect(s.segments.find((x) => x.id === 'seg-laptop')?.edit).toBeUndefined();
  });

  it('Cancel and Esc change nothing here either', async () => {
    const s = laptop('unknown', {}, 2 * 3600);
    const u = mount(s);
    const first = await open(s, u, 'Work here anyway…', 'Work here anyway?');
    await u.click(press(first, 'Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await u.click(screen.getByRole('button', { name: 'Work here anyway…' }));
    await dialogNamed('Work here anyway?');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(s, 'lease_take_over')).toHaveLength(0);
    expect(s.lease.state).toBe('heldByOtherLive');
  });

  it('folders that go away after the line was drawn are found out when the dialog reads them, and it says so in these words', async () => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s);
    // The line was drawn for an inactive holder; the folder goes away before the dialog reads it.
    await screen.findByRole('button', { name: 'Take over…' });
    const root = s.targets[0]?.root ?? '';
    s.folders[root] = { ...(s.folders[root] ?? { devices: [], counts: { projects: 0, tasks: 0, segments: 0 } }), available: false };
    await u.click(screen.getByRole('button', { name: 'Take over…' }));
    const dialog = await dialogNamed('Work here anyway?');
    await waitFor(() => expect(press(dialog, 'Continue')).toBeEnabled());
    expect(textOf(dialog)).toContain("The sync folder can't be reached");
  });
});

describe('D2 switched off, which is how it ships', () => {
  it.each<[string, LeaseBannerProps]>([
    ['explicitly off', { offerToLive: false }],
    ['by default', {}],
  ])('%s: a holder that came to look in use while the dialog was open gets no Continue, and the words say when it comes', async (_how, props) => {
    const s = laptop('stale', {}, 40 * 60);
    const u = mount(s, props);
    const first = await open(s, u);
    await u.click(press(first, 'Continue'));
    s.takeOverNext = 'changed';
    await u.click(press(await dialogNamed('Are you sure?'), 'Take over'));
    const again = await dialogNamed('Take over from LAPTOP?');
    expect(para(again, "It looks like it's still in use.")).toHaveTextContent("It looks like it's still in use. Take over is offered once it looks inactive.");
    expect(within(again).queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(textOf(again)).not.toMatch(/shown as running/);
    expect(press(again, 'Cancel')).toHaveFocus();
    // The line behind it offers no take over either.
    expect(within(screen.getByTestId('lease-banner')).queryByRole('button', { name: 'Take over…' })).toBeNull();
  });
});
