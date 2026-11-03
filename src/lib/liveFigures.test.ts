import { describe, expect, it } from 'vitest';

import { demoState } from '../mocks/demoSeed';
import { handle, type MockState } from '../mocks/ipcMock';
import { projectsAt } from './liveFigures';
import type { Snapshot } from './types';

const snap = (s: MockState): Snapshot => handle(s, 'get_snapshot', {}) as Snapshot;
const input = (s: MockState, id: string, over: Record<string, unknown>) => {
  const p = s.projects.find((x) => x.id === id)!;
  return { name: p.name, color: p.color, billable: p.billable, budgetHours: p.budgetHours, clientZone: p.clientZone, billingType: 'hourly', ...over };
};

describe('figures carried forward', () => {
  // The oracle is the snapshot a backend would make at that moment. It crosses steps of rounding, midnight and a price change.
  it.each([60, 61, 899, 901, 3600, 7 * 3600 + 13, 30 * 3600])('read as a new snapshot would, %i s later', (later) => {
    const s = demoState();
    handle(s, 'update_project', { id: 'p-brand', input: input(s, 'p-brand', { budgetHours: 100 }) });
    handle(s, 'set_rate', { input: { projectId: 'p-brand', rateCents: 7000, currency: 'EUR', effectiveFrom: new Date((s.now + 1800) * 1000).toISOString() } });
    const then = snap(s);
    s.now += later;
    const fresh = snap(s);
    const figuresOf = (list: readonly { id: string; figures: unknown }[]) => Object.fromEntries(list.map((p) => [p.id, p.figures]));
    expect(figuresOf(projectsAt(then, s.now))).toEqual(figuresOf(fresh.projects));
  });

  it('measures a fixed fee by the value of its time', () => {
    const s = demoState();
    handle(s, 'update_project', { id: 'p-brand', input: input(s, 'p-brand', { billingType: 'fixedFee', fixedFeeCents: 900_000, feeCurrency: 'EUR' }) });
    const then = snap(s);
    s.now += 5 * 3600;
    const live = projectsAt(then, s.now).find((p) => p.id === 'p-brand')!;
    expect(live.figures).toEqual(snap(s).projects.find((p) => p.id === 'p-brand')!.figures);
  });

  // Three rounded figures added up can be a cent away from one worked out once, so the amounts carried are exact.
  it.each([60, 901, 1800, 2700, 3600, 4500, 7 * 3600 + 13])('r7: a time value at 33.33 an hour rounds once, %i s later', (later) => {
    const s = demoState();
    handle(s, 'update_project', { id: 'p-brand', input: input(s, 'p-brand', { billingType: 'fixedFee', fixedFeeCents: 900_000, feeCurrency: 'EUR' }) });
    handle(s, 'set_rate', { input: { projectId: 'p-brand', rateCents: 3333, currency: 'EUR', effectiveFrom: '2020-01-01T00:00:00Z', confirmRetroactive: true } });
    const then = snap(s);
    s.now += later;
    const live = projectsAt(then, s.now).find((p) => p.id === 'p-brand')!;
    expect(live.figures).toEqual(snap(s).projects.find((p) => p.id === 'p-brand')!.figures);
  });

  it('is the same array when nothing is running, so nothing is drawn again for it', () => {
    const s = demoState();
    handle(s, 'stop_task', { id: 't-logo' });
    const then = snap(s);
    expect(projectsAt(then, s.now + 3600)).toBe(then.projects);
  });

  it('is the same array at the moment of the snapshot', () => {
    const then = snap(demoState());
    expect(projectsAt(then, Date.parse(then.now) / 1000)).toBe(then.projects);
  });
});
