import { describe, expect, it } from 'vitest';

import { RateBook, centsFromNumerator } from '../../lib/billing';
import { parseIso } from '../../lib/tz';
import type { IdleGap, RateVersion, RawSegment, Segment, Task } from '../../lib/types';
import { fullTask } from '../../mocks/factories';
import { blocksOf, buildClosed, buildOverlay, dayData, differs, entriesOf, rawIndex, timelineSegs, totalsOf } from './model';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'd' };
const rate: RateVersion = { id: 'r', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 6000, currency: 'USD', deleted: false, stamp };
const book = new RateBook([{ id: 'p', billable: true }], [rate]);
const fixedBook = new RateBook([{ id: 'p', billable: true, billingType: 'fixedFee' }], [rate]);
const tasks: Task[] = [fullTask({ id: 't1', projectId: 'p' })];

const piece = (id: string, start: string, end: string | null, kind: Segment['kind'] = 'work', segmentId?: string): Segment => ({
  id, taskId: 't1', deviceId: kind === 'billablePause' ? '' : 'd', start, end, provisionalEnd: null, kind, ...(segmentId ? { segmentId } : {}),
});
const gap = (id: string, decision: IdleGap['decision'], start: string, end: string): IdleGap => ({ id, segmentId: 's1', taskId: 't1', deviceId: 'd', start, end, kind: 'idle', decision, decisionStamp: stamp });

const dayOf = (segments: Segment[], gaps: IdleGap[], day = '2026-03-10', rounding = [] as never[]) => {
  const closed = buildClosed(timelineSegs({ segments, tasks, gaps }), 'UTC', book, rounding);
  return dayData(closed, buildOverlay(closed, 0, book, rounding), day);
};

describe('timeline segments carry their kind', () => {
  it('turns pending and dropped gaps into segments that are not work, and ignores the others', () => {
    const segs = timelineSegs({
      segments: [piece('s1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z')],
      tasks,
      gaps: [gap('a', 'pending', '2026-03-10T09:10:00Z', '2026-03-10T09:20:00Z'), gap('b', 'drop', '2026-03-10T09:30:00Z', '2026-03-10T09:40:00Z'), gap('c', 'keep', '2026-03-10T09:45:00Z', '2026-03-10T09:50:00Z'), gap('d', 'thinking', '2026-03-10T09:52:00Z', '2026-03-10T09:55:00Z')],
    });
    expect(segs.map((s) => [s.id, s.kind])).toEqual([['s1', 'work'], ['gap:a', 'pending'], ['gap:b', 'dropped']]);
  });

  it('a missing kind is work and the recorded segment id falls back to the piece id', () => {
    const [s] = timelineSegs({ segments: [{ id: 'x', taskId: 't1', deviceId: 'd', start: '2026-03-10T09:00:00Z', end: '2026-03-10T10:00:00Z', provisionalEnd: null }], tasks, gaps: [] });
    expect(s?.kind).toBe('work');
    expect(s?.segmentId).toBe('x');
  });
});

