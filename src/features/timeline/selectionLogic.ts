// Which Timeline entries are selected, as pure functions so every rule is easy to test. The unit is a
// task-day (one task on one day, the same as an Excel row): all rows of it are selected together.
import type { SelectedEntry } from '../../lib/types';

/** `taskId|day`. Task ids never contain a bar. */
export const keyOf = (taskId: string, day: string): string => `${taskId}|${day}`;

export function entryOf(key: string): SelectedEntry {
  const at = key.lastIndexOf('|');
  return { taskId: key.slice(0, at), day: key.slice(at + 1) };
}

export interface Sel {
  /** Selected task-days, in the order they were chosen. */
  keys: readonly string[];
  /** Where a Shift range starts: the last one chosen on its own. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Sel = { keys: [], anchor: null };

const has = (sel: Sel, key: string): boolean => sel.keys.includes(key);

/** Plain click or Space: only this one. */
export function selectOnly(key: string): Sel {
  return { keys: [key], anchor: key };
}

/** Ctrl+click (Cmd on macOS) or Ctrl+Space: add it, or take it out if it is in. */
export function toggle(sel: Sel, key: string): Sel {
  return has(sel, key) ? { keys: sel.keys.filter((k) => k !== key), anchor: key } : { keys: [...sel.keys, key], anchor: key };
}

/**
 * Shift+click or Shift+Arrow: everything from the anchor to `key` in the order on screen (days run across,
 * newest first). The range replaces the selection, unless `keep` (Ctrl+Shift) adds it to what is chosen.
 * The anchor stays where it was, so Shift+click again moves only the far end.
 */
export function selectRange(sel: Sel, key: string, order: readonly string[], keep = false): Sel {
  const to = order.indexOf(key);
  const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  if (to < 0) return sel;
  if (from < 0) return selectOnly(key);
  const [a, b] = from <= to ? [from, to] : [to, from];
  const range = order.slice(a, b + 1);
  const keys = keep ? [...sel.keys, ...range.filter((k) => !has(sel, k))] : range;
  return { keys, anchor: sel.anchor };
}

/** Ctrl+A: everything on screen, added to what is chosen. */
export function selectAll(sel: Sel, order: readonly string[]): Sel {
  return { keys: [...sel.keys, ...order.filter((k) => !has(sel, k))], anchor: sel.anchor ?? order[0] ?? null };
}

/** Takes out keys that no longer exist (their time was voided or corrected away). */
export function prune(sel: Sel, present: ReadonlySet<string>): Sel {
  const keys = sel.keys.filter((k) => present.has(k));
  return keys.length === sel.keys.length ? sel : { keys, anchor: sel.anchor !== null && present.has(sel.anchor) ? sel.anchor : (keys.at(-1) ?? null) };
}

/** The selection as the backend takes it: newest day first, then task id, so the same choice always sends the same list. */
export function toEntries(keys: readonly string[]): SelectedEntry[] {
  return keys
    .map(entryOf)
    .sort((a, b) => (a.day === b.day ? (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) : a.day < b.day ? 1 : -1));
}

/** The words for the live region. */
export function announce(count: number, hidden: number): string {
  if (count === 0) return 'Selection cleared';
  const base = `${count} ${count === 1 ? 'task' : 'tasks'} selected`;
  return hidden > 0 ? `${base}, ${hidden} not on screen` : base;
}
