// The lease, saved versions, the packaged build and Start with Windows on the mock backend: what a page can drive and what it is
// told, in the backend's words, so that a page test that passes on the mock says something about the real one.
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { api } from '../lib/api';
import { parseIso, toIso } from '../lib/tz';
import type { AutostartInfo, AutostartState, RestorePreview, Snapshot, TakeOverPreview, TakeOverResult, VersionList } from '../lib/types';
import { demoState } from './demoSeed';
import {
  DEVICE_ID,
  OTHER_DEVICE_ID,
  PACKAGED_NO_FOLDER_WARNING,
  addVersion,
  autostartFor,
  captureData,
  emptyState,
  handle,
  installMock,
  leaseView,
  loseLease,
  readOnlyMessage,
  seedJoinPending,
  seedLease,
  seedVersions,
  versionName,
  type LeaseSeed,
  type MockState,
} from './ipcMock';

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const snap = (s: MockState) => call<Snapshot>(s, 'get_snapshot');
const fails = (s: MockState, cmd: string, a: Record<string, unknown> = {}) => {
  try {
    handle(s, cmd, a);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error(`${cmd} did not fail`);
};

/** A value a test needs to be there, without a non-null assertion. */
function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`no ${what}`);
  return value;
}

const ONE_DRIVE = 'C:\\Users\\me\\OneDrive';
const DRIVE = 'G:\\My Drive';
const NOW = parseIso('2026-03-12T15:20:00Z');
const ago = (secs: number): string => toIso(NOW - secs);
const unplug = (s: MockState, root: string): void => {
  s.folders[root] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: false };
};

/** LAPTOP holds the lease and shows "Email and invoices" as running, last heard of 90 seconds ago. */
function laptopRunsATask(kind: LeaseSeed = 'live'): MockState {
  const s = demoState();
  const t = s.tasks.find((x) => x.id === 't-mail');
  if (!t) throw new Error('no task');
  t.state = 'running';
  t.pauseReason = null;
  t.runningElsewhere = 'LAPTOP';
  s.segments.push({ id: 'seg-laptop', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: ago(3 * 3600), end: null, provisionalEnd: ago(30 * 60) });
  seedLease(s, kind);
  return s;
}

