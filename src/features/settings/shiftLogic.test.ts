import { describe, expect, it } from 'vitest';

import type { ShiftVersion } from '../../lib/types';
import { checkShift, runsOvernight, shiftGroups, weekdaysText, type ShiftDraft } from './shiftLogic';

const draft = (o: Partial<ShiftDraft> = {}): ShiftDraft => ({ shiftId: null, name: 'Morning', color: '#0891b2', start: '06:00', end: '14:00', weekdays: [1, 2, 3], zone: 'UTC', breakMinutes: '30', effectiveFrom: '2026-03-01', ...o });
const stamp = { at: '', by: '' };
const ver = (o: Partial<ShiftVersion>): ShiftVersion => ({ id: 'v', shiftId: 'S', effectiveFrom: '2026-01-01', name: 'Day', color: '#000000', start: '09:00', end: '17:00', weekdays: [1], zone: 'UTC', breakMinutes: 0, retired: false, deleted: false, stamp, ...o });

describe('checkShift', () => {
  it('accepts a valid draft and normalises it', () => {
    const r = checkShift(draft({ weekdays: [3, 1, 2], name: ' Morning ' }));
    expect(r.ok && r.input).toMatchObject({ name: 'Morning', weekdays: [1, 2, 3], breakMinutes: 30, zone: 'UTC' });
  });
  it('reports each problem', () => {
    const r = checkShift(draft({ name: '', weekdays: [], start: '09:00', end: '09:00', breakMinutes: '-5' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['break', 'name', 'time', 'weekdays']);
  });
  it('treats an end before the start as overnight', () => {
    expect(runsOvernight('22:00', '06:00')).toBe(true);
    expect(runsOvernight('06:00', '14:00')).toBe(false);
    expect(checkShift(draft({ start: '22:00', end: '06:00' })).ok).toBe(true);
  });
});

describe('shift helpers', () => {
  it('words weekday sets', () => {
    expect(weekdaysText([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(weekdaysText([7, 6])).toBe('Weekends');
    expect(weekdaysText([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(weekdaysText([1, 3])).toBe('Mon, Wed');
  });
  it('groups versions per shift and flags a retired one', () => {
    const groups = shiftGroups(
      [ver({ id: 'a', effectiveFrom: '2026-01-01' }), ver({ id: 'b', effectiveFrom: '2026-03-01', retired: true }), ver({ id: 'c', shiftId: 'T', name: 'Aaa' })],
      '2026-03-10',
    );
    expect(groups.map((g) => g.current.name)).toEqual(['Aaa', 'Day']);
    const day = groups.find((g) => g.shiftId === 'S');
    expect(day?.retired).toBe(true);
    expect(day?.versions.map((v) => v.id)).toEqual(['b', 'a']);
    expect(shiftGroups([ver({ id: 'a', effectiveFrom: '2026-03-01', retired: true })], '2026-02-01')[0]?.retired).toBe(false);
  });
});
