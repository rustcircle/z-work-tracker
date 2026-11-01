// Which tasks have their editor open, and each editor's unsaved draft. The draft lives here rather
// than in the editor so that a card that moves in the list (a state change re-groups it) can rebuild
// its editor without losing what was typed. A draft with unsaved changes also outlives closing the
// editor, so there is only ever one draft per task: a retry always sends its latest text, and reopening
// shows what failed to save. The store also fans out "save now" requests: from the backend's flush
// event (window hiding, app quitting) and from the page becoming hidden.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { events } from '../../lib/api';
import type { RichDoc } from '../../lib/types';

export type EditField = 'name' | 'project' | 'description';

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'rejected'; message: string }
  | { kind: 'failed'; willRetry: boolean }
  | { kind: 'conflict' };

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
  /** Bumped by every change. Lives here, because saves outlive an editor rebuilt mid-save. */
  rev: number;
  /** Saves run one at a time, in order, across rebuilds. Resolves false when the save failed. */
  queue: Promise<boolean>;
  /** Failed saves in a row, for the retry delay. */
  failures: number;
  /** The next autosave or retry. Lives here so that rebuilt editors share one, and it outlives a closed editor. */
  timer: number | null;
  /** Stashed drafts are written one at a time, in order, across rebuilds. */
  draftChain: Promise<void>;
  /** The editor was closed with changes still unsaved. */
  closed: boolean;
  /** The stored description the unsaved one was edited from, to notice a newer one arriving from elsewhere. */
  base: RichDoc;
  /** A closed editor's description met newer stored text. It stays here and isn't sent until the user chooses to. */
  conflict: boolean;
  /** The editor showing this draft now, for the outcome of a save that started under an earlier one. */
  report: (status: SaveStatus) => void;
  /** Saves through that editor. */
  retry: () => Promise<boolean>;
}

/** Whether a save still has something to send. A blank name never does: it is refused, not sent. */
export function hasUnsaved(s: EditSession): boolean {
  return (s.dirty.name && s.name.trim() !== '') || s.dirty.project || s.dirty.description || s.dirty.tags;
}

interface EditStoreApi {
  editing: ReadonlySet<string>;
  open: (id: string, focus?: EditField) => void;
  close: (id: string) => void;
  /** Tells the store a save landed, so a closed editor's draft can go once nothing is left in it. */
  saved: (id: string, s: EditSession) => void;
  /** Drops a draft whose task no longer exists. */
  forget: (id: string, s: EditSession) => void;
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
  const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
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
  const forget = useCallback((id: string, s: EditSession) => {
    if (sessions.current.get(id) === s) {
      sessions.current.delete(id);
      flushers.current.delete(id);
    }
  }, []);
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

  const api = useMemo<EditStoreApi>(() => ({ editing, open, close, saved, forget, session, register, flushAll }), [editing, open, close, saved, forget, session, register, flushAll]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
