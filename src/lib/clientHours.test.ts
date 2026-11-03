import { describe, expect, it } from 'vitest';

import { clientHoursWindows } from './clientHours';
import { dayBounds, parseIso } from './tz';

const iso = (s: string): number => parseIso(s);
const pairs = (ws: { start: number; end: number }[]): [string, string][] => ws.map((w) => [new Date(w.start * 1000).toISOString().slice(0, 16), new Date(w.end * 1000).toISOString().slice(0, 16)]);

describe('clientHoursWindows', () => {
  it('gives the hours of every day of the week, weekends included', () => {
    const week = clientHoursWindows(iso('2026-03-09T00:00:00Z'), iso('2026-03-16T00:00:00Z'), 'UTC', '09:00', '17:00');
    expect(pairs(week).map(([a]) => a.slice(0, 10))).toEqual(['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15']);
    expect(week.every((w) => w.end - w.start === 8 * 3600)).toBe(true);
  });

  it('clips the hours to the range asked for', () => {
    const ws = clientHoursWindows(iso('2026-03-14T12:00:00Z'), iso('2026-03-14T20:00:00Z'), 'UTC', '09:00', '17:00');
    expect(pairs(ws)).toEqual([['2026-03-14T12:00', '2026-03-14T17:00']]);
  });

  it('gives nothing when the range holds no working hour', () => {
    expect(clientHoursWindows(iso('2026-03-14T18:00:00Z'), iso('2026-03-14T23:00:00Z'), 'UTC', '09:00', '17:00')).toEqual([]);
  });

  it('reads the hours on the client clock, with the offset in force on each date', () => {
    // New York is UTC-5 before 8 March 2026 and UTC-4 from then on.
    const ws = clientHoursWindows(iso('2026-03-07T00:00:00Z'), iso('2026-03-10T00:00:00Z'), 'America/New_York', '09:00', '17:00');
    expect(pairs(ws)).toEqual([
      ['2026-03-07T14:00', '2026-03-07T22:00'],
      ['2026-03-08T13:00', '2026-03-08T21:00'],
      ['2026-03-09T13:00', '2026-03-09T21:00'],
    ]);
  });

  it('runs hours that end before they start overnight, with the night before the range included', () => {
    const ws = clientHoursWindows(iso('2026-03-10T00:00:00Z'), iso('2026-03-11T12:00:00Z'), 'UTC', '22:00', '06:00');
    expect(pairs(ws)).toEqual([
      ['2026-03-10T00:00', '2026-03-10T06:00'],
      ['2026-03-10T22:00', '2026-03-11T06:00'],
    ]);
  });

  it('keeps the night short on the night the clocks go forward', () => {
    const ws = clientHoursWindows(iso('2026-03-08T00:00:00Z'), iso('2026-03-08T12:00:00Z'), 'America/New_York', '22:00', '06:00');
    expect(ws.map((w) => w.end - w.start)).toEqual([7 * 3600]);
  });

  it('covers every second when the hours start and end at the same time', () => {
    const day = dayBounds('2026-03-14', 'UTC');
    const ws = clientHoursWindows(day.start, day.end + 86400, 'UTC', '00:00', '00:00');
    expect(ws.reduce((n, w) => n + (w.end - w.start), 0)).toBe(2 * 86400);
  });

  it('never overlaps and comes earliest first', () => {
    for (const [s, e] of [['09:00', '17:00'], ['22:00', '06:00'], ['00:00', '00:00'], ['18:30', '02:15']] as const) {
      const ws = clientHoursWindows(iso('2026-03-01T00:00:00Z'), iso('2026-04-05T00:00:00Z'), 'Europe/Lisbon', s, e);
      ws.forEach((w, i) => {
        expect(w.end).toBeGreaterThan(w.start);
        if (i > 0) expect(w.start).toBeGreaterThanOrEqual((ws[i - 1] as { end: number }).end);
      });
    }
  });
});
