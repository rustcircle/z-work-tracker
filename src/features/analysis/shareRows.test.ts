// The rows of the Share of time donut at the levels below Projects: what a row is called (only what the filter leaves
// open), the subtasks and a task's time on none, the tag combinations and the Other row of each level.
import { describe, expect, it } from 'vitest';

import { THEMES } from '../../lib/themes';
import { contrast } from '../../lib/color';
import { UNTAGGED_COLOR } from './fam-p2';
import {
  COMBINATION_NOTE,
  NO_SUBTASK_LABEL,
  NO_TAG_LABEL,
  OTHER_COLOR,
  PATH_SEPARATOR,
  TAG_SEPARATOR,
  hoursMinutes,
  otherLabel,
  otherNote,
  otherTip,
  projectShares,
  spokenName,
  subtaskShares,
  tagKeyOf,
  tagShares,
  tagWeightsOf,
  taskShares,
  toOklch,
  type ShareModel,
  type ShareRow,
  type ShareSubtask,
  type ShareTag,
  type ShareTagTask,
  type ShareTask,
} from './shareSlices';

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const COLORS: Record<string, string> = { A: '#2563eb', B: '#dc2626', C: '#059669' };
const colorOf = (projectId: string): string => COLORS[projectId] ?? '#6b7280';

/** What the rows of every model must satisfy, whatever the level. */
function expectConsistent(model: ShareModel): void {
  expect(model.totalMinutes).toBe(Math.round(model.totalSecs / 60));
  expect(sum(model.rows.map((r) => r.minutes))).toBe(model.totalMinutes);
  if (model.rows.length > 0) expect(sum(model.rows.map((r) => r.percent))).toBe(100);
  for (const r of model.rows) {
    expect(r.secs).toBeGreaterThan(0);
    expect(r.figure).toBe(`${r.hm} ${r.pct}`);
    expect(r.hm).toBe(hoursMinutes(r.minutes));
    expect(r.title).toBe(r.path.join(PATH_SEPARATOR));
    expect(r.path.at(-1)).toBeDefined();
  }
  expect(new Set(model.rows.map((r) => r.key)).size, 'keys are distinct').toBe(model.rows.length);
}

const T = (id: string, projectId: string, secs: number): ShareTask => ({ id, name: `Task ${id}`, projectId, projectName: `Project ${projectId}`, secs });
const S = (taskId: string, projectId: string, id: string | null, secs: number): ShareSubtask => ({
  taskId,
  taskName: `Task ${taskId}`,
  projectId,
  projectName: `Project ${projectId}`,
  id,
  name: id === null ? '' : `Sub ${id}`,
  secs,
});
const contextOf = (m: ShareModel): string[][] => m.rows.map((r) => [...r.context]);

describe('the words after a task’s name: only what the filter leaves open', () => {
  it('names the project when the tasks belong to several projects', () => {
    const m = taskShares([T('t1', 'A', 600), T('t2', 'B', 300)], colorOf);
    expect(contextOf(m)).toEqual([['Project A'], ['Project B']]);
    expect(m.rows.map((r) => r.label)).toEqual(['Task t1', 'Task t2']);
  });

  it('leaves the project out when every task belongs to one project', () => {
    const m = taskShares([T('t1', 'A', 600), T('t2', 'A', 300)], colorOf);
    expect(contextOf(m)).toEqual([[], []]);
    expect(m.rows.map((r) => r.label)).toEqual(['Task t1', 'Task t2']);
  });

  it('keeps the whole path in the title, the slice’s label and the spoken name whatever the line leaves out', () => {
    const m = taskShares([T('t1', 'A', 600)], colorOf);
    const row = m.rows[0] as ShareRow;
    expect(row.context).toEqual([]);
    expect(row.path).toEqual(['Project A', 'Task t1']);
    expect(row.title).toBe('Project A > Task t1');
    expect(spokenName(row)).toBe('Task t1, project Project A');
  });

  it('counts the projects of the tasks Other groups: they are in the data, shown or not', () => {
    // Eight tasks of A are shown; the two that Other groups belong to B, so the data holds two projects.
    const tasks = [...Array.from({ length: 8 }, (_, i) => T(`a${i}`, 'A', 1000 - i)), T('b1', 'B', 20), T('b2', 'B', 10)];
    const m = taskShares(tasks, colorOf);
    expect(m.rows.at(-1)?.label).toBe('Other (2 tasks)');
    expect(m.rows.slice(0, 8).every((r) => r.context[0] === 'Project A')).toBe(true);
    // Whereas ten tasks of one project name none.
    const one = taskShares(Array.from({ length: 10 }, (_, i) => T(`a${i}`, 'A', 1000 - i)), colorOf);
    expect(one.rows.every((r) => r.context.length === 0)).toBe(true);
  });

  it('names no project on the Other row', () => {
    const m = taskShares(Array.from({ length: 10 }, (_, i) => T(`t${i}`, i % 2 ? 'A' : 'B', 1000 - i)), colorOf);
    const other = m.rows.at(-1) as ShareRow;
    expect(other.kind).toBe('other');
    expect(other.context).toEqual([]);
    expect(other.path).toEqual(['Other (2 tasks)']);
  });

  it('does not touch the Projects level', () => {
    const m = projectShares([{ id: 'A', name: 'Alpha', color: '#2563eb', secs: 600 }]);
    expect(m.rows[0]).toMatchObject({ label: 'Alpha', context: [], path: ['Alpha'], title: 'Alpha' });
    expect(spokenName(m.rows[0] as ShareRow)).toBeUndefined();
  });
});

