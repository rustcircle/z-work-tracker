// Runs a backend call and keeps the error code, which the page needs (overlap, conflict, validation).
import type { CommandError } from '../../../lib/types';

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: CommandError };

export function toCommandError(e: unknown): CommandError {
  if (e && typeof e === 'object' && 'message' in e) {
    const code = 'code' in e && typeof e.code === 'string' ? e.code : 'error';
    return { code, message: String(e.message) };
  }
  return { code: 'error', message: String(e) };
}

export async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    return { ok: false, error: toCommandError(e) };
  }
}

/** "this overlaps time already logged on: A" becomes a sentence that starts with a capital. */
export const sentence = (message: string): string => {
  const m = message.trim();
  return m === '' ? m : `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`;
};
