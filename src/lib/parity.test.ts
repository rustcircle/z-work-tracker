// The same fixtures run in Rust (z-work-core billing tests), so both sides stay in agreement.
import { describe, expect, it } from 'vitest';

import billing from '../../fixtures/billing-fixtures.json';
import tz from '../../fixtures/tz-fixtures.json';
import { RateBook, centsFromNumerator, exactNumeratorsOf, numeratorsOf, taskDays } from './billing';
import type { RateVersion, RoundMethod, RoundingVersion } from './types';
import { addDays, clockAt, dayBounds, dayOf, offsetAt, parseIso, startOfDay, toIso } from './tz';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'x' };

describe('shared tz fixtures', () => {
  it.each(tz.conversions)('$zone at $at', (c) => {
    const t = parseIso(c.at);
    expect(dayOf(t, c.zone)).toBe(c.day);
    expect(clockAt(t, c.zone)).toBe(c.clock);
    expect(offsetAt(t, c.zone) / 60).toBe(c.offsetMin);
  });

  it.each(tz.days)('$zone day $day', (c) => {
    expect(toIso(startOfDay(c.day, c.zone))).toBe(c.start);
    expect(dayBounds(c.day, c.zone).length).toBe(c.hours * 3600);
  });

  it.each(tz.splits)('split $zone $start', (c) => {
    const rows = taskDays(
      [{ taskId: 't', projectId: 'p', start: parseIso(c.start), end: parseIso(c.end) }],
      c.zone,
      new RateBook([], []),
      [{ id: 'r', projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 0, method: 'up', deleted: false, stamp }],
    ).sort((a, b) => a.day.localeCompare(b.day));
    expect(rows.map((r) => ({ day: r.day, secs: r.exactSecs }))).toEqual(c.pieces);
  });
});

describe('shared billing fixtures', () => {
  it.each(billing.cases)('$name', (c) => {
    const rates: RateVersion[] = c.rates.map((r, i) => ({
      id: `r${i}`, projectId: 'p', effectiveFrom: r.from, rateCents: r.cents, currency: r.currency, deleted: false, stamp,
    }));
    const rounding: RoundingVersion[] = c.rounding.map((r, i) => ({
      id: `o${i}`, projectId: null, effectiveFrom: r.from, incrementMinutes: r.minutes, method: r.method as RoundMethod, deleted: false, stamp,
    }));
    // Additive fields: pauses and thinking are lists of [from, to], fixedFee marks the project, rows[].pause is the pause seconds.
    const extra = c as typeof c & { pauses?: string[][]; thinking?: string[][]; fixedFee?: boolean };
    const span = (pair: string[], kind?: 'billablePause' | 'thinking') => ({ taskId: 't', projectId: 'p', start: parseIso(pair[0] as string), end: parseIso(pair[1] as string), ...(kind ? { kind } : {}) });
    const spans = [...c.segments.map((x) => span(x)), ...(extra.thinking ?? []).map((x) => span(x, 'thinking')), ...(extra.pauses ?? []).map((x) => span(x, 'billablePause'))];
    const book = new RateBook([{ id: 'p', billable: true, billingType: extra.fixedFee ? 'fixedFee' : 'hourly' }], rates);
    const rows = taskDays(spans, c.zone, book, rounding).sort((a, b) => a.day.localeCompare(b.day));
    expect(rows.length).toBe(c.rows.length);
    rows.forEach((r, i) => {
      const w = c.rows[i] as (typeof c.rows)[number] & { roundedToZero?: boolean; pause?: number };
      expect(r.day).toBe(w.day);
      expect(r.exactSecs).toBe(w.exact);
      expect(r.pauseSecs).toBe(w.pause ?? 0);
      expect(r.billableSecs).toBe(w.billable);
      expect(r.roundedToZero).toBe(w.roundedToZero ?? false);
      const amounts = Object.fromEntries(Object.entries(numeratorsOf([r])).map(([k, n]) => [k, centsFromNumerator(n)]));
      expect(amounts).toEqual(w.amounts);
      const exact = Object.fromEntries(Object.entries(exactNumeratorsOf([r])).map(([k, n]) => [k, centsFromNumerator(n)]));
      expect(exact).toEqual(w.exactAmounts);
    });
  });

  it('addDays crosses months', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});