describe('with no folder, as the mock always started', () => {
  it('has no lease, nothing is refused, and it is not a packaged build', () => {
    const s = demoState();
    const v = snap(s);
    expect(v.lease).toEqual({ state: 'off', readOnly: false, holder: null, generation: null, note: null, reachableRoots: [], unreachableRoots: [] });
    expect(v.platform).toEqual({ packaged: false });
    expect(v.sync.joinPending).toBeNull();
    expect(v.warnings).not.toContain(PACKAGED_NO_FOLDER_WARNING);
    expect(() => call(s, 'create_project', { input: { name: 'New', color: '#123456', billable: true, budgetHours: null, clientZone: null } })).not.toThrow();
    expect(s.projects.some((p) => p.name === 'New')).toBe(true);
  });

  it('shows nothing of a lease that was set, because the lease lives in the folders', () => {
    const s = demoState();
    seedLease(s, 'live');
    call(s, 'remove_sync_target', { root: ONE_DRIVE });
    expect(snap(s).lease.state).toBe('off');
    expect(() => call(s, 'create_task', { input: { name: 'x', projectId: 'p-web', description: null } })).not.toThrow();
  });

  it('is free once a folder is connected and nobody holds it, with nothing to see', () => {
    const s = demoState();
    call(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
    expect(snap(s).lease).toMatchObject({ state: 'free', readOnly: false, holder: null, reachableRoots: [ONE_DRIVE], unreachableRoots: [] });
  });
});

describe('each lease state', () => {
  const cases: [LeaseSeed, Partial<Snapshot['lease']>][] = [
    ['checking', { state: 'checking', readOnly: false, holder: null }],
    ['free', { state: 'free', readOnly: false, holder: null, generation: 4 }],
    ['mine', { state: 'heldByMe', readOnly: false, holder: null, generation: 5 }],
    ['live', { state: 'heldByOtherLive', readOnly: true, generation: 4, holder: expect.objectContaining({ deviceName: 'LAPTOP', beatSeq: 83, ageSecs: 90, clockSuspect: false }) }],
    ['stale', { state: 'heldByOtherStale', readOnly: true, holder: expect.objectContaining({ deviceName: 'LAPTOP', ageSecs: 2400 }) }],
    ['unknown', { state: 'unknown', readOnly: true, reachableRoots: [], unreachableRoots: [ONE_DRIVE], holder: expect.objectContaining({ deviceName: 'LAPTOP', ageSecs: 7200 }) }],
    ['unknown-writable', { state: 'unknown', readOnly: false, holder: null, reachableRoots: [], unreachableRoots: [ONE_DRIVE] }],
  ];
  it.each(cases)('%s', (kind, want) => {
    const s = demoState();
    seedLease(s, kind);
    expect(snap(s).lease).toMatchObject(want);
  });

  it('connects a folder when seeding one and none is', () => {
    const s = demoState();
    expect(s.targets).toHaveLength(0);
    seedLease(s, 'live');
    expect(s.targets.map((t) => t.root)).toEqual([ONE_DRIVE]);
  });

  it('ages the holder with the clock of the backend, from its last sign', () => {
    const s = demoState();
    seedLease(s, 'live');
    s.now += 600;
    expect(snap(s).lease.holder).toMatchObject({ lastSignAt: ago(90), ageSecs: 690 });
  });

  it('uses the holder a test describes', () => {
    const s = demoState();
    seedLease(s, 'live', { deviceName: 'Home PC', clockSuspect: true });
    expect(snap(s).lease.holder).toMatchObject({ deviceName: 'Home PC', clockSuspect: true });
  });

  it('is the lease of the folders that can be read: a lost folder is listed, and one left is enough', () => {
    const s = demoState();
    seedLease(s, 'live');
    call(s, 'add_sync_target', { provider: 'googleDrive', root: DRIVE });
    unplug(s, DRIVE);
    expect(snap(s).lease).toMatchObject({ state: 'heldByOtherLive', readOnly: true, reachableRoots: [ONE_DRIVE], unreachableRoots: [DRIVE] });
  });

  it('turns unknown when every folder is lost, and read-only only if another computer held it', () => {
    const live = demoState();
    seedLease(live, 'live');
    unplug(live, ONE_DRIVE);
    expect(snap(live).lease).toMatchObject({ state: 'unknown', readOnly: true, holder: expect.objectContaining({ deviceName: 'LAPTOP' }) });
    const mine = demoState();
    seedLease(mine, 'mine');
    unplug(mine, ONE_DRIVE);
    expect(snap(mine).lease).toMatchObject({ state: 'unknown', readOnly: false, holder: null });
  });

  it('comes back as it was when the folder does', () => {
    const s = demoState();
    seedLease(s, 'live');
    unplug(s, ONE_DRIVE);
    expect(snap(s).lease.state).toBe('unknown');
    s.folders[ONE_DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: true };
    expect(snap(s).lease.state).toBe('heldByOtherLive');
  });
});

describe('the gate', () => {
  it('refuses a change with the backend’s error, and nothing is written', () => {
    const s = demoState();
    seedLease(s, 'live');
    const before = JSON.stringify([s.projects, s.tasks, s.segments, s.audit, s.settings]);
    expect(fails(s, 'start_task', { id: 't-next' })).toEqual({
      code: 'read_only',
      message: 'LAPTOP is using zWorkTracker, so this computer is read-only. Take over from the banner to work here.',
    });
    expect(fails(s, 'create_project', { input: { name: 'x', color: '#123456', billable: true, budgetHours: null, clientZone: null } }).code).toBe('read_only');
    expect(JSON.stringify([s.projects, s.tasks, s.segments, s.audit, s.settings])).toBe(before);
  });

  it('refuses the same way when a computer held it and no folder can be read, and says who', () => {
    const s = demoState();
    seedLease(s, 'unknown');
    expect(fails(s, 'pause_task', { id: 't-logo' })).toEqual({ code: 'read_only', message: readOnlyMessage('LAPTOP') });
  });

  it('does not refuse a computer that is writable in every other state', () => {
    for (const kind of ['checking', 'free', 'mine', 'unknown-writable'] as const) {
      const s = demoState();
      seedLease(s, kind);
      expect(() => call(s, 'set_setting', { key: 'idleMinutes', value: 5 }), kind).not.toThrow();
    }
  });

  it('lets a read-only computer look, keep its own preferences, sync, report and ask the holder to pause', () => {
    const s = laptopRunsATask();
    expect(snap(s).lease.readOnly).toBe(true);
    expect(() => call(s, 'set_theme', { theme: 'dark' })).not.toThrow();
    expect(() => call(s, 'set_hide_earnings', { hide: true })).not.toThrow();
    expect(() => call(s, 'set_backup_keep', { keep: 10 })).not.toThrow();
    expect(() => call(s, 'sync_now')).not.toThrow();
    expect(() => call(s, 'set_setting', { key: 'activeZone', value: 'UTC' })).not.toThrow();
    expect(call(s, 'get_audit', {})).toEqual(expect.any(Array));
    expect(call<Snapshot>(s, 'request_remote_pause', { taskId: 't-mail' }).pauseRequests).toHaveLength(1);
  });

  it('is lifted by taking the folder away, which is the way out when nothing else works', () => {
    const s = demoState();
    seedLease(s, 'live');
    expect(fails(s, 'delete_draft', { id: 't-next' }).code).toBe('read_only');
    call(s, 'remove_sync_target', { root: ONE_DRIVE });
    expect(() => call(s, 'delete_draft', { id: 't-next' })).not.toThrow();
  });
});

describe('taking over', () => {
  it('shows the holder and the running task that would be closed, at the last moment the holder was seen', () => {
    const s = laptopRunsATask();
    const p = call<TakeOverPreview>(s, 'lease_preview_take_over');
    expect(p).toMatchObject({ live: true, unreachable: false, holder: { deviceName: 'LAPTOP', generation: 4, beatSeq: 83 } });
    expect(p.segments).toEqual([{ segmentId: 'seg-laptop', taskName: 'Email and invoices', end: ago(90), secs: 3 * 3600 - 90 }]);
  });

  it('says a stale holder is not live, and caps the end at a pause request', () => {
    const s = laptopRunsATask('stale');
    call(s, 'request_remote_pause', { taskId: 't-mail' });
    s.pauseRequests[0] = { ...must(s.pauseRequests[0], 'pause request'), at: ago(2 * 3600) };
    const p = call<TakeOverPreview>(s, 'lease_preview_take_over');
    expect(p.live).toBe(false);
    expect(p.segments[0]).toMatchObject({ end: ago(2 * 3600) });
  });

  it('takes over after the double check: the holder’s time is settled, the task stops, and this computer can write', () => {
    const s = laptopRunsATask();
    const out = call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: 4, beatSeq: 83 }, mode: 'live' });
    expect(out.outcome).toBe('done');
    expect(out.preview).toBeNull();
    expect(out.snapshot.lease).toMatchObject({ state: 'heldByMe', readOnly: false, holder: null, generation: 5 });
    const raw = out.snapshot.rawSegments.find((x) => x.id === 'seg-laptop');
    expect(raw).toMatchObject({ rawEnd: null, corrected: true, voided: false, end: ago(90) });
    expect(raw?.reason).toBe('Closed from Mock PC: LAPTOP stopped responding. Ended at its last known moment.');
    const t = out.snapshot.tasks.find((x) => x.id === 't-mail');
    expect(t).toMatchObject({ state: 'paused', pauseReason: { kind: 'syncReconciled' }, runningElsewhere: null });
    expect(out.snapshot.notices.map((n) => n.message)).toContain('You took over from LAPTOP. 1 running task was closed at its last known time.');
    expect(call<{ action: string }[]>(s, 'get_audit', { entityId: 'seg-laptop' }).map((e) => e.action)).toContain('settleLost');
    expect(() => call(s, 'start_task', { id: 't-next' })).not.toThrow();
  });

  it('says only that it took over when there was nothing to close', () => {
    const s = demoState();
    seedLease(s, 'stale');
    const out = call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: 4, beatSeq: 83 }, mode: 'stale' });
    expect(out.snapshot.notices.map((n) => n.message)).toContain('You took over from LAPTOP.');
  });

  it('answers "changed" when the holder beat while the dialog was open, changes nothing, and goes through with the fresh view', () => {
    const s = laptopRunsATask();
    const shown = call<TakeOverPreview>(s, 'lease_preview_take_over').holder;
    s.lease = { ...s.lease, holder: { ...must(s.lease.holder, 'holder'), beatSeq: 84, lastSignAt: ago(5) } };
    const out = call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: must(shown).generation, beatSeq: must(shown).beatSeq }, mode: 'stale' });
    expect(out.outcome).toBe('changed');
    expect(out.preview).toMatchObject({ holder: { beatSeq: 84 }, live: true });
    expect(out.snapshot.lease).toMatchObject({ state: 'heldByOtherLive', readOnly: true });
    expect(s.segments.find((x) => x.id === 'seg-laptop')?.edit).toBeUndefined();
    // Asked again with what it was just shown, it goes through.
    expect(call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: 4, beatSeq: 84 }, mode: 'live' }).outcome).toBe('done');
  });

  it('answers "changed" when the holder let go in the meantime', () => {
    const s = laptopRunsATask();
    s.lease = { ...s.lease, state: 'free', readOnly: false, holder: null };
    const out = call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: 4, beatSeq: 83 }, mode: 'live' });
    expect(out).toMatchObject({ outcome: 'changed', preview: { holder: null, live: false, segments: [] } });
  });

  it('answers "unreachable" when no folder can be read, unless it is the offline take over', () => {
    const s = laptopRunsATask();
    unplug(s, ONE_DRIVE);
    const out = call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: 4, beatSeq: 83 }, mode: 'stale' });
    expect(out.outcome).toBe('unreachable');
    expect(out.snapshot.lease.readOnly).toBe(true);
    expect(call<TakeOverPreview>(s, 'lease_preview_take_over')).toMatchObject({ unreachable: true, segments: [] });
  });

  it('works offline: writable at once, nothing settled, and holds the lease when the folder is back', () => {
    const s = laptopRunsATask('unknown');
    expect(snap(s).lease).toMatchObject({ state: 'unknown', readOnly: true });
    // With no folder to read, only the last holder's name, generation and time are known, so the page is shown no beat.
    const shown = must(call<TakeOverPreview>(s, 'lease_preview_take_over').holder);
    expect(shown).toMatchObject({ generation: 4, beatSeq: 0 });
    const out = call<TakeOverResult>(s, 'lease_take_over', { expected: { generation: shown.generation, beatSeq: shown.beatSeq }, mode: 'offline' });
    expect(out.outcome).toBe('done');
    expect(out.snapshot.lease).toMatchObject({ state: 'unknown', readOnly: false });
    expect(s.segments.find((x) => x.id === 'seg-laptop')?.edit).toBeUndefined();
    expect(() => call(s, 'start_task', { id: 't-next' })).not.toThrow();
    s.folders[ONE_DRIVE] = { devices: [], counts: { projects: 0, tasks: 0, segments: 0 }, available: true };
    expect(snap(s).lease).toMatchObject({ state: 'heldByMe', readOnly: false, generation: 5 });
  });

  it('can be told how to end next, once, whatever the lease says', () => {
    const s = laptopRunsATask();
    const expected = { generation: 4, beatSeq: 83 };
    s.takeOverNext = 'unreachable';
    expect(call<TakeOverResult>(s, 'lease_take_over', { expected, mode: 'live' }).outcome).toBe('unreachable');
    expect(s.takeOverNext).toBeUndefined();
    s.takeOverNext = 'changed';
    const changed = call<TakeOverResult>(s, 'lease_take_over', { expected, mode: 'live' });
    expect(changed.outcome).toBe('changed');
    expect(changed.preview?.holder?.beatSeq).toBe(84);
    s.takeOverNext = 'done';
    // Forced through even though what it was shown is out of date.
    expect(call<TakeOverResult>(s, 'lease_take_over', { expected, mode: 'live' }).outcome).toBe('done');
    expect(snap(s).lease.state).toBe('heldByMe');
  });

  it('asks for what it was shown, and for a mode', () => {
    const s = laptopRunsATask();
    expect(fails(s, 'lease_take_over', { mode: 'live' }).code).toBe('validation');
    expect(fails(s, 'lease_take_over', { expected: { generation: 4, beatSeq: 83 }, mode: 'now' }).code).toBe('validation');
  });

  it('lets go on "Release now", keeping the generation, and does nothing for a computer that holds nothing', () => {
    const s = demoState();
    seedLease(s, 'mine');
    // The demo has Logo concepts running here, which keeps this computer in use (see the next test).
    call(s, 'pause_task', { id: 't-logo' });
    expect(call<Snapshot>(s, 'lease_release').lease).toMatchObject({ state: 'free', generation: 5 });
    const other = demoState();
    seedLease(other, 'live');
    expect(call<Snapshot>(other, 'lease_release').lease.state).toBe('heldByOtherLive');
  });

  it('refuses "Release now" while a task is timing here, as the backend does, and goes on holding', () => {
    const s = demoState();
    seedLease(s, 'mine');
    expect(fails(s, 'lease_release')).toEqual({ code: 'conflict', message: 'a task is running here, so this computer is still in use. Pause it first.' });
    expect(snap(s).lease).toMatchObject({ state: 'heldByMe', generation: 5 });
    call(s, 'pause_task', { id: 't-logo' });
    expect(call<Snapshot>(s, 'lease_release').lease.state).toBe('free');
  });

  it('counts only a timer on this computer: one left running on another does not keep this one in use', () => {
    const s = demoState();
    seedLease(s, 'mine');
    call(s, 'pause_task', { id: 't-logo' });
    s.segments.push({ id: 'seg-laptop', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: ago(3600), end: null, provisionalEnd: ago(60) });
    expect(call<Snapshot>(s, 'lease_release').lease.state).toBe('free');
  });

  it('refuses "Release now" when no folder can be written, as the backend does, and goes on holding', () => {
    const s = demoState();
    seedLease(s, 'mine');
    call(s, 'pause_task', { id: 't-logo' });
    unplug(s, ONE_DRIVE);
    expect(fails(s, 'lease_release')).toEqual({
      code: 'conflict',
      message: 'no sync folder could be written just now, so this computer still holds it. Try again when a folder can be reached.',
    });
    expect(s.lease.state).toBe('heldByMe');
  });

  it('lets go of the lease when the last folder is taken away, so the next connection starts free', () => {
    const s = demoState();
    seedLease(s, 'mine');
    call(s, 'remove_sync_target', { root: ONE_DRIVE });
    call(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
    expect(snap(s).lease.state).toBe('free');
  });
});

