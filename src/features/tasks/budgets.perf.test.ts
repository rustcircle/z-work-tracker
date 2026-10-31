// Run with `pnpm test:perf`. These budgets compare two ways of doing the same work on the same machine in
// the same second, so a slow or busy CI runner moves both sides and the ratio stands. Absolute times are
// only printed. The clock's budgets count instead of timing: see src/app/store.test.tsx and
// src/features/analysis/analysisTick.test.tsx.
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import type { Segment } from '../../lib/types';
import { piecesOf } from './taskFigures';

const report = (line: string): void => void process.stdout.write(`${line}\n`);

function median(run: () => void, n = 9): number {
  const times: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[Math.floor(n / 2)] as number;
}

describe('budgets at 50k segments', () => {
  const segments: Segment[] = Array.from({ length: 50_000 }, (_, i) => ({
    id: `s${i}`,
    taskId: `t${i % 400}`,
    deviceId: 'd',
    start: '2026-03-01T09:00:00Z',
    end: '2026-03-01T09:10:00Z',
    provisionalEnd: null,
  }));
  const cards = Array.from({ length: 400 }, (_, i) => `t${i}`);

  it('grouping pieces for 400 cards beats filtering for each by at least 10 times', () => {
    let sink = 0;
    const filtering = median(() => {
      for (const id of cards) sink += segments.filter((s) => s.taskId === id).length;
    }, 5);
    const grouping = median(() => {
      // A new array each run, as a new snapshot is, so the grouping is really done each time.
      const fresh = segments.slice();
      for (const id of cards) sink += piecesOf(fresh, id).length;
    }, 5);
    report(`PERF task cards: filtering ${filtering.toFixed(1)} ms, grouping ${grouping.toFixed(1)} ms`);
    expect(sink).toBeGreaterThan(0);
    expect(grouping * 10).toBeLessThan(filtering);
  });

});
