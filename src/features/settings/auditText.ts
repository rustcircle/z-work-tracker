// Readable lines for the audit log. The backend stores `before` and `after` as free JSON, so every
// reader here checks the shape it expects and falls back to plain key/value text.
import { clock } from '../../components/format';
import { isCurrency, money } from '../../lib/billing';
import { dayOf, parseIso } from '../../lib/tz';
import type { AuditEntry } from '../../lib/types';
import { parseVersionName, versionReasonWords } from './versionText';

const ENTITY: Record<string, string> = {
  segment: 'Time entry',
  gap: 'Time away',
  pause: 'Billable pause',
  summary: 'Billing summary',
  backup: 'Backup',
  version: 'Saved version',
  lease: 'Use of the app',
  price: 'Price',
};
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
  requestPause: 'pause requested from this computer for a task running elsewhere',
  delete: 'deleted, with all its time',
  removed: 'removed',
  // Another computer stopped responding, so a running entry of it was closed at the last moment it was known to be running.
  settleLost: 'closed for a computer that stopped responding',
  // That computer came back: its own record of the end replaces the closing that was made for it.
  reclaimAfterReturn: 'set back to the end its own computer recorded',
  // The same, but the time is on a billing summary, so the closing stays.
  reclaimOnSummary: 'kept as billed, though its own computer recorded another end',
  // Written by the computer that lost the turn to change data, so it reads as what that computer saw.
  leaseLost: 'went to another computer, as recorded',
  clockPutBack: "closed because its computer's clock was put back",
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

/** "the version of 2026-11-02 14:25 (automatic hourly copy)", for a version's file name; any other text is shown as it is. */
export function versionLabel(name: string, zone: string): string {
  const parsed = parseVersionName(name);
  return parsed === null ? name : `the version of ${whenText(parsed.iso, zone)} (${versionReasonWords(parsed.reason)})`;
}

/** The computer a record names: its name, or "another computer" when all it holds is a device id. */
function computerNamed(by: unknown): string {
  const name = str(by);
  return name === null || name.trim() === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) ? 'another computer' : name;
}

/** "€70.00/h from 2026-04-01". Amounts are masked while earnings are hidden, as everywhere else. */
function priceText(value: Record<string, unknown>, from: string, zone: string, hide: boolean): string {
  const since = isIso(from) ? dayOf(parseIso(from), zone) : from;
  const cents = value.rateCents;
  const currency = str(value.currency);
  if (typeof cents !== 'number') return `no rate from ${since}`;
  if (hide) return `rate hidden from ${since}`;
  const amount = currency !== null && isCurrency(currency) ? money(currency, cents) : `${(cents / 100).toFixed(2)}${currency === null ? '' : ` ${currency}`}`;
  return `${amount}/h from ${since}`;
}

/** One short phrase for a stored value. `hide` masks amounts of money, like the rest of the window does while earnings are hidden. */
export function summarize(value: unknown, zone: string, hide = false): string {
  if (value === null || value === undefined) return 'nothing';
  if (!isRecord(value)) return typeof value === 'string' && isIso(value) ? whenText(value, zone) : String(value);
  const rawStart = str(value.rawStart);
  if (rawStart !== null) {
    const recorded = spanText(rawStart, str(value.rawEnd), zone);
    const edit = value.edit;
    if (isRecord(edit)) {
      const start = str(edit.start);
      if (edit.voided === true) return `voided (recorded ${recorded})`;
      // A closing made for a computer that stopped responding says so: its own computer never recorded that end.
      if (start !== null) return `${spanText(start, str(edit.end), zone)} (${edit.settled === true ? `closed at its last known moment; recorded ${recorded}` : `recorded ${recorded}`})`;
    }
    return `recorded ${recorded}`;
  }
  const decision = str(value.decision);
  if (decision !== null) return DECISION[decision] ?? decision;
  const reference = str(value.reference);
  if (reference !== null) return reference;
  const safetyCopy = str(value.safetyCopy);
  if (safetyCopy !== null) {
    // A restored version also leaves a copy of the data before it in the sync folders.
    const before = str(value.preRestore);
    return `the data from just before is kept as ${safetyCopy}${before === null ? '' : ` and as ${versionLabel(before, zone)}`}`;
  }
  const start = str(value.start);
  if (start !== null && 'end' in value) {
    const kind = str(value.kind);
    return `${spanText(start, str(value.end), zone)}${kind ? ` (${GAP_KIND[kind] ?? kind})` : ''}`;
  }
  // A deleted task: what it was called and where it was, and how much went with it.
  const taskName = str(value.name);
  if (taskName !== null && typeof value.segments === 'number' && typeof value.pauses === 'number') {
    const project = str(value.project);
    const state = str(value.state);
    const entries = `${value.segments} time ${value.segments === 1 ? 'entry' : 'entries'}`;
    const pauses = value.pauses > 0 ? `, ${value.pauses} billable ${value.pauses === 1 ? 'pause' : 'pauses'}` : '';
    return `“${taskName}”${project === null ? '' : ` in ${project}`}${state === null ? '' : `, ${state}`}, ${entries}${pauses}`;
  }
  // A pause request: the other computer's segment, and when it was asked for.
  const requestedAt = str(value.at);
  if (str(value.segmentId) !== null && requestedAt !== null && Object.keys(value).length === 2) return `asked at ${whenText(requestedAt, zone)}`;
  // A price taken away: what it was and from when it applied.
  const priceFrom = str(value.effectiveFrom);
  if (str(value.projectId) !== null && priceFrom !== null && 'rateCents' in value) return priceText(value, priceFrom, zone, hide);
  // The turn to change data went to another computer, and the entries of this one that were closed because of it.
  if (typeof value.generation === 'number' && Array.isArray(value.closed)) {
    const closed = value.closed.length;
    return `${computerNamed(value.by)} took over${closed === 0 ? '' : `; ${closed} running ${closed === 1 ? 'entry' : 'entries'} stopped here`}`;
  }
  return pairs(value, zone);
}

export interface AuditLine {
  when: string;
  by: string;
  before: string;
  after: string;
}

export function auditLine(e: AuditEntry, zone: string, deviceId: string, deviceName: string, hide = false): AuditLine {
  const mine = e.by === deviceId;
  const by = mine ? (deviceName ? `this computer (${deviceName})` : 'this computer') : 'another computer';
  const when = whenText(e.at, zone);
  // A restore names the backup or the version in its entity id; its before and after are not about that.
  if (e.action === 'restore' && (e.entity === 'backup' || e.entity === 'version')) {
    const restored = e.entity === 'version' ? versionLabel(e.entityId, zone) : e.entityId;
    return { when, by, before: 'the data in use', after: `${restored}; ${summarize(e.after, zone, hide)}` };
  }
  // Written by the computer that lost its turn: it could change data before, and the other one did after.
  if (e.entity === 'lease') return { when, by, before: mine ? 'this computer could change data' : 'that computer could change data', after: summarize(e.after, zone, hide) };
  return { when, by, before: summarize(e.before, zone, hide), after: summarize(e.after, zone, hide) };
}