describe('the subtask rows', () => {
  it('within one task, writes the subtask’s name alone, and "<Task> (no subtask)" for time on none', () => {
    const m = subtaskShares([S('t1', 'A', 's1', 3600), S('t1', 'A', 's2', 1800), S('t1', 'A', null, 600)], colorOf);
    expect(m.level).toBe('subtasks');
    expect(m.rows.map((r) => r.label)).toEqual(['Sub s1', 'Sub s2', `Task t1 ${NO_SUBTASK_LABEL}`]);
    expect(m.rows.map((r) => r.label).at(-1)).toBe('Task t1 (no subtask)');
    expect(contextOf(m)).toEqual([[], [], []]);
    expectConsistent(m);
  });

  it('keeps the whole path of each row: project, task, subtask', () => {
    const m = subtaskShares([S('t1', 'A', 's1', 3600), S('t1', 'A', null, 600)], colorOf);
    expect(m.rows.map((r) => r.title)).toEqual(['Project A > Task t1 > Sub s1', 'Project A > Task t1 > (no subtask)']);
    expect(m.rows.map(spokenName)).toEqual(['Sub s1, task Task t1, project Project A', 'Task t1 (no subtask), project Project A']);
  });

  it('across several tasks of one project, follows the subtask with its task', () => {
    const m = subtaskShares([S('t1', 'A', 's1', 3600), S('t2', 'A', 's2', 1800), S('t2', 'A', null, 600)], colorOf);
    expect(m.rows.map((r) => [r.label, ...r.context])).toEqual([['Sub s1', 'Task t1'], ['Sub s2', 'Task t2'], ['Task t2 (no subtask)']]);
  });

  it('adds the project only when the data holds several projects', () => {
    const m = subtaskShares([S('t1', 'A', 's1', 3600), S('t2', 'B', 's2', 1800), S('t2', 'B', null, 600)], colorOf);
    expect(m.rows.map((r) => [r.label, ...r.context])).toEqual([
      ['Sub s1', 'Task t1', 'Project A'],
      ['Sub s2', 'Task t2', 'Project B'],
      ['Task t2 (no subtask)', 'Project B'],
    ]);
    // One task of two projects is not possible, but one task alone still names nothing.
    expect(subtaskShares([S('t1', 'A', 's1', 3600)], colorOf).rows[0]?.context).toEqual([]);
  });

  it('puts the subtasks of one project together, the biggest task first, the biggest subtask first inside it', () => {
    const m = subtaskShares(
      [S('t1', 'A', 's1', 100), S('t2', 'B', 's2', 500), S('t1', 'A', 's3', 300), S('t3', 'A', 's4', 250), S('t2', 'B', null, 200)],
      colorOf,
    );
    // Project A has 650 and B 700. Inside A: t1 (400) before t3 (250); inside t1: s3 before s1.
    expect(m.rows.map((r) => r.label)).toEqual(['Sub s2', 'Task t2 (no subtask)', 'Sub s3', 'Sub s1', 'Sub s4']);
    expect(m.rows.map((r) => r.projectId)).toEqual(['B', 'B', 'A', 'A', 'A']);
  });

  it('colours the subtasks of a project in shades of the project’s colour', () => {
    const m = subtaskShares([S('t1', 'A', 's1', 300), S('t1', 'A', 's2', 200), S('t1', 'A', null, 100), S('t2', 'B', 's3', 50)], colorOf);
    const hue = (hex: string): number => toOklch(hex)?.h ?? Number.NaN;
    const a = m.rows.filter((r) => r.projectId === 'A').map((r) => r.color);
    expect(new Set(a).size).toBe(3);
    for (const c of a) expect(Math.abs(hue(c) - hue('#2563eb'))).toBeLessThan(3);
    expect(m.rows.find((r) => r.projectId === 'B')?.color).toBe('#dc2626');
  });

  it('groups all but the top eight past nine rows as "Other (N subtasks)"', () => {
    const rows = Array.from({ length: 12 }, (_, i) => S(`t${i % 3}`, 'A', `s${i}`, 1000 - i * 10));
    const m = subtaskShares(rows, colorOf);
    expect(m.rows).toHaveLength(9);
    const other = m.rows.at(-1) as ShareRow;
    expect(other).toMatchObject({ kind: 'other', label: 'Other (4 subtasks)', grouped: 4, unit: 'subtasks', color: OTHER_COLOR, context: [] });
    expect(other.secs).toBe(sum(rows.slice(8).map((r) => r.secs)));
    expectConsistent(m);
    // Nine rows are all shown.
    expect(subtaskShares(rows.slice(0, 9), colorOf).rows.some((r) => r.kind === 'other')).toBe(false);
  });

  it('has no rows without time, and a row of tiny time still gets "<1%" while the rest add up to 100', () => {
    const m = subtaskShares([S('t1', 'A', 's1', 99_999), S('t1', 'A', 's2', 1), S('t1', 'A', 's3', 0)], colorOf);
    expect(m.rows.map((r) => r.pct)).toEqual(['(100%)', '(<1%)']);
    expectConsistent(m);
  });

  it('adds up to the same total in the centre as the tasks the subtasks come from', () => {
    const tasks = [T('t1', 'A', 3600 + 1800 + 600), T('t2', 'B', 1234)];
    const subs = [S('t1', 'A', 's1', 3600), S('t1', 'A', 's2', 1800), S('t1', 'A', null, 600), S('t2', 'B', null, 1234)];
    expect(subtaskShares(subs, colorOf).totalMinutes).toBe(taskShares(tasks, colorOf).totalMinutes);
  });
});

