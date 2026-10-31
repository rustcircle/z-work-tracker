// Grouping pieces per snapshot must hand each card what filtering would, and a task with nothing open
// must read the same at any time, which is why its card can leave the clock alone.
import { describe, expect, it } from 'vitest';

import { fullTask } from '../../mocks/factories';
import type { Segment } from '../../lib/types';
import { hasOpenPiece, piecesOf, taskTime } from './taskFigures';

const seg = (id: string, taskId: string, start: string, end: string | null, provisionalEnd: string | null = null): Segment => ({ id, taskId, deviceId: 'd', start, end, provisionalEnd });

const SEGMENTS: Segment[] = [
  seg('a', 't1', '2026-03-01T09:00:00Z', '2026-03-01T09:10:00Z'),
  seg('b', 't2', '2026-03-01T09:05:00Z', '2026-03-01T09:06:00Z'),
  seg('c', 't1', '2026-03-01T10:00:00Z', '2026-03-01T10:10:00Z'),
  seg('d', 't3', '2026-03-01T11:00:00Z', null, '2026-03-01T11:30:00Z'),
  seg('e', 't4', '2026-03-01T12:00:00Z', null),
];

describe('piecesOf', () => {
  it('gives the same pieces in the same order as filtering, for every task', () => {
    for (const id of ['t1', 't2', 't3', 't4', 'none']) {
      expect(piecesOf(SEGMENTS, id)).toEqual(SEGMENTS.filter((s) => s.taskId === id));
    }
  });

  it('gives a stable array for one snapshot, and a new snapshot is grouped afresh', () => {
    expect(piecesOf(SEGMENTS, 't1')).toBe(piecesOf(SEGMENTS, 't1'));
    const next = [...SEGMENTS, seg('f', 't1', '2026-03-01T13:00:00Z', '2026-03-01T13:01:00Z')];
    expect(piecesOf(next, 't1').map((s) => s.id)).toEqual(['a', 'c', 'f']);
    expect(piecesOf(SEGMENTS, 't1').map((s) => s.id)).toEqual(['a', 'c']);
  });
});

describe('hasOpenPiece', () => {
  it('counts only a piece growing here: a device elsewhere has a provisional end', () => {
    expect(hasOpenPiece(piecesOf(SEGMENTS, 't1'))).toBe(false);
    expect(hasOpenPiece(piecesOf(SEGMENTS, 't3'))).toBe(false);
    expect(hasOpenPiece(piecesOf(SEGMENTS, 't4'))).toBe(true);
  });

  it('a task without one reads the same at any time', () => {
    const snap = Date.parse('2026-03-01T14:00:00Z') / 1000;
    for (const id of ['t1', 't2', 't3']) {
      const task = fullTask({ id, projectId: 'p', unbilledSecs: 60 });
      const pieces = piecesOf(SEGMENTS, id);
      expect(taskTime(task, pieces, snap + 86_400, snap)).toEqual(taskTime(task, pieces, snap, snap));
    }
  });
});
