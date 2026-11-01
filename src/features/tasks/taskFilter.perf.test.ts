// Run with `pnpm test:perf`. Filtering stays fast with a Timeline of 50k segments because the filter works on
// task ids: the folded text of each task is made once per task list, and a day is cut once per filter.
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { RateBook } from '../../lib/billing';
import type { RichDoc, RoundingVersion, Segment, Task } from '../../lib/types';
import { fullProject, fullTask } from '../../mocks/factories';
import { buildClosed, buildOverlay, filteredDayData, timelineSegs, visibleDays } from '../timeline/model';
import { matchingTaskIds } from './taskFilter';

const report = (line: string): void => void process.stdout.write(`${line}\n`);
const median = (run: () => void, n = 7): number => {
  const times: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  return times.sort((a, b) => a - b)[Math.floor(n / 2)] as number;
};

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (i: number): RichDoc => ({
  type: 'doc',
  content: [para(`Client brief number ${i} with a café menu and some longer text to read through`), { type: 'orderedList', content: ['Moodboard', 'Sketches', 'Final artwork'].map((t) => ({ type: 'listItem', content: [para(`${t} ${i}`)] })) }],
});

describe('task filter at 50k segments', () => {
  const projects = Array.from({ length: 10 }, (_, i) => fullProject({ id: `p${i}`, name: `Project ${i}` }));
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const makeTasks = (): Task[] => Array.from({ length: 400 }, (_, i) => fullTask({ id: `t${i}`, projectId: `p${i % 10}`, name: `Task ${i}`, description: doc(i), tags: i % 3 === 0 ? ['tag-a'] : [] }));
  const segments: Segment[] = Array.from({ length: 50_000 }, (_, i) => {
    const day = 1 + (i % 28);
    const start = 8 + (i % 9);
    return { id: `s${i}`, taskId: `t${i % 400}`, deviceId: 'd', start: `2026-02-${String(day).padStart(2, '0')}T${String(start).padStart(2, '0')}:00:00Z`, end: `2026-02-${String(day).padStart(2, '0')}T${String(start).padStart(2, '0')}:30:00Z`, provisionalEnd: null };
  });
  const rounding: RoundingVersion[] = [];
  const book = new RateBook(projects, []);

  it('typing into the filter costs a small fraction of rebuilding the model, and a repeat costs almost nothing', () => {
    const tasks = makeTasks();
    const base = timelineSegs({ segments, tasks, gaps: [] });
    const build = median(() => void buildClosed(base, 'UTC', book, rounding), 3);
    const closed = buildClosed(base, 'UTC', book, rounding);
    const overlay = buildOverlay(closed, 0, book, rounding);

    const firstWord = median(() => {
      const fresh = tasks.slice();
      const only = matchingTaskIds(fresh, projectMap, { text: 'sketches 17', projectId: '', tagIds: [] });
      const days = visibleDays(closed, overlay, only);
      for (const d of days.slice(0, 14)) filteredDayData(closed, overlay, d, only);
    });
    const only = matchingTaskIds(tasks, projectMap, { text: 'sketches 17', projectId: '', tagIds: [] });
    const repeat = median(() => {
      for (const d of visibleDays(closed, overlay, only).slice(0, 14)) filteredDayData(closed, overlay, d, only);
    });
    report(`PERF filter: rebuild model ${build.toFixed(1)} ms, filter on new tasks ${firstWord.toFixed(1)} ms, same filter again ${repeat.toFixed(2)} ms`);
    expect(only?.size).toBeGreaterThan(0);
    // Both sides are measured on the same machine in the same second, so a slow runner moves them together.
    expect(firstWord * 4).toBeLessThan(build);
    expect(repeat * 20).toBeLessThan(firstWord);
  });

  it('a text filter reads each document once per task list, not once per keystroke', () => {
    const tasks = makeTasks();
    const first = median(() => void matchingTaskIds(tasks.slice(), projectMap, { text: 'final artwork 399', projectId: '', tagIds: [] }), 5);
    matchingTaskIds(tasks, projectMap, { text: 'x', projectId: '', tagIds: [] });
    const again = median(() => void matchingTaskIds(tasks, projectMap, { text: 'final artwork 399', projectId: '', tagIds: [] }), 5);
    report(`PERF filter text over 400 tasks: new list ${first.toFixed(2)} ms, same list ${again.toFixed(3)} ms`);
    expect(again * 3).toBeLessThan(first);
  });
});
