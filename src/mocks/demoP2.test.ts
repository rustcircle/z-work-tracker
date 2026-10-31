import { describe, expect, it } from 'vitest';

import { demoP2State } from './demoSeed';
import { handle } from './ipcMock';
import type { Snapshot } from '../lib/types';

const snap = () => handle(demoP2State(), 'get_snapshot', {}) as Snapshot;

describe('the phase 2 demo seed', () => {
  it('has every feature the screenshots need', () => {
    const s = snap();
    expect(s.tags.map((t) => t.id)).toEqual(['tag-concept', 'tag-revision', 'tag-client-call', 'tag-admin']);
    expect(s.templates).toHaveLength(1);
    expect(s.gaps.map((g) => g.decision).sort()).toEqual(['drop', 'pending', 'thinking']);
    expect(s.pauses).toHaveLength(1);
    expect(s.rawSegments.some((r) => r.manual)).toBe(true);
    expect(s.rawSegments.some((r) => r.corrected && r.reason !== '')).toBe(true);
    expect(s.billing.summaries.map((b) => [b.reference, b.voided])).toEqual([['A-001', false], ['A-002', true]]);
    expect(s.segments.some((x) => x.kind === 'billablePause')).toBe(true);
    expect(s.segments.some((x) => x.kind === 'thinking')).toBe(true);
    const logo = s.tasks.find((t) => t.id === 't-logo');
    expect(logo?.subtasks.map((i) => [i.text, i.secs > 0])).toEqual([['Moodboard', true], ['Sketches', true], ['Final artwork', false]]);
    expect(logo?.unconfirmedSecs).toBe(1800);
    expect(logo?.pauseSecs).toBe(1800);
  });

  it('puts the fixed-fee project at 86% of its fee, a warning and not yet over', () => {
    const p = snap().projects.find((x) => x.id === 'p-print');
    expect(p?.billingType).toBe('fixedFee');
    expect(p?.figures.budget).toEqual({ basis: 'fee', percent: 86, level: 80, needsTargetRate: false });
    expect(p?.figures.effectiveHourlyCents).toBe(Math.floor((100_000 * 3600) / (17.25 * 3600)));
  });
});
