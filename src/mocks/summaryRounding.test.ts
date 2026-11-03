// The billing summaries of the mock backend against the rules of `summary.rs`, with the steps it runs from the same fixture.
import { describe, expect, it } from 'vitest';

import billing from '../../fixtures/billing-fixtures.json';
import { parseIso } from '../lib/tz';
import { DEVICE_ID, emptyState, handle, type MockState } from './ipcMock';
import { computePieces, rowsOf, type MockSegment } from './pieces';
import { summaryCsv } from './summaryCsv';
import type { BillingSummary, Snapshot, SummaryPreview, SummaryRow, WithId } from '../lib/types';

const call = <T,>(s: MockState, cmd: string, a: Record<string, unknown> = {}) => handle(s, cmd, a) as T;
const NOTE = 'Row amounts are rounded; the total is worked out from the exact amounts.';

function world(rates: readonly { from: string; cents: number | null; currency: string }[]) {
  const s = emptyState('2026-06-01T00:00:00Z');
  const { id: projectId } = call<WithId>(s, 'create_project', { input: { name: 'P', color: '#2563EB', billable: true, budgetHours: null, clientZone: null } });
  for (const r of rates) call(s, 'set_rate', { input: { projectId, rateCents: r.cents, currency: r.currency, effectiveFrom: r.from, confirmRetroactive: true } });
  call(s, 'set_rounding', { input: { projectId: null, effectiveFrom: '2000-01-01', incrementMinutes: 15, method: 'up', confirmRetroactive: true }, today: '2026-06-01' });
  const { id: taskId } = call<WithId>(s, 'create_task', { input: { name: 'T', projectId, description: null, tags: ['tag-admin'] } });
  return { s, projectId, taskId };
}

const add = (s: MockState, taskId: string, id: string, start: string, end: string): void => {
  s.segments.push({ id, taskId, deviceId: DEVICE_ID, start, end, provisionalEnd: null });
};

const summariesOf = (s: MockState): BillingSummary[] => call<Snapshot>(s, 'get_snapshot').billing.summaries;

interface Step {
  rule?: { from: string; minutes: number; method: string };
  segments?: string[][];
  corrected?: string[][];
  pauses?: string[][];
  void?: number[];
  zone?: string;
  from?: string;
  to?: string;
  rows: { day: string; exact: number; pause?: number; billable: number; amounts: Record<string, number> }[];
  totals: Record<string, number>;
  partlyBilled: number;
  create: boolean;
  asOlderBuild?: { billable: number; amounts: Record<string, number> };
}

describe('the steps of the shared billing fixtures', () => {
  it.each(billing.summaries)('$name', (c) => {
    const { s, projectId, taskId } = world(c.rates);
    const made: string[] = [];
    (c.steps as Step[]).forEach((step, i) => {
      if (step.rule) call(s, 'set_rounding', { input: { projectId: null, effectiveFrom: step.rule.from, incrementMinutes: step.rule.minutes, method: step.rule.method, confirmRetroactive: true }, today: '2026-06-01' });
      for (const [id, start, end] of step.corrected ?? []) {
        (s.segments.find((x) => x.id === id) as MockSegment).edit = { start: start as string, end: end as string, voided: false, reason: 'corrected on another device' };
      }
      (step.pauses ?? []).forEach((pair, n) => s.pauses.push({ id: `p${i}-${n}`, taskId, start: pair[0] as string, end: pair[1] as string, note: '', deleted: false, stamp: { at: '2026-01-01T00:00:00Z', by: 'x' } }));
      (step.segments ?? []).forEach((pair, n) => add(s, taskId, `s${i}-${n}`, pair[0] as string, pair[1] as string));
      for (const v of step.void ?? []) call(s, 'void_summary', { id: made[v] });
      const request = { projectId, from: step.from ?? '2026-01-01', to: step.to ?? '2026-12-31', zone: step.zone ?? 'UTC' };
      const preview = call<SummaryPreview>(s, 'summary_preview', { request });
      expect(preview.rows.map((r) => ({ day: r.day, exact: r.exactSecs, billable: r.billableSecs, amounts: r.cents }))).toEqual(step.rows.map(({ pause: _pause, ...row }) => row));
      expect(preview.rows.map((r) => r.pauseSecs)).toEqual(step.rows.map((r) => r.pause ?? 0));
      expect(preview.totals).toEqual(step.totals);
      expect(preview.partlyBilledRows).toBe(step.partlyBilled);
      if (step.create) {
        const { id } = call<WithId>(s, 'create_summary', { request });
        if (step.asOlderBuild) {
          const b = s.summaries.find((x) => x.id === id) as BillingSummary;
          (b.rows[0] as SummaryRow).billableSecs = step.asOlderBuild.billable;
          (b.rows[0] as SummaryRow).cents = step.asOlderBuild.amounts;
          b.totals = step.asOlderBuild.amounts;
        }
        made.push(id);
      }
    });
    const billed = summariesOf(s).filter((b) => !b.voided).flatMap((b) => b.rows).reduce((n, r) => n + r.billableSecs, 0);
    expect(billed).toBe(c.billed);
    const now = call<Snapshot>(s, 'get_snapshot');
    const pieces = computePieces({ segments: s.segments, gaps: [], pauses: s.pauses, liveTasks: new Set(now.tasks.map((t) => t.id)), summaries: s.summaries }, (x) => parseIso(x.end ?? x.start));
    const report = rowsOf({ projects: now.projects, tasks: now.tasks, rates: now.rates, rounding: now.rounding }, pieces, (c as { reportZone?: string }).reportZone ?? 'UTC');
    expect(report.reduce((n, r) => n + r.billableSecs, 0)).toBe(c.report);
  });
});

