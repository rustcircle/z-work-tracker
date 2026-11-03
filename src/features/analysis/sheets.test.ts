import { afterEach, describe, expect, it } from 'vitest';

import { MASK } from '../../lib/billing';
import { glossaryEntry, GLOSSARY, searchGlossary } from './glossary';
import { buildInsights } from './insights';
import { analyze } from './metrics';
import { dayNum, defaultRange, periodOf, previousRange, shiftRange, spanDays } from './range';
import { buildAnalyticsSheets } from './sheets';
import { fmtClock, fmtHM, fmtHMS, fmtPct, fmtSignedPct } from './format';
import { mkSnapshot, nowOf, params, type Spec } from './testkit';
import { publishAnalysisView } from './view';
import { NO_FILTERS } from './engine';

const SPEC: Spec = {
  now: '2026-03-09T12:00:00Z',
  projects: [{ id: 'pa', name: 'Alpha' }, { id: 'pb', name: 'Beta' }, { id: 'pc', name: 'Admin', billable: false }],
  tasks: [
    { id: 't1', projectId: 'pa', state: 'stopped', stoppedAt: '2026-03-05T14:10:00Z' },
    { id: 't2', projectId: 'pa' },
    { id: 't3', projectId: 'pb', state: 'paused' },
    { id: 't4', projectId: 'pc' },
  ],
  segs: [
    ['t1', '2026-03-02T09:00:00Z', '2026-03-02T10:30:00Z'],
    ['t1', '2026-03-02T10:40:00Z', '2026-03-02T11:20:00Z'],
    ['t3', '2026-03-02T14:00:00Z', '2026-03-02T15:00:00Z'],
    ['t1', '2026-03-03T08:00:00Z', '2026-03-03T12:00:00Z'],
    ['t2', '2026-03-04T23:00:00Z', '2026-03-05T01:00:00Z'],
    ['t1', '2026-03-05T13:00:00Z', '2026-03-05T13:10:00Z'],
    ['t4', '2026-03-05T13:10:00Z', '2026-03-05T13:30:00Z'],
    ['t3', '2026-03-07T10:00:00Z', '2026-03-07T10:20:00Z'],
  ],
  rates: [{ project: 'pa', cents: 6000, currency: 'EUR' }],
  settings: { dailyTargetHours: 3, weeklyTargetHours: 12 },
};
const NOW = nowOf(SPEC.now);
const view = { range: { kind: 'week', anchor: '2026-03-04' } as const, filters: NO_FILTERS, basis: 'billable' as const, compare: false };

afterEach(() => publishAnalysisView(null));

