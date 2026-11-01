// Editing a task's name, project and description at any time, in any state. It autosaves: a change
// is sent about 600 ms after the last keystroke, and at once on blur, when the window hides or the
// app quits. Saving only calls patch_task with the changed fields, so segments and the running timer
// are never touched.
//
// Each save carries the value this editor last showed or saved for its fields. The backend compares
// them in the same step as the write and refuses any field it holds something else in, so a save
// can't replace text nobody here has seen. A refused value stays in the draft, shown and held, until
// Done sends it regardless or Discard gives it up. Typing on it changes neither. A press of Done in the
// first second of the notice says nothing about it, as focus may well be on Done already.
//
// The editor keeps a local draft. Live updates re-render it but never overwrite unsaved values or
// move focus. A field with nothing unsaved shows the newer value, from then on the one it expects.
import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';

import { useAppState } from '../../app/store';
import { api } from '../../lib/api';
import type { PatchReply, RichDoc, Task, TaskExpected, TaskPatch, TemplateInput } from '../../lib/types';
import { TagPicker } from './TagPicker';
import { RichEditor, type RichEditorHandle } from '../../components/RichText';
import { Button, Field } from '../../components/ui';
import { useCommands } from '../../components/useCommands';
import { MAX_RETRIES, SAVED_FIELDS, hasUnsaved, heldFields, newSession, readHeldFields, sameValue, settle, storedFields, useEditStore, type EditField, type SaveStatus, type SavedField } from './editStore';
import { errorCode, errorMessage } from '../../lib/errorMessage';

export const AUTOSAVE_MS = 600;
/** How soon typed description text is stashed on disk, so a Windows shutdown in the next second loses nothing. */
export const DRAFT_MS = 300;
export const RETRY_BASE_MS = 2000;
/** How long a hold notice is up before a press of Done counts as a choice about what it says. */
export const HOLD_READ_MS = 1000;

/** "name", "name and tags", "name, project and tags". */
function listFields(fields: readonly SavedField[]): string {
  return fields.length < 2 ? fields.join('') : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`;
}

/**
 * What becomes of held values if the app closes first. Words typed into a description are stashed on disk, and the
 * next launch shows them in a notice rather than over the newer text, as long as the disk takes them. The other
 * fields live only in this page.
 */
function ifTheAppCloses(held: readonly SavedField[], stashFailed: boolean, words: string, others: string): string {
  if (!held.includes('description')) return `If the app closes first, ${others}.`;
  const only = held.length === 1;
  const them = only ? 'them' : 'it';
  const disk = stashFailed ? `, if the disk takes ${them}` : '';
  const end = only ? `${words}${disk}` : `the description comes back as a notice at the next launch${disk}${stashFailed ? ',' : ''} and the rest is lost`;
  return `If the app closes first, ${end}.${stashFailed ? ` It isn't taking ${them} just now, so copy what you want to keep.` : ''}`;
}

/** Why a task's values were not sent, and what the user can do, for a notice outside the editor. */
export function heldAwayNotice(name: string, held: readonly SavedField[], stashFailed: boolean): string {
  return `“${name}” was changed elsewhere while an edit waited to save, so the edit to its ${listFields(held)} wasn't sent. Open the task's editor to choose what to keep. ${ifTheAppCloses(held, stashFailed, 'your words come back as a notice at the next launch', 'your edit is lost')}`;
}

/** Why a task's values haven't gone yet, and what the user can do, for a notice that outlasts the error of the failed save. */
export function unsentAwayNotice(name: string, unsent: readonly SavedField[], refused: string | null): string {
  const end = !unsent.includes('description') ? 'your edit is lost' : unsent.length === 1 ? 'your words come back at the next launch, if the disk took them' : 'the description comes back at the next launch, if the disk took it, and the rest is lost';
  const edit = `Your edit to the ${listFields(unsent)} of “${name}”`;
  const state = refused === null ? `${edit} could not be saved yet. It is still here and will be sent again. Opening the task's editor shows it and tries again.` : `${edit} can't be saved: ${refused}. It is still here. Open the task's editor to change it.`;
  return `${state} If the app closes first, ${end}.`;
}

/** Why the backend won't take a save, when the failure is in the edit and not in the writing. */
function refusal(e: unknown): string | null {
  const code = errorCode(e);
  return code === 'validation' || code === 'not_found' ? errorMessage(e) : null;
}

