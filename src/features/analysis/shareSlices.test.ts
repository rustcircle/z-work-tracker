// The rows behind the "Share of time" donut: rounding that always adds up, the Other group, the order of the tasks,
// the text of a legend row and the shades of a project's colour.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROJECT_PALETTE, THEME_BACKGROUNDS, contrast } from '../../lib/color';
import { THEMES } from '../../lib/themes';
import { fmtHM } from './format';
import { glossaryEntry } from './glossary';
import {
  OTHER_COLOR,
  SHOW_ALL_UP_TO,
  TOP_ROWS,
  apportion,
  hoursMinutes,
  percentText,
  projectShares,
  shareFigure,
  taskShades,
  taskShares,
  toOklch,
  type ShareModel,
  type ShareTask,
} from './shareSlices';

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** A repeatable stream of numbers in [0, 1), so the random cases are the same on every run. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** What the rows of a model must always satisfy, whatever the data. */
function expectConsistent(model: ShareModel): void {
  expect(model.totalMinutes).toBe(Math.round(model.totalSecs / 60));
  expect(sum(model.rows.map((r) => r.minutes))).toBe(model.totalMinutes);
  if (model.rows.length > 0) expect(sum(model.rows.map((r) => r.percent))).toBe(100);
  for (const r of model.rows) {
    expect(r.secs).toBeGreaterThan(0);
    expect(r.figure).toBe(`${r.hm} ${r.pct}`);
    expect(r.hm).toBe(hoursMinutes(r.minutes));
    // A row is never more than one unit away from its exact share of the total it is rounded to.
    expect(Math.abs(r.minutes - (r.secs / model.totalSecs) * model.totalMinutes)).toBeLessThan(1);
    expect(Math.abs(r.percent - (r.secs / model.totalSecs) * 100)).toBeLessThan(1);
  }
  // The centre of the donut writes the same total the rows add up to.
  if (model.totalMinutes >= 60) expect(fmtHM(model.totalSecs)).toBe(hoursMinutes(model.totalMinutes));
}

describe('apportion: the largest-remainder method', () => {
  it('splits three equal parts into 34, 33 and 33: the extra point goes to the first row', () => {
    expect(apportion([1, 1, 1], 100)).toEqual([34, 33, 33]);
  });

  it('keeps a 1 / 1 / 98 split as it is', () => {
    expect(apportion([1, 1, 98], 100)).toEqual([1, 1, 98]);
  });

  it('gives tiny values nothing and the big row the rest, so the total still comes to 100', () => {
    expect(apportion([1, 1, 98_000], 100)).toEqual([0, 0, 100]);
  });

  it('adds up seven equal parts: two rows get 15 and five get 14', () => {
    const seven = apportion(Array<number>(7).fill(1), 100);
    expect(seven).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(sum(seven)).toBe(100);
  });

  it('gives the spare unit to the largest remainder where plain rounding would fall one short', () => {
    // 47.4 + 26.3 + 26.3 rounds to 47 + 26 + 26 = 99.
    expect(apportion([474, 263, 263], 100)).toEqual([48, 26, 26]);
  });

  it('breaks a tie in the remainder by the larger weight, then by the earlier row', () => {
    // 0.5 and 1.5: the same remainder, so the larger weight wins.
    expect(apportion([1, 3], 2)).toEqual([0, 2]);
    // All four have the same weight and the same remainder: the first two rows win.
    expect(apportion([2, 2, 2, 2], 6)).toEqual([2, 2, 1, 1]);
  });

  it('leaves a row with no weight at 0, even when it is first in line', () => {
    expect(apportion([0, 5, 0, 5], 3)).toEqual([0, 2, 0, 1]);
  });

  it('has nothing to split when there are no rows, no weight or no units', () => {
    expect(apportion([], 100)).toEqual([]);
    expect(apportion([0, 0], 100)).toEqual([0, 0]);
    expect(apportion([1, 2], 0)).toEqual([0, 0]);
    expect(apportion([Number.NaN, -1, 3], 4)).toEqual([0, 0, 4]);
  });

  it('always adds up to the units, and every row stays within one unit of its exact share', () => {
    const rnd = lcg(20261103);
    for (let n = 0; n < 600; n += 1) {
      const rows = 1 + Math.floor(rnd() * 12);
      const weights = Array.from({ length: rows }, () => (rnd() < 0.15 ? 0 : 1 + Math.floor(rnd() * 5_000_000)));
      const units = rnd() < 0.5 ? 100 : 1 + Math.floor(rnd() * 5000);
      const got = apportion(weights, units);
      const total = sum(weights);
      if (total === 0) {
        expect(got).toEqual(weights.map(() => 0));
        continue;
      }
      expect(sum(got)).toBe(units);
      weights.forEach((w, i) => {
        const exact = (w * units) / total;
        expect(got[i]).toBeGreaterThanOrEqual(Math.floor(exact + 1e-9));
        expect(got[i]).toBeLessThanOrEqual(Math.ceil(exact - 1e-9));
        if (w === 0) expect(got[i]).toBe(0);
      });
    }
  });
});