describe('the tag combination a task is counted under', () => {
  const TAGS: ShareTag[] = [
    { id: 'design', name: 'Design', color: '#7c3aed' },
    { id: 'client', name: 'Client', color: '#0f766e' },
    { id: 'urgent', name: 'Urgent', color: '#c2410c' },
  ];

  it('is the exact set of tags the task carries, in the order of the Settings list, whichever order it was tagged in', () => {
    expect(tagKeyOf(['design', 'client'], TAGS).label).toBe('Design + Client');
    expect(tagKeyOf(['client', 'design'], TAGS).label).toBe('Design + Client');
    expect(tagKeyOf(['client', 'design'], TAGS).key).toBe(tagKeyOf(['design', 'client'], TAGS).key);
    expect(tagKeyOf(['urgent', 'client', 'design'], TAGS)).toMatchObject({ label: 'Design + Client + Urgent', tagIds: ['design', 'client', 'urgent'], colors: ['#7c3aed', '#0f766e', '#c2410c'] });
  });

  it('uses the Settings order, not the alphabet', () => {
    const reversed = [...TAGS].reverse();
    expect(tagKeyOf(['design', 'client'], reversed).label).toBe('Client + Design');
  });

  it('is a single tag’s own row for one tag, and "No tag" for none', () => {
    expect(tagKeyOf(['client'], TAGS)).toMatchObject({ label: 'Client', tagIds: ['client'], colors: ['#0f766e'] });
    expect(tagKeyOf([], TAGS)).toMatchObject({ label: NO_TAG_LABEL, tagIds: [], colors: [UNTAGGED_COLOR] });
  });

  it('does not count a tag that no longer exists: a task left with none is "No tag"', () => {
    expect(tagKeyOf(['gone'], TAGS).label).toBe('No tag');
    expect(tagKeyOf(['gone', 'design'], TAGS).label).toBe('Design');
  });

  it('is one different row for every different set: {Design, Client} is not {Design}', () => {
    const keys = [['design'], ['client'], ['design', 'client'], ['design', 'client', 'urgent'], []].map((t) => tagKeyOf(t, TAGS).key);
    expect(new Set(keys).size).toBe(5);
  });

  it('is the one place the counting rule lives: a task’s time goes whole to one row', () => {
    const weights = tagWeightsOf(['client', 'design'], TAGS);
    expect(weights).toHaveLength(1);
    expect(weights[0]?.weight).toBe(1);
    expect(weights[0]?.row.label).toBe('Design + Client');
    expect(sum(tagWeightsOf([], TAGS).map((w) => w.weight))).toBe(1);
  });
});

