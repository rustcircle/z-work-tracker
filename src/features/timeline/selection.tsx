// The Timeline's selection, held above the tabs so it survives scrolling, filtering and a visit to another
// tab, and so the Export dialog can read it. Days are in the zone they were selected in: changing the
// day zone clears the selection, because the same date would then mean a different stretch of time.
import { createContext, useCallback, useContext, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import type { SelectedEntry } from '../../lib/types';
import { EMPTY_SELECTION, announce, entryOf, prune as prunePure, selectAll, selectOnly, selectRange, toEntries, toggle, type Sel } from './selectionLogic';

export interface RowReg {
  /** Identifies one row on screen (a task-day can have several). */
  rowId: string;
  key: string;
}

export interface SelectionApi {
  zone: string;
  keys: readonly string[];
  count: number;
  isSelected: (key: string) => boolean;
  entries: SelectedEntry[];
  /** The row that holds the one tab stop of the entries. */
  tabRow: string | null;
  /** Selected task-days not drawn right now: filtered out, or in days not loaded yet. */
  hidden: number;
  /** For the live region. */
  live: string;
  /** Says which rows a day draws, in order. Saying the same again changes nothing. */
  register: (day: string, rows: readonly RowReg[]) => void;
  unregister: (day: string) => void;
  rowClick: (e: MouseEvent<HTMLElement>, key: string, rowId: string) => void;
  rowMouseDown: (e: MouseEvent<HTMLElement>) => void;
  gridKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  clear: () => void;
  prune: (present: ReadonlySet<string>) => void;
  /** Takes every entry of a task out of the selection, on any day: the task has just been deleted. */
  dropTask: (taskId: string) => void;
}

const Ctx = createContext<SelectionApi | null>(null);

/** Null outside the provider: a Timeline drawn on its own (a test) is simply not selectable. */
export const useSelection = (): SelectionApi | null => useContext(Ctx);

const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [data-no-select]';

export function SelectionProvider({ zone, children }: { zone: string; children: ReactNode }) {
  const [sel, setSel] = useState<Sel>(EMPTY_SELECTION);
  const [selZone, setSelZone] = useState(zone);
  const [cursor, setCursor] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [registry, setRegistry] = useState<ReadonlyMap<string, readonly RowReg[]>>(() => new Map());

  // Days are cut in this zone; a different zone means different days, so nothing selected stays valid.
  if (selZone !== zone) {
    setSelZone(zone);
    if (sel.keys.length > 0) {
      setSel(EMPTY_SELECTION);
      setLive('Selection cleared because the day zone changed');
    }
  }

  const register = useCallback((day: string, rows: readonly RowReg[]) => {
    setRegistry((prev) => {
      const was = prev.get(day);
      if (was && was.length === rows.length && was.every((r, i) => r.rowId === rows[i]?.rowId && r.key === rows[i]?.key)) return prev;
      return new Map(prev).set(day, rows);
    });
  }, []);
  const unregister = useCallback((day: string) => {
    setRegistry((prev) => {
      if (!prev.has(day)) return prev;
      const next = new Map(prev);
      next.delete(day);
      return next;
    });
  }, []);

  // The rows on screen, newest day first, and the task-days they stand for in the same order.
  const { rows, order, visible } = useMemo(() => {
    const days = [...registry.keys()].sort().reverse();
    const rows = days.flatMap((d) => registry.get(d) ?? []);
    const order: string[] = [];
    for (const r of rows) if (!order.includes(r.key)) order.push(r.key);
    return { rows, order, visible: new Set(order) };
  }, [registry]);

  const selected = useMemo(() => new Set(sel.keys), [sel.keys]);
  const hidden = sel.keys.filter((k) => !visible.has(k)).length;
  const firstRow = rows[0]?.rowId ?? null;
  const tabRow = cursor !== null && rows.some((r) => r.rowId === cursor) ? cursor : firstRow;

  const apply = useCallback(
    (next: Sel, rowId: string | null) => {
      setSel(next);
      if (rowId !== null) setCursor(rowId);
      const gone = next.keys.filter((k) => !visible.has(k)).length;
      setLive(announce(next.keys.length, gone));
    },
    [visible],
  );

  const rowMouseDown = useCallback((e: MouseEvent<HTMLElement>) => {
    // Shift+click extends a range; the browser would also start selecting text across the rows.
    if (e.shiftKey) e.preventDefault();
  }, []);

  const rowClick = useCallback(
    (e: MouseEvent<HTMLElement>, key: string, rowId: string) => {
      const target = e.target as HTMLElement;
      // Clicks on the row's own controls (edit, open, links) are theirs: they never select. The task name is the
      // one exception: a plain click opens the task, but with Ctrl, Cmd or Shift held it is part of the row.
      const control = target.closest(INTERACTIVE);
      if (control && !((e.ctrlKey || e.metaKey || e.shiftKey) && control.hasAttribute('data-select-with-modifier'))) return;
      // A drag that selected text to copy it is not a click on the row.
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && (window.getSelection()?.toString() ?? '') !== '') return;
      const additive = e.ctrlKey || e.metaKey;
      if (e.shiftKey) apply(selectRange(sel, key, order, additive), rowId);
      else if (additive) apply(toggle(sel, key), rowId);
      else apply(selectOnly(key), rowId);
    },
    [apply, order, sel],
  );

  const clear = useCallback(() => apply(EMPTY_SELECTION, null), [apply]);

  const gridKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const row = target.closest<HTMLElement>('tr[data-row-id]');
      const onRow = target === row;
      const typing = target.closest('input, textarea, select, [contenteditable="true"]') !== null;
      const mod = e.ctrlKey || e.metaKey;
      if (typing) return;
      if (e.key === 'Escape' && sel.keys.length > 0) {
        e.preventDefault();
        clear();
        return;
      }
      if (mod && (e.key === 'a' || e.key === 'A') && (onRow || row === null)) {
        e.preventDefault();
        apply(selectAll(sel, order), cursor);
        return;
      }
      if (!onRow || !row) return;
      const key = row.dataset.selKey ?? '';
      const rowId = row.dataset.rowId ?? '';
      const all = [...(row.closest('.days')?.querySelectorAll<HTMLElement>('tr[data-row-id]') ?? [])];
      const at = all.indexOf(row);
      const go = (i: number): HTMLElement | undefined => all[Math.max(0, Math.min(all.length - 1, i))];
      let next: HTMLElement | undefined;
      if (e.key === 'ArrowDown') next = go(at + 1);
      else if (e.key === 'ArrowUp') next = go(at - 1);
      else if (e.key === 'Home') next = go(0);
      else if (e.key === 'End') next = go(all.length - 1);
      if (next && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
        e.preventDefault();
        const nextKey = next.dataset.selKey ?? '';
        const nextId = next.dataset.rowId ?? '';
        next.focus();
        if (e.shiftKey) apply(selectRange(sel.keys.length === 0 ? selectOnly(key) : sel, nextKey, order, mod), nextId);
        else setCursor(nextId);
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        apply(mod ? toggle(sel, key) : selectOnly(key), rowId);
      }
    },
    [apply, clear, cursor, order, sel],
  );

  const prune = useCallback(
    (present: ReadonlySet<string>) => {
      setSel((s) => prunePure(s, present));
    },
    [],
  );

  const dropTask = useCallback(
    (taskId: string) => {
      const present = new Set(sel.keys.filter((k) => entryOf(k).taskId !== taskId));
      if (present.size !== sel.keys.length) apply(prunePure(sel, present), null);
    },
    [apply, sel],
  );

  // A selection that lost entries (their time was corrected away) says so once.
  const count = sel.keys.length;
  const entries = useMemo(() => toEntries(sel.keys), [sel.keys]);
  const value = useMemo<SelectionApi>(
    () => ({ zone: selZone, keys: sel.keys, count, isSelected: (k) => selected.has(k), entries, tabRow, hidden, live, register, unregister, rowClick, rowMouseDown, gridKeyDown, clear, prune, dropTask }),
    [selZone, sel.keys, count, selected, entries, tabRow, hidden, live, register, unregister, rowClick, rowMouseDown, gridKeyDown, clear, prune, dropTask],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
