import { describe, expect, it } from 'vitest';

import type { AuditEntry } from '../../lib/types';
import { actionWords, auditLine, entityLabel, spanText, summarize, whenText } from './auditText';

const entry = (over: Partial<AuditEntry>): AuditEntry => ({ id: 'a', at: '2026-03-12T15:20:00Z', by: 'dev', entity: 'segment', entityId: 's', action: 'correct', reason: '', before: null, after: null, ...over });

describe('audit wording', () => {
  it('names entities and actions in plain words, with a fallback for unknown ones', () => {
    expect(entityLabel('segment')).toBe('Time entry');
    expect(entityLabel('gap')).toBe('Time away');
    expect(entityLabel('widget')).toBe('Widget');
    expect(actionWords('manualEntry')).toBe('added by hand');
    expect(actionWords('unmarkBillable')).toBe('no longer billable');
    expect(actionWords('someNewAction')).toBe('some new action');
    expect(actionWords('')).toBe('changed');
  });

  it('writes times in the active zone', () => {
    expect(whenText('2026-03-12T15:20:00Z', 'America/New_York')).toBe('2026-03-12 11:20');
    expect(spanText('2026-03-12T15:00:00Z', '2026-03-12T16:30:00Z', 'UTC')).toBe('2026-03-12 15:00 to 16:30');
    expect(spanText('2026-03-12T23:00:00Z', '2026-03-13T01:00:00Z', 'UTC')).toBe('2026-03-12 23:00 to 2026-03-13 01:00');
    expect(spanText('2026-03-12T15:00:00Z', null, 'UTC')).toBe('2026-03-12 15:00, still running');
  });

  it('summarises a segment before and after a correction, a void and a decision', () => {
    const before = { rawStart: '2026-03-09T09:00:00Z', rawEnd: '2026-03-09T11:20:00Z', edit: null, subtaskId: null };
    const after = { ...before, edit: { start: '2026-03-09T09:00:00Z', end: '2026-03-09T11:05:00Z', voided: false, reason: 'x' } };
    expect(summarize(before, 'UTC')).toBe('recorded 2026-03-09 09:00 to 11:20');
    expect(summarize(after, 'UTC')).toBe('2026-03-09 09:00 to 11:05 (recorded 2026-03-09 09:00 to 11:20)');
    expect(summarize({ ...before, edit: { start: before.rawStart, end: before.rawEnd, voided: true, reason: '' } }, 'UTC')).toBe('voided (recorded 2026-03-09 09:00 to 11:20)');
    expect(summarize({ decision: 'pending' }, 'UTC')).toBe('waiting for an answer');
    expect(summarize({ decision: 'thinking' }, 'UTC')).toBe('marked as thinking');
    expect(summarize({ reference: 'A-001' }, 'UTC')).toBe('A-001');
    expect(summarize({ start: '2026-03-12T10:00:00Z', end: '2026-03-12T10:20:00Z', kind: 'sleep' }, 'UTC')).toBe('2026-03-12 10:00 to 10:20 (sleep)');
    expect(summarize({ start: '2026-03-12T10:00:00Z', end: '2026-03-12T10:20:00Z', kind: 'lock' }, 'UTC')).toBe('2026-03-12 10:00 to 10:20 (screen locked)');
    expect(summarize(null, 'UTC')).toBe('nothing');
  });

  it('never throws on an unknown shape and keeps long ones short', () => {
    expect(summarize({ a: 1, b: null, c: ['x'] }, 'UTC')).toBe('a 1, b none, c ["x"]');
    expect(summarize(7, 'UTC')).toBe('7');
    expect(summarize(['a'], 'UTC')).toBe('a');
    expect(summarize({ big: 'y'.repeat(400) }, 'UTC').length).toBeLessThanOrEqual(160);
  });

  it('words a restore with the backup it came from and the safety copy it left', () => {
    const e = entry({ entity: 'backup', entityId: 'z-work-data-2026-03-11.json', action: 'restore', before: null, after: { safetyCopy: 'pre-restore-2026-03-12T12-00-00.json' } });
    expect(entityLabel('backup')).toBe('Backup');
    expect(actionWords('restore')).toBe('restored');
    expect(auditLine(e, 'UTC', 'dev', 'Office PC')).toMatchObject({
      before: 'the data in use',
      after: 'z-work-data-2026-03-11.json; the data from just before is kept as pre-restore-2026-03-12T12-00-00.json',
    });
  });

  it('says who made the change', () => {
    expect(auditLine(entry({ by: 'dev' }), 'UTC', 'dev', 'Office PC').by).toBe('this computer (Office PC)');
    expect(auditLine(entry({ by: 'other' }), 'UTC', 'dev', 'Office PC').by).toBe('another computer');
  });
});

describe('remote pause requests in the history', () => {
  it('reads as a request made from this computer, with when it was asked for', () => {
    expect(actionWords('requestPause')).toBe('pause requested from this computer for a task running elsewhere');
    expect(summarize({ segmentId: 'seg-1', at: '2026-03-12T15:20:00Z' }, 'UTC')).toBe('asked at 2026-03-12 15:20');
    const line = auditLine(entry({ entity: 'task', action: 'requestPause', before: null, after: { segmentId: 'seg-1', at: '2026-03-12T15:20:00Z' } }), 'UTC', 'dev', 'Mock PC');
    expect(line).toMatchObject({ before: 'nothing', after: 'asked at 2026-03-12 15:20', by: 'this computer (Mock PC)' });
  });
});

describe('a deleted task in the history', () => {
  const gone = { name: 'Brand guidelines', project: 'Brand refresh', state: 'paused', segments: 3, pauses: 1 };
  it('reads as a task deleted with all its time, naming what went', () => {
    expect(entityLabel('task')).toBe('Task');
    expect(actionWords('delete')).toBe('deleted, with all its time');
    expect(summarize(gone, 'UTC')).toBe('“Brand guidelines” in Brand refresh, paused, 3 time entries, 1 billable pause');
    const line = auditLine(entry({ entity: 'task', entityId: 't', action: 'delete', before: gone, after: null }), 'UTC', 'dev', 'Office PC');
    expect(line).toMatchObject({ by: 'this computer (Office PC)', before: '“Brand guidelines” in Brand refresh, paused, 3 time entries, 1 billable pause', after: 'nothing' });
  });

  it('copes with a task that had no project, one entry and no pauses, and with a record of another shape', () => {
    expect(summarize({ name: 'Solo', project: null, state: 'stopped', segments: 1, pauses: 0 }, 'UTC')).toBe('“Solo”, stopped, 1 time entry');
    expect(summarize({ name: 'Not a task record' }, 'UTC')).toBe('name Not a task record');
    expect(summarize({ name: 'X', segments: 'many', pauses: 0 }, 'UTC')).toBe('name X, segments many, pauses 0');
  });
});
