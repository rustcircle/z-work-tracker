import { describe, expect, it } from 'vitest';

import { amountText } from '../../../components/format';
import { fullTask } from '../../../mocks/factories';
import { demoP2State, demoState } from '../../../mocks/demoSeed';
import { handle } from '../../../mocks/ipcMock';
import type { Snapshot, Task } from '../../../lib/types';
import { blockText, deleteBlocks, elsewhereText, footprint, runningElsewhere, summariesListing } from './deleteRules';

const snapshotOf = (s: ReturnType<typeof demoState>): Snapshot => handle(s, 'get_snapshot', {}) as Snapshot;
const taskOf = (snap: Snapshot, id: string): Task => {
  const t = snap.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};

describe('what stops a delete', () => {
  it('nothing, for a paused or stopped task with no time on a live summary', () => {
    const snap = snapshotOf(demoP2State());
    expect(deleteBlocks(snap, taskOf(snap, 't-guide'))).toEqual([]);
    // Box dieline is on summary A-002, which is voided.
    expect(deleteBlocks(snap, taskOf(snap, 't-box'))).toEqual([]);
  });

  it('a task running here', () => {
    const snap = snapshotOf(demoState());
    expect(deleteBlocks(snap, taskOf(snap, 't-logo'))).toEqual([{ kind: 'running' }]);
  });

  it('a task running here is told from its open recorded segment alone, whatever its state says', () => {
    const snap = snapshotOf(demoState());
    const t = { ...taskOf(snap, 't-logo'), state: 'paused' as const };
    expect(deleteBlocks(snap, t)).toEqual([{ kind: 'running' }]);
  });

  it('a task running on another of the computers does not stop it, with a request to pause or without, named or not', () => {
    const s = demoState();
    const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    if (!open) throw new Error('seed');
    open.deviceId = 'other-device';
    const named = s.tasks.find((t) => t.id === 't-logo');
    if (named) named.runningElsewhere = 'Office PC';
    const snap = snapshotOf(s);
    expect(deleteBlocks(snap, taskOf(snap, 't-logo'))).toEqual([]);
    // The name is not always known, but the open segment says where it runs.
    expect(deleteBlocks(snap, { ...taskOf(snap, 't-logo'), runningElsewhere: null })).toEqual([]);
    // A request that it pause, waiting for that computer to hear, changes nothing about that.
    s.pauseRequests.push({ id: 'pr', taskId: 't-logo', segmentId: open.id, requestedBy: 'x', at: '2026-03-12T15:00:00Z', stamp: { at: '2026-03-12T15:00:00Z', by: 'x' } });
    const asked = snapshotOf(s);
    expect(asked.pauseRequests).toHaveLength(1);
    expect(deleteBlocks(asked, taskOf(asked, 't-logo'))).toEqual([]);
  });

  it('a timer open here still stops it, though another computer runs the task too', () => {
    const s = demoState();
    s.segments.push({ id: 'also-there', taskId: 't-logo', deviceId: 'other-device', start: '2026-03-12T14:10:00Z', end: null, provisionalEnd: null });
    const named = s.tasks.find((t) => t.id === 't-logo');
    if (named) named.runningElsewhere = 'Office PC';
    const snap = snapshotOf(s);
    expect(deleteBlocks(snap, taskOf(snap, 't-logo'))).toEqual([{ kind: 'running' }]);
  });

  it('a live summary that lists the task, by reference and in order', () => {
    const snap = snapshotOf(demoP2State());
    expect(deleteBlocks(snap, taskOf(snap, 't-home'))).toEqual([{ kind: 'summary', references: ['A-001'] }]);
    expect(summariesListing(snap, 't-home')).toEqual(['A-001']);
    expect(summariesListing(snap, 't-box')).toEqual([]);
  });

  it('a summary that lists the task by a recorded segment or a pause alone counts, as in the backend', () => {
    const s = demoP2State();
    const live = s.summaries.find((b) => !b.voided);
    const own = s.segments.find((x) => x.taskId === 't-box');
    if (!live || !own) throw new Error('seed');
    live.rows = [];
    live.segmentIds = [own.id];
    live.pauseIds = [];
    const snap = snapshotOf(s);
    expect(summariesListing(snap, 't-box')).toEqual([live.reference]);
    live.segmentIds = [];
    live.pauseIds = s.pauses.filter((p) => p.taskId === 't-logo').map((p) => p.id);
    expect(summariesListing(snapshotOf(s), 't-logo')).toEqual([live.reference]);
  });

  it('running and on a summary at once: both, in the order the backend checks', () => {
    const s = demoP2State();
    const summary = s.summaries.find((b) => !b.voided);
    if (!summary) throw new Error('seed');
    summary.rows = [...summary.rows, { ...(summary.rows[0] as NonNullable<(typeof summary.rows)[number]>), taskId: 't-logo', taskName: 'Logo concepts' }];
    const snap = snapshotOf(s);
    expect(deleteBlocks(snap, taskOf(snap, 't-logo')).map((b) => b.kind)).toEqual(['running', 'summary']);
  });
});