describe('a summary in another zone', () => {
  it('r8: an empty segment on it holds no share', () => {
    const { s, projectId, taskId } = world([{ from: '2026-01-01T00:00:00Z', cents: 6000, currency: 'EUR' }]);
    // 2 March in UTC. In New York the 20 minutes are on 1 March, and the empty segment is on 2 March.
    add(s, taskId, 'a', '2026-03-02T04:30:00Z', '2026-03-02T04:50:00Z');
    add(s, taskId, 'empty', '2026-03-02T06:00:00Z', '2026-03-02T06:00:00Z');
    call(s, 'create_summary', { request: { projectId, from: '2026-03-01', to: '2026-03-31', zone: 'UTC' } });
    add(s, taskId, 'b', '2026-03-02T03:00:00Z', '2026-03-02T03:20:00Z');
    add(s, taskId, 'c', '2026-03-02T07:00:00Z', '2026-03-02T07:20:00Z');
    const preview = call<SummaryPreview>(s, 'summary_preview', { request: { projectId, from: '2026-03-01', to: '2026-03-31', zone: 'America/New_York' } });
    // 1 March: 40 minutes round to 45, and 30 are held. 2 March: 20 minutes round to 30, and nothing is held.
    expect(preview.rows.map((r) => r.billableSecs)).toEqual([900, 1800]);
  });
});

describe('a summary of forty rows of 15 minutes at 33.33 an hour', () => {
  function forty() {
    const { s, projectId, taskId } = world([{ from: '2026-01-01T00:00:00Z', cents: 3333, currency: 'EUR' }]);
    for (let i = 0; i < 40; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10);
      add(s, taskId, `d${i}`, `${day}T09:00:00Z`, `${day}T09:15:00Z`);
    }
    return { s, request: { projectId, from: '2026-01-01', to: '2026-12-31', zone: 'UTC' } };
  }

  it('r7: totals 333.30, and its rows keep showing 8.33', () => {
    const { s, request } = forty();
    const preview = call<SummaryPreview>(s, 'summary_preview', { request });
    expect(preview.rows.every((r) => r.cents.EUR === 833)).toBe(true);
    expect(preview.totals).toEqual({ EUR: 33330 });
  });

  it('r7: its CSV says why its rows do not add up, unless amounts are hidden', () => {
    const { s, request } = forty();
    call(s, 'create_summary', { request });
    const b = summariesOf(s)[0] as BillingSummary;
    const csv = summaryCsv(b, 'P', false);
    expect(csv).toContain(',333.30\r\n');
    expect(csv).toContain(NOTE);
    expect(summaryCsv(b, 'P', true)).not.toContain(NOTE);
  });

  it('r7: a summary whose rows add up has no such line', () => {
    const { s, projectId, taskId } = world([{ from: '2026-01-01T00:00:00Z', cents: 6000, currency: 'EUR' }]);
    add(s, taskId, 'a', '2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z');
    call(s, 'create_summary', { request: { projectId, from: '2026-03-01', to: '2026-03-31', zone: 'UTC' } });
    expect(summaryCsv(summariesOf(s)[0] as BillingSummary, 'P', false)).not.toContain(NOTE);
  });
});
