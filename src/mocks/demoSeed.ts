// Deterministic demo data for tests and screenshots only. It is imported solely from the e2e entry
// and tests, and never reaches a user's store: the production bundle does not contain this module.
import { parseIso, toIso } from '../lib/tz';
import type { RichDoc, Segment, TaskState } from '../lib/types';
import { DEVICE_ID, type MockState, emptyState } from './ipcMock';

export const DEMO_NOW = '2026-03-12T15:20:00Z';

const stamp = { at: '2026-01-01T00:00:00Z', by: DEVICE_ID };

const steps: RichDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Client asked for three directions.' }] },
    {
      type: 'orderedList',
      attrs: { start: 1 },
      content: ['Moodboard', 'Sketches', 'Final artwork'].map((text) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      })),
    },
  ],
};

/** Hand-computable fixture: see src/features/analysis fixtures for figures derived from it. */
export function demoState(): MockState {
  const s = emptyState(DEMO_NOW);
  const project = (id: string, name: string, color: string, extra: Partial<MockState['projects'][number]> = {}) =>
    s.projects.push({ id, name, color, archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', hasTasks: true, ...extra });
  project('p-brand', 'Brand refresh', '#2563eb', { budgetHours: 60, clientZone: 'America/New_York' });
  project('p-web', 'Website', '#dc2626', { budgetHours: 40 });
  project('p-pack', 'Packaging', '#059669');
  project('p-admin', 'Admin', '#d97706', { billable: false });

  const rate = (id: string, projectId: string, from: string, cents: number, currency: string) =>
    s.rates.push({ id, projectId, effectiveFrom: from, rateCents: cents, currency, deleted: false, stamp });
  rate('r1', 'p-brand', '2026-01-01T00:00:00Z', 8000, 'USD');
  rate('r2', 'p-brand', '2026-03-09T00:00:00Z', 9000, 'USD');
  rate('r3', 'p-web', '2026-01-01T00:00:00Z', 6000, 'EUR');

  const task = (id: string, name: string, projectId: string, state: TaskState, description: RichDoc = null, stoppedAt: string | null = null) =>
    s.tasks.push({ id, name, projectId, description, state, pauseReason: state === 'paused' ? { kind: 'user' } : null, createdAt: '2026-02-20T09:00:00Z', stoppedAt, runningElsewhere: null });
  task('t-logo', 'Logo concepts', 'p-brand', 'running', steps);
  task('t-guide', 'Brand guidelines', 'p-brand', 'paused');
  task('t-home', 'Homepage layout', 'p-web', 'stopped', null, '2026-03-11T16:30:00Z');
  task('t-box', 'Box dieline', 'p-pack', 'stopped', null, '2026-03-10T12:00:00Z');
  task('t-mail', 'Email and invoices', 'p-admin', 'paused');
  task('t-next', 'Social templates', 'p-brand', 'draft');

  let n = 0;
  const seg = (taskId: string, start: string, end: string | null): void => {
    n += 1;
    const item: Segment = { id: `s${n}`, taskId, deviceId: DEVICE_ID, start, end, provisionalEnd: null };
    s.segments.push(item);
  };
  // Three weeks of work with patterns across bands. All times UTC.
  const days = ['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10', '2026-03-11'];
  const cycle = ['t-logo', 't-home', 't-guide', 't-box', 't-home'];
  days.forEach((day, i) => {
    const a = cycle[i % cycle.length] as string;
    const b = cycle[(i + 2) % cycle.length] as string;
    seg(a, `${day}T09:00:00Z`, `${day}T11:20:00Z`);
    seg(a, `${day}T11:35:00Z`, `${day}T12:50:00Z`);
    seg(b, `${day}T14:00:00Z`, `${day}T16:30:00Z`);
    if (i % 3 === 0) seg('t-mail', `${day}T17:00:00Z`, `${day}T17:20:00Z`);
    if (i % 4 === 1) seg('t-guide', `${day}T21:30:00Z`, `${day}T23:10:00Z`);
  });
  // Crosses midnight UTC, with a pause gap before it.
  seg('t-logo', '2026-03-11T22:30:00Z', '2026-03-12T00:40:00Z');
  seg('t-logo', '2026-03-12T09:05:00Z', '2026-03-12T10:30:00Z');
  seg('t-logo', '2026-03-12T14:00:00Z', null);

  const shift = (id: string, shiftId: string, name: string, color: string, start: string, end: string, zone: string) =>
    s.shifts.push({ id, shiftId, effectiveFrom: '2026-01-01', name, color, start, end, weekdays: [1, 2, 3, 4, 5], zone, breakMinutes: 30, retired: false, deleted: false, stamp });
  shift('sv1', 'sh-morning', 'Morning', '#0891b2', '09:00', '13:00', 'Europe/Lisbon');
  shift('sv2', 'sh-coverage', 'US coverage', '#7c3aed', '09:00', '13:00', 'America/New_York');

  s.settings = {
    myZone: 'Europe/Lisbon',
    clientZone: 'America/New_York',
    activeZone: 'Europe/Lisbon',
    showBoth: false,
    clientWorkStart: '09:00',
    clientWorkEnd: '17:00',
    dailyTargetHours: 6,
    weeklyTargetHours: 30,
  };
  s.clientZonePromptDone = true;
  s.syncPromptDone = true;
  s.nextId = 1000;
  return s;
}

export const demoNowSec = (): number => parseIso(DEMO_NOW);
export const demoIso = (sec: number): string => toIso(sec);
