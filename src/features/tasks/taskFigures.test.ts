import { describe, expect, it } from 'vitest';

import { RateBook } from '../../lib/billing';
import { parseIso } from '../../lib/tz';
import type { Segment } from '../../lib/types';
import { fullProject, fullTask } from '../../mocks/factories';
import { liveFigures, liveSpans } from './taskLive';
import { taskTime } from './taskFigures';

const piece = (id: string, start: string, end: string | null, extra: Partial<Segment> = {}): Segment => ({ id, taskId: 't', deviceId: 'dev', start, end, provisionalEnd: null, ...extra });
const at = (iso: string) => parseIso(iso);

describe('taskTime', () => {
  const task = fullTask({
    id: 't',
    projectId: 'p',
    state: 'running',
    activeSubtask: 'b',
    subtasks: [
      { id: 'a', text: 'A', checked: true, secs: 3600 },
      { id: 'b', text: 'B', checked: false, secs: 1800 },
    ],
    billedSecs: 0,
    unbilledSecs: 3600 + 1800 + 600 + 900,
    pauseSecs: 900,
  });
  const pieces = [
    piece('1', '2026-03-12T08:00:00Z', '2026-03-12T09:00:00Z', { subtaskId: 'a' }),
    piece('2', '2026-03-12T09:10:00Z', '2026-03-12T09:20:00Z', { subtaskId: null }), // ten minutes with no subtask
    piece('3', '2026-03-12T09:30:00Z', '2026-03-12T09:45:00Z', { kind: 'billablePause', subtaskId: null }), // billed, not worked
    piece('4', '2026-03-12T10:00:00Z', null, { subtaskId: 'b' }), // open, 30 min old at the snapshot
  ];
  const snapshotAt = at('2026-03-12T10:30:00Z');

  it('splits worked time into the items and the time with no subtask, and the parts add up', () => {
    const t = taskTime(task, pieces, snapshotAt, snapshotAt);
    expect(t.noSubtaskSecs).toBe(600);
    expect(t.subtasks.map((r) => [r.id, r.secs, r.active])).toEqual([['a', 3600, false], ['b', 1800, true]]);
    expect(t.workedSecs).toBe(600 + 3600 + 1800);
    expect(t.workedSecs).toBe(t.noSubtaskSecs + t.subtasks.reduce((n, r) => n + r.secs, 0));
    expect(t.noneActive).toBe(false);
  });

  it('never counts a billable pause as worked time', () => {
    const t = taskTime(task, pieces, snapshotAt, snapshotAt);
    expect(t.workedSecs).toBe(6000);
    expect(t.pauseSecs).toBe(900);
    expect(t.noSubtaskSecs).toBe(600);
  });

  it('lets the open piece grow after the snapshot, in its item and in the unbilled total, and the sum still holds', () => {
    const later = snapshotAt + 120;
    const t = taskTime(task, pieces, later, snapshotAt);
    expect(t.subtasks.find((r) => r.id === 'b')?.secs).toBe(1800 + 120);
    expect(t.unbilledSecs).toBe(task.unbilledSecs + 120);
    expect(t.workedSecs).toBe(6000 + 120);
    expect(t.workedSecs).toBe(t.noSubtaskSecs + t.subtasks.reduce((n, r) => n + r.secs, 0));
    // A clock that sits behind the snapshot never makes time shrink.
    expect(taskTime(task, pieces, snapshotAt - 5, snapshotAt).unbilledSecs).toBe(task.unbilledSecs);
  });

  it('when the open piece has no subtask the growth lands in the time with no subtask', () => {
    const open = [piece('1', '2026-03-12T10:00:00Z', null, { subtaskId: null })];
    const t = taskTime({ ...task, activeSubtask: null }, open, snapshotAt + 60, snapshotAt);
    expect(t.noSubtaskSecs).toBe(1800 + 60);
    expect(t.noneActive).toBe(true);
    expect(t.subtasks.every((r) => !r.active)).toBe(true);
  });

  it('time on an item that was removed from the list stays in the total, as time with no subtask, and is reported', () => {
    const gone = [piece('1', '2026-03-12T08:00:00Z', '2026-03-12T08:30:00Z', { subtaskId: 'removed' })];
    const t = taskTime(task, gone, snapshotAt, snapshotAt);
    expect(t.noSubtaskSecs).toBe(1800);
    expect(t.orphanSecs).toBe(1800);
  });

  it('an active id that is no longer in the list reads as no subtask', () => {
    const t = taskTime({ ...task, activeSubtask: 'removed' }, [], snapshotAt, snapshotAt);
    expect(t.noneActive).toBe(true);
  });

  it('an item without an id cannot be made active', () => {
    const t = taskTime({ ...task, subtasks: [{ id: '', text: 'typed', checked: false, secs: 0 }] }, [], snapshotAt, snapshotAt);
    expect(t.subtasks[0]?.canActivate).toBe(false);
  });

  it('a piece open on another device only counts to its last heartbeat', () => {
    const remote = [piece('1', '2026-03-12T10:00:00Z', null, { provisionalEnd: '2026-03-12T10:10:00Z', subtaskId: null })];
    const t = taskTime(task, remote, snapshotAt + 3600, snapshotAt);
    expect(t.noSubtaskSecs).toBe(600);
    expect(t.unbilledSecs).toBe(task.unbilledSecs); // no growth: nothing is open here
  });
});

