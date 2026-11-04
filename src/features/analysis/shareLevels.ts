// Which level the "Share of time" donut shows: Projects, Tasks, Subtasks or Tags. Pure rules with no React, so each one
// has a unit test. The card holds one `LevelState` and feeds it these functions.
//
// The owner: "it depends on the filtering, it should be more accurate regarding the filter applied (per project, per
// project and task, per project task and subtask)". So the level the card starts on, and moves to when the filter
// changes, is the one that divides what the filter has left open. Tags is never that level: it is chosen by hand.
import type { Filters } from './engine';

export type ShareLevel = 'projects' | 'tasks' | 'subtasks' | 'tags';

/** The four segments of the switch, in order, with the words on them. */
export const SHARE_LEVELS: readonly { level: ShareLevel; label: string }[] = [
  { level: 'projects', label: 'Projects' },
  { level: 'tasks', label: 'Tasks' },
  { level: 'subtasks', label: 'Subtasks' },
  { level: 'tags', label: 'Tags' },
];

/** The tooltip of the Subtasks segment while it is switched off. */
export const NO_SUBTASK_TIME = 'No subtask time in this period';

/** What each level's slice is called in the donut's label: "Share of time per project". */
export const LEVEL_NOUN: Record<ShareLevel, string> = { projects: 'project', tasks: 'task', subtasks: 'subtask', tags: 'tag' };

/**
 * The level the filter asks for. A filter on one task leaves its subtasks open (Subtasks); one project leaves its tasks
 * open (Tasks); no project, or several, leaves the projects open (Projects). The name search counts as a task filter
 * when it has been turned into task ids, which is how the card sees it.
 */
export function defaultLevel(filters: Pick<Filters, 'projectIds' | 'taskIds'>): ShareLevel {
  if (filters.taskIds.length === 1) return 'subtasks';
  if (filters.projectIds.length === 1) return 'tasks';
  return 'projects';
}

/** Which levels have something to show. Only Subtasks can be empty while there is time: time on no subtask is just the tasks again. */
export type Availability = Readonly<Record<ShareLevel, boolean>>;

/** `subtasks` are the rows of the metrics: a row with an id is time on a real subtask. */
export function availabilityOf(subtasks: readonly { id: string | null; secs: number }[]): Availability {
  return { projects: true, tasks: true, subtasks: subtasks.some((s) => s.id !== null && s.secs > 0), tags: true };
}

/**
 * The level to draw: the one asked for, or when it has nothing to show (a filter or period took its time away) the
 * default of the filter, or the nearest level above it that has something. Never an empty chart.
 */
export function shownLevel(level: ShareLevel, auto: ShareLevel, available: Availability): ShareLevel {
  if (available[level]) return level;
  const fallback: readonly ShareLevel[] = [auto, 'tasks', 'projects'];
  return fallback.find((l) => available[l]) ?? 'projects';
}

/**
 * What the card remembers. `auto` is the default of the filters it last saw. `picked` says the user chose a level by
 * hand since that default last changed.
 */
export interface LevelState {
  level: ShareLevel;
  auto: ShareLevel;
  picked: boolean;
}

export type LevelEvent =
  /** The user chose a level. */
  | { type: 'pick'; level: ShareLevel }
  /** The card saw the filters again; `auto` is `defaultLevel` of them. */
  | { type: 'filters'; auto: ShareLevel };

export const startLevel = (auto: ShareLevel): LevelState => ({ level: auto, auto, picked: false });

/**
 * A filter change that moves the default applies the new default, unless the user has picked a level since the last
 * time the default moved: then their pick stays for this change, and the next change that moves the default applies
 * the default again. A change that leaves the default where it was (a tag, a band, another period) does nothing, so a
 * level picked by hand is not lost to a tag being ticked.
 */
export function reduceLevel(state: LevelState, event: LevelEvent): LevelState {
  if (event.type === 'pick') return { level: event.level, auto: state.auto, picked: true };
  if (event.auto === state.auto) return state;
  return { level: state.picked ? state.level : event.auto, auto: event.auto, picked: false };
}
