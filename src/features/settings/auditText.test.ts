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

describe('another computer stopped responding, and came back', () => {
  const start = '2026-03-09T09:00:00Z';
  const settledEdit = { start, end: '2026-03-09T11:50:00Z', voided: false, reason: 'Closed from Office PC: LAPTOP stopped responding. Ended at its last known moment.', settled: true };
  const open = { rawStart: start, rawEnd: null, edit: null, subtaskId: null };
  const closedFor = { ...open, edit: settledEdit };
  const back = { rawStart: start, rawEnd: '2026-03-09T12:30:00Z', subtaskId: null };

  it('words the closing, and says that the computer never recorded that end', () => {
    expect(actionWords('settleLost')).toBe('closed for a computer that stopped responding');
    const e = entry({ action: 'settleLost', reason: settledEdit.reason, before: open, after: closedFor });
    expect(auditLine(e, 'UTC', 'dev', 'Office PC')).toMatchObject({
      by: 'this computer (Office PC)',
      before: 'recorded 2026-03-09 09:00, still running',
      after: '2026-03-09 09:00 to 11:50 (closed at its last known moment; recorded 2026-03-09 09:00, still running)',
    });
  });

  it('words the owner coming back: its own end replaces the closing', () => {
    expect(actionWords('reclaimAfterReturn')).toBe('set back to the end its own computer recorded');
    const e = entry({ action: 'reclaimAfterReturn', reason: "this device's own record", before: { ...back, edit: settledEdit }, after: { ...back, edit: null } });
    expect(auditLine(e, 'UTC', 'dev', 'Office PC')).toMatchObject({
      before: '2026-03-09 09:00 to 11:50 (closed at its last known moment; recorded 2026-03-09 09:00 to 12:30)',
      after: 'recorded 2026-03-09 09:00 to 12:30',
    });
  });

  it('words a closing that stays because the time is billed', () => {
    expect(actionWords('reclaimOnSummary')).toBe('kept as billed, though its own computer recorded another end');
    const kept = { start, end: settledEdit.end, voided: false, reason: settledEdit.reason };
    const e = entry({ action: 'reclaimOnSummary', reason: "this device's record differs", before: { ...back, edit: settledEdit }, after: { ...back, edit: kept } });
    expect(auditLine(e, 'UTC', 'dev', 'Office PC')).toMatchObject({
      before: '2026-03-09 09:00 to 11:50 (closed at its last known moment; recorded 2026-03-09 09:00 to 12:30)',
      after: '2026-03-09 09:00 to 11:50 (recorded 2026-03-09 09:00 to 12:30)',
    });
  });

  it('keeps a correction that is not a closing worded as before', () => {
    const corrected = { ...open, edit: { start, end: '2026-03-09T11:05:00Z', voided: false, reason: 'x' } };
    expect(summarize(corrected, 'UTC')).toBe('2026-03-09 09:00 to 11:05 (recorded 2026-03-09 09:00, still running)');
  });
});

describe('this computer\'s clock put back while a task ran', () => {
  it('reads as an entry closed because of the clock, with where it ended', () => {
    expect(actionWords('clockPutBack')).toBe("closed because its computer's clock was put back");
    const before = { rawStart: '2026-03-09T09:00:00Z', rawEnd: null, edit: null, subtaskId: null };
    const after = { ...before, rawEnd: '2026-03-09T10:00:00Z' };
    const line = auditLine(entry({ action: 'clockPutBack', before, after }), 'UTC', 'dev', 'Office PC');
    expect(line).toMatchObject({ before: 'recorded 2026-03-09 09:00, still running', after: 'recorded 2026-03-09 09:00 to 10:00' });
  });
});

describe('the turn to change data going to another computer', () => {
  const lost = (by: unknown, closed: string[]) => entry({ entity: 'lease', entityId: 'dev', action: 'leaseLost', before: null, after: { by, generation: 5, closed } });

  it('names the entity and the action in plain words', () => {
    expect(entityLabel('lease')).toBe('Use of the app');
    expect(actionWords('leaseLost')).toBe('went to another computer, as recorded');
  });

  it('says who took over and how many running entries stopped here', () => {
    expect(auditLine(lost('LAPTOP', ['s1']), 'UTC', 'dev', 'Office PC')).toEqual({
      when: '2026-03-12 15:20',
      by: 'this computer (Office PC)',
      before: 'this computer could change data',
      after: 'LAPTOP took over; 1 running entry stopped here',
    });
    expect(auditLine(lost('LAPTOP', ['s1', 's2']), 'UTC', 'dev', 'Office PC').after).toBe('LAPTOP took over; 2 running entries stopped here');
    expect(auditLine(lost('LAPTOP', []), 'UTC', 'dev', 'Office PC').after).toBe('LAPTOP took over');
  });

  it('reads from the viewer\'s side, and never prints a device id as a name', () => {
    expect(auditLine(lost('LAPTOP', []), 'UTC', 'other-dev', 'Home PC')).toMatchObject({ by: 'another computer', before: 'that computer could change data' });
    expect(auditLine(lost('22222222-2222-4222-8222-222222222222', []), 'UTC', 'dev', 'Office PC').after).toBe('another computer took over');
    expect(auditLine(lost(null, ['s1']), 'UTC', 'dev', 'Office PC').after).toBe('another computer took over; 1 running entry stopped here');
  });
});

