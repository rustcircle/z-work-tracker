import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boot as bootApp, polyfillDom } from '../../components/testKit';
import { demoP2State } from '../../mocks/demoSeed';
import { DEVICE_ID, type MockState } from '../../mocks/ipcMock';

beforeEach(polyfillDom);
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

let state: MockState;
const boot = (s: MockState) => {
  state = s;
  return bootApp(s);
};
const calls = (cmd: string) => state.calls.filter((c) => c.cmd === cmd).map((c) => c.args as Record<string, unknown>);
const dialog = () => screen.findByRole('dialog', { name: /You were away/ });
const plant = (id: string, start: string, end: string) => {
  const seg = state.segments.find((x) => x.taskId === 't-logo' && x.end === null);
  if (!seg) throw new Error('no running segment');
  state.gaps.push({ id, segmentId: seg.id, taskId: 't-logo', deviceId: DEVICE_ID, start, end, kind: 'sleep', decision: 'pending', decisionStamp: { at: end, by: DEVICE_ID } });
};

describe('the time away dialog', () => {
  it('opens on return, lists the stretch and sends one decision per button', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    const d = await dialog();
    expect(within(d).getByText(/Unconfirmed: not counted until you confirm/)).toBeVisible();
    expect(within(d).getByText('14:20–14:50 Lisbon time, 30m away')).toBeVisible();
    expect(within(d).getByText('Idle')).toBeVisible();
    await user.click(within(d).getByRole('button', { name: /^Mark as thinking: Logo concepts/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    expect(calls('decide_gap')).toEqual([{ id: 'gap-pending', decision: 'thinking' }]);
    expect(screen.queryByTestId('away-banner')).toBeNull();
  });

  it('can be dismissed, leaves the banner, and the banner opens it again', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    const banner = screen.getByTestId('away-banner');
    expect(banner).toHaveTextContent('Unconfirmed: not counted until you confirm');
    expect(banner).toHaveTextContent('30m of time away on Logo concepts');
    expect(calls('decide_gap')).toEqual([]);
    const open = within(banner).getByRole('button', { name: 'Review time away' });
    await user.click(open);
    expect(await dialog()).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(open).toHaveFocus());
  });

  it('applies one answer to every stretch', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    state = s;
    plant('gap-two', '2026-03-12T14:55:00Z', '2026-03-12T15:05:00Z');
    boot(s);
    const d = await dialog();
    expect(within(d).getAllByTestId('away-gap')).toHaveLength(2);
    expect(within(d).getByText('Sleep')).toBeVisible();
    await user.click(within(d).getByRole('button', { name: 'Drop all' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    expect(calls('decide_gap')).toEqual([{ id: 'gap-pending', decision: 'drop' }, { id: 'gap-two', decision: 'drop' }]);
    expect(screen.queryByTestId('away-banner')).toBeNull();
  });

  it('opens again only for a stretch it has not asked about', async () => {
    const user = userEvent.setup();
    boot(demoP2State());
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull());
    // The same pending stretch arriving again in a new snapshot does not reopen it.
    await emit('state-changed');
    await waitFor(() => expect(calls('get_snapshot').length).toBeGreaterThan(1));
    expect(screen.queryByRole('dialog', { name: /You were away/ })).toBeNull();
    // A new one does.
    plant('gap-two', '2026-03-12T14:55:00Z', '2026-03-12T15:05:00Z');
    await emit('state-changed');
    const d = await dialog();
    expect(within(d).getAllByTestId('away-gap')).toHaveLength(2);
  });

  it('shows a refused decision and keeps the stretch', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.failNext = ['decide_gap'];
    boot(s);
    const d = await dialog();
    await user.click(within(d).getByRole('button', { name: /^Keep: Logo concepts/ }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('mock: decide_gap failed');
    expect(within(d).getAllByTestId('away-gap')).toHaveLength(1);
  });
});

describe('the reminder banner', () => {
  it('names the task and the long run, and Keep running 1 h snoozes for an hour', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.settings.longRunMinutes = 60;
    boot(s);
    const r = await screen.findByTestId('reminder-banner');
    expect(r).toHaveTextContent('Logo concepts');
    expect(r).toHaveTextContent(/Running for 1 h 20 min since 14:00/);
    await user.click(within(r).getByRole('button', { name: 'Keep running 1 h' }));
    await waitFor(() => expect(screen.queryByTestId('reminder-banner')).toBeNull());
    expect(calls('snooze_reminder')).toEqual([{ minutes: 60 }]);
  });

  it('past the end of a shift, and Pause pauses that task', async () => {
    const user = userEvent.setup();
    const s = demoP2State();
    s.reminderOverride = { kind: 'pastShift', taskId: 't-logo', shift: 'Morning', ended: '2026-03-12T13:00:00Z' };
    boot(s);
    const r = await screen.findByTestId('reminder-banner');
    expect(r).toHaveTextContent('Past the end of your Morning shift (13:00)');
    await user.click(within(r).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.queryByTestId('reminder-banner')).toBeNull());
    expect(calls('pause_task')).toEqual([{ id: 't-logo' }]);
    expect(s.tasks.find((t) => t.id === 't-logo')?.state).toBe('paused');
  });
});