describe('the text of a legend row', () => {
  it('writes hours always, and minutes with two digits', () => {
    expect(hoursMinutes(45)).toBe('0h 45m');
    expect(hoursMinutes(5)).toBe('0h 05m');
    expect(hoursMinutes(60)).toBe('1h 00m');
    expect(hoursMinutes(1010)).toBe('16h 50m');
    expect(hoursMinutes(123 * 60 + 5)).toBe('123h 05m');
  });

  it('puts the figure together as the owner asked: hours, one space, the percentage in brackets', () => {
    expect(shareFigure(45, 2, 2700).figure).toBe('0h 45m (2%)');
    expect(shareFigure(1010, 47, 60_600).figure).toBe('16h 50m (47%)');
    expect(shareFigure(123 * 60 + 5, 100, 443_100).figure).toBe('123h 05m (100%)');
    expect(shareFigure(65, 3, 3900)).toEqual({ hm: '1h 05m', pct: '(3%)', figure: '1h 05m (3%)' });
  });

  it('writes "<1%" for a row with time whose share rounds to nothing, and "0%" only for a row with none', () => {
    expect(percentText(0, 1)).toBe('(<1%)');
    expect(percentText(0, 0)).toBe('(0%)');
    expect(percentText(1, 1)).toBe('(1%)');
    expect(shareFigure(0, 0, 20).figure).toBe('0h 00m (<1%)');
  });
});

describe('projectShares', () => {
  const P = (id: string, name: string, secs: number, color = '#2563eb') => ({ id, name, color, secs });

  it('lists the projects with time, most first, then by name, each in its own colour', () => {
    const m = projectShares([P('c', 'Charlie', 600, '#059669'), P('z', 'Idle', 0), P('a', 'Alpha', 1200, '#dc2626'), P('b', 'Bravo', 600, '#2563eb')]);
    expect(m.level).toBe('projects');
    expect(m.rows.map((r) => [r.label, r.color, r.kind, r.id, r.projectId])).toEqual([
      ['Alpha', '#dc2626', 'project', 'a', 'a'],
      ['Bravo', '#2563eb', 'project', 'b', 'b'],
      ['Charlie', '#059669', 'project', 'c', 'c'],
    ]);
    expectConsistent(m);
  });

  it('adds three equal projects up to 100%, the extra point going to the first by name', () => {
    const m = projectShares([P('g', 'Gamma', 3600), P('a', 'Alpha', 3600), P('b', 'Beta', 3600)]);
    expect(m.rows.map((r) => [r.label, r.figure])).toEqual([
      ['Alpha', '1h 00m (34%)'],
      ['Beta', '1h 00m (33%)'],
      ['Gamma', '1h 00m (33%)'],
    ]);
  });

  it('adds the minutes up to the total the centre shows, where rounding each row would drift', () => {
    // 30 s each: every row alone rounds up to a minute (4 in all), the 2 minutes of the total is what the centre shows.
    const halves = projectShares([P('a', 'A', 30), P('b', 'B', 30), P('c', 'C', 30), P('d', 'D', 30)]);
    expect(halves.rows.map((r) => Math.round(r.secs / 60))).toEqual([1, 1, 1, 1]);
    expect(halves.totalMinutes).toBe(2);
    expect(halves.rows.map((r) => r.minutes)).toEqual([1, 1, 0, 0]);
    // 89 s twice: each alone rounds down to 1 minute (2 in all) but the total of 178 s is 3 minutes.
    const down = projectShares([P('a', 'A', 89), P('b', 'B', 89)]);
    expect(down.rows.map((r) => Math.round(r.secs / 60))).toEqual([1, 1]);
    expect(down.totalMinutes).toBe(3);
    expect(down.rows.map((r) => r.minutes)).toEqual([2, 1]);
    // 100 s three times: each alone rounds up to 2 minutes (6 in all) but the total of 300 s is 5.
    const up = projectShares([P('a', 'A', 100), P('b', 'B', 100), P('c', 'C', 100)]);
    expect(up.rows.map((r) => Math.round(r.secs / 60))).toEqual([2, 2, 2]);
    expect(up.totalMinutes).toBe(5);
    expect(up.rows.map((r) => r.minutes)).toEqual([2, 2, 1]);
    for (const m of [halves, down, up]) expectConsistent(m);
  });

  it('writes "(<1%)" for a project with a sliver of time and gives the rest to the big one', () => {
    const m = projectShares([P('a', 'Big', 99_999), P('b', 'Sliver', 1)]);
    expect(m.rows.map((r) => r.figure)).toEqual(['27h 47m (100%)', '0h 00m (<1%)']);
    expectConsistent(m);
  });

  it('shows a project that fills the whole donut at 100%', () => {
    const m = projectShares([P('a', 'Only', 2700)]);
    expect(m.rows.map((r) => r.figure)).toEqual(['0h 45m (100%)']);
  });

  it('has no rows when there is no time', () => {
    const m = projectShares([P('a', 'A', 0)]);
    expect(m.rows).toEqual([]);
    expect(m.totalSecs).toBe(0);
    expect(m.totalMinutes).toBe(0);
  });

  it('stays consistent for random data', () => {
    const rnd = lcg(7);
    for (let n = 0; n < 300; n += 1) {
      const rows = 1 + Math.floor(rnd() * 14);
      const m = projectShares(Array.from({ length: rows }, (_, i) => P(`p${i}`, `Project ${i}`, rnd() < 0.2 ? 0 : 1 + Math.floor(rnd() * 400_000))));
      expectConsistent(m);
    }
  });
});