describe('a saved version restored', () => {
  const name = '20260301T090000Z--a1b2c3d4--auto';
  const restored = (after: unknown) => entry({ entity: 'version', entityId: name, action: 'restore', before: null, after });

  it('names the version by its date and why it was made, and what was kept of the data before', () => {
    expect(entityLabel('version')).toBe('Saved version');
    expect(actionWords('restore')).toBe('restored');
    const after = { safetyCopy: 'pre-restore-2026-03-12T12-00-00.json', preRestore: '20260312T120000Z--0a1b2c3d--pre-restore', epoch: 2 };
    expect(auditLine(restored(after), 'UTC', 'dev', 'Office PC')).toMatchObject({
      before: 'the data in use',
      after: 'the version of 2026-03-01 09:00 (automatic hourly copy); the data from just before is kept as pre-restore-2026-03-12T12-00-00.json and as the version of 2026-03-12 12:00 (copy of the data before a restore)',
    });
  });

  it('copes with no copy in the folders, and with a name that is not a version name', () => {
    expect(auditLine(restored({ safetyCopy: 's.json', preRestore: null }), 'UTC', 'dev', 'x').after).toBe('the version of 2026-03-01 09:00 (automatic hourly copy); the data from just before is kept as s.json');
    expect(auditLine(entry({ entity: 'version', entityId: 'odd.json', action: 'restore', after: { safetyCopy: 's.json' } }), 'UTC', 'dev', 'x').after).toBe('odd.json; the data from just before is kept as s.json');
  });

  it('shows the time in the zone on screen', () => {
    expect(auditLine(restored({ safetyCopy: 's.json' }), 'America/New_York', 'dev', 'x').after).toMatch(/^the version of 2026-03-01 04:00 /);
  });
});

describe('a price version taken away', () => {
  const priceBefore = { projectId: 'p1', effectiveFrom: '2026-04-01T00:00:00Z', rateCents: 7000, currency: 'EUR' };
  const removed = (before: unknown) => entry({ entity: 'price', entityId: 'r1', action: 'removed', before, after: null });

  it('reads as a price removed, with the rate and the day it applied from', () => {
    expect(entityLabel('price')).toBe('Price');
    expect(actionWords('removed')).toBe('removed');
    expect(auditLine(removed(priceBefore), 'UTC', 'dev', 'Office PC')).toMatchObject({ before: '€70.00/h from 2026-04-01', after: 'nothing' });
    expect(summarize({ ...priceBefore, currency: 'USD', rateCents: 12_550 }, 'UTC')).toBe('$125.50/h from 2026-04-01');
  });

  it('gives the day in the zone on screen, where that day started', () => {
    expect(summarize(priceBefore, 'America/New_York')).toBe('€70.00/h from 2026-03-31');
  });

  it('hides the amount while earnings are hidden, as everything else does', () => {
    expect(auditLine(removed(priceBefore), 'UTC', 'dev', 'Office PC', true).before).toBe('rate hidden from 2026-04-01');
    expect(auditLine(removed(priceBefore), 'UTC', 'dev', 'Office PC', false).before).toBe('€70.00/h from 2026-04-01');
  });

  it('copes with no rate and with a currency it does not know', () => {
    expect(summarize({ ...priceBefore, rateCents: null }, 'UTC')).toBe('no rate from 2026-04-01');
    expect(summarize({ ...priceBefore, currency: 'GBP' }, 'UTC')).toBe('70.00 GBP/h from 2026-04-01');
    expect(summarize({ ...priceBefore, currency: null }, 'UTC')).toBe('70.00/h from 2026-04-01');
  });

  it('is not mistaken for an unknown shape', () => {
    expect(summarize(priceBefore, 'UTC')).not.toContain('projectId');
  });
});
