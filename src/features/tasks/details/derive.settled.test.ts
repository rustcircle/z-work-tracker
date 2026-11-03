// The history of time closed from another computer: what the audit trail says of it (design 5.1, 5.4), in plain words.
import { describe, expect, it } from 'vitest';

import type { AuditEntry, RawSegment } from '../../../lib/types';
import { describeAudit, type AuditLookup } from './derive';

const entry = (action: string, before: unknown, after: unknown, reason = ''): AuditEntry => ({ id: action, at: '2026-03-12T15:00:00Z', by: 'me', entity: 'segment', entityId: 's1', action, reason, before, after });
const json = (rawEnd: string | null, edit: Record<string, unknown> | null) => ({ rawStart: '2026-03-09T09:00:00Z', rawEnd, edit, subtaskId: null });
const edit = (end: string, settled = true) => ({ start: '2026-03-09T09:00:00Z', end, voided: false, reason: 'gone', settled });

/** The segment as the page has it now: no recorded end, and a correction that closes it. */
const settledSeg: RawSegment = { id: 's1', taskId: 'task', deviceId: 'other', rawStart: '2026-03-09T09:00:00Z', rawEnd: null, start: '2026-03-09T09:00:00Z', end: '2026-03-09T11:05:00Z', voided: false, corrected: true, manual: false, reason: 'gone', billed: false };
const look = (seg: RawSegment): AuditLookup => ({ zone: 'Europe/Lisbon', deviceId: 'me', rawSegments: [seg], gaps: [] });

describe('describeAudit for time closed from another computer', () => {
  it('says what Close at last known time did, from running to the end it was given, with the reason', () => {
    const e = entry('settleLost', json(null, null), json(null, edit('2026-03-09T11:05:00Z')), 'Closed from Mock PC: Office PC stopped responding. Ended at its last known moment.');
    expect(describeAudit(e, look(settledSeg))).toEqual({
      id: 'settleLost',
      when: '12 Mar 15:00',
      what: 'Closed at its last known time',
      // It has no recorded end and is not running: the line says so, not "to now".
      about: 'Time on 9 Mar 09:00, no recorded end',
      change: '9 Mar 09:00 to now became 9 Mar 09:00 to 11:05',
      reason: 'Closed from Mock PC: Office PC stopped responding. Ended at its last known moment.',
      elsewhere: false,
    });
  });

  it('says when the computer’s own record took the place of that', () => {
    const closed: RawSegment = { ...settledSeg, rawEnd: '2026-03-09T13:00:00Z', end: '2026-03-09T13:00:00Z', corrected: false, reason: '' };
    const e = entry('reclaimAfterReturn', json('2026-03-09T13:00:00Z', edit('2026-03-09T11:05:00Z')), json('2026-03-09T13:00:00Z', null), "this device's own record");
    expect(describeAudit(e, look(closed))).toMatchObject({ what: 'Closed time replaced by the end its computer recorded', about: 'Time on 9 Mar 09:00 to 13:00', change: '9 Mar 09:00 to 11:05 became 9 Mar 09:00 to 13:00', reason: "this device's own record" });
  });

  it('says when the closed time was kept because it is on a summary', () => {
    const e = entry('reclaimOnSummary', json('2026-03-09T13:00:00Z', edit('2026-03-09T11:05:00Z')), json('2026-03-09T13:00:00Z', edit('2026-03-09T11:05:00Z', false)), "this device's record differs");
    expect(describeAudit(e, look(settledSeg))).toMatchObject({ what: 'Closed time kept, as it is on a billing summary', change: null, reason: "this device's record differs" });
  });

  it('leaves a running segment’s line as it was, and a voided one with no end says the same as a settled one', () => {
    const running: RawSegment = { ...settledSeg, corrected: false, end: null };
    expect(describeAudit(entry('weird', null, null), look(running)).about).toBe('Time on 9 Mar 09:00 to now');
    const voided: RawSegment = { ...settledSeg, corrected: false, voided: true };
    expect(describeAudit(entry('void', json(null, null), json(null, { ...edit('2026-03-09T11:05:00Z'), voided: true })), look(voided)).about).toBe('Time on 9 Mar 09:00, no recorded end');
  });
});