describe('losing the lease while it runs', () => {
  it('closes the timer as sync-reconciled, turns read-only behind the new holder and tells the user', () => {
    const s = demoState();
    seedLease(s, 'mine');
    expect(s.tasks.find((t) => t.id === 't-logo')?.state).toBe('running');
    loseLease(s);
    const v = snap(s);
    expect(v.lease).toMatchObject({ state: 'heldByOtherLive', readOnly: true, holder: { deviceName: 'LAPTOP', generation: 6 } });
    expect(v.tasks.find((t) => t.id === 't-logo')).toMatchObject({ state: 'paused', pauseReason: { kind: 'syncReconciled' } });
    expect(v.rawSegments.some((x) => x.taskId === 't-logo' && x.rawEnd === null)).toBe(false);
    expect(v.notices.map((n) => n.message)).toContain('LAPTOP took over, so this computer is now read-only. "Logo concepts" stopped timing here at 15:20. Nothing was lost: it will sync.');
    expect(fails(s, 'resume_task', { id: 't-logo' }).code).toBe('read_only');
  });

  it('leaves the second sentence out when nothing was running', () => {
    const s = emptyState();
    seedLease(s, 'mine');
    loseLease(s, { deviceName: 'Home PC' });
    expect(snap(s).notices.map((n) => n.message)).toEqual(['Home PC took over, so this computer is now read-only. Nothing was lost: it will sync.']);
  });
});

