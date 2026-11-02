import { describe, expect, it } from 'vitest';

import type { AuditEntry, BillablePause, RawSegment } from '../../../lib/types';
import { billedPauseIds, derivePauses, describeAudit, pauseRows, taskAudit, type AuditLookup } from './derive';

const t = (iso: string): number => Date.parse(iso) / 1000;
const seg = (id: string, start: string, end: string | null, extra: Partial<RawSegment> = {}): RawSegment => ({
  id,
  taskId: 'task',
  deviceId: 'dev',
  rawStart: start,
  rawEnd: end,
  start,
  end,
  voided: false,
  corrected: false,
  manual: false,
  reason: '',
  billed: false,
  ...extra,
});
const task = { id: 'task', state: 'stopped' as const, stoppedAt: '2026-03-10T17:00:00Z' };

describe('derivePauses', () => {
  it('lists the gaps between segments in order, and ignores other tasks and overlaps', () => {
    const segs = [
      seg('b', '2026-03-10T13:00:00Z', '2026-03-10T14:00:00Z'),
      seg('a', '2026-03-10T09:00:00Z', '2026-03-10T11:00:00Z'),
      seg('c', '2026-03-10T13:30:00Z', '2026-03-10T16:00:00Z'), // overlaps b: no gap between them
      { ...seg('x', '2026-03-10T11:30:00Z', '2026-03-10T11:40:00Z'), taskId: 'other' },
    ];
    expect(derivePauses(segs, task)).toEqual([
      { start: t('2026-03-10T11:00:00Z'), end: t('2026-03-10T13:00:00Z') },
      { start: t('2026-03-10T16:00:00Z'), end: t('2026-03-10T17:00:00Z') }, // last end to the stop time
    ]);
  });

  it('a voided segment is not work, so the gap spans it; a corrected one uses its corrected times', () => {
    const segs = [
      seg('a', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'),
      seg('v', '2026-03-10T10:30:00Z', '2026-03-10T11:00:00Z', { voided: true }),
      seg('c', '2026-03-10T12:00:00Z', '2026-03-10T13:00:00Z', { rawEnd: '2026-03-10T14:00:00Z', corrected: true }),
    ];
    expect(derivePauses(segs, { ...task, stoppedAt: null })).toEqual([{ start: t('2026-03-10T10:00:00Z'), end: t('2026-03-10T12:00:00Z') }]);
  });

  it('stops at a running segment and adds no stop-time gap to a task that is not stopped', () => {
    const segs = [seg('a', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'), seg('r', '2026-03-10T11:00:00Z', null), seg('z', '2026-03-10T15:00:00Z', '2026-03-10T16:00:00Z')];
    expect(derivePauses(segs, { id: 'task', state: 'running', stoppedAt: null })).toEqual([{ start: t('2026-03-10T10:00:00Z'), end: t('2026-03-10T11:00:00Z') }]);
    expect(derivePauses([seg('a', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z')], { id: 'task', state: 'paused', stoppedAt: null })).toEqual([]);
  });
});

const pause = (id: string, start: string, end: string, extra: Partial<BillablePause> = {}): BillablePause => ({ id, taskId: 'task', start, end, note: '', deleted: false, stamp: { at: '', by: '' }, ...extra });

describe('pauseRows', () => {
  const spans = [
    { start: t('2026-03-10T11:00:00Z'), end: t('2026-03-10T13:00:00Z') },
    { start: t('2026-03-10T16:00:00Z'), end: t('2026-03-10T17:00:00Z') },
  ];
  it('matches a marked pause to the gap it overlaps, even when it covers only part of it', () => {
    const r = pauseRows(spans, [pause('p1', '2026-03-10T11:30:00Z', '2026-03-10T12:00:00Z')], 'task');
    expect(r.rows.map((x) => x.marked.map((m) => m.id))).toEqual([['p1'], []]);
    expect(r.orphans).toEqual([]);
  });
  it('keeps a marked pause that matches no gap reachable, and skips deleted and other tasks', () => {
    const r = pauseRows(
      spans,
      [pause('p1', '2026-03-10T14:00:00Z', '2026-03-10T14:30:00Z'), pause('gone', '2026-03-10T11:30:00Z', '2026-03-10T12:00:00Z', { deleted: true }), pause('o', '2026-03-10T11:30:00Z', '2026-03-10T12:00:00Z', { taskId: 'other' })],
      'task',
    );
    expect(r.orphans.map((p) => p.id)).toEqual(['p1']);
    expect(r.rows.every((x) => x.marked.length === 0)).toBe(true);
  });
  it('billedPauseIds ignores voided summaries', () => {
    const ids = billedPauseIds([
      { pauseIds: ['a'], voided: false },
      { pauseIds: ['b'], voided: true },
    ] as never);
    expect([...ids]).toEqual(['a']);
  });
});

const entry = (id: string, entity: string, entityId: string, action: string, before: unknown, after: unknown, extra: Partial<AuditEntry> = {}): AuditEntry => ({ id, at: '2026-03-12T15:00:00Z', by: 'dev', entity, entityId, action, reason: '', before, after, ...extra });
const look: AuditLookup = { zone: 'Europe/Lisbon', deviceId: 'dev', rawSegments: [seg('s1', '2026-03-09T09:00:00Z', '2026-03-09T11:35:00Z')], gaps: [] };
const segJson = (rawStart: string, rawEnd: string, edit: unknown = null) => ({ rawStart, rawEnd, edit, subtaskId: null });

describe('describeAudit', () => {
  it('reads a correction as before and after, with the reason', () => {
    const e = entry('1', 'segment', 's1', 'correct', segJson('2026-03-09T09:00:00Z', '2026-03-09T11:35:00Z'), segJson('2026-03-09T09:00:00Z', '2026-03-09T11:35:00Z', { start: '2026-03-09T09:00:00Z', end: '2026-03-09T11:05:00Z', voided: false, reason: 'x' }), { reason: 'Stopped at 11:05' });
    expect(describeAudit(e, look)).toMatchObject({ what: 'Time corrected', about: 'Time on 9 Mar 09:00 to 11:35', change: '9 Mar 09:00 to 11:35 became 9 Mar 09:00 to 11:05', reason: 'Stopped at 11:05', elsewhere: false });
  });
  it('reads a void, a restore, a hand entry, a decision and a pause in plain words', () => {
    const raw = segJson('2026-03-09T09:00:00Z', '2026-03-09T11:35:00Z');
    expect(describeAudit(entry('2', 'segment', 's1', 'void', raw, segJson('2026-03-09T09:00:00Z', '2026-03-09T11:35:00Z', { start: '2026-03-09T09:00:00Z', end: '2026-03-09T11:35:00Z', voided: true, reason: 'r' })), look)).toMatchObject({ what: 'Time voided', change: '9 Mar 09:00 to 11:35 no longer counts' });
    expect(describeAudit(entry('3', 'segment', 's1', 'manualEntry', null, raw), look)).toMatchObject({ what: 'Time added by hand', change: 'Added 9 Mar 09:00 to 11:35' });
    expect(describeAudit(entry('4', 'gap', 'g1', 'decide', { decision: 'pending' }, { decision: 'thinking' }), look)).toMatchObject({ what: 'Time away decision', change: 'waiting for your decision became thinking time' });
    expect(describeAudit(entry('5', 'pause', 'p1', 'markBillable', null, { start: '2026-03-12T10:45:00Z', end: '2026-03-12T11:15:00Z' }), look)).toMatchObject({ what: 'Pause billed', about: 'Pause 12 Mar 10:45 to 11:15 (30m)' });
    expect(describeAudit(entry('6', 'segment', 's1', 'weird', null, null, { by: 'other' }), look)).toMatchObject({ what: 'weird', elsewhere: true });
  });
  it('shows times in the active zone', () => {
    const e = entry('7', 'segment', 's1', 'manualEntry', null, segJson('2026-07-01T09:00:00Z', '2026-07-01T09:30:00Z'), { at: '2026-07-01T09:30:00Z' });
    expect(describeAudit(e, { ...look, zone: 'America/New_York' })).toMatchObject({ when: '1 Jul 05:30', change: 'Added 1 Jul 05:00 to 05:30' });
  });
});

describe('taskAudit', () => {
  const snap = {
    rawSegments: [seg('s1', '2026-03-09T09:00:00Z', '2026-03-09T10:00:00Z'), { ...seg('s2', '2026-03-09T09:00:00Z', '2026-03-09T10:00:00Z'), taskId: 'other' }],
    gaps: [{ id: 'g1', taskId: 'task' }, { id: 'g2', taskId: 'other' }],
    pauses: [pause('p1', '2026-03-10T11:30:00Z', '2026-03-10T12:00:00Z'), pause('po', '2026-03-10T11:30:00Z', '2026-03-10T12:00:00Z', { taskId: 'other' })],
  } as never;
  const spans = [{ start: t('2026-03-10T11:00:00Z'), end: t('2026-03-10T13:00:00Z') }];
  it('keeps the entries of the task segments, time away and pauses, and nobody else', () => {
    const entries = [
      entry('a', 'segment', 's1', 'void', null, null),
      entry('b', 'segment', 's2', 'void', null, null),
      entry('c', 'gap', 'g1', 'decide', null, null),
      entry('d', 'gap', 'g2', 'decide', null, null),
      entry('e', 'pause', 'p1', 'markBillable', null, null),
      entry('f', 'pause', 'po', 'markBillable', null, null),
    ];
    expect(taskAudit(entries, snap, 'task', spans).map((e) => e.id)).toEqual(['a', 'c', 'e']);
  });
  it('finds the record of a pause that was unmarked, by the range it covered', () => {
    const entries = [
      entry('u', 'pause', 'gone', 'unmarkBillable', { start: '2026-03-10T11:30:00Z', end: '2026-03-10T12:00:00Z' }, null),
      entry('v', 'pause', 'gone2', 'markBillable', null, { start: '2026-03-11T11:30:00Z', end: '2026-03-11T12:00:00Z' }),
    ];
    expect(taskAudit(entries, snap, 'task', spans).map((e) => e.id)).toEqual(['u']);
  });
});

describe('taskAudit and the pauses of a task that was deleted', () => {
  // The deleted task's pauses are gone from the snapshot, like an unmarked pause, and could line up with this task's gap.
  const snap = {
    rawSegments: [seg('s1', '2026-03-09T09:00:00Z', '2026-03-09T10:00:00Z')],
    gaps: [],
    pauses: [pause('p1', '2026-03-10T11:30:00Z', '2026-03-10T12:00:00Z')],
  } as never;
  const spans = [{ start: t('2026-03-10T11:00:00Z'), end: t('2026-03-10T13:00:00Z') }];
  const within = { start: '2026-03-10T11:30:00Z', end: '2026-03-10T12:00:00Z' };

  it('leaves out a record that names another task, however well its time lines up', () => {
    const entries = [
      entry('d1', 'pause', 'gone', 'markBillable', null, { taskId: 'deleted', ...within }),
      entry('d2', 'pause', 'gone', 'unmarkBillable', { taskId: 'deleted', ...within }, null),
      entry('mine', 'pause', 'gone2', 'unmarkBillable', { taskId: 'task', ...within }, null),
    ];
    expect(taskAudit(entries, snap, 'task', spans).map((e) => e.id)).toEqual(['mine']);
  });

  it('still finds, by their time, the older records that name no task', () => {
    const entries = [entry('old', 'pause', 'gone', 'unmarkBillable', within, null), entry('far', 'pause', 'gone3', 'unmarkBillable', { start: '2026-03-20T11:30:00Z', end: '2026-03-20T12:00:00Z' }, null)];
    expect(taskAudit(entries, snap, 'task', spans).map((e) => e.id)).toEqual(['old']);
  });
});