describe('what counts', () => {
  it('pending and dropped time are drawn but add nothing to exact, billable or earnings', () => {
    const d = dayOf([piece('s1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z')], [gap('a', 'pending', '2026-03-10T11:00:00Z', '2026-03-10T11:30:00Z'), gap('b', 'drop', '2026-03-10T12:00:00Z', '2026-03-10T12:30:00Z')]);
    const t = totalsOf(d.rows);
    expect(t.exactSecs).toBe(3600);
    expect(t.billableSecs).toBe(3600);
    expect(t.pauseSecs).toBe(0);
    const entries = entriesOf(d.pieces, book);
    expect(entries.map((e) => e.kind)).toEqual(['work', 'pending', 'dropped']);
    expect(entries.filter((e) => e.kind !== 'work').every((e) => Object.keys(e.numerators).length === 0)).toBe(true);
    const { blocks } = blocksOf(d.pieces);
    expect(blocks.map((b) => b.kind)).toEqual(['work', 'pending', 'dropped']);
  });

  it('a day with only a dropped stretch is still listed', () => {
    const closed = buildClosed(timelineSegs({ segments: [], tasks, gaps: [gap('b', 'drop', '2026-03-10T12:00:00Z', '2026-03-10T12:30:00Z')] }), 'UTC', book, []);
    expect(closed.days).toEqual(['2026-03-10']);
  });

  it('a billable pause is billable only: never exact, rounded together, and it earns', () => {
    // 1 h of work and a 30 min pause: exact 60, billable 90, earnings at 60.00/h for the 90 minutes.
    const d = dayOf([piece('s1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'), piece('p1', '2026-03-10T10:30:00Z', '2026-03-10T11:00:00Z', 'billablePause', 'pause-1')], []);
    const t = totalsOf(d.rows);
    expect(t.exactSecs).toBe(3600);
    expect(t.pauseSecs).toBe(1800);
    expect(t.billableSecs).toBe(5400);
    expect(differs(t)).toBe(true);
    expect(centsFromNumerator(t.billable.USD ?? 0)).toBe(9000);
    expect(centsFromNumerator(t.exact.USD ?? 0)).toBe(6000);
    const pause = entriesOf(d.pieces, book).find((e) => e.kind === 'billablePause');
    expect(pause?.segmentId).toBe('pause-1');
    expect(centsFromNumerator(pause?.numerators.USD ?? 0)).toBe(3000);
  });

  it('rounding applies once to exact plus pauses', () => {
    // 50 min of work + 20 min pause = 70 min -> 75 (up to 15), not 60 + 30.
    const d = dayOf([piece('s1', '2026-03-10T09:00:00Z', '2026-03-10T09:50:00Z'), piece('p1', '2026-03-10T10:00:00Z', '2026-03-10T10:20:00Z', 'billablePause')], [], '2026-03-10', [{ id: 'g', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp }] as never[]);
    const t = totalsOf(d.rows);
    expect(t.billableSecs).toBe(75 * 60);
    expect(t.rounded).toBe(true);
  });

  it('thinking counts in exact and billable and is reported on its own', () => {
    const off = [{ id: 'g', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 0, method: 'up', deleted: false, stamp }] as never[];
    const d = dayOf([piece('s1', '2026-03-10T09:00:00Z', '2026-03-10T09:30:00Z'), piece('s1:1', '2026-03-10T09:30:00Z', '2026-03-10T09:45:00Z', 'thinking', 's1')], [], '2026-03-10', off);
    const t = totalsOf(d.rows);
    expect(t.exactSecs).toBe(45 * 60);
    expect(t.thinkingSecs).toBe(15 * 60);
    expect(t.billableSecs).toBe(45 * 60);
    expect(differs(t)).toBe(false);
  });

  it('a fixed-fee project earns no hourly money on any kind of time', () => {
    const closed = buildClosed(timelineSegs({ segments: [piece('s1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'), piece('p1', '2026-03-10T10:30:00Z', '2026-03-10T11:00:00Z', 'billablePause')], tasks, gaps: [] }), 'UTC', fixedBook, []);
    const d = dayData(closed, buildOverlay(closed, 0, fixedBook, []), '2026-03-10');
    expect(totalsOf(d.rows).billable).toEqual({});
    expect(entriesOf(d.pieces, fixedBook).every((e) => Object.keys(e.numerators).length === 0)).toBe(true);
  });

  it('a running task keeps its per-tick split: an older day is the same cached object on every tick', () => {
    const segments = [piece('old', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'), piece('p1', '2026-03-12T10:00:00Z', '2026-03-12T10:30:00Z', 'billablePause'), piece('live', '2026-03-12T14:00:00Z', null)];
    const closed = buildClosed(timelineSegs({ segments, tasks, gaps: [gap('a', 'pending', '2026-03-12T14:00:00Z', '2026-03-12T14:10:00Z')] }), 'UTC', book, []);
    const a = buildOverlay(closed, parseIso('2026-03-12T14:20:00Z'), book, []);
    const b = buildOverlay(closed, parseIso('2026-03-12T14:21:00Z'), book, []);
    expect(dayData(closed, a, '2026-03-10')).toBe(dayData(closed, b, '2026-03-10'));
    const t1 = totalsOf(dayData(closed, a, '2026-03-12').rows);
    const t2 = totalsOf(dayData(closed, b, '2026-03-12').rows);
    expect(t1.exactSecs).toBe(20 * 60);
    expect(t2.exactSecs).toBe(21 * 60);
    expect(t1.pauseSecs).toBe(1800);
  });
});

describe('raw index', () => {
  const raw = (over: Partial<RawSegment>): RawSegment => ({ id: 'r', taskId: 't1', deviceId: 'd', rawStart: '2026-03-10T09:00:00Z', rawEnd: '2026-03-10T10:00:00Z', start: '2026-03-10T09:00:00Z', end: '2026-03-10T10:00:00Z', voided: false, corrected: false, manual: false, reason: '', billed: false, ...over });
  it('marks corrected and manual segments, lists voided ones by day, and ignores plain ones', () => {
    const idx = rawIndex([raw({ id: 'a', corrected: true }), raw({ id: 'b', manual: true }), raw({ id: 'c' }), raw({ id: 'd', voided: true, corrected: true })], 'UTC');
    expect([...idx.marks.keys()]).toEqual(['a', 'b']);
    expect(idx.voided.get('2026-03-10')?.map((r) => r.id)).toEqual(['d']);
  });
});
