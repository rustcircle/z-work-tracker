// The words for a saved version: why it was made, and what its file name says. Shared by the Versions section and the
// history of changes, so both name a version the same way.

/** Why a version was made, as the backend's change record words it. Keys are the reason codes in the file name. */
const REASON_WORDS: Readonly<Record<string, string>> = {
  auto: 'automatic hourly copy',
  quit: 'copy when the app was closed',
  manual: 'saved by hand',
  takeover: 'copy when a computer took over',
  'pre-restore': 'copy of the data before a restore',
  'pre-adopt': 'copy of the data before following a restore',
  restored: 'copy of the restored data',
};

/** "automatic hourly copy". A code this page doesn't know is shown as plain words, never dropped. */
export function versionReasonWords(code: string): string {
  return REASON_WORDS[code] ?? (code.replace(/-/g, ' ').trim() || 'saved copy');
}

export const capitalize = (text: string): string => (text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1));

export interface ParsedVersionName {
  /** When it was taken, as the writer's UTC clock stamped it. */
  iso: string;
  /** The first 8 digits of the writing device's id. */
  device8: string;
  reason: string;
}

const NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z--([0-9a-f]{8})--([a-z-]+)$/;

/** `20261102T142530Z--a1b2c3d4--auto` in parts, or null when it isn't a version name. */
export function parseVersionName(name: string): ParsedVersionName | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, device8, reason] = m;
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}Z`, device8: device8 ?? '', reason: reason ?? '' };
}
