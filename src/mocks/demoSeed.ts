// Deterministic demo data for tests and screenshots only. It is imported solely from the e2e entry
// and tests, and never reaches a user's store: the production bundle does not contain this module.
import { parseIso, toIso } from '../lib/tz';
import type { RichDoc, Segment, TaskState } from '../lib/types';
import { DEVICE_ID, type MockState, captureData, emptyState, handle } from './ipcMock';

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
    s.tasks.push({ id, name, projectId, description, state, pauseReason: state === 'paused' ? { kind: 'user' } : null, createdAt: '2026-02-20T09:00:00Z', stoppedAt, runningElsewhere: null, continuedFrom: null });
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
  s.warm = true;
  s.lastWorked = s.tasks.find((t) => t.state === 'running')?.id ?? s.tasks[0]?.id ?? null;
  return s;
}

export const demoNowSec = (): number => parseIso(DEMO_NOW);
export const demoIso = (sec: number): string => toIso(sec);

const subtaskDoc = (items: { id?: string; text: string; checked?: boolean }[], intro?: string): RichDoc => ({
  type: 'doc',
  content: [
    ...(intro ? [{ type: 'paragraph', content: [{ type: 'text', text: intro }] }] : []),
    {
      type: 'taskList',
      content: items.map((i) => ({
        type: 'taskItem',
        attrs: { checked: i.checked ?? false, ...(i.id ? { subtaskId: i.id } : {}) },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: i.text }] }],
      })),
    },
  ],
});

/**
 * The demo plus everything phase 2 adds, so screenshots and tests can show it: tags, a template, subtasks
 * with time, a billable pause, a thinking gap, a dropped gap, a pending gap, a correction and a manual
 * entry, a fixed-fee project with a budget at 80% or more, and billing summaries with prefix A.
 * Kept apart from `demoState()` because it changes worked, billable and earned totals.
 */
