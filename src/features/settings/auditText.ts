// Readable lines for the audit log. The backend stores `before` and `after` as free JSON, so every
// reader here checks the shape it expects and falls back to plain key/value text.
import { clock } from '../../components/format';
import { dayOf, parseIso } from '../../lib/tz';
import type { AuditEntry } from '../../lib/types';

const ENTITY: Record<string, string> = { segment: 'Time entry', gap: 'Time away', pause: 'Billable pause', summary: 'Billing summary', backup: 'Backup' };
const GAP_KIND: Record<string, string> = { sleep: 'sleep', idle: 'idle', lock: 'screen locked' };
const ACTION: Record<string, string> = {
  manualEntry: 'added by hand',
  correct: 'corrected',
  void: 'voided',
  restore: 'restored',
  decide: 'answered',
  detected: 'detected',
  markBillable: 'marked billable',
  unmarkBillable: 'no longer billable',
  create: 'created',
};
const DECISION: Record<string, string> = { pending: 'waiting for an answer', keep: 'kept as work', drop: 'dropped', thinking: 'marked as thinking' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isIso = (s: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);

export function entityLabel(entity: string): string {
  return ENTITY[entity] ?? (entity ? entity.charAt(0).toUpperCase() + entity.slice(1) : 'Entry');
}

/** "markBillable" -> "marked as a billable pause"; unknown actions become lower-case words. */
export function actionWords(action: string): string {
  return ACTION[action] ?? (action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase() || 'changed');
}

/** "2026-03-09 09:00", in `zone`. */
export function whenText(iso: string, zone: string): string {
  if (!isIso(iso)) return iso;
  const sec = parseIso(iso);
  return `${dayOf(sec, zone)} ${clock(sec, zone)}`;
}

/** "2026-03-09 09:00 to 11:05", or with both dates when the span crosses midnight. */
export function spanText(start: string, end: string | null, zone: string): string {
  if (!isIso(start)) return start;
  const s = parseIso(start);
  if (end === null || !isIso(end)) return `${whenText(start, zone)}, still running`;
  const e = parseIso(end);
  return dayOf(s, zone) === dayOf(e, zone) ? `${whenText(start, zone)} to ${clock(e, zone)}` : `${whenText(start, zone)} to ${whenText(end, zone)}`;
}

function pairs(o: Record<string, unknown>, zone: string): string {
  const text = Object.entries(o)
    .map(([k, v]) => {
      const shown = typeof v === 'string' ? (isIso(v) ? whenText(v, zone) : v) : v === null ? 'none' : isRecord(v) || Array.isArray(v) ? JSON.stringify(v) : String(v);
      return `${k} ${shown}`;
    })
    .join(', ');
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** One short phrase for a stored value. */
export function summarize(value: unknown, zone: string): string {
  if (value === null || value === undefined) return 'nothing';
  if (!isRecord(value)) return typeof value === 'string' && isIso(value) ? whenText(value, zone) : String(value);
  const rawStart = str(value.rawStart);
  if (rawStart !== null) {
    const recorded = spanText(rawStart, str(value.rawEnd), zone);
    const edit = value.edit;
    if (isRecord(edit)) {
      const start = str(edit.start);
      if (edit.voided === true) return `voided (recorded ${recorded})`;
      if (start !== null) return `${spanText(start, str(edit.end), zone)} (recorded ${recorded})`;
    }
    return `recorded ${recorded}`;
  }
  const decision = str(value.decision);
  if (decision !== null) return DECISION[decision] ?? decision;
  const reference = str(value.reference);
  if (reference !== null) return reference;
  const safetyCopy = str(value.safetyCopy);
  if (safetyCopy !== null) return `the data from just before is kept as ${safetyCopy}`;
  const start = str(value.start);
  if (start !== null && 'end' in value) {
    const kind = str(value.kind);
    return `${spanText(start, str(value.end), zone)}${kind ? ` (${GAP_KIND[kind] ?? kind})` : ''}`;
  }
  return pairs(value, zone);
}

export interface AuditLine {
  when: string;
  by: string;
  before: string;
  after: string;
}

export function auditLine(e: AuditEntry, zone: string, deviceId: string, deviceName: string): AuditLine {
  // A restore names the backup in its entity id; its before and after are not about that backup.
  const restore = e.entity === 'backup' && e.action === 'restore';
  return {
    when: whenText(e.at, zone),
    by: e.by === deviceId ? (deviceName ? `this computer (${deviceName})` : 'this computer') : 'another computer',
    before: restore ? 'the data in use' : summarize(e.before, zone),
    after: restore ? `${e.entityId}; ${summarize(e.after, zone)}` : summarize(e.after, zone),
  };
}
