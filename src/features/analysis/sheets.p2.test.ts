// The phase 2 rows of the Excel analytics sheets. The export's first sheet is built by Rust and is not touched here.
import { afterEach, describe, expect, it } from 'vitest';

import { NO_FILTERS } from './engine';
import { buildAnalyticsSheets } from './sheets';
import { mkSnapshot, nowOf, type Spec } from './testkit';
import { publishAnalysisView } from './view';

const SPEC: Spec = {
  now: '2026-03-09T12:00:00Z',
  projects: [
    { id: 'pa', name: 'Alpha' },
    { id: 'pf', name: 'Print run', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR', figures: { exactSecs: 7200, pauseSecs: 0, billableSecs: 7200, thinkingSecs: 0, effectiveHourlyCents: 50_000, timeValueCents: {}, budget: null } },
  ],
  tags: [{ id: 'a', name: 'Concept' }, { id: 'b', name: 'Revision' }],
  tasks: [
    { id: 't1', projectId: 'pa', tags: ['a', 'b'] },
    { id: 't3', projectId: 'pf', tags: ['b'] },
  ],
  rates: [{ project: 'pa', cents: 6000, currency: 'EUR' }],
  // t1: work 09:00-10:00, billable pause 10:00-10:30, work 10:30-11:00 (Exact 5400, Billable 7200); t3: 2 h of fixed-fee work.
  segs: [
    ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'],
    ['t1', '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z', { kind: 'billablePause' }],
    ['t1', '2026-03-02T10:30:00Z', '2026-03-02T11:00:00Z'],
    ['t3', '2026-03-03T09:00:00Z', '2026-03-03T11:00:00Z'],
  ],
};
const view = { range: { kind: 'week', anchor: '2026-03-04' } as const, filters: NO_FILTERS, basis: 'billable' as const, compare: false };

afterEach(() => publishAnalysisView(null));

describe('phase 2 sheet rows', () => {
  const sheets = buildAnalyticsSheets(mkSnapshot(SPEC), 'UTC', nowOf(SPEC.now), view);
  const by = (name: string) => sheets.find((s) => s.name === name);

  it('the KPI summary lists billable pauses apart from Exact and the rounding adjustment includes them', () => {
    const kpi = by('KPI summary');
    const row = (label: string) => kpi?.rows.find((r) => String(r[0]).startsWith(label));
    // Exact 5400 + 7200; Billable 7200 + 7200.
    expect(row('Total time (Exact)')?.[1]).toBe(12600);
    expect(row('Total time (Billable)')?.[1]).toBe(14400);
    expect(row('Billable pauses')?.[1]).toBe(1800);
    expect(row('Billable pauses')?.[4]).toBe('Billable');
    expect(row('Rounding adjustment')?.[1]).toBe(1800);
  });

  it('a Tags sheet notes that rows overlap and carries no total row', () => {
    const tags = by('Tags');
    expect(tags?.title).toContain('counts fully in each');
    expect(tags?.rows.map((r) => r[0])).toEqual(['Revision', 'Concept']);
    // Revision: t1 (Billable 7200, Exact 5400) and t3 (7200, 7200). Concept: t1 only.
    expect(tags?.rows[0]).toEqual(['Revision', 12600, 14400, 1, 2]);
    expect(tags?.rows[1]?.[1]).toBe(5400);
    expect(tags?.rows.some((r) => String(r[0]).toLowerCase().includes('total'))).toBe(false);
    expect(tags?.containsPrices).toBe(false);
  });

  it('a fixed-fee project says "Fixed fee" instead of "No rate set"', () => {
    const projects = by('Projects');
    const col = projects?.columns.findIndex((c) => c.header === 'Rate') ?? -1;
    expect(projects?.rows.find((r) => r[0] === 'Print run')?.[col]).toBe('Fixed fee');
    expect(projects?.rows.find((r) => r[0] === 'Alpha')?.[col]).toBe('');
    const earn = by('Earnings by project');
    const rate = earn?.columns.findIndex((c) => c.header === 'Rate') ?? -1;
    const eff = earn?.columns.findIndex((c) => c.header === 'Effective hourly rate (fixed fee)') ?? -1;
    const print = earn?.rows.find((r) => r[0] === 'Print run');
    expect(print?.[rate]).toBe('Fixed fee');
    expect(print?.[eff]).toBe('€500.00 per hour');
    expect(earn?.containsPrices).toBe(true);
    expect(print?.[earn?.columns.findIndex((c) => c.header === 'Earnings EUR') ?? -1]).toBeNull();
  });

  it('the Rust-built first sheet is not part of these analytics sheets', () => {
    expect(sheets.map((s) => s.name)).not.toContain('Summary');
    expect(sheets[0]?.name).toBe('KPI summary');
  });
});
