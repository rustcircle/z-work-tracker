// Deleting a task, from the bottom of its Details: a red button, then two dialogs. The first says what goes with the
// task, the second asks once more. Backing out of either changes nothing.
//
// Both dialogs answer only to a mouse click or a tap. Enter does nothing in them, whatever has focus. Space, or a screen
// reader's usual activation of a button, on Continue or Delete task clicks with a count of 0 and does nothing either: a
// keyboard is no way to delete a task here. Keep it and Esc back out, and Space on Keep it does too. There is no close button, and a click
// beside a dialog does nothing: the second click of a double click on Continue lands beside the next dialog, or on
// its Keep it, and must not be what decides.
//
// Each of those two buttons also waits a second after its dialog comes up (the same second a notice in the task editor
// waits before a press of Done means anything), and ignores the second click of a double click. Otherwise a double click
// on Continue would carry on to Delete task, which sits under it in the next dialog.
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { useAppState } from '../../../app/store';
import { amountText, formatDuration, listOf, plural } from '../../../components/format';
import { useNav } from '../../../components/nav';
import { useToast } from '../../../components/Toasts';
import { Button, Modal } from '../../../components/ui';
import { api } from '../../../lib/api';
import type { Task } from '../../../lib/types';
import { useSelection } from '../../timeline/selection';
import { useEditStore } from '../editStore';
import { attempt, sentence } from './attempt';
import { blockText, deleteBlocks, elsewhereText, footprint, runningElsewhere } from './deleteRules';

/**
 * How long Continue and Delete task wait, from the moment their dialog is up, before they answer a press. Windows' longest
 * double-click time is 900 ms, so a double click can't reach the second dialog's button before it is ready.
 */
export const ARM_MS = 1000;

type Step = 'review' | 'confirm';

/** Said in both dialogs, so that a person at a keyboard knows why nothing happens. */
const CLICK_ONLY = 'Only a click or a tap goes on here. Enter and Space do nothing, and Esc keeps the task.';

/** True for a mouse click or a tap. A key press (Enter, Space) or a screen reader's usual activation of a button clicks with a count of 0, and the second click of a double click counts 2. */
const aClick = (e: ReactMouseEvent<HTMLElement>): boolean => e.detail === 1;

/** False until `ARM_MS` after the component using it appeared. */
function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return armed;
}

/**
 * True while the dialog on top of the page is one of the two delete dialogs. Another that opens by itself over them, such
 * as the time-away one, is on top and keeps its own keys. A portal is added to the end of the body, so the last dialog
 * in the document is the one most recently opened.
 */
const deleteDialogIsOnTop = (): boolean => [...document.querySelectorAll('[role="dialog"]')].at(-1)?.querySelector('[data-delete-step]') != null;

/**
 * While a delete dialog is on top, Enter does nothing and Esc backs out of it, and only it. This sits on the window in
 * the capture phase, ahead of the dialogs' own listeners on the document: otherwise the Details underneath, which is
 * open too, would close on the same Esc, and Enter would press whatever button has focus.
 */
function useDeleteKeys(active: boolean, back: () => void): void {
  const backRef = useRef(back);
  useEffect(() => {
    backRef.current = back;
  });
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'Enter' && e.key !== 'Escape') || !deleteDialogIsOnTop()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') backRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}

/** The names of the tasks that continue the deleted one, as many as fit in a sentence. */
function namesOf(tasks: readonly Task[]): string {
  const shown = tasks.slice(0, 3).map((t) => `“${t.name}”`);
  return tasks.length > 3 ? `${shown.join(', ')} and ${tasks.length - 3} more` : listOf(shown);
}

function ReviewDialog({ task, onKeep, onContinue }: { task: Task; onKeep: () => void; onContinue: () => void }) {
  const { snapshot, zones } = useAppState();
  const armed = useArmed();
  const fp = useMemo(() => footprint(snapshot, task, zones.active), [snapshot, task, zones.active]);
  const project = snapshot.projects.find((p) => p.id === task.projectId);
  const earnings = amountText(fp.billable, snapshot.prefs.hideEarnings);
  const synced = snapshot.sync.targets.length > 0;
  const n = fp.continuedBy.length;
  const away = runningElsewhere(snapshot, task);
  return (
    <Modal
      open
      title="Delete this task?"
      dismissible={false}
      onClose={onKeep}
      footer={
        <>
          <Button data-autofocus="" data-delete-step="" onClick={onKeep}>
            Keep it
          </Button>
          <Button
            disabled={!armed}
            onClick={(e) => {
              if (aClick(e)) onContinue();
            }}
          >
            Continue
          </Button>
        </>
      }
    >
      <p className="delete-text">
        “{task.name}”{project ? ` in ${project.name}` : ''} will be deleted from {snapshot.deviceName} and from synced devices, with everything logged on it.
      </p>
      {away && <p className="delete-text delete-running">{elsewhereText(away.device)}</p>}
      <dl className="delete-figures" aria-label="What goes with it">
        <div>
          <dt>Time logged</dt>
          <dd className="tabular">{fp.loggedSecs > 0 ? `${formatDuration(fp.loggedSecs)}${fp.days > 0 ? ` on ${plural(fp.days, 'day')}` : ''}` : 'None'}</dd>
        </div>
        {fp.unconfirmedSecs > 0 && (
          <div>
            <dt>Unconfirmed</dt>
            <dd className="tabular">{formatDuration(fp.unconfirmedSecs)} of time away, not counted</dd>
          </div>
        )}
        {earnings !== '' && (
          <div>
            <dt>Earnings</dt>
            <dd className="tabular">{earnings}</dd>
          </div>
        )}
      </dl>
      <p>This removes the whole task and all its time, not only one day&apos;s entry. It goes from the Timeline, Analysis, billing, budgets and exports.</p>
      {n > 0 && (
        <p className="delete-text">
          {n === 1 ? `${namesOf(fp.continuedBy)} continues it and stays, without the link.` : `${n} tasks continue it: ${namesOf(fp.continuedBy)}. They stay, without the link.`}
        </p>
      )}
      <p className="delete-text delete-undo">
        {synced
          ? "With sync on, this can't be undone. It reaches your other devices at their next sync. Restoring a backup made before the delete (Settings, Backups) brings the task back only until the next sync merges the delete in again."
          : "This can't be undone in the app. The only way back is to restore a backup made before the delete (Settings, Backups), which rolls back everything else since then too."}
      </p>
      <p className="muted delete-hint">{CLICK_ONLY}</p>
    </Modal>
  );
}