export function demoP2State(): MockState {
  const s = demoState();
  const T = (id: string) => s.tasks.find((t) => t.id === id)!;
  const findSeg = (taskId: string, start: string) => s.segments.find((x) => x.taskId === taskId && x.start === start)!;

  // Tags.
  T('t-logo').tags = ['tag-concept'];
  T('t-guide').tags = ['tag-concept', 'tag-revision'];
  T('t-home').tags = ['tag-revision'];
  T('t-box').tags = ['tag-concept'];
  T('t-mail').tags = ['tag-admin'];

  // Subtasks with time: three items on the running task, the middle one active since 14:00.
  T('t-logo').description = subtaskDoc(
    [{ id: 'st-moodboard', text: 'Moodboard', checked: true }, { id: 'st-sketches', text: 'Sketches' }, { id: 'st-final', text: 'Final artwork' }],
    'Client asked for three directions.',
  );
  T('t-logo').activeSubtask = 'st-sketches';
  for (const x of s.segments.filter((g) => g.taskId === 't-logo')) x.subtaskId = x.start < '2026-03-05' ? 'st-moodboard' : 'st-sketches';
  findSeg('t-logo', '2026-03-12T14:00:00Z').subtaskId = 'st-sketches';

  // A template.
  s.templates.push({
    id: 'tpl-logo',
    name: 'Logo job',
    projectId: 'p-brand',
    description: subtaskDoc([{ text: 'Moodboard' }, { text: 'Sketches' }, { text: 'Final artwork' }], 'Three directions, one round of changes.'),
    tags: ['tag-concept'],
    deleted: false,
    stamp: { at: '2026-02-01T00:00:00Z', by: DEVICE_ID },
  });

  // A fixed-fee project at 86% of its fee: 17 h 15 min at 50 EUR/h is 862.50 of 1,000.00.
  s.projects.push({ id: 'p-print', name: 'Print run (fixed fee)', color: '#0ea5e9', archived: false, billable: true, budgetHours: null, clientZone: null, createdAt: '2026-01-01T00:00:00Z', billingType: 'fixedFee', fixedFeeCents: 100_000, feeCurrency: 'EUR' });
  s.rates.push({ id: 'r4', projectId: 'p-print', effectiveFrom: '2026-01-01T00:00:00Z', rateCents: 5000, currency: 'EUR', deleted: false, stamp: { at: '2026-01-01T00:00:00Z', by: DEVICE_ID } });
  s.tasks.push({ id: 't-print', name: 'Print proofs', projectId: 'p-print', description: null, state: 'stopped', pauseReason: null, createdAt: '2026-02-20T09:00:00Z', stoppedAt: '2026-03-04T14:00:00Z', runningElsewhere: null, continuedFrom: null, tags: ['tag-revision'] });
  for (const [i, day] of ['2026-03-02', '2026-03-03', '2026-03-04'].entries()) {
    s.segments.push({ id: `sp${i}`, taskId: 't-print', deviceId: DEVICE_ID, start: `${day}T07:00:00Z`, end: `${day}T12:40:00Z`, provisionalEnd: null });
  }

  // Time away inside recorded segments: thinking, dropped, and a pending one in the running segment.
  const gap = (id: string, segmentId: string, taskId: string, start: string, end: string, kind: 'sleep' | 'idle', decision: 'pending' | 'keep' | 'drop' | 'thinking') =>
    s.gaps.push({ id, segmentId, taskId, deviceId: DEVICE_ID, start, end, kind, decision, decisionStamp: { at: end, by: DEVICE_ID } });
  const box = findSeg('t-box', '2026-03-10T14:00:00Z');
  gap('gap-think', box.id, 't-box', '2026-03-10T15:00:00Z', '2026-03-10T15:25:00Z', 'idle', 'thinking');
  const home = findSeg('t-home', '2026-03-10T09:00:00Z');
  gap('gap-drop', home.id, 't-home', '2026-03-10T10:00:00Z', '2026-03-10T10:20:00Z', 'sleep', 'drop');
  gap('gap-pending', findSeg('t-logo', '2026-03-12T14:00:00Z').id, 't-logo', '2026-03-12T14:20:00Z', '2026-03-12T14:50:00Z', 'idle', 'pending');

  // A billable pause: the wait for the client between two sessions today.
  handle(s, 'mark_billable_pause', { input: { taskId: 't-logo', start: '2026-03-12T10:45:00Z', end: '2026-03-12T11:15:00Z', note: 'Waiting on the client call' } });

  // A billing summary for last month's website work (A-001), another that was voided (A-002, never reused).
  handle(s, 'create_summary', { request: { projectId: 'p-web', from: '2026-02-23', to: '2026-02-27', zone: 'Europe/Lisbon' } });
  handle(s, 'create_summary', { request: { projectId: 'p-pack', from: '2026-02-23', to: '2026-03-06', zone: 'Europe/Lisbon' } });
  const second = s.summaries.at(-1);
  if (second) handle(s, 'void_summary', { id: second.id });

  // A correction and a hand-entered segment, both with reasons, so the timeline and history show them.
  handle(s, 'correct_segment', { input: { segmentId: findSeg('t-logo', '2026-03-09T09:00:00Z').id, start: '2026-03-09T09:00:00Z', end: '2026-03-09T11:05:00Z', reason: 'Stopped at 11:05, the timer ran on' } });
  handle(s, 'add_manual_entry', { input: { taskId: 't-home', start: '2026-03-11T16:45:00Z', end: '2026-03-11T17:15:00Z', reason: 'Forgot to start the timer after the call', allowOverlap: true } });

  s.backups = [
    { name: 'z-work-data-2026-03-12.json', bytes: 48_211, safety: false },
    { name: 'z-work-data-2026-03-11.json', bytes: 47_960, safety: false },
    { name: 'pre-restore-2026-03-05T10-00-00.json', bytes: 41_302, safety: true },
  ];
  s.backupData['z-work-data-2026-03-11.json'] = captureData(s);
  return s;
}
