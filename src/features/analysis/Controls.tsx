// Range, comparison, basis and filters.
import { useEffect, useMemo, useState } from 'react';

import { onRadioKeyDown } from '../../components/ui';
import { BANDS } from '../../lib/split';
import { OUTSIDE, NO_FILTERS, type Filters } from './engine';
import type { Basis } from './mctx';
import { DayInput } from './DayInput';
import { MAX_CUSTOM_DAYS, defaultRange, shiftRange, spanDays, withCustomEnd, type RangeKind, type RangeSpec } from './range';
import { groupVersions } from '../../lib/shifts';
import type { Snapshot } from '../../lib/types';

const KINDS: { kind: RangeKind; label: string }[] = [
  { kind: 'day', label: 'Day' },
  { kind: 'week', label: 'Week' },
  { kind: 'month', label: 'Month' },
  { kind: 'quarter', label: 'Quarter' },
  { kind: 'year', label: 'Year' },
  { kind: 'custom', label: 'Custom' },
];

export interface ControlsProps {
  snapshot: Snapshot;
  today: string;
  range: RangeSpec;
  setRange: (r: RangeSpec) => void;
  periodLabel: string;
  filters: Filters;
  setFilters: (f: Filters) => void;
  /** How many tasks the name and description search matches, or null when nothing is typed. */
  matches?: number | null;
  basis: Basis;
  setBasis: (b: Basis) => void;
  billableAvailable: boolean;
  compare: boolean;
  setCompare: (c: boolean) => void;
  onGlossary: () => void;
}

