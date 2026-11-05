// The "Share of time" card of the Projects section: the legend that writes every slice as text, the Projects / Tasks /
// Subtasks / Tags switch and the level the filter asks for, the View data table, drill-down from the legend and the
// slices, and Hide earnings, which must not touch it.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASK } from '../../lib/billing';
import { contrast } from '../../lib/color';
import { THEMES, applyTheme } from '../../lib/themes';
import { parseIso } from '../../lib/tz';
import type { Project, Snapshot, Theme } from '../../lib/types';
import { Donut, type Slice } from './charts';
import type { DrillSel } from './drill';
import { NO_FILTERS, type Filters } from './engine';
import { analyze, type Basis } from './metrics';
import type { RangeSpec } from './range';
import type { SecEnv } from './secenv';
import { Projects } from './SectionsA';
import type { ShareLevel } from './shareLevels';
import { mkSnapshot, params, toIso, type Spec } from './testkit';

const NOW = '2026-03-12T12:00:00Z';
const WEEK: RangeSpec = { kind: 'week', anchor: '2026-03-10' };
const MONTH: RangeSpec = { kind: 'month', anchor: '2026-03-10' };

const PROJECTS: (Partial<Project> & { id: string })[] = [
  { id: 'p-a', name: 'Alpha', color: '#2563eb' },
  { id: 'p-b', name: 'Beta', color: '#dc2626' },
  { id: 'p-c', name: 'Gamma', color: '#059669' },
];

/** One closed stretch of work on 10 March (UTC), from "09:00" to "10:05". */
const work = (taskId: string, from: string, to: string): NonNullable<Spec['segs']>[number] => [taskId, `2026-03-10T${from}:00Z`, `2026-03-10T${to}:00Z`];

/** Three projects with one task each and an hour of work apiece: three equal thirds. */
const THIRDS = mkSnapshot({
  now: NOW,
  projects: PROJECTS,
  tasks: [
    { id: 'a1', projectId: 'p-a' },
    { id: 'b1', projectId: 'p-b' },
    { id: 'g1', projectId: 'p-c' },
  ],
  segs: [work('a1', '09:00', '10:00'), work('b1', '11:00', '12:00'), work('g1', '13:00', '14:00')],
});

/** Alpha 1h 05m and Beta 40m, which round up to 1h 15m and 45m at the default 15 minutes. */
const ROUNDED = mkSnapshot({
  now: NOW,
  projects: PROJECTS.slice(0, 2),
  tasks: [
    { id: 'a1', projectId: 'p-a' },
    { id: 'b1', projectId: 'p-b' },
  ],
  segs: [work('a1', '09:00', '10:05'), work('b1', '11:00', '11:40')],
});

/** Twelve tasks, each on a day of its own: minutes of work per task, in a month. */
const MINUTES: [taskId: string, projectId: string, minutes: number][] = [
  ['a1', 'p-a', 120],
  ['a2', 'p-a', 90],
  ['a3', 'p-a', 60],
  ['a4', 'p-a', 45],
  ['a5', 'p-a', 30],
  ['b1', 'p-b', 100],
  ['b2', 'p-b', 75],
  ['b3', 'p-b', 50],
  ['b4', 'p-b', 20],
  ['g1', 'p-c', 80],
  ['g2', 'p-c', 40],
  ['g3', 'p-c', 10],
];
const TWELVE = mkSnapshot({
  now: NOW,
  projects: PROJECTS,
  tasks: MINUTES.map(([id, projectId]) => ({ id, projectId })),
  segs: MINUTES.map(([id, , minutes], i): NonNullable<Spec['segs']>[number] => {
    const start = parseIso(`2026-03-${String(i + 1).padStart(2, '0')}T09:00:00Z`);
    return [id, toIso(start), toIso(start + minutes * 60)];
  }),
});

/** Alpha with a task worked for an hour and another that only has a 30 minute billable pause. */
const PAUSE_ONLY = mkSnapshot({
  now: NOW,
  projects: PROJECTS.slice(0, 1),
  tasks: [
    { id: 'x', projectId: 'p-a' },
    { id: 'y', projectId: 'p-a' },
  ],
  segs: [work('x', '09:00', '10:00'), ['y', '2026-03-10T11:00:00Z', '2026-03-10T11:30:00Z', { kind: 'billablePause' }]],
});

/** The same snapshot with some tasks renamed (the builder names every task "Task <id>"). */
function renamed(snapshot: Snapshot, names: Readonly<Record<string, string>>): Snapshot {
  return { ...snapshot, tasks: snapshot.tasks.map((t) => ({ ...t, name: names[t.id] ?? t.name })) };
}

/** Alpha and Beta each have a task called "Meetings": 1h 30m in Alpha and 1h in Beta. */
const SAME_NAME = renamed(
  mkSnapshot({
    now: NOW,
    projects: PROJECTS.slice(0, 2),
    tasks: [
      { id: 'a1', projectId: 'p-a' },
      { id: 'b1', projectId: 'p-b' },
    ],
    segs: [work('a1', '09:00', '10:30'), work('b1', '11:00', '12:00')],
  }),
  { a1: 'Meetings', b1: 'Meetings' },
);

function envOf(snapshot: Snapshot, basis: Basis, range: RangeSpec = WEEK, hide = false, filters: Partial<Filters> = {}): SecEnv & { drill: ReturnType<typeof vi.fn<(sel: DrillSel) => void>> } {
  const projects = new Map(snapshot.projects.map((p) => [p.id, p]));
  const tasks = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const nowSec = parseIso(NOW);
  const m = analyze(snapshot, params('UTC', range, { filters: { ...NO_FILTERS, ...filters } }), nowSec, basis);
  return {
    m,
    snapshot,
    hide,
    nowSec,
    pname: (id) => projects.get(id)?.name ?? 'Unknown project',
    pcolor: (id) => projects.get(id)?.color ?? '#6b7280',
    tname: (id) => tasks.get(id)?.name ?? 'Unknown task',
    order: m.projects.map((p) => p.id),
    drill: vi.fn<(sel: DrillSel) => void>(),
    openGlossary: vi.fn(),
    jumps: { openProject: vi.fn(), openSettings: vi.fn() },
  };
}

const card = (): HTMLElement => screen.getByRole('heading', { name: 'Share of time' }).closest('article') as HTMLElement;
const legend = (kind: ShareLevel = 'projects'): HTMLElement => screen.getByRole('list', { name: `Share of time legend, ${kind}` });
const rowsOf = (kind: ShareLevel = 'projects'): HTMLElement[] => within(legend(kind)).getAllByRole('listitem');
const text = (el: Element, selector: string): string | undefined => el.querySelector(selector)?.textContent ?? undefined;
/** The figures of a legend, as written. */
const figures = (kind: ShareLevel = 'projects'): string[] => rowsOf(kind).map((li) => text(li, '.a-share-fig') ?? '');
/** The name each row is about: a task's own name, without the project that is written after it. */
const names = (kind: ShareLevel = 'projects'): string[] => rowsOf(kind).map((li) => text(li, '.a-share-task') ?? text(li, '.a-share-name') ?? '');
const centre = (): string | null => card().querySelector('.a-donut-total')?.textContent ?? null;
/** "16h 50m (47%)" is 1010 minutes and 47 percent. */
const minutesOf = (figure: string): number => {
  const m = /^(\d+)h (\d\d)m /.exec(figure);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
};
const percentOf = (figure: string): number => Number(/\((\d+)%\)$/.exec(figure)?.[1] ?? Number.NaN);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
/** The name of each row as it is written, a task's project included. */
const written = (kind: ShareLevel = 'projects'): string[] => rowsOf(kind).map((li) => text(li, '.a-share-name') ?? '');