describe('liveFigures with pieces', () => {
  const project = fullProject({ id: 'p', billable: true });
  const book = new RateBook([project], [{ id: 'r', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 6000, currency: 'EUR', deleted: false, stamp: { at: '', by: '' } }]);
  const rounding = [{ id: 'g', projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 15, method: 'up' as const, deleted: false, stamp: { at: '', by: '' } }];
  const now = at('2026-03-12T15:20:00Z');
  const pieces = [
    piece('1', '2026-03-12T09:00:00Z', '2026-03-12T10:00:00Z'), // 60 min work
    piece('2', '2026-03-12T10:00:00Z', '2026-03-12T10:20:00Z', { kind: 'thinking' }), // 20 min thinking, counts as worked
    piece('3', '2026-03-12T10:30:00Z', '2026-03-12T11:00:00Z', { kind: 'billablePause' }), // 30 min pause
    piece('4', '2026-03-12T15:00:00Z', null), // open, 20 min old
  ];

  it('keeps a billable pause out of Exact, adds it to Billable and earns on it', () => {
    const f = liveFigures(liveSpans(pieces, 'p', now), now, 'UTC', book, rounding);
    expect(f.exactSecs).toBe((60 + 20 + 20) * 60);
    expect(f.pauseSecs).toBe(30 * 60);
    expect(f.thinkingSecs).toBe(20 * 60);
    expect(f.billableSecs).toBe(135 * 60); // 130 minutes rounded up to 135
    expect(f.exactNumerators.EUR).toBe(6000 * 100 * 60); // exact accrual: 100 minutes, no pause
    expect(f.billableNumerators.EUR).toBe(6000 * 135 * 60);
  });

  it('measures the session from the open piece, not from an older piece', () => {
    const f = liveFigures(liveSpans(pieces, 'p', now), now, 'UTC', book, rounding);
    expect(f.sessionSecs).toBe(20 * 60);
  });

  it('a pause alone is no session', () => {
    const f = liveFigures(liveSpans([pieces[2] as Segment], 'p', now), now, 'UTC', book, rounding);
    expect(f.sessionSecs).toBe(0);
    expect(f.exactSecs).toBe(0);
    expect(f.billableSecs).toBe(30 * 60);
  });

  it('a piece with no kind is work', () => {
    const f = liveFigures(liveSpans([pieces[0] as Segment], 'p', now), now, 'UTC', book, rounding);
    expect(f.exactSecs).toBe(3600);
    expect(f.pauseSecs).toBe(0);
  });

  it('a fixed-fee project has no hourly rate, so the ticker has nothing to accrue', () => {
    const fixed = fullProject({ id: 'p', billable: true, billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR' });
    const fixedBook = new RateBook([fixed], [{ id: 'r', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 6000, currency: 'EUR', deleted: false, stamp: { at: '', by: '' } }]);
    const f = liveFigures(liveSpans(pieces, 'p', now), now, 'UTC', fixedBook, rounding);
    expect(f.rate.rateCents).toBeNull();
    expect(f.exactNumerators).toEqual({});
    expect(f.exactSecs).toBe(100 * 60);
  });
});
