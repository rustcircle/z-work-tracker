import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import { dayOf, parseIso } from '../../lib/tz';
import { resetSubtasks } from '../../lib/subtasks';
import type { RichDoc, Tag, Task, TaskInput } from '../../lib/types';
import { dayLabel } from '../../components/format';
import { RichEditor, type RichEditorHandle } from '../../components/RichText';
import { Button, Field } from '../../components/ui';
import { IconPlay } from '../../components/icons';
import { useCommands } from '../../components/useCommands';
import { missingText, requiredToStart, validateTask, type TaskErrors } from './taskLogic';
import { TagPicker } from './TagPicker';
import './tasksP2.css';

/** Ids of the tags that still exist. */
const liveIds = (ids: readonly string[], tags: readonly Tag[]): string[] => tags.filter((t) => !t.deleted && ids.includes(t.id)).map((t) => t.id);

/**
 * The new-task form, in three situations:
 * - warm launch: opens filled in from the task most recently worked (a deep copy, editable);
 * - cold launch: opens empty, and every field the launch requires must be filled before Start;
 * - cold resume (`continueFrom`): opens empty, and submitting creates a new task linked to the old one.
 */
export function TaskForm({ continueFrom, onDone }: { continueFrom?: Task; onDone: () => void }) {
  const { snapshot, zones } = useAppState();
  const { act, transition } = useCommands();
  const launch = snapshot.launch;
  const source = continueFrom ? null : launch.warm ? launch.copySource : null;

  const [copied, setCopied] = useState(source);
  const [name, setName] = useState(() => source?.name ?? '');
  const [projectId, setProjectId] = useState(() => (source && !source.projectArchived ? source.projectId : ''));
  // A deep copy: editing this form, or the task made from it, never changes the source task. Items of a
  // task list come back unticked, and without the ids that carry tracked time.
  const [description, setDescription] = useState<RichDoc>(() => (source ? resetSubtasks(source.description) : null));
  const [tags, setTags] = useState<string[]>(() => (source ? liveIds(source.tags, snapshot.tags) : []));
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const nameTouched = useRef(false);
  const [editorKey, setEditorKey] = useState(0);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const createdId = useRef<string | null>(null);
  /** Whether the task an earlier, unfinished submit created was given tags: update_task cannot clear them. */
  const createdWithTags = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef<HTMLSelectElement | null>(null);
  const descRef = useRef<RichEditorHandle | null>(null);
  const tagsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const usable = snapshot.projects.filter((p) => !p.archived);
  const required = requiredToStart(launch);
  const errors = validateTask({ name, projectId, description, tags }, snapshot.projects, null, required, snapshot.tags);
  const templates = snapshot.templates.filter((t) => !t.deleted);
  const show = touched;
  const archivedSourceProject = copied?.projectArchived ? snapshot.projects.find((p) => p.id === copied.projectId) : undefined;

  function focusFirstInvalid(e: TaskErrors): void {
    if (e.name) nameRef.current?.focus();
    else if (e.project) projectRef.current?.focus();
    else if (e.description) descRef.current?.focus();
    else if (e.tags) tagsRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }

  /** Fills the form from a template. The form, not a stored draft, so Cancel leaves nothing behind. */
  function applyTemplate(id: string): void {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    // A name the user typed is theirs; the name of a copied task is not.
    if (name.trim() === '' || !nameTouched.current) setName(t.name);
    const own = t.projectId ? usable.find((p) => p.id === t.projectId) : undefined;
    if (own) setProjectId(own.id);
    setTags(liveIds(t.tags, snapshot.tags));
    setDescription(resetSubtasks(t.description));
    setEditorKey((k) => k + 1);
    setCopied(null);
    const keptProject = projectId !== '' ? usable.find((p) => p.id === projectId) : undefined;
    const projectNote = own ? '' : t.projectId ? ` Its project is archived or gone, so ${keptProject ? `“${keptProject.name}” is kept` : 'choose a project'}.` : ` It has no project, so ${keptProject ? `“${keptProject.name}” is kept` : 'choose a project'}.`;
    setTemplateNote(`Filled in from the template “${t.name}”. Task-list items start unticked.${projectNote}`);
  }

  async function save(startAfter: boolean): Promise<void> {
    setTouched(true);
    if (startAfter ? !errors.ok : !errors.draftOk) {
      focusFirstInvalid(errors);
      return;
    }
    setBusy(true);
    try {
      const input: TaskInput = { name: name.trim(), projectId, description, tags, ...(continueFrom ? { continuedFrom: continueFrom.id } : {}) };
      // If an earlier submit created the task but could not start it, this retries on the same task.
      let id = createdId.current;
      const saved = await act(async () => {
        if (id !== null) {
          const updated = await api.updateTask(id, input);
          // An empty list leaves the stored tags alone, so clearing them takes a patch.
          return createdWithTags.current && tags.length === 0 ? api.patchTask(id, { tags: [] }) : updated;
        }
        const r = await api.createTask(input);
        id = r.id;
        createdId.current = r.id;
        return r.snapshot;
      });
      createdWithTags.current = tags.length > 0;
      if (!saved || id === null) return;
      if (startAfter) {
        const started = id;
        // A failed start keeps the form open, with its error, rather than leaving a stray draft.
        if (!(await transition(() => api.startTask(started), input.name))) return;
      }
      createdId.current = null;
      createdWithTags.current = false;
      onDone();
    } finally {
      setBusy(false);
    }
  }

  /** Cancel changes nothing: a draft left by a start that failed goes too. */
  async function cancel(): Promise<void> {
    const leftover = createdId.current;
    createdId.current = null;
    createdWithTags.current = false;
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
    setTags([]);
    setTemplateNote(null);
    nameTouched.current = false;
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
      {templates.length > 0 && (
        <div className="template-pick">
          <Field label="From template" hint="Fills in the project, tags and description. You can change everything before you start.">
            {({ id, describedBy }) => (
              <select id={id} className="input" value="" onChange={(e) => applyTemplate(e.target.value)} aria-describedby={describedBy}>
                <option value="">Choose a template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <p className="template-note" role="status" aria-live="polite">
            {templateNote}
          </p>
        </div>
      )}
      <Field label="Task name" error={show ? errors.name : null}>
        {({ id, describedBy }) => (
          <input id={id} ref={nameRef} className="input" value={name} onChange={(e) => { nameTouched.current = true; setName(e.target.value); }} aria-required="true" aria-invalid={show && errors.name ? true : undefined} aria-describedby={describedBy} autoComplete="off" />
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
      <div ref={tagsRef}>
        <TagPicker tags={snapshot.tags} value={tags} onChange={setTags} error={show ? errors.tags : null} hint={required.includes('tags') ? 'Tags are required for the first start after launch.' : 'Tags are optional.'} />
      </div>
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