describe('taskShares', () => {
  const COLORS: Record<string, string> = { A: '#2563eb', B: '#dc2626', C: '#059669' };
  const colorOf = (projectId: string): string => COLORS[projectId] ?? '#6b7280';
  const T = (id: string, projectId: string, secs: number): ShareTask => ({ id, name: `Task ${id}`, projectId, projectName: `Project ${projectId}`, secs });
  /** `n` tasks of one project with distinct, falling times. */
  const many = (n: number, projectId = 'A'): ShareTask[] => Array.from({ length: n }, (_, i) => T(`t${String(i).padStart(2, '0')}`, projectId, 10_000 - i * 100));

  it('gives every task a slice when there are nine or fewer', () => {
    expect(SHOW_ALL_UP_TO).toBe(9);
    const m = taskShares(many(9), colorOf);
    expect(m.rows).toHaveLength(9);
    expect(m.rows.every((r) => r.kind === 'task')).toBe(true);
    expect(m.rows.some((r) => r.label.startsWith('Other'))).toBe(false);
    expectConsistent(m);
  });

  it('groups all but the top eight as "Other (2 tasks)" when there are ten', () => {
    expect(TOP_ROWS).toBe(8);
    const tasks = many(10);
    const m = taskShares(tasks, colorOf);
    expect(m.rows).toHaveLength(9);
    const other = m.rows[8];
    expect(other).toMatchObject({ kind: 'other', id: null, projectId: null, label: 'Other (2 tasks)', grouped: 2, color: OTHER_COLOR });
    expect(other?.secs).toBe((tasks[8]?.secs ?? 0) + (tasks[9]?.secs ?? 0));
    expect(m.rows.slice(0, 8).map((r) => r.id)).toEqual(tasks.slice(0, 8).map((t) => t.id));
    expectConsistent(m);
  });

  it('counts the grouped tasks in the label: 12 tasks make "Other (4 tasks)"', () => {
    const m = taskShares(many(12), colorOf);
    const last = m.rows.at(-1);
    expect(last?.label).toBe('Other (4 tasks)');
    expect(last?.kind === 'other' ? last.grouped : null).toBe(4);
  });

  it('never writes "Other (1 tasks)", whatever the number of tasks', () => {
    for (let n = 1; n <= 40; n += 1) {
      const labels = taskShares(many(n), colorOf).rows.map((r) => r.label);
      expect(labels.some((l) => l === 'Other (1 tasks)' || l === 'Other (1 task)')).toBe(false);
      const other = labels.find((l) => l.startsWith('Other'));
      if (n <= 9) expect(other).toBeUndefined();
      else expect(other).toBe(`Other (${n - 8} tasks)`);
    }
  });

  it('does not count a task with no time towards the nine', () => {
    const m = taskShares([...many(9), T('idle1', 'A', 0), T('idle2', 'B', 0)], colorOf);
    expect(m.rows).toHaveLength(9);
    expect(m.rows.some((r) => r.kind === 'other')).toBe(false);
  });

  it('groups the shown tasks by project, the projects by their time, each project’s tasks by time, Other last', () => {
    const m = taskShares([T('t1', 'A', 10), T('t2', 'A', 3), T('t3', 'B', 8), T('t4', 'B', 7)], colorOf);
    // B has 15 against A’s 13, although the biggest single task is A’s.
    expect(m.rows.map((r) => r.id)).toEqual(['t3', 't4', 't1', 't2']);
    expect(m.rows.map((r) => r.projectId)).toEqual(['B', 'B', 'A', 'A']);
  });

  it('counts the time of the grouped tasks when it puts the projects in order', () => {
    // A: one task of 130. B: 90 and nine of 5, so B has 135 in all but only 120 of it shown.
    const tasks = [T('a1', 'A', 130), T('b1', 'B', 90), ...Array.from({ length: 9 }, (_, i) => T(`b${i + 2}`, 'B', 5))];
    const m = taskShares(tasks, colorOf);
    expect(m.rows.at(-1)?.label).toBe('Other (3 tasks)');
    expect(m.rows[0]?.projectId).toBe('B');
    expect(m.rows.find((r) => r.id === 'a1')).toBeDefined();
    expect(m.rows.map((r) => r.projectId)).toEqual(['B', 'B', 'B', 'B', 'B', 'B', 'B', 'A', null]);
  });

  it('puts projects with the same time in the order of their best task', () => {
    const m = taskShares([T('t1', 'B', 5), T('t2', 'A', 5)], colorOf);
    // The same time: the project of the task that ranks first goes first.
    expect(m.rows.map((r) => r.id)).toEqual(['t1', 't2']);
    const swapped = taskShares([T('x', 'B', 9), T('y', 'A', 4), T('z', 'A', 5)], colorOf);
    expect(swapped.rows.map((r) => r.id)).toEqual(['x', 'z', 'y']);
  });

  it('is the same whatever order the tasks come in', () => {
    const tasks = [T('t1', 'A', 10), T('t2', 'B', 10), T('t3', 'A', 10), T('t4', 'C', 1), ...many(12, 'B')];
    const reversed = taskShares([...tasks].reverse(), colorOf);
    expect(reversed.rows.map((r) => [r.key, r.color, r.figure])).toEqual(taskShares(tasks, colorOf).rows.map((r) => [r.key, r.color, r.figure]));
  });

  it('gives a project’s only task the project’s own colour, and several tasks different shades of its hue', () => {
    const alone = taskShares([T('t1', 'A', 5), T('t2', 'B', 4)], colorOf);
    expect(alone.rows.map((r) => r.color)).toEqual(['#2563eb', '#dc2626']);
    const shared = taskShares([T('t1', 'A', 9), T('t2', 'A', 5), T('t3', 'A', 2), T('t4', 'B', 1)], colorOf);
    const colours = shared.rows.map((r) => r.color);
    expect(new Set(colours).size).toBe(4);
    expect(colours[3]).toBe('#dc2626');
  });

  it('adds up in minutes and percent with Other included, for random data', () => {
    const rnd = lcg(99);
    for (let n = 0; n < 200; n += 1) {
      const rows = 1 + Math.floor(rnd() * 30);
      const tasks = Array.from({ length: rows }, (_, i) => T(`t${i}`, ['A', 'B', 'C'][Math.floor(rnd() * 3)] ?? 'A', rnd() < 0.1 ? 0 : 1 + Math.floor(rnd() * 90_000)));
      const m = taskShares(tasks, colorOf);
      expectConsistent(m);
      expect(m.totalSecs).toBe(sum(tasks.map((t) => t.secs)));
    }
  });
});