describe('the Tags level', () => {
  const TAGS: ShareTag[] = [
    { id: 'design', name: 'Design', color: '#7c3aed' },
    { id: 'client', name: 'Client', color: '#0f766e' },
    { id: 'urgent', name: 'Urgent', color: '#c2410c' },
  ];
  const X = (id: string, secs: number, tagIds: string[]): ShareTagTask => ({ id, secs, exact: secs, billableSecs: secs + 60, tagIds });

  it('has one row per combination, a single tag’s row for a task with one tag, and "No tag" for time on untagged tasks', () => {
    const m = tagShares([X('t1', 7200, ['design']), X('t2', 3600, ['client', 'design']), X('t3', 1800, ['design', 'client', 'urgent']), X('t4', 600, [])], TAGS);
    expect(m.level).toBe('tags');
    expect(m.rows.map((r) => [r.label, r.figure])).toEqual([
      ['Design', '2h 00m (55%)'],
      ['Design + Client', '1h 00m (27%)'],
      ['Design + Client + Urgent', '0h 30m (14%)'],
      ['No tag', '0h 10m (4%)'],
    ]);
    expectConsistent(m);
  });

  it('counts each task once, so the rows add up to the total in the centre and to 100%', () => {
    const tasks = [X('t1', 7777, ['design', 'client']), X('t2', 3333, ['client']), X('t3', 1111, ['design', 'client', 'urgent']), X('t4', 999, [])];
    const m = tagShares(tasks, TAGS);
    expect(m.totalSecs).toBe(sum(tasks.map((t) => t.secs)));
    expect(sum(m.rows.map((r) => r.secs))).toBe(m.totalSecs);
    expectConsistent(m);
    // The same tasks at the Tasks level have the same centre.
    expect(m.totalMinutes).toBe(taskShares(tasks.map((t) => T(t.id, 'A', t.secs)), colorOf).totalMinutes);
  });

  it('puts tasks with the same set of tags in one row, whatever order they were tagged in', () => {
    const m = tagShares([X('t1', 3600, ['design', 'client']), X('t2', 1800, ['client', 'design'])], TAGS);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ label: 'Design + Client', secs: 5400, kind: 'tag' });
    expect(m.rows[0]?.kind === 'tag' ? m.rows[0].taskIds : []).toEqual(['t1', 't2']);
  });

  it('draws a single tag in its colour, "No tag" in the grey, and a combination as stripes of its tags’ colours', () => {
    const m = tagShares([X('t1', 4000, ['design']), X('t2', 3000, ['design', 'client']), X('t3', 2000, ['urgent', 'client', 'design']), X('t4', 1000, [])], TAGS);
    const by = (label: string): ShareRow => m.rows.find((r) => r.label === label) as ShareRow;
    expect(by('Design')).toMatchObject({ color: '#7c3aed' });
    expect(by('Design').stripes).toBeUndefined();
    expect(by('No tag')).toMatchObject({ color: UNTAGGED_COLOR });
    expect(by('No tag').stripes).toBeUndefined();
    expect(by('Design + Client')).toMatchObject({ color: '#7c3aed', stripes: ['#7c3aed', '#0f766e'] });
    expect(by('Design + Client + Urgent').stripes).toEqual(['#7c3aed', '#0f766e', '#c2410c']);
  });

  it('counts the combinations, for the footnote that explains them', () => {
    expect(tagShares([X('t1', 100, ['design']), X('t2', 100, [])], TAGS).combinations).toBe(0);
    expect(tagShares([X('t1', 100, ['design', 'client'])], TAGS).combinations).toBe(1);
    expect(tagShares([X('t1', 100, ['design', 'client']), X('t2', 100, ['design', 'urgent']), X('t3', 100, ['design'])], TAGS).combinations).toBe(2);
    expect(COMBINATION_NOTE).toBe('Tasks with several tags are counted once, under their combination.');
  });

  it('has no rows for tasks without time', () => {
    const m = tagShares([X('t1', 0, ['design']), X('t2', 600, [])], TAGS);
    expect(m.rows.map((r) => r.label)).toEqual(['No tag']);
  });

  it('groups past nine rows as "Other (N combinations)" and still lists every combination for the table', () => {
    // Eleven different sets of the three tags and none: 7 combinations of three tags, plus "No tag" is 8; add more tags to reach 11.
    const many: ShareTag[] = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, name: `Tag ${i}`, color: '#0891b2' }));
    const tasks = [
      ...many.map((t, i) => X(`s${i}`, 5000 - i * 100, [t.id])),
      X('p01', 4000, ['g0', 'g1']),
      X('p02', 3900, ['g0', 'g2']),
      X('p03', 3800, ['g1', 'g2']),
      X('p04', 3700, ['g0', 'g1', 'g2']),
      X('p05', 3600, ['g3', 'g4']),
      X('p06', 3500, []),
    ];
    const m = tagShares(tasks, many);
    expect(m.rows).toHaveLength(9);
    const other = m.rows.at(-1) as ShareRow;
    expect(other).toMatchObject({ kind: 'other', label: 'Other (3 combinations)', grouped: 3, unit: 'combinations', color: OTHER_COLOR, path: ['Other (3 combinations)'] });
    expect(m.lines).toHaveLength(11);
    expect(sum(m.lines.map((l) => l.secs))).toBe(m.totalSecs);
    expect(m.lines.map((l) => l.label)).toEqual([...m.lines].sort((a, b) => b.secs - a.secs).map((l) => l.label));
    expectConsistent(m);
    // The grouped rows are the three with the least time, and the combinations among them still count for the footnote.
    expect(other.secs).toBe(sum(m.lines.slice(8).map((l) => l.secs)));
  });

  it('keeps the sums of Exact and Billable for the table, per combination', () => {
    const m = tagShares([X('t1', 3600, ['design']), X('t2', 1800, ['design'])], TAGS);
    expect(m.lines[0]).toMatchObject({ label: 'Design', secs: 5400, exact: 5400, billableSecs: 5520, taskIds: ['t1', 't2'] });
  });

  it('is the same whatever order the tasks come in', () => {
    const tasks = [X('t1', 100, ['design']), X('t2', 100, ['client']), X('t3', 100, ['design', 'client']), X('t4', 100, [])];
    const a = tagShares(tasks, TAGS).rows.map((r) => [r.key, r.figure]);
    const b = tagShares([...tasks].reverse(), TAGS).rows.map((r) => [r.key, r.figure]);
    expect(b).toEqual(a);
  });

  it('opens its rows by the tasks they count', () => {
    const m = tagShares([X('t1', 100, ['design', 'client']), X('t2', 50, [])], TAGS);
    const ids = m.rows.map((r) => (r.kind === 'tag' ? r.taskIds : []));
    expect(ids).toEqual([['t1'], ['t2']]);
    expect(m.rows.map(spokenName)).toEqual([undefined, undefined]);
  });
});

