// Which tasks have their editor open, and each editor's unsaved draft. The draft lives here rather
// than in the editor so that a card that moves in the list (a state change re-groups it) can rebuild
// its editor without losing what was typed. A draft with unsaved changes also outlives closing the
// editor, so there is only ever one draft per task: a retry always sends its latest text, and reopening
// shows what failed to save. The store also fans out "save now" requests: from the backend's flush
// event (window hiding, app quitting) and from the page becoming hidden, and keeps lists of the values
// held back or failing to save whose editor is not on screen, so a notice can say so for as long as that lasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useAppState } from '../../app/store';
import { api, events } from '../../lib/api';
import { docHasText } from '../../lib/docText';
import { sameJson } from '../../lib/sameJson';
import type { RichDoc, StoredFields, Task } from '../../lib/types';

export type EditField = 'name' | 'project' | 'description';

/** Retries of a failing save on a timer. After these it waits for a write of anything else to show saving works again. */
export const MAX_RETRIES = 5;

/** The fields a save can carry: the keys of an editor's `dirty`. */
export const SAVED_FIELDS = ['name', 'project', 'description', 'tags'] as const;
export type SavedField = (typeof SAVED_FIELDS)[number];

export function storedFields(t: Task): StoredFields {
  return { name: t.name, projectId: t.projectId, description: t.description, tags: t.tags };
}

/** Whether two sets of values agree on a field. Tags are a set: order is no change. */
export function sameValue(field: SavedField, a: StoredFields, b: StoredFields): boolean {
  switch (field) {
    case 'name':
      return a.name === b.name;
    case 'project':
      return a.projectId === b.projectId;
    case 'description':
      return sameJson(a.description, b.description);
    case 'tags':
      return a.tags.length === b.tags.length && a.tags.every((id) => b.tags.includes(id));
  }
}

/** `expected` with one field taken from `from`. */
export function settle(expected: StoredFields, field: SavedField, from: StoredFields): StoredFields {
  switch (field) {
    case 'name':
      return { ...expected, name: from.name };
    case 'project':
      return { ...expected, projectId: from.projectId };
    case 'description':
      return { ...expected, description: from.description };
    case 'tags':
      return { ...expected, tags: from.tags };
  }
}

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'rejected'; message: string }
  | { kind: 'failed'; willRetry: boolean }
  | { kind: 'conflict' }
  | { kind: 'discarded' };

export interface EditSession {
  name: string;
  description: RichDoc;
  /** The project the user picked, or null while it is unchanged. */
  projectId: string | null;
  /** The tags the user picked, or null while they are unchanged. An empty list means none. */
  tags: string[] | null;
  dirty: { name: boolean; project: boolean; description: boolean; tags: boolean };
  /** The field that had focus, so a rebuilt editor can give it back. */
  focus: EditField | null;
  /** Edits per field, to tell a sent value from one changed since. Lives here, because saves outlive an editor rebuilt mid-save. */
  edits: Record<SavedField, number>;
  /** Saves run one at a time, in order, across rebuilds. Resolves false when the save failed. */
  queue: Promise<boolean>;
  /** Failed saves in a row, for the retry delay. */
  failures: number;
  /** Why the backend refuses to take this edit at all, if it does. Sending it again can't help, so nothing does until it changes. */
  refused: string | null;
  /** The next autosave or retry. Lives here so that rebuilt editors share one, and it outlives a closed editor. */
  timer: number | null;
  /** Stashed drafts are written one at a time, in order, across rebuilds. */
  draftChain: Promise<void>;
  /** The latest of them didn't reach the disk, so the next launch may have nothing of these words to show. */
  stashFailed: boolean;
  /** The editor was closed with changes still unsaved. */
  closed: boolean;
  /**
   * What this editor last showed or saved for each field: the backend refuses a save if it holds anything else.
   * It moves only with a successful save, an explicit choice or a newer value shown in a clean field, never at a keystroke.
   */
  expected: StoredFields;
  /** Unsaved values the backend refused. They stay here, shown, and aren't sent until Done or Discard ends the hold. */
  conflict: Record<SavedField, boolean>;
  /** Held values Done has chosen to send regardless, for one save only. No retry repeats that on its own. */
  overriding: Record<SavedField, boolean>;
  /** Held values whose notice has been on screen long enough for a press of Done to be a choice about them. */
  holdRead: Record<SavedField, boolean>;
  /** A save is on its way, so what is stored may already include it. */
  saving: boolean;
  /** An editor is on screen for this draft. */
  shown: boolean;
  /** The editor showing this draft now, for the outcome of a save that started under an earlier one. */
  report: (status: SaveStatus) => void;
  /** That editor again, for how the latest stash went. */
  reportStash: (failed: boolean) => void;
  /** Saves through that editor. */
  retry: () => Promise<boolean>;
}

/** The unsaved fields that met newer stored values and wait for the user to choose. */
export function heldFields(s: EditSession): SavedField[] {
  return SAVED_FIELDS.filter((f) => s.dirty[f] && s.conflict[f]);
}