/** The card on its Tasks view. */
async function showTasks(snapshot: Snapshot, basis: Basis = 'exact', range: RangeSpec = WEEK) {
  const user = userEvent.setup();
  const env = envOf(snapshot, basis, range);
  render(<Projects env={env} />);
  await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
  return { user, env };
}

/**
 * What a screen reader says for part of the page: the text in reading order, nothing for what is hidden from it, and
 * the label of anything that has one in place of what is inside it.
 */
function spoken(node: Node): string {
  if (node instanceof Text) return node.data;
  if (!(node instanceof HTMLElement) || node.getAttribute('aria-hidden') === 'true') return '';
  const label = node.getAttribute('aria-label');
  return label !== null ? ` ${label} ` : [...node.childNodes].map(spoken).join('');
}
const said = (el: Element): string => spoken(el).replace(/\s+/g, ' ').trim();

describe('the legend', () => {
  it('writes one row per project as text, in the structure the end-to-end tests rely on', () => {
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    const list = legend();
    expect(list).toHaveClass('a-share-legend');
    const rows = rowsOf();
    expect(rows).toHaveLength(3);
    for (const li of rows) {
      const swatch = li.querySelector('.a-share-swatch');
      expect(swatch).toHaveAttribute('aria-hidden', 'true');
      expect(li.querySelector('.a-share-name')).not.toBeNull();
      const fig = li.querySelector('.a-share-fig');
      expect(fig?.textContent).toBe(`${text(li, '.a-share-hm')} ${text(li, '.a-share-pct')}`);
    }
    expect(rows.map((li) => [text(li, '.a-share-name'), text(li, '.a-share-fig'), text(li, '.a-share-hm'), text(li, '.a-share-pct')])).toEqual([
      ['Alpha', '1h 00m (34%)', '1h 00m', '(34%)'],
      ['Beta', '1h 00m (33%)', '1h 00m', '(33%)'],
      ['Gamma', '1h 00m (33%)', '1h 00m', '(33%)'],
    ]);
    // The swatch is the project’s own colour.
    expect((rows[0]?.querySelector('.a-share-swatch') as HTMLElement).style.backgroundColor).toBe('rgb(37, 99, 235)');
  });

  it('adds three equal thirds up to 100%, and the rows up to the total in the middle of the donut', () => {
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    expect(sum(figures().map(percentOf))).toBe(100);
    expect(centre()).toBe('3h 00m');
    expect(sum(figures().map(minutesOf))).toBe(180);
  });

  it('gives a long name an ellipsis and the whole name as its title', () => {
    const long = 'Customer churn prediction model for the retention team, second round';
    const snapshot = mkSnapshot({ now: NOW, projects: [{ id: 'p-a', name: long, color: '#2563eb' }], tasks: [{ id: 'a1', projectId: 'p-a' }], segs: [work('a1', '09:00', '10:00')] });
    render(<Projects env={envOf(snapshot, 'exact')} />);
    const name = rowsOf()[0]?.querySelector('.a-share-name');
    expect(name?.getAttribute('title')).toBe(long);
    expect(name?.textContent).toBe(long);
  });

  it('follows the Billable and Exact switch: the figures change where rounding makes them differ', () => {
    const { rerender } = render(<Projects env={envOf(ROUNDED, 'billable')} />);
    expect(figures()).toEqual(['1h 15m (63%)', '0h 45m (37%)']);
    expect(centre()).toBe('2h 00m');
    expect(card()).toHaveTextContent('Billable');
    rerender(<Projects env={envOf(ROUNDED, 'exact')} />);
    expect(figures()).toEqual(['1h 05m (62%)', '0h 40m (38%)']);
    expect(centre()).toBe('1h 45m');
    expect(card().querySelector('svg')).toHaveTextContent('Exact');
  });

  it('shows no legend, only the empty message, when nothing is logged, and keeps the switch', () => {
    render(<Projects env={envOf(mkSnapshot({ now: NOW, projects: PROJECTS, tasks: [], segs: [] }), 'exact')} />);
    expect(within(card()).getByText(/No time logged in this period/)).toBeVisible();
    expect(screen.queryByRole('list', { name: /Share of time legend/ })).toBeNull();
    expect(within(card()).getByRole('radiogroup', { name: 'Share of time by' })).toBeVisible();
  });
});

describe('Hide earnings', () => {
  it('leaves the legend and the donut as they are: hours are not earnings', () => {
    const snapshot: Snapshot = { ...ROUNDED, prefs: { ...ROUNDED.prefs, hideEarnings: true } };
    render(<Projects env={envOf(snapshot, 'billable', WEEK, true)} />);
    expect(legend()).toBeVisible();
    expect(figures()).toEqual(['1h 15m (63%)', '0h 45m (37%)']);
    expect(card()).not.toHaveTextContent(MASK);
    expect(centre()).toBe('2h 00m');
  });

  it('does the same in the Tasks view', async () => {
    const user = userEvent.setup();
    const snapshot: Snapshot = { ...ROUNDED, prefs: { ...ROUNDED.prefs, hideEarnings: true } };
    render(<Projects env={envOf(snapshot, 'billable', WEEK, true)} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    expect(figures('tasks')).toEqual(['1h 15m (63%)', '0h 45m (37%)']);
    expect(card()).not.toHaveTextContent(MASK);
  });
});

describe('the Projects / Tasks switch', () => {
  it('starts on Projects, shows each task’s share on Tasks and comes back', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    const group = within(card()).getByRole('radiogroup', { name: 'Share of time by' });
    const projects = within(group).getByRole('radio', { name: 'Projects' });
    const tasks = within(group).getByRole('radio', { name: 'Tasks' });
    expect(projects).toHaveAttribute('aria-checked', 'true');
    expect(tasks).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('img', { name: 'Share of time per project' })).toBeInTheDocument();

    await user.click(tasks);
    expect(tasks).toHaveAttribute('aria-checked', 'true');
    expect(projects).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('list', { name: 'Share of time legend, projects' })).toBeNull();
    expect(names('tasks')).toEqual(['Task a1', 'Task b1', 'Task g1']);
    expect(screen.getByRole('img', { name: 'Share of time per task' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Share of time per project' })).toBeNull();

    await user.click(projects);
    expect(names('projects')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(screen.getByRole('img', { name: 'Share of time per project' })).toBeInTheDocument();
  });

  it('moves with the arrow keys like the other segmented controls, with one tab stop', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    const group = within(card()).getByRole('radiogroup', { name: 'Share of time by' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    radios[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: 'Tasks' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'Tasks' })).toHaveFocus();
    expect(legend('tasks')).toBeVisible();
    await user.keyboard('{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: 'Projects' })).toHaveAttribute('aria-checked', 'true');
  });

  it('changes the View data table: project columns first, then one row per task with its own columns', async () => {
    const user = userEvent.setup();
    // Two columns called "Exact" used to share a React key, which left a stale header cell behind when the columns changed.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<Projects env={envOf(TWELVE, 'exact', MONTH)} />);
    await user.click(within(card()).getByText('View data'));
    let table = await within(card()).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Project', 'Exact', 'Share', 'Exact', 'Billable', 'Tasks', 'Average per task', 'Change vs previous', 'Pricing']);
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3);

    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    table = await within(card()).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Task', 'Project', 'Exact', 'Share', 'Exact', 'Billable']);
    // Every task, not the nine of the legend.
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 12);
    const first = within(within(table).getAllByRole('row')[1] as HTMLElement).getAllByRole('cell');
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Task a1');
    expect(first.map((c) => c.textContent)).toEqual(['Alpha', '2:00:00', '16.7%', '2:00:00', '2:00:00']);
    expect(within(card()).getByText('Task time', { selector: 'caption' })).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('headlines the column of the basis in use: Billable when Billable is on', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(ROUNDED, 'billable')} />);
    await user.click(within(card()).getByText('View data'));
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    const table = await within(card()).findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Task', 'Project', 'Billable', 'Share', 'Exact', 'Billable']);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('1:15:00');
  });
});

