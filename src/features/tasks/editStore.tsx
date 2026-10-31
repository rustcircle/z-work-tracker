// Which tasks have their editor open, and each editor's unsaved draft. The draft lives here rather
// than in the editor so that a card that moves in the list (a state change re-groups it) can rebuild
// its editor without losing what was typed. The store also fans out "save now" requests: from the
// backend's flush event (window hiding, app quitting) and from the page becoming hidden.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { events } from '../../lib/api';
import type { RichDoc } from '../../lib/types';

export type EditField = 'name' | 'project' | 'description';

export interface EditSession {
  name: string;
  description: RichDoc;
  /** The project the user picked, or null while it is unchanged. */
  projectId: string | null;
  dirty: { name: boolean; project: boolean; description: boolean };
  /** The field that had focus, so a rebuilt editor can give it back. */
  focus: EditField | null;
  /** Bumped by every change. Lives here, because saves outlive an editor rebuilt mid-save. */
  rev: number;
  /** Saves run one at a time, in order, across rebuilds. Resolves false when the save failed. */
  queue: Promise<boolean>;
  /** Failed saves in a row, for the retry delay. */
  failures: number;
}

interface EditStoreApi {
  editing: ReadonlySet<string>;
  open: (id: string, focus?: EditField) => void;
  close: (id: string) => void;
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
    sessions.current.delete(id);
    pendingFocus.current.delete(id);
    setEditing((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
  const session = useCallback((id: string, init: () => EditSession) => {
    let s = sessions.current.get(id);
    if (!s) {
      s = init();
      const f = pendingFocus.current.get(id);
      if (f) s.focus = f;
      pendingFocus.current.delete(id);
      sessions.current.set(id, s);
    }
    return s;
  }, []);
  const register = useCallback((id: string, flush: () => Promise<unknown>) => {
    flushers.current.set(id, flush);
    return () => {
      if (flushers.current.get(id) === flush) flushers.current.delete(id);
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

  const api = useMemo<EditStoreApi>(() => ({ editing, open, close, session, register, flushAll }), [editing, open, close, session, register, flushAll]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
