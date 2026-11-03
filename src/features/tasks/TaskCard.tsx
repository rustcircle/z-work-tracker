import { memo, useEffect, useRef, useState, type ReactElement } from 'react';

import { api } from '../../lib/api';
import type { LaunchState, Project, Task } from '../../lib/types';
import { useAppState } from '../../app/store';
import { useReadOnly } from '../../app/useReadOnly';
import { useNav } from '../../components/nav';
import { RichView, hasDescription } from '../../components/RichText';
import { Badge, Button, IconButton, Modal, ProjectChip } from '../../components/ui';
import { IconChevron, IconEdit, IconPause, IconPlay, IconStop, IconTrash } from '../../components/icons';
import { formatDuration } from '../../components/format';
import { useCommands } from '../../components/useCommands';
import { useEditStore } from './editStore';
import { LiveTicker } from './LiveTicker';
import { TaskDetailsButton } from './TaskDetails';
import { TaskEditor } from './TaskEditor';
import { RemotePause, TaskTags, TaskTimeParts } from './TaskCardExtras';
import { STATE_LABEL, controlsFor, pauseReasonText, type Control } from './taskLogic';

interface Props {
  task: Task;
  project: Project | undefined;
  tasks: ReadonlyMap<string, Task>;
  /** Tasks created by continuing this one. */
  continuedBy: readonly Task[];
  launch: LaunchState;
  /** Closed time already logged on this task, in seconds. */
  loggedSecs: number;
}

const TONE = { draft: 'neutral', running: 'success', paused: 'warning', stopped: 'neutral' } as const;

