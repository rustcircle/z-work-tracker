// Parts of a task card added in phase 2, kept out of TaskCard.tsx so that file stays easy to merge:
// tag chips, billed and unbilled time, and the task-list items with their time and "Make active".
import { useEffect, useId, useRef } from 'react';

import { useAppState } from '../../app/store';
import { nextMarkIn, useStepNow } from '../../app/stepClock';
import { api } from '../../lib/api';
import { parseIso } from '../../lib/tz';
import type { Segment, Task } from '../../lib/types';
import { formatDuration } from '../../components/format';
import { Badge, Button } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { TagChips } from './TagPicker';
import { hasOpenPiece, piecesOf, taskTime, type SubtaskRow } from './taskFigures';
import './tasksP2.css';

/** The task's live tags as chips, under the project. */
export function TaskTags({ task }: { task: Task }) {
  const { snapshot } = useAppState();
  return <TagChips ids={task.tags} tags={snapshot.tags} />;
}

/** Billed and unbilled time, thinking and unconfirmed time, then the task-list items with their time. */
export function TaskTimeParts({ task }: { task: Task }) {
  const { snapshot } = useAppState();
  const pieces = piecesOf(snapshot.segments, task.id);
  const snapshotSec = parseIso(snapshot.now);
  // A task with nothing growing reads the same at any time, so only a running one follows the clock.
  return hasOpenPiece(pieces) ? <LiveTimeParts task={task} pieces={pieces} snapshotSec={snapshotSec} /> : <TimeParts task={task} pieces={pieces} nowSec={snapshotSec} snapshotSec={snapshotSec} />;
}

/** A running task's item times grow, but only each whole minute of the running stretch, never each second. */
function LiveTimeParts(p: { task: Task; pieces: readonly Segment[]; snapshotSec: number }) {
  const { snapshot } = useAppState();
  const open = p.pieces.find((x) => x.end === null && x.provisionalEnd === null);
  const since = open ? parseIso(open.start) : null;
  const nowSec = useStepNow(snapshot, (at) => (since === null ? null : nextMarkIn(at, since)));
  return <TimeParts {...p} nowSec={nowSec} />;
}

function TimeParts({ task, pieces, nowSec, snapshotSec }: { task: Task; pieces: readonly Segment[]; nowSec: number; snapshotSec: number }) {
  const t = taskTime(task, pieces, nowSec, snapshotSec);
  const billable = t.billedSecs + t.unbilledSecs > 0;
  const running = task.state === 'running';
  return (
    <>
      {(billable || t.thinkingSecs > 0 || t.unconfirmedSecs > 0) && (
        <ul className="task-figures" aria-label={`Time on ${task.name}`}>
          {billable && (
            <li data-testid="billed-line">
              Billed {formatDuration(t.billedSecs)}, unbilled {formatDuration(t.unbilledSecs)}
              {t.pauseSecs > 0 && `, includes ${formatDuration(t.pauseSecs)} billable pauses`}
            </li>
          )}
          {t.thinkingSecs > 0 && <li data-testid="thinking-line">Thinking time {formatDuration(t.thinkingSecs)}, counted as worked time</li>}
          {t.unconfirmedSecs > 0 && (
            <li className="task-unconfirmed" data-testid="unconfirmed-line">
              Unconfirmed: not counted until you confirm <span className="tabular">{formatDuration(t.unconfirmedSecs)}</span>
            </li>
          )}
        </ul>
      )}
      {t.subtasks.length > 0 && (
        <Subtasks
          task={task}
          rows={t.subtasks}
          noSubtaskSecs={t.noSubtaskSecs}
          noneActive={t.noneActive}
          workedSecs={t.workedSecs}
          orphanSecs={t.orphanSecs}
          running={running}
        />
      )}
    </>
  );
}

function Subtasks({ task, rows, noSubtaskSecs, noneActive, workedSecs, orphanSecs, running }: { task: Task; rows: SubtaskRow[]; noSubtaskSecs: number; noneActive: boolean; workedSecs: number; orphanSecs: number; running: boolean }) {
  const { act } = useCommands();
  const headId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  /** The row to give focus to once the switch is saved: the clicked button turns into a badge. */
  const focusKey = useRef<string | null>(null);
  const items = rows.reduce((n, r) => n + r.secs, 0);

  const activeKey = noneActive ? 'none' : (rows.find((r) => r.active)?.id ?? 'none');
  useEffect(() => {
    if (focusKey.current === null || focusKey.current !== activeKey) return;
    const row = Array.from(listRef.current?.children ?? []).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.row === activeKey);
    row?.focus();
    focusKey.current = null;
  }, [activeKey]);

  const choose = (id: string | null): void => {
    focusKey.current = id ?? 'none';
    void act(() => api.setActiveSubtask(task.id, id)).then((ok) => {
      if (!ok) focusKey.current = null;
    });
  };

  return (
    <section className="subtasks" aria-labelledby={headId}>
      <div className="subtasks-head">
        <h4 id={headId}>Subtasks</h4>
        <span className="subtask-total tabular" data-testid="subtask-total" title="Items plus time with no subtask">
          Total worked {formatDuration(workedSecs)}
        </span>
      </div>
      <ul className="subtask-list" ref={listRef}>
        {rows.map((r) => (
          <SubtaskItemRow key={r.id || r.text} row={r} onMakeActive={() => choose(r.id)} />
        ))}
        <li className={`subtask-row subtask-none${noneActive ? ' subtask-active' : ''}`} data-row="none" tabIndex={-1} aria-current={noneActive ? 'true' : undefined}>
          <span className="subtask-mark" aria-hidden="true">–</span>
          <span className="subtask-text">Time with no subtask</span>
          <span className="subtask-time tabular" data-testid="no-subtask-time">
            {formatDuration(noSubtaskSecs)}
          </span>
          {noneActive ? (
            <Badge tone="accent">Active</Badge>
          ) : (
            <Button small onClick={() => choose(null)}>
              No subtask
            </Button>
          )}
        </li>
      </ul>
      <p className="subtask-note">
        {formatDuration(items)} on items plus {formatDuration(noSubtaskSecs)} with no subtask makes {formatDuration(workedSecs)}. New time goes to the active one.
        {running && ' Switching now splits the running time at this moment.'}
        {orphanSecs > 0 && ` ${formatDuration(orphanSecs)} of the time with no subtask belongs to items that were removed from the list.`}
      </p>
    </section>
  );
}

function SubtaskItemRow({ row, onMakeActive }: { row: SubtaskRow; onMakeActive: () => void }) {
  const textId = useId();
  return (
    <li className={`subtask-row${row.active ? ' subtask-active' : ''}${row.checked ? ' subtask-done' : ''}`} data-row={row.id || undefined} tabIndex={-1} aria-current={row.active ? 'true' : undefined}>
      <span className="subtask-mark" aria-hidden="true">
        {row.checked ? '☑' : '☐'}
      </span>
      <span className="subtask-text" id={textId}>
        {row.text || 'Untitled item'}
        {row.checked && <span className="visually-hidden"> (ticked)</span>}
      </span>
      <span className="subtask-time tabular">{formatDuration(row.secs)}</span>
      {row.active ? (
        <Badge tone="accent">Active</Badge>
      ) : row.canActivate ? (
        <Button small aria-describedby={textId} onClick={onMakeActive}>
          Make active
        </Button>
      ) : (
        <Button small disabled aria-describedby={textId} title="Saved items only">
          Make active
        </Button>
      )}
      {!row.canActivate && <span className="subtask-note subtask-saved-only">Saved items only</span>}
    </li>
  );
}
