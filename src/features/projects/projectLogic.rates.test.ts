// The pure rules behind removing a price version, the limits of its start date, and the form's wording after a partial save.
import { describe, expect, it } from 'vitest';

import { addDays, startOfDay } from '../../lib/tz';
import type { RateVersion } from '../../lib/types';
import { chosenDayBounds, laterVersion, priceFieldsOf, rateHistory, savedButNot } from './projectLogic';

const EARLIEST = Date.parse('2000-01-01T00:00:00Z') / 1000;
const LATEST = Date.parse('2100-01-01T00:00:00Z') / 1000;
const rate = (cents: number | null, currency: string): RateVersion => ({ id: 'r', projectId: 'p', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: cents, currency, deleted: false, stamp: { at: '', by: '' } });

describe('chosenDayBounds: the days a price may start on, which the backend takes from 2000-01-01 to 2100-01-01 UTC', () => {
  it.each([
    ['Europe/Lisbon', '2000-01-01', '2100-01-01'],
    ['UTC', '2000-01-01', '2100-01-01'],
    ['Asia/Tokyo', '2000-01-02', '2100-01-01'],
    ['America/New_York', '2000-01-01', '2099-12-31'],
    ['Pacific/Kiritimati', '2000-01-02', '2100-01-01'],
    ['Pacific/Pago_Pago', '2000-01-01', '2099-12-31'],
  ])('%s: from %s to %s', (zone, min, max) => {
    expect(chosenDayBounds(zone)).toEqual({ min, max });
  });

  it.each(['Europe/Lisbon', 'Asia/Tokyo', 'America/New_York', 'Australia/Sydney', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'])('%s: the first and last day start inside the range, and the days beside them do not', (zone) => {
    const { min, max } = chosenDayBounds(zone);
    expect(startOfDay(min, zone)).toBeGreaterThanOrEqual(EARLIEST);
    expect(startOfDay(addDays(min, -1), zone)).toBeLessThan(EARLIEST);
    expect(startOfDay(max, zone)).toBeLessThanOrEqual(LATEST);
    expect(startOfDay(addDays(max, 1), zone)).toBeGreaterThan(LATEST);
  });
});

describe('priceFieldsOf: what the price and currency fields show', () => {
  it('shows the price and currency in force', () => {
    expect(priceFieldsOf(rate(9050, 'USD'), 'EUR')).toEqual({ price: '90.50', currency: 'USD' });
    expect(priceFieldsOf(rate(6000, 'EUR'), null)).toEqual({ price: '60', currency: 'EUR' });
    expect(priceFieldsOf(rate(0, 'EUR'), 'USD')).toEqual({ price: '0', currency: 'EUR' });
  });
  it('shows nothing and the last currency used for no price, a price of "no rate", or a currency it does not know', () => {
    expect(priceFieldsOf(null, 'USD')).toEqual({ price: '', currency: 'USD' });
    expect(priceFieldsOf(null, null)).toEqual({ price: '', currency: 'EUR' });
    expect(priceFieldsOf(rate(null, 'USD'), 'EUR')).toEqual({ price: '', currency: 'USD' });
    expect(priceFieldsOf(rate(100, 'GBP'), 'USD')).toEqual({ price: '1', currency: 'USD' });
  });
});

describe('savedButNot: the form after the project was saved and the next step was refused', () => {
  it('says what was saved, what was not and why, as one sentence', () => {
    expect(savedButNot('price', "the price's start date must be between 2000-01-01 and 2100-01-01")).toBe("The project was saved, but the price was not: the price's start date must be between 2000-01-01 and 2100-01-01.");
    expect(savedButNot('rounding', 'could not save data: Disk full.')).toBe('The project was saved, but the rounding was not: could not save data: Disk full.');
  });
});

describe('laterVersion: where the effect of taking a price version away ends', () => {
  const at = (id: string, effectiveFrom: string, deleted = false): RateVersion => ({ ...rate(100, 'EUR'), id, effectiveFrom, deleted });
  const all = [at('a', '2026-01-01T00:00:00Z'), at('b', '2026-03-09T00:00:00Z'), at('c', '2026-06-01T00:00:00Z'), at('gone', '2026-02-01T00:00:00Z', true)];
  const history = rateHistory(all, 'p');
  const of = (id: string): RateVersion => {
    const v = all.find((r) => r.id === id);
    if (!v) throw new Error(id);
    return v;
  };

  it('is the version that starts next after it, the nearest one and not the newest', () => {
    expect(laterVersion(history, of('a'))?.id).toBe('b');
    expect(laterVersion(history, of('b'))?.id).toBe('c');
  });

  it('is null for the newest version', () => {
    expect(laterVersion(history, of('c'))).toBeNull();
  });

  it('does not count a version that was taken away', () => {
    expect(history.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(laterVersion(history, of('a'))?.id).not.toBe('gone');
  });
});
