import { describe, expect, it } from 'vitest';

import type { SummaryRow } from '../../lib/types';
import { GUIDANCE, centsText, feeText, noAmountReason, pauseNote, periodText, sumRows, summaryText, type SummaryTextInput } from './billingText';

const rows: SummaryRow[] = [
  { taskId: 't1', taskName: 'Logo concepts', day: '2026-03-12', exactSecs: 7500, pauseSecs: 1800, billableSecs: 9900, cents: { USD: 24750 } },
  { taskId: 't2', taskName: 'Guide', day: '2026-03-09', exactSecs: 9000, pauseSecs: 0, billableSecs: 9000, cents: { USD: 22500, EUR: 100 } },
];
const base: SummaryTextInput = { projectName: 'Brand refresh', noAmount: null, fee: '', from: '2026-03-01', to: '2026-03-31', zone: 'Europe/Lisbon', rows, totals: { USD: 47250, EUR: 100 }, hide: false };

describe('r7: rows that do not add up to their total', () => {
  const NOTE = 'Row amounts are rounded; the total is worked out from the exact amounts.';
  const eight = (day: string): SummaryRow => ({ taskId: 't', taskName: 'Guide', day, exactSecs: 900, pauseSecs: 0, billableSecs: 900, cents: { EUR: 833 } });
  const three = { ...base, rows: [eight('2026-03-02'), eight('2026-03-03'), eight('2026-03-04')], totals: { EUR: 2500 } };

  it('the copied text says why, under the total', () => {
    const lines = summaryText(three).split('\n');
    expect(lines.at(-2)).toContain('€25.00');
    expect(lines.at(-1)).toBe(NOTE);
  });

  it('the copied text has no such line where they do add up, or where no amount shows', () => {
    expect(summaryText(base)).not.toContain(NOTE);
    expect(summaryText({ ...three, totals: { EUR: 2499 } })).not.toContain(NOTE);
    expect(summaryText({ ...three, hide: true })).not.toContain(NOTE);
    expect(summaryText({ ...three, noAmount: 'fixedFee' })).not.toContain(NOTE);
  });
});

describe('summary wording', () => {
  it('the guidance label is exactly the one the spec gives', () => {
    expect(GUIDANCE).toBe('For your own guidance. Not an invoice, not a tax document.');
  });
  it('shows pauses as "includes X billable pauses"', () => {
    expect(pauseNote(1800)).toBe('includes 30m billable pauses');
    expect(pauseNote(5400)).toBe('includes 1h 30m billable pauses');
  });
  it('adds rows up and keeps currencies apart', () => {
    expect(sumRows(rows)).toEqual({ exactSecs: 16500, pauseSecs: 1800, billableSecs: 18900 });
    expect(centsText({ USD: 47250, EUR: 100 }, false)).toBe('€1.00 + $472.50');
    expect(centsText({}, false)).toBe('');
    expect(centsText({ USD: 47250 }, true)).toBe('••••');
    expect(centsText({}, true)).toBe('');
  });
  it('knows which projects earn no hourly amount', () => {
    expect(noAmountReason({ billable: true, billingType: 'fixedFee' })).toBe('fixedFee');
    expect(noAmountReason({ billable: false, billingType: 'hourly' })).toBe('notBillable');
    expect(noAmountReason({ billable: true, billingType: 'hourly' })).toBeNull();
    expect(noAmountReason(undefined)).toBeNull();
  });
  it('prints and masks a fee', () => {
    expect(feeText({ fixedFeeCents: 100_000, feeCurrency: 'EUR' }, false)).toBe('€1,000.00');
    expect(feeText({ fixedFeeCents: 100_000, feeCurrency: 'EUR' }, true)).toBe('••••');
    expect(feeText({ fixedFeeCents: null, feeCurrency: null }, false)).toBe('');
  });
  it('names a one-day period once', () => {
    expect(periodText('2026-03-12', '2026-03-12', 'UTC')).toBe('Thu 12 Mar 2026 (UTC)');
    expect(periodText('2026-03-01', '2026-03-31', 'UTC')).toBe('Sun 1 Mar 2026 to Tue 31 Mar 2026 (UTC)');
  });
});

describe('summaryText (the plain text a Copy puts on the clipboard)', () => {
  it('starts with the guidance label, then project and period, one line per row, and a total', () => {
    const lines = summaryText(base).split('\n');
    expect(lines.slice(0, 4)).toEqual([GUIDANCE, 'Project: Brand refresh', 'Period: Sun 1 Mar 2026 to Tue 31 Mar 2026 (Europe/Lisbon)', '']);
    expect(lines[4]).toBe('Thu 12 Mar 2026 | Logo concepts | exact 2h 05m | billable 2h 45m (includes 30m billable pauses) | $247.50');
    expect(lines[5]).toBe('Mon 9 Mar 2026 | Guide | exact 2h 30m | billable 2h 30m | €1.00 + $225.00');
    expect(lines[6]).toBe('Total | exact 4h 35m | billable 5h 15m (includes 30m billable pauses) | €1.00 + $472.50');
  });
  it('names the reference and its status for a saved summary', () => {
    expect(summaryText({ ...base, reference: 'A-001' }).split('\n')[1]).toBe('A-001 (Live)');
    expect(summaryText({ ...base, reference: 'A-002', voided: true }).split('\n')[1]).toBe('A-002 (Voided)');
  });
  it('says a running segment is not included', () => {
    expect(summaryText({ ...base, runningExcluded: true }).split('\n').at(-1)).toBe('A running segment is not included.');
    expect(summaryText(base)).not.toContain('running');
  });
  it('leaves amounts out while earnings are hidden, and says so', () => {
    const text = summaryText({ ...base, hide: true });
    expect(text).not.toMatch(/[$€]/);
    expect(text.split('\n')).toContain('Amounts are left out because Hide earnings is on.');
    expect(text).toContain('billable 2h 45m (includes 30m billable pauses)');
  });
  it('says "Fixed fee: no hourly amount" with the fee, and no amounts', () => {
    const text = summaryText({ ...base, noAmount: 'fixedFee', fee: '€1,000.00', rows: rows.map((r) => ({ ...r, cents: {} })), totals: {} });
    expect(text.split('\n').at(-1)).toBe('Fixed fee: no hourly amount. Fee: €1,000.00.');
    expect(text).not.toContain('$');
    const hidden = summaryText({ ...base, noAmount: 'fixedFee', fee: '€1,000.00', hide: true, totals: {} });
    expect(hidden).toContain('Fixed fee: no hourly amount.');
    expect(hidden).not.toContain('€1,000.00');
  });
  it('has no tax, sent or paid wording of its own', () => {
    expect(summaryText(base).replace(GUIDANCE, '')).not.toMatch(/\b(tax|vat|sent|paid)\b/i);
  });
});
