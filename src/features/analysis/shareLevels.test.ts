// Which level the "Share of time" donut shows: the default the filter asks for, the switch the user can move by hand,
// and the fallback when a level has nothing to show.
import { describe, expect, it } from 'vitest';

import { NO_FILTERS, type Filters } from './engine';
import {
  NO_SUBTASK_TIME,
  SHARE_LEVELS,
  availabilityOf,
  defaultLevel,
  reduceLevel,
  shownLevel,
  startLevel,
  type Availability,
  type LevelEvent,
  type LevelState,
  type ShareLevel,
} from './shareLevels';

const f = (projectIds: string[] = [], taskIds: string[] = []): { projectIds: string[]; taskIds: string[] } => ({ projectIds, taskIds });
const ALL: Availability = { projects: true, tasks: true, subtasks: true, tags: true };
const NO_SUBTASKS: Availability = { ...ALL, subtasks: false };

describe('the segments of the switch', () => {
  it('are Projects, Tasks, Subtasks and Tags, in that order', () => {
    expect(SHARE_LEVELS.map((l) => [l.level, l.label])).toEqual([
      ['projects', 'Projects'],
      ['tasks', 'Tasks'],
      ['subtasks', 'Subtasks'],
      ['tags', 'Tags'],
    ]);
  });

  it('say why Subtasks is switched off in the words the owner can read on the tooltip', () => {
    expect(NO_SUBTASK_TIME).toBe('No subtask time in this period');
  });
});

describe('the level the filter asks for', () => {
  it('is Projects with no project filter, or with several projects', () => {
    expect(defaultLevel(f())).toBe('projects');
    expect(defaultLevel(f(['p1', 'p2']))).toBe('projects');
    expect(defaultLevel(f(['p1', 'p2', 'p3']))).toBe('projects');
  });

  it('is Tasks with exactly one project', () => {
    expect(defaultLevel(f(['p1']))).toBe('tasks');
  });

  it('stays Tasks with one project and several tasks: several tasks are not one task', () => {
    expect(defaultLevel(f(['p1'], ['t1', 't2']))).toBe('tasks');
    expect(defaultLevel(f([], ['t1', 't2']))).toBe('projects');
  });

  it('is Subtasks with exactly one task, alone or with its one project', () => {
    expect(defaultLevel(f([], ['t1']))).toBe('subtasks');
    expect(defaultLevel(f(['p1'], ['t1']))).toBe('subtasks');
    expect(defaultLevel(f(['p1', 'p2'], ['t1']))).toBe('subtasks');
  });

  it('is never Tags: that one is chosen by hand', () => {
    const cases = [f(), f(['p1']), f(['p1', 'p2']), f([], ['t1']), f(['p1'], ['t1']), f(['p1'], ['t1', 't2'])];
    for (const c of cases) expect(defaultLevel(c)).not.toBe('tags');
  });

  it('does not look at the filters that are not the project or the task', () => {
    const full: Filters = { ...NO_FILTERS, tagIds: ['a'], band: 1, shiftKey: 'x', query: 'logo' };
    expect(defaultLevel(full)).toBe('projects');
  });
});

describe('which levels have something to show', () => {
  it('needs time on a real subtask for Subtasks; the other levels always have rows when there is time', () => {
    expect(availabilityOf([{ id: 's1', secs: 60 }])).toEqual(ALL);
    expect(availabilityOf([{ id: null, secs: 600 }])).toEqual(NO_SUBTASKS);
    expect(availabilityOf([{ id: 's1', secs: 0 }, { id: null, secs: 600 }])).toEqual(NO_SUBTASKS);
    expect(availabilityOf([])).toEqual(NO_SUBTASKS);
    expect(availabilityOf([{ id: null, secs: 60 }, { id: 's2', secs: 5 }]).subtasks).toBe(true);
  });
});

