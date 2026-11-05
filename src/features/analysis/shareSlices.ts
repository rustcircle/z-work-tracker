// The "Share of time" donut and its legend: which slices there are at each level (projects, tasks, subtasks, tags), what
// colour each one has, what its row is called and the hours and percentage written beside it. Pure functions with no
// React and no DOM, so every rule here has a unit test.
import { THEME_BACKGROUNDS, contrast, fromOklch, hexToRgb } from '../../lib/color';
import { UNTAGGED_COLOR } from './fam-p2';
import type { ShareLevel } from './shareLevels';

/** Up to this many rows all get a slice, at the levels that group (tasks, subtasks, tag combinations). */
export const SHOW_ALL_UP_TO = 9;
/** Past that, only this many rows (the ones with the most time) get a slice and the rest are grouped as "Other". */
export const TOP_ROWS = 8;
/** The grouped rest: the strong border token, a mid grey in all four themes. */
export const OTHER_COLOR = 'var(--border-strong)';

/** What the legend writes for time a task has on no subtask, after the task's name: "Logo concepts (no subtask)". */
export const NO_SUBTASK_LABEL = '(no subtask)';
/** The row of the tasks that carry no tag. */
export const NO_TAG_LABEL = 'No tag';
/** Between the tags of a combination: "Design + Client". */
export const TAG_SEPARATOR = ' + ';
/** Between the parts of a row's path in its title and its slice's label: "Brand refresh > Logo concepts > Moodboard". */
export const PATH_SEPARATOR = ' > ';
/** Under the legend of the Tags level, when a task has more than one tag. */
export const COMBINATION_NOTE = 'Tasks with several tags are counted once, under their combination.';

/** A project as the chart needs it: its time in the basis in use. */
export interface ShareProject {
  id: string;
  name: string;
  color: string;
  secs: number;
}

/** A task with the project it belongs to and its time in the basis in use. */
export interface ShareTask {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  secs: number;
}

/** The time of a task on one of its subtasks (`id` is the subtask's), or on none (`id` is null; `name` is not used). */
export interface ShareSubtask {
  taskId: string;
  taskName: string;
  projectId: string;
  projectName: string;
  id: string | null;
  name: string;
  secs: number;
}

/** A tag that exists. The tags are handed over in the order of the Settings list, which is the order of a combination. */
export interface ShareTag {
  id: string;
  name: string;
  color: string;
}

/**
 * A task's time under one set of tags, for the Tags level: all of the task's time with the task's tags, or when some of its
 * subtasks have tags of their own, one entry for each set its time counts under. The entries of a task add up to its time.
 */
export interface ShareTagTask {
  /** The task's id. */
  id: string;
  /** For the basis in use. */
  secs: number;
  exact: number;
  billableSecs: number;
  tagIds: readonly string[];
}

/** What the grouped rest of a level is made of. */
export type OtherUnit = 'tasks' | 'subtasks' | 'combinations';
const OTHER_ONE: Record<OtherUnit, string> = { tasks: 'task', subtasks: 'subtask', combinations: 'combination' };

/** "Other (4 tasks)", "Other (3 subtasks)" or "Other (5 combinations)". The group always has at least two rows. */
export const otherLabel = (grouped: number, unit: OtherUnit): string => `Other (${grouped} ${unit})`;
/** What the tooltip of the Other slice says it is made of. */
export const otherTip = (grouped: number, unit: OtherUnit): string => `The ${grouped} ${unit} with the least time. View data lists every ${OTHER_ONE[unit]}.`;
/** The note under the donut when rows are grouped: what Other adds up and where every row can be read. */
export const otherNote = (grouped: number, unit: OtherUnit): string => `Other adds up the ${grouped} ${unit} with the least time. View data lists every ${OTHER_ONE[unit]}.`;

/** What every row has, whatever it stands for. */
interface RowCore {
  key: string;
  /** The row's own name: a project, a task, a subtask, a combination of tags, or "Other (N tasks)". */
  label: string;
  /** Names written after the label in muted text: only what the filter leaves open (a task's project, a subtask's task and project). */
  context: readonly string[];
  /** The whole path, outermost first: project, task, subtask. The title, the slice's label and the button's name carry all of it. */
  path: readonly string[];
  secs: number;
  /** A hex colour, or a CSS variable for the grouped rest. For a combination, the first tag's. */
  color: string;
  /** A combination of two tags or more: every tag's colour, drawn as stripes. */
  stripes?: readonly string[];
}