export function Controls(p: ControlsProps) {
  const { range, filters } = p;
  const span = spanDays(range);
  const activeProjects = useMemo(() => p.snapshot.projects.filter((x) => !x.archived || filters.projectIds.includes(x.id)), [p.snapshot.projects, filters.projectIds]);
  const tasks = useMemo(() => p.snapshot.tasks.filter((t) => t.state !== 'draft'), [p.snapshot.tasks]);
  const shifts = useMemo(() => [...groupVersions(p.snapshot.shifts)].map(([id, v]) => ({ id, name: [...v].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]?.name ?? id })), [p.snapshot.shifts]);
  const liveTags = useMemo(() => p.snapshot.tags.filter((t) => !t.deleted), [p.snapshot.tags]);
  const filtered = filters.projectIds.length > 0 || filters.taskIds.length > 0 || filters.tagIds.length > 0 || (filters.query ?? '') !== '' || filters.band !== null || filters.shiftKey !== null;
  // Typing waits for a pause before the charts are worked out again.
  const [draft, setDraft] = useState(filters.query ?? '');
  const [seen, setSeen] = useState(filters.query ?? '');
  if (seen !== (filters.query ?? '')) {
    setSeen(filters.query ?? '');
    setDraft(filters.query ?? '');
  }
  const { setFilters } = p;
  useEffect(() => {
    if (draft === (filters.query ?? '')) return;
    const timer = window.setTimeout(() => setFilters({ ...filters, query: draft }), 200);
    return () => window.clearTimeout(timer);
  }, [draft, filters, setFilters]);
  const setKind = (kind: RangeKind): void => {
    if (kind === 'custom') p.setRange({ kind, anchor: span.fromDay, from: span.fromDay, to: span.toDay });
    else p.setRange({ kind, anchor: kind === range.kind ? range.anchor : p.today >= span.fromDay && p.today <= span.toDay ? p.today : span.fromDay });
  };
  const toggleProject = (id: string): void =>
    p.setFilters({ ...filters, projectIds: filters.projectIds.includes(id) ? filters.projectIds.filter((x) => x !== id) : [...filters.projectIds, id] });
  const toggleTag = (id: string): void => p.setFilters({ ...filters, tagIds: filters.tagIds.includes(id) ? filters.tagIds.filter((x) => x !== id) : [...filters.tagIds, id] });
  return (
    <div className="a-controls" role="group" aria-label="Analysis controls">
      <div className="a-row a-wrap">
        <div className="a-seg" role="radiogroup" aria-label="Range" onKeyDown={onRadioKeyDown}>
          {KINDS.map((k) => (
            <button key={k.kind} type="button" role="radio" aria-checked={range.kind === k.kind} tabIndex={range.kind === k.kind ? 0 : -1} className={`a-seg-btn ${range.kind === k.kind ? 'is-on' : ''}`} onClick={() => setKind(k.kind)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="a-row">
          <button type="button" className="a-btn" aria-label="Previous period" onClick={() => p.setRange(shiftRange(range, -1))}>
            ‹
          </button>
          <strong className="a-period tabular" aria-live="polite">
            {p.periodLabel}
          </strong>
          <button type="button" className="a-btn" aria-label="Next period" onClick={() => p.setRange(shiftRange(range, 1))}>
            ›
          </button>
          <button type="button" className="a-btn" onClick={() => p.setRange(range.kind === 'custom' ? defaultRange(p.today) : { kind: range.kind, anchor: p.today })}>
            {range.kind === 'custom' ? 'This week' : 'Today'}
          </button>
        </div>
        {range.kind === 'custom' ? (
          <div className="a-row">
            <label className="a-field a-inline">
              <span>From</span>
              <DayInput value={span.fromDay} max={span.toDay} onDay={(day) => p.setRange(withCustomEnd(range, 'from', day))} />
            </label>
            <label className="a-field a-inline">
              <span>To</span>
              <DayInput value={span.toDay} min={span.fromDay} onDay={(day) => p.setRange(withCustomEnd(range, 'to', day))} />
            </label>
            <span className="muted">Up to {MAX_CUSTOM_DAYS} days</span>
          </div>
        ) : null}
      </div>
      <div className="a-row a-wrap">
        <div className="a-seg" role="radiogroup" aria-label="Time basis" onKeyDown={onRadioKeyDown}>
          {(['billable', 'exact'] as const).map((b) => (
            <button key={b} type="button" role="radio" aria-checked={p.basis === b} tabIndex={p.basis === b ? 0 : -1} disabled={b === 'billable' && !p.billableAvailable} className={`a-seg-btn ${p.basis === b ? 'is-on' : ''}`} onClick={() => p.setBasis(b)}>
              {b === 'billable' ? 'Billable' : 'Exact'}
            </button>
          ))}
        </div>
        {!p.billableAvailable ? <span className="muted">Billable is off while a band or shift filter is on.</span> : null}
        <label className="a-check">
          <input type="checkbox" checked={p.compare} onChange={(e) => p.setCompare(e.target.checked)} />
          <span>Compare with the previous period</span>
        </label>
        <button type="button" className="a-btn" onClick={p.onGlossary}>
          Metrics glossary
        </button>
      </div>
      <div className="a-row a-wrap" role="group" aria-label="Filters">
        <details className="a-menu">
          <summary>Projects: {filters.projectIds.length === 0 ? 'all' : `${filters.projectIds.length} selected`}</summary>
          <div className="a-menu-body">
            {activeProjects.map((x) => (
              <label key={x.id} className="a-check">
                <input type="checkbox" checked={filters.projectIds.includes(x.id)} onChange={() => toggleProject(x.id)} />
                <span className="a-dot-sw" style={{ background: x.color }} aria-hidden="true" />
                <span>{x.name}</span>
              </label>
            ))}
            {activeProjects.length === 0 ? <span className="muted">No projects yet</span> : null}
          </div>
        </details>
        <label className="a-field a-inline">
          <span>Task</span>
          <select value={filters.taskIds[0] ?? ''} onChange={(e) => p.setFilters({ ...filters, taskIds: e.target.value ? [e.target.value] : [] })}>
            <option value="">All tasks</option>
            {activeProjects.map((pr) => (
              <optgroup key={pr.id} label={pr.name}>
                {tasks
                  .filter((t) => t.projectId === pr.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="a-field a-inline">
          <span>Band</span>
          <select value={filters.band === null ? '' : String(filters.band)} onChange={(e) => p.setFilters({ ...filters, band: e.target.value === '' ? null : (Number(e.target.value) as 0 | 1 | 2 | 3) })}>
            <option value="">All day</option>
            {BANDS.map((b, i) => (
              <option key={b} value={i}>
                {b} ({['00-06', '06-12', '12-18', '18-24'][i]})
              </option>
            ))}
          </select>
        </label>
        <label className="a-field a-inline">
          <span>Shift</span>
          <select value={filters.shiftKey ?? ''} onChange={(e) => p.setFilters({ ...filters, shiftKey: e.target.value === '' ? null : e.target.value })} disabled={shifts.length === 0}>
            <option value="">{shifts.length === 0 ? 'No shifts set up' : 'All time'}</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {shifts.length > 0 ? <option value={OUTSIDE}>Outside any shift</option> : null}
          </select>
        </label>
        {filtered ? (
          <button type="button" className="a-btn" onClick={() => p.setFilters(NO_FILTERS)}>
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="a-row a-wrap" role="group" aria-label="Search">
        <label className="a-field a-inline">
          <span>Search</span>
          <input type="search" placeholder="Task name or description" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Search tasks by name or description" autoComplete="off" />
        </label>
        {p.matches !== null && p.matches !== undefined ? (
          <span className="muted" role="status" aria-live="polite" data-testid="analysis-search-status">
            {p.matches} {p.matches === 1 ? 'task matches' : 'tasks match'}
          </span>
        ) : null}
      </div>
      {liveTags.length > 0 ? (
        <div className="a-row a-wrap" role="group" aria-label="Tag filter">
          <span className="a-field-label">Tags</span>
          {liveTags.map((t) => (
            <label key={t.id} className="a-check">
              <input type="checkbox" checked={filters.tagIds.includes(t.id)} onChange={() => toggleTag(t.id)} />
              <span className="a-dot-sw" style={{ background: t.color }} aria-hidden="true" />
              <span>{t.name}</span>
            </label>
          ))}
          <span className="muted a-tag-hint">{filters.tagIds.length === 0 ? 'All tasks' : 'Tasks with any selected tag'}; whole tasks are kept, so Billable stays available.</span>
        </div>
      ) : null}
    </div>
  );
}
