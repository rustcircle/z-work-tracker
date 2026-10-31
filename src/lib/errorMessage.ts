/** The text of a failed backend call: its `message` when it has one, else the value as a string. Shown as plain text only. */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** The backend's error code (`validation`, `conflict`, `not_found`, ...), or '' when the failure had none. */
export function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e) return String((e as { code: unknown }).code);
  return '';
}
