// A task left running on another computer can be paused from here by a request that syncs. The other computer's
// own segment is never rewritten, and the card says so.
import { clearMocks } from '@tauri-apps/api/mocks';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boot, polyfillDom } from '../../components/testKit';
import { demoState } from '../../mocks/demoSeed';
import { DEVICE_ID, type MockState } from '../../mocks/ipcMock';
import type { PauseRequest } from '../../lib/types';
import { waitingPauseRequest } from './taskLogic';

beforeEach(polyfillDom);
afterEach(() => clearMocks());

/** The demo's running task, made to be running on Office PC. */
function elsewhere(): MockState {
  const s = demoState();
  const t = s.tasks.find((x) => x.id === 't-logo');
  const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
  if (!t || !open) throw new Error('seed');
  open.deviceId = 'other-device';
  t.runningElsewhere = 'Office PC';
  return s;
}

const card = async () => within(await screen.findByRole('article', { name: 'Logo concepts' }));

describe('pause a task running on another computer', () => {
  it('offers the request, says what it does and does not do, and keeps Pause itself off', async () => {
    boot(elsewhere());
    const c = await card();
    expect(c.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(c.getByRole('button', { name: /Pause it from here/ })).toBeEnabled();
    const note = c.getByTestId('remote-pause');
    expect(note).toHaveTextContent("Office PC's own record is not changed");
    expect(note).toHaveTextContent('counted only up to the moment of your request');
    expect(note).toHaveTextContent('closes there the next time Office PC syncs');
  });

  it('sends the request once, then shows Pause requested instead of the button, and changes no segment', async () => {
    const s = elsewhere();
    const before = JSON.stringify(s.segments);
    const user = userEvent.setup();
    boot(s);
    await user.click((await card()).getByRole('button', { name: /Pause it from here/ }));
    await waitFor(() => expect(s.pauseRequests).toHaveLength(1));
    const c = await card();
    await waitFor(() => expect(c.getByText('Pause requested')).toBeVisible());
    expect(c.queryByRole('button', { name: /Pause it from here/ })).toBeNull();
    expect(c.getByTestId('remote-pause')).toHaveTextContent('takes effect when Office PC next syncs');
    expect(s.segments.map((x) => ({ id: x.id, end: x.end, deviceId: x.deviceId }))).toEqual(JSON.parse(before).map((x: { id: string; end: string | null; deviceId: string }) => ({ id: x.id, end: x.end, deviceId: x.deviceId })));
    expect(s.calls.filter((x) => x.cmd === 'request_remote_pause')).toHaveLength(1);
  });

  it('shows Pause requested straight away when a request already exists, and nothing for a task running here', async () => {
    const s = elsewhere();
    const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    s.pauseRequests.push({ id: 'pr1', taskId: 't-logo', segmentId: open?.id ?? '', requestedBy: DEVICE_ID, at: '2026-03-12T15:10:00Z', stamp: { at: '2026-03-12T15:10:00Z', by: DEVICE_ID } });
    boot(s);
    const c = await card();
    expect(c.getByText('Pause requested')).toBeVisible();
    expect(screen.queryAllByTestId('remote-pause')).toHaveLength(1);
  });

  it('a task running on this computer shows none of it', async () => {
    boot(demoState());
    await card();
    expect(screen.queryByTestId('remote-pause')).toBeNull();
  });
});

describe('which request is waiting', () => {
  const task = { id: 't', runningElsewhere: 'Office PC' } as never;
  const req = (id: string, segmentId: string, at: string): PauseRequest => ({ id, taskId: 't', segmentId, requestedBy: 'x', at, stamp: { at, by: 'x' } });
  const open = (id: string) => ({ id, segmentId: id, taskId: 't', end: null });

  it('only a request about the segment that is open now counts; an older one is history', () => {
    const old = req('r1', 'seg-old', '2026-03-01T10:00:00Z');
    expect(waitingPauseRequest(task, [old], [open('seg-new')])).toBeNull();
    const fresh = req('r2', 'seg-new', '2026-03-02T10:00:00Z');
    expect(waitingPauseRequest(task, [old, fresh], [open('seg-new')])).toBe(fresh);
  });

  it('without the other segment on screen the newest request counts, and a task here has none', () => {
    const a = req('a', 's1', '2026-03-01T10:00:00Z');
    const b = req('b', 's2', '2026-03-02T10:00:00Z');
    expect(waitingPauseRequest(task, [a, b], [])).toBe(b);
    expect(waitingPauseRequest({ id: 't', runningElsewhere: null } as never, [a], [])).toBeNull();
    expect(waitingPauseRequest(task, [], [])).toBeNull();
  });
});