/** What a row stands for: a project, a task, a subtask (or a task's time on none), a combination of tags, or the grouped rest. */
type RowKind =
  | { kind: 'project'; id: string; projectId: string }
  | { kind: 'task'; id: string; projectId: string }
  | { kind: 'subtask'; /** The subtask's id; null for the task's time on none. */ id: string | null; taskId: string; projectId: string }
  | {
      kind: 'tag';
      id: null;
      projectId: null;
      /** The tags, in the order the label writes them; none for the row "No tag". */
      tagIds: readonly string[];
      /** The tasks counted in this row, each once. */
      taskIds: readonly string[];
    }
  | {
      kind: 'other';
      id: null;
      projectId: null;
      /** How many rows the row adds up. */
      grouped: number;
      unit: OtherUnit;
    };

type Draft = RowCore & RowKind;

/** One slice and one legend row. Every row of a model has time: a slice with none is not drawn. */
export type ShareRow = Draft & {
  /** The path as one text, outermost first: "Brand refresh > Logo concepts". */
  title: string;
  /** Whole minutes; all rows together add up to `totalMinutes`. */
  minutes: number;
  /** Whole percent; all rows together add up to 100. */
  percent: number;
  /** "16h 50m": hours always shown. */
  hm: string;
  /** "(47%)", or "(<1%)" for a row with time whose share rounds to nothing. */
  pct: string;
  /** "16h 50m (47%)": the text of the legend row, the tooltip and the slice's label. */
  figure: string;
};

export interface ShareModel {
  level: ShareLevel;
  rows: readonly ShareRow[];
  totalSecs: number;
  /** `Math.round(totalSecs / 60)`: the minutes the donut's centre shows, and the sum of the rows' minutes. */
  totalMinutes: number;
  /** Tags level: how many of the rows (grouped ones included) combine two tags or more. The footnote shows when it is above 0. */
  combinations: number;
  /** Tags level: every combination with time, most first, grouped or not, for the View data table. */
  lines: readonly TagLine[];
}

/** A combination of tags with the tasks that have time under exactly it. */
export interface TagLine {
  key: string;
  label: string;
  tagIds: readonly string[];
  taskIds: readonly string[];
  secs: number;
  exact: number;
  billableSecs: number;
}

// ------------------------------------------------------------------ rounding

/** Remainders closer than this are the same remainder: floating point noise, not a difference. */
const EPS = 1e-9;

/**
 * The largest-remainder (Hamilton) method. Splits `units` whole units among rows in proportion to `weights`: each row
 * gets the whole part of its exact share, then the units still left go one each to the rows with the largest
 * remainders, so the result adds up to `units` exactly. A tie goes to the larger weight, then to the earlier row, so
 * the same input always gives the same answer. A row with no weight stays at 0.
 */
export function apportion(weights: readonly number[], units: number): number[] {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0 || !(units > 0)) return w.map(() => 0);
  const rows = w.map((weight, i) => {
    const exact = (weight * units) / total;
    const floor = Math.floor(exact + EPS);
    return { i, weight, floor, rem: Math.round((exact - floor) * 1e9) };
  });
  const out = rows.map((r) => r.floor);
  const ranked = rows.filter((r) => r.weight > 0).sort((a, b) => b.rem - a.rem || b.weight - a.weight || a.i - b.i);
  let left = units - out.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0 && ranked.length > 0; k += 1, left -= 1) {
    const r = ranked[k % ranked.length];
    if (r) out[r.i] = (out[r.i] ?? 0) + 1;
  }
  return out;
}

// ------------------------------------------------------------------ text

/** "16h 50m", "0h 45m", "123h 05m": hours are always written, minutes always have two digits. */
export const hoursMinutes = (minutes: number): string => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

/** "(47%)", and "(<1%)" for a row that has time but whose share rounds to 0. */
export const percentText = (percent: number, secs: number): string => (secs > 0 && percent < 1 ? '(<1%)' : `(${percent}%)`);

/** The three texts of a legend row: "16h 50m", "(47%)" and "16h 50m (47%)". */
export function shareFigure(minutes: number, percent: number, secs: number): { hm: string; pct: string; figure: string } {
  const hm = hoursMinutes(minutes);
  const pct = percentText(percent, secs);
  return { hm, pct, figure: `${hm} ${pct}` };
}