function TaskCardImpl({ task, project, tasks, continuedBy, launch, loggedSecs }: Props) {
  const { snapshot } = useAppState();
  const { act, transition } = useCommands();
  const nav = useNav();
  const store = useEditStore();
  const ro = useReadOnly();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const handledSeq = useRef(0);
  const editing = store.editing.has(task.id);
  const allowed = controlsFor(task, project, launch, snapshot.tags);
  // What the state of the task allows is not enough while another computer holds the lease: the backend refuses all four.
  // A control that is off for its own reason keeps that reason.
  const gate = (ctl: Control): Control => (ro.readOnly && ctl.enabled ? { enabled: false, why: ro.why } : ctl);
  const c = { start: gate(allowed.start), pause: gate(allowed.pause), resume: gate(allowed.resume), stop: gate(allowed.stop) };
  const reason = task.state === 'paused' ? pauseReasonText(task.pauseReason, tasks) : null;
  const detail = hasDescription(task.description);
  const titleId = `task-${task.id}`;
  const from = task.continuedFrom ? tasks.get(task.continuedFrom) : undefined;

  // A link elsewhere (a timeline entry, a chain link) asked to bring this card into view.
  const { focusTask, clearFocusTask } = nav;
  const { open: openEditor } = store;
  useEffect(() => {
    if (!focusTask || focusTask.id !== task.id || handledSeq.current === focusTask.seq) return;
    handledSeq.current = focusTask.seq;
    articleRef.current?.scrollIntoView?.({ block: 'nearest' });
    if (focusTask.edit) openEditor(task.id);
    else articleRef.current?.focus();
    clearFocusTask();
  }, [focusTask, task.id, openEditor, clearFocusTask]);

  const btn = (label: 'Start' | 'Pause' | 'Resume' | 'Stop', ctl: { enabled: boolean; why: string | null }, icon: ReactElement, run: () => void, variant: 'primary' | 'secondary' = 'secondary') => (
    <Button key={label} small variant={variant} icon={icon} disabled={!ctl.enabled} title={ctl.why ?? undefined} onClick={run}>
      {label}
    </Button>
  );

  // Cold launch: Resume never continues the old task directly. It opens the form for a new, linked task.
  const resume = () => (launch.warm ? void transition(() => api.resumeTask(task.id), task.name) : nav.openContinue(task.id));

  return (
    <article ref={articleRef} tabIndex={-1} className={`task task-${task.state}`} aria-labelledby={titleId} data-state={task.state} data-task-id={task.id}>
      <header className="task-head">
        <h3 id={titleId} className="task-name">
          {task.name}
        </h3>
        <Badge tone={TONE[task.state]}>{STATE_LABEL[task.state]}</Badge>
      </header>
      <div className="task-meta">
        {project ? <ProjectChip name={project.name} color={project.color} archived={project.archived} /> : <Badge tone="danger">No project</Badge>}
        {task.state !== 'draft' && task.state !== 'running' && loggedSecs > 0 && <span className="muted tabular">{formatDuration(loggedSecs)} logged</span>}
        <TaskTags task={task} />
      </div>
      {(task.continuedFrom || continuedBy.length > 0) && (
        <ul className="chain" aria-label="Continuation links">
          {task.continuedFrom && (
            <li>
              Continued from{' '}
              {from ? (
                <button type="button" className="link" onClick={() => nav.goToTask(from.id)}>
                  {from.name}
                </button>
              ) : (
                'an earlier task'
              )}
            </li>
          )}
          {continuedBy.map((t) => (
            <li key={t.id}>
              Continued by{' '}
              <button type="button" className="link" onClick={() => nav.goToTask(t.id)}>
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {task.runningElsewhere && (
        <p className="task-note" role="note">
          Running on <strong>{task.runningElsewhere}</strong>. Time keeps counting there; you can stop it from here.
        </p>
      )}
      {task.runningElsewhere && <RemotePause task={task} />}
      {reason && <p className="task-note task-note-pause">{reason}</p>}
      {task.state === 'paused' && !reason && <p className="task-note">Paused. Time is not being counted.</p>}
      {task.state === 'paused' && !launch.warm && <p className="task-note">After a restart, Resume asks for every field again and starts a new task that continues this one. This task stays as it is.</p>}
      {task.state === 'running' && project && !task.runningElsewhere && <LiveTicker task={task} project={project} />}
      {task.state === 'stopped' && task.stoppedAt && <p className="muted task-note">Stopped {task.stoppedAt.slice(0, 16).replace('T', ' ')} UTC.</p>}
      <TaskTimeParts task={task} />

      <div className="task-actions" role="group" aria-label={`Controls for ${task.name}`}>
        {btn('Start', c.start, <IconPlay />, () => void transition(() => api.startTask(task.id), task.name), 'primary')}
        {btn('Pause', c.pause, <IconPause />, () => void act(() => api.pauseTask(task.id)))}
        {btn('Resume', c.resume, <IconPlay />, resume, 'primary')}
        {btn('Stop', c.stop, <IconStop />, () => void act(() => api.stopTask(task.id)))}
      </div>
      {c.start.why && task.state === 'draft' && <p className="task-note">{c.start.why}</p>}
      <div className="task-tools">
        <IconButton label={`Edit ${task.name}`} icon={<IconEdit />} onClick={() => (editing ? store.close(task.id) : store.open(task.id))} aria-expanded={editing} />
        {task.state !== 'draft' && <TaskDetailsButton task={task} />}
        {task.state === 'draft' && <IconButton label={`Delete draft ${task.name}`} icon={<IconTrash />} disabled={ro.readOnly} title={ro.readOnly ? (ro.why ?? undefined) : `Delete draft ${task.name}`} onClick={() => setConfirmDelete(true)} />}
        {detail && !editing && (
          <button type="button" className="link task-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Description <IconChevron open={open} />
          </button>
        )}
      </div>
      {editing && <TaskEditor task={task} />}
      {open && !editing && (
        <div className="task-desc">
          <RichView doc={task.description} label={`Description of ${task.name}`} />
        </div>
      )}
      <Modal
        open={confirmDelete}
        title="Delete this draft?"
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
            <Button
              variant="danger"
              disabled={ro.readOnly}
              onClick={() => {
                setConfirmDelete(false);
                void act(() => api.deleteDraft(task.id));
              }}
            >
              Delete draft
            </Button>
          </>
        }
      >
        <p>
          “{task.name}” has no logged time. Deleting removes it from {snapshot.deviceName} and from synced devices.
        </p>
        {ro.readOnly && <p className="muted">{ro.why}</p>}
      </Modal>
    </article>
  );
}

export const TaskCard = memo(TaskCardImpl);
