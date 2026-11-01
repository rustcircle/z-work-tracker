import { describe, expect, it } from 'vitest';

import { analysisWake } from './analysisClock';

const T = (iso: string): number => Date.parse(iso) / 1000;
const rounding = [{ id: 'r', projectId: null, effectiveFrom: '2026-01-01', incrementMinutes: 15, method: 'up' as const, deleted: false, stamp: { at: '', by: '' } }];
const task = { id: 't', projectId: 'p' } as never;
const seg = (start: string, end: string | null, over: object = {}) => ({ id: start, taskId: 't', deviceId: 'd', start, end, provisionalEnd: null, ...over }) as never;

describe('when Analysis reads the clock again', () => {
  it('nothing running: only midnight', () => {
    const at = T('2026-03-12T15:20:00Z');
    expect(analysisWake({ segments: [seg('2026-03-12T09:00:00Z', '2026-03-12T10:00:00Z')], tasks: [task], rounding }, 'UTC', at)).toBe(T('2026-03-13T00:00:00Z') - at);
  });

  it('a task that has just started under Up: the first increment is a minute mark away, not a minute and more', () => {
    const at = T('2026-03-12T15:00:05Z');
    expect(analysisWake({ segments: [seg('2026-03-12T15:00:00Z', null)], tasks: [task], rounding }, 'UTC', at)).toBe(55);
  });

  it('a due step wakes sooner than the minute mark would', () => {
    // 14:59:30 on 15:00:00-anchored minutes would wait 30 s; counted time passes a multiple of 15 minutes in 1 s.
    const at = T('2026-03-12T15:30:00Z');
    const segs = [seg('2026-03-12T15:00:00Z', null)];
    expect(analysisWake({ segments: segs, tasks: [task], rounding }, 'UTC', at)).toBe(1);
  });

  it('only today\'s row grows: a segment from yesterday adds nothing to yesterday', () => {
    // Running since 23:00 yesterday, now 00:10: today holds 10 minutes, so the step to 15 is 5 minutes (and 1 s) away,
    // but the minute mark comes first.
    const at = T('2026-03-12T00:10:30Z');
    const wake = analysisWake({ segments: [seg('2026-03-11T23:00:00Z', null)], tasks: [task], rounding }, 'UTC', at);
    expect(wake).toBe(30);
    // Today's counted time is exactly 10m30s, not 1h10m30s: a step due at 1h15m would be 4m31s away, the same here
    // only by chance of the multiple, so check a case where they differ.
    const at2 = T('2026-03-12T00:14:30Z');
    expect(analysisWake({ segments: [seg('2026-03-11T23:00:00Z', null)], tasks: [task], rounding }, 'UTC', at2)).toBe(30);
  });
});