// ------------------------------------------------------------------ colour

export interface Oklch {
  /** Lightness 0 to 1. */
  l: number;
  /** Chroma, about 0 to 0.4. */
  c: number;
  /** Hue in degrees. */
  h: number;
}

/**
 * The OKLCH values of a hex colour, or null when it is not one. The inverse of `fromOklch` in lib/color, which does
 * not export its forward conversion.
 */
export function toOklch(hex: string): Oklch | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(rgb.r);
  const g = lin(rgb.g);
  const b = lin(rgb.b);
  const l = Math.cbrt(0.41222147 * r + 0.53633254 * g + 0.05144599 * b);
  const m = Math.cbrt(0.2119035 * r + 0.68069955 * g + 0.10739696 * b);
  const s = Math.cbrt(0.08830246 * r + 0.28171884 * g + 0.6299787 * b);
  const a = 1.9779985 * l - 2.42859221 * m + 0.45059371 * s;
  const bb = 0.02590404 * l + 0.78277177 * m - 0.80867577 * s;
  const c = Math.hypot(a, bb);
  return { l: 0.21045426 * l + 0.79361779 * m - 0.00407205 * s, c, h: c < 1e-4 ? 0 : (((Math.atan2(bb, a) * 180) / Math.PI) % 360 + 360) % 360 };
}

/** A shade must keep this much of its project's chroma, or it stops reading as the same hue. */
const KEEP_CHROMA = 0.6;
/** Contrast against every theme's page and card that a shade must keep (the floor lib/color uses for project colours). */
const MIN_CONTRAST = 2;
/** The widest step in lightness between two neighbouring shades. */
const MAX_STEP = 0.07;
/** Lightness values tried when looking for the range a hue stays visible in. */
const SCAN_FROM = 0.3;
const SCAN_STEP = 0.005;
const SCAN_COUNT = 131;

const visible = (hex: string): boolean => THEME_BACKGROUNDS.every((bg) => contrast(hex, bg) >= MIN_CONTRAST);

/**
 * The colour at lightness `l` with the base hue and as much of the base chroma as the sRGB gamut allows, or null when
 * it would be too washed out or too hard to see on one of the themes.
 */
function shadeAt(base: Oklch, l: number): string | null {
  let c = base.c;
  for (let i = 0; i < 40; i += 1) {
    const hex = fromOklch(l, c, base.h);
    if (hex !== null) return c >= base.c * KEEP_CHROMA && visible(hex) ? hex : null;
    c *= 0.93;
  }
  return null;
}

const bands = new Map<string, readonly [number, number] | null>();

/** The run of lightness values where the hue is visible on every theme: the one holding the base, else the longest. */
function visibleBand(key: string, base: Oklch): readonly [number, number] | null {
  const hit = bands.get(key);
  if (hit !== undefined) return hit;
  let best: readonly [number, number] | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let from = -1;
  for (let k = 0; k <= SCAN_COUNT; k += 1) {
    const ok = k < SCAN_COUNT && shadeAt(base, SCAN_FROM + k * SCAN_STEP) !== null;
    if (ok && from < 0) from = k;
    if (!ok && from >= 0) {
      const lo = SCAN_FROM + from * SCAN_STEP;
      const hi = SCAN_FROM + (k - 1) * SCAN_STEP;
      const score = (base.l >= lo - SCAN_STEP && base.l <= hi + SCAN_STEP ? 10 : 0) + (hi - lo);
      if (score > bestScore) {
        bestScore = score;
        best = [lo, hi];
      }
      from = -1;
    }
  }
  bands.set(key, best);
  return best;
}

/**
 * `count` shades of one project colour for that project's tasks, darkest first: the same hue, lightness stepped
 * evenly inside the range where the hue stays visible on every theme, centred on the project's own lightness. A
 * single task has the project colour itself. Each step is at most `MAX_STEP` in OKLCH lightness, less when the
 * visible range is too narrow for that many.
 */
export function taskShades(base: string, count: number): string[] {
  if (count <= 0) return [];
  const lch = toOklch(base);
  const band = count > 1 && lch !== null ? visibleBand(base.toLowerCase(), lch) : null;
  if (lch === null || band === null) return Array.from({ length: count }, () => base);
  const [lo, hi] = band;
  const step = Math.min(MAX_STEP, (hi - lo) / (count - 1));
  const span = step * (count - 1);
  const start = Math.min(hi - span, Math.max(lo, lch.l - span / 2));
  return Array.from({ length: count }, (_, i) => shadeAt(lch, start + i * step) ?? base);
}