describe('buildAnalyticsSheets', () => {
  const sheets = buildAnalyticsSheets(mkSnapshot(SPEC), 'UTC', NOW, view);
  const by = (name: string) => sheets.find((s) => s.name === name);

  it('returns the six required sheets with valid, unique names and rectangular rows', () => {
    expect(sheets.map((s) => s.name)).toEqual(['KPI summary', 'Bands', 'Projects', 'Weekdays', 'Earnings by period', 'Earnings by project']);
    for (const s of sheets) {
      expect(s.name.length).toBeLessThanOrEqual(31);
      for (const row of s.rows) expect(row).toHaveLength(s.columns.length);
      expect(s.title).toContain('2 Mar – 8 Mar 2026');
      expect(s.title).toContain('UTC');
    }
  });

  it('KPI figures match the screen: durations in seconds', () => {
    const kpi = by('KPI summary');
    const row = (label: string) => kpi?.rows.find((r) => String(r[0]).startsWith(label));
    expect(row('Total time (Exact)')?.[1]).toBe(36000);
    expect(row('Total time (Billable)')?.[1]).toBe(37800);
    expect(row('Rounding adjustment')?.[1]).toBe(1800);
    expect(row('Active days')?.[2]).toBe(5);
    expect(row('Sessions')?.[2]).toBe(8);
    expect(row('Median session')?.[1]).toBe(3000);
    expect(row('Context switches')?.[2]).toBe(2);
    expect(row('Typical start')?.[0]).toBe('Typical start: 10:00 (middle half 09:00-13:00)');
    expect(kpi?.columns.map((c) => c.kind)).toEqual(['text', 'duration', 'int', 'percent', 'text', 'text']);
  });

  it('bands, projects and weekdays', () => {
    const bands = by('Bands')?.rows.filter((r) => r[0] === 'Band' && r[2] === 'All projects');
    expect(bands?.map((r) => r[3])).toEqual([3600, 23400, 5400, 3600]);
    const projects = by('Projects')?.rows;
    expect(projects?.[0]?.slice(0, 3)).toEqual(['Alpha', 30000, 30600]);
    expect(projects?.find((r) => r[0] === 'Beta')?.[9]).toBe('No rate set');
    expect(projects?.find((r) => r[0] === 'Admin')?.[9]).toBe('Not billable');
    const wd = by('Weekdays')?.rows;
    expect(wd?.map((r) => r[1])).toEqual([11400, 14400, 3600, 5400, 0, 1200, 0]);
  });

  it('earnings are exact cents, marked as prices, and everything else is price-free', () => {
    const e = by('Earnings by period');
    expect(e?.containsPrices).toBe(true);
    expect(e?.rows.at(-1)).toEqual(['Total', 37800, 36000, 51000, null]);
    const cents = e?.rows.slice(0, -1).reduce((n, r) => n + Number(r[3] ?? 0), 0);
    expect(cents).toBe(51000 - 0);
    expect(by('Earnings by project')?.containsPrices).toBe(true);
    for (const s of sheets.filter((x) => !x.containsPrices)) expect(s.columns.some((c) => c.kind === 'eur' || c.kind === 'usd')).toBe(false);
  });

  it('r7: the earnings sheet says its rows can differ from its total', () => {
    expect(by('Earnings by period')?.title).toContain('Row amounts are rounded; the total is worked out from the exact amounts.');
  });

  it('shift sheet appears only when shifts exist', () => {
    expect(by('Shifts')).toBeUndefined();
    const withShift = buildAnalyticsSheets(mkSnapshot({ ...SPEC, shifts: [{ name: 'Morning', start: '09:00', end: '13:00', breakMinutes: 30 }] }), 'UTC', NOW, view);
    const s = withShift.find((x) => x.name === 'Shifts');
    expect(s?.rows.at(-1)?.[0]).toBe('Outside any shift');
    expect(s?.containsPrices).toBe(false);
  });

  it('defaults to all logged history, and follows the view the tab published', () => {
    const all = buildAnalyticsSheets(mkSnapshot(SPEC), 'UTC', NOW);
    expect(all[0]?.title).toContain('2 Mar – 9 Mar 2026');
    expect(all[0]?.rows[0]?.[1]).toBe(36000);
    publishAnalysisView({ ...view, range: { kind: 'day', anchor: '2026-03-03' } });
    const day = buildAnalyticsSheets(mkSnapshot(SPEC), 'UTC', NOW);
    expect(day[0]?.rows[0]?.[1]).toBe(14400);
  });

  it('an empty snapshot still builds sheets without NaN', () => {
    const empty = buildAnalyticsSheets(mkSnapshot({ now: SPEC.now }), 'UTC', NOW);
    expect(empty.length).toBeGreaterThanOrEqual(4);
    for (const s of empty) for (const row of s.rows) for (const c of row) if (typeof c === 'number') expect(Number.isFinite(c)).toBe(true);
  });
});

