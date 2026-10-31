// Recently used colours: a per-device convenience kept in localStorage. Every access is guarded, so a
// browser or webview with storage blocked, full or missing simply shows no recent colours.
import { normalizeHex } from './color';

export const RECENT_KEY = 'zwt.recentColors';
export const RECENT_MAX = 8;

/** `hex` first, without a repeat, at most `RECENT_MAX` long. Anything that is not a colour is ignored. */
export function pushRecent(list: readonly string[], hex: string): string[] {
  const c = normalizeHex(hex);
  if (!c) return [...list];
  return [c, ...list.filter((x) => x !== c)].slice(0, RECENT_MAX);
}

/** Reads a stored list defensively: bad JSON, the wrong shape or bad entries all give a clean list. */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      const c = typeof item === 'string' ? normalizeHex(item) : null;
      if (c && !out.includes(c)) out.push(c);
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function loadRecent(): string[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

/** Remembers `hex` as the most recent colour. Returns the new list, which is empty when storage is unavailable. */
export function rememberColor(hex: string): string[] {
  const next = pushRecent(loadRecent(), hex);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage is blocked or full: the colour is simply not remembered.
  }
  return next;
}