/** The held fields Done can send regardless: their notice has been up for long enough to have been read. */
export function readHeldFields(s: EditSession): SavedField[] {
  return heldFields(s).filter((f) => s.holdRead[f]);
}

/** The unsaved fields whose last save failed, and go when one works. A blank name never does: it is refused, not sent. */
export function unsentFields(s: EditSession): SavedField[] {
  return s.failures === 0 ? [] : SAVED_FIELDS.filter((f) => s.dirty[f] && !s.conflict[f] && (f !== 'name' || s.name.trim() !== ''));
}

/** A fresh draft for a task as stored now. `report` shows the outcome of its saves. */
export function newSession(task: Task, report: (status: SaveStatus) => void): EditSession {
  return {
    name: task.name,
    description: task.description,
    projectId: null,
    tags: null,
    dirty: { name: false, project: false, description: false, tags: false },
    focus: null,
    edits: { name: 0, project: 0, description: 0, tags: 0 },
    queue: Promise.resolve(true),
    failures: 0,
    refused: null,
    timer: null,
    draftChain: Promise.resolve(),
    stashFailed: false,
    closed: false,
    expected: storedFields(task),
    conflict: { name: false, project: false, description: false, tags: false },
    overriding: { name: false, project: false, description: false, tags: false },
    holdRead: { name: false, project: false, description: false, tags: false },
    saving: false,
    shown: false,
    report,
    reportStash: () => undefined,
    retry: () => Promise.resolve(true),
  };
}

/** Whether a save still has something to send. A blank name never does: it is refused, not sent. */
export function hasUnsaved(s: EditSession): boolean {
  return (s.dirty.name && s.name.trim() !== '') || s.dirty.project || s.dirty.description || s.dirty.tags;
}

/** The fields held back for a task, and whether the disk has taken a description among them. */
export interface Held {
  fields: readonly SavedField[];
  stashFailed: boolean;
}

/** The fields failing to save for a task, and why if that can't change by itself. */
export interface Unsent {
  fields: readonly SavedField[];
  refused: string | null;
}

/** `was` with a task's entry replaced, the same object if nothing changed. */
function withEntry<T>(was: ReadonlyMap<string, T>, id: string, entry: T | null): ReadonlyMap<string, T> {
  if (JSON.stringify(was.get(id) ?? null) === JSON.stringify(entry)) return was;
  const next = new Map(was);
  if (entry !== null) next.set(id, entry);
  else next.delete(id);
  return next;
}

interface EditStoreApi {
  editing: ReadonlySet<string>;
  open: (id: string, focus?: EditField) => void;
  close: (id: string) => void;
  /** Tells the store a save landed, so a closed editor's draft can go once nothing is left in it. */
  saved: (id: string, s: EditSession) => void;
  /** Ends a draft whose task no longer exists: no save can take it, so a notice shows its words. */
  taskGone: (id: string, s: EditSession) => void;
  /** The fields held back, by task, while no editor is on screen to say so. */
  heldAway: ReadonlyMap<string, Held>;
  /** The fields failing to save, by task, while no editor is on screen to say so. */
  unsentAway: ReadonlyMap<string, Unsent>;
  /** Tells the store a draft's holds, its failures or its editor may have changed. */
  noteAway: (id: string, s: EditSession) => void;
  /** The draft for a task, created from `init` the first time. Mutated in place by the editor. */
  session: (id: string, init: () => EditSession) => EditSession;
  register: (id: string, flush: () => Promise<unknown>) => () => void;
  flushAll: () => Promise<void>;
}

const Ctx = createContext<EditStoreApi | null>(null);

export function useEditStore(): EditStoreApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useEditStore needs EditStoreProvider');
  return v;
}