describe('the Tasks view', () => {
  async function tasksView(basis: Basis = 'exact') {
    const user = userEvent.setup();
    const env = envOf(TWELVE, basis, MONTH);
    render(<Projects env={env} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    return { user, env };
  }

  it('groups the shown tasks by project and the rest as "Other (4 tasks)", last', async () => {
    await tasksView();
    // Alpha has the most time (345 min with its grouped task), then Beta (245), then Gamma (130).
    expect(names('tasks')).toEqual(['Task a1', 'Task a2', 'Task a3', 'Task a4', 'Task b1', 'Task b2', 'Task b3', 'Task g1', 'Other (4 tasks)']);
    expect(figures('tasks').at(-1)).toMatch(/^1h 40m \(14%\)$/);
  });

  it('adds up to 100% and to the total in the middle, Other included', async () => {
    await tasksView();
    expect(centre()).toBe('12h 00m');
    expect(sum(figures('tasks').map(percentOf))).toBe(100);
    expect(sum(figures('tasks').map(minutesOf))).toBe(720);
  });

  it('says what Other is made of, and cannot be opened', async () => {
    const { user, env } = await tasksView();
    const other = rowsOf('tasks').at(-1) as HTMLElement;
    expect(other).toHaveTextContent('Other (4 tasks)');
    expect(within(other).queryByRole('button')).toBeNull();
    expect(said(other)).toBe('Other (4 tasks) 1h 40m (14%)');
    // Its colour is the strong border token, a grey every theme defines, not one of the project shades.
    expect(other.querySelector('.a-share-swatch')?.getAttribute('style')).toContain('var(--border-strong)');
    await user.click(other);
    expect(env.drill).not.toHaveBeenCalled();
    expect(within(card()).getByText('Other adds up the 4 tasks with the least time. View data lists every task.')).toBeVisible();
  });

  it('draws a project’s only shown task in the project’s colour and its several tasks in different shades', async () => {
    await tasksView();
    const swatches = rowsOf('tasks').map((li) => (li.querySelector('.a-share-swatch') as HTMLElement).style.backgroundColor);
    // g1 is Gamma’s only shown task; Alpha’s four and Beta’s three are all different.
    expect(swatches[7]).toBe('rgb(5, 150, 105)');
    expect(new Set(swatches.slice(0, 4)).size).toBe(4);
    expect(new Set(swatches.slice(4, 7)).size).toBe(3);
    expect(new Set(swatches).size).toBe(9);
  });

  it('shows nine tasks or fewer without an Other row', async () => {
    const user = userEvent.setup();
    const nine = mkSnapshot({
      now: NOW,
      projects: PROJECTS,
      tasks: MINUTES.slice(0, 9).map(([id, projectId]) => ({ id, projectId })),
      segs: MINUTES.slice(0, 9).map(([id, , minutes], i): NonNullable<Spec['segs']>[number] => {
        const start = parseIso(`2026-03-${String(i + 1).padStart(2, '0')}T09:00:00Z`);
        return [id, toIso(start), toIso(start + minutes * 60)];
      }),
    });
    render(<Projects env={envOf(nine, 'exact', MONTH)} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    expect(rowsOf('tasks')).toHaveLength(9);
    expect(names('tasks').some((n) => n.startsWith('Other'))).toBe(false);
  });

  it('puts the centre of the view at the sum of its slices, which is not the projects’ when a task has only a billable pause', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(PAUSE_ONLY, 'billable')} />);
    // Projects: Alpha has the hour worked on x and the 30 minute pause on y.
    expect(centre()).toBe('1h 30m');
    expect(figures()).toEqual(['1h 30m (100%)']);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    // Tasks: y has no worked time in the period, so it has no task row and no slice.
    expect(centre()).toBe('1h 00m');
    expect(figures('tasks')).toEqual(['1h 00m (100%)']);
    expect(names('tasks')).toEqual(['Task x']);
  });
});