describe('the colours that mark a tag row stay visible against the card', () => {
  it('keeps the grey of "No tag", the strong border of a striped swatch and the grey of Other at 3:1 on every theme’s card', () => {
    for (const [theme, tokens] of Object.entries(THEMES)) {
      expect(contrast(UNTAGGED_COLOR, tokens.surface), `${theme}: No tag on the card`).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens.borderStrong, tokens.surface), `${theme}: the swatch’s border`).toBeGreaterThanOrEqual(3);
    }
    expect(OTHER_COLOR).toBe('var(--border-strong)');
  });
});

describe('Other at each level', () => {
  it('is worded for what it adds up, never "(1 …)": a group has at least two rows', () => {
    expect(otherLabel(2, 'tasks')).toBe('Other (2 tasks)');
    expect(otherLabel(5, 'subtasks')).toBe('Other (5 subtasks)');
    expect(otherLabel(3, 'combinations')).toBe('Other (3 combinations)');
  });

  it('writes the note under the donut, and the tooltip of the slice, for each unit', () => {
    expect(otherNote(2, 'tasks')).toBe('Other adds up the 2 tasks with the least time. View data lists every task.');
    expect(otherNote(4, 'subtasks')).toBe('Other adds up the 4 subtasks with the least time. View data lists every subtask.');
    expect(otherNote(3, 'combinations')).toBe('Other adds up the 3 combinations with the least time. View data lists every combination.');
    expect(otherTip(2, 'tasks')).toBe('The 2 tasks with the least time. View data lists every task.');
    expect(otherTip(3, 'combinations')).toBe('The 3 combinations with the least time. View data lists every combination.');
  });

  it('is only ever the Projects level’s exception: it never groups', () => {
    const projects = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, color: '#2563eb', secs: 100 + i }));
    const m = projectShares(projects);
    expect(m.rows).toHaveLength(14);
    expect(m.rows.some((r) => r.kind === 'other')).toBe(false);
  });

  it('uses one separator for a tag combination and another for a path', () => {
    expect(TAG_SEPARATOR).toBe(' + ');
    expect(PATH_SEPARATOR).toBe(' > ');
  });
});
