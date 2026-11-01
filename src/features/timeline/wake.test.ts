// What makes the Timeline look at the clock again must not be fooled by yesterday's row of a segment that runs
// past midnight: that row stopped growing at midnight, so its counted time being an exact multiple of the
// increment must not mean "a step is due every second until it stops".
import { describe, expect, it } from 'vitest';

import { nextWake } from '../../app/stepClock';
import { RateBook } from '../../lib/billing';
import { dayBounds, parseIso } from '../../lib/tz';
import type { RoundingVersion, Segment, Task } from '../../lib/types';
import { fullTask } from '../../mocks/factories';
import { buildClosed, buildOverlay, growingRows, timelineSegs } from './model';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'd' };
const book = new RateBook([{ id: 'p', billable: true }], []);
const tasks: Task[] = [fullTask({ id: 't1', projectId: 'p' })];
const rounding: RoundingVersion[] = [{ id: 'r', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up', deleted: false, stamp }];
// Running since 22:00 yesterday (UTC).
const running: Segment = { id: 's1', taskId: 't1', deviceId: 'd', start: '2026-03-10T22:00:00Z', end: null, provisionalEnd: null };

function wakeAt(iso: string, only: 'today' | 'all'): number {
  const closed = buildClosed(timelineSegs({ segments: [running], tasks, gaps: [] }), 'UTC', book, rounding);
  const at = parseIso(iso);
  const ov = buildOverlay(closed, at, book, rounding);
  const today = iso.slice(0, 10);
  const rows = only === 'today' ? growingRows(ov, today) : [...ov.rows.values()].flat().map((r) => ({ counted: r.exactSecs + r.pauseSecs, rule: r.rule }));
  return nextWake(rows, at, closed.liveSegs[0]?.start ?? null, dayBounds(today, 'UTC').end - at);
}

describe('rows that are still growing', () => {
  it('yesterday holds exactly 2 hours (a multiple of 15 minutes): counting it would wake every second', () => {
    // 00:10:30: today has 10m30s, so the next step is minutes away and the next minute mark (30 s) comes first.
    expect(wakeAt('2026-03-11T00:10:30Z', 'all')).toBe(1);
    expect(wakeAt('2026-03-11T00:10:30Z', 'today')).toBe(30);
  });

  it('only the day containing now is returned', () => {
    const closed = buildClosed(timelineSegs({ segments: [running], tasks, gaps: [] }), 'UTC', book, rounding);
    const ov = buildOverlay(closed, parseIso('2026-03-11T00:10:30Z'), book, rounding);
    expect([...ov.rows.keys()].sort()).toEqual(['2026-03-10', '2026-03-11']);
    expect(growingRows(ov, '2026-03-11')).toEqual([{ counted: 630, rule: { incrementMinutes: 15, method: 'up' } }]);
    expect(growingRows(ov, '2026-03-12')).toEqual([]);
  });

  it('today\'s own step still wakes the screen on time', () => {
    // 00:14:59 of today counted: the step to the next quarter is due in 2 s (Up passes a multiple by a second).
    expect(wakeAt('2026-03-11T00:14:59Z', 'today')).toBe(1);
    expect(wakeAt('2026-03-11T00:15:00Z', 'today')).toBe(1);
  });
});
