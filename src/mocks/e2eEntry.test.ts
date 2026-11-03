// The e2e build's query parameters for the lease, versions, packaged build and Start with Windows: what a Playwright spec gets by
// opening the page with them.
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import type { AutostartInfo, Snapshot, VersionList } from '../lib/types';
import { installE2eBackend } from './e2eEntry';
import { handle, type MockState } from './ipcMock';

afterEach(() => {
  clearMocks();
  window.history.replaceState({}, '', '/');
});

/** Opens the page as the e2e build would with this query, and returns the state behind it. */
function open(query: string): MockState {
  window.history.replaceState({}, '', `/?${query}`);
  installE2eBackend();
  return window.__mock;
}
const snap = (s: MockState): Snapshot => handle(s, 'get_snapshot', {}) as Snapshot;

describe('the e2e query', () => {
  it('starts with no lease, as every spec has so far', () => {
    const s = open('seed=demo');
    expect(snap(s)).toMatchObject({ lease: { state: 'off', readOnly: false }, platform: { packaged: false }, sync: { joinPending: null } });
    expect(s.versions).toEqual([]);
  });

  it.each([
    ['live', 'heldByOtherLive', true],
    ['stale', 'heldByOtherStale', true],
    ['unknown', 'unknown', true],
    ['mine', 'heldByMe', false],
    ['free', 'free', false],
    ['checking', 'checking', false],
    ['unknown-writable', 'unknown', false],
  ])('?lease=%s is %s, and connects the OneDrive folder `?sync=1` does', (value, state, readOnly) => {
    const s = open(`lease=${value}`);
    expect(snap(s).lease).toMatchObject({ state, readOnly });
    expect(snap(s).sync.targets.map((t) => t.root)).toEqual(['C:\\Users\\me\\OneDrive']);
    expect(snap(s).sync.targets[0]?.status.devicesSeen).toBe(1);
  });

  it('refuses a change under ?lease=live, with the backend’s error, and ?sync=1 alone does not', () => {
    expect(() => handle(open('lease=live'), 'start_task', { id: 't-next' })).toThrow(expect.objectContaining({ code: 'read_only' }));
    expect(() => handle(open('sync=1'), 'start_task', { id: 't-next' })).not.toThrow();
  });

  it('keeps the folder of ?sync=1 when both are given', () => {
    const s = open('sync=1&lease=live');
    expect(snap(s).sync.targets).toHaveLength(1);
    expect(snap(s).sync.detected.map((d) => d.provider)).toEqual(['googleDrive']);
  });

  it('refuses a lease it does not know, so a typo fails the spec loudly instead of testing nothing', () => {
    expect(() => open('lease=mine2')).toThrow(/lease=/);
  });

  it('?versions=1 connects two folders and fills the list', () => {
    const s = open('versions=1');
    expect(snap(s).sync.targets.map((t) => t.provider)).toEqual(['oneDrive', 'googleDrive']);
    expect((handle(s, 'list_versions', {}) as VersionList).versions).toHaveLength(7);
  });

  it('?packaged=1 is a Store build, with its warning until a folder is connected', () => {
    const s = open('packaged=1');
    expect(snap(s).platform.packaged).toBe(true);
    expect(snap(s).warnings.some((w) => w.startsWith('This copy of zWorkTracker keeps its data in a private Windows folder.'))).toBe(true);
    const withFolder = open('packaged=1&sync=1');
    expect(snap(withFolder).warnings.some((w) => w.includes('private Windows folder'))).toBe(false);
  });

  it('?packaged=1&firstRun=1 is the wizard on a Store build', () => {
    const s = open('packaged=1&firstRun=1');
    expect(snap(s)).toMatchObject({ platform: { packaged: true }, setup: { pending: true } });
  });

  it('?autostart= sets what Windows says, and rejects a state it does not know', () => {
    const s = open('packaged=1&autostart=offByUser');
    expect(handle(s, 'get_autostart_info', {}) as AutostartInfo).toMatchObject({ packaged: true, state: 'offByUser', canChange: false });
    expect(() => open('autostart=maybe')).toThrow(/autostart=/);
  });

  it('?join=1 leaves a folder waiting for the user’s choice', () => {
    const s = open('join=1');
    expect(snap(s).sync.joinPending).toMatchObject({ root: 'C:\\Users\\me\\OneDrive', deviceName: 'LAPTOP' });
  });

  it('can have the lease taken away mid-session: a running task stops and the page turns read-only', () => {
    const s = open('lease=mine');
    expect(s.tasks.find((t) => t.id === 't-logo')?.state).toBe('running');
    window.__mockLeaseLost({ deviceName: 'Home PC' });
    expect(snap(s).lease).toMatchObject({ state: 'heldByOtherLive', readOnly: true, holder: { deviceName: 'Home PC' } });
    expect(s.tasks.find((t) => t.id === 't-logo')?.state).toBe('paused');
  });
});
