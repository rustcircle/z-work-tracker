// A selected Excel export gets its analysis sheets from the Rust core (analytics.rs), and a whole-period
// one from this code. The fixture holds the core's inputs and its figures, so here the same inputs must
// give the same figures. The Rust test keeps the fixture current.
import { describe, expect, it } from 'vitest';

import parity from '../../../fixtures/analytics-parity.json';
import type { AnalyticsSheet, Snapshot } from '../../lib/types';
import { NO_FILTERS } from './engine';
import { buildAnalyticsSheets } from './sheets';

type Case = (typeof parity.cases)[number];

// A case the UI doesn't follow yet says why in `tsSkip` (subtask tags, until A2), and is left out here until then.
const cases = parity.cases.filter((c) => !('tsSkip' in c));

const TOLERANCE = 1e-6;

function compare(where: string, got: unknown, want: unknown): void {
  if (typeof got === 'number' && typeof want === 'number') {
    expect(Math.abs(got - want), `${where}: ${got} against ${want}`).toBeLessThanOrEqual(TOLERANCE);
    return;
  }
  expect(got, where).toEqual(want);
}

function sheetsFor(c: Case): AnalyticsSheet[] {
  const range = { kind: 'custom' as const, anchor: c.from, from: c.from, to: c.to };
  return buildAnalyticsSheets(c.snapshot as unknown as Snapshot, c.zone, c.now, { range, filters: NO_FILTERS, basis: 'billable', compare: false });
}

describe('the UI and the core give the same analysis sheets', () => {
  it('covers each kind of period and a selection', () => {
    expect(parity.cases.map((c) => c.selection)).toContain(true);
    expect(parity.cases.length).toBeGreaterThan(5);
  });

  it.each(cases)('$name', (c) => {
    const got = sheetsFor(c);
    const want = c.sheets as unknown as AnalyticsSheet[];
    expect(got.map((s) => s.name)).toEqual(want.map((s) => s.name));
    got.forEach((sheet, i) => {
      const other = want[i] as AnalyticsSheet;
      // A selection's titles say so, on top of what the screen's titles say.
      expect(other.title.replace('Selected entries, ', ''), sheet.name).toBe(sheet.title);
      expect(sheet.columns).toEqual(other.columns);
      expect(sheet.containsPrices).toBe(other.containsPrices);
      expect(sheet.rows.map((r) => r[0]), `${sheet.name} rows`).toEqual(other.rows.map((r) => r[0]));
      sheet.rows.forEach((row, r) => {
        row.forEach((cell, col) => compare(`${sheet.name} row ${r} (${String(row[0])}) column ${col}`, cell, other.rows[r]?.[col]));
      });
    });
  });
});
