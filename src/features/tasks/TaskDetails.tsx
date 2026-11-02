// The "Details" dialog of a task: add time by hand, correct recorded time, read the history, bill pauses
// and change what time away means. One dialog with five tabs; the card only carries the button. Below the tabs
// is the only way to delete a task that has started.
import { useId, useRef, useState, type KeyboardEvent } from 'react';

import { useAppState } from '../../app/store';
import { formatDuration } from '../../components/format';
import { Button, Modal } from '../../components/ui';
import type { Task } from '../../lib/types';
import { AddTimeForm } from './details/AddTimeForm';
import { AwayList } from './details/AwayList';
import { CorrectionsList } from './details/CorrectionsList';
import { DeleteTask } from './details/DeleteTask';
import { HistoryTab } from './details/HistoryTab';
import { PausesList } from './details/PausesList';
import './details/details.css';

const TABS = [
  { id: 'add', label: 'Add time' },
  { id: 'corrections', label: 'Corrections' },
  { id: 'history', label: 'History' },
  { id: 'pauses', label: 'Pauses' },
  { id: 'away', label: 'Time away' },
] as const;
type TabKey = (typeof TABS)[number]['id'];

/** The button for a task card, and the dialog it opens. Focus returns to the button when the dialog closes. */
export function TaskDetailsButton({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button small title={`Details for ${task.name}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Details
      </Button>
      <TaskDetails task={task} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function TaskDetails({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  // Read the live task each render: the card's own copy is replaced with every snapshot.
  const { snapshot } = useAppState();
  const live = snapshot.tasks.find((t) => t.id === task.id) ?? task;
  const [tab, setTab] = useState<TabKey>('add');
  const base = useId();
  const refs = useRef(new Map<TabKey, HTMLButtonElement>());

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length];
    if (!target) return;
    setTab(target.id);
    refs.current.get(target.id)?.focus();
  };

  const pauseSecs = live.pauseSecs;
  return (
    <Modal open={open} title={`Details: ${live.name}`} onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
      <dl className="details-figures" aria-label="Time on this task">
        <div>
          <dt>Billable pauses</dt>
          <dd className="tabular">{formatDuration(pauseSecs)}</dd>
        </div>
        <div>
          <dt>Thinking time</dt>
          <dd className="tabular">{formatDuration(live.thinkingSecs)}</dd>
        </div>
        <div>
          <dt>Unconfirmed</dt>
          <dd className="tabular">{formatDuration(live.unconfirmedSecs)}</dd>
          {live.unconfirmedSecs > 0 && <dd className="details-fig-note">Not counted until you confirm</dd>}
        </div>
      </dl>
      <div className="details-tabs" role="tablist" aria-label="Task details">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            data-autofocus={tab === t.id ? '' : undefined}
            className={`details-tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => setTab(t.id)}
            onKeyDown={onKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="details-panel" role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`}>
        {tab === 'add' && <AddTimeForm task={live} />}
        {tab === 'corrections' && <CorrectionsList task={live} />}
        {tab === 'history' && <HistoryTab task={live} />}
        {tab === 'pauses' && <PausesList task={live} />}
        {tab === 'away' && <AwayList task={live} />}
      </div>
      <DeleteTask task={live} close={onClose} />
    </Modal>
  );
}
