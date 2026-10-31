/** Shown when a failure has no text of its own. An object is never printed as "[object Object]". */
export const GENERIC_ERROR = 'Something went wrong.';

/**
 * The text of a failed backend call, as plain text: its `message` when it has a text one, the text itself
 * for a thrown string, and a generic sentence for anything else (such as an object with no message).
 */
export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (typeof e === 'number' || typeof e === 'boolean' || typeof e === 'bigint') return String(e);
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (typeof m === 'number' || typeof m === 'boolean') return String(m);
  }
  return GENERIC_ERROR;
}

/** The backend's error code (`validation`, `conflict`, `not_found`, ...), or '' when the failure had none. */
export function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) return String((e as { code: unknown }).code);
  return '';
}