// ------------------------------------------------------------------ rows

/** Most time first; the same time by name, then by id, so the order never depends on how the input came. */
function byTime<T extends { id: string; name: string; secs: number }>(a: T, b: T): number {
  return b.secs - a.secs || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Works out minutes and percent for the rows that have time and writes their texts. */
function finish(level: ShareLevel, drafts: readonly Draft[], combinations = 0, lines: readonly TagLine[] = []): ShareModel {
  const live = drafts.filter((d) => d.secs > 0);
  const totalSecs = live.reduce((n, d) => n + d.secs, 0);
  const totalMinutes = Math.round(totalSecs / 60);
  const secs = live.map((d) => d.secs);
  const minutes = apportion(secs, totalMinutes);
  const percents = apportion(secs, 100);
  const rows = live.map((d, i): ShareRow => {
    const m = minutes[i] ?? 0;
    const p = percents[i] ?? 0;
    return { ...d, title: d.path.join(PATH_SEPARATOR), minutes: m, percent: p, ...shareFigure(m, p, d.secs) };
  });
  return { level, rows, totalSecs, totalMinutes, combinations, lines };
}

/** The rows that get a slice (up to nine, or the eight with the most time) and the rest, which are grouped. `ranked` is most time first. */
function cut<T>(ranked: readonly T[]): { shown: T[]; rest: T[] } {
  const grouped = ranked.length > SHOW_ALL_UP_TO;
  return { shown: grouped ? ranked.slice(0, TOP_ROWS) : [...ranked], rest: grouped ? ranked.slice(TOP_ROWS) : [] };
}

/** The one row that adds up `rest`. */
function otherDraft(rest: readonly { secs: number }[], unit: OtherUnit): Draft {
  const label = otherLabel(rest.length, unit);
  return { key: 'other', kind: 'other', id: null, projectId: null, label, context: [], path: [label], secs: rest.reduce((n, r) => n + r.secs, 0), color: OTHER_COLOR, grouped: rest.length, unit };
}

/** The projects of `ranked` in the order of their time, the grouped rows' time counted; a tie goes to the project that ranks first. */
function projectOrder(ranked: readonly { projectId: string; secs: number }[]): string[] {
  const projectSecs = new Map<string, number>();
  const firstRank = new Map<string, number>();
  ranked.forEach((t, i) => {
    projectSecs.set(t.projectId, (projectSecs.get(t.projectId) ?? 0) + t.secs);
    if (!firstRank.has(t.projectId)) firstRank.set(t.projectId, i);
  });
  return [...projectSecs.keys()].sort((a, b) => (projectSecs.get(b) ?? 0) - (projectSecs.get(a) ?? 0) || (firstRank.get(a) ?? 0) - (firstRank.get(b) ?? 0));
}

/** Every project with time, most time first, in the colour it has everywhere else. */
export function projectShares(projects: readonly ShareProject[]): ShareModel {
  const drafts = projects
    .filter((p) => p.secs > 0)
    .sort(byTime)
    .map((p): Draft => ({ key: `project:${p.id}`, kind: 'project', id: p.id, projectId: p.id, label: p.name, context: [], path: [p.name], secs: p.secs, color: p.color }));
  return finish('projects', drafts);
}

/**
 * The tasks with time. Up to `SHOW_ALL_UP_TO` tasks all show; with more, the `TOP_ROWS` with the most time show and the
 * rest become one "Other (N tasks)" row (N is at least 2). Shown tasks are grouped by project, the projects in the
 * order of their time in this view (the grouped tasks' time counted), each project's tasks by time, Other last. Each
 * task has a shade of its project's colour.
 *
 * A row names only what the filter leaves open: its project follows the task's name when the tasks in the data belong
 * to several projects, and is left out when they all belong to one.
 */
export function taskShares(tasks: readonly ShareTask[], projectColor: (projectId: string) => string): ShareModel {
  const ranked = tasks.filter((t) => t.secs > 0).sort(byTime);
  const { shown, rest } = cut(ranked);
  const severalProjects = new Set(ranked.map((t) => t.projectId)).size > 1;
  const drafts: Draft[] = [];
  for (const projectId of projectOrder(ranked)) {
    const mine = shown.filter((t) => t.projectId === projectId);
    const base = projectColor(projectId);
    const shades = taskShades(base, mine.length);
    mine.forEach((t, i) =>
      drafts.push({ key: `task:${t.id}`, kind: 'task', id: t.id, projectId, label: t.name, context: severalProjects ? [t.projectName] : [], path: [t.projectName, t.name], secs: t.secs, color: shades[i] ?? base }),
    );
  }
  if (rest.length > 0) drafts.push(otherDraft(rest, 'tasks'));
  return finish('tasks', drafts);
}

/** The row's own name: the subtask's text, or the task's name and "(no subtask)" for time on none. */
const subtaskLabel = (s: ShareSubtask): string => (s.id === null ? `${s.taskName} ${NO_SUBTASK_LABEL}` : s.name);

/**
 * The time per subtask, and a task's time on no subtask as the row "<Task> (no subtask)". Grouped like the tasks: past
 * nine rows the eight with the most time show and the rest are "Other (N subtasks)". Shown rows are grouped by project
 * (the projects by their time), then by task (the tasks by theirs), then by time, and take shades of their project's
 * colour.
 *
 * A row names only what the filter leaves open: its task when the data holds the time of several tasks, its project
 * when it holds the time of several projects. A "(no subtask)" row already names its task.
 */
export function subtaskShares(subtasks: readonly ShareSubtask[], projectColor: (projectId: string) => string): ShareModel {
  const key = (s: ShareSubtask): string => `${s.taskId}\u0000${s.id ?? ''}`;
  const ranked = subtasks
    .filter((s) => s.secs > 0)
    // Of two rows with the same time the named subtask comes before the one for time on none.
    .map((s) => ({ ...s, rankName: subtaskLabel(s), rankId: key(s), tieName: `${s.id === null ? '\u{10ffff}' : ''}${subtaskLabel(s)}` }))
    .sort((a, b) => byTime({ id: a.rankId, name: a.tieName, secs: a.secs }, { id: b.rankId, name: b.tieName, secs: b.secs }));
  const { shown, rest } = cut(ranked);
  const severalTasks = new Set(ranked.map((s) => s.taskId)).size > 1;
  const severalProjects = new Set(ranked.map((s) => s.projectId)).size > 1;
  const taskSecs = new Map<string, number>();
  for (const s of ranked) taskSecs.set(s.taskId, (taskSecs.get(s.taskId) ?? 0) + s.secs);
  const drafts: Draft[] = [];
  for (const projectId of projectOrder(ranked)) {
    // Within a project: the task with the most time first, and in a task the subtask with the most time first.
    const mine = shown
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => (taskSecs.get(b.taskId) ?? 0) - (taskSecs.get(a.taskId) ?? 0) || a.taskName.localeCompare(b.taskName) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) || ranked.indexOf(a) - ranked.indexOf(b));
    const base = projectColor(projectId);
    const shades = taskShades(base, mine.length);
    mine.forEach((s, i) => {
      const label = s.rankName;
      const context = [...(s.id !== null && severalTasks ? [s.taskName] : []), ...(severalProjects ? [s.projectName] : [])];
      drafts.push({
        key: `subtask:${s.rankId}`,
        kind: 'subtask',
        id: s.id,
        taskId: s.taskId,
        projectId,
        label,
        context,
        path: [s.projectName, s.taskName, s.id === null ? NO_SUBTASK_LABEL : s.name],
        secs: s.secs,
        color: shades[i] ?? base,
      });
    });
  }
  if (rest.length > 0) drafts.push(otherDraft(rest, 'subtasks'));
  return finish('subtasks', drafts);
}

