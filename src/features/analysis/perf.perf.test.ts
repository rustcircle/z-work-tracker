// Run with `pnpm test:perf`. Synthetic data at the scale the dashboard must stay responsive at.
// Timings are printed, and the two budgets from the brief are asserted with some headroom.
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { prepare } from './engine';
import { analyze, computeMetrics } from './metrics';
import { evaluate } from './engine';
import { mkSnapshot, params, type Spec } from './testkit';
import { toIso } from '../../lib/tz';

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 50,000 segments across 1,095 days (about 46 a day), 12 projects, 400 tasks, shifts and a client zone. */
function synthetic(live: boolean): { spec: Spec; now: number } {
  const rand = rng(7);
  const start = Date.UTC(2024, 0, 1) / 1000;
  const days = 1095;
  const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, budgetHours: i % 3 === 0 ? 800 : null }));
  const tasks = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, projectId: `p${i % 12}`, state: 'stopped' as const, stoppedAt: toIso(start + days * 86400) }));
  const segs: [string, string, string | null][] = [];
  const perDay = Math.round(50_000 / days);
  for (let d = 0; d < days && segs.length < 50_000; d += 1) {
    let cursor = start + d * 86400 + 6 * 3600 + Math.floor(rand() * 7200);
    for (let k = 0; k < perDay && segs.length < 50_000; k += 1) {
      const len = 120 + Math.floor(rand() * 1800);
      const task = Math.floor(rand() * 400);
      segs.push([`t${task}`, toIso(cursor), toIso(cursor + len)]);
      cursor += len + Math.floor(rand() * 600);
    }
  }
  const nowSec = start + days * 86400 + 3 * 3600;
  if (live) {
    tasks[0] = { id: 't0', projectId: 'p0', state: 'running' as never, stoppedAt: null as never };
    segs.push(['t0', toIso(nowSec - 1800), null]);
  }
  return {
    now: nowSec,
    spec: {
      now: toIso(nowSec),
      projects,
      tasks,
      segs,
      rates: projects.map((p, i) => ({ project: p.id, cents: 4000 + i * 500, currency: i % 2 ? 'USD' : 'EUR' })),
      shifts: [
        { name: 'Morning', start: '08:00', end: '12:00', zone: 'Europe/Lisbon', weekdays: [1, 2, 3, 4, 5], breakMinutes: 15 },
        { name: 'US coverage', start: '09:00', end: '13:00', zone: 'America/New_York', weekdays: [1, 2, 3, 4, 5], breakMinutes: 0 },
      ],
      settings: { myZone: 'Europe/Lisbon', clientZone: 'America/New_York', dailyTargetHours: 6, weeklyTargetHours: 30 },
    },
  };
}

const report = (line: string): void => void process.stdout.write(`${line}\n`);
const ms = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10;

describe('analysis performance at 50k segments', () => {
  const { spec, now } = synthetic(true);
  const snapshot = mkSnapshot(spec);
  const full = params('Europe/Lisbon', { kind: 'custom', anchor: '2024-01-01', from: '2024-01-01', to: '2026-12-31' }, { compare: true });

  it('full analysis of all 50,000 segments (3-year custom range, with comparison)', () => {
    expect(snapshot.segments.length).toBeGreaterThanOrEqual(50_000);
    const t0 = performance.now();
    const m = analyze(snapshot, full, now, 'billable');
    const total = ms(t0);
    report(`PERF full analysis, ${snapshot.segments.length} segments, 3-year range: ${total} ms (volume ${Math.round(m.volume.exact / 3600)} h, sessions ${m.focus.sessions})`);
    expect(m.focus.sessions).toBeGreaterThan(49_000);
    expect(total).toBeLessThan(1500);
  });

  it('prepare and metrics separately, and a typical year range', () => {
    const snap2 = mkSnapshot(spec);
    const t0 = performance.now();
    const prep = prepare(snap2, full);
    const tPrep = ms(t0);
    const t1 = performance.now();
    const ev = evaluate(prep, now);
    const tEval = ms(t1);
    const t2 = performance.now();
    computeMetrics(snap2, full, ev, now, 'billable');
    const tMetrics = ms(t2);
    report(`PERF split: prepare ${tPrep} ms, evaluate ${tEval} ms, metrics ${tMetrics} ms`);
    const t3 = performance.now();
    analyze(snap2, params('Europe/Lisbon', { kind: 'year', anchor: '2025-06-01' }, { compare: true }), now, 'billable');
    report(`PERF full analysis, year range with comparison: ${ms(t3)} ms`);
    const t4 = performance.now();
    analyze(snap2, params('Europe/Lisbon', { kind: 'week', anchor: '2026-12-30' }, { compare: true }), now, 'billable');
    report(`PERF full analysis, week range with comparison: ${ms(t4)} ms`);
  });

  it('a tick (new clock value, running segment) after the first run', () => {
    analyze(snapshot, full, now, 'billable');
    const times: number[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const t0 = performance.now();
      analyze(snapshot, full, now + i * 10, 'billable');
      times.push(ms(t0));
    }
    const sorted = [...times].sort((a, b) => a - b);
    report(`PERF tick update, 3-year range: median ${sorted[5]} ms, max ${sorted[9]} ms`);
    const week = params('Europe/Lisbon', { kind: 'week', anchor: '2026-12-31' });
    analyze(snapshot, week, now, 'billable');
    const t0 = performance.now();
    analyze(snapshot, week, now + 10, 'billable');
    report(`PERF tick update, week range: ${ms(t0)} ms`);
    expect(sorted[5] as number).toBeLessThan(50);
  });
});