export function EditStoreProvider({ children }: { children: ReactNode }) {
  const { snapshot, act } = useAppState();
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
  const [heldAway, setHeldAway] = useState<ReadonlyMap<string, Held>>(new Map());
  const [unsentAway, setUnsentAway] = useState<ReadonlyMap<string, Unsent>>(new Map());
  const sessions = useRef(new Map<string, EditSession>());
  const flushers = useRef(new Map<string, () => Promise<unknown>>());
  /** Focus requested before the editor existed. */
  const pendingFocus = useRef(new Map<string, EditField>());

  const open = useCallback((id: string, focus: EditField = 'name') => {
    const existing = sessions.current.get(id);
    if (existing) existing.focus = focus;
    else pendingFocus.current.set(id, focus);
    setEditing((s) => (s.has(id) ? s : new Set(s).add(id)));
  }, []);
  const close = useCallback((id: string) => {
    const s = sessions.current.get(id);
    if (s) {
      if (s.dirty.name && s.name.trim() === '') s.dirty.name = false;
      if (hasUnsaved(s)) s.closed = true;
      else sessions.current.delete(id);
    }
    pendingFocus.current.delete(id);
    setEditing((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
  const saved = useCallback((id: string, s: EditSession) => {
    if (s.closed && !hasUnsaved(s) && sessions.current.get(id) === s) {
      sessions.current.delete(id);
      flushers.current.delete(id);
    }
  }, []);
  const noteAway = useCallback((id: string, s: EditSession) => {
    const held = s.shown ? [] : heldFields(s);
    const unsent = s.shown ? [] : unsentFields(s);
    setHeldAway((was) => withEntry(was, id, held.length > 0 ? { fields: held, stashFailed: s.stashFailed } : null));
    setUnsentAway((was) => withEntry(was, id, unsent.length > 0 ? { fields: unsent, refused: s.refused } : null));
  }, []);
  const taskGone = useCallback(
    (id: string, s: EditSession) => {
      if (sessions.current.get(id) !== s) return;
      // A project or tags aren't words, and go with the task.
      const newName = s.dirty.name && s.name.trim() !== '' ? s.name.trim() : null;
      const description = s.dirty.description && docHasText(s.description) ? s.description : null;
      if (s.timer !== null) window.clearTimeout(s.timer);
      s.timer = null;
      s.dirty = { name: false, project: false, description: false, tags: false };
      close(id);
      flushers.current.delete(id);
      setHeldAway((was) => withEntry(was, id, null));
      setUnsentAway((was) => withEntry(was, id, null));
      // Keeping words also ends their stash, once they are safe: the backend knows when that is.
      s.draftChain = s.draftChain
        .then(async () => {
          if (newName === null && description === null) await api.clearDraft(id);
          else await act(() => api.keepUnsavedWords(id, s.expected.name, newName, description));
        })
        .catch(() => undefined);
    },
    [act, close],
  );
  const session = useCallback((id: string, init: () => EditSession) => {
    let s = sessions.current.get(id);
    if (!s) {
      s = init();
      const f = pendingFocus.current.get(id);
      if (f) s.focus = f;
      pendingFocus.current.delete(id);
      sessions.current.set(id, s);
    } else if (s.closed) {
      // Reopened with something unsaved: that stays, and the rest catches up with the stored task.
      const fresh = init();
      // Newer values may have arrived while nobody was looking, and the retry that would have met them may be used up
      // or still waiting, or the store may be refusing saves. The snapshot at hand can say so now. A save on its way
      // says for itself, and a stored value equal to the draft is no conflict.
      const draft: StoredFields = { name: s.name.trim(), projectId: s.projectId ?? s.expected.projectId, description: s.description, tags: s.tags ?? s.expected.tags };
      for (const f of SAVED_FIELDS) {
        if (!s.dirty[f]) s.expected = settle(s.expected, f, fresh.expected);
        else if (!s.conflict[f] && !s.saving && !sameValue(f, s.expected, fresh.expected) && !sameValue(f, draft, fresh.expected)) s.conflict[f] = true;
      }
      if (!s.dirty.name) s.name = fresh.name;
      if (!s.dirty.description) s.description = fresh.description;
      if (!s.dirty.project) s.projectId = fresh.projectId;
      if (!s.dirty.tags) s.tags = fresh.tags;
      s.closed = false;
    }
    return s;
  }, []);
  const register = useCallback((id: string, flush: () => Promise<unknown>) => {
    flushers.current.set(id, flush);
    return () => {
      if (flushers.current.get(id) !== flush) return;
      // Unsaved changes keep their way out, so a window hiding or the app quitting still tries to send them.
      const s = sessions.current.get(id);
      if (!s || !hasUnsaved(s)) flushers.current.delete(id);
    };
  }, []);
  const flushAll = useCallback(async () => {
    await Promise.all([...flushers.current.values()].map((f) => f().then(() => undefined)));
  }, []);

  // A task can go with no save to find that out: held values wait for the user, and retries can run out. A save on its
  // way finds out for itself.
  useEffect(() => {
    for (const [id, s] of [...sessions.current]) {
      if (!s.saving && hasUnsaved(s) && !snapshot.tasks.some((t) => t.id === id)) taskGone(id, s);
    }
  }, [snapshot.tasks, heldAway, taskGone]);

  // A write has just landed, so saving works again, and a draft with no retries left can go now. If it fails again it
  // waits for the next one: this goes round no faster than other things are saved.
  const revision = snapshot.revision;
  useEffect(() => {
    for (const s of [...sessions.current.values()]) {
      if (!s.shown && s.failures > MAX_RETRIES && s.refused === null && hasUnsaved(s)) void s.retry();
    }
  }, [revision]);

  // The backend asks for a save when the window hides or the app quits; so does a hidden page.
  useEffect(() => {
    const unlisten = events.onFlushEdits(() => void flushAll());
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void unlisten.then((f) => f()).catch(() => undefined);
    };
  }, [flushAll]);

  const value = useMemo<EditStoreApi>(() => ({ editing, open, close, saved, taskGone, heldAway, unsentAway, noteAway, session, register, flushAll }), [editing, open, close, saved, taskGone, heldAway, unsentAway, noteAway, session, register, flushAll]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