// ------------------------------------------------------------------ tag combinations

/** The row a task's tags put its time in: one row per distinct set of tags. */
export interface TagRowKey {
  key: string;
  /** The tags' names joined by " + ", or "No tag". */
  label: string;
  /** The task's tags that exist, in the order of the Settings list. */
  tagIds: readonly string[];
  /** One colour per tag, or the grey of "No tag". */
  colors: readonly string[];
}

/**
 * The row of a task: the exact set of tags it carries, named in the order of `tags` (the Settings list), so
 * "Design + Client" is that row whichever order the task was tagged in. One tag is that tag's row; a task with none is
 * "No tag". A tag that no longer exists is not counted. The tags are those the time counts under: its task's, or for time
 * on a subtask with tags of its own, the subtask's.
 */
export function tagKeyOf(taskTagIds: readonly string[], tags: readonly ShareTag[]): TagRowKey {
  const mine = tags.filter((t) => taskTagIds.includes(t.id));
  if (mine.length === 0) return { key: 'tags:none', label: NO_TAG_LABEL, tagIds: [], colors: [UNTAGGED_COLOR] };
  return { key: `tags:${mine.map((t) => t.id).join(',')}`, label: mine.map((t) => t.name).join(TAG_SEPARATOR), tagIds: mine.map((t) => t.id), colors: mine.map((t) => t.color) };
}