describe('the level that is drawn', () => {
  it('is the one asked for while it has something to show', () => {
    for (const level of ['projects', 'tasks', 'subtasks', 'tags'] as const) expect(shownLevel(level, 'projects', ALL)).toBe(level);
  });

  it('falls back to the default of the filter when Subtasks is empty, and to the level above when the default is the empty one', () => {
    expect(shownLevel('subtasks', 'projects', NO_SUBTASKS)).toBe('projects');
    expect(shownLevel('subtasks', 'tasks', NO_SUBTASKS)).toBe('tasks');
    // A filter on one task asks for Subtasks, which is empty: the nearest level above that has something is Tasks.
    expect(shownLevel('subtasks', 'subtasks', NO_SUBTASKS)).toBe('tasks');
    expect(shownLevel('tasks', 'subtasks', NO_SUBTASKS)).toBe('tasks');
    expect(shownLevel('tags', 'subtasks', NO_SUBTASKS)).toBe('tags');
  });

  it('never leaves the chart empty while any level has rows', () => {
    const levels: ShareLevel[] = ['projects', 'tasks', 'subtasks', 'tags'];
    for (const level of levels) for (const auto of levels) expect(NO_SUBTASKS[shownLevel(level, auto, NO_SUBTASKS)]).toBe(true);
  });
});

describe('the level the card remembers', () => {
  const fold = (start: LevelState, ...events: LevelEvent[]): LevelState => events.reduce(reduceLevel, start);
  const filters = (auto: ShareLevel): LevelEvent => ({ type: 'filters', auto });
  const pick = (level: ShareLevel): LevelEvent => ({ type: 'pick', level });

  it('starts on the default and has not been picked', () => {
    expect(startLevel('tasks')).toEqual({ level: 'tasks', auto: 'tasks', picked: false });
  });

  it('follows the default as the filter moves it, while the user has picked nothing', () => {
    const s = fold(startLevel('projects'), filters('tasks'));
    expect(s).toEqual({ level: 'tasks', auto: 'tasks', picked: false });
    expect(fold(s, filters('subtasks')).level).toBe('subtasks');
    expect(fold(s, filters('subtasks'), filters('projects')).level).toBe('projects');
  });

  it('keeps a level the user picked when the filter next moves the default', () => {
    const s = fold(startLevel('projects'), pick('tags'), filters('tasks'));
    expect(s.level).toBe('tags');
    expect(s.auto).toBe('tasks');
  });

  it('applies the default again on the change after that: a pick protects one change only', () => {
    const s = fold(startLevel('projects'), pick('tags'), filters('tasks'), filters('subtasks'));
    expect(s).toEqual({ level: 'subtasks', auto: 'subtasks', picked: false });
  });

  it('protects the pick again when the user picks again after a change', () => {
    const s = fold(startLevel('projects'), pick('tags'), filters('tasks'), pick('subtasks'), filters('projects'));
    expect(s.level).toBe('subtasks');
    expect(fold(s, filters('tasks')).level).toBe('tasks');
  });

  it('does nothing when the filter changes but the default stays: ticking a tag does not undo a pick', () => {
    const picked = fold(startLevel('projects'), pick('tags'));
    expect(reduceLevel(picked, filters('projects'))).toBe(picked);
    const after = fold(picked, filters('projects'), filters('projects'), filters('projects'), filters('tasks'));
    expect(after.level).toBe('tags');
  });

  it('counts a pick of the level already shown: the user chose it', () => {
    expect(fold(startLevel('tasks'), pick('tasks')).picked).toBe(true);
    expect(fold(startLevel('tasks'), pick('tasks'), filters('projects')).level).toBe('tasks');
  });

  it('walks the owner’s filters: none, one project, one task, and back', () => {
    const walk = [f(), f(['p1']), f(['p1'], ['t1']), f(['p1']), f()].map((x) => defaultLevel(x));
    expect(walk).toEqual(['projects', 'tasks', 'subtasks', 'tasks', 'projects']);
    const levels: ShareLevel[] = [];
    let s = startLevel(walk[0] as ShareLevel);
    for (const auto of walk) {
      s = reduceLevel(s, filters(auto));
      levels.push(s.level);
    }
    expect(levels).toEqual(walk);
  });
});
