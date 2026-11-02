// delete_task in the mock, held to the rules and the exact words of the Rust core (machine.rs `delete_task`,
// summary.rs `summaries_listing`, service.rs `snapshot`), so that a page test that passes on the mock says something
// about the real backend.
import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../lib/types';
import { demoP2State, demoState } from './demoSeed';
import { DEVICE_ID, captureData, handle, summariesListing, type MockState } from './ipcMock';

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const snap = (s: MockState) => call<Snapshot>(s, 'get_snapshot');
const fails = (s: MockState, cmd: string, a: Record<string, unknown>) => {
  try {
    handle(s, cmd, a);
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error(`${cmd} did not fail`);
};
const shows = (s: MockState, taskId: string): string[] => {
  const v = snap(s);
  return [
    v.tasks.some((t) => t.id === taskId) && 'tasks',
    v.segments.some((x) => x.taskId === taskId) && 'segments',
    v.rawSegments.some((x) => x.taskId === taskId) && 'raw segments',
    v.gaps.some((x) => x.taskId === taskId) && 'time away',
    v.pauses.some((x) => x.taskId === taskId) && 'billable pauses',
    v.pauseRequests.some((x) => x.taskId === taskId) && 'pause requests',
  ].filter((x): x is string => x !== false);
};

describe('delete_task', () => {
  it('takes a stopped task with everything logged on it out of every view, and writes it in the audit trail', () => {
    const s = demoP2State();
    // Homepage layout has a hand-entered stretch and time on summary A-001; Box dieline only on the voided A-002.
    const id = 't-box';
    expect(shows(s, id)).toEqual(expect.arrayContaining(['tasks', 'segments', 'raw segments', 'time away']));
    const before = snap(s);
    const segments = before.rawSegments.filter((x) => x.taskId === id).length;
    const pauses = before.pauses.filter((x) => x.taskId === id).length;
    const out = call<Snapshot>(s, 'delete_task', { id });
    expect(out.tasks.some((t) => t.id === id)).toBe(false);
    expect(shows(s, id)).toEqual([]);
    expect(out.revision).toBeGreaterThan(before.revision);
    expect(out.tasks.length).toBe(before.tasks.length - 1);
    const entry = call<{ entity: string; action: string; by: string; before: unknown; after: unknown }[]>(s, 'get_audit', { entityId: id }).find((e) => e.action === 'delete');
    expect(entry).toMatchObject({ entity: 'task', action: 'delete', by: DEVICE_ID, after: null });
    expect(entry?.before).toEqual({ name: 'Box dieline', project: 'Packaging', state: 'stopped', segments, pauses });
  });

  it('deletes a draft and a paused task too, and a task no longer there is not found', () => {
    const s = demoState();
    expect(call<Snapshot>(s, 'delete_task', { id: 't-next' }).tasks.some((t) => t.id === 't-next')).toBe(false);
    expect(call<Snapshot>(s, 'delete_task', { id: 't-guide' }).tasks.some((t) => t.id === 't-guide')).toBe(false);
    expect(fails(s, 'delete_task', { id: 't-guide' })).toEqual({ code: 'not_found', message: 'task not found' });
  });

  it('refuses a task running here, with the backend’s words, and changes nothing', () => {
    const s = demoState();
    const before = JSON.stringify([s.tasks, s.segments, s.audit]);
    expect(fails(s, 'delete_task', { id: 't-logo' })).toEqual({ code: 'conflict', message: 'this task is running; pause or stop it before deleting it' });
    expect(JSON.stringify([s.tasks, s.segments, s.audit])).toBe(before);
  });

  it('deletes a task running on another device, with a request for it to pause or without, and its open segment goes with it', () => {
    for (const asked of [false, true]) {
      const s = demoState();
      const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
      const t = s.tasks.find((x) => x.id === 't-logo');
      if (!open || !t) throw new Error('seed');
      open.deviceId = 'other-device';
      t.runningElsewhere = 'Office PC';
      if (asked) {
        call(s, 'request_remote_pause', { taskId: 't-logo' });
        expect(s.pauseRequests).toHaveLength(1);
      }
      const out = call<Snapshot>(s, 'delete_task', { id: 't-logo' });
      expect(out.tasks.some((x) => x.id === 't-logo')).toBe(false);
      expect(shows(s, 't-logo')).toEqual([]);
      expect(s.segments.some((x) => x.id === open.id)).toBe(false);
      expect(s.pauseRequests).toEqual([]);
      expect(call<{ action: string }[]>(s, 'get_audit', { entityId: 't-logo' }).some((e) => e.action === 'delete')).toBe(true);
    }
  });

  it('still refuses a task with a timer open on this device, whatever else runs it', () => {
    const s = demoState();
    s.segments.push({ id: 'also-there', taskId: 't-logo', deviceId: 'other-device', start: '2026-03-12T14:10:00Z', end: null, provisionalEnd: null });
    const message = 'this task is running; pause or stop it before deleting it';
    expect(fails(s, 'delete_task', { id: 't-logo' })).toEqual({ code: 'conflict', message });
    // Paused here, the other computer's timer is no reason to refuse.
    call(s, 'pause_task', { id: 't-logo' });
    expect(call<Snapshot>(s, 'delete_task', { id: 't-logo' }).tasks.some((x) => x.id === 't-logo')).toBe(false);
  });

  it('names the live summary that lists the task’s time, and the voided one does not stop it', () => {
    const s = demoP2State();
    expect(summariesListing(s, 't-home')).toEqual(['A-001']);
    expect(fails(s, 'delete_task', { id: 't-home' })).toEqual({ code: 'conflict', message: "this task's time is on billing summary A-001; void that summary first" });
    // A-002 is voided and lists Box dieline: that does not stop the delete, and the summary keeps its rows.
    expect(summariesListing(s, 't-box')).toEqual([]);
    const voided = s.summaries.find((b) => b.reference === 'A-002');
    const rows = JSON.stringify(voided?.rows);
    call(s, 'delete_task', { id: 't-box' });
    expect(JSON.stringify(s.summaries.find((b) => b.reference === 'A-002')?.rows)).toBe(rows);
    expect(snap(s).billing.summaries.find((b) => b.reference === 'A-002')?.rows.some((r) => r.taskName === 'Box dieline')).toBe(true);
  });

  it('names every live summary when there are several, in order, and lets go once they are voided', () => {
    const s = demoP2State();
    // A second live summary for the same project and task: more time on Homepage layout, later.
    call(s, 'add_manual_entry', { input: { taskId: 't-home', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z', reason: 'more', allowOverlap: true } });
    call(s, 'create_summary', { request: { projectId: 'p-web', from: '2026-03-01', to: '2026-03-12', zone: 'Europe/Lisbon' } });
    expect(summariesListing(s, 't-home')).toEqual(['A-001', 'A-003']);
    expect(fails(s, 'delete_task', { id: 't-home' })).toEqual({ code: 'conflict', message: "this task's time is on billing summaries A-001, A-003; void those summaries first" });
    for (const b of s.summaries.filter((x) => !x.voided && x.projectId === 'p-web')) call(s, 'void_summary', { id: b.id });
    expect(call<Snapshot>(s, 'delete_task', { id: 't-home' }).tasks.some((t) => t.id === 't-home')).toBe(false);
  });

  it('counts a summary that lists the task by a segment or a pause only, as the backend does', () => {
    const s = demoP2State();
    const live = s.summaries.find((b) => !b.voided);
    if (!live) throw new Error('seed');
    const ownSegment = s.segments.find((x) => x.taskId === 't-box');
    const ownPause = s.pauses[0];
    if (!ownSegment || !ownPause) throw new Error('seed');
    live.rows = [];
    live.segmentIds = [ownSegment.id];
    expect(summariesListing(s, 't-box')).toEqual([live.reference]);
    live.segmentIds = [];
    live.pauseIds = [ownPause.id];
    expect(summariesListing(s, ownPause.taskId)).toEqual([live.reference]);
  });

  it('hides its gaps, pauses and pause requests, and its stash, and unlinks the tasks that continue it', () => {
    const s = demoP2State();
    s.drafts['t-box'] = null;
    s.tasks.push({ id: 't-more', name: 'Dieline, again', projectId: 'p-pack', description: null, state: 'draft', pauseReason: null, createdAt: '2026-03-01T00:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: 't-box' });
    expect(snap(s).tasks.find((t) => t.id === 't-more')?.continuedFrom).toBe('t-box');
    s.pauses.push({ id: 'pause-box', taskId: 't-box', start: '2026-03-10T12:00:00Z', end: '2026-03-10T12:30:00Z', note: '', deleted: false, stamp: { at: '2026-03-10T12:30:00Z', by: DEVICE_ID } });
    s.pauseRequests.push({ id: 'pr', taskId: 't-box', segmentId: 'nowhere', requestedBy: DEVICE_ID, at: '2026-03-10T12:30:00Z', stamp: { at: '2026-03-10T12:30:00Z', by: DEVICE_ID } });
    expect(shows(s, 't-box')).toEqual(expect.arrayContaining(['billable pauses', 'pause requests']));
    const out = call<Snapshot>(s, 'delete_task', { id: 't-box' });
    expect(shows(s, 't-box')).toEqual([]);
    expect(out.tasks.find((t) => t.id === 't-more')?.continuedFrom).toBeNull();
    expect(s.drafts['t-box']).toBeUndefined();
  });

  it('shows no pause, pause request or link of a task that is gone, however it went', () => {
    const s = demoP2State();
    s.tasks.push({ id: 't-more', name: 'Dieline, again', projectId: 'p-pack', description: null, state: 'draft', pauseReason: null, createdAt: '2026-03-01T00:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: 't-box' });
    s.pauseRequests.push({ id: 'pr', taskId: 't-box', segmentId: 'nowhere', requestedBy: DEVICE_ID, at: '2026-03-10T12:30:00Z', stamp: { at: '2026-03-10T12:30:00Z', by: DEVICE_ID } });
    s.pauses.push({ id: 'pause-box', taskId: 't-box', start: '2026-03-10T12:00:00Z', end: '2026-03-10T12:30:00Z', note: '', deleted: false, stamp: { at: '2026-03-10T12:30:00Z', by: DEVICE_ID } });
    // Another device's delete arrives: the task is simply not in the store any more.
    s.tasks = s.tasks.filter((t) => t.id !== 't-box');
    expect(shows(s, 't-box')).toEqual([]);
  });

  it('takes the project’s figures with the task', () => {
    const s = demoP2State();
    const exact = (v: Snapshot) => v.projects.find((p) => p.id === 'p-brand')?.figures.exactSecs ?? 0;
    const logo = snap(s).rawSegments.filter((x) => x.taskId === 't-guide' && !x.voided).reduce((n, x) => n + (Date.parse(x.end ?? x.start) - Date.parse(x.start)) / 1000, 0);
    expect(logo).toBeGreaterThan(0);
    const before = exact(snap(s));
    // Brand guidelines is paused and has time on the budgeted project.
    expect(exact(call<Snapshot>(s, 'delete_task', { id: 't-guide' }))).toBe(before - logo);
  });

  it('is undone by restoring a backup made before it, as the backend’s kept records allow', () => {
    const s = demoP2State();
    s.backupData['z-work-data-2026-03-11.json'] = captureData(s);
    call(s, 'delete_task', { id: 't-box' });
    expect(shows(s, 't-box')).toEqual([]);
    call(s, 'restore_backup', { name: 'z-work-data-2026-03-11.json' });
    expect(shows(s, 't-box')).toEqual(expect.arrayContaining(['tasks', 'segments']));
    // The audit trail only grows: the delete is still in it.
    expect(call<{ action: string }[]>(s, 'get_audit', { entityId: 't-box' }).some((e) => e.action === 'delete')).toBe(true);
  });

  it('lets the warm start copy from the task worked on before when the last one is deleted', () => {
    const s = demoState();
    call(s, 'pause_task', { id: 't-logo' });
    call(s, 'stop_task', { id: 't-logo' });
    s.lastWorked = 't-logo';
    expect(snap(s).launch.copySource?.taskId).toBe('t-logo');
    call(s, 'delete_task', { id: 't-logo' });
    const next = snap(s).launch.copySource;
    expect(next).not.toBeNull();
    expect(next?.taskId).not.toBe('t-logo');
    expect(snap(s).tasks.some((t) => t.id === next?.taskId)).toBe(true);
  });
});

describe('a project and its billing summaries', () => {
  it('cannot be deleted while a summary names it, voided or not, even once its tasks are gone', () => {
    const s = demoP2State();
    expect(fails(s, 'delete_project', { id: 'p-pack' })).toMatchObject({ code: 'conflict', message: 'a project with tasks can only be archived' });
    call(s, 'delete_task', { id: 't-box' });
    // Packaging has no task now, and one voided summary (A-002) still names it.
    expect(snap(s).tasks.some((t) => t.projectId === 'p-pack')).toBe(false);
    expect(snap(s).projects.find((p) => p.id === 'p-pack')?.hasTasks, 'so the page offers Archive, not Delete').toBe(true);
    expect(fails(s, 'delete_project', { id: 'p-pack' })).toEqual({ code: 'conflict', message: 'a project with billing summaries can only be archived' });
    expect(call<Snapshot>(s, 'set_project_archived', { id: 'p-pack', archived: true }).projects.find((p) => p.id === 'p-pack')?.archived).toBe(true);
  });

  it('can be deleted when nothing names it', () => {
    const s = demoState();
    call(s, 'delete_task', { id: 't-mail' });
    expect(snap(s).projects.find((p) => p.id === 'p-admin')?.hasTasks).toBe(false);
    expect(call<Snapshot>(s, 'delete_project', { id: 'p-admin' }).projects.some((p) => p.id === 'p-admin')).toBe(false);
  });
});

describe('the audit records of billable pauses', () => {
  it('name their task, as the backend’s do', () => {
    const s = demoP2State();
    const marked = s.audit.find((e) => e.entity === 'pause' && e.action === 'markBillable');
    expect(marked?.after).toMatchObject({ taskId: 't-logo' });
    const pause = s.pauses.find((p) => p.taskId === 't-logo');
    if (!pause) throw new Error('seed');
    call(s, 'unmark_billable_pause', { id: pause.id });
    expect(s.audit.find((e) => e.action === 'unmarkBillable')?.before).toMatchObject({ taskId: 't-logo' });
  });
});
