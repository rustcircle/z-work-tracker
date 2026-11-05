// The Store screenshot seeds (storeSeed.ts): each is a store the app could really hold, and what the pictures rely on is there. The
// pictures themselves are e2e/store-shots.spec.ts, which runs only on purpose.
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';

import { addDays, dayOf, parseIso, weekdayOf } from '../lib/tz';
import type { Snapshot, Task } from '../lib/types';
import { installE2eBackend } from './e2eEntry';
import { handle, type MockState } from './ipcMock';
import { STORE_NOW, STORE_SEEDS, isStoreSeed, storeSeedState, type StoreSeed } from './storeSeed';

afterEach(() => {
  clearMocks();
  window.history.replaceState({}, '', '/');
});

const snap = (s: MockState): Snapshot => handle(s, 'get_snapshot', {}) as Snapshot;
const NOW = parseIso(STORE_NOW);

describe('the Store seeds', () => {
  it('are the three the e2e query names, and nothing else is one', () => {
    expect([...STORE_SEEDS]).toEqual(['store-web', 'store-swe', 'store-data']);
    expect(STORE_SEEDS.every((seed) => isStoreSeed(seed))).toBe(true);
    expect([isStoreSeed('demo'), isStoreSeed('store-'), isStoreSeed('')]).toEqual([false, false, false]);
    expect(isStoreSeed(null)).toBe(false);
  });

  it('stand at a Friday afternoon, the moment the screenshots set the page clock to', () => {
    expect(weekdayOf(STORE_NOW.slice(0, 10))).toBe(5);
    for (const seed of STORE_SEEDS) expect(storeSeedState(seed).now).toBe(NOW);
  });

  it('are the same every time they are made, so a picture can be taken again', () => {
    for (const seed of STORE_SEEDS) expect(storeSeedState(seed)).toEqual(storeSeedState(seed));
  });
});

/** The weekdays of the five weeks from Monday 5 October to Friday 6 November, which every seed has worked. */
const WORKED = Array.from({ length: 5 }, (_, week) => Array.from({ length: 5 }, (_, d) => addDays('2026-10-05', week * 7 + d))).flat();

describe.each(STORE_SEEDS)('%s', (seed: StoreSeed) => {
  const s = storeSeedState(seed);
  const snapshot = snap(s);
  const zone = snapshot.settings.myZone ?? '';
  const running = snapshot.tasks.filter((t) => t.state === 'running');

  it('opens with nothing for the app to warn about', () => {
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.notices).toEqual([]);
    expect(snapshot.lease.readOnly).toBe(false);
  });

  it('has one running task with its one open segment, one paused task and a draft', () => {
    expect(running).toHaveLength(1);
    const open = s.segments.filter((x) => x.end === null);
    expect(open.map((x) => x.taskId)).toEqual([running[0]?.id]);
    expect(snapshot.tasks.filter((t) => t.state === 'paused').length).toBeGreaterThanOrEqual(1);
    expect(snapshot.tasks.filter((t) => t.state === 'draft').length).toBeGreaterThanOrEqual(1);
    expect(s.lastWorked).toBe(running[0]?.id);
  });

  it('has no segment that overlaps another, or ends after now', () => {
    const byStart = [...s.segments].sort((a, b) => parseIso(a.start) - parseIso(b.start));
    byStart.forEach((x, i) => {
      expect(parseIso(x.start), `${x.id} starts before now`).toBeLessThan(NOW);
      if (x.end !== null) {
        expect(parseIso(x.end), `${x.id} ends after it starts`).toBeGreaterThan(parseIso(x.start));
        expect(parseIso(x.end), `${x.id} ends by now`).toBeLessThanOrEqual(NOW);
      }
      const next = byStart[i + 1];
      if (next && x.end !== null) expect(parseIso(next.start), `${next.id} starts after ${x.id} ends`).toBeGreaterThanOrEqual(parseIso(x.end));
    });
  });

  it('has worked every weekday of five weeks and no weekend, so the Timeline and Analysis are full', () => {
    const days = [...new Set(s.segments.map((x) => dayOf(parseIso(x.start), zone)))].sort();
    expect(days).toEqual(WORKED);
    expect(days.at(-3)).toBe('2026-11-04');
  });

  it('names only projects, tasks, subtasks and tags that exist, and gives subtasks a subset of their task`s tags', () => {
    const tagIds = new Set(snapshot.tags.map((t) => t.id));
    const projectIds = new Set(snapshot.projects.map((p) => p.id));
    for (const t of snapshot.tasks) {
      expect(projectIds.has(t.projectId), `${t.name} has a project`).toBe(true);
      expect(t.tags.every((id) => tagIds.has(id)), `${t.name} has tags that exist`).toBe(true);
      for (const item of t.subtasks) expect((item.tags ?? []).every((id) => t.tags.includes(id)), `${item.text} counts under its task's tags only`).toBe(true);
    }
    const items = new Set(snapshot.tasks.flatMap((t: Task) => t.subtasks.map((i) => `${t.id}/${i.id}`)));
    for (const x of s.segments) {
      if (x.subtaskId) expect(items.has(`${x.taskId}/${x.subtaskId}`), `${x.id} is on a subtask its task has`).toBe(true);
    }
  });

  it('has three live summaries, issued in order on days before now', () => {
    const summaries = snapshot.billing.summaries;
    expect(summaries.map((b) => [b.reference, b.voided])).toEqual([['A-001', false], ['A-002', false], ['A-003', false]]);
    for (const b of summaries) {
      expect(b.rows.length, `${b.reference} has rows`).toBeGreaterThan(0);
      expect(parseIso(b.createdAt), `${b.reference} was issued before now`).toBeLessThan(NOW - 6 * 86_400);
    }
  });

  it('has a running task whose subtasks count under tags of their own, which the tags button shows', () => {
    const own = running[0]?.subtasks.map((i) => i.tags) ?? [];
    expect(own.length).toBeGreaterThanOrEqual(4);
    expect(own.filter((tags) => tags !== null && tags.length > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('has the web developer\'s Checkout flow on all four states of the tags button: a subset, one tag, "Same as task" and "No tag"', () => {
    const task = snap(storeSeedState('store-web')).tasks.find((t) => t.name === 'Checkout flow');
    expect(task?.state).toBe('running');
    expect(task?.tags).toEqual(['tag-frontend', 'tag-backend', 'tag-design']);
    expect(task?.subtasks.map((i) => [i.text, i.tags])).toEqual([
      ['Cart page', ['tag-frontend', 'tag-design']],
      ['Payment API', ['tag-backend']],
      ['Order confirmation email', null],
      ['Release notes', []],
    ]);
  });
});

describe('the e2e query', () => {
  it.each(STORE_SEEDS)('?seed=%s opens that store', (seed) => {
    window.history.replaceState({}, '', `/?seed=${seed}`);
    installE2eBackend();
    expect(window.__mock.projects.length).toBeGreaterThanOrEqual(4);
    expect(window.__mock.now).toBe(NOW);
    expect(window.__mock.theme).toBe(seed === 'store-swe' ? 'dark' : 'light');
  });

  it('keeps ?theme= and ?showBoth= working with it, as with every seed', () => {
    window.history.replaceState({}, '', '/?seed=store-swe&theme=solarizedDark&showBoth=1');
    installE2eBackend();
    expect(window.__mock.theme).toBe('solarizedDark');
    expect(window.__mock.settings.showBoth).toBe(true);
  });
});
