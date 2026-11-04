// E2E-only seed for `?seed=many-tasks`: the demo plus six more tasks with time, so the "Share of time" donut can be
// checked with more tasks than it shows, and with tags and subtasks to divide by. The demo's own times are not changed;
// the new segments sit in the gaps of its days, and tags and subtasks only label time that is already there.
//   Week 9-15 Mar 2026 (the default range): the 5 demo tasks and 5 new ones, 10 in all, so 8 tasks and "Other (2 tasks)".
//   Week 2-8 Mar 2026: the 5 demo tasks and 4 new ones, 9 in all, so every task shows. One has only 4 minutes ("<1%").
//   March 2026: 10 tasks. Quarter 1 2026 and the year: 11 tasks (one more worked on 24 Feb).
//
// Tags (the starter tags, in the Settings order Concept, Revision, Client call, Admin). In the default week:
//   Concept: Logo concepts, Colour study.               Concept + Revision: Brand guidelines.
//   Revision: Homepage layout, Landing copy.            Concept + Revision + Client call: Box dieline (tagged out of order on purpose).
//   Concept + Client call: Pitch deck.                  Admin: Email and invoices.            No tag: Label artwork, Bug triage.
//
// Subtasks (items of a task's list, with time logged on them), in the default week, in minutes:
//   Logo concepts: Moodboard 140, Sketches 205 (75 + 130), Final artwork 85, and 80 on no subtask (the running stretch).
//   Brand guidelines: Outline 290 (150 + 140), Review 75.      Pitch deck: Slides 90.      Every other task has none.
import { DEVICE_ID, type MockState } from './ipcMock';
import { demoState, subtaskDoc } from './demoSeed';

interface Extra {
  id: string;
  name: string;
  projectId: string;
  /** [day, from, to] in UTC, all of them times the demo leaves free. */
  work: readonly (readonly [string, string, string])[];
}

const EXTRAS: readonly Extra[] = [
  { id: 'x-pitch', name: 'Pitch deck', projectId: 'p-brand', work: [['2026-03-09', '07:00', '08:30'], ['2026-03-02', '07:00', '08:00']] },
  { id: 'x-colour', name: 'Colour study', projectId: 'p-brand', work: [['2026-03-10', '07:00', '07:45'], ['2026-03-03', '07:00', '07:30']] },
  { id: 'x-copy', name: 'Landing copy', projectId: 'p-web', work: [['2026-03-11', '07:00', '08:00'], ['2026-03-04', '07:00', '07:40']] },
  { id: 'x-label', name: 'Label artwork', projectId: 'p-pack', work: [['2026-03-09', '18:00', '18:20'], ['2026-03-05', '18:00', '18:04']] },
  { id: 'x-triage', name: 'Bug triage', projectId: 'p-web', work: [['2026-03-11', '18:00', '18:10']] },
  { id: 'x-icons', name: 'Icon set', projectId: 'p-web', work: [['2026-02-24', '07:00', '08:00']] },
];

/** Task id to the ids of its tags. Box dieline lists them out of the Settings order, which a row of the Tags level must not mind. */
const TAGS: Readonly<Record<string, readonly string[]>> = {
  't-logo': ['tag-concept'],
  't-guide': ['tag-concept', 'tag-revision'],
  't-home': ['tag-revision'],
  't-box': ['tag-client-call', 'tag-concept', 'tag-revision'],
  't-mail': ['tag-admin'],
  'x-pitch': ['tag-concept', 'tag-client-call'],
  'x-colour': ['tag-concept'],
  'x-copy': ['tag-revision'],
};

/** Task id to the items of its list: [id, text]. */
const ITEMS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  't-logo': [['st-moodboard', 'Moodboard'], ['st-sketches', 'Sketches'], ['st-final', 'Final artwork']],
  't-guide': [['st-outline', 'Outline'], ['st-review', 'Review']],
  'x-pitch': [['st-slides', 'Slides']],
};

/** [task, start of its segment, item the segment was logged on]. A segment not listed here is on no item. */
const LOGGED_ON: readonly (readonly [string, string, string])[] = [
  ['t-logo', '2026-03-09T09:00:00Z', 'st-moodboard'],
  ['t-logo', '2026-03-09T11:35:00Z', 'st-sketches'],
  ['t-logo', '2026-03-11T22:30:00Z', 'st-sketches'],
  ['t-logo', '2026-03-12T09:05:00Z', 'st-final'],
  ['t-logo', '2026-03-02T09:00:00Z', 'st-moodboard'],
  ['t-logo', '2026-03-02T11:35:00Z', 'st-moodboard'],
  ['t-logo', '2026-03-05T14:00:00Z', 'st-sketches'],
  ['t-guide', '2026-03-09T14:00:00Z', 'st-outline'],
  ['t-guide', '2026-03-11T09:00:00Z', 'st-outline'],
  ['t-guide', '2026-03-11T11:35:00Z', 'st-review'],
  ['t-guide', '2026-03-04T09:00:00Z', 'st-outline'],
  ['x-pitch', '2026-03-09T07:00:00Z', 'st-slides'],
];

export function manyTasksState(): MockState {
  const s = demoState();
  let n = 0;
  for (const x of EXTRAS) {
    const last = x.work.map(([d, , to]) => `${d}T${to}:00Z`).sort().at(-1) ?? null;
    s.tasks.push({ id: x.id, name: x.name, projectId: x.projectId, description: null, state: 'stopped', pauseReason: null, createdAt: '2026-02-20T09:00:00Z', stoppedAt: last, runningElsewhere: null, continuedFrom: null });
    for (const [day, from, to] of x.work) {
      n += 1;
      s.segments.push({ id: `sx${n}`, taskId: x.id, deviceId: DEVICE_ID, start: `${day}T${from}:00Z`, end: `${day}T${to}:00Z`, provisionalEnd: null });
    }
  }
  for (const t of s.tasks) {
    const tags = TAGS[t.id];
    if (tags) t.tags = [...tags];
    const items = ITEMS[t.id];
    if (items) t.description = subtaskDoc(items.map(([id, text]) => ({ id, text })));
  }
  for (const [taskId, start, item] of LOGGED_ON) {
    const seg = s.segments.find((x) => x.taskId === taskId && x.start === start);
    if (!seg) throw new Error(`many-tasks seed: no segment of ${taskId} starts at ${start}`);
    seg.subtaskId = item;
  }
  return s;
}
