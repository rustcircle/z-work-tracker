import { describe, expect, it } from 'vitest';

import type { Project, RateVersion } from '../../lib/types';
import { parseBudget, parsePrice, rateAt, rateHistory, rateText, validateProjectName } from './projectLogic';

const stamp = { at: '', by: '' };
const rate = (id: string, from: string, cents: number | null): RateVersion => ({ id, projectId: 'p', effectiveFrom: from, rateCents: cents, currency: 'EUR', deleted: false, stamp });
const proj = (id: string, name: string): Project => ({ id, name, color: '#000000', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '', hasTasks: false });

describe('parsePrice', () => {
  it('reads whole and decimal prices to exact cents', () => {
    expect(parsePrice('90')).toEqual({ ok: true, cents: 9000 });
    expect(parsePrice('90.5')).toEqual({ ok: true, cents: 9050 });
    expect(parsePrice('12,34')).toEqual({ ok: true, cents: 1234 });
    expect(parsePrice('€ 60')).toEqual({ ok: true, cents: 6000 });
    expect(parsePrice('10000')).toEqual({ ok: true, cents: 1_000_000 });
  });
  it('keeps blank (no rate) different from zero', () => {
    expect(parsePrice('')).toEqual({ ok: true, cents: null });
    expect(parsePrice('  ')).toEqual({ ok: true, cents: null });
    expect(parsePrice('0')).toEqual({ ok: true, cents: 0 });
  });
  it('rejects bad input', () => {
    for (const bad of ['abc', '-5', '1.234', '10000.01', '1e3', '12345678']) expect(parsePrice(bad).ok).toBe(false);
  });
});

describe('project rules', () => {
  it('names must be present and unique, ignoring case and the project itself', () => {
    const all = [proj('a', 'Website'), proj('b', 'Brand')];
    expect(validateProjectName('', all, null)).toBe('Enter a project name.');
    expect(validateProjectName(' website ', all, null)).toContain('already exists');
    expect(validateProjectName('Website', all, 'a')).toBeNull();
    expect(validateProjectName('New', all, null)).toBeNull();
  });
  it('budget is optional and numeric', () => {
    expect(parseBudget('')).toEqual({ ok: true, hours: null });
    expect(parseBudget('40')).toEqual({ ok: true, hours: 40 });
    expect(parseBudget('-1').ok).toBe(false);
    expect(parseBudget('x').ok).toBe(false);
  });
  it('rate history is newest first and rateAt finds the version in force', () => {
    const rates = [rate('1', '2026-01-01T00:00:00Z', 6000), rate('2', '2026-03-09T00:00:00Z', 9000), rate('3', '2026-06-01T00:00:00Z', null)];
    expect(rateHistory(rates, 'p').map((r) => r.id)).toEqual(['3', '2', '1']);
    expect(rateAt(rates, 'p', Date.parse('2026-03-10T00:00:00Z') / 1000)?.rateCents).toBe(9000);
    expect(rateAt(rates, 'p', Date.parse('2025-12-01T00:00:00Z') / 1000)).toBeNull();
    expect(rateText(rates[1] ?? null)).toBe('€90.00/h');
    expect(rateText(rates[2] ?? null)).toBe('No rate set');
    expect(rateText(null)).toBe('No rate set');
    expect(rateText(rates[1] ?? null, '••••')).toBe('••••/h');
  });
});