function ConfirmDelete({ task, busy, onKeep, onDelete }: { task: Task; busy: boolean; onKeep: () => void; onDelete: () => void }) {
  const { snapshot } = useAppState();
  const armed = useArmed();
  const logged = task.billedSecs + task.unbilledSecs;
  const away = runningElsewhere(snapshot, task);
  return (
    <Modal
      open
      title={`Delete “${task.name}” for good?`}
      dismissible={false}
      onClose={onKeep}
      footer={
        <>
          <Button data-autofocus="" data-delete-step="" disabled={busy} onClick={onKeep}>
            Keep it
          </Button>
          <Button
            variant="danger"
            className="delete-btn"
            disabled={!armed || busy}
            onClick={(e) => {
              if (aClick(e)) onDelete();
            }}
          >
            Delete task
          </Button>
        </>
      }
    >
      <p className="delete-text">
        This deletes “{task.name}”{logged > 0 ? ` and the ${formatDuration(logged)} logged on it` : ''} from {snapshot.deviceName} and from synced devices. It can&apos;t be undone.
      </p>
      {away && <p className="delete-text delete-running">{elsewhereText(away.device)}</p>}
      <p className="muted delete-hint">{CLICK_ONLY}</p>
    </Modal>
  );
}

/** The red button and what stands in its way, for the bottom of a started task's Details. `close` closes the Details. */
export function DeleteTask({ task, close }: { task: Task; close: () => void }) {
  const { snapshot, adopt, clearError, showError } = useAppState();
  const nav = useNav();
  const edits = useEditStore();
  const selection = useSelection();
  const toast = useToast();
  const headId = useId();
  const noteId = useId();
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const sending = useRef(false);
  // A refusal is about what the page had heard when it came. A newer snapshot may have moved on from it, and the reason for
  // what still stands is given beside the button already.
  const [heard, setHeard] = useState(snapshot.revision);
  if (heard !== snapshot.revision) {
    setHeard(snapshot.revision);
    setFailure(null);
  }

  const blocks = deleteBlocks(snapshot, task);
  const blocked = blocks.length > 0;

  // Backing out of either dialog changes nothing, and the next try starts at the review again. Not once the delete is on its way.
  const keep = (): void => {
    if (!sending.current) setStep(null);
  };
  useDeleteKeys(step !== null, keep);

  async function remove(): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    const sent = await attempt(() => api.deleteTask(task.id));
    sending.current = false;
    setBusy(false);
    if (!sent.ok) {
      // The backend has the last word, whatever the page saw: its reason goes in the usual banner and here, beside the button.
      setStep(null);
      setFailure(sent.error.message);
      showError(sent.error.message);
      return;
    }
    // In one render: the card, its editor, what the editor held and the task's place in the selection all go together.
    edits.forget(task.id);
    selection?.dropTask(task.id);
    setStep(null);
    close();
    // A refusal an earlier try left in the banner is no longer true.
    clearError();
    adopt(sent.value);
    toast.push(`Deleted “${task.name}” and everything logged on it.`);
  }

  return (
    <section className="details-delete" aria-labelledby={headId}>
      <div className="details-delete-text">
        <h3 id={headId}>Delete this task</h3>
        <div id={noteId} className="details-delete-note">
          {blocked ? (
            blocks.map((b) => (
              <p key={b.kind} data-testid="delete-blocked">
                {blockText(b)}
                {b.kind === 'summary' && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        close();
                        nav.go('billing');
                      }}
                    >
                      Open Billing
                    </button>
                  </>
                )}
              </p>
            ))
          ) : (
            <p>Removes the task and all the time logged on it, here and on synced devices. You are asked twice.</p>
          )}
        </div>
        {failure && (
          <p className="field-error" role="alert">
            {sentence(failure)}
          </p>
        )}
      </div>
      <Button variant="danger" className="delete-btn" aria-haspopup="dialog" aria-describedby={noteId} disabled={blocked || busy}
        onClick={() => {
          setFailure(null);
          setStep('review');
        }}
      >
        Delete task
      </Button>
      {step === 'review' && <ReviewDialog task={task} onKeep={keep} onContinue={() => setStep('confirm')} />}
      {step === 'confirm' && <ConfirmDelete task={task} busy={busy} onKeep={keep} onDelete={() => void remove()} />}
    </section>
  );
}
