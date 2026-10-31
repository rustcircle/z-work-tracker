import { describe, expect, it } from 'vitest';

import type { IdleGap } from '../../lib/types';
import { fullTask } from '../../mocks/factories';
import { gapSecs, longRunText, pendingGaps, taskNames, totalSecs } from './awayLogic';

const stamp = { at: '2026-01-01T00:00:00Z', by: 'd' };
const gap = (id: string, taskId: string, start: string, end: string, decision: IdleGap['decision'] = 'pending'): IdleGap => ({ id, segmentId: 's', taskId, deviceId: 'd', start, end, kind: 'idle', decision, decisionStamp: stamp });

describe('time away helpers', () => {
  it('lists only pending gaps, earliest first, and adds them up', () => {
    const gaps = [gap('b', 't', '2026-03-12T14:00:00Z', '2026-03-12T14:10:00Z'), gap('a', 't', '2026-03-12T09:00:00Z', '2026-03-12T09:30:00Z'), gap('c', 't', '2026-03-12T10:00:00Z', '2026-03-12T10:30:00Z', 'drop')];
    expect(pendingGaps(gaps).map((g) => g.id)).toEqual(['a', 'b']);
    expect(totalSecs(pendingGaps(gaps))).toBe(2400);
    expect(gapSecs(gap('x', 't', '2026-03-12T10:00:00Z', '2026-03-12T09:00:00Z'))).toBe(0);
  });

  it('names the tasks briefly', () => {
    const tasks = new Map(['A', 'B', 'C', 'D'].map((n) => [`t${n}`, fullTask({ id: `t${n}`, name: n, projectId: 'p' })] as const));
    const g = (n: string) => gap(`g${n}`, `t${n}`, '2026-03-12T09:00:00Z', '2026-03-12T09:10:00Z');
    expect(taskNames([g('A'), g('A')], tasks)).toBe('A');
    expect(taskNames([g('A'), g('B')], tasks)).toBe('A and B');
    expect(taskNames([g('A'), g('B'), g('C'), g('D')], tasks)).toBe('A, B and 2 more');
    expect(taskNames([gap('x', 'missing', '2026-03-12T09:00:00Z', '2026-03-12T09:10:00Z')], tasks)).toBe('a task');
  });

  it('writes the length of a run in words', () => {
    expect(longRunText(4 * 3600)).toBe('4 h');
    expect(longRunText(4 * 3600 + 5 * 60)).toBe('4 h 05 min');
    expect(longRunText(35 * 60)).toBe('35 min');
    expect(longRunText(-5)).toBe('0 min');
    expect(longRunText(79 * 60 + 59)).toBe('1 h 20 min');
  });
});
