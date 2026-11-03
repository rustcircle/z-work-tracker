// useReadOnly: the page's early answer to "may this computer change data?", from the lease in the snapshot. The backend's refusal is
// what really stops a change; this only has to agree with it, and say so in the same words.
import { emit } from '@tauri-apps/api/event';
import { clearMocks } from '@tauri-apps/api/mocks';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { api } from '../lib/api';
import type { LeaseView } from '../lib/types';
import { demoState } from '../mocks/demoSeed';
import { handle, installMock, loseLease, readOnlyMessage as backendMessage, seedLease, type LeaseSeed, type MockState } from '../mocks/ipcMock';
import { AppProvider } from './store';
import { useReadOnly, readOnlyMessage, readOnlyOf, type ReadOnly } from './useReadOnly';

afterEach(() => {
  cleanup();
  clearMocks();
});

/** Every answer the hook gave, in the order it gave them. */
function mount(s: MockState): ReadOnly[] {
  const seen: ReadOnly[] = [];
  function Probe() {
    const answer = useReadOnly();
    seen.push(answer);
    return <p data-testid="answer">{answer.readOnly ? `read-only: ${answer.why}` : 'writable'}</p>;
  }
  installMock(s);
  render(
    <AppProvider fallback={() => <p>loading</p>}>
      <Probe />
    </AppProvider>,
  );
  return seen;
}

const answerText = async (): Promise<string> => (await screen.findByTestId('answer')).textContent ?? '';

async function arrives(change: () => void): Promise<void> {
  change();
  await act(async () => {
    await emit('state-changed');
  });
}

const world = (kind?: LeaseSeed): MockState => {
  const s = demoState();
  if (kind) seedLease(s, kind);
  return s;
};

describe('useReadOnly', () => {
  it('is writable with no sync folder, which is every existing screen', async () => {
    mount(world());
    expect(await answerText()).toBe('writable');
  });

  it.each([
    ['checking', 'writable'],
    ['free', 'writable'],
    ['mine', 'writable'],
    ['unknown-writable', 'writable'],
    ['live', 'read-only'],
    ['stale', 'read-only'],
    ['unknown', 'read-only'],
  ] as const)('%s is %s', async (kind, want) => {
    mount(world(kind));
    expect(await answerText()).toMatch(new RegExp(`^${want}`));
  });

  it('says why in the words of the backend’s own refusal, naming who holds the lease', async () => {
    mount(world('live'));
    expect(await answerText()).toBe('read-only: LAPTOP is using zWorkTracker, so this computer is read-only. Take over from the banner to work here.');
    // The page and the mock say it once each; they have to agree.
    expect(readOnlyMessage('LAPTOP')).toBe(backendMessage('LAPTOP'));
    expect(() => handle(world('live'), 'start_task', { id: 't-next' })).toThrow(expect.objectContaining({ message: readOnlyMessage('LAPTOP') }));
  });

  it('follows the lease as it changes: read-only when another computer takes over, writable after taking over', async () => {
    const s = world('mine');
    mount(s);
    expect(await answerText()).toBe('writable');
    await arrives(() => loseLease(s, { deviceName: 'Home PC' }));
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe(`read-only: ${readOnlyMessage('Home PC')}`));
    await arrives(() => {
      handle(s, 'lease_take_over', { expected: { generation: 6, beatSeq: 1 }, mode: 'live' });
    });
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('writable'));
  });

  it('follows a take over made through the typed api, not only a state change', async () => {
    const s = world('live');
    mount(s);
    expect(await answerText()).toMatch(/^read-only/);
    const out = await api.leaseTakeOver({ generation: 4, beatSeq: 83 }, 'live');
    expect(out.outcome).toBe('done');
    await arrives(() => undefined);
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toBe('writable'));
  });

  it('is the same object until the answer changes, so it can sit in a dependency list', async () => {
    const s = world('live');
    const seen = mount(s);
    await answerText();
    // New snapshots that change nothing about the lease: a preference, and the holder growing 30 seconds older.
    await arrives(() => {
      s.hideEarnings = true;
    });
    await arrives(() => {
      s.now += 30;
    });
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(1);
  });

  it('gives a new answer when the holder is another computer, since the words name it', async () => {
    const s = world('live');
    const seen = mount(s);
    await answerText();
    await arrives(() => seedLease(s, 'live', { deviceName: 'Home PC' }));
    await waitFor(() => expect(screen.getByTestId('answer').textContent).toContain('Home PC is using'));
    expect(new Set(seen).size).toBe(2);
  });
});

describe('readOnlyOf', () => {
  const lease = (over: Partial<LeaseView>): LeaseView => ({ state: 'off', readOnly: false, holder: null, generation: null, note: null, reachableRoots: [], unreachableRoots: [], ...over });

  it('answers from any snapshot’s lease, outside React', () => {
    expect(readOnlyOf(lease({}))).toEqual({ readOnly: false, why: null });
    const holder = { deviceId: 'd', deviceName: 'LAPTOP', generation: 1, beatSeq: 1, lastSignAt: null, ageSecs: null, clockSuspect: false };
    expect(readOnlyOf(lease({ state: 'heldByOtherLive', readOnly: true, holder }))).toEqual({ readOnly: true, why: readOnlyMessage('LAPTOP') });
  });

  it('does not make up a name, and still refuses, when a read-only lease has no holder', () => {
    expect(readOnlyOf(lease({ state: 'unknown', readOnly: true }))).toEqual({ readOnly: true, why: readOnlyMessage('Another computer') });
  });

  it('is one shared object for "writable", so comparing by identity is fine', () => {
    expect(readOnlyOf(lease({}))).toBe(readOnlyOf(lease({ state: 'heldByMe' })));
  });
});