describe('opening the time behind a slice', () => {
  it('opens a project from its legend row, by mouse and by keyboard', async () => {
    const user = userEvent.setup();
    const env = envOf(THIRDS, 'exact');
    render(<Projects env={env} />);
    await user.click(within(legend()).getByRole('button', { name: 'Beta' }));
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Beta', projectId: 'p-b' });
    // The whole row opens it, not only the name.
    await user.click(rowsOf()[2]?.querySelector('.a-share-fig') as HTMLElement);
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Gamma', projectId: 'p-c' });

    within(card()).getByRole('radio', { name: 'Projects' }).focus();
    await user.tab();
    expect(within(legend()).getByRole('button', { name: 'Alpha' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Alpha', projectId: 'p-a' });
    await user.tab();
    await user.keyboard(' ');
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Beta', projectId: 'p-b' });
    expect(env.drill).toHaveBeenCalledTimes(4);
  });

  it('opens a task from the Tasks legend, and names the project in the button’s name', async () => {
    const user = userEvent.setup();
    const env = envOf(THIRDS, 'exact');
    render(<Projects env={env} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    await user.click(within(legend('tasks')).getByRole('button', { name: 'Task g1, project Gamma' }));
    expect(env.drill).toHaveBeenCalledOnce();
    expect(env.drill).toHaveBeenCalledWith({ title: 'Task g1', taskId: 'g1' });
  });

  it('opens from a slice too, with a label that says the figure the legend shows', async () => {
    const user = userEvent.setup();
    const env = envOf(THIRDS, 'exact');
    render(<Projects env={env} />);
    const slice = within(screen.getByRole('img', { name: 'Share of time per project' })).getByRole('button', { name: 'Alpha: 1h 00m (34%)' });
    // The legend is the way in by keyboard, so the slices are not tab stops.
    expect(slice).toHaveAttribute('tabindex', '-1');
    await user.click(slice);
    expect(env.drill).toHaveBeenCalledWith({ title: 'Alpha', projectId: 'p-a' });
  });

  it('opens a task from its slice in the Tasks view', async () => {
    const user = userEvent.setup();
    const env = envOf(THIRDS, 'exact');
    render(<Projects env={env} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    await user.click(within(screen.getByRole('img', { name: 'Share of time per task' })).getByRole('button', { name: 'Beta > Task b1: 1h 00m (33%)' }));
    expect(env.drill).toHaveBeenCalledWith({ title: 'Task b1', taskId: 'b1' });
  });
});

describe('tooltips', () => {
  it('say the figure of the legend, not a second rounding of it', () => {
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    const slice = within(screen.getByRole('img', { name: 'Share of time per project' })).getByRole('button', { name: 'Alpha: 1h 00m (34%)' });
    fireEvent.pointerMove(slice, { clientX: 30, clientY: 30 });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Alpha');
    expect(tip).toHaveTextContent('Exact: 1h 00m (34%)');
    expect(tip).toHaveTextContent('To the second: 1:00:00');
    // The old tooltip spelled the share with a decimal, which would now disagree with the legend.
    expect(tip).not.toHaveTextContent('33.3%');
  });

  it('name the other basis where it is available, and the project on a task', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(ROUNDED, 'billable')} />);
    await user.click(within(card()).getByRole('radio', { name: 'Tasks' }));
    fireEvent.pointerMove(within(screen.getByRole('img', { name: 'Share of time per task' })).getByRole('button', { name: 'Alpha > Task a1: 1h 15m (63%)' }), { clientX: 10, clientY: 10 });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Project: Alpha');
    expect(tip).toHaveTextContent('Billable: 1h 15m (63%)');
    expect(tip).toHaveTextContent('Exact 1h 05m');
  });
});

describe('two tasks with the same name in different projects', () => {
  it('are told apart by the project written after the task name, in the row and in its title', async () => {
    const { user } = await showTasks(SAME_NAME);
    const rows = rowsOf('tasks');
    expect(rows).toHaveLength(2);
    // The task name alone and the project alone can each be read.
    expect(rows.map((li) => text(li, '.a-share-task'))).toEqual(['Meetings', 'Meetings']);
    expect(rows.map((li) => text(li, '.a-share-project'))).toEqual(['Alpha', 'Beta']);
    // What the eye reads in the row, and what a hover shows once the row is too narrow for it.
    expect(written('tasks')).toEqual(['Meetings · Alpha', 'Meetings · Beta']);
    expect(rows.map((li) => li.querySelector('.a-share-name')?.getAttribute('title'))).toEqual(['Alpha > Meetings', 'Beta > Meetings']);
    expect(new Set(rows.map((li) => li.textContent)).size).toBe(2);
    // The figure column is still the hours and the percentage, and nothing else.
    expect(figures('tasks')).toEqual(['1h 30m (60%)', '1h 00m (40%)']);

    // The Projects view is as it was: the project's name alone.
    await user.click(within(card()).getByRole('radio', { name: 'Projects' }));
    expect(written('projects')).toEqual(['Alpha', 'Beta']);
    expect(legend('projects').querySelector('.a-share-task, .a-share-sep, .a-share-project')).toBeNull();
  });

  it('keep the task name first and in one line with its project, so a narrow row cuts the project before the name', async () => {
    await showTasks(SAME_NAME);
    for (const li of rowsOf('tasks')) {
      const parts = [...(li.querySelector('.a-share-name') as HTMLElement).querySelectorAll('.a-share-task, .a-share-sep, .a-share-project')];
      expect(parts.map((p) => p.className)).toEqual(['a-share-task', 'a-share-sep', 'a-share-project']);
      // The dot between them is decoration, and a screen reader skips it.
      expect(parts[1]).toHaveAttribute('aria-hidden', 'true');
    }
  });
});

describe('what a screen reader says for a legend row', () => {
  it('names a button after the task and its project, or after the project alone, and never the figures', async () => {
    const { user } = await showTasks(SAME_NAME);
    const tasks = within(legend('tasks'));
    expect(tasks.getByRole('button', { name: 'Meetings, project Alpha' })).toBeVisible();
    expect(tasks.getByRole('button', { name: 'Meetings, project Beta' })).toBeVisible();
    expect(tasks.queryAllByRole('button', { name: /\d|%/ })).toEqual([]);

    await user.click(within(card()).getByRole('radio', { name: 'Projects' }));
    const projects = within(legend('projects'));
    expect(projects.getByRole('button', { name: 'Alpha' })).toBeVisible();
    expect(projects.getByRole('button', { name: 'Beta' })).toBeVisible();
    expect(projects.queryAllByRole('button', { name: /\d|%/ })).toEqual([]);
  });

  it('reads each row as the name, the project and the figure, each said once and in that order', async () => {
    const { user } = await showTasks(SAME_NAME);
    expect(rowsOf('tasks').map(said)).toEqual(['Meetings, project Alpha 1h 30m (60%)', 'Meetings, project Beta 1h 00m (40%)']);
    await user.click(within(card()).getByRole('radio', { name: 'Projects' }));
    expect(rowsOf('projects').map(said)).toEqual(['Alpha 1h 30m (60%)', 'Beta 1h 00m (40%)']);
  });
});

describe('keyboard focus on a legend row', () => {
  const read = (file: string): string => readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
  /**
   * What the browser has when the card is on screen: the shared base rules, then the Analysis rules. jsdom works out
   * :focus-visible from the history of events, which a synthetic Tab does not give it reliably, so here the rules say
   * `.fv` where they say :focus-visible, and the button the keyboard has reached gets that class.
   */
  const STYLES = `${read('../../styles/base.css')}\n${read('./analysis.css')}`.replaceAll(':focus-visible', '.fv');
  let sheet: HTMLStyleElement;
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = STYLES;
    document.head.append(sheet);
  });
  afterEach(() => sheet.remove());

  /** Renders the card, moves to a view with the arrow keys, and tabs from the switch to the first button of the legend. */
  async function tabToLegend(view: 'Projects' | 'Tasks'): Promise<HTMLElement> {
    const user = userEvent.setup();
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    within(card()).getByRole('radio', { name: 'Projects' }).focus();
    if (view === 'Tasks') await user.keyboard('{ArrowRight}');
    await user.tab();
    const button = document.activeElement;
    if (!(button instanceof HTMLButtonElement)) throw new Error('Tab did not reach a button');
    expect(legend(view === 'Tasks' ? 'tasks' : 'projects')).toContainElement(button);
    button.classList.add('fv');
    return button;
  }

  /** The outline of a focused button: width and offset in pixels, and the colour as written (a token such as `var(--focus)`). */
  function ringOf(button: HTMLElement): { width: number; offset: number; color: string } | null {
    const { outline, outlineOffset } = getComputedStyle(button);
    const m = /^(\d+(?:\.\d+)?)px solid (.+)$/.exec(outline);
    return m ? { width: Number(m[1]), offset: Number.parseFloat(outlineOffset) || 0, color: m[2] ?? '' } : null;
  }

  /** The boxes between a button and its row that cut off whatever is drawn outside the button. */
  function clippersAround(button: HTMLElement): string[] {
    const row = button.closest('li');
    const found: string[] = [];
    for (let box = button.parentElement; box !== null && box !== row; box = box.parentElement) {
      const { overflow } = getComputedStyle(box);
      if (overflow !== '' && overflow !== 'visible') found.push(`.${box.className} has overflow: ${overflow}`);
    }
    return found;
  }

  /** The ring a keyboard user sees: none when it is drawn outside the button and a box around the button clips it. */
  function visibleRing(button: HTMLElement): ReturnType<typeof ringOf> {
    const ring = ringOf(button);
    const outside = ring !== null && ring.width + ring.offset > 0;
    return outside && clippersAround(button).length > 0 ? null : ring;
  }

  it.each(['Projects', 'Tasks'] as const)('shows the ring of the focused button in the %s view: nothing around the button clips it away', async (view) => {
    const button = await tabToLegend(view);
    // The name cell used to cut the ring off: it is drawn outside the button, and the cell clips whatever is outside its box, so only the row's grey background showed.
    expect(visibleRing(button), `outline ${JSON.stringify(ringOf(button))}, clipped by ${clippersAround(button).join(', ') || 'nothing'}`).not.toBeNull();
  });

  it('draws the ring in the focus colour, 2px or wider, and every theme keeps that colour at 3:1 on the card and on the highlighted row', async () => {
    const ring = visibleRing(await tabToLegend('Projects'));
    expect(ring?.color).toBe('var(--focus)');
    expect(ring?.width).toBeGreaterThanOrEqual(2);
    const root = document.createElement('div');
    for (const theme of Object.keys(THEMES) as Theme[]) {
      applyTheme(theme, root);
      const focus = root.style.getPropertyValue('--focus');
      expect(contrast(focus, THEMES[theme].surface), `${theme}: the ring on the card`).toBeGreaterThanOrEqual(3);
      expect(contrast(focus, THEMES[theme].surfaceAlt), `${theme}: the ring on the highlighted row`).toBeGreaterThanOrEqual(3);
    }
  });

  it('mutes the project after a task, and writes it in the full text colour on the highlighted row', async () => {
    await tabToLegend('Tasks');
    const [focused, other] = rowsOf('tasks').map((li) => li.querySelector('.a-share-project') as HTMLElement);
    expect(getComputedStyle(other as HTMLElement).color).toBe('var(--text-muted)');
    expect(getComputedStyle(focused as HTMLElement).color).toBe('var(--text)');
    // Muted text is 4.5:1 on the card in every theme, but only 4.4:1 and 4.1:1 on the highlighted row in the two Solarized themes.
    for (const theme of Object.keys(THEMES) as Theme[]) {
      expect(contrast(THEMES[theme].textMuted, THEMES[theme].surface), `${theme}: muted on the card`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(THEMES[theme].text, THEMES[theme].surfaceAlt), `${theme}: text on the highlighted row`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// ---------------------------------------------------------------------------------------------- four levels

/**
 * Alpha has Logo (Moodboard 60 min, Sketches 30, none 30; tagged Design) and Pitch (20 min, no tag and no list). Beta has
 * Site (Copy 45, none 15; tagged Client then Design, which the Settings list reads Design then Client).
 */
const LEVELS = mkSnapshot({
  now: NOW,
  projects: PROJECTS.slice(0, 2),
  tags: [
    { id: 't-d', name: 'Design', color: '#7c3aed' },
    { id: 't-c', name: 'Client', color: '#0f766e' },
  ],
  tasks: [
    { id: 'a1', projectId: 'p-a', name: 'Logo', tags: ['t-d'], subtasks: [{ id: 'mood', text: 'Moodboard' }, { id: 'sk', text: 'Sketches' }] },
    { id: 'a2', projectId: 'p-a', name: 'Pitch' },
    { id: 'b1', projectId: 'p-b', name: 'Site', tags: ['t-c', 't-d'], subtasks: [{ id: 'copy', text: 'Copy' }] },
  ],
  segs: [
    ['a1', '2026-03-10T09:00:00Z', '2026-03-10T10:00:00Z', { subtaskId: 'mood' }],
    ['a1', '2026-03-10T11:00:00Z', '2026-03-10T11:30:00Z', { subtaskId: 'sk' }],
    ['a1', '2026-03-10T12:00:00Z', '2026-03-10T12:30:00Z'],
    ['a2', '2026-03-10T15:00:00Z', '2026-03-10T15:20:00Z'],
    ['b1', '2026-03-10T13:00:00Z', '2026-03-10T13:45:00Z', { subtaskId: 'copy' }],
    ['b1', '2026-03-10T14:00:00Z', '2026-03-10T14:15:00Z'],
  ],
});

const radio = (name: string): HTMLElement => within(card()).getByRole('radio', { name });
const checkedRadio = (): string | undefined => within(card()).getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? undefined;
const dotted = (level: ShareLevel): string[][] => rowsOf(level).map((li) => [text(li, '.a-share-task') ?? text(li, '.a-share-name') ?? '', ...[...li.querySelectorAll('.a-share-project')].map((e) => e.textContent ?? '')]);

describe('the four segments', () => {
  it('are Projects, Tasks, Subtasks and Tags, with Projects on at first', () => {
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    const radios = within(within(card()).getByRole('radiogroup', { name: 'Share of time by' })).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Projects', 'Tasks', 'Subtasks', 'Tags']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false']);
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });

  it('switches Subtasks off, with a tooltip, while no time is logged on a subtask', () => {
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    const subtasks = radio('Subtasks');
    expect(subtasks).toBeDisabled();
    expect(subtasks).toHaveAttribute('title', 'No subtask time in this period');
    expect(subtasks).toHaveAttribute('aria-checked', 'false');
    expect(radio('Projects')).toBeEnabled();
    expect(radio('Tasks')).toBeEnabled();
    expect(radio('Tags')).toBeEnabled();
    expect(radio('Tags')).not.toHaveAttribute('title');
  });

  it('switches Subtasks on when time is logged on one', () => {
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    expect(radio('Subtasks')).toBeEnabled();
    expect(radio('Subtasks')).not.toHaveAttribute('title');
  });

  it('skips the switched-off segment with the arrow keys and never lands on it', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    radio('Projects').focus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Tasks')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(radio('Tags')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Tags')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Projects')).toHaveAttribute('aria-checked', 'true');
    await user.click(radio('Subtasks'));
    expect(radio('Projects')).toHaveAttribute('aria-checked', 'true');
  });

  it('name the donut and the legend for each level', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    for (const [name, level, noun] of [['Projects', 'projects', 'project'], ['Tasks', 'tasks', 'task'], ['Subtasks', 'subtasks', 'subtask'], ['Tags', 'tags', 'tag']] as const) {
      await user.click(radio(name));
      expect(radio(name)).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('img', { name: `Share of time per ${noun}` })).toBeInTheDocument();
      expect(legend(level)).toBeVisible();
      expect(screen.getAllByRole('list', { name: /^Share of time legend/ })).toHaveLength(1);
    }
  });

  it('keeps the same total in the middle at every level', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    const centres: (string | null)[] = [];
    for (const name of ['Projects', 'Tasks', 'Subtasks', 'Tags']) {
      await user.click(radio(name));
      centres.push(centre());
    }
    expect(centres).toEqual(['3h 20m', '3h 20m', '3h 20m', '3h 20m']);
  });
});