/** What the status line says while unsaved values wait for the user to choose. The editor shows one value per field, so it can't show the newer one beside them. */
function conflictNotice(held: readonly SavedField[], stashFailed: boolean): string {
  const end = ifTheAppCloses(held, stashFailed, 'they come back as a notice at the next launch', 'they are lost');
  const both = held.includes('description') || held.includes('name') ? ' To see both, copy your words, press Discard my words, and paste them back.' : '';
  if (held.length === 1 && held[0] === 'description') {
    return `This description was changed elsewhere while your words waited to save. They are shown here and have not been sent. Typing on does not send them. Press Done to save them over the newer text, which you can't read first, or press Discard my words to keep the newer text.${both} ${end}`;
  }
  return `The ${listFields(held)} changed elsewhere while your edits waited to save. They are shown here and have not been sent. Typing on does not send them. Press Done to save them over the newer ones, which you can't read first, or press Discard my words to keep the newer ones.${both} ${end}`;
}

export function TaskEditor({ task }: { task: Task }) {
  const { snapshot, adopt, showError } = useAppState();
  const { act } = useCommands();
  const store = useEditStore();
  const { saved: savedInStore, taskGone, noteAway } = store;
  const statusId = useId();
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });

  const session = store.session(task.id, () => newSession(task, setStatus));
  const [stashFailed, setStashFailed] = useState(session.stashFailed);
  const [name, setName] = useState(session.name);
  const [projectId, setProjectId] = useState(session.projectId ?? task.projectId);
  const [tags, setTags] = useState<string[]>(session.tags ?? task.tags);
  const [templateState, setTemplateState] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement | null>(null);
  const projectRef = useRef<HTMLSelectElement | null>(null);
  const descRef = useRef<RichEditorHandle | null>(null);
  // Durable local draft of the description as it is typed (never synced). One writer at a time, in order, so a
  // late stash can never land after the clear that follows a successful save.
  const draftTimer = useRef<number | null>(null);
  const draftDoc = useRef<RichDoc | null>(null);
  // The fields read as held when Done was pressed, before the blur of that press could hold anything more.
  const heldAtPress = useRef<SavedField[] | null>(null);
  // Each field's second of being named in the notice on this screen.
  const holdTimers = useRef(new Map<SavedField, number>());
  // The latest stored task: the name to fall back on when a blank one is refused.
  const latest = useRef(task);
  // A field with nothing unsaved shows what is stored. If the user types first, or is composing text now, the field
  // goes on expecting what it shows, and the backend refuses the save for the user to choose.
  const showStored = useEffectEvent(() => {
    const now = snapshot.tasks.find((t) => t.id === task.id) ?? task;
    latest.current = now;
    const stored = storedFields(now);
    for (const f of SAVED_FIELDS) {
      if (session.dirty[f] || sameValue(f, session.expected, stored)) continue;
      switch (f) {
        case 'name':
          session.name = now.name;
          setName(now.name);
          break;
        case 'project':
          session.projectId = null;
          setProjectId(now.projectId);
          break;
        case 'tags':
          session.tags = null;
          setTags(now.tags);
          break;
        case 'description':
          if (!descRef.current?.replace(now.description)) continue;
          session.description = now.description;
          break;
      }
      session.expected = settle(session.expected, f, stored);
    }
  });
  // A save ending leaves a field clean with no new snapshot, if a newer one came while it was on its way.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the fields follow the store, and only render again when a value really changed.
  useEffect(() => showStored(), [snapshot, status]);

  const clearTimer = useCallback(() => {
    if (session.timer !== null) {
      window.clearTimeout(session.timer);
      session.timer = null;
    }
  }, [session]);

  /** Writes a stash in its turn. The autosave is the real save, but held or unsent words count on this if the app closes, so how it went gets said. */
  const stash = useCallback(
    (doc: RichDoc): void => {
      const went = (failed: boolean): void => {
        session.stashFailed = failed;
        session.reportStash(failed);
        noteAway(task.id, session);
      };
      session.draftChain = session.draftChain.then(() => api.stashDraft(task.id, doc, session.expected.description)).then(
        () => went(false),
        () => went(true),
      );
    },
    [noteAway, session, task.id],
  );

  /** Writes the pending draft now. */
  const flushDraft = useCallback((): void => {
    if (draftTimer.current !== null) {
      window.clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    const doc = draftDoc.current;
    if (doc === null) return;
    draftDoc.current = null;
    stash(doc);
  }, [stash]);

  const stashSoon = (doc: RichDoc): void => {
    draftDoc.current = doc;
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(flushDraft, DRAFT_MS);
  };

  /** What was waiting to be stashed isn't wanted any more. */
  const dropPendingStash = useCallback((): void => {
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    draftDoc.current = null;
  }, []);

  /** A stash can fail, and held or unsent words count on one reaching the disk. */
  const stashAgain = useCallback((): void => {
    stash(session.description);
  }, [session, stash]);

  const doSave = useCallback(async (): Promise<boolean> => {
    const s = session;
    if (!hasUnsaved(s) && !s.dirty.name) return true;
    const cur = latest.current;
    const trimmed = s.name.trim();
    const send: Record<SavedField, boolean> = {
      name: s.dirty.name && !s.conflict.name && trimmed !== '',
      project: s.dirty.project && !s.conflict.project && s.projectId !== null,
      description: s.dirty.description && !s.conflict.description,
      tags: s.dirty.tags && !s.conflict.tags && s.tags !== null,
    };
    if (s.dirty.name && trimmed === '') s.report({ kind: 'rejected', message: `A task needs a name, so “${cur.name}” is kept.` });
    if (s.dirty.description && s.conflict.description) stashAgain();
    if (!SAVED_FIELDS.some((f) => send[f])) {
      if (heldFields(s).length > 0) s.report({ kind: 'conflict' });
      return true;
    }
    const sentEdits = { ...s.edits };
    s.report({ kind: 'saving' });
    const patch: TaskPatch = {
      ...(send.name ? { name: trimmed } : {}),
      ...(send.project && s.projectId ? { projectId: s.projectId } : {}),
      ...(send.description ? { description: s.description } : {}),
      // An empty list clears the tags: only patch_task does that, update_task ignores it.
      ...(send.tags && s.tags ? { tags: s.tags } : {}),
    };
    const expected: TaskExpected = {
      ...(send.name && !s.overriding.name ? { name: s.expected.name } : {}),
      ...(send.project && !s.overriding.project ? { projectId: s.expected.projectId } : {}),
      ...(send.description && !s.overriding.description ? { description: s.expected.description } : {}),
      ...(send.tags && !s.overriding.tags ? { tags: s.expected.tags } : {}),
    };
    s.saving = true;
    const sentExpected = s.expected;
    const out: { reply?: PatchReply; error?: unknown } = {};
    const ok = await act(async () => {
      const reply = await api.patchTask(task.id, patch, expected).catch((e: unknown) => {
        out.error = e;
        throw e;
      });
      out.reply = reply;
      // Before the snapshot is adopted, so nothing rendered from it can take this save for a newer value.
      for (const f of SAVED_FIELDS) {
        if (!send[f]) continue;
        // A field given up while this was on its way isn't expecting anything of it, and shows what the store holds next.
        // Typing since goes on from that, so a refusal of what was sent before says nothing about it.
        if (reply.conflicts.includes(f)) s.conflict[f] = s.dirty[f] && sameValue(f, s.expected, sentExpected);
        else if (s.dirty[f]) s.expected = settle(s.expected, f, reply.stored);
        s.overriding[f] = false;
      }
      return reply.snapshot;
    });
    s.saving = false;
    if (!ok) {
      // Done's choice was for that press. A retry could meet something newer still, so it goes back to being held.
      for (const f of SAVED_FIELDS) {
        if (s.overriding[f]) s.conflict[f] = true;
        s.overriding[f] = false;
      }
      // A task deleted elsewhere can never take this save. Trying again would only repeat the error.
      const fresh = await api.getSnapshot().catch(() => null);
      if (fresh && !fresh.tasks.some((t) => t.id === task.id)) {
        // These words go in a notice, and a stash of them left to land after that would tell of them again.
        dropPendingStash();
        adopt(fresh);
        taskGone(task.id, s);
        return false;
      }
      s.failures += 1;
      s.refused = refusal(out.error);
      if (s.dirty.description) stashAgain();
      const willRetry = s.refused === null && s.failures <= MAX_RETRIES && SAVED_FIELDS.some((f) => s.dirty[f] && !s.conflict[f]);
      s.report({ kind: 'failed', willRetry });
      if (willRetry) schedule(RETRY_BASE_MS * 2 ** (s.failures - 1));
      return false;
    }
    s.failures = 0;
    s.refused = null;
    if (out.reply) latest.current = { ...latest.current, ...out.reply.stored };
    if (send.description && s.conflict.description) stashAgain();
    // A sent field not changed since is done with. What was held stays unsaved, and so does anything typed meanwhile.
    for (const f of SAVED_FIELDS) if (send[f] && !s.conflict[f] && s.edits[f] === sentEdits[f]) s.dirty[f] = false;
    // The description is saved for real, so the stashed copy, and any waiting to be written, is no longer needed.
    if (send.description && !s.dirty.description) {
      dropPendingStash();
      s.draftChain = s.draftChain.then(() => api.clearDraft(task.id)).catch(() => undefined);
    }
    if (SAVED_FIELDS.some((f) => s.dirty[f] && !s.conflict[f] && s.edits[f] !== sentEdits[f])) {
      // Typing went on during this save, and the next one goes from what this one stored.
      schedule();
    } else {
      s.report(heldFields(s).length > 0 ? { kind: 'conflict' } : { kind: 'saved' });
      savedInStore(task.id, s);
    }
    return true;
  // `schedule` is declared below and only reads the session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act, adopt, dropPendingStash, stashAgain, taskGone, savedInStore, session, task.id]);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    // Shutting down or leaving: the draft goes to disk first, whatever the save does next.
    flushDraft();
    session.queue = session.queue.then(doSave, doSave).then((ok) => {
      noteAway(task.id, session);
      return ok;
    });
    return session.queue;
  }, [clearTimer, doSave, flushDraft, noteAway, session, task.id]);

  function schedule(delay = AUTOSAVE_MS): void {
    clearTimer();
    session.timer = window.setTimeout(() => void session.retry(), delay);
  }

  function touch(field: SavedField): void {
    session.dirty[field] = true;
    session.edits[field] += 1;
    session.failures = 0;
    session.refused = null;
    setStatus((prev) => (prev.kind === 'saving' ? prev : { kind: 'idle' }));
  }

  // While this editor is on screen it says what is held. When it goes, a notice elsewhere takes that over.
  useEffect(() => {
    session.shown = true;
    noteAway(task.id, session);
    return () => {
      session.shown = false;
      noteAway(task.id, session);
    };
  }, [noteAway, session, task.id]);

  // Register for "save now" requests, and save whatever is pending if this editor goes away.
  useEffect(() => store.register(task.id, flush), [store, task.id, flush]);
  useEffect(
    () => () => {
      clearTimer();
      void flush();
    },
    [clearTimer, flush],
  );

  // Changes left unsaved by the editor before this one are this one's to finish, so the result shows here.
  // A held value waits for the user instead.
  useEffect(() => {
    session.report = setStatus;
    session.reportStash = setStashFailed;
    session.retry = flush;
    if (SAVED_FIELDS.some((f) => session.dirty[f] && !session.conflict[f])) schedule();
    // `schedule` only reads the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, flush]);

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
  /** Gives up the held values: the editor goes back to what is stored now. */
  function discardHeld(): void {
    const fields = heldFields(session);
    if (fields.length === 0) return;
    const now = latest.current;
    const stored = storedFields(now);
    for (const f of fields) {
      session.dirty[f] = false;
      session.conflict[f] = false;
      session.expected = settle(session.expected, f, stored);
      switch (f) {
        case 'name':
          session.name = now.name;
          setName(now.name);
          setNameError(null);
          break;
        case 'project':
          session.projectId = null;
          setProjectId(now.projectId);
          break;
        case 'tags':
          session.tags = null;
          setTags(now.tags);
          break;
        case 'description':
          session.description = now.description;
          descRef.current?.replace(now.description);
          // The held words' draft goes too, or the next launch would find them and tell of them.
          dropPendingStash();
          session.draftChain = session.draftChain.then(() => api.clearDraft(task.id)).catch(() => undefined);
          break;
      }
    }
    // The cursor goes to the first field given up, in the form's order (tags have no single place to put it).
    const first = fields.find((f): f is EditField => f !== 'tags') ?? 'name';
    session.focus = first;
    if (first === 'name') nameRef.current?.focus();
    else if (first === 'project') projectRef.current?.focus();
    else descRef.current?.focus();
    session.report({ kind: 'discarded' });
  }

  const restoreName = (): void => {
    const valid = latest.current.name;
    setName(valid);
    session.name = valid;
    session.dirty.name = false;
    session.conflict.name = false;
    session.overriding.name = false;
    session.expected = settle(session.expected, 'name', storedFields(latest.current));
    setNameError(null);
  };

  // Whatever else has happened, what is held still needs saying, and giving up stays on offer.
  const held = heldFields(session);
  const shown: SaveStatus = held.length > 0 && (status.kind === 'idle' || status.kind === 'saved' || status.kind === 'discarded') ? { kind: 'conflict' } : status;

  // A field's second starts when the notice first names it, and a field no longer held starts again if it comes back.
  // This runs after every commit, with no dependencies, because `held` is read from the session as this renders. If React
  // renders and then bails out, it drops that render's effects but keeps their dependencies, so a hold met first by such a
  // render would never start its second. Running again changes nothing: a second under way or over is never started again.
  const heldKey = held.join();
  useEffect(() => {
    const timers = holdTimers.current;
    for (const f of SAVED_FIELDS) {
      const timer = timers.get(f);
      if (!heldKey.split(',').includes(f)) {
        window.clearTimeout(timer);
        timers.delete(f);
        session.holdRead[f] = false;
      } else if (timer === undefined && !session.holdRead[f]) {
        timers.set(
          f,
          window.setTimeout(() => {
            timers.delete(f);
            session.holdRead[f] = true;
          }, HOLD_READ_MS),
        );
      }
    }
  });
  // Off this screen the notice is not being read, so an editor opened again gives it its second again.
  useEffect(() => {
    const timers = holdTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      session.holdRead = { name: false, project: false, description: false, tags: false };
    };
  }, [session]);

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
        <span id={statusId} className="save-state" role="status" aria-live="polite" data-testid="save-state" data-kind={shown.kind}>
          {shown.kind === 'saving' && 'Saving…'}
          {shown.kind === 'saved' && 'Saved'}
          {shown.kind === 'rejected' && shown.message}
          {shown.kind === 'discarded' && 'Discarded. What is stored now is shown.'}
          {shown.kind === 'failed' && (shown.willRetry ? 'Not saved. Your changes are still here and will be sent again.' : 'Not saved. Your changes are still here. Edit or press Done to try again.')}
          {shown.kind !== 'conflict' && held.length > 0 && ' '}
          {held.length > 0 && conflictNotice(held, stashFailed)}
        </span>
        <div className="editor-buttons">
          {held.length > 0 && (
            <Button small aria-describedby={statusId} onClick={discardHeld}>
              Discard my words
            </Button>
          )}
          <Button small disabled={templateBusy} onClick={() => void saveAsTemplate()}>
            Save as template
          </Button>
          <Button
            small
            variant="primary"
            onPointerDown={() => {
              heldAtPress.current = readHeldFields(session);
            }}
            onKeyDown={(e) => {
              // A key held down repeats, and each repeat would click again. Only the press that began it is one.
              if (e.repeat) e.preventDefault();
            }}
            onClick={(e) => {
              // Only what was on screen as held before this press is the user's to send regardless. A keyboard press
              // has no pointer-down, and any blur of its own came with an earlier key. It reads no list either, as the
              // list of a press dragged off this button is still here, and `detail` is 0 for a click of no pointer.
              // Nor is a notice not yet read: it stays up, for a press after that. That also keeps the second click of a
              // double click from choosing what the first one's blur held. `detail` doesn't tell them apart: the browser
              // goes on counting clicks that follow one another quickly, and one that comes after the second counts.
              const chosen = (e.detail > 0 ? heldAtPress.current : null) ?? readHeldFields(session);
              heldAtPress.current = null;
              void (async () => {
                // The blur of this very press may have started a save that holds more back: it settles first.
                await session.queue.catch(() => undefined);
                for (const f of chosen) {
                  if (!session.conflict[f]) continue;
                  session.conflict[f] = false;
                  session.overriding[f] = true;
                }
                // A failed save keeps the editor open, so what was typed is not lost, and so does anything newly held.
                if ((await flush()) && heldFields(session).length === 0) store.close(task.id);
              })();
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
