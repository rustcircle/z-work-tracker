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
    expect(summarize(null, 'UTC')).toBe('nothing');
  });

  it('never throws on an unknown shape and keeps long ones short', () => {
    expect(summarize({ a: 1, b: null, c: ['x'] }, 'UTC')).toBe('a 1, b none, c ["x"]');
    expect(summarize(7, 'UTC')).toBe('7');
    expect(summarize(['a'], 'UTC')).toBe('a');
    expect(summarize({ big: 'y'.repeat(400) }, 'UTC').length).toBeLessThanOrEqual(160);
  });

  it('says who made the change', () => {
    expect(auditLine(entry({ by: 'dev' }), 'UTC', 'dev', 'Office PC').by).toBe('this computer (Office PC)');
    expect(auditLine(entry({ by: 'other' }), 'UTC', 'dev', 'Office PC').by).toBe('another computer');
  });
});
