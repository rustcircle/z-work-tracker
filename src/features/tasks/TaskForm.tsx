import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useApp } from '../../app/store';
import { api } from '../../lib/api';
import { dayOf, parseIso } from '../../lib/tz';
import type { RichDoc, Task, TaskInput } from '../../lib/types';
import { dayLabel } from '../../components/format';
import { RichEditor, type RichEditorHandle } from '../../components/RichText';
import { Button, Field } from '../../components/ui';
import { IconPlay } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { missingText, requiredToStart, validateTask, type TaskErrors } from './taskLogic';

/**
 * The new-task form, in three situations:
 * - warm launch: opens filled in from the task most recently worked (a deep copy, editable);
 * - cold launch: opens empty, and every field the launch requires must be filled before Start;
 * - cold resume (`continueFrom`): opens empty, and submitting creates a new task linked to the old one.
 */
export function TaskForm({ continueFrom, onDone }: { continueFrom?: Task; onDone: () => void }) {
  const { snapshot, zones } = useApp();
  const { act, transition } = useCommands();
  const launch = snapshot.launch;
  const source = continueFrom ? null : launch.warm ? launch.copySource : null;

  const [copied, setCopied] = useState(source);
  const [name, setName] = useState(() => source?.name ?? '');
  const [projectId, setProjectId] = useState(() => (source && !source.projectArchived ? source.projectId : ''));
  // A deep copy: editing this form, or the task made from it, never changes the source task.
  const [description, setDescription] = useState<RichDoc>(() => (source ? structuredClone(source.description) : null));
  const [editorKey, setEditorKey] = useState(0);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const createdId = useRef<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef<HTMLSelectElement | null>(null);
  const descRef = useRef<RichEditorHandle | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const usable = snapshot.projects.filter((p) => !p.archived);
  const required = requiredToStart(launch);
  const errors = validateTask({ name, projectId, description }, snapshot.projects, null, required);
  const show = touched;
  const archivedSourceProject = copied?.projectArchived ? snapshot.projects.find((p) => p.id === copied.projectId) : undefined;

  function focusFirstInvalid(e: TaskErrors): void {
    if (e.name) nameRef.current?.focus();
    else if (e.project) projectRef.current?.focus();
    else if (e.description) descRef.current?.focus();
  }

  async function save(startAfter: boolean): Promise<void> {
    setTouched(true);
    if (startAfter ? !errors.ok : !errors.draftOk) {
      focusFirstInvalid(errors);
      return;
    }
    setBusy(true);
    try {
      const input: TaskInput = { name: name.trim(), projectId, description, ...(continueFrom ? { continuedFrom: continueFrom.id } : {}) };
      // If an earlier submit created the task but could not start it, this retries on the same task.
      let id = createdId.current;
      const saved = await act(async () => {
        if (id !== null) return api.updateTask(id, input);
        const r = await api.createTask(input);
        id = r.id;
        createdId.current = r.id;
        return r.snapshot;
      });
      if (!saved || id === null) return;
      if (startAfter) {
        const started = id;
        // A failed start keeps the form open, with its error, rather than leaving a stray draft.
        if (!(await transition(() => api.startTask(started), input.name))) return;
      }
      createdId.current = null;
      onDone();
    } finally {
      setBusy(false);
    }
  }

  /** Cancel changes nothing: a draft left by a start that failed goes too. */
  async function cancel(): Promise<void> {
    const leftover = createdId.current;
    createdId.current = null;
    if (leftover !== null) await act(() => api.deleteDraft(leftover));
    onDone();
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void save(continueFrom !== undefined);
  }

  function startBlank(): void {
    setCopied(null);
    setName('');
    setProjectId('');
    setDescription(null);
    setEditorKey((k) => k + 1);
    setTouched(false);
    nameRef.current?.focus();
  }

  const copiedWhen = copied?.lastWorkedAt ? dayLabel(dayOf(parseIso(copied.lastWorkedAt), zones.active)) : null;

  return (
    <form className="task-form" onSubmit={onSubmit} noValidate aria-label={continueFrom ? `Continue ${continueFrom.name}` : 'New task'}>
      {continueFrom && (
        <p className="continue-note" data-testid="continue-note">
          Continuing <strong>“{continueFrom.name}”</strong>. Submitting creates a new task linked to it and starts timing that one. “{continueFrom.name}” stays paused and unchanged, and you can still stop it.
          {!launch.warm && ' Every field is asked again after a restart.'}
        </p>
      )}
      {copied && (
        <div className="copy-note" data-testid="copy-note">
          <span>
            Copied from “{copied.name}”{copiedWhen ? `, ${copiedWhen}` : ''}. Everything below is yours to edit; the original is not changed.
          </span>
          <Button small onClick={startBlank}>
            Start blank
          </Button>
        </div>
      )}
      <Field label="Task name" error={show ? errors.name : null}>
        {({ id, describedBy }) => (
          <input id={id} ref={nameRef} className="input" value={name} onChange={(e) => setName(e.target.value)} aria-required="true" aria-invalid={show && errors.name ? true : undefined} aria-describedby={describedBy} autoComplete="off" />
        )}
      </Field>
      <Field
        label="Project"
        error={show ? errors.project : null}
        hint={archivedSourceProject ? `The project “${archivedSourceProject.name}” of the copied task is archived, so choose a project for this one.` : usable.length === 0 ? 'No projects yet. Create one in the Projects tab first.' : undefined}
      >
        {({ id, describedBy }) => (
          <select id={id} ref={projectRef} className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-required="true" aria-invalid={show && errors.project ? true : undefined} aria-describedby={describedBy}>
            <option value="">Choose a project</option>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <RichEditor
        key={editorKey}
        ref={descRef}
        label="Description"
        value={description}
        onChange={setDescription}
        hint={required.includes('description') ? 'Required for the first start after launch.' : 'Optional.'}
        error={show || description !== null ? errors.description : null}
      />
      {!errors.ok && (
        <p className="validation-note" id="start-needs">
          To start, enter {missingText(errors)}.
        </p>
      )}
      <div className="form-actions">
        {continueFrom ? (
          <>
            <Button variant="primary" type="submit" icon={<IconPlay />} disabled={!errors.ok || busy}>
              Start
            </Button>
            <Button variant="ghost" onClick={() => void cancel()}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button type="submit" disabled={busy}>
              Save draft
            </Button>
            <Button variant="primary" icon={<IconPlay />} disabled={!errors.ok || busy} aria-describedby={!errors.ok ? 'start-needs' : undefined} onClick={() => void save(true)}>
              Start
            </Button>
            <Button variant="ghost" onClick={() => void cancel()}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
