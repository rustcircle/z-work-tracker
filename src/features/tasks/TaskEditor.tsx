// Editing a task's name, project and description at any time, in any state. It autosaves: a change
// is sent about 600 ms after the last keystroke, and at once on blur, when the window hides or the
// app quits. Saving only calls patch_task with the changed fields, so segments and the running timer
// are never touched, and a field edited on another device is never reverted.
//
// The editor keeps a local draft. Live updates (the clock tick, a fresh snapshot) re-render it but
// never overwrite the draft or move focus: the inputs are controlled by local state and the
// description editor is built once.
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import type { RichDoc, Task, TaskPatch, TemplateInput } from '../../lib/types';
import { TagPicker } from './TagPicker';
import { RichEditor, type RichEditorHandle } from '../../components/RichText';
import { Button, Field } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { useEditStore, type EditField, type EditSession } from './editStore';
import { errorMessage } from '../../lib/errorMessage';

export const AUTOSAVE_MS = 600;
/** How soon typed description text is stashed on disk, so a Windows shutdown in the next second loses nothing. */
export const DRAFT_MS = 300;
const RETRY_BASE_MS = 2000;
const MAX_RETRIES = 5;

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'rejected'; message: string } | { kind: 'failed'; willRetry: boolean };

export function TaskEditor({ task }: { task: Task }) {
  const { snapshot, adopt, showError } = useAppState();
  const { act } = useCommands();
  const store = useEditStore();
  const statusId = useId();

  const session = store.session(task.id, (): EditSession => ({ name: task.name, description: task.description, projectId: null, tags: null, dirty: { name: false, project: false, description: false, tags: false }, focus: null, rev: 0, queue: Promise.resolve(true), failures: 0 }));
  const [name, setName] = useState(session.name);
  const [projectId, setProjectId] = useState(session.projectId ?? task.projectId);
  const [tags, setTags] = useState<string[]>(session.tags ?? task.tags);
  const [templateState, setTemplateState] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [nameError, setNameError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef<HTMLSelectElement | null>(null);
  const descRef = useRef<RichEditorHandle | null>(null);
  const timer = useRef<number | null>(null);
  // Durable local draft of the description as it is typed (never synced). One writer at a time, in order, so a
  // late stash can never land after the clear that follows a successful save.
  const draftTimer = useRef<number | null>(null);
  const draftDoc = useRef<RichDoc | null>(null);
  const draftChain = useRef<Promise<void>>(Promise.resolve());
  // The latest stored task: the name to fall back on when a blank one is refused.
  const latest = useRef(task);
  useEffect(() => {
    latest.current = snapshot.tasks.find((t) => t.id === task.id) ?? task;
  });

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /** Writes the pending draft now. The autosave is the real save, so a failed stash is dropped rather than shown. */
  const flushDraft = useCallback((): void => {
    if (draftTimer.current !== null) {
      window.clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    const doc = draftDoc.current;
    if (doc === null) return;
    draftDoc.current = null;
    draftChain.current = draftChain.current.then(() => api.stashDraft(task.id, doc)).catch(() => undefined);
  }, [task.id]);

  const stashSoon = (doc: RichDoc): void => {
    draftDoc.current = doc;
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(flushDraft, DRAFT_MS);
  };

  const doSave = useCallback(async (): Promise<boolean> => {
    const s = session;
    if (!s.dirty.name && !s.dirty.project && !s.dirty.description && !s.dirty.tags) return true;
    const cur = latest.current;
    const trimmed = s.name.trim();
    const nameOk = s.dirty.name && trimmed !== '';
    const changes = nameOk || s.dirty.project || s.dirty.description || s.dirty.tags;
    if (s.dirty.name && trimmed === '') setStatus({ kind: 'rejected', message: `A task needs a name, so “${cur.name}” is kept.` });
    if (!changes) return true;
    const sentRev = s.rev;
    setStatus({ kind: 'saving' });
    const patch: TaskPatch = {
      ...(nameOk ? { name: trimmed } : {}),
      ...(s.dirty.project && s.projectId ? { projectId: s.projectId } : {}),
      ...(s.dirty.description ? { description: s.description } : {}),
      // An empty list clears the tags: only patch_task does that, update_task ignores it.
      ...(s.dirty.tags && s.tags ? { tags: s.tags } : {}),
    };
    const ok = await act(() => api.patchTask(task.id, patch));
    if (!ok) {
      s.failures += 1;
      const willRetry = s.failures <= MAX_RETRIES;
      setStatus({ kind: 'failed', willRetry });
      if (willRetry) schedule(RETRY_BASE_MS * 2 ** (s.failures - 1));
      return false;
    }
    s.failures = 0;
    if (s.rev === sentRev) {
      // The description is saved for real, so the stashed copy is no longer needed. Anything typed since
      // (the revision moved on) keeps its draft.
      if (s.dirty.description && draftDoc.current === null && draftTimer.current === null) {
        draftChain.current = draftChain.current.then(() => api.clearDraft(task.id)).catch(() => undefined);
      }
      s.dirty = { name: s.dirty.name && !nameOk, project: false, description: false, tags: false };
      setStatus((prev) => (prev.kind === 'rejected' ? prev : { kind: 'saved' }));
    } else schedule();
    return true;
  // `schedule` is declared below and only reads refs, so it is safe to leave out.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act, session, task.id]);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    // Shutting down or leaving: the draft goes to disk first, whatever the save does next.
    flushDraft();
    session.queue = session.queue.then(doSave, doSave);
    return session.queue;
  }, [clearTimer, doSave, flushDraft, session]);

  function schedule(delay = AUTOSAVE_MS): void {
    clearTimer();
    timer.current = window.setTimeout(() => void flush(), delay);
  }

  function touch(field: keyof EditSession['dirty']): void {
    session.dirty[field] = true;
    session.rev += 1;
    session.failures = 0;
    setStatus((prev) => (prev.kind === 'saving' ? prev : { kind: 'idle' }));
  }

  // Register for "save now" requests, and save whatever is pending if this editor goes away.
  useEffect(() => store.register(task.id, flush), [store, task.id, flush]);
  useEffect(
    () => () => {
      clearTimer();
      void flush();
    },
    [clearTimer, flush],
  );

  // Give focus back to the field that had it, or to the name when the editor was just opened.
  useEffect(() => {
    const f: EditField | null = session.focus;
    if (f === 'name') nameRef.current?.focus();
    else if (f === 'project') projectRef.current?.focus();
    else if (f === 'description') descRef.current?.focus();
  }, [session]);

  const track = (field: EditField) => ({
    onFocus: () => {
      session.focus = field;
    },
  });
  /** Focus is only cleared by a real blur, not by the field being detached while its card moves. */
  const leave = (el: Element | null, field: EditField): void => {
    if (el?.isConnected && session.focus === field) session.focus = null;
  };

  /** Stores the task as it is shown now (after saving pending edits) as a template, without time or ticks. */
  async function saveAsTemplate(): Promise<void> {
    setTemplateBusy(true);
    try {
      await flush();
      const cur = latest.current;
      const name = session.name.trim() || cur.name;
      const live = new Set(snapshot.tags.filter((t) => !t.deleted).map((t) => t.id));
      const input: TemplateInput = {
        id: null,
        name,
        projectId: session.projectId ?? cur.projectId,
        description: session.description,
        tags: (session.tags ?? cur.tags).filter((id) => live.has(id)),
      };
      const saved = await api.saveTemplate(input);
      adopt(saved.snapshot);
      setTemplateState(`Saved as template “${name}”. Task-list items start unticked, with no time.`);
    } catch (e) {
      showError(errorMessage(e));
      setTemplateState(null);
    } finally {
      setTemplateBusy(false);
    }
  }

  const usable = snapshot.projects.filter((p) => !p.archived || p.id === task.projectId);
  const restoreName = (): void => {
    const valid = latest.current.name;
    setName(valid);
    session.name = valid;
    session.dirty.name = false;
    setNameError(null);
  };

  return (
    <form
      className="task-editor"
      aria-label={`Editing ${task.name}`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void flush();
      }}
    >
      <Field label="Task name" error={nameError}>
        {({ id, describedBy }) => (
          <input
            id={id}
            ref={nameRef}
            className="input"
            value={name}
            autoComplete="off"
            aria-required="true"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={describedBy}
            {...track('name')}
            onChange={(e) => {
              setName(e.target.value);
              session.name = e.target.value;
              setNameError(e.target.value.trim() === '' ? 'A task needs a name. The last saved name is kept until you type one.' : null);
              touch('name');
              schedule();
            }}
            onBlur={(e) => {
              leave(e.currentTarget, 'name');
              if (e.target.value.trim() === '') {
                setStatus({ kind: 'rejected', message: `A task needs a name, so “${latest.current.name}” is kept.` });
                restoreName();
              } else void flush();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                restoreName();
              }
            }}
          />
        )}
      </Field>
      <Field label="Project">
        {({ id }) => (
          <select
            id={id}
            ref={projectRef}
            className="input"
            value={projectId}
            {...track('project')}
            onChange={(e) => {
              setProjectId(e.target.value);
              session.projectId = e.target.value;
              touch('project');
              schedule();
            }}
            onBlur={(e) => {
              leave(e.currentTarget, 'project');
              void flush();
            }}
          >
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      <RichEditor
        ref={descRef}
        label="Description"
        value={session.description}
        onChange={(doc: RichDoc) => {
          session.description = doc;
          touch('description');
          stashSoon(doc);
          schedule();
        }}
        onFocus={() => {
          session.focus = 'description';
        }}
        onBlur={() => {
          if (session.focus === 'description') session.focus = null;
          void flush();
        }}
      />
      <TagPicker
        tags={snapshot.tags}
        value={tags}
        onChange={(ids) => {
          setTags(ids);
          session.tags = ids;
          touch('tags');
          schedule();
        }}
      />
      <div className="editor-foot">
        <span id={statusId} className="save-state" role="status" aria-live="polite" data-testid="save-state" data-kind={status.kind}>
          {status.kind === 'saving' && 'Saving…'}
          {status.kind === 'saved' && 'Saved'}
          {status.kind === 'rejected' && status.message}
          {status.kind === 'failed' && (status.willRetry ? 'Not saved. Your changes are still here and will be sent again.' : 'Not saved. Your changes are still here. Edit or press Done to try again.')}
        </span>
        <div className="editor-buttons">
          <Button small disabled={templateBusy} onClick={() => void saveAsTemplate()}>
            Save as template
          </Button>
          <Button
            small
            variant="primary"
            onClick={() => {
              // A failed save keeps the editor open, so what was typed is not lost.
              void flush().then((saved) => {
                if (saved) store.close(task.id);
              });
            }}
          >
            Done
          </Button>
        </div>
      </div>
      <p className="template-note" role="status" aria-live="polite">
        {templateState}
      </p>
    </form>
  );
}
