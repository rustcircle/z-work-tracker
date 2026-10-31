import { describe, expect, it } from 'vitest';

import { RateBook, centsFromNumerator } from '../../lib/billing';
import type { Seg } from '../../lib/split';
import { dayBounds, parseIso } from '../../lib/tz';
import type { RateVersion, RoundingVersion } from '../../lib/types';
import { assignLanes, axisTicks, repeatedPass } from './axisGeometry';
import { allDays, blocksOf, buildClosed, buildOverlay, dayData, entriesOf, overlapSecs, projectTotals, totalsOf, workWindows } from './model';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'x' };
const rate = (projectId: string, cents: number | null, currency = 'USD'): RateVersion => ({ id: `r-${projectId}`, projectId, effectiveFrom: '2026-01-01T00:00:00Z', rateCents: cents, currency, deleted: false, stamp });
const book = new RateBook([{ id: 'p', billable: true }, { id: 'q', billable: true }], [rate('p', 6000), rate('q', null)]);
const none: RoundingVersion[] = [];
const seg = (id: string, taskId: string, start: string, end: string | null, projectId = 'p'): Seg => ({
  id, taskId, projectId, deviceId: 'd', start: parseIso(start), end: end ? parseIso(end) : parseIso(start), live: end === null, remoteOpen: false,
});

