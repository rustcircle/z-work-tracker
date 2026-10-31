import { memo, useState, type ReactElement } from 'react';

import { api } from '../../lib/api';
import type { Project, Task } from '../../lib/types';
import { useApp } from '../../app/store';
import { RichView, hasDescription } from '../../components/RichText';
import { Badge, Button, IconButton, Modal, ProjectChip } from '../../components/ui';
import { IconChevron, IconEdit, IconPause, IconPlay, IconStop, IconTrash } from '../../components/icons';
import { formatDuration } from '../../components/format';
import { useCommands } from '../../components/useCommands';
import { LiveTicker } from './LiveTicker';
import { TaskForm } from './TaskForm';
import { STATE_LABEL, controlsFor, pauseReasonText } from './taskLogic';

interface Props {
  task: Task;
  project: Project | undefined;
  tasks: ReadonlyMap<string, Task>;
  /** Closed time already logged on this task, in seconds. */
  loggedSecs: number;
}

const TONE = { draft: 'neutral', running: 'success', paused: 'warning', stopped: 'neutral' } as const;

function TaskCardImpl({ task, project, tasks, loggedSecs }: Props) {
  const { snapshot } = useApp();
  const { act, transition } = useCommands();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const c = controlsFor(task, project);
  const reason = task.state === 'paused' ? pauseReasonText(task.pauseReason, tasks) : null;
  const detail = hasDescription(task.description);
  const titleId = `task-${task.id}`;

  const btn = (label: 'Start' | 'Pause' | 'Resume' | 'Stop', ctl: { enabled: boolean; why: string | null }, icon: ReactElement, run: () => void, variant: 'primary' | 'secondary' = 'secondary') => (
    <Button key={label} small variant={variant} icon={icon} disabled={!ctl.enabled} title={ctl.why ?? undefined} onClick={run}>
      {label}
    </Button>
  );

  return (
    <article className={`task task-${task.state}`} aria-labelledby={titleId} data-state={task.state}>
      <header className="task-head">
        <h3 id={titleId} className="task-name">
          {task.name}
        </h3>
        <Badge tone={TONE[task.state]}>{STATE_LABEL[task.state]}</Badge>
      </header>
      <div className="task-meta">
        {project ? <ProjectChip name={project.name} color={project.color} archived={project.archived} /> : <Badge tone="danger">No project</Badge>}
        {task.state !== 'draft' && task.state !== 'running' && loggedSecs > 0 && <span className="muted tabular">{formatDuration(loggedSecs)} logged</span>}
      </div>
      {task.runningElsewhere && (
        <p className="task-note" role="note">
          Running on <strong>{task.runningElsewhere}</strong>. Time keeps counting there; you can stop it from here.
        </p>
      )}
      {reason && <p className="task-note task-note-pause">{reason}</p>}
      {task.state === 'paused' && !reason && <p className="task-note">Paused. Time is not being counted.</p>}
      {task.state === 'running' && project && !task.runningElsewhere && <LiveTicker task={task} project={project} />}
      {task.state === 'stopped' && task.stoppedAt && <p className="muted task-note">Stopped {task.stoppedAt.slice(0, 16).replace('T', ' ')} UTC.</p>}

      <div className="task-actions" role="group" aria-label={`Controls for ${task.name}`}>
        {btn('Start', c.start, <IconPlay />, () => void transition(() => api.startTask(task.id), task.name), 'primary')}
        {btn('Pause', c.pause, <IconPause />, () => void act(() => api.pauseTask(task.id)))}
        {btn('Resume', c.resume, <IconPlay />, () => void transition(() => api.resumeTask(task.id), task.name), 'primary')}
        {btn('Stop', c.stop, <IconStop />, () => void act(() => api.stopTask(task.id)))}
      </div>
      <div className="task-tools">
        <IconButton label={`Edit ${task.name}`} icon={<IconEdit />} onClick={() => setEditing((v) => !v)} aria-expanded={editing} />
        {task.state === 'draft' && <IconButton label={`Delete draft ${task.name}`} icon={<IconTrash />} onClick={() => setConfirmDelete(true)} />}
        {detail && (
          <button type="button" className="link task-details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            Description <IconChevron open={open} />
          </button>
        )}
      </div>
      {editing && <TaskForm task={task} onDone={() => setEditing(false)} />}
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
      </Modal>
    </article>
  );
}

export const TaskCard = memo(TaskCardImpl);