describe('a task another computer left running (settle_lost_segment, no take over)', () => {
  /** Started three days ago, last heard of two days ago. */
  function abandoned(): MockState {
    const s = demoState();
    const t = s.tasks.find((x) => x.id === 't-mail');
    if (!t) throw new Error('no task');
    t.state = 'running';
    t.runningElsewhere = 'Office PC';
    s.segments.push({ id: 'seg-old', taskId: 't-mail', deviceId: OTHER_DEVICE_ID, start: ago(3 * 86_400), end: null, provisionalEnd: ago(2 * 86_400) });
    return s;
  }

  it('closes it at its last known moment once the other computer has been silent for a day, and records why', () => {
    const s = abandoned();
    const out = call<Snapshot>(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: 'Closed at last known time' });
    expect(out.rawSegments.find((x) => x.id === 'seg-old')).toMatchObject({ rawEnd: null, corrected: true, end: ago(2 * 86_400), reason: 'Closed at last known time' });
    expect(out.tasks.find((t) => t.id === 't-mail')).toMatchObject({ state: 'paused', runningElsewhere: null });
  });

  it('refuses a computer that was seen recently, with its age, unless it was asked to pause', () => {
    const s = abandoned();
    // Seen is when the computer last wrote its file, not the last heartbeat of this segment (service.rs `settle_lost_segment`).
    s.remoteDevices = { [OTHER_DEVICE_ID]: { name: 'Office PC', writtenAt: ago(90 * 60) } };
    expect(fails(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' })).toEqual({ code: 'conflict', message: 'Office PC was seen 1 h 30 min ago, so it may still be running this' });
    call(s, 'request_remote_pause', { taskId: 't-mail' });
    expect(() => call(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' })).not.toThrow();
  });

  it('refuses a segment of this computer, one that is closed, and one that is not there', () => {
    const s = abandoned();
    expect(fails(s, 'settle_lost_segment', { segmentId: 's1', reason: '' }).code).toBe('conflict');
    expect(fails(s, 'settle_lost_segment', { segmentId: 'nope', reason: '' }).code).toBe('not_found');
  });

  it('is refused while read-only, like any change', () => {
    const s = abandoned();
    seedLease(s, 'live');
    expect(fails(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' }).code).toBe('read_only');
  });

  it('leaves a settled segment correctable and voidable at its end, and restorable never', () => {
    const s = abandoned();
    call(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' });
    const end = ago(2 * 86_400);
    expect(fails(s, 'restore_segment', { id: 'seg-old', reason: '' })).toEqual({ code: 'conflict', message: "this segment's device never reported an end, so it can only be corrected" });
    const voided = call<Snapshot>(s, 'void_segment', { id: 'seg-old', reason: 'not work' });
    expect(voided.rawSegments.find((x) => x.id === 'seg-old')).toMatchObject({ voided: true, rawEnd: null });
    expect(s.segments.find((x) => x.id === 'seg-old')?.edit).toMatchObject({ voided: true, end });
    const t = abandoned();
    call(t, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' });
    const fixed = call<Snapshot>(t, 'correct_segment', { input: { segmentId: 'seg-old', start: ago(3 * 86_400 - 60), end: ago(2 * 86_400 + 600), reason: 'checked' } });
    expect(fixed.rawSegments.find((x) => x.id === 'seg-old')).toMatchObject({ corrected: true, rawEnd: null, end: ago(2 * 86_400 + 600) });
  });

  it('still refuses to correct, void or restore a segment that is running', () => {
    const s = abandoned();
    expect(fails(s, 'correct_segment', { input: { segmentId: 'seg-old', start: ago(3600), end: ago(60), reason: '' } }).code).toBe('conflict');
    expect(fails(s, 'void_segment', { id: 'seg-old', reason: '' }).message).toBe('this segment is still running; pause the task first');
    expect(fails(s, 'request_remote_pause', { taskId: 't-logo' }).code).toBe('conflict');
  });

  it('no longer offers a pause request once the segment is settled', () => {
    const s = abandoned();
    call(s, 'settle_lost_segment', { segmentId: 'seg-old', reason: '' });
    expect(fails(s, 'request_remote_pause', { taskId: 't-mail' }).message).toBe("this task isn't running on another device");
  });
});

describe('saved versions', () => {
  it('lists them newest first with a badge for each folder that holds a copy, and what they weigh', () => {
    const s = demoState();
    seedVersions(s);
    expect(s.targets.map((t) => t.provider)).toEqual(['oneDrive', 'googleDrive']);
    expect(s.detected).toEqual([]);
    const list = call<VersionList>(s, 'list_versions');
    expect(list.versions).toHaveLength(7);
    expect(list.errors).toEqual([]);
    expect(list.overBudget).toBe(false);
    const times = list.versions.map((v) => v.takenAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(list.versions[0]).toEqual({
      name: versionName(ago(55 * 60), DEVICE_ID, 'auto'),
      takenAt: ago(55 * 60),
      deviceName: 'Mock PC',
      reason: 'auto',
      pinned: false,
      locations: [
        { root: ONE_DRIVE, provider: 'oneDrive', bytes: 182_400 },
        { root: DRIVE, provider: 'googleDrive', bytes: 182_400 },
      ],
    });
    expect(list.versions.filter((v) => v.pinned).map((v) => v.reason)).toEqual(['pre-restore', 'takeover']);
    expect(list.totalBytes).toBe(list.versions.reduce((n, v) => n + v.locations.reduce((m, l) => m + l.bytes, 0), 0));
  });

  it('leaves out the mock’s own fields, so a page sees what the backend sends', () => {
    const s = demoState();
    seedVersions(s);
    for (const v of call<VersionList>(s, 'list_versions').versions) expect(Object.keys(v).sort()).toEqual(['deviceName', 'locations', 'name', 'pinned', 'reason', 'takenAt']);
  });

  it('reports a folder it can not read and lists the rest', () => {
    const s = demoState();
    seedVersions(s);
    unplug(s, DRIVE);
    const list = call<VersionList>(s, 'list_versions');
    expect(list.errors).toEqual([{ root: DRIVE, message: 'Folder not found. Is the drive connected and the desktop client running?' }]);
    // The copy only Google Drive holds is gone from the list; the others show just the copy that can be seen.
    expect(list.versions).toHaveLength(6);
    expect(list.versions[0]?.locations.map((l) => l.root)).toEqual([ONE_DRIVE]);
  });

  it('looks in another folder too when asked, and says if that one is not there', () => {
    const s = demoState();
    seedVersions(s);
    const old = 'D:\\Old cloud';
    const v = addVersion(s, { takenAt: ago(400 * 86_400), roots: [old] });
    expect(call<VersionList>(s, 'list_versions').versions.some((x) => x.name === v.name)).toBe(false);
    expect(call<VersionList>(s, 'list_versions', { extraRoot: old }).versions.find((x) => x.name === v.name)?.locations).toEqual([{ root: old, provider: 'custom', bytes: 150_000 }]);
    unplug(s, old);
    expect(call<VersionList>(s, 'list_versions', { extraRoot: old }).errors.map((e) => e.root)).toEqual([old]);
  });

  it('warns about more than a gibibyte and deletes nothing', () => {
    const s = demoState();
    seedVersions(s);
    addVersion(s, { takenAt: ago(86_400 * 200), bytes: 1024 ** 3 });
    expect(call<VersionList>(s, 'list_versions').overBudget).toBe(true);
    expect(s.versions).toHaveLength(8);
  });

  it('reads the change record of a copy, by a name that must be a version’s', () => {
    const s = demoState();
    seedVersions(s);
    const first = must(call<VersionList>(s, 'list_versions').versions[0]);
    const text = call<string>(s, 'read_version_changes', { root: ONE_DRIVE, name: first.name });
    expect(text.split('\n')[0]).toBe('zWorkTracker version saved 12 Mar 2026, 14:25 UTC');
    expect(text).toContain('corrected a time segment on "Logo concepts"');
    for (const name of ['../../x', 'z-work-data', `${first.name}.json.gz`, '']) expect(fails(s, 'read_version_changes', { root: ONE_DRIVE, name }).code, name).toBe('validation');
    expect(fails(s, 'read_version_changes', { root: 'E:\\none', name: first.name }).code).toBe('not_found');
  });

  it('can not read a copy that is still syncing, but can read the same version from the other folder', () => {
    const s = demoState();
    seedVersions(s);
    const slow = must(call<VersionList>(s, 'list_versions').versions.find((v) => v.reason === 'auto' && v.takenAt === ago(40 * 86_400)), 'version');
    expect(fails(s, 'read_version_changes', { root: DRIVE, name: slow.name }).code).toBe('io');
    expect(fails(s, 'preview_restore_version', { root: DRIVE, name: slow.name }).code).toBe('io');
    expect(fails(s, 'restore_version', { root: DRIVE, name: slow.name }).code).toBe('io');
    expect(call<string>(s, 'read_version_changes', { root: ONE_DRIVE, name: slow.name })).toContain('zWorkTracker version saved');
    addVersion(s, { takenAt: ago(86_400 * 3), failRead: true });
    const all = call<VersionList>(s, 'list_versions').versions.find((v) => v.takenAt === ago(86_400 * 3));
    expect(fails(s, 'read_version_changes', { root: ONE_DRIVE, name: must(all).name }).code).toBe('io');
  });

  it('previews a restore against what is here now', () => {
    const s = demoState();
    seedVersions(s);
    const first = must(call<VersionList>(s, 'list_versions').versions[0]);
    const p = call<RestorePreview>(s, 'preview_restore_version', { root: ONE_DRIVE, name: first.name });
    expect(p).toEqual({
      name: first.name,
      takenAt: first.takenAt,
      reason: 'auto',
      version: { projects: 4, tasks: 6, segments: 118 },
      current: { projects: s.projects.length, tasks: s.tasks.length, segments: s.segments.length },
      warnings: [],
      blockedReason: null,
    });
  });

  it('counts a version from the data it holds, and passes on what could not be read', () => {
    const s = demoState();
    const small = emptyState();
    small.projects = s.projects.slice(0, 1);
    const v = addVersion(s, { takenAt: ago(60), roots: [ONE_DRIVE], data: captureData(small), warnings: ['Skipped 1 time segment that could not be read.'] });
    expect(call<RestorePreview>(s, 'preview_restore_version', { root: ONE_DRIVE, name: v.name })).toMatchObject({ version: { projects: 1, tasks: 0, segments: 0 }, warnings: ['Skipped 1 time segment that could not be read.'] });
  });

  it('says why a restore can not go ahead: read-only, or a reason only the backend knows', () => {
    const s = demoState();
    seedVersions(s);
    const first = must(call<VersionList>(s, 'list_versions').versions[0]);
    must(s.versions[0]).blockedReason = 'This version was saved by a newer app. Update zWorkTracker first.';
    expect(call<RestorePreview>(s, 'preview_restore_version', { root: ONE_DRIVE, name: first.name }).blockedReason).toBe('This version was saved by a newer app. Update zWorkTracker first.');
    seedLease(s, 'live');
    expect(call<RestorePreview>(s, 'preview_restore_version', { root: ONE_DRIVE, name: first.name }).blockedReason).toBe('Take over first to restore.');
  });

  it('restores: the data comes back, a copy of today’s goes to every folder and to this computer, and the launch is cold', () => {
    const s = demoState();
    const before = s.projects.length;
    const smaller = demoState();
    smaller.projects = smaller.projects.slice(0, 2);
    smaller.tasks = smaller.tasks.filter((t) => smaller.projects.some((p) => p.id === t.projectId));
    seedVersions(s);
    const v = addVersion(s, { takenAt: ago(30), reason: 'manual', roots: [ONE_DRIVE, DRIVE], data: captureData(smaller) });
    s.warm = true;
    const out = call<Snapshot>(s, 'restore_version', { root: ONE_DRIVE, name: v.name });
    expect(out.projects).toHaveLength(2);
    expect(out.projects.length).toBeLessThan(before);
    expect(out.launch.warm).toBe(false);
    expect(out.tasks.find((t) => t.id === 't-logo')?.state).not.toBe('running');
    const list = call<VersionList>(s, 'list_versions').versions;
    const pre = list.find((x) => x.reason === 'pre-restore' && x.takenAt === toIso(s.now));
    expect(pre).toMatchObject({ pinned: true, locations: [{ root: ONE_DRIVE }, { root: DRIVE }] });
    const held = s.versions.find((x) => x.name === pre?.name);
    expect(held?.data ? (JSON.parse(held.data) as { projects: unknown[] }).projects : []).toHaveLength(before);
    expect(s.backups.some((b) => b.safety)).toBe(true);
    const notes = out.notices.map((n) => n.message);
    expect(notes).toContainEqual(expect.stringMatching(/^Restored the version from 12 Mar 2026, 15:19 UTC\. The data just before it is kept as pre-restore-.+\.json and as the version \d{8}T\d{6}Z--11111111--pre-restore\.$/));
    expect(notes.join('\n')).not.toContain('merge back');
    expect(call<{ action: string }[]>(s, 'get_audit', { entityId: v.name }).map((e) => e.action)).toEqual(['restore']);
  });

  it('restores a version that holds no data by only pausing, as a backup without data does', () => {
    const s = demoState();
    seedVersions(s);
    const first = must(call<VersionList>(s, 'list_versions').versions[0]);
    const projects = s.projects.length;
    const out = call<Snapshot>(s, 'restore_version', { root: ONE_DRIVE, name: first.name });
    expect(out.projects).toHaveLength(projects);
    expect(out.tasks.find((t) => t.id === 't-logo')?.state).toBe('paused');
  });

  it('is refused while read-only, and when no folder can take the copy of today’s data first', () => {
    const s = demoState();
    seedVersions(s);
    const first = must(call<VersionList>(s, 'list_versions').versions[0]);
    seedLease(s, 'live');
    expect(fails(s, 'restore_version', { root: ONE_DRIVE, name: first.name }).code).toBe('read_only');
    seedLease(s, 'mine');
    const old = addVersion(s, { takenAt: ago(86_400 * 300), roots: ['D:\\Old cloud'] });
    unplug(s, ONE_DRIVE);
    unplug(s, DRIVE);
    const before = JSON.stringify([s.projects, s.versions.length, s.backups]);
    expect(fails(s, 'restore_version', { root: 'D:\\Old cloud', name: old.name })).toEqual({ code: 'conflict', message: "Couldn't save a copy of today's data to any folder first, so nothing was changed." });
    expect(JSON.stringify([s.projects, s.versions.length, s.backups])).toBe(before);
  });

  it('saves a version now, in every folder that can be written', () => {
    const s = demoState();
    seedVersions(s);
    unplug(s, DRIVE);
    const out = call<Snapshot>(s, 'save_version_now');
    expect(out.revision).toBeGreaterThan(0);
    const top = s.versions.find((v) => v.reason === 'manual' && v.takenAt === toIso(s.now));
    expect(top?.locations.map((l) => l.root)).toEqual([ONE_DRIVE]);
    expect(top?.data ? (JSON.parse(top.data) as { projects: unknown[] }).projects : []).toHaveLength(s.projects.length);
  });

  it('can not save with no folder to put it in, or none that can be written, or while read-only', () => {
    const none = demoState();
    expect(fails(none, 'save_version_now').message).toBe('Connect a sync folder first: versions are saved there.');
    const s = demoState();
    seedVersions(s);
    unplug(s, ONE_DRIVE);
    unplug(s, DRIVE);
    expect(fails(s, 'save_version_now')).toEqual({ code: 'io', message: "Couldn't save a version: no sync folder could be written." });
    const ro = demoState();
    seedVersions(ro);
    seedLease(ro, 'live');
    expect(fails(ro, 'save_version_now').code).toBe('read_only');
    expect(ro.versions).toHaveLength(7);
  });

  it('lists the versions while read-only, and reads their change records', () => {
    const s = demoState();
    seedVersions(s);
    seedLease(s, 'live');
    const list = call<VersionList>(s, 'list_versions');
    expect(list.versions).toHaveLength(7);
    expect(call<string>(s, 'read_version_changes', { root: ONE_DRIVE, name: must(list.versions[0]).name })).toContain('zWorkTracker version saved');
  });
});

describe('the join choice', () => {
  it('is null until a folder with restored data meets data from before it, and is answered once', () => {
    const s = demoState();
    expect(snap(s).sync.joinPending).toBeNull();
    seedJoinPending(s);
    expect(snap(s).sync.joinPending).toEqual({ root: ONE_DRIVE, takenFrom: versionName(ago(3 * 86_400), OTHER_DEVICE_ID, 'auto'), at: ago(3 * 86_400), deviceName: 'LAPTOP' });
    const out = call<Snapshot>(s, 'resolve_join', { root: ONE_DRIVE, choice: 'follow' });
    expect(out.sync.joinPending).toBeNull();
    // Following keeps what was here before, in a safety copy on this computer and as a version in the folder, and the notice names both.
    const kept = must(s.versions.find((v) => v.reason === 'pre-adopt'));
    const safety = must(s.backups.find((b) => b.safety));
    expect(kept).toMatchObject({ pinned: true, locations: [{ root: ONE_DRIVE }] });
    expect(out.notices.map((n) => n.message)).toContain(
      `LAPTOP restored the version from 9 Mar 2026, 15:20 UTC. This computer now follows it. What was here before is kept in ${safety.name} and in the version ${kept.name}.`,
    );
    expect(fails(s, 'resolve_join', { root: ONE_DRIVE, choice: 'keep' }).code).toBe('conflict');
  });

  it('can leave the question on a folder that is not connected, as a move into a folder past a restore does', () => {
    const s = demoState();
    seedJoinPending(s, { root: DRIVE });
    // A folder is connected so there is something to move from, and the question is about the other one.
    expect(s.targets.map((t) => t.root)).toEqual([ONE_DRIVE]);
    expect(snap(s).sync.joinPending).toEqual({ root: DRIVE, takenFrom: versionName(ago(3 * 86_400), OTHER_DEVICE_ID, 'auto'), at: ago(3 * 86_400), deviceName: 'LAPTOP' });
    expect(fails(s, 'resolve_join', { root: ONE_DRIVE, choice: 'keep' }).code).toBe('conflict');
    // The backend accepts an answer for a root that is not connected (`join_folder` skips it), and the question is gone.
    expect(call<Snapshot>(s, 'resolve_join', { root: DRIVE, choice: 'follow' }).sync.joinPending).toBeNull();
    expect(s.targets.map((t) => t.root)).toEqual([ONE_DRIVE]);
    // It keeps the connected folder it finds, and a root that is given is used as it is.
    const connected = demoState();
    call(connected, 'add_sync_target', { provider: 'googleDrive', root: DRIVE });
    seedJoinPending(connected, { root: 'E:\\Elsewhere' });
    expect(connected.targets.map((t) => t.root)).toEqual([DRIVE]);
    expect(snap(connected).sync.joinPending?.root).toBe('E:\\Elsewhere');
  });

  it('is not forgotten when another folder is taken away, only with the folder it is about', () => {
    const s = demoState();
    seedJoinPending(s, { root: DRIVE });
    call(s, 'remove_sync_target', { root: ONE_DRIVE });
    expect(snap(s).sync.joinPending?.root).toBe(DRIVE);
  });

  it('knows two choices, answers the right folder, and says what keeping does', () => {
    const s = demoState();
    seedJoinPending(s);
    expect(fails(s, 'resolve_join', { root: ONE_DRIVE, choice: 'both' }).code).toBe('validation');
    expect(fails(s, 'resolve_join', { root: 'E:\\other', choice: 'keep' }).code).toBe('conflict');
    expect(call<Snapshot>(s, 'resolve_join', { root: ONE_DRIVE, choice: 'keep' }).notices.at(-1)?.message).toBe(
      "Kept this computer's data together with the version restored on LAPTOP. Rolled-back items may return on every computer.",
    );
    expect(s.versions).toHaveLength(0);
  });

  it('is forgotten with its folder, and is not refused while read-only, since it is how a folder is joined', () => {
    const s = demoState();
    seedJoinPending(s);
    seedLease(s, 'live');
    expect(() => call(s, 'resolve_join', { root: ONE_DRIVE, choice: 'follow' })).not.toThrow();
    seedJoinPending(s);
    call(s, 'remove_sync_target', { root: ONE_DRIVE });
    expect(snap(s).sync.joinPending).toBeNull();
  });
});

describe('the packaged build', () => {
  it('is said in the snapshot, and warns without a folder until one is connected', () => {
    const s = demoState();
    s.packaged = true;
    expect(snap(s).platform).toEqual({ packaged: true });
    expect(snap(s).warnings).toContain(
      'This copy of zWorkTracker keeps its data in a private Windows folder. Uninstalling the app deletes that folder and your hours with it. Connect a OneDrive or Google Drive folder in Settings > Sync between devices.',
    );
    call(s, 'add_sync_target', { provider: 'oneDrive', root: ONE_DRIVE });
    expect(snap(s).warnings).not.toContain(PACKAGED_NO_FOLDER_WARNING);
    call(s, 'remove_sync_target', { root: ONE_DRIVE });
    expect(snap(s).warnings).toContain(PACKAGED_NO_FOLDER_WARNING);
  });

  it('is not packaged by default, and adds nothing to the warnings', () => {
    expect(snap(demoState()).platform.packaged).toBe(false);
    expect(snap(demoState()).warnings.filter((w) => w.includes('private Windows folder'))).toEqual([]);
  });
});

describe('Start with Windows', () => {
  const words: [AutostartState, boolean, string | null][] = [
    ['on', true, null],
    ['off', true, null],
    ['offByUser', false, 'You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.'],
    ['offByPolicy', false, "A policy on this computer doesn't allow this, or the device doesn't support it."],
    ['onByPolicy', false, 'A policy on this computer keeps this on.'],
    ['unavailable', false, "Windows couldn't find this app's startup entry."],
  ];
  it.each(words)('%s: can change %s, and says %j', (state, canChange, note) => {
    const s = demoState();
    s.packaged = true;
    s.autostartInfo = autostartFor(state);
    if (state === 'on') s.autostart = true;
    expect(call<AutostartInfo>(s, 'get_autostart_info')).toEqual({ packaged: true, state, canChange, note });
  });

  it('needs only the state to be set: the rest follows from it, as in the backend', () => {
    const s = demoState();
    s.autostartInfo = { ...s.autostartInfo, state: 'offByUser' };
    expect(call<AutostartInfo>(s, 'get_autostart_info')).toEqual(autostartFor('offByUser', false));
  });

  it('follows the plain switch for on and off, and a plain switch stays as it always was', () => {
    const s = demoState();
    expect(call<AutostartInfo>(s, 'get_autostart_info')).toEqual({ packaged: false, state: 'off', canChange: true, note: null });
    expect(call<boolean>(s, 'set_autostart', { enabled: true })).toBe(true);
    expect(s.autostart).toBe(true);
    expect(call<boolean>(s, 'get_autostart')).toBe(true);
    expect(call<AutostartInfo>(s, 'get_autostart_info').state).toBe('on');
    expect(call<boolean>(s, 'set_autostart', { enabled: false })).toBe(false);
    expect(s.autostart).toBe(false);
  });

  it('answers a switch Windows will not move with the error code `autostart` and its reason, and leaves the switch alone', () => {
    for (const state of ['offByUser', 'offByPolicy', 'unavailable'] as const) {
      const s = demoState();
      s.autostartInfo = autostartFor(state);
      expect(fails(s, 'set_autostart', { enabled: true })).toEqual({ code: 'autostart', message: autostartFor(state).note });
      expect(s.autostart).toBe(false);
    }
    const on = demoState();
    on.autostartInfo = autostartFor('onByPolicy');
    expect(fails(on, 'set_autostart', { enabled: false }).code).toBe('autostart');
    expect(call<boolean>(on, 'get_autostart')).toBe(true);
    expect(call<boolean>(on, 'set_autostart', { enabled: true })).toBe(true);
  });

  it('turning off what is already off is no error', () => {
    const s = demoState();
    s.autostartInfo = autostartFor('offByUser');
    expect(call<boolean>(s, 'set_autostart', { enabled: false })).toBe(false);
  });

  it('opens the Windows settings page, which the mock only records', () => {
    const s = demoState();
    expect(call(s, 'open_startup_settings')).toBeNull();
  });
});

describe('leaseView', () => {
  it('is what the snapshot says, and never shares state with the mock', () => {
    const s = demoState();
    seedLease(s, 'live');
    const v = leaseView(s);
    must(v.holder).deviceName = 'changed';
    v.reachableRoots.push('x');
    expect(leaseView(s).holder?.deviceName).toBe('LAPTOP');
    expect(leaseView(s).reachableRoots).toEqual([ONE_DRIVE]);
  });
});

describe('the typed wrappers', () => {
  afterEach(() => clearMocks());

  it('send the names the backend’s parameters have, and the mock answers each of them', async () => {
    const s = laptopRunsATask();
    seedVersions(s);
    installMock(s);
    const last = () => s.calls.at(-1);

    expect((await api.leasePreviewTakeOver()).holder?.deviceName).toBe('LAPTOP');
    expect(last()?.cmd).toBe('lease_preview_take_over');

    expect((await api.listVersions()).versions).toHaveLength(7);
    expect(last()).toEqual({ cmd: 'list_versions', args: {} });
    await api.listVersions('D:\\Old cloud');
    expect(last()).toEqual({ cmd: 'list_versions', args: { extraRoot: 'D:\\Old cloud' } });

    const first = must((await api.listVersions()).versions[0]);
    expect(await api.readVersionChanges(ONE_DRIVE, first.name)).toContain('zWorkTracker version saved');
    expect(last()).toEqual({ cmd: 'read_version_changes', args: { root: ONE_DRIVE, name: first.name } });
    expect((await api.previewRestoreVersion(ONE_DRIVE, first.name)).version.projects).toBe(4);
    expect(last()).toEqual({ cmd: 'preview_restore_version', args: { root: ONE_DRIVE, name: first.name } });

    // Read-only: a restore is refused with the backend's code, and the wrapper rejects with it.
    await expect(api.restoreVersion(ONE_DRIVE, first.name)).rejects.toEqual({ code: 'read_only', message: readOnlyMessage('LAPTOP') });
    expect(last()).toEqual({ cmd: 'restore_version', args: { root: ONE_DRIVE, name: first.name } });

    const taken = await api.leaseTakeOver({ generation: 4, beatSeq: 83 }, 'live');
    expect(taken.outcome).toBe('done');
    expect(last()).toEqual({ cmd: 'lease_take_over', args: { expected: { generation: 4, beatSeq: 83 }, mode: 'live' } });

    await api.saveVersionNow();
    expect(last()?.cmd).toBe('save_version_now');
    expect((await api.restoreVersion(ONE_DRIVE, first.name)).launch.warm).toBe(false);
    expect((await api.leaseRelease()).lease.state).toBe('free');
    expect(last()?.cmd).toBe('lease_release');

    await expect(api.settleLostSegment('nope', 'why')).rejects.toMatchObject({ code: 'not_found' });
    expect(last()).toEqual({ cmd: 'settle_lost_segment', args: { segmentId: 'nope', reason: 'why' } });
    await expect(api.resolveJoin(ONE_DRIVE, 'follow')).rejects.toMatchObject({ code: 'conflict' });
    expect(last()).toEqual({ cmd: 'resolve_join', args: { root: ONE_DRIVE, choice: 'follow' } });

    expect(await api.getAutostartInfo()).toEqual({ packaged: false, state: 'off', canChange: true, note: null });
    await api.openStartupSettings();
    expect(last()?.cmd).toBe('open_startup_settings');
  });
});

describe('resolve_join while read-only (mirrors epoch.rs)', () => {
  it('refuses Keep and allows Follow', async () => {
    const mod = await import('./ipcMock');
    const s = demoState();
    mod.seedLease(s, 'live');
    mod.seedJoinPending(s);
    const root = s.joinPending!.root;
    expect(() => mod.handle(s, 'resolve_join', { root, choice: 'keep' })).toThrow();
    expect(s.joinPending).not.toBeNull();
    mod.handle(s, 'resolve_join', { root, choice: 'follow' });
    expect(s.joinPending).toBeNull();
  });
});
