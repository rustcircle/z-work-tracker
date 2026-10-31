import { useMemo, useState, type ReactNode } from 'react';

import { useApp } from '../../app/store';
import { effectiveEnd } from '../../lib/split';
import { parseIso } from '../../lib/tz';
import type { Task } from '../../lib/types';
import { useNav } from '../../components/nav';
import { Button } from '../../components/ui';
import { IconPlus } from '../../components/icons';
import { TaskCard } from './TaskCard';
import { TaskForm } from './TaskForm';

const STOPPED_PAGE = 8;
const NONE: readonly Task[] = [];

/** Left rail: the new-task form and the task list, active tasks first. */
export function TaskRail() {
  const { snapshot } = useApp();
  const nav = useNav();
  const launch = snapshot.launch;
  const [formOpen, setFormOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [showAllStopped, setShowAllStopped] = useState(false);

  const projectsById = useMemo(() => new Map(snapshot.projects.map((p) => [p.id, p])), [snapshot.projects]);
  const tasksById = useMemo(() => new Map(snapshot.tasks.map((t) => [t.id, t])), [snapshot.tasks]);

  // Closed time per task and the most recent activity, recomputed only when the segments change.
  const { logged, last } = useMemo(() => {
    const logged = new Map<string, number>();
    const last = new Map<string, number>();
    for (const s of snapshot.segments) {
      // A billable pause is billed, not worked: it is no logged time and no activity.
      if (s.kind === 'billablePause') continue;
      const start = parseIso(s.start);
      const openHere = s.end === null && s.provisionalEnd === null;
      const end = openHere ? start : effectiveEnd(s, 0);
      logged.set(s.taskId, (logged.get(s.taskId) ?? 0) + Math.max(0, end - start));
      last.set(s.taskId, Math.max(last.get(s.taskId) ?? 0, end));
    }
    return { logged, last };
  }, [snapshot.segments]);

  // Tasks that continue another one, grouped by the task they continue.
  const continuedBy = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of snapshot.tasks) {
      if (!t.continuedFrom) continue;
      const list = m.get(t.continuedFrom);
      if (list) list.push(t);
      else m.set(t.continuedFrom, [t]);
    }
    return m;
  }, [snapshot.tasks]);

  // A request to show one task (a chain link, a timeline entry) must reach it even when it is hidden
  // by the filter or by the short list of stopped tasks.
  const { focusTask } = nav;
  const [revealedSeq, setRevealedSeq] = useState(0);
  if (focusTask && focusTask.seq !== revealedSeq) {
    setRevealedSeq(focusTask.seq);
    setFilter('');
    if (tasksById.get(focusTask.id)?.state === 'stopped') setShowAllStopped(true);
  }

  const continuing = nav.continueTaskId ? tasksById.get(nav.continueTaskId) : undefined;
  const q = filter.trim().toLowerCase();
  const visible = snapshot.tasks.filter((t) => q === '' || t.name.toLowerCase().includes(q) || (projectsById.get(t.projectId)?.name.toLowerCase().includes(q) ?? false));
  const byRecent = (a: Task, b: Task): number => (last.get(b.id) ?? parseIso(b.createdAt)) - (last.get(a.id) ?? parseIso(a.createdAt));
  const active = visible.filter((t) => t.state === 'running' || t.state === 'paused').sort((a, b) => (a.state === b.state ? byRecent(a, b) : a.state === 'running' ? -1 : 1));
  const drafts = visible.filter((t) => t.state === 'draft').sort((a, b) => parseIso(b.createdAt) - parseIso(a.createdAt));
  const stopped = visible.filter((t) => t.state === 'stopped').sort(byRecent);
  const stoppedShown = showAllStopped ? stopped : stopped.slice(0, STOPPED_PAGE);
  const noProjects = snapshot.projects.filter((p) => !p.archived).length === 0;

  const group = (title: string, tasks: Task[], extra?: ReactNode) =>
    tasks.length > 0 && (
      <section className="rail-group" aria-label={title}>
        <h3 className="rail-group-title">
          {title} <span className="muted">{tasks.length}</span>
        </h3>
        <ul className="task-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <TaskCard task={t} project={projectsById.get(t.projectId)} tasks={tasksById} continuedBy={continuedBy.get(t.id) ?? NONE} launch={launch} loggedSecs={logged.get(t.id) ?? 0} />
            </li>
          ))}
        </ul>
        {extra}
      </section>
    );

  return (
    <aside className="rail" aria-label="Tasks">
      <div className="rail-head">
        <h2>Tasks</h2>
        <Button variant="primary" icon={<IconPlus />} aria-expanded={formOpen} onClick={() => { nav.clearContinue(); setFormOpen((v) => !v); }}>
          New task
        </Button>
      </div>
      {noProjects && (
        <p className="rail-hint">
          Tasks belong to a project.{' '}
          <button type="button" className="link" onClick={() => nav.go('projects')}>
            Create a project first
          </button>
          .
        </p>
      )}
      {continuing ? (
        <div className="card rail-form">
          <TaskForm key={`continue-${continuing.id}`} continueFrom={continuing} onDone={nav.clearContinue} />
        </div>
      ) : (
        formOpen && (
          <div className="card rail-form">
            <TaskForm onDone={() => setFormOpen(false)} />
          </div>
        )
      )}
      {snapshot.tasks.length > 3 && <input className="input" type="search" placeholder="Filter tasks" aria-label="Filter tasks" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      <div className="rail-scroll">
        {snapshot.tasks.length === 0 && !formOpen && !continuing && <p className="muted rail-empty">No tasks yet. Use New task to add one, then press Start to begin timing.</p>}
        {group('Active', active)}
        {group('Drafts', drafts)}
        {group(
          'Stopped',
          stoppedShown,
          stopped.length > STOPPED_PAGE && (
            <button type="button" className="link" onClick={() => setShowAllStopped((v) => !v)}>
              {showAllStopped ? 'Show fewer' : `Show all ${stopped.length} stopped tasks`}
            </button>
          ),
        )}
        {q !== '' && visible.length === 0 && <p className="muted rail-empty">No task matches “{filter}”.</p>}
      </div>
    </aside>
  );
}
