// The task filter's state and its one control, shown in the task list and on the Timeline. Both bars edit
// the same filter, so what the list shows and what the Timeline draws never disagree.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useAppState } from '../../app/store';
import { Button } from '../../components/ui';
import { IconClose } from '../../components/icons';
import { plural } from '../../components/format';
import { NO_TASK_FILTER, isTaskFilterActive, type TaskFilter } from './taskFilter';
import './taskFilter.css';

interface FilterApi {
  filter: TaskFilter;
  setFilter: (f: TaskFilter) => void;
  clear: () => void;
}

const INERT: FilterApi = { filter: NO_TASK_FILTER, setFilter: () => undefined, clear: () => undefined };
const Ctx = createContext<FilterApi>(INERT);

/** Not persisted: a new launch starts unfiltered. */
export function TaskFilterProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useAppState();
  const [stored, setFilter] = useState<TaskFilter>(NO_TASK_FILTER);
  // A project or tag deleted while it was the filter is no filter any more: nothing could pass, and nothing on screen would say why.
  const filter = useMemo<TaskFilter>(() => {
    const projectGone = stored.projectId !== '' && !snapshot.projects.some((p) => p.id === stored.projectId);
    const tagIds = stored.tagIds.filter((id) => snapshot.tags.some((t) => t.id === id && !t.deleted));
    return !projectGone && tagIds.length === stored.tagIds.length ? stored : { ...stored, projectId: projectGone ? '' : stored.projectId, tagIds };
  }, [stored, snapshot.projects, snapshot.tags]);
  const value = useMemo<FilterApi>(() => ({ filter, setFilter, clear: () => setFilter(NO_TASK_FILTER) }), [filter]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTaskFilter = (): FilterApi => useContext(Ctx);

/** Typing waits this long for a pause before the lists are filtered. */
export const FILTER_DEBOUNCE_MS = 200;

interface BarProps {
  /** How many tasks pass, and how many there are, for the line under the box. */
  matches: number;
  total: number;
  /** A shorter bar: project and tags sit behind "More filters". */
  compact?: boolean;
  /** Names the bar's controls apart when two are on screen. */
  scope: string;
}

export function TaskFilterBar({ matches, total, compact = false, scope }: BarProps) {
  const { snapshot } = useAppState();
  const { filter, setFilter, clear } = useTaskFilter();
  const [draft, setDraft] = useState(filter.text);
  const [seen, setSeen] = useState(filter.text);
  // The other bar (or Clear) changed the text: follow it.
  if (seen !== filter.text) {
    setSeen(filter.text);
    setDraft(filter.text);
  }
  useEffect(() => {
    if (draft === filter.text) return;
    const timer = window.setTimeout(() => setFilter({ ...filter, text: draft }), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, filter, setFilter]);

  const active = isTaskFilterActive(filter) || draft.trim() !== '';
  const liveTags = snapshot.tags.filter((t) => !t.deleted);
  const projects = snapshot.projects;
  const toggleTag = (id: string): void => setFilter({ ...filter, tagIds: filter.tagIds.includes(id) ? filter.tagIds.filter((x) => x !== id) : [...filter.tagIds, id] });

  const extra = (
    <div className="tf-extra">
      <label className="tf-field">
        <span>Project</span>
        <select className="input" value={filter.projectId} onChange={(e) => setFilter({ ...filter, projectId: e.target.value })} aria-label={`Filter ${scope} by project`}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.archived ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </label>
      {liveTags.length > 0 && (
        <fieldset className="tf-tags">
          <legend>Tags (any of these)</legend>
          {liveTags.map((t) => (
            <label key={t.id} className="tf-tag">
              <input type="checkbox" aria-label={`Filter ${scope} by tag ${t.name}`} checked={filter.tagIds.includes(t.id)} onChange={() => toggleTag(t.id)} />
              <span className="tf-dot" style={{ background: t.color }} aria-hidden="true" />
              <span>{t.name}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );

  const extraActive = filter.projectId !== '' || filter.tagIds.length > 0;
  return (
    <div className={`tf${compact ? ' tf-compact' : ''}`} role="search" aria-label={`Filter ${scope}`} data-testid={`task-filter-${scope}`}>
      <div className="tf-row">
        <input
          className="input tf-text"
          type="search"
          placeholder="Search name or description"
          aria-label={`Search ${scope} by name or description`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        {active && (
          <Button small icon={<IconClose />} onClick={clear}>
            Clear filter
          </Button>
        )}
      </div>
      {compact ? (
        <details className="tf-more" open={extraActive || undefined}>
          <summary>More filters{extraActive ? ' (on)' : ''}</summary>
          {extra}
        </details>
      ) : (
        extra
      )}
      <p className="tf-status muted" role="status" aria-live="polite" data-testid="task-filter-status">
        {active ? `${matches} of ${plural(total, 'task')} match` : ''}
      </p>
    </div>
  );
}