/** A share of a task's time that goes to one row. */
export interface TagWeight {
  row: TagRowKey;
  /** The fraction of the task's time this row gets; a task's weights add up to 1. */
  weight: number;
}

/**
 * THE counting rule of the Tags level, in one place (owner decision "B"): a piece of time counts once, under the
 * combination of tags it counts under, so the rows add up to the total in the centre and to 100%.
 *
 * To count another way, change only this function. An even split, for example, would return one entry per tag:
 *   `mine.map((t) => ({ row: tagKeyOf([t.id], tags), weight: 1 / mine.length }))`
 * and the rows, their sums, the legend and the table follow without another change.
 */
export function tagWeightsOf(taskTagIds: readonly string[], tags: readonly ShareTag[]): TagWeight[] {
  return [{ row: tagKeyOf(taskTagIds, tags), weight: 1 }];
}

/**
 * The time per combination of tags. Rows are by time, most first; past nine rows the eight with the most time show and
 * the rest are "Other (N combinations)". Every row with one tag has that tag's colour, "No tag" the grey, and a
 * combination the stripes of its tags' colours (`stripes`), its first tag's colour standing for it elsewhere.
 */
export function tagShares(tasks: readonly ShareTagTask[], tags: readonly ShareTag[]): ShareModel {
  const lines = new Map<string, TagLine & { taskIds: string[]; colors: readonly string[] }>();
  for (const t of tasks) {
    if (!(t.secs > 0)) continue;
    for (const { row, weight } of tagWeightsOf(t.tagIds, tags)) {
      let line = lines.get(row.key);
      if (!line) lines.set(row.key, (line = { key: row.key, label: row.label, tagIds: row.tagIds, taskIds: [], secs: 0, exact: 0, billableSecs: 0, colors: row.colors }));
      // A task can reach one row through several of its parts (two sets that differ only by a tag that was deleted).
      if (!line.taskIds.includes(t.id)) line.taskIds.push(t.id);
      line.secs += t.secs * weight;
      line.exact += t.exact * weight;
      line.billableSecs += t.billableSecs * weight;
    }
  }
  const ranked = [...lines.values()].sort((a, b) => byTime({ id: a.key, name: a.label, secs: a.secs }, { id: b.key, name: b.label, secs: b.secs }));
  const { shown, rest } = cut(ranked);
  const drafts: Draft[] = shown.map(
    (l): Draft => ({
      key: l.key,
      kind: 'tag',
      id: null,
      projectId: null,
      tagIds: l.tagIds,
      taskIds: l.taskIds,
      label: l.label,
      context: [],
      path: [l.label],
      secs: l.secs,
      color: l.colors[0] ?? UNTAGGED_COLOR,
      ...(l.colors.length > 1 ? { stripes: l.colors } : {}),
    }),
  );
  if (rest.length > 0) drafts.push(otherDraft(rest, 'combinations'));
  const everyLine: TagLine[] = ranked.map(({ key, label, tagIds, taskIds, secs, exact, billableSecs }) => ({ key, label, tagIds, taskIds, secs, exact, billableSecs }));
  return finish('tags', drafts, ranked.filter((l) => l.tagIds.length > 1).length, everyLine);
}

/**
 * What a screen reader says for a button that opens a row: the row's name and the rest of its path, whatever the legend
 * leaves out of the line. A project and a combination of tags are their own name, so they need nothing more. Never the
 * figures: they are the row's own text after the button.
 */
export function spokenName(row: ShareRow): string | undefined {
  switch (row.kind) {
    case 'task':
      return `${row.label}, project ${row.path[0] ?? ''}`;
    case 'subtask':
      return row.id === null ? `${row.label}, project ${row.path[0] ?? ''}` : `${row.label}, task ${row.path[1] ?? ''}, project ${row.path[0] ?? ''}`;
    case 'project':
    case 'tag':
    case 'other':
      return undefined;
  }
}