describe('axis ticks follow real wall-clock hours', () => {
  it('draws 24 even ticks on an ordinary day', () => {
    const b = dayBounds('2026-03-10', 'UTC');
    const t = axisTicks(b.start, b.end, 'UTC');
    expect(t).toHaveLength(24);
    expect(t[0]?.label).toBe('00:00');
    expect(t[6]?.frac).toBeCloseTo(0.25, 10);
    expect(t.filter((x) => x.major).map((x) => x.label)).toEqual(['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
  });

  it('skips the missing hour on a 23-hour day and keeps true proportions', () => {
    const b = dayBounds('2026-03-08', 'America/New_York');
    expect(b.length).toBe(23 * 3600);
    const t = axisTicks(b.start, b.end, 'America/New_York');
    expect(t).toHaveLength(23);
    expect(t.map((x) => x.label)).not.toContain('02:00');
    // 03:00 EDT is two real hours after midnight: 2/23 of the axis, not 3/24.
    expect(t.find((x) => x.label === '03:00')?.frac).toBeCloseTo(2 / 23, 10);
  });

  it('labels the repeated hour twice on a 25-hour day', () => {
    const b = dayBounds('2026-11-01', 'America/New_York');
    expect(b.length).toBe(25 * 3600);
    const t = axisTicks(b.start, b.end, 'America/New_York');
    expect(t).toHaveLength(25);
    expect(t.filter((x) => x.label.startsWith('01:00')).map((x) => x.label)).toEqual(['01:00', '01:00 again']);
    expect(t.filter((x) => x.repeated)).toHaveLength(1);
    expect(t.find((x) => x.repeated)?.major).toBe(true);
  });

  it('draws a second zone over the same instants, with a midnight date marker', () => {
    const b = dayBounds('2026-03-12', 'Europe/Lisbon');
    const t = axisTicks(b.start, b.end, 'America/New_York');
    // 00:00 UTC is 20:00 on the 11th in New York, so the first tick is 20:00 and midnight lands at 04:00 UTC.
    expect(t[0]?.label).toBe('20:00');
    expect(t[0]?.day).toBe('2026-03-11');
    const mid = t.find((x) => x.midnight);
    expect(mid?.day).toBe('2026-03-12');
    expect(mid?.frac).toBeCloseTo(4 / 24, 10);
  });

  it('puts ticks on wall hours in a zone with a 45-minute offset', () => {
    const b = dayBounds('2026-03-10', 'Asia/Kathmandu');
    const t = axisTicks(b.start, b.end, 'Asia/Kathmandu');
    expect(t).toHaveLength(24);
    expect(t[1]?.frac).toBeCloseTo(1 / 24, 10);
  });

  it('tells the first and second pass of the repeated hour apart', () => {
    const nine = parseIso('2026-11-01T05:30:00Z'); // 01:30 EDT, first pass
    const second = parseIso('2026-11-01T06:30:00Z'); // 01:30 EST
    expect(repeatedPass(nine, 'America/New_York')).toBe(1);
    expect(repeatedPass(second, 'America/New_York')).toBe(2);
    expect(repeatedPass(parseIso('2026-11-01T12:00:00Z'), 'America/New_York')).toBeNull();
  });

  it('assigns overlapping intervals to separate lanes', () => {
    expect(assignLanes([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 10, end: 20 }])).toEqual({ lanes: [0, 1, 0], count: 2 });
    expect(assignLanes([])).toEqual({ lanes: [], count: 1 });
  });
});

describe('timeline model', () => {
  it('rounds once per task per day and keeps exact time separate', () => {
    // 09:00-09:40 and 14:00-14:40 on one task: exact 80 min, billable rounded once to 90 min.
    const segs = [seg('a', 't1', '2026-03-10T09:00:00Z', '2026-03-10T09:40:00Z'), seg('b', 't1', '2026-03-10T14:00:00Z', '2026-03-10T14:40:00Z')];
    const closed = buildClosed(segs, 'UTC', book, none);
    const d = dayData(closed, buildOverlay(closed, 0, book, none), '2026-03-10');
    const t = totalsOf(d.rows);
    expect(t.exactSecs).toBe(4800);
    expect(t.billableSecs).toBe(5400);
    expect(t.rounded).toBe(true);
    expect(centsFromNumerator(t.billable.USD as number)).toBe(9000);
    expect(centsFromNumerator(t.exact.USD as number)).toBe(8000);
  });

  it('band pieces sum to the day total, also across midnight', () => {
    const segs = [seg('a', 't1', '2026-03-10T22:30:00Z', '2026-03-11T00:40:00Z'), seg('b', 't2', '2026-03-11T05:00:00Z', '2026-03-11T07:00:00Z')];
    const closed = buildClosed(segs, 'UTC', book, none);
    expect(closed.days).toEqual(['2026-03-11', '2026-03-10']);
    const d10 = dayData(closed, buildOverlay(closed, 0, book, none), '2026-03-10');
    const d11 = dayData(closed, buildOverlay(closed, 0, book, none), '2026-03-11');
    expect(d10.pieces.reduce((n, p) => n + p.end - p.start, 0)).toBe(5400);
    expect(d11.pieces.reduce((n, p) => n + p.end - p.start, 0)).toBe(2400 + 7200);
    expect(totalsOf(d11.rows).exactSecs).toBe(9600);
    const bands = entriesOf(d11.pieces, book).map((e) => e.band);
    expect(bands).toEqual([0, 0, 1]); // 00:00-00:40 and 05:00-06:00 Night, 06:00-07:00 Morning
  });

  it('exact totals are the same in every zone, billable may differ', () => {
    // 23:50 UTC to 00:20 UTC: one task-day in UTC, two in New York's evening cut? No: 19:50-20:20 EST is one day there too.
    const segs = [seg('a', 't1', '2026-03-10T23:50:00Z', '2026-03-11T00:20:00Z')];
    const utc = buildClosed(segs, 'UTC', book, none);
    const ny = buildClosed(segs, 'America/New_York', book, none);
    const all = (c: typeof utc) => c.days.flatMap((d) => dayData(c, buildOverlay(c, 0, book, none), d).rows);
    expect(totalsOf(all(utc)).exactSecs).toBe(1800);
    expect(totalsOf(all(ny)).exactSecs).toBe(1800);
    // UTC splits it into two days (10 min and 20 min, each rounded up to 15 and 30 min); New York keeps one day.
    expect(totalsOf(all(utc)).billableSecs).toBe(900 + 1800);
    expect(totalsOf(all(ny)).billableSecs).toBe(1800);
  });

  it('keeps a 25-hour day at its true length', () => {
    const segs = [seg('a', 't1', '2026-11-01T04:30:00Z', '2026-11-01T07:30:00Z')]; // 00:30 EDT to 02:30 EST
    const closed = buildClosed(segs, 'America/New_York', book, none);
    const d = dayData(closed, buildOverlay(closed, 0, book, none), '2026-11-01');
    expect(totalsOf(d.rows).exactSecs).toBe(3 * 3600);
  });

  it('re-splits only the running segment and only rebuilds the days it touches', () => {
    const segs = [
      seg('old', 't1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z'),
      seg('today-closed', 't1', '2026-03-12T09:00:00Z', '2026-03-12T10:00:00Z'),
      seg('live', 't1', '2026-03-12T14:00:00Z', null),
    ];
    const closed = buildClosed(segs, 'UTC', book, none);
    const a = buildOverlay(closed, parseIso('2026-03-12T14:20:00Z'), book, none);
    const b = buildOverlay(closed, parseIso('2026-03-12T14:21:00Z'), book, none);
    // The older day is the very same cached object on every tick, so its card does not re-render.
    expect(dayData(closed, a, '2026-03-10')).toBe(dayData(closed, b, '2026-03-10'));
    const t1 = totalsOf(dayData(closed, a, '2026-03-12').rows);
    const t2 = totalsOf(dayData(closed, b, '2026-03-12').rows);
    expect(t1.exactSecs).toBe(3600 + 1200);
    expect(t2.exactSecs).toBe(3600 + 1260);
    expect(t1.billableSecs).toBe(5400); // 80 min rounded up to 90
    expect(t2.billableSecs).toBe(5400); // 81 min still 90
    expect(allDays(closed, a)).toEqual(['2026-03-12', '2026-03-10']);
  });

  it('shows a running task on a day that has no closed time yet', () => {
    const closed = buildClosed([seg('live', 't1', '2026-03-12T14:00:00Z', null)], 'UTC', book, none);
    const o = buildOverlay(closed, parseIso('2026-03-12T14:10:00Z'), book, none);
    expect(closed.days).toEqual([]);
    expect(allDays(closed, o)).toEqual(['2026-03-12']);
    expect(totalsOf(dayData(closed, o, '2026-03-12').rows).exactSecs).toBe(600);
  });

  it('merges band pieces into one block per segment and flags unrated projects', () => {
    const segs = [seg('a', 't1', '2026-03-10T05:00:00Z', '2026-03-10T07:00:00Z'), seg('b', 't2', '2026-03-10T08:00:00Z', '2026-03-10T09:00:00Z', 'q')];
    const closed = buildClosed(segs, 'UTC', book, none);
    const d = dayData(closed, buildOverlay(closed, 0, book, none), '2026-03-10');
    const { blocks, lanes } = blocksOf(d.pieces);
    expect(blocks.map((b) => [b.segId, b.start, b.end])).toEqual([
      ['a', parseIso('2026-03-10T05:00:00Z'), parseIso('2026-03-10T07:00:00Z')],
      ['b', parseIso('2026-03-10T08:00:00Z'), parseIso('2026-03-10T09:00:00Z')],
    ]);
    expect(lanes).toBe(1);
    const per = projectTotals(d.rows);
    expect(per.find((p) => p.projectId === 'p')?.hasRate).toBe(true);
    expect(per.find((p) => p.projectId === 'q')?.hasRate).toBe(false);
  });

  it('counts logged time inside the client working hours', () => {
    // Lisbon day 2026-03-12; New York is UTC-4, so 09:00-17:00 there is 13:00-21:00 UTC.
    const day = dayBounds('2026-03-12', 'Europe/Lisbon');
    const w = workWindows(day.start, day.end, 'America/New_York', '09:00', '17:00');
    expect(w).toEqual([{ start: parseIso('2026-03-12T13:00:00Z'), end: parseIso('2026-03-12T21:00:00Z') }]);
    const pieces = [{ start: parseIso('2026-03-12T12:00:00Z'), end: parseIso('2026-03-12T14:30:00Z') }];
    expect(overlapSecs(pieces, w)).toBe(5400);
  });

  it('an overnight client window is clipped to the day', () => {
    const day = dayBounds('2026-03-12', 'UTC');
    const w = workWindows(day.start, day.end, 'UTC', '22:00', '06:00');
    expect(w).toEqual([
      { start: parseIso('2026-03-12T00:00:00Z'), end: parseIso('2026-03-12T06:00:00Z') },
      { start: parseIso('2026-03-12T22:00:00Z'), end: parseIso('2026-03-13T00:00:00Z') },
    ]);
  });
});