describe('insights and glossary', () => {
  const snap = mkSnapshot(SPEC);
  const m = analyze(snap, params('UTC', view.range, { compare: false }), NOW, 'billable');
  const names = new Map(snap.projects.map((p) => [p.id, p.name]));

  it('every sentence is traceable to glossary metrics', () => {
    const list = buildInsights(m, { hideEarnings: false, names });
    expect(list.length).toBeGreaterThan(8);
    for (const i of list) {
      expect(i.metrics.length).toBeGreaterThan(0);
      for (const id of i.metrics) expect(glossaryEntry(id), `${i.id} -> ${id}`).toBeDefined();
    }
    expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
  });

  it('is deterministic and states the figures', () => {
    const a = buildInsights(m, { hideEarnings: false, names });
    expect(buildInsights(m, { hideEarnings: false, names })).toEqual(a);
    expect(a.find((i) => i.id === 'volume')?.text).toBe('You logged 10h 30m (billable) in 2 Mar – 8 Mar 2026.');
    expect(a.find((i) => i.id === 'band')?.text).toBe('Morning is the busiest band: 65% of logged time (6h 30m).');
    expect(a.find((i) => i.id === 'earnings')?.text).toBe('Earnings from Billable time: €510.00.');
    expect(a.find((i) => i.id === 'weekly')?.text).toBe("This week's target is 12h 00m; 10h 00m is logged (83%).");
  });

  it('hiding earnings masks every amount', () => {
    const hidden = buildInsights(m, { hideEarnings: true, names });
    expect(hidden.find((i) => i.id === 'earnings')?.text).toContain(MASK);
    expect(hidden.map((i) => i.text).join(' ')).not.toMatch(/€|\$/);
  });

  it('has nothing to say about an empty period', () => {
    const empty = analyze(mkSnapshot({ now: SPEC.now }), params('UTC', view.range), NOW, 'billable');
    expect(buildInsights(empty, { hideEarnings: false, names })).toEqual([]);
  });

  it('the glossary has unique ids, states Exact or Billable for each entry, and is searchable', () => {
    expect(new Set(GLOSSARY.map((e) => e.id)).size).toBe(GLOSSARY.length);
    for (const e of GLOSSARY) {
      expect(e.definition.length).toBeGreaterThan(20);
      expect(['Exact', 'Billable', 'Follows the Basis switch', 'Neither']).toContain(e.basis);
    }
    expect(searchGlossary('repeated hour').map((e) => e.id)).toContain('time.hours');
    expect(searchGlossary('')).toHaveLength(GLOSSARY.length);
    expect(searchGlossary('zzzzzz')).toEqual([]);
  });
});

describe('periods', () => {
  it('weeks start on Monday, months and quarters follow the calendar', () => {
    expect(spanDays({ kind: 'week', anchor: '2026-03-08' })).toEqual({ fromDay: '2026-03-02', toDay: '2026-03-08' });
    expect(spanDays({ kind: 'month', anchor: '2026-02-14' })).toEqual({ fromDay: '2026-02-01', toDay: '2026-02-28' });
    expect(spanDays({ kind: 'quarter', anchor: '2026-05-01' })).toEqual({ fromDay: '2026-04-01', toDay: '2026-06-30' });
    expect(spanDays({ kind: 'year', anchor: '2026-05-01' })).toEqual({ fromDay: '2026-01-01', toDay: '2026-12-31' });
    expect(spanDays({ kind: 'custom', anchor: 'x', from: '2026-03-10', to: '2026-03-01' })).toEqual({ fromDay: '2026-03-01', toDay: '2026-03-10' });
  });

  it('prev and next, including across year ends and for custom spans', () => {
    expect(shiftRange({ kind: 'month', anchor: '2026-01-15' }, -1).anchor).toBe('2025-12-01');
    expect(spanDays(shiftRange({ kind: 'quarter', anchor: '2026-02-01' }, -1))).toEqual({ fromDay: '2025-10-01', toDay: '2025-12-31' });
    expect(shiftRange({ kind: 'week', anchor: '2026-03-04' }, 1).anchor).toBe('2026-03-11');
    expect(previousRange({ kind: 'custom', anchor: '2026-03-10', from: '2026-03-10', to: '2026-03-19' })).toMatchObject({ from: '2026-02-28', to: '2026-03-09' });
    expect(defaultRange('2026-03-12')).toEqual({ kind: 'week', anchor: '2026-03-12' });
  });

  it('a period has the real length on DST days', () => {
    const p = periodOf({ kind: 'day', anchor: '2026-03-29' }, 'Europe/Lisbon');
    expect(p.to - p.from).toBe(23 * 3600);
    expect(p.days).toBe(1);
    expect(periodOf({ kind: 'week', anchor: '2026-03-29' }, 'UTC').label).toBe('23 Mar – 29 Mar 2026');
    expect(dayNum('1970-01-02')).toBe(1);
  });

  it('formats', () => {
    expect(fmtHM(7500)).toBe('2h 05m');
    expect(fmtHM(30)).toBe('1m');
    expect(fmtHMS(7513)).toBe('2:05:13');
    expect(fmtPct(0.256)).toBe('26%');
    expect(fmtSignedPct(-0.9)).toBe('-90%');
    expect(fmtClock(1500)).toBe('25:00');
  });
});