describe('the level the filter asks for', () => {
  const at = (filters: Partial<Filters>) => envOf(LEVELS, 'exact', WEEK, false, filters);

  it('starts on Projects with no filter and with several projects', () => {
    render(<Projects env={at({})} />);
    expect(checkedRadio()).toBe('Projects');
  });

  it('starts on Projects with several projects chosen', () => {
    render(<Projects env={at({ projectIds: ['p-a', 'p-b'] })} />);
    expect(checkedRadio()).toBe('Projects');
  });

  it('starts on Tasks with one project chosen, and the rows name the task alone', () => {
    render(<Projects env={at({ projectIds: ['p-a'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    expect(dotted('tasks')).toEqual([['Logo'], ['Pitch']]);
    expect(figures('tasks')).toEqual(['2h 00m (86%)', '0h 20m (14%)']);
  });

  it('starts on Subtasks with one task chosen, and the rows name the subtask alone', () => {
    render(<Projects env={at({ taskIds: ['a1'] })} />);
    expect(checkedRadio()).toBe('Subtasks');
    expect(dotted('subtasks')).toEqual([['Moodboard'], ['Sketches'], ['Logo (no subtask)']]);
    expect(figures('subtasks')).toEqual(['1h 00m (50%)', '0h 30m (25%)', '0h 30m (25%)']);
  });

  it('starts on Subtasks with one task and its one project', () => {
    render(<Projects env={at({ projectIds: ['p-a'], taskIds: ['a1'] })} />);
    expect(checkedRadio()).toBe('Subtasks');
  });

  it('moves with the filter while nothing has been picked: none, one project, one task, and back', () => {
    const { rerender } = render(<Projects env={at({})} />);
    expect(checkedRadio()).toBe('Projects');
    rerender(<Projects env={at({ projectIds: ['p-a'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    rerender(<Projects env={at({ projectIds: ['p-a'], taskIds: ['a1'] })} />);
    expect(checkedRadio()).toBe('Subtasks');
    rerender(<Projects env={at({ projectIds: ['p-a'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    rerender(<Projects env={at({})} />);
    expect(checkedRadio()).toBe('Projects');
  });

  it('keeps a level the user picked through every later change of the default, however many there are', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Projects env={at({})} />);
    await user.click(radio('Tags'));
    // The default goes to Tasks, Subtasks, Tasks, Projects and Projects again. The pick used to give way at the second change.
    const steps: Partial<Filters>[] = [{ projectIds: ['p-a'] }, { projectIds: ['p-a'], taskIds: ['a1'] }, { projectIds: ['p-a'] }, {}, { projectIds: ['p-a', 'p-b'] }];
    for (const filters of steps) {
      rerender(<Projects env={at(filters)} />);
      expect(checkedRadio()).toBe('Tags');
    }
  });

  it('follows the filter until the first pick, and stops following it from then on', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Projects env={at({})} />);
    expect(checkedRadio()).toBe('Projects');
    rerender(<Projects env={at({ projectIds: ['p-a'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    rerender(<Projects env={at({ projectIds: ['p-a'], taskIds: ['a1'] })} />);
    expect(checkedRadio()).toBe('Subtasks');
    rerender(<Projects env={at({ projectIds: ['p-a'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    await user.click(radio('Projects'));
    const later: Partial<Filters>[] = [{ taskIds: ['a1'] }, { projectIds: ['p-b'] }, { projectIds: ['p-b'], taskIds: ['b1'] }, {}];
    for (const filters of later) {
      rerender(<Projects env={at(filters)} />);
      expect(checkedRadio()).toBe('Projects');
    }
    // Only the user moves it, and that pick holds in the same way.
    await user.click(radio('Tasks'));
    rerender(<Projects env={at({ projectIds: ['p-a', 'p-b'] })} />);
    expect(checkedRadio()).toBe('Tasks');
  });

  it('holds a pick of the level the filter already asked for, like a pick of any other', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Projects env={at({ projectIds: ['p-a'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    await user.click(radio('Tasks'));
    rerender(<Projects env={at({})} />);
    expect(checkedRadio()).toBe('Tasks');
    rerender(<Projects env={at({ taskIds: ['a1'] })} />);
    expect(checkedRadio()).toBe('Tasks');
  });

  it('does not lose a picked level to a change that leaves the default where it was', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Projects env={at({})} />);
    await user.click(radio('Tags'));
    for (const tagIds of [['t-d'], ['t-d', 't-c'], []]) rerender(<Projects env={at({ tagIds })} />);
    expect(checkedRadio()).toBe('Tags');
    rerender(<Projects env={envOf(LEVELS, 'exact', MONTH)} />);
    expect(checkedRadio()).toBe('Tags');
  });

  it('falls back to the default level when the level shown has no rows left, and switches Subtasks off', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Projects env={at({})} />);
    await user.click(radio('Subtasks'));
    expect(checkedRadio()).toBe('Subtasks');
    // Pitch has no subtask time: the filter asks for Subtasks, which is empty, so the card shows Tasks.
    rerender(<Projects env={at({ taskIds: ['a2'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    expect(radio('Subtasks')).toBeDisabled();
    expect(radio('Subtasks')).toHaveAttribute('title', 'No subtask time in this period');
    expect(names('tasks')).toEqual(['Pitch']);
    expect(screen.queryByRole('list', { name: 'Share of time legend, subtasks' })).toBeNull();
  });

  it('draws another level while the picked one has nothing to show, and goes back to the pick when its time returns', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Projects env={at({})} />);
    await user.click(radio('Subtasks'));
    // Pitch has no subtask time: Subtasks is switched off and Tasks is drawn instead, but the pick is not given up.
    rerender(<Projects env={at({ taskIds: ['a2'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    expect(radio('Subtasks')).toBeDisabled();
    expect(radio('Subtasks')).toHaveAttribute('title', 'No subtask time in this period');
    // Beta's Site has time on a subtask. The filter now asks for Tasks, and still the pick is what is drawn.
    rerender(<Projects env={at({ projectIds: ['p-b'] })} />);
    expect(checkedRadio()).toBe('Subtasks');
    expect(radio('Subtasks')).toBeEnabled();
    expect(names('subtasks')).toEqual(['Copy', 'Site (no subtask)']);
  });

  it('shows Subtasks again when the time comes back, if that is still the level asked for', () => {
    const { rerender } = render(<Projects env={at({ taskIds: ['a2'] })} />);
    expect(checkedRadio()).toBe('Tasks');
    rerender(<Projects env={at({ taskIds: ['a1'] })} />);
    expect(checkedRadio()).toBe('Subtasks');
  });

  it('lets the user pick a level by hand over the default', async () => {
    const user = userEvent.setup();
    render(<Projects env={at({ projectIds: ['p-a'] })} />);
    await user.click(radio('Projects'));
    expect(checkedRadio()).toBe('Projects');
    expect(names('projects')).toEqual(['Alpha']);
  });
});

describe('what a row says: only what the filter leaves open', () => {
  it('Tasks with several projects in the data: the task, then its project in muted text', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    await user.click(radio('Tasks'));
    // Grouped by project, the project with the most time first.
    expect(dotted('tasks')).toEqual([['Logo', 'Alpha'], ['Pitch', 'Alpha'], ['Site', 'Beta']]);
    expect(written('tasks')).toEqual(['Logo · Alpha', 'Pitch · Alpha', 'Site · Beta']);
  });

  it('Tasks with one project in the data: the task alone, with the whole path still in the title, the button and the slice', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact', WEEK, false, { projectIds: ['p-a'] })} />);
    expect(written('tasks')).toEqual(['Logo', 'Pitch']);
    expect(legend('tasks').querySelector('.a-share-sep, .a-share-project')).toBeNull();
    expect(rowsOf('tasks').map((li) => li.querySelector('.a-share-name')?.getAttribute('title'))).toEqual(['Alpha > Logo', 'Alpha > Pitch']);
    expect(within(legend('tasks')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Logo, project Alpha', 'Pitch, project Alpha']);
    expect(rowsOf('tasks').map(said)).toEqual(['Logo, project Alpha 2h 00m (86%)', 'Pitch, project Alpha 0h 20m (14%)']);
    expect(within(screen.getByRole('img', { name: 'Share of time per task' })).getByRole('button', { name: 'Alpha > Logo: 2h 00m (86%)' })).toBeInTheDocument();
    // The tooltip names the project too.
    fireEvent.pointerMove(within(screen.getByRole('img', { name: 'Share of time per task' })).getByRole('button', { name: 'Alpha > Logo: 2h 00m (86%)' }), { clientX: 10, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Project: Alpha');
    await user.click(radio('Projects'));
    expect(written('projects')).toEqual(['Alpha']);
  });

  it('Subtasks of one task: the subtask alone, and the task’s time on none as "<Task> (no subtask)"', () => {
    render(<Projects env={envOf(LEVELS, 'exact', WEEK, false, { taskIds: ['a1'] })} />);
    expect(written('subtasks')).toEqual(['Moodboard', 'Sketches', 'Logo (no subtask)']);
    expect(rowsOf('subtasks').map((li) => li.querySelector('.a-share-name')?.getAttribute('title'))).toEqual(['Alpha > Logo > Moodboard', 'Alpha > Logo > Sketches', 'Alpha > Logo > (no subtask)']);
    expect(within(legend('subtasks')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Moodboard, task Logo, project Alpha',
      'Sketches, task Logo, project Alpha',
      'Logo (no subtask), project Alpha',
    ]);
    expect(rowsOf('subtasks').map(said)[0]).toBe('Moodboard, task Logo, project Alpha 1h 00m (50%)');
    expect(within(screen.getByRole('img', { name: 'Share of time per subtask' })).getByRole('button', { name: 'Alpha > Logo > Sketches: 0h 30m (25%)' })).toBeInTheDocument();
  });

  it('Subtasks across the tasks of one project: the subtask, then its task', () => {
    render(<Projects env={envOf(LEVELS, 'exact', WEEK, false, { projectIds: ['p-a'], taskIds: [] })} />);
    // One project chosen starts on Tasks; the user moves to Subtasks.
    act(() => radio('Subtasks').click());
    expect(dotted('subtasks')).toEqual([['Moodboard', 'Logo'], ['Sketches', 'Logo'], ['Logo (no subtask)'], ['Pitch (no subtask)']]);
  });

  it('Subtasks across several projects: the subtask, then its task, then its project; the row for none names its project only', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    await user.click(radio('Subtasks'));
    expect(dotted('subtasks')).toEqual([
      ['Moodboard', 'Logo', 'Alpha'],
      ['Sketches', 'Logo', 'Alpha'],
      ['Logo (no subtask)', 'Alpha'],
      ['Pitch (no subtask)', 'Alpha'],
      ['Copy', 'Site', 'Beta'],
      ['Site (no subtask)', 'Beta'],
    ]);
    expect(written('subtasks')[0]).toBe('Moodboard · Logo · Alpha');
    expect(rowsOf('subtasks')[0]?.querySelector('.a-share-name')?.getAttribute('title')).toBe('Alpha > Logo > Moodboard');
    // The dots are for the eye only.
    expect([...rowsOf('subtasks')[0]!.querySelectorAll('.a-share-sep')].map((e) => e.getAttribute('aria-hidden'))).toEqual(['true', 'true']);
    expect(said(rowsOf('subtasks')[0] as HTMLElement)).toBe('Moodboard, task Logo, project Alpha 1h 00m (30%)');
  });

  it('adds up to 100% and to the total in the middle at the Subtasks level, rows for none included', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    await user.click(radio('Subtasks'));
    expect(rowsOf('subtasks')).toHaveLength(6);
    expect(sum(figures('subtasks').map(percentOf))).toBe(100);
    expect(sum(figures('subtasks').map(minutesOf))).toBe(200);
    expect(centre()).toBe('3h 20m');
  });
});

describe('the Tags level', () => {
  it('has a row per combination of tags, named in the Settings order, with "No tag" for the rest', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    await user.click(radio('Tags'));
    expect(written('tags')).toEqual(['Design', 'Design + Client', 'No tag']);
    expect(figures('tags')).toEqual(['2h 00m (60%)', '1h 00m (30%)', '0h 20m (10%)']);
    expect(centre()).toBe('3h 20m');
    expect(sum(figures('tags').map(percentOf))).toBe(100);
    expect(rowsOf('tags').map((li) => li.querySelector('.a-share-name')?.getAttribute('title'))).toEqual(['Design', 'Design + Client', 'No tag']);
  });

  it('draws a single tag in its colour, a combination in stripes of its tags’ colours, and "No tag" in grey', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    await user.click(radio('Tags'));
    const swatches = rowsOf('tags').map((li) => li.querySelector('.a-share-swatch') as HTMLElement);
    expect(swatches.map((s) => s.getAttribute('data-stripes'))).toEqual([null, '2', null]);
    expect(swatches[0]?.style.backgroundColor).toBe('rgb(124, 58, 237)');
    expect(swatches[2]?.style.backgroundColor).toBe('rgb(107, 114, 128)');
    expect(swatches[1]?.classList.contains('is-stripes')).toBe(true);
    // The slice for the combination is filled with a pattern; the others with their colour.
    const fills = [...screen.getByRole('img', { name: 'Share of time per tag' }).querySelectorAll('path.a-slice')].map((p) => p.getAttribute('fill'));
    expect(fills[0]).toBe('#7c3aed');
    expect(fills[1]).toMatch(/^url\(#.+-stripes-1\)$/);
    expect(fills[2]).toBe('#6b7280');
    const pattern = screen.getByRole('img', { name: 'Share of time per tag' }).querySelector('pattern');
    expect([...(pattern?.querySelectorAll('rect') ?? [])].map((r) => r.getAttribute('fill'))).toEqual(['#7c3aed', '#0f766e']);
    // The legend and the slices carry no stripes at the other levels.
    await user.click(radio('Tasks'));
    expect(screen.getByRole('img', { name: 'Share of time per task' }).querySelector('pattern')).toBeNull();
  });

  it('explains the combinations under the legend when a task carries more than one tag', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    expect(within(card()).queryByText(/counted once/)).toBeNull();
    await user.click(radio('Tags'));
    expect(within(card()).getByText('Tasks with several tags are counted once, under their combination.')).toBeVisible();
    await user.click(radio('Tasks'));
    expect(within(card()).queryByText(/counted once/)).toBeNull();
  });

  it('says nothing about combinations when no task carries more than one tag', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(THIRDS, 'exact')} />);
    await user.click(radio('Tags'));
    expect(names('tags')).toEqual(['No tag']);
    expect(within(card()).queryByText(/counted once/)).toBeNull();
    // The tag filter can leave only tasks with one tag, too.
    expect(within(card()).queryByText(/several tags/)).toBeNull();
  });

  it('shows only the tasks the tag filter keeps, each with its full set of tags', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact', WEEK, false, { tagIds: ['t-c'] })} />);
    await user.click(radio('Tags'));
    expect(written('tags')).toEqual(['Design + Client']);
    expect(figures('tags')).toEqual(['1h 00m (100%)']);
  });

  it('shows the untagged time alone for the "No tag" filter', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact', WEEK, false, { tagIds: ['__no-tag'] })} />);
    await user.click(radio('Tags'));
    expect(written('tags')).toEqual(['No tag']);
    expect(figures('tags')).toEqual(['0h 20m (100%)']);
    expect(centre()).toBe('0h 20m');
  });
});

describe('the View data table at the new levels', () => {
  it('lists the whole path of each subtask in three columns, and every subtask', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'exact')} />);
    await user.click(radio('Subtasks'));
    await user.click(within(card()).getByText('View data'));
    const table = await within(card()).findByRole('table');
    expect(within(table).getByText('Subtask time', { selector: 'caption' })).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Subtask', 'Task', 'Project', 'Exact', 'Share', 'Exact', 'Billable']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    expect(within(rows[0] as HTMLElement).getAllByRole('cell', { hidden: true }).map((c) => c.textContent)).toEqual(['Logo', 'Alpha', '1:00:00', '30.0%', '1:00:00', '1:00:00']);
    expect(rows[0]).toHaveTextContent('Moodboard');
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toContain('(no subtask)');
  });

  it('lists every combination with its tasks at the Tags level', async () => {
    const user = userEvent.setup();
    render(<Projects env={envOf(LEVELS, 'billable')} />);
    await user.click(radio('Tags'));
    await user.click(within(card()).getByText('View data'));
    const table = await within(card()).findByRole('table');
    expect(within(table).getByText('Time by tag combination', { selector: 'caption' })).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Tags', 'Billable', 'Share', 'Exact', 'Billable', 'Tasks']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual(['Design', 'Design + Client', 'No tag']);
    // Billable rounds the 20 minute Pitch up to 30, so the total is 3h 30m and Design is 2h of it.
    expect(within(rows[0] as HTMLElement).getAllByRole('cell').map((c) => c.textContent)).toEqual(['2:00:00', '57.1%', '2:00:00', '2:00:00', '1']);
  });
});

describe('opening the time behind a row of the new levels', () => {
  it('opens a subtask with its task, and the time on none with the task’s time on no subtask', async () => {
    const user = userEvent.setup();
    const env = envOf(LEVELS, 'exact');
    render(<Projects env={env} />);
    await user.click(radio('Subtasks'));
    await user.click(within(legend('subtasks')).getByRole('button', { name: 'Moodboard, task Logo, project Alpha' }));
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Moodboard', taskId: 'a1', subtaskId: 'mood' });
    await user.click(within(legend('subtasks')).getByRole('button', { name: 'Logo (no subtask), project Alpha' }));
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Logo (no subtask)', taskId: 'a1', subtaskId: null });
  });

  it('opens a combination with the time that counts under exactly it, not whole tasks (a task’s subtasks can differ)', async () => {
    const user = userEvent.setup();
    const env = envOf(LEVELS, 'exact');
    render(<Projects env={env} />);
    await user.click(radio('Tags'));
    await user.click(within(legend('tags')).getByRole('button', { name: 'Design + Client' }));
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'Design + Client', tagSet: ['t-d', 't-c'] });
    await user.click(within(legend('tags')).getByRole('button', { name: 'No tag' }));
    expect(env.drill).toHaveBeenLastCalledWith({ title: 'No tag', tagSet: [] });
  });
});

describe('Other at the Subtasks level', () => {
  /** One task with twelve items, each with its own time. */
  const ITEMS = Array.from({ length: 12 }, (_, i) => ({ id: `i${String(i).padStart(2, '0')}`, text: `Item ${String(i).padStart(2, '0')}` }));
  const TWELVE_ITEMS = mkSnapshot({
    now: NOW,
    projects: PROJECTS.slice(0, 1),
    tasks: [{ id: 'a1', projectId: 'p-a', name: 'Big', subtasks: ITEMS }],
    segs: ITEMS.map((it, i): NonNullable<Spec['segs']>[number] => {
      const start = parseIso(`2026-03-${String(i + 2).padStart(2, '0')}T09:00:00Z`);
      return ['a1', toIso(start), toIso(start + (120 - i * 5) * 60), { subtaskId: it.id }];
    }),
  });

  it('groups all but the top eight as "Other (4 subtasks)", says what it is made of, and cannot be opened', async () => {
    const user = userEvent.setup();
    const env = envOf(TWELVE_ITEMS, 'exact', MONTH, false, { taskIds: ['a1'] });
    render(<Projects env={env} />);
    expect(checkedRadio()).toBe('Subtasks');
    expect(rowsOf('subtasks')).toHaveLength(9);
    expect(names('subtasks').slice(0, 8)).toEqual(ITEMS.slice(0, 8).map((i) => i.text));
    const other = rowsOf('subtasks').at(-1) as HTMLElement;
    expect(other).toHaveTextContent('Other (4 subtasks)');
    expect(within(other).queryByRole('button')).toBeNull();
    expect(other.querySelector('.a-share-swatch')?.getAttribute('style')).toContain('var(--border-strong)');
    await user.click(other);
    expect(env.drill).not.toHaveBeenCalled();
    expect(within(card()).getByText('Other adds up the 4 subtasks with the least time. View data lists every subtask.')).toBeVisible();
    // The table lists every subtask, not the nine of the legend.
    await user.click(within(card()).getByText('View data'));
    expect(within(await within(card()).findByRole('table')).getAllByRole('row')).toHaveLength(1 + 12);
    expect(sum(figures('subtasks').map(percentOf))).toBe(100);
  });
});

describe('the stripes of a combination', () => {
  it('get ids of their own in each donut, so two donuts on a page never draw each other’s', () => {
    const slices: Slice[] = [
      { key: 'a', value: 2, color: '#7c3aed', stripes: ['#7c3aed', '#0f766e'], tip: ['A'], aria: 'A: 2h' },
      { key: 'b', value: 1, color: '#c2410c', tip: ['B'], aria: 'B: 1h' },
    ];
    const { container } = render(
      <>
        <Donut slices={slices} centerTop="3h" centerBottom="Exact" ariaLabel="First donut" />
        <Donut slices={slices} centerTop="3h" centerBottom="Exact" ariaLabel="Second donut" />
      </>,
    );
    const ids = [...container.querySelectorAll('pattern')].map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(container.querySelectorAll(`path[fill="url(#${id})"]`)).toHaveLength(1);
    // Each pattern has a stripe per colour, the same width.
    const stripes = [...(container.querySelector('pattern')?.querySelectorAll('rect') ?? [])];
    expect(stripes.map((r) => r.getAttribute('fill'))).toEqual(['#7c3aed', '#0f766e']);
    expect(new Set(stripes.map((r) => r.getAttribute('width'))).size).toBe(1);
  });
});
