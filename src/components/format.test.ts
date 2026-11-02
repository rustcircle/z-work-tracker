import { describe, expect, it } from 'vitest';

import { MASK } from '../lib/billing';
import { parseIso } from '../lib/tz';
import { rangeText } from '../features/timeline/DayCard';
import { addNumerators, ago, amountText, clock, dayLabel, formatDuration, formatHMS, listOf, relativeDay } from './format';

describe('durations', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(605)).toBe('10m 05s');
    expect(formatDuration(3600)).toBe('1h 00m');
    expect(formatDuration(3 * 3600 + 25 * 60 + 59)).toBe('3h 25m');
    expect(formatHMS(3725)).toBe('1:02:05');
    expect(formatHMS(-5)).toBe('0:00:00');
  });
  it('says how long ago, without a 60 min edge', () => {
    const now = 1_000_000;
    expect(ago(now - 10, now)).toBe('just now');
    expect(ago(now - 120, now)).toBe('2 min ago');
    expect(ago(now - 3599, now)).toBe('1 h ago');
    expect(ago(now - 7200, now)).toBe('2 h ago');
    expect(ago(now - 3 * 86400, now)).toBe('3 d ago');
  });
});

describe('dates and money', () => {
  it('labels days without Intl', () => {
    expect(dayLabel('2026-03-12')).toBe('Thu 12 Mar 2026');
    expect(relativeDay('2026-03-12', '2026-03-12')).toBe('Today, Thu 12 Mar 2026');
    expect(relativeDay('2026-03-11', '2026-03-12')).toBe('Yesterday, Wed 11 Mar 2026');
    expect(relativeDay('2026-03-01', '2026-03-12')).toBe('Sun 1 Mar 2026');
  });
  it('masks only when there is an amount to hide', () => {
    expect(amountText({ USD: 36_000_000 }, false)).toBe('$100.00');
    expect(amountText({ USD: 36_000_000 }, true)).toBe(MASK);
    expect(amountText({}, true)).toBe('');
    expect(amountText({ EUR: 3_600_000, USD: 7_200_000 }, false)).toBe('€10.00 + $20.00');
    expect(addNumerators({ USD: 1 }, { USD: 2, EUR: 3 })).toEqual({ USD: 3, EUR: 3 });
  });
});

describe('lists in a sentence', () => {
  it('joins two with and, and more with commas and and', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['A-001'])).toBe('A-001');
    expect(listOf(['A-001', 'A-002'])).toBe('A-001 and A-002');
    expect(listOf(['A-001', 'A-002', 'A-003'])).toBe('A-001, A-002 and A-003');
  });
});

describe('rangeText', () => {
  const at = (iso: string) => parseIso(iso);
  it('prints a plain range, and 24:00 for an end at midnight', () => {
    expect(rangeText(at('2026-03-12T14:00:00Z'), at('2026-03-12T16:30:00Z'), 'UTC', '2026-03-12')).toBe('14:00–16:30');
    expect(rangeText(at('2026-03-12T22:30:00Z'), at('2026-03-13T00:00:00Z'), 'UTC', '2026-03-12')).toBe('22:30–24:00');
  });
  it('marks the date where the other zone is on a different day', () => {
    // 00:00-00:40 UTC on the 12th is 20:00-20:40 on the 11th in New York.
    expect(rangeText(at('2026-03-12T00:00:00Z'), at('2026-03-12T00:40:00Z'), 'America/New_York', '2026-03-12')).toBe('11 Mar 20:00–20:40');
    expect(rangeText(at('2026-03-12T03:30:00Z'), at('2026-03-12T05:00:00Z'), 'America/New_York', '2026-03-12')).toBe('11 Mar 23:30 – 12 Mar 01:00');
  });
  it('tells the two passes of a repeated hour apart', () => {
    const first = rangeText(at('2026-11-01T05:10:00Z'), at('2026-11-01T05:40:00Z'), 'America/New_York', '2026-11-01', true);
    const second = rangeText(at('2026-11-01T06:10:00Z'), at('2026-11-01T06:40:00Z'), 'America/New_York', '2026-11-01', true);
    expect(first).toBe('01:10–01:40 (1st pass)');
    expect(second).toBe('01:10–01:40 (2nd pass)');
    expect(clock(at('2026-11-01T06:10:00Z'), 'America/New_York')).toBe('01:10');
  });
});
