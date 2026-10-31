import { describe, expect, it } from 'vitest';

import type { Seg } from '../../lib/split';
import { parseIso } from '../../lib/tz';
import type { ShiftVersion } from '../../lib/types';
import { segmentShiftText } from './segmentShifts';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'x' };
const shift = (o: Partial<ShiftVersion>): ShiftVersion => ({
  id: 'v1', shiftId: 'S1', effectiveFrom: '2026-01-01', name: 'Morning', color: '#123456', start: '09:00', end: '13:00',
  weekdays: [1, 2, 3, 4, 5, 6, 7], zone: 'UTC', breakMinutes: 0, retired: false, deleted: false, stamp, ...o,
});
const seg = (id: string, start: string, end: string): Seg => ({ id, taskId: 't', projectId: 'p', deviceId: 'd', start: parseIso(start), end: parseIso(end), live: false, remoteOpen: false });

describe('segmentShiftText', () => {
  it('splits a segment into shift and outside time', () => {
    const out = segmentShiftText([seg('a', '2026-03-10T08:30:00Z', '2026-03-10T10:00:00Z')], [shift({})]);
    expect(out).toEqual({ a: 'Outside 0:30:00; Morning 1:00:00' });
  });

  it('is empty without shifts and skips empty segments', () => {
    expect(segmentShiftText([seg('a', '2026-03-10T08:30:00Z', '2026-03-10T10:00:00Z')], [])).toEqual({});
    expect(segmentShiftText([seg('z', '2026-03-10T10:00:00Z', '2026-03-10T10:00:00Z')], [shift({})])).toEqual({});
  });

  it('gives overlapping shifts to the earliest start so nothing is counted twice', () => {
    const out = segmentShiftText(
      [seg('a', '2026-03-10T09:00:00Z', '2026-03-10T13:00:00Z')],
      [shift({}), shift({ id: 'v2', shiftId: 'S2', name: 'Cover', start: '10:00', end: '14:00' })],
    );
    expect(out).toEqual({ a: 'Morning 4:00:00' });
  });

  it('attributes an overnight shift to the date it started on', () => {
    const night = shift({ name: 'Night', start: '22:00', end: '06:00' });
    const out = segmentShiftText([seg('a', '2026-03-11T01:00:00Z', '2026-03-11T02:30:00Z')], [night]);
    expect(out).toEqual({ a: 'Night 1:30:00' });
  });

  it('keeps working over many segments and long ranges', () => {
    const segs = Array.from({ length: 400 }, (_, i) => seg(`s${i}`, `2026-0${1 + (i % 6)}-10T09:00:00Z`, `2026-0${1 + (i % 6)}-10T10:00:00Z`));
    const out = segmentShiftText(segs, [shift({})]);
    expect(Object.keys(out)).toHaveLength(400);
    expect(out['s7']).toBe('Morning 1:00:00');
  });
});