describe('the words for a block', () => {
  it('say what is wrong and how to get past it', () => {
    expect(blockText({ kind: 'running' })).toBe('This task is running. Pause or stop it first, then delete it.');
    expect(blockText({ kind: 'summary', references: ['A-001'] })).toBe("This task's time is on billing summary A-001. Void that summary first, then delete the task.");
    expect(blockText({ kind: 'summary', references: ['A-001', 'A-002'] })).toBe("This task's time is on billing summaries A-001 and A-002. Void those summaries first, then delete the task.");
  });
});

describe('a task running on another of the computers', () => {
  it('is told by the name the snapshot gives, or by an open segment of another device, and not by one of this device', () => {
    const s = demoState();
    const open = s.segments.find((x) => x.taskId === 't-logo' && x.end === null);
    if (!open) throw new Error('seed');
    const here = snapshotOf(s);
    expect(runningElsewhere(here, taskOf(here, 't-logo'))).toBeNull();
    open.deviceId = 'other-device';
    const t = s.tasks.find((x) => x.id === 't-logo');
    if (t) t.runningElsewhere = 'Office PC';
    const there = snapshotOf(s);
    expect(runningElsewhere(there, taskOf(there, 't-logo'))).toEqual({ device: 'Office PC' });
    expect(runningElsewhere(there, { id: 't-logo', runningElsewhere: null })).toEqual({ device: null });
    expect(runningElsewhere(there, taskOf(there, 't-guide'))).toBeNull();
  });

  it('is said plainly: where, that its time so far goes too, and that the timer there stops when that computer syncs', () => {
    expect(elsewhereText('Office PC')).toBe("It is running on Office PC right now. The time it has logged there so far is deleted too, and Office PC's timer stops the next time it syncs.");
    expect(elsewhereText(null)).toBe("It is running on your other PC right now. The time it has logged there so far is deleted too, and that PC's timer stops the next time it syncs.");
  });
});

describe('what a delete takes', () => {
  it('counts the time logged, the days it covers and the Billable earnings the way the Timeline does', () => {
    const snap = snapshotOf(demoP2State());
    const task = taskOf(snap, 't-print');
    // Print proofs: three days of 5 h 40 min on a fixed-fee project, which earns no hourly money.
    const fp = footprint(snap, task, 'Europe/Lisbon');
    expect(fp.loggedSecs).toBe(3 * (5 * 3600 + 40 * 60));
    expect(fp.days).toBe(3);
    expect(amountText(fp.billable, false)).toBe('');
    const guide = taskOf(snap, 't-guide');
    const g = footprint(snap, guide, 'Europe/Lisbon');
    expect(g.loggedSecs).toBe(guide.billedSecs + guide.unbilledSecs);
    expect(g.days).toBeGreaterThan(1);
    expect(amountText(g.billable, false)).toMatch(/^\$[\d,]+\.\d\d$/);
    expect(amountText(g.billable, true)).toBe('••••');
  });

  it('cuts days in the zone shown: one stretch over midnight UTC is two days there and one in Tokyo', () => {
    const snap = snapshotOf(demoP2State());
    const task = fullTask({ id: 'late', projectId: 'p-brand', name: 'Late', state: 'stopped', unbilledSecs: 7200 });
    const stretch = { id: 'late-1', taskId: 'late', deviceId: 'd', start: '2026-03-10T23:00:00Z', end: '2026-03-11T01:00:00Z', provisionalEnd: null };
    const own = { ...snap, segments: [stretch], tasks: [task] };
    expect(footprint(own, task, 'UTC').days).toBe(2);
    expect(footprint(own, task, 'Asia/Tokyo').days).toBe(1);
    expect(footprint(own, task, 'Asia/Tokyo').loggedSecs).toBe(7200);
  });

  it('carries time away that waits for an answer, and none at all for a task without time', () => {
    const snap = snapshotOf(demoP2State());
    expect(footprint(snap, taskOf(snap, 't-logo'), 'UTC').unconfirmedSecs).toBe(30 * 60);
    const empty = fullTask({ id: 'new', projectId: 'p-brand', name: 'New', state: 'stopped' });
    expect(footprint(snap, empty, 'UTC')).toEqual({ loggedSecs: 0, unconfirmedSecs: 0, days: 0, billable: {}, continuedBy: [] });
  });

  it('lists the tasks that continue it', () => {
    const s = demoP2State();
    s.tasks.push({ id: 't-after', name: 'Guidelines, round two', projectId: 'p-brand', description: null, state: 'draft', pauseReason: null, createdAt: '2026-03-01T00:00:00Z', stoppedAt: null, runningElsewhere: null, continuedFrom: 't-guide' });
    const snap = snapshotOf(s);
    expect(footprint(snap, taskOf(snap, 't-guide'), 'UTC').continuedBy.map((t) => t.id)).toEqual(['t-after']);
    expect(footprint(snap, taskOf(snap, 't-home'), 'UTC').continuedBy).toEqual([]);
  });
});