describe('taskShades: the shades of a project colour', () => {
  /** The angle between two hues, 0 to 180 degrees. */
  const hueGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
  const lightness = (hex: string): number => toOklch(hex)?.l ?? Number.NaN;
  const COLOURS = [...PROJECT_PALETTE, '#0ea5e9', '#7c5cbf'];

  it('gives a single task the project colour itself', () => {
    for (const c of COLOURS) expect(taskShades(c, 1)).toEqual([c]);
  });

  it('gives none for no tasks', () => {
    expect(taskShades('#2563eb', 0)).toEqual([]);
  });

  it('keeps the hue of the project colour in every shade, for every palette colour and up to eight tasks', () => {
    for (const c of COLOURS) {
      const base = toOklch(c);
      expect(base?.c).toBeGreaterThan(0.09);
      for (let n = 2; n <= 8; n += 1) {
        const shades = taskShades(c, n);
        expect(shades).toHaveLength(n);
        for (const s of shades) expect(hueGap(toOklch(s)?.h ?? 999, base?.h ?? 0), `${c} x${n} ${s}`).toBeLessThan(3);
      }
    }
  });

  it('steps the lightness: darkest first, every shade different, neighbours far enough apart to tell', () => {
    for (const c of COLOURS) {
      for (let n = 2; n <= 8; n += 1) {
        const l = taskShades(c, n).map(lightness);
        const steps = l.slice(1).map((v, i) => v - (l[i] ?? 0));
        expect(Math.min(...steps), `${c} x${n}`).toBeGreaterThan(n <= 3 ? 0.05 : n <= 5 ? 0.04 : 0.025);
      }
    }
  });

  it('keeps every shade visible against the page and the card of all four themes', () => {
    for (const c of COLOURS) {
      for (let n = 2; n <= 8; n += 1) {
        for (const s of taskShades(c, n)) {
          const weakest = Math.min(...THEME_BACKGROUNDS.map((bg) => contrast(s, bg)));
          expect(weakest, `${c} x${n} ${s}`).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('is the same every time', () => {
    expect(taskShades('#7c3aed', 5)).toEqual(taskShades('#7c3aed', 5));
  });

  it('leaves a colour that is not a hex value as it is, for each task', () => {
    expect(taskShades('var(--accent)', 3)).toEqual(['var(--accent)', 'var(--accent)', 'var(--accent)']);
  });
});

describe('the colour of the grouped rest', () => {
  it('is the strong border token, which every theme defines and which shows on that theme’s card', () => {
    expect(OTHER_COLOR).toBe('var(--border-strong)');
    for (const [theme, tokens] of Object.entries(THEMES)) {
      expect(contrast(tokens.borderStrong, tokens.surface), theme).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('what the glossary and the README say about the rounding', () => {
  const P = (id: string, name: string, secs: number) => ({ id, name, color: '#2563eb', secs });
  const glossary = (): string => glossaryEntry('projects.share')?.definition ?? '';
  /** The "Share of time" paragraph of the README's Analysis section. */
  const readme = (): string => readFileSync(path.resolve(import.meta.dirname, '../../../README.md'), 'utf8').split('\n').find((line) => line.startsWith('**Share of time**')) ?? '';

  it('reserves "<1%" for a slice whose share rounds to 0, which is not every slice under 1%', () => {
    // 0.7% is given a spare point, so it reads 1%. 0.4% is not, so it reads "<1%".
    expect(projectShares([P('a', 'Big', 9930), P('b', 'Sliver', 70)]).rows.map((r) => r.pct)).toEqual(['(99%)', '(1%)']);
    expect(projectShares([P('a', 'Big', 9960), P('b', 'Sliver', 40)]).rows.map((r) => r.pct)).toEqual(['(100%)', '(<1%)']);
    expect(glossary()).toContain('a slice whose share rounds to 0 reads "<1%"');
    expect(glossary()).not.toContain('under 1%');
  });

  it('says that some slices, not one, can differ by a point from plain rounding', () => {
    // Plain rounding of seven equal parts is 14 each, 98 in all: two slices take the spare points.
    const seven = projectShares(Array.from({ length: 7 }, (_, i) => P(`p${i}`, `Project ${i}`, 600)));
    expect(seven.rows.map((r) => r.percent)).toEqual([15, 15, 14, 14, 14, 14, 14]);
    // Twelve equal parts: 8 each is 96 in all, so four slices differ.
    const twelve = projectShares(Array.from({ length: 12 }, (_, i) => P(`p${String(i).padStart(2, '0')}`, `Project ${String(i).padStart(2, '0')}`, 600)));
    expect(twelve.rows.filter((r) => r.percent !== Math.round((r.secs / twelve.totalSecs) * 100))).toHaveLength(4);
    for (const text of [glossary(), readme()]) {
      expect(text).toContain('some slices');
      expect(text).toContain('a point from plain rounding');
      expect(text).not.toContain('one slice');
    }
  });
});
