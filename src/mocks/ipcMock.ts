// Test-only stand-in for the Rust backend, installed in the `e2e` build mode and in component tests.
// It mirrors z-work-core's command behaviour. Real-backend behaviour is covered by the Rust tests and
// by scripts/native-smoke.mjs; anything verified only against this mock is reported as such.
import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';

import { PROJECT_PALETTE, distinctColor } from '../lib/color';
import { RateBook, isCurrency, taskDays } from '../lib/billing';
import { docHasText, docPlainText } from '../lib/docText';
import { assignSubtaskIds, effectiveTags, resetSubtasks, sameOverride, shownTags, subtaskItems } from '../lib/subtasks';
import { clockAt, isZone, parseIso, toIso } from '../lib/tz';
import { summaryCsv } from './summaryCsv';
import { capAtPauseRequest, computePieces, effective, projectFigures, summaryPreview, taskTotals, unconfirmedSecs, type MockSegment, type PieceInput } from './pieces';
import { sameJson } from '../lib/sameJson';
import type {
  AuditEntry,
  AutostartInfo,
  AutostartState,
  BackupInfo,
  BillablePause,
  BillingSummary,
  ClockBehindView,
  CopySource,
  CorrectionInput,
  DataCounts,
  ExportRequest,
  GapDecision,
  IdleGap,
  JoinChoice,
  JoinPending,
  LeaseHolderView,
  LeaseView,
  ManualEntryInput,
  MovePreview,
  MoveResult,
  PauseInput,
  PauseReason,
  PauseRequest,
  PdfRequest,
  PendingCopy,
  Project,
  ProjectInput,
  RateInput,
  RateVersion,
  RequiredField,
  RestorePreview,
  RichDoc,
  SelectedEntry,
  RoundingInput,
  RoundingVersion,
  Reminder,
  Settings,
  ShiftInput,
  ShiftVersion,
  Snapshot,
  Stamp,
  SubtaskTagsExpected,
  SubtaskTagsReply,
  SummaryRequest,
  Tag,
  TagInput,
  TakeOverExpected,
  TakeOverMode,
  TakeOverPreview,
  TakeOverResult,
  Task,
  TaskInput,
  PatchReply,
  TaskExpected,
  TaskPatch,
  TaskState,
  Template,
  TemplateInput,
  Theme,
  VersionInfo,
  VersionList,
} from '../lib/types';

export const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

/** What the mock knows about one sync folder, keyed by its root. A root nobody described is empty and readable. */
export interface MockFolder {
  /** Names of the devices that have written there. */
  devices: string[];
  counts: DataCounts;
  /** False when the folder cannot be read, like an unplugged drive. */
  available: boolean;
  /** Test hook: the next move into this folder fails once, before anything changes. */
  failNext?: boolean;
  /** Test hook: records that arrive in this store when the folder is connected, like a first sync from another PC. */
  data?: { projects?: MockProject[]; settings?: Settings; rounding?: RoundingVersion[]; shifts?: ShiftVersion[] };
}

/** A project as the mock stores it: the backend's derived fields are computed when a snapshot is taken. */
export type MockProject = Omit<Project, 'figures' | 'hasTasks' | 'billingType' | 'fixedFeeCents' | 'feeCurrency'> &
  Partial<Pick<Project, 'billingType' | 'fixedFeeCents' | 'feeCurrency'>> & { hasTasks?: boolean };

/**
 * One subtask's stored override (`Task.subtaskTags`): a list is its own tags, `null` is a reset to "Same as task". Each has
 * its own stamp, as in the backend, so a test can tell which entries a change moved. Entries are never deleted.
 */
export interface MockSubtaskTags {
  tags: string[] | null;
  stamp: Stamp;
}

/** A task as the mock stores it. Subtask time, billed seconds and the like are derived at snapshot time. */
export type MockTask = Omit<Task, 'tags' | 'activeSubtask' | 'subtasks' | 'billedSecs' | 'unbilledSecs' | 'thinkingSecs' | 'pauseSecs' | 'unconfirmedSecs'> &
  Partial<Pick<Task, 'tags' | 'activeSubtask'>> & {
    /** Only overrides, by subtask id: left out while there are none, as the backend leaves the field out. Not part of the snapshot, which shows each item's `tags`. */
    subtaskTags?: Record<string, MockSubtaskTags>;
  };

export type { MockSegment };

/** A saved version as the mock holds it: what the list shows, plus what reading it and restoring it need. */
export interface MockVersion extends VersionInfo {
  /** The text of its `.changes.txt`. */
  changes: string;
  /** The data a restore installs, as `captureData` writes it. Without it a restore only pauses and goes cold, like a backup that holds none. */
  data?: string;
  /** The counts the restore preview shows when there is no `data` to count. */
  counts?: DataCounts;
  /** This copy can't be read here, as if it were still syncing: in every folder holding it (true), or only in the roots listed. */
  failRead?: boolean | string[];
  /** Records the restore leaves out because they couldn't be read. */
  warnings?: string[];
  /** A reason only the backend knows why a restore can't go ahead, such as a newer app having saved it. */
  blockedReason?: string | null;
}

/** The seeded starter tags, the same ids and colours the backend creates for a store that has none. */
export const STARTER_TAGS: readonly [string, string, string][] = [
  ['tag-concept', 'Concept', '#7c3aed'],
  ['tag-revision', 'Revision', '#0f766e'],
  ['tag-client-call', 'Client call', '#c2410c'],
  ['tag-admin', 'Admin', '#475569'],
];

export interface MockState {
  now: number;
  projects: MockProject[];
  tasks: MockTask[];
  /** Recorded segments with their corrections. The snapshot's `segments` are pieces computed from these. */
  segments: MockSegment[];
  gaps: IdleGap[];
  pauses: BillablePause[];
  tags: Tag[];
  templates: Template[];
  summaries: BillingSummary[];
  /** This device's reference prefix, or null until one is chosen: then it is the first letter no other device uses. */
  prefix: string | null;
  /** The prefixes other devices use, by device name. A device with the same prefix as this one is a clash. */
  otherPrefixes: Record<string, string>;
  /** The highest number issued under each prefix on this device (prefs `referenceMarks`). It survives a restore, so a number is never reused. */
  referenceMarks: Record<string, number>;
  /** The text of the last CSV written for each billing summary, by summary id. */
  summaryCsvFiles: Record<string, string>;
  audit: AuditEntry[];
  backups: BackupInfo[];
  /** Test hook: the data a backup holds, by name, as JSON. Restoring a backup without any only pauses and goes cold. */
  backupData: Record<string, string>;
  backupKeep: number;
  hasPdfLogo: boolean;
  /** Test hook: a reminder the real backend would raise for reasons the mock does not model, such as past shift end. */
  reminderOverride: Reminder | null;
  /** The reminder is quiet until this time (epoch seconds), after Keep running. */
  reminderQuietUntil: number | null;
  shifts: ShiftVersion[];
  rates: RateVersion[];
  rounding: RoundingVersion[];
  settings: Settings;
  theme: Theme;
  hideEarnings: boolean;
  lastCurrency: 'EUR' | 'USD' | null;
  clientZonePromptDone: boolean;
  syncPromptDone: boolean;
  systemZone: string;
  targets: Snapshot['sync']['targets'];
  folders: Record<string, MockFolder>;
  /** Set when a move could not read the previous folder; cleared by a successful retry. */
  pendingCopy: PendingCopy | null;
  /** Test hook: pause between the steps of a move, so progress can be seen. */
  moveDelayMs: number;
  detected: Snapshot['sync']['detected'];
  notices: Snapshot['notices'];
  warnings: string[];
  exports: { kind: 'xlsx' | 'csv'; request: ExportRequest }[];
  /** The PDF timesheets asked for, kept apart so `exports` stays Excel and CSV only. */
  pdfExports: PdfRequest[];
  calls: { cmd: string; args: unknown }[];
  /** Test hook: these commands fail once each, like a failed save. */
  failNext?: string[];
  autostart: boolean;
  /** The first-run setup was finished or skipped. A fresh store is `setupDone: false, syncPromptDone: false`. */
  setupDone: boolean;
  setupStep: number;
  /** Asks made to pause tasks running on another device. */
  pauseRequests: PauseRequest[];
  /** Durable local drafts by task id (`stash_draft`). They never sync. */
  drafts: Record<string, RichDoc>;
  /** Moves with every snapshot built, so one built earlier reads as older, as the backend's count of changes does. */
  revision: number;
  /** Randomness for replacing a clashing colour, in [0, 1). Defaults to a fixed seed so runs repeat. */
  random?: () => number;
  nextId: number;
  /** Launch-scoped, like the Rust service: false until the first task of this launch has started. */
  warm: boolean;
  lastWorked: string | null;
  /**
   * Who holds the lease, as the folders would say if they could all be read; `leaseView` adds what the folders and the
   * connected targets change. The default, `off`, with no sync folder, refuses nothing. Use `seedLease` for a coherent state.
   * A holder's `ageSecs` follows its `lastSignAt` and the clock of the mock.
   */
  lease: LeaseView;
  /** Test hook: the next `lease_take_over` ends this way whatever the lease says, and then it is back to the real checks. */
  takeOverNext?: 'done' | 'changed' | 'unreachable';
  /** Test hook: a Microsoft Store (packaged) build. */
  packaged: boolean;
  /**
   * Start with Windows as Windows reports it. Only `state` is read: `canChange` and `note` follow from it as in the backend,
   * and `packaged` from the field above. `on` and `off` follow `autostart`. Use `autostartFor` for a whole value.
   */
  autostartInfo: AutostartInfo;
  /** Saved versions in the sync folders (`locations` names the roots holding each). `addVersion` or `seedVersions` fill it in. */
  versions: MockVersion[];
  /** A folder waiting for the user to choose between its restored data and this computer's own. */
  joinPending: JoinPending | null;
  /**
   * The other computers whose file this one has read (`remote_devices`), by device id: their name and when each last wrote it.
   * `settle_lost_segment` measures a computer's silence from `writtenAt`. One with no entry is known only by its segments.
   */
  remoteDevices?: Record<string, { name: string; writtenAt: string }>;
  /**
   * The newest change this computer has seen, as the backend's floor for new stamps (`Service.newest`): when it says it was saved (epoch
   * seconds) and the other computer that saved it by name, or null when it was saved here. Null for no such change. `clockBehindOf` turns
   * it into the banner's view, so moving `now` forward past `at - 120` makes the line go away, as correcting the clock does.
   */
  newestStamp: { at: number; causeDevice: string | null } | null;
}

export function emptyState(now = '2026-10-31T12:00:00Z'): MockState {
  return {
    now: parseIso(now),
    projects: [],
    tasks: [],
    segments: [],
    gaps: [],
    pauses: [],
    tags: STARTER_TAGS.map(([id, name, color]) => ({ id, name, color, deleted: false, stamp: { at: '0001-01-01T00:00:00Z', by: '' } })),
    templates: [],
    summaries: [],
    prefix: null,
    otherPrefixes: {},
    referenceMarks: {},
    summaryCsvFiles: {},
    audit: [],
    backups: [],
    backupData: {},
    backupKeep: 30,
    hasPdfLogo: false,
    reminderOverride: null,
    reminderQuietUntil: null,
    shifts: [],
    rates: [],
    rounding: [],
    settings: {},
    theme: 'light',
    hideEarnings: false,
    lastCurrency: null,
    clientZonePromptDone: true,
    syncPromptDone: true,
    systemZone: 'Europe/Lisbon',
    targets: [],
    folders: {},
    pendingCopy: null,
    moveDelayMs: 0,
    detected: [],
    notices: [],
    warnings: [],
    exports: [],
    pdfExports: [],
    calls: [],
    autostart: false,
    setupDone: true,
    setupStep: 0,
    pauseRequests: [],
    drafts: {},
    revision: 0,
    nextId: 1,
    warm: false,
    lastWorked: null,
    lease: { state: 'off', readOnly: false, holder: null, generation: null, note: null, reachableRoots: [], unreachableRoots: [] },
    packaged: false,
    autostartInfo: { packaged: false, state: 'off', canChange: true, note: null },
    versions: [],
    joinPending: null,
    newestStamp: null,
  };
}

const err = (code: string, message: string) => ({ code, message });

// ---- sync folder moves, shaped like the Rust service: preview reads, the move copies, verifies and only
// then changes anything, and an unreadable source still switches but leaves a copy owed. A folder holds one
// file per device. Counts and device lists follow `sync.rs`: the files of the OTHER devices are what a move
// copies, and this device's own file is always written last.

const NO_COUNTS: DataCounts = { projects: 0, tasks: 0, segments: 0 };
/** The name this mock gives its own device in a folder (`deviceName` of the snapshot). */
const OWN_DEVICE = 'Mock PC';
const FOLDER_NOT_FOUND = 'Folder not found. Is the drive connected and the desktop client running?';

const folderOf = (s: MockState, root: string): MockFolder => s.folders[root] ?? { devices: [], counts: { ...NO_COUNTS }, available: true };
const folderHasData = (f: MockFolder): boolean => f.devices.length > 0 || f.counts.projects + f.counts.tasks + f.counts.segments > 0;
/** The other devices' files in a folder: this device's own file is read separately, as in `read_target`. */
const othersIn = (f: MockFolder): string[] => f.devices.filter((d) => d !== OWN_DEVICE);
const localCounts = (s: MockState): DataCounts => ({ projects: s.projects.length, tasks: s.tasks.length, segments: s.segments.length });
const mergeCounts = (...all: DataCounts[]): DataCounts => ({
  projects: Math.max(...all.map((c) => c.projects)),
  tasks: Math.max(...all.map((c) => c.tasks)),
  segments: Math.max(...all.map((c) => c.segments)),
});

function movePreview(s: MockState, from: string | null, to: string): MovePreview {
  const src = from === null ? null : folderOf(s, from);
  const dst = folderOf(s, to);
  const ok = src !== null && src.available;
  return {
    sourceAvailable: ok,
    sourceDevices: ok ? othersIn(src) : [],
    sourceCounts: ok ? { ...src.counts } : { ...NO_COUNTS },
    destinationHasData: folderHasData(dst),
    destinationDevices: othersIn(dst),
    destinationCounts: { ...dst.counts },
    localCounts: localCounts(s),
    warnings: dst.available ? [] : [FOLDER_NOT_FOUND],
  };
}

function sendProgress(step: string, done: number, total: number): void {
  try {
    emit('sync-move-progress', { step, done, total }).catch(() => undefined);
  } catch {
    // No event system installed (a bare `handle` call): progress is simply not observed.
  }
}

/** The 16 hex digits `sync.rs` prints for a checksum (FNV-1a there; here a stand-in of the same shape). */
const checksumOf = (c: DataCounts): string => (c.projects * 1_000_000 + c.tasks * 1_000 + c.segments).toString(16).padStart(16, '0');

async function moveSyncTarget(s: MockState, a: Record<string, unknown>): Promise<MoveResult> {
  const from = (a.from as string | null) ?? null;
  const to = a.to as string;
  const replacing = a.replacing === true;
  const dst = folderOf(s, to);
  const src = from === null ? null : folderOf(s, from);
  const sourceMissing = from !== null && !(src?.available ?? true);
  const incoming = !src || sourceMissing ? [] : othersIn(src);
  const there = othersIn(dst);
  const total = incoming.length + 1;
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, s.moveDelayMs));

  // The steps are the backend's own words.
  if (!dst.available) throw err('conflict', FOLDER_NOT_FOUND);
  sendProgress('Reading the folders', 0, 1);
  await pause();
  let filesCopied = 0;
  let filesAlreadyThere = 0;
  for (const [i, device] of incoming.entries()) {
    sendProgress('Copying device files', i, total);
    await pause();
    if (there.includes(device)) filesAlreadyThere += 1;
    else filesCopied += 1;
  }
  sendProgress("Writing this device's data", total - 1, total);
  await pause();
  if (dst.failNext) {
    dst.failNext = false;
    s.folders[to] = dst;
    throw err('conflict', "Could not write this device's file: the folder is read-only.");
  }
  sendProgress('Checking the copy', total - 1, total);
  await pause();

  // Verified: only now does anything change.
  const counts = mergeCounts(sourceMissing || !src ? NO_COUNTS : src.counts, dst.counts, localCounts(s));
  s.folders[to] = { ...dst, devices: [...new Set([...dst.devices, ...incoming, OWN_DEVICE])], counts };
  const view: Snapshot['sync']['targets'][number] = {
    provider: a.provider as Snapshot['sync']['targets'][number]['provider'],
    root: to,
    folder: `${to}/zWorkTracker`,
    status: { lastWrittenAt: toIso(s.now), lastReadAt: toIso(s.now), lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: Math.max(0, othersIn(s.folders[to]).length) },
  };
  const at = replacing && from !== null ? s.targets.findIndex((t) => t.root === from) : -1;
  if (!s.targets.some((t) => t.root === to)) {
    if (at >= 0) s.targets.splice(at, 1, view);
    else s.targets.push(view);
  } else if (at >= 0) s.targets.splice(at, 1);
  s.syncPromptDone = true;
  // Every move settles the owed copy: a source that could not be read leaves one, anything else clears it.
  s.pendingCopy = sourceMissing && from !== null ? { from, to } : null;
  sendProgress('Done', total, total);
  return {
    filesCopied,
    filesAlreadyThere,
    filesIgnored: 0,
    sourceMissing,
    counts,
    checksum: checksumOf(counts),
    warnings: sourceMissing ? ['The previous folder could not be read, so this used the data on this computer. You can retry the copy later.'] : [],
  };
}

/** A folder that holds another PC's records brings them in when it is connected (the first sync). */
function mergeFolderData(s: MockState, root: string): void {
  const data = s.folders[root]?.data;
  if (!data) return;
  for (const p of data.projects ?? []) if (!s.projects.some((x) => x.id === p.id)) s.projects.push(p);
  s.settings = { ...data.settings, ...s.settings, ...Object.fromEntries(Object.entries(data.settings ?? {}).filter(([k]) => (s.settings as Record<string, unknown>)[k] === undefined)) };
  for (const r of data.rounding ?? []) if (!s.rounding.some((x) => x.id === r.id)) s.rounding.push(r);
  for (const v of data.shifts ?? []) if (!s.shifts.some((x) => x.id === v.id)) s.shifts.push(v);
  delete s.folders[root]?.data;
}

const COLD_REQUIRED: RequiredField[] = ['name', 'project', 'description'];

/** What a cold start needs. Tags join the list as soon as any exist. */
const coldRequired = (s: MockState): RequiredField[] => (s.tags.some((t) => !t.deleted) ? [...COLD_REQUIRED, 'tags'] : COLD_REQUIRED);
const liveTag = (s: MockState, id: string): boolean => s.tags.some((t) => t.id === id && !t.deleted);

/** The task whose time ends last, for when the one worked on last has been deleted (`copy_source` in service.rs). */
function latestWorked(s: MockState): MockTask | undefined {
  let latest: { at: number; taskId: string } | null = null;
  for (const seg of s.segments) {
    const eff = effective(seg);
    if (eff === null || !s.tasks.some((t) => t.id === seg.taskId)) continue;
    const at = eff[1] ?? eff[0];
    if (latest === null || at > latest.at || (at === latest.at && seg.taskId > latest.taskId)) latest = { at, taskId: seg.taskId };
  }
  return s.tasks.find((t) => t.id === latest?.taskId);
}

function copySource(s: MockState): CopySource | null {
  if (s.lastWorked === null) return null;
  const t = s.tasks.find((x) => x.id === s.lastWorked) ?? latestWorked(s);
  if (!t) return null;
  const ends = s.segments.filter((x) => x.taskId === t.id).map((x) => x.end ?? x.start).sort();
  return {
    taskId: t.id,
    name: t.name,
    projectId: t.projectId,
    projectArchived: s.projects.find((p) => p.id === t.projectId)?.archived ?? true,
    // A copy keeps subtask text, with ticks cleared and no time carried over.
    description: resetSubtasks(t.description),
    lastWorkedAt: ends.at(-1) ?? null,
    tags: (t.tags ?? []).filter((id) => liveTag(s, id)),
  };
}

function checkColdFields(s: MockState, t: MockTask): void {
  if (s.warm) return;
  for (const field of coldRequired(s)) {
    if (field === 'name' && !t.name.trim()) throw err('validation', 'Task name is required for the first start after launch');
    if (field === 'project' && !t.projectId) throw err('validation', 'Project is required for the first start after launch');
    if (field === 'description' && !docHasText(t.description)) throw err('validation', 'Description is required for the first start after launch');
    if (field === 'tags' && !(t.tags ?? []).some((id) => liveTag(s, id))) throw err('validation', 'A tag is required for the first start after launch');
  }
}

/** A real launch after a clean quit: the running task pauses, and the launch is cold. */
export function relaunch(s: MockState): void {
  closeAllAndPause(s, { kind: 'appQuit' });
  s.warm = false;
  s.lastWorked = null;
}

/** A relaunch after a crash: the running task pauses, a notice explains it, and the launch is cold. */
export function crashRelaunch(s: MockState): void {
  const names = closeAllAndPause(s, { kind: 'crashRecovery' });
  s.warm = false;
  s.lastWorked = null;
  if (names.length) {
    s.notices.push({
      id: `crash-${s.nextId}`,
      level: 'warning',
      message: `The app did not shut down cleanly. ${names.join(', ')} was paused at its last recorded moment (${toIso(s.now)}). Time after that was not logged. The next start asks for every field.`,
    });
    s.nextId += 1;
  }
}

function closeAllAndPause(s: MockState, reason: PauseReason): string[] {
  const names: string[] = [];
  for (const t of s.tasks) {
    if (t.state === 'running' && !t.runningElsewhere) {
      closeOwn(s, t.id);
      setState(t, 'paused', reason);
      names.push(t.name);
    }
  }
  return names;
}

/** Open segments end now on this device, and at their last known moment on another. */
const endOf = (s: MockState) => (seg: MockSegment): number => capAtPauseRequest(seg.provisionalEnd ? parseIso(seg.provisionalEnd) : s.now, seg, s.pauseRequests, DEVICE_ID);

const liveTaskIds = (s: MockState): Set<string> => new Set(s.tasks.map((t) => t.id));

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** `prefix_of` in summary.rs: this device's prefix, or the first letter no other device uses, or "PC" when all are taken. */
export function prefixOf(s: MockState): string {
  if (s.prefix !== null) return s.prefix;
  const used = new Set(Object.values(s.otherPrefixes));
  return LETTERS.find((c) => !used.has(c)) ?? 'PC';
}

/** Other devices using the same prefix as this one: their numbers could collide with ours. */
export const prefixClashes = (s: MockState): string[] => {
  const mine = prefixOf(s);
  return Object.entries(s.otherPrefixes)
    .filter(([, p]) => p === mine)
    .map(([name]) => name);
};

/** References on more than one live summary, which offline devices can produce. */
export function referenceClashes(s: MockState): string[] {
  const seen = new Map<string, number>();
  for (const b of s.summaries) if (!b.voided) seen.set(b.reference, (seen.get(b.reference) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([r]) => r).sort();
}

/** `raise_reference_marks`: each prefix's mark rises to the highest number on any summary, voided ones included. */
export function raiseReferenceMarks(marks: Record<string, number>, summaries: readonly Pick<BillingSummary, 'prefix' | 'number'>[]): void {
  for (const b of summaries) marks[b.prefix] = Math.max(marks[b.prefix] ?? 0, b.number);
}

function pieceInput(s: MockState): PieceInput {
  return { segments: s.segments, gaps: s.gaps, pauses: s.pauses, liveTasks: liveTaskIds(s), summaries: s.summaries };
}

function billedSets(s: MockState): { segments: Set<string>; pauses: Set<string> } {
  const segments = new Set<string>();
  const pauses = new Set<string>();
  for (const b of s.summaries.filter((x) => !x.voided)) {
    for (const id of b.segmentIds) segments.add(id);
    for (const id of b.pauseIds) pauses.add(id);
  }
  return { segments, pauses };
}

const billingData = (s: MockState) => ({
  projects: s.projects.map((p) => ({ id: p.id, billable: p.billable, billingType: p.billingType ?? 'hourly', budgetHours: p.budgetHours, fixedFeeCents: p.fixedFeeCents ?? null, feeCurrency: p.feeCurrency ?? null })),
  tasks: s.tasks.map((t) => ({ id: t.id, projectId: t.projectId })),
  rates: s.rates.filter((r) => !r.deleted),
  rounding: s.rounding.filter((r) => !r.deleted),
});

const minutesSetting = (s: MockState, key: 'idleMinutes' | 'longRunMinutes', fallback: number): number => {
  const v = s.settings[key];
  return v === undefined ? fallback : Math.max(0, typeof v === 'number' ? v : 0);
};

/** The reminder the backend would raise: a long run on this device, or one the test planted. */
function currentReminder(s: MockState): Reminder | null {
  if (s.reminderQuietUntil !== null && s.reminderQuietUntil > s.now) return null;
  const open = s.segments.find((x) => x.end === null && x.deviceId === DEVICE_ID);
  if (!open) return null;
  if (s.reminderOverride) return s.reminderOverride;
  const minutes = minutesSetting(s, 'longRunMinutes', 240);
  if (minutes > 0 && s.now - parseIso(open.start) >= minutes * 60) return { kind: 'longRun', taskId: open.taskId, since: open.start };
  return null;
}

/** The two reference warnings of `service.rs`, worded the same. */
function referenceWarnings(s: MockState): string[] {
  const out: string[] = [];
  const repeated = referenceClashes(s);
  if (repeated.length > 0) out.push(`More than one billing summary uses the same reference: ${repeated.join(', ')}. Change a device's prefix and void and reissue one of them.`);
  const clashes = prefixClashes(s);
  if (clashes.length > 0) out.push(`Another device uses the same reference prefix: ${clashes.join(', ')}. Choose a different prefix, or references can repeat.`);
  return out;
}

/** `service.rs`: two active projects (or two tags) with the same colour, which only a merge can produce. */
function colorWarnings(s: MockState): string[] {
  const out: string[] = [];
  const groups: [string, { name: string; color: string }[]][] = [
    ['projects', s.projects.filter((p) => !p.archived)],
    ['tags', s.tags.filter((t) => !t.deleted)],
  ];
  for (const [kind, items] of groups) {
    const by = new Map<string, string[]>();
    for (const i of items) by.set(i.color.toLowerCase(), [...(by.get(i.color.toLowerCase()) ?? []), i.name]);
    for (const names of by.values()) {
      if (names.length > 1) out.push(`These ${kind} have the same colour, probably from two devices: ${names.join(', ')}. Change one if that is confusing.`);
    }
  }
  return out;
}

/** `hlc::CLOCK_BEHIND_WARN_SECS`: a newest change this far ahead of the clock, or more, is worth a line. */
const CLOCK_BEHIND_WARN_SECS = 120;

/** `hlc::HLC_MAX_LEAD_SECS`: the furthest past this computer's clock a new change may be dated. A newest change this far ahead, or more, can't be beaten. */
const HLC_MAX_LEAD_SECS = 86_400;

/** As the backend's `clock_behind`: the view while this computer's clock is behind the newest change it has seen, else null. */
export function clockBehindOf(s: MockState): ClockBehindView | null {
  const n = s.newestStamp;
  if (!n || n.at - s.now < CLOCK_BEHIND_WARN_SECS) return null;
  const behindSecs = n.at - s.now;
  return { behindSecs, newestAt: toIso(n.at), causeDevice: n.causeDevice, capped: behindSecs >= HLC_MAX_LEAD_SECS };
}

/** A small seeded generator (mulberry32), so a mock run picks the same replacement colours every time. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const defaultRandom = seeded(20_261_031);

/**
 * `colors::resolve`: the colour to save is as asked, unless it exactly matches (any case) a colour in `taken`,
 * when a random distinct one replaces it. `unchanged` (an update that keeps its colour) is never replaced.
 */
function resolveColor(s: MockState, wanted: string, taken: readonly string[], unchanged: boolean): { color: string; replacedFrom: string | null } {
  const color = cleanColor(wanted);
  if (unchanged || !taken.some((t) => t.toLowerCase() === color)) return { color, replacedFrom: null };
  return { color: distinctColor(taken, s.random ?? defaultRandom), replacedFrom: color };
}

/** Tags are a set: their order is no change. */
const sameTags = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t) => b.includes(t));

/** A read gives the revision as it is. Anything else counts as a write, which is the only thing that raises it in the backend. */
function snapshot(s: MockState, read = false): Snapshot {
  // A summary counts as a task here, as in the backend: it names its project, and a delete can leave it the last thing that does.
  const withTasks = new Set([...s.tasks.map((t) => t.projectId), ...s.summaries.map((b) => b.projectId)]);
  const input = pieceInput(s);
  const all = computePieces(input, endOf(s));
  const billed = billedSets(s);
  const totals = taskTotals(all, billed.segments, billed.pauses);
  const unconfirmed = unconfirmedSecs(s.gaps.filter((g) => input.liveTasks.has(g.taskId)));
  const figures = projectFigures(billingData(s), input, s.systemZone, endOf(s));
  const segments = all
    .map((p) => ({
      id: p.id,
      taskId: p.taskId,
      deviceId: p.deviceId ?? '',
      start: toIso(p.start),
      end: p.open ? null : toIso(p.end),
      provisionalEnd: p.open && p.deviceId !== DEVICE_ID ? toIso(p.end) : null,
      segmentId: p.sourceId,
      kind: p.kind,
      subtaskId: p.subtaskId,
    }))
    .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.id < y.id ? -1 : 1));
  const rawSegments = s.segments
    .filter((x) => input.liveTasks.has(x.taskId))
    .map((x) => {
      const eff = effective(x);
      return {
        id: x.id,
        taskId: x.taskId,
        deviceId: x.deviceId,
        rawStart: x.start,
        rawEnd: x.end,
        start: eff ? toIso(eff[0]) : x.start,
        end: eff ? (eff[1] === null ? null : toIso(eff[1])) : x.end,
        voided: eff === null,
        corrected: !!x.edit && !x.edit.voided,
        manual: x.manual === true,
        reason: x.edit?.reason ?? '',
        billed: billed.segments.has(x.id),
      };
    });
  const tags = s.tags.filter((t) => !t.deleted);
  return structuredClone({
    revision: read ? s.revision : (s.revision += 1),
    now: toIso(s.now),
    deviceId: DEVICE_ID,
    deviceName: 'Mock PC',
    systemZone: s.systemZone,
    tzdbVersion: 'mock',
    projects: s.projects.map((p) => ({
      ...p,
      hasTasks: withTasks.has(p.id),
      billingType: p.billingType ?? 'hourly',
      fixedFeeCents: p.fixedFeeCents ?? null,
      feeCurrency: p.feeCurrency ?? null,
      figures: figures.get(p.id) ?? { exactSecs: 0, pauseSecs: 0, billableSecs: 0, thinkingSecs: 0, effectiveHourlyCents: null, timeValueCents: {}, budget: null },
    })),
    tasks: s.tasks.map(({ subtaskTags, ...t }) => {
      const tt = totals.get(t.id);
      return {
        ...t,
        tags: t.tags ?? [],
        activeSubtask: t.activeSubtask ?? null,
        subtasks: subtaskItems(t.description).map((i) => ({
          id: i.id,
          text: i.text,
          checked: i.checked,
          secs: tt?.subtaskSecs.get(i.id) ?? 0,
          // What the editor shows: the stored list cut to the task's tags, or null for "Same as task".
          tags: shownTags(t.tags ?? [], subtaskTags?.[i.id]?.tags),
        })),
        billedSecs: tt?.billedSecs ?? 0,
        unbilledSecs: tt?.unbilledSecs ?? 0,
        thinkingSecs: tt?.thinkingSecs ?? 0,
        pauseSecs: tt?.pauseSecs ?? 0,
        unconfirmedSecs: unconfirmed.get(t.id) ?? 0,
      };
    }),
    segments,
    shifts: s.shifts.filter((x) => !x.deleted),
    rates: s.rates.filter((x) => !x.deleted),
    rounding: s.rounding.filter((x) => !x.deleted),
    settings: s.settings,
    prefs: {
      theme: s.theme,
      hideEarnings: s.hideEarnings,
      lastCurrency: s.lastCurrency,
      clientZonePromptDone: s.clientZonePromptDone,
    },
    notices: s.notices,
    warnings: [...s.warnings, ...colorWarnings(s), ...referenceWarnings(s), ...(s.packaged && s.targets.length === 0 ? [PACKAGED_NO_FOLDER_WARNING] : [])],
    clockBehind: clockBehindOf(s),
    sync: { targets: s.targets, detected: s.detected, promptPending: !s.syncPromptDone && s.targets.length === 0, pendingCopy: s.pendingCopy, joinPending: s.joinPending },
    lease: leaseView(s),
    platform: { packaged: s.packaged },
    launch: { warm: s.warm, coldRequired: coldRequired(s), copySource: s.warm ? copySource(s) : null },
    rawSegments,
    gaps: s.gaps.filter((g) => input.liveTasks.has(g.taskId)),
    pauses: s.pauses.filter((x) => !x.deleted && input.liveTasks.has(x.taskId)),
    tags,
    templates: s.templates.filter((x) => !x.deleted),
    billing: { prefix: prefixOf(s), clashes: prefixClashes(s), summaries: s.summaries },
    // The backend also skips a store that has data but no setup state; the mock's seeds always hold data,
    // so the `legacy` first-run seed stands for that case instead.
    setup: { pending: !s.setupDone && (s.setupStep > 0 || !s.syncPromptDone), step: s.setupStep },
    pauseRequests: s.pauseRequests.filter((q) => input.liveTasks.has(q.taskId)),
    reminder: currentReminder(s),
    reminderSettings: {
      idleMinutes: minutesSetting(s, 'idleMinutes', 10),
      longRunMinutes: minutesSetting(s, 'longRunMinutes', 240),
      remindPastShift: s.settings.remindPastShift ?? true,
    },
    backupKeep: s.backupKeep,
    hasPdfLogo: s.hasPdfLogo,
  });
}

const stamp = (s: MockState) => ({ at: toIso(s.now), by: DEVICE_ID });

/** A stamp later than `old`, as the backend's clock makes one: now, or a second past the old one if that is not yet later. */
const stampAfter = (s: MockState, old: Stamp): Stamp => ({ at: toIso(Math.max(s.now, parseIso(old.at) + 1)), by: DEVICE_ID });

/**
 * The task's tags just changed: each subtask's list keeps only tags still on the task, in the same write, and moves its stamp
 * only if that changed it (`prune_subtask_tags`). A list left empty stays "No tag", and a reset stays a reset.
 */
function pruneSubtaskTags(s: MockState, t: MockTask): void {
  const tags = t.tags ?? [];
  for (const entry of Object.values(t.subtaskTags ?? {})) {
    if (entry.tags === null) continue;
    const kept = entry.tags.filter((tag) => tags.includes(tag));
    if (kept.length === entry.tags.length) continue;
    entry.tags = kept;
    entry.stamp = stampAfter(s, entry.stamp);
  }
}

/** `validate.rs`: a subtask id that can carry tags of its own is one a description may hold, and a task has at most this many such entries. */
const MAX_SUBTASK_ID_BYTES = 64;
const MAX_SUBTASK_TAG_ENTRIES = 10_000;

/** The same list in the same order, which is what the backend compares to see whether a task's tags changed. */
const sameTagList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `Shared::set_subtask_tags`: gives a subtask some of its task's tags (an empty list is "No tag") or, with null, puts it back on
 * "Same as task". With `expected`, what the row showed, the edit is written only if the subtask still shows that, or already
 * shows what is asked. A tag the task no longer has is refused the same way, as the row's view is out of date. A refusal writes
 * nothing and says what the subtask shows now.
 */
function setSubtaskTags(s: MockState, taskId: string, subtaskId: string, tags: readonly string[] | null, expected: SubtaskTagsExpected | null | undefined): SubtaskTagsReply {
  const t = task(s, taskId);
  if (subtaskId === '' || !subtaskItems(t.description).some((i) => i.id === subtaskId)) throw err('not_found', 'subtask not found');
  const taskTags = t.tags ?? [];
  const shownNow = (): string[] | null => shownTags(taskTags, t.subtaskTags?.[subtaskId]?.tags);
  const outcome = (conflict: boolean): SubtaskTagsReply => {
    const now = shownNow();
    return { snapshot: snapshot(s), conflict, tags: now, effective: effectiveTags(taskTags, now) };
  };
  const shown = shownNow();
  if (tags !== null && tags.some((tag) => !taskTags.includes(tag))) return outcome(true);
  const wanted = tags === null ? null : effectiveTags(taskTags, tags);
  if (sameOverride(shown, wanted)) return outcome(false);
  if (expected && !sameOverride(shown, expected.tags ?? null)) return outcome(true);
  if (new TextEncoder().encode(subtaskId).length > MAX_SUBTASK_ID_BYTES) throw err('validation', 'a subtask id has an invalid length');
  const stored = (t.subtaskTags ??= {});
  const entry = stored[subtaskId];
  if (!entry && Object.keys(stored).length >= MAX_SUBTASK_TAG_ENTRIES) throw err('validation', 'this task has too many subtasks with tags of their own');
  stored[subtaskId] = { tags: wanted, stamp: entry ? stampAfter(s, entry.stamp) : stamp(s) };
  return outcome(false);
}

function newId(s: MockState, prefix: string): string {
  const id = `${prefix}-${s.nextId}`;
  s.nextId += 1;
  return id;
}

/** The backend's `clean_color`: exactly `#rrggbb`, stored lowercase. */
function cleanColor(raw: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(raw)) throw err('validation', 'a color must look like #1a2b3c');
  return raw.toLowerCase();
}

function cleanProject(s: MockState, input: ProjectInput, except: string | null): ProjectInput & { billingType: 'hourly' | 'fixedFee'; fixedFeeCents: number | null; feeCurrency: 'EUR' | 'USD' | null } {
  const name = cleanText(input.name, 'Project name', 80);
  if (s.projects.some((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase())) {
    throw err('conflict', `a project named "${name}" already exists`);
  }
  const color = cleanColor(input.color);
  if (input.clientZone && !isZone(input.clientZone)) throw err('validation', `unknown time zone: ${input.clientZone}`);
  const billingType = input.billingType ?? 'hourly';
  let fixedFeeCents: number | null = null;
  if (billingType === 'fixedFee') {
    if (input.fixedFeeCents === null || input.fixedFeeCents === undefined) throw err('validation', 'enter the fixed fee');
    if (input.fixedFeeCents < 0 || input.fixedFeeCents > 1_000_000_000_000) throw err('validation', 'that fee is out of range');
    if (!input.feeCurrency || !isCurrency(input.feeCurrency)) throw err('validation', "the fee's currency must be EUR or USD");
    fixedFeeCents = input.fixedFeeCents;
  }
  return { ...input, name, color, billingType, fixedFeeCents, feeCurrency: billingType === 'fixedFee' ? (input.feeCurrency ?? null) : null };
}

/** `validate.rs` MAX_NAME: a task name is at most 200 characters, with no control characters. */
const cleanTaskName = (raw: string): string => cleanText(raw, 'Task name', 200);

/** An edit removed the active subtask's item: no subtask is active now (`clear_missing_active`). */
function clearMissingActive(t: MockTask): void {
  if (t.activeSubtask && !subtaskItems(t.description).some((i) => i.id === t.activeSubtask)) t.activeSubtask = null;
}

function task(s: MockState, id: string): MockTask {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) throw err('not_found', 'task not found');
  return t;
}

function closeOwn(s: MockState, taskId: string): void {
  for (const seg of s.segments) {
    if (seg.taskId === taskId && seg.end === null && seg.deviceId === DEVICE_ID) {
      seg.end = toIso(Math.max(s.now, parseIso(seg.start)));
    }
  }
}

function setState(t: MockTask, state: TaskState, reason: PauseReason | null): void {
  t.state = state;
  t.pauseReason = reason;
}

function begin(s: MockState, id: string, required: TaskState, action: string) {
  const t = task(s, id);
  if (t.state !== required) throw err('illegal_transition', `cannot ${action} a task that is ${t.state}`);
  if (!t.name.trim()) throw err('validation', 'Task name is required');
  const project = s.projects.find((p) => p.id === t.projectId);
  if (!project) throw err('validation', 'Project is required');
  if (project.archived) throw err('validation', `project "${project.name}" is archived; restore it first`);
  checkColdFields(s, t);
  let autoPausedTaskId: string | null = null;
  let autoPausedTaskName: string | null = null;
  for (const other of s.tasks) {
    if (other.id !== id && other.state === 'running' && !other.runningElsewhere) {
      closeOwn(s, other.id);
      setState(other, 'paused', { kind: 'autoPaused', byTaskId: id });
      autoPausedTaskId = other.id;
      autoPausedTaskName = other.name;
    }
  }
  s.segments.push({ id: newId(s, 'seg'), taskId: id, deviceId: DEVICE_ID, start: toIso(s.now), end: null, provisionalEnd: null, subtaskId: t.activeSubtask ?? null });
  setState(t, 'running', null);
  s.warm = true;
  s.lastWorked = id;
  return { autoPausedTaskId, autoPausedTaskName, snapshot: snapshot(s) };
}

// ---- phase 2: corrections, time away, billable pauses, subtasks, tags, templates, billing summaries,
// PDF, backups and reminders. Rules and error codes follow adjust.rs, catalog.rs, summary.rs and service.rs.

const NOT_HANDLED = Symbol('not handled');
const MAX_REASON = 500;
const MAX_SEGMENT_SECS = 366 * 86_400;
/** The limits of a date someone chose, as `check_chosen_date` in validate.rs holds them: 2000-01-01 to 2100-01-01, UTC. */
const EARLIEST_CHOSEN = Date.UTC(2000, 0, 1) / 1000;
const LATEST_CHOSEN = Date.UTC(2100, 0, 1) / 1000;
function checkChosenDate(sec: number, what: string): void {
  if (sec < EARLIEST_CHOSEN || sec > LATEST_CHOSEN) throw err('validation', `${what} must be between 2000-01-01 and 2100-01-01`);
}

function checkTagIds(s: MockState, ids: readonly string[]): void {
  if (ids.length > 32) throw err('validation', 'too many tags');
  for (const id of ids) if (!liveTag(s, id)) throw err('not_found', 'tag not found');
}

function addAudit(s: MockState, entity: string, entityId: string, action: string, reason: string, before: unknown, after: unknown): void {
  s.audit.push({ id: newId(s, 'audit'), at: toIso(s.now), by: DEVICE_ID, entity, entityId, action, reason, before, after });
}

function cleanReason(raw: string | undefined): string {
  const reason = (raw ?? '').trim();
  if ([...reason].length > MAX_REASON) throw err('validation', 'the reason is too long');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(reason)) throw err('validation', "the reason has characters that can't be stored");
  return reason;
}

function cleanText(raw: string, field: string, max: number): string {
  const text = raw.trim();
  if (!text) throw err('validation', `${field} is required`);
  if ([...text].length > max) throw err('validation', `${field} is longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw err('validation', `${field} contains control characters`);
  return text;
}

function checkRange(s: MockState, startIso: string, endIso: string): [number, number] {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (end <= start) throw err('validation', 'the end must be after the start');
  if (end > s.now) throw err('validation', "the end can't be in the future");
  checkChosenDate(start, 'the start');
  checkChosenDate(end, 'the end');
  if (end - start > MAX_SEGMENT_SECS) throw err('validation', 'that span is too long');
  return [start, end];
}

/** Other time logged on this device that the span overlaps. Segments on other PCs may overlap. */
function overlapping(s: MockState, device: string, except: string | null, start: number, end: number): string[] {
  const names: string[] = [];
  for (const seg of s.segments) {
    if (seg.deviceId !== device || seg.id === except) continue;
    const eff = effective(seg);
    if (!eff || !(eff[0] < end && (eff[1] === null || eff[1] > start))) continue;
    const t = s.tasks.find((x) => x.id === seg.taskId);
    if (t) names.push(t.name);
  }
  return names;
}

function refuseOverlap(names: string[]): void {
  if (names.length > 0) throw err('overlap', `this overlaps time already logged on: ${names.join(', ')}`);
}

const BILLED = 'this time is on a billing summary; void that summary first';

/**
 * `ExportSource::narrowed`: a selection must be non-empty, name tasks that exist, and name days on which
 * the task has counted time in the request's zone. Nothing else is checked, and nothing is trusted.
 */
function checkSelection(s: MockState, selection: SelectedEntry[] | null | undefined, zone: string): void {
  if (selection === null || selection === undefined) return;
  if (selection.length === 0) throw err('validation', 'select at least one entry to export');
  const input = pieceInput(s);
  const spans = computePieces(input, endOf(s)).map((p) => ({ taskId: p.taskId, projectId: s.tasks.find((t) => t.id === p.taskId)?.projectId ?? '', start: p.start, end: p.end, kind: p.kind }));
  const book = new RateBook(s.projects, s.rates.filter((r) => !r.deleted));
  const have = new Set(taskDays(spans, zone, book, s.rounding.filter((r) => !r.deleted)).map((r) => `${r.taskId}|${r.day}`));
  for (const e of selection) {
    if (!s.tasks.some((t) => t.id === e.taskId)) throw err('not_found', 'task not found');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.day)) throw err('validation', 'the selected day is not a date');
    if (!have.has(`${e.taskId}|${e.day}`)) throw err('validation', `that task has no time on ${e.day}`);
  }
}

/** `Segment::is_open`: no end and no recorded edit. A settled segment (see `settleSegments`) has no end of its own but is closed for everyone else. */
const isOpen = (seg: Pick<MockSegment, 'end' | 'edit'>): boolean => seg.end === null && !seg.edit;

function correctable(s: MockState, id: string): MockSegment {
  const seg = s.segments.find((x) => x.id === id);
  if (!seg) throw err('not_found', 'work segment not found');
  if (isOpen(seg)) throw err('conflict', 'this segment is still running; pause the task first');
  if (billedSets(s).segments.has(id)) throw err('conflict', BILLED);
  task(s, seg.taskId);
  return seg;
}

const segJson = (seg: MockSegment) => ({ rawStart: seg.start, rawEnd: seg.end, edit: seg.edit ?? null, subtaskId: seg.subtaskId ?? null });

function applyEdit(s: MockState, seg: MockSegment, edit: MockSegment['edit'], action: string, reason: string): void {
  const before = segJson(seg);
  seg.edit = edit;
  addAudit(s, 'segment', seg.id, action, reason, before, segJson(seg));
}

function summaryInput(s: MockState) {
  const live = liveTaskIds(s);
  return {
    ...billingData(s),
    segments: s.segments,
    gaps: s.gaps,
    pauses: s.pauses,
    tasksLive: s.tasks.filter((t) => live.has(t.id)).map((t) => ({ id: t.id, projectId: t.projectId, name: t.name })),
    billedSegments: billedSets(s).segments,
    billedPauses: billedSets(s).pauses,
    summaries: s.summaries,
  };
}

function checkSummaryRequest(s: MockState, req: SummaryRequest): void {
  if (!isZone(req.zone)) throw err('validation', `unknown time zone: ${req.zone}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.from)) throw err('validation', 'the start date is not a date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.to)) throw err('validation', 'the end date is not a date');
  if (req.to < req.from) throw err('validation', 'the end date must not be before the start date');
  if (!s.projects.some((p) => p.id === req.projectId)) throw err('not_found', 'project not found');
}

/**
 * Everything a restore rolls back, as JSON: the records, the replicated settings (`data.settings`) and the
 * moment it was taken (the backup's heartbeat). Kept on this computer, not rolled back: preferences such as
 * the theme and how many backups to keep, sync folders, the device prefix, the reference marks, and the audit
 * log, which only grows (the backup's copy is still written, and merged in).
 */
const dataKeys = ['projects', 'tasks', 'segments', 'gaps', 'pauses', 'tags', 'templates', 'summaries', 'rates', 'rounding', 'shifts', 'settings', 'audit'] as const;
export const captureData = (s: MockState): string => JSON.stringify({ ...Object.fromEntries(dataKeys.map((k) => [k, s[k]])), heartbeat: s.now });

type Captured = Pick<MockState, (typeof dataKeys)[number]> & { heartbeat?: number };

/** `backup::list`: newest first by the date in the name, whichever kind of backup it is. */
const backupDate = (name: string): string => name.replace(/^z-work-data-/, '').replace(/^pre-restore-/, '');
const SAFETY_KEEP = 5;

function sortBackups(s: MockState): void {
  s.backups.sort((a, b) => (backupDate(a.name) < backupDate(b.name) ? 1 : backupDate(a.name) > backupDate(b.name) ? -1 : 0));
}

/** Keeps the newest few safety copies, like `backup::safety_copy`. */
function pruneSafetyCopies(s: MockState): void {
  const names = s.backups.filter((b) => b.safety).map((b) => b.name).sort();
  for (const name of names.slice(0, Math.max(0, names.length - SAFETY_KEEP))) {
    s.backups = s.backups.filter((b) => b.name !== name);
    delete s.backupData[name];
  }
}

/**
 * A task the backup held running stopped being timed when the backup was taken: its open segment on this
 * device ends at the backup's heartbeat, and the task is paused as `backupRestored`. Returns the task names.
 */
function closeBackupRunning(s: MockState, heartbeat: number | null): string[] {
  const names: string[] = [];
  for (const seg of s.segments) {
    if (seg.end !== null || seg.deviceId !== DEVICE_ID) continue;
    const start = parseIso(seg.start);
    seg.end = toIso(Math.max(heartbeat ?? start, start));
    const t = s.tasks.find((x) => x.id === seg.taskId);
    if (!t) continue;
    const stillOpen = s.segments.some((x) => x.taskId === t.id && x.end === null);
    if (t.state === 'running' && !stillOpen) setState(t, 'paused', { kind: 'backupRestored' });
    names.push(t.name);
  }
  return names;
}

/** A copy of the data as it is now, kept before a restore so that it can be undone (`backup::safety_copy`). Returns its name. */
function takeSafetyCopy(s: MockState): string {
  const safety = `pre-restore-${toIso(s.now).replace(/:/g, '-').replace('Z', '')}.json`;
  s.backupData[safety] = captureData(s);
  s.backups = s.backups.filter((b) => b.name !== safety);
  s.backups.push({ name: safety, bytes: s.backupData[safety].length, safety: true });
  sortBackups(s);
  pruneSafetyCopies(s);
  return safety;
}

/**
 * `install_restored`, shared by a restored backup and a restored version: the data held replaces the records here, the log keeps
 * both sets of entries, and the numbers already issued stay issued. `held` is `captureData` output, or nothing, when only the
 * running task is closed. A running task ends at the heartbeat the data holds, else `heartbeatIfNone`.
 */
function installRestored(s: MockState, held: string | undefined, heartbeatIfNone: number | null): { names: string[]; heartbeat: number | null } {
  // Numbers already issued, here or in the backup, are never issued again.
  raiseReferenceMarks(s.referenceMarks, s.summaries);
  let names: string[] = [];
  let heartbeat: number | null = null;
  if (held) {
    const restored = JSON.parse(held) as Captured;
    raiseReferenceMarks(s.referenceMarks, restored.summaries);
    // The log only grows: the backup's entries and every entry made since both stay.
    const log = new Map(restored.audit.map((e) => [e.id, e]));
    for (const e of s.audit) log.set(e.id, e);
    const keep = [...log.values()];
    Object.assign(s, Object.fromEntries(dataKeys.map((k) => [k, restored[k]])));
    s.audit = keep;
    heartbeat = restored.heartbeat ?? heartbeatIfNone;
    names = closeBackupRunning(s, heartbeat);
  }
  return { names, heartbeat };
}

/** `Shared::summaries_listing`: the references of the live summaries listing any of this task's time, in order. */
export function summariesListing(s: MockState, taskId: string): string[] {
  const ownSegments = new Set(s.segments.filter((x) => x.taskId === taskId).map((x) => x.id));
  const ownPauses = new Set(s.pauses.filter((p) => p.taskId === taskId).map((p) => p.id));
  const listing = s.summaries.filter((b) => !b.voided && (b.rows.some((r) => r.taskId === taskId) || b.segmentIds.some((id) => ownSegments.has(id)) || b.pauseIds.some((id) => ownPauses.has(id))));
  return [...new Set(listing.map((b) => b.reference))].sort();
}

/**
 * `Shared::delete_task`: a task of any state goes with everything logged on it, from every view, unless a timer of it
 * is open on this device or its time is on a live billing summary. A timer open on another of the person's computers
 * doesn't stop it, with a request to pause it or without: that computer stops it when it next syncs, which the mock
 * doesn't model. The backend keeps the records in the file, hidden, so that a backup can bring them back and time that
 * arrives later stays hidden. Here they are simply dropped, and a backup the mock holds still has them.
 */
function deleteTask(s: MockState, id: string): void {
  const t = task(s, id);
  if (s.segments.some((x) => x.taskId === id && x.end === null && x.deviceId === DEVICE_ID)) throw err('conflict', 'this task is running; pause or stop it before deleting it');
  const listing = summariesListing(s, id);
  if (listing.length === 1) throw err('conflict', `this task's time is on billing summary ${listing[0]}; void that summary first`);
  if (listing.length > 1) throw err('conflict', `this task's time is on billing summaries ${listing.join(', ')}; void those summaries first`);
  addAudit(
    s,
    'task',
    id,
    'delete',
    '',
    {
      name: t.name,
      project: s.projects.find((p) => p.id === t.projectId)?.name ?? null,
      state: t.state,
      segments: s.segments.filter((x) => x.taskId === id).length,
      pauses: s.pauses.filter((p) => p.taskId === id && !p.deleted).length,
    },
    null,
  );
  s.tasks = s.tasks.filter((x) => x.id !== id);
  s.segments = s.segments.filter((x) => x.taskId !== id);
  s.gaps = s.gaps.filter((g) => g.taskId !== id);
  s.pauses = s.pauses.filter((p) => p.taskId !== id);
  s.pauseRequests = s.pauseRequests.filter((q) => q.taskId !== id);
  delete s.drafts[id];
  // Tasks continued from it stay, without the link: a task deleted with its time leaves no trace, not even "an earlier task".
  for (const other of s.tasks) if (other.continuedFrom === id) other.continuedFrom = null;
}

function phase2(s: MockState, cmd: string, a: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'add_manual_entry': {
      const input = a.input as ManualEntryInput;
      task(s, input.taskId);
      const [start, end] = checkRange(s, input.start, input.end);
      const reason = cleanReason(input.reason);
      if (!input.allowOverlap) refuseOverlap(overlapping(s, DEVICE_ID, null, start, end));
      const id = newId(s, 'seg');
      const seg: MockSegment = { id, taskId: input.taskId, deviceId: DEVICE_ID, start: toIso(start), end: toIso(end), provisionalEnd: null, manual: true, subtaskId: input.subtaskId ?? null, edit: null };
      s.segments.push(seg);
      addAudit(s, 'segment', id, 'manualEntry', reason, null, segJson(seg));
      return { id, snapshot: snapshot(s) };
    }
    case 'correct_segment': {
      const input = a.input as CorrectionInput;
      const [start, end] = checkRange(s, input.start, input.end);
      const reason = cleanReason(input.reason);
      const seg = correctable(s, input.segmentId);
      if (!input.allowOverlap) refuseOverlap(overlapping(s, seg.deviceId, seg.id, start, end));
      applyEdit(s, seg, { start: toIso(start), end: toIso(end), voided: false, reason }, 'correct', reason);
      return snapshot(s);
    }
    case 'void_segment': {
      const reason = cleanReason(a.reason as string);
      const seg = correctable(s, a.id as string);
      // The times that count come first, so voiding a settled segment keeps the end it was settled at.
      const eff = effective(seg);
      applyEdit(s, seg, { start: eff ? toIso(eff[0]) : seg.start, end: eff && eff[1] !== null ? toIso(eff[1]) : (seg.end ?? seg.start), voided: true, reason }, 'void', reason);
      return snapshot(s);
    }
    case 'restore_segment': {
      const reason = cleanReason(a.reason as string);
      const seg = correctable(s, a.id as string);
      if (seg.end === null) throw err('conflict', "this segment's device never reported an end, so it can only be corrected");
      applyEdit(s, seg, null, 'restore', reason);
      return snapshot(s);
    }
    case 'decide_gap': {
      const gap = s.gaps.find((g) => g.id === a.id);
      if (!gap) throw err('not_found', 'time away not found');
      if (billedSets(s).segments.has(gap.segmentId)) throw err('conflict', BILLED);
      const before = { decision: gap.decision };
      gap.decision = a.decision as GapDecision;
      addAudit(s, 'gap', gap.id, 'decide', '', before, { decision: gap.decision });
      return snapshot(s);
    }
    case 'mark_billable_pause': {
      const input = a.input as PauseInput;
      task(s, input.taskId);
      const [start, end] = checkRange(s, input.start, input.end);
      const note = cleanReason(input.note);
      const id = newId(s, 'pause');
      s.pauses.push({ id, taskId: input.taskId, start: toIso(start), end: toIso(end), note, deleted: false, stamp: stamp(s) });
      addAudit(s, 'pause', id, 'markBillable', note, null, { taskId: input.taskId, start: toIso(start), end: toIso(end) });
      return { id, snapshot: snapshot(s) };
    }
    case 'unmark_billable_pause': {
      if (s.summaries.some((b) => !b.voided && b.pauseIds.includes(a.id as string))) throw err('conflict', BILLED);
      const pause = s.pauses.find((p) => p.id === a.id);
      if (!pause) throw err('not_found', 'billable pause not found');
      pause.deleted = true;
      addAudit(s, 'pause', pause.id, 'unmarkBillable', '', { taskId: pause.taskId, start: pause.start, end: pause.end }, null);
      return snapshot(s);
    }
    case 'set_active_subtask': {
      const t = task(s, a.taskId as string);
      const id = (a.subtaskId as string | null) ?? null;
      if (id !== null && !subtaskItems(t.description).some((i) => i.id === id)) throw err('not_found', 'subtask not found');
      const changed = (t.activeSubtask ?? null) !== id;
      t.activeSubtask = id;
      if (changed) {
        // The running segment closes now and a new one starts, so each segment belongs to exactly one subtask.
        const open = s.segments.filter((x) => x.taskId === t.id && x.deviceId === DEVICE_ID && x.end === null);
        for (const seg of open) seg.end = toIso(Math.max(s.now, parseIso(seg.start)));
        if (open.length > 0) s.segments.push({ id: newId(s, 'seg'), taskId: t.id, deviceId: DEVICE_ID, start: toIso(s.now), end: null, provisionalEnd: null, subtaskId: id });
      }
      return snapshot(s);
    }
    case 'set_subtask_tags':
      return setSubtaskTags(s, a.taskId as string, a.subtaskId as string, (a.tags ?? null) as string[] | null, a.expected as SubtaskTagsExpected | null | undefined);
    case 'save_tag': {
      const input = a.input as TagInput;
      const name = cleanText(input.name, 'Tag name', 40);
      cleanColor(input.color);
      if (s.tags.some((t) => !t.deleted && t.id !== (input.id ?? null) && t.name.toLowerCase() === name.toLowerCase())) throw err('conflict', `a tag named "${name}" already exists`);
      const own = input.id ? s.tags.find((t) => t.id === input.id) : undefined;
      if (input.id && !own) throw err('not_found', 'tag not found');
      const taken = s.tags.filter((t) => !t.deleted && t.id !== (input.id ?? null)).map((t) => t.color);
      const { color, replacedFrom } = resolveColor(s, input.color, taken, own?.color.toLowerCase() === input.color.toLowerCase());
      if (own) {
        Object.assign(own, { name, color, deleted: false, stamp: stamp(s) });
        return { id: own.id, snapshot: snapshot(s), color, replacedFrom };
      }
      const id = newId(s, 'tag');
      s.tags.push({ id, name, color, deleted: false, stamp: stamp(s) });
      return { id, snapshot: snapshot(s), color, replacedFrom };
    }
    case 'delete_tag': {
      const tag = s.tags.find((t) => t.id === a.id);
      if (!tag) throw err('not_found', 'tag not found');
      tag.deleted = true;
      return snapshot(s);
    }
    case 'save_template': {
      const input = a.input as TemplateInput;
      const name = cleanText(input.name, 'Template name', 120);
      checkTagIds(s, input.tags);
      if (input.projectId && !s.projects.some((p) => p.id === input.projectId)) throw err('not_found', 'project not found');
      const doc = resetSubtasks(input.description);
      if (input.id) {
        const old = s.templates.find((t) => t.id === input.id);
        if (!old) throw err('not_found', 'template not found');
        Object.assign(old, { name, projectId: input.projectId, description: doc, tags: input.tags, deleted: false, stamp: stamp(s) });
        return { id: old.id, snapshot: snapshot(s) };
      }
      const id = newId(s, 'template');
      s.templates.push({ id, name, projectId: input.projectId, description: doc, tags: input.tags, deleted: false, stamp: stamp(s) });
      return { id, snapshot: snapshot(s) };
    }
    case 'delete_template': {
      const t = s.templates.find((x) => x.id === a.id);
      if (!t) throw err('not_found', 'template not found');
      t.deleted = true;
      return snapshot(s);
    }
    case 'task_from_template': {
      const t = s.templates.find((x) => x.id === a.id && !x.deleted);
      if (!t) throw err('not_found', 'template not found');
      const projectId = (a.projectId as string | null) ?? t.projectId;
      if (!projectId) throw err('validation', 'Project is required');
      const input: TaskInput = { name: t.name, projectId, description: resetSubtasks(t.description), continuedFrom: null, tags: t.tags.filter((id) => liveTag(s, id)) };
      return handle(s, 'create_task', { input });
    }
    case 'summary_preview': {
      const req = a.request as SummaryRequest;
      checkSummaryRequest(s, req);
      return summaryPreview(summaryInput(s), req);
    }
    case 'create_summary': {
      const req = a.request as SummaryRequest;
      checkSummaryRequest(s, req);
      const preview = summaryPreview(summaryInput(s), req);
      if (preview.rows.length === 0) throw err('validation', 'there is no unbilled time in that period');
      // The prefix is fixed by the first summary. The number is above every summary under it, voided or
      // restored away, and above the mark kept in the settings of this computer.
      const prefix = prefixOf(s);
      s.prefix = prefix;
      const number = Math.max(0, s.referenceMarks[prefix] ?? 0, ...s.summaries.filter((b) => b.prefix === prefix).map((b) => b.number)) + 1;
      const id = newId(s, 'summary');
      const reference = `${prefix}-${String(number).padStart(3, '0')}`;
      s.summaries.push({
        id, reference, prefix, number, deviceId: DEVICE_ID, projectId: req.projectId, from: req.from, to: req.to, zone: req.zone, createdAt: toIso(s.now),
        segmentIds: preview.segmentIds, pauseIds: preview.pauseIds, rows: preview.rows, totals: preview.totals, voided: false, stamp: stamp(s),
      });
      raiseReferenceMarks(s.referenceMarks, s.summaries);
      addAudit(s, 'summary', id, 'create', '', null, { reference });
      return { id, snapshot: snapshot(s) };
    }
    case 'void_summary': {
      const b = s.summaries.find((x) => x.id === a.id);
      if (!b) throw err('not_found', 'billing summary not found');
      // Voiding twice is a no-op, and writes no second entry in the history.
      if (!b.voided) {
        b.voided = true;
        addAudit(s, 'summary', b.id, 'void', '', { reference: b.reference }, null);
      }
      return snapshot(s);
    }
    case 'set_device_prefix': {
      const prefix = String(a.prefix ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{1,4}$/.test(prefix)) throw err('validation', 'a prefix is 1 to 4 letters or digits');
      s.prefix = prefix;
      return snapshot(s);
    }
    case 'export_summary_csv': {
      const b = s.summaries.find((x) => x.id === a.id);
      if (!b) throw err('not_found', 'billing summary not found');
      // Like the backend, what the file holds follows Hide earnings as it is when the file is written.
      s.summaryCsvFiles[b.id] = summaryCsv(b, s.projects.find((p) => p.id === b.projectId)?.name ?? '', s.hideEarnings);
      return `/mock/${b.reference}.csv`;
    }
    case 'export_pdf': {
      const req = a.request as PdfRequest;
      if (!isZone(req.zone)) throw err('validation', `unknown time zone: ${req.zone}`);
      checkSelection(s, req.selection, req.zone);
      s.pdfExports.push(req);
      // The bundled font covers Latin, Greek and Cyrillic. The title stands in for all the printed text.
      const unprintable = [...new Set([...req.title].filter((c) => /[\u0590-\u08ff\u3000-\u9fff\uac00-\ud7af]|\p{Extended_Pictographic}/u.test(c)))];
      return { path: `/mock/timesheet-${req.from}-to-${req.to}.pdf`, unprintable };
    }
    case 'revert_shift_version': {
      const v = s.shifts.find((x) => x.id === a.versionId && !x.deleted);
      if (!v) throw err('not_found', 'shift version not found');
      if (s.shifts.filter((x) => x.shiftId === v.shiftId && !x.deleted).length < 2) throw err('conflict', "this is the shift's only version; delete the shift instead");
      v.deleted = true;
      v.stamp = stamp(s);
      return snapshot(s);
    }
    case 'request_remote_pause': {
      const t = task(s, a.taskId as string);
      const open = s.segments.find((x) => x.taskId === t.id && isOpen(x) && x.deviceId !== DEVICE_ID);
      if (!open) throw err('conflict', "this task isn't running on another device");
      if (!s.pauseRequests.some((q) => q.segmentId === open.id)) {
        const id = newId(s, 'pausereq');
        s.pauseRequests.push({ id, taskId: t.id, segmentId: open.id, requestedBy: DEVICE_ID, at: toIso(s.now), stamp: stamp(s) });
        addAudit(s, 'task', t.id, 'requestPause', '', null, { segmentId: open.id, at: toIso(s.now) });
      }
      return snapshot(s);
    }
    case 'stash_draft':
      if (!docHasText(a.description as RichDoc) && a.description === undefined) throw err('validation', 'a draft needs a description');
      s.drafts[a.taskId as string] = a.description as RichDoc;
      return null;
    case 'clear_draft':
      delete s.drafts[a.taskId as string];
      return null;
    case 'keep_unsaved_words': {
      const words = [a.newName as string | null, a.description ? docPlainText(a.description as RichDoc) : null].filter((w) => w !== null).join('\n');
      s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'warning', message: `Your unsaved words on “${a.name as string}” were not saved, because the task no longer exists. Copy your words from here if you want them, as dismissing this notice ends them: ${words}` });
      delete s.drafts[a.taskId as string];
      return snapshot(s);
    }
    case 'set_setup_step':
      s.setupStep = Math.max(0, Math.trunc(a.step as number));
      return snapshot(s);
    case 'finish_setup':
      s.setupDone = true;
      s.syncPromptDone = true;
      s.clientZonePromptDone = true;
      return snapshot(s);
    case 'window_ready':
      return null;
    case 'pick_pdf_logo':
      s.hasPdfLogo = true;
      return snapshot(s);
    case 'clear_pdf_logo':
      s.hasPdfLogo = false;
      return snapshot(s);
    case 'list_backups':
      sortBackups(s);
      return s.backups.map((b) => ({ ...b }));
    case 'set_backup_keep': {
      const keep = a.keep as number;
      if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw err('validation', 'keep between 1 and 365 backups');
      s.backupKeep = keep;
      return snapshot(s);
    }
    case 'restore_backup': {
      const name = a.name as string;
      if (!s.backups.some((b) => b.name === name)) throw err('not_found', 'backup not found');
      const held = s.backupData[name];
      // A running task is closed first, like a quit, so the safety copy holds the data as it is now.
      closeAllAndPause(s, { kind: 'appQuit' });
      const safety = takeSafetyCopy(s);
      const { names, heartbeat } = installRestored(s, held, null);
      addAudit(s, 'backup', name, 'restore', '', null, { safetyCopy: safety });
      // The launch counts as cold afterwards.
      s.warm = false;
      s.lastWorked = null;
      s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'info', message: `Restored ${name}. The data just before it is kept as ${safety}.` });
      if (names.length > 0) {
        s.notices.push({
          id: `notice-${newId(s, 'n')}`,
          level: 'info',
          message: `${names.join(', ')} was running when this backup was taken. It is paused at the last moment the backup knows about (${heartbeat === null ? 'its start' : toIso(heartbeat)}).`,
        });
      }
      if (s.targets.length > 0) {
        s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'warning', message: 'Sync is on, so newer records in your sync folders will merge back in at the next sync.' });
      }
      return snapshot(s);
    }
    case 'snooze_reminder': {
      const minutes = Math.min(Math.max(Math.trunc(a.minutes as number), 1), 24 * 60);
      s.reminderQuietUntil = s.now + minutes * 60;
      return snapshot(s);
    }
    case 'get_audit': {
      const id = (a.entityId as string | null | undefined) ?? null;
      return s.audit
        .filter((e) => id === null || e.entityId === id)
        .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? -1 : 1));
    }
    default:
      return NOT_HANDLED;
  }
}

// ---- Who may change the data (the single-device lease), saved versions, the packaged build and Start with Windows.
// This models what a page can see of them, not the folders: `MockState.lease` is what the folders say when all can be read,
// and `leaseView` adds what the connected folders change. Rules, limits and words follow the backend's.

/** The other computer a seeded lease belongs to. */
export const OTHER_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_DEVICE_NAME = 'LAPTOP';

const OFF_LEASE: LeaseView = { state: 'off', readOnly: false, holder: null, generation: null, note: null, reachableRoots: [], unreachableRoots: [] };
/** The folder a seeded lease connects when none is. It is also the one `?sync=1` uses. */
const SEED_ROOT = 'C:\\Users\\me\\OneDrive';
const SEED_SECOND_ROOT = 'G:\\My Drive';

/** `CoreError::ReadOnly`: the code is `read_only`. */
export const readOnlyMessage = (holder: string): string => `${holder} is using zWorkTracker, so this computer is read-only. Take over from the banner to work here.`;

/** `Service::snapshot`: a packaged build with no folder keeps its only copy where uninstalling deletes it. */
export const PACKAGED_NO_FOLDER_WARNING =
  'This copy of zWorkTracker keeps its data in a private Windows folder. Uninstalling the app deletes that folder and your hours with it. Connect a OneDrive or Google Drive folder in Settings > Sync between devices.';

/**
 * The commands that change data shared between computers, or restore it. The backend refuses them while this computer is
 * read-only, and so does `handle`, before the command is looked at. `set_setting` is one of them, except for the two view
 * settings in `VIEW_SETTINGS`. Everything that only changes this computer's own preferences, folders or files is not, and
 * neither is `request_remote_pause`. `parity.test.ts` places every command in one list or the other, so a new one must be classified.
 */
export const READ_ONLY_BLOCKED: ReadonlySet<string> = new Set([
  'create_project', 'update_project', 'set_project_archived', 'delete_project',
  'create_task', 'update_task', 'patch_task', 'delete_draft', 'delete_task', 'start_task', 'resume_task', 'pause_task', 'stop_task',
  'save_shift', 'delete_shift', 'revert_shift_version', 'set_rate', 'delete_rate_version', 'set_rounding', 'delete_rounding', 'set_setting',
  'add_manual_entry', 'correct_segment', 'void_segment', 'restore_segment', 'settle_lost_segment',
  'decide_gap', 'mark_billable_pause', 'unmark_billable_pause', 'set_active_subtask', 'set_subtask_tags',
  'save_tag', 'delete_tag', 'save_template', 'delete_template', 'task_from_template',
  'create_summary', 'void_summary', 'set_device_prefix',
  'restore_backup', 'restore_version', 'save_version_now',
]);

/** Changing these is viewing, so a read-only computer may (`Service::set_setting`). */
const VIEW_SETTINGS: ReadonlySet<string> = new Set(['activeZone', 'showBoth']);

const holderWithAge = (s: MockState, h: LeaseHolderView): LeaseHolderView => ({ ...h, ageSecs: h.lastSignAt === null ? null : Math.max(0, s.now - parseIso(h.lastSignAt)) });

/**
 * What the page is told. With no sync folder connected it is `off`, which refuses nothing. A folder that can't be read
 * (`MockFolder.available`) is unreachable, and with none readable the lease is `unknown`: read-only only when another computer held it.
 */
export function leaseView(s: MockState): LeaseView {
  if (s.targets.length === 0) return structuredClone(OFF_LEASE);
  const readable = (root: string): boolean => folderOf(s, root).available;
  const reachableRoots = s.targets.map((t) => t.root).filter(readable);
  const unreachableRoots = s.targets.map((t) => t.root).filter((root) => !readable(root));
  let view: LeaseView = { ...s.lease, holder: s.lease.holder && holderWithAge(s, s.lease.holder), reachableRoots, unreachableRoots };
  // A folder is connected and nobody holds it.
  if (view.state === 'off') view = { ...view, state: 'free' };
  if (reachableRoots.length === 0 && view.state !== 'unknown') {
    const other = view.state === 'heldByOtherLive' || view.state === 'heldByOtherStale';
    // With no folder to read only the last holder's name, generation and time are known, not its beat.
    view = { ...view, state: 'unknown', readOnly: other, holder: other && view.holder ? { ...view.holder, beatSeq: 0 } : null };
  }
  return structuredClone(view);
}

const readOnlyRefusal = (s: MockState) => err('read_only', readOnlyMessage(leaseView(s).holder?.deviceName ?? 'Another computer'));

/**
 * Coherent lease states for tests and the e2e build (`?lease=`). A folder is connected first when none is. `live` and `stale` are
 * another computer holding the lease; `mine` is this one; `unknown` is every folder unreadable after another computer held it
 * (read-only), `unknown-writable` the same after nobody did. `holder` overrides what the seeded holder is like.
 */
export type LeaseSeed = 'checking' | 'free' | 'mine' | 'live' | 'stale' | 'unknown' | 'unknown-writable';
export const LEASE_SEEDS: readonly LeaseSeed[] = ['checking', 'free', 'mine', 'live', 'stale', 'unknown', 'unknown-writable'];
export const isLeaseSeed = (value: string): value is LeaseSeed => (LEASE_SEEDS as readonly string[]).includes(value);

export function seedLease(s: MockState, kind: LeaseSeed, holder: Partial<LeaseHolderView> = {}): void {
  if (s.targets.length === 0) handle(s, 'add_sync_target', { provider: 'oneDrive', root: SEED_ROOT });
  const quiet = kind === 'unknown' ? 2 * 3600 : kind === 'stale' ? 40 * 60 : 90;
  const other: LeaseHolderView = { deviceId: OTHER_DEVICE_ID, deviceName: OTHER_DEVICE_NAME, generation: 4, beatSeq: 83, lastSignAt: toIso(s.now - quiet), ageSecs: quiet, clockSuspect: false, ...holder };
  const lease = (state: LeaseView['state'], readOnly: boolean, who: LeaseHolderView | null, generation: number | null): LeaseView => ({ state, readOnly, holder: who, generation, note: null, reachableRoots: [], unreachableRoots: [] });
  switch (kind) {
    case 'checking':
      s.lease = lease('checking', false, null, null);
      break;
    case 'free':
    case 'unknown-writable':
      s.lease = lease('free', false, null, other.generation);
      break;
    case 'mine':
      s.lease = lease('heldByMe', false, null, other.generation + 1);
      break;
    case 'live':
    case 'unknown':
      s.lease = lease('heldByOtherLive', true, other, other.generation);
      break;
    case 'stale':
      s.lease = lease('heldByOtherStale', true, other, other.generation);
      break;
    default: {
      const unreachable: never = kind;
      throw new Error(`unknown lease seed ${String(unreachable)}`);
    }
  }
  // Every folder can be read, except for the two kinds whose point is that none can.
  const none = kind === 'unknown' || kind === 'unknown-writable';
  for (const t of s.targets) {
    const known = s.folders[t.root];
    if (none) s.folders[t.root] = { ...folderOf(s, t.root), available: false };
    else if (known && !known.available) s.folders[t.root] = { ...known, available: true };
  }
}

/**
 * Another computer takes the lease over while this one holds it: a running task closes now as `syncReconciled`, this computer is
 * read-only behind the new holder, and a notice says what happened (`Service::on_lease_lost`). Needs a connected folder.
 */
export function loseLease(s: MockState, by: Partial<LeaseHolderView> = {}): void {
  const holder: LeaseHolderView = { deviceId: OTHER_DEVICE_ID, deviceName: OTHER_DEVICE_NAME, generation: (s.lease.generation ?? 0) + 1, beatSeq: 1, lastSignAt: toIso(s.now), ageSecs: 0, clockSuspect: false, ...by };
  const running = s.tasks.filter((t) => t.state === 'running' && !t.runningElsewhere);
  const stopped = closeAllAndPause(s, { kind: 'syncReconciled' });
  s.lease = { state: 'heldByOtherLive', readOnly: true, holder, generation: holder.generation, note: null, reachableRoots: [], unreachableRoots: [] };
  addAudit(s, 'lease', holder.deviceId, 'leaseLost', '', null, { by: holder.deviceName, generation: holder.generation, closed: running.map((t) => t.id) });
  const timer = stopped[0] === undefined ? '' : ` "${stopped[0]}" stopped timing here at ${clockAt(s.now, s.systemZone)}.`;
  s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'warning', message: `${holder.deviceName} took over, so this computer is now read-only.${timer} Nothing was lost: it will sync.` });
}

// ---- Take over (`lease_io::take_over`): the page shows a preview, asks twice, and the backend reads again before it acts.

/** `end_of` for another device's open segment: its last heartbeat, else its start, and nothing after a pause request. */
function lastKnownEnd(s: MockState, seg: MockSegment): number {
  const start = parseIso(seg.start);
  const beat = seg.provisionalEnd ? parseIso(seg.provisionalEnd) : start;
  return Math.min(Math.max(capAtPauseRequest(beat, seg, s.pauseRequests, DEVICE_ID), start), s.now);
}

/** The holder's open segments with the end a take over gives each: the later of what its device last reported and the holder's last sign, but never after a pause request. */
function holderOpenSegments(s: MockState, holder: LeaseHolderView): { seg: MockSegment; end: number }[] {
  const out: { seg: MockSegment; end: number }[] = [];
  for (const seg of s.segments) {
    if (!isOpen(seg) || seg.deviceId !== holder.deviceId) continue;
    const start = parseIso(seg.start);
    const asked = Math.min(Infinity, ...s.pauseRequests.filter((q) => q.segmentId === seg.id).map((q) => parseIso(q.at)));
    const beat = holder.clockSuspect || holder.lastSignAt === null ? -Infinity : parseIso(holder.lastSignAt);
    out.push({ seg, end: Math.max(Math.min(Math.max(lastKnownEnd(s, seg), Math.min(beat, asked)), s.now), start) });
  }
  return out;
}

function takeOverPreview(s: MockState): TakeOverPreview {
  const view = leaseView(s);
  const other = view.state === 'heldByOtherLive' || view.state === 'heldByOtherStale';
  const segments = view.holder && other ? holderOpenSegments(s, view.holder) : [];
  return {
    holder: view.holder,
    live: view.state === 'heldByOtherLive',
    unreachable: s.targets.length > 0 && view.reachableRoots.length === 0,
    segments: segments.map(({ seg, end }) => ({ segmentId: seg.id, taskName: s.tasks.find((t) => t.id === seg.taskId)?.name ?? '', end: toIso(end), secs: end - parseIso(seg.start) })),
  };
}

/** The task has no open segment left anywhere, so it is no longer running on another computer. */
function endRunningElsewhere(s: MockState, taskId: string): void {
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t || s.segments.some((x) => x.taskId === taskId && isOpen(x))) return;
  t.runningElsewhere = null;
  if (t.state === 'running') setState(t, 'paused', { kind: 'syncReconciled' });
}

function leaseTakeOver(s: MockState, expected: TakeOverExpected | undefined, mode: TakeOverMode): TakeOverResult {
  if (!expected || typeof expected.generation !== 'number' || typeof expected.beatSeq !== 'number') throw err('validation', 'say which holder this take over was shown');
  if (mode !== 'stale' && mode !== 'live' && mode !== 'offline') throw err('validation', 'the mode must be stale, live or offline');
  const forced = s.takeOverNext;
  s.takeOverNext = undefined;
  const result = (outcome: TakeOverResult['outcome'], preview: TakeOverPreview | null): TakeOverResult => ({ outcome, preview, snapshot: snapshot(s) });
  const view = leaseView(s);

  if (forced === 'unreachable') return result('unreachable', null);
  if (forced === 'changed') {
    // The holder came back to life while the dialog was open.
    if (s.lease.holder) s.lease = { ...s.lease, state: 'heldByOtherLive', readOnly: true, holder: { ...s.lease.holder, beatSeq: s.lease.holder.beatSeq + 1, lastSignAt: toIso(s.now) } };
    return result('changed', takeOverPreview(s));
  }
  if (forced === undefined) {
    if (mode !== 'offline' && s.targets.length > 0 && view.reachableRoots.length === 0) return result('unreachable', null);
    // The double check: the holder must still be the one the dialog showed.
    const top = view.holder;
    if (mode !== 'offline' && (!top || top.generation !== expected.generation || top.beatSeq !== expected.beatSeq)) return result('changed', takeOverPreview(s));
  }

  const holder = view.holder;
  if (mode === 'offline') {
    // Only a claim for now: nothing is settled until a folder comes back, and then only if nobody else took over meanwhile.
    s.lease = { state: 'heldByMe', readOnly: false, holder: null, generation: expected.generation + 1, note: null, reachableRoots: [], unreachableRoots: [] };
    return result('done', null);
  }
  const closed = holder ? settleHolderSegments(s, holder) : 0;
  s.lease = { state: 'heldByMe', readOnly: false, holder: null, generation: (holder?.generation ?? view.generation ?? 0) + 1, note: null, reachableRoots: [], unreachableRoots: [] };
  const tasks = closed === 0 ? '' : closed === 1 ? ' 1 running task was closed at its last known time.' : ` ${closed} running tasks were closed at their last known time.`;
  s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'info', message: `You took over from ${holder?.deviceName ?? 'the other computer'}.${tasks}` });
  return result('done', null);
}

/** `finish_take_over`: each open segment of the old holder gets a recorded end (raw times stay) and the audit trail says why. Returns how many. */
function settleHolderSegments(s: MockState, holder: LeaseHolderView): number {
  const reason = `Closed from ${OWN_DEVICE}: ${holder.deviceName} stopped responding. Ended at its last known moment.`;
  const open = holderOpenSegments(s, holder);
  for (const { seg, end } of open) {
    applyEdit(s, seg, { start: seg.start, end: toIso(end), voided: false, reason }, 'settleLost', reason);
    endRunningElsewhere(s, seg.taskId);
  }
  return open.length;
}

/**
 * `lease_io::release_now` ("Release now"): this computer lets go and keeps the generation it held. A computer that holds nothing has
 * nothing to do. A timer running here keeps it in use, and with no folder to write the release into it still holds the lease: both
 * are refused as the backend words them, in that order.
 */
function leaseRelease(s: MockState): Snapshot {
  if (s.lease.state !== 'heldByMe') return snapshot(s);
  if (s.segments.some((x) => x.deviceId === DEVICE_ID && isOpen(x))) throw err('conflict', 'a task is running here, so this computer is still in use. Pause it first.');
  if (leaseView(s).reachableRoots.length === 0) throw err('conflict', 'no sync folder could be written just now, so this computer still holds it. Try again when a folder can be reached.');
  s.lease = { ...s.lease, state: 'free', holder: null };
  return snapshot(s);
}

/** `lease::LOST_DEVICE_SILENCE_SECS`: how long another computer must have said nothing before its open segment can be closed without a pause request. */
const LOST_DEVICE_SILENCE_SECS = 86_400;

/** `service::span_text`: a length of time to the minute, as a refusal words it ("1 h 30 min", "less than a minute"). */
function spanText(secs: number): string {
  const minutes = Math.floor(Math.max(0, secs) / 60);
  const days = Math.floor(minutes / 1440);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return rest === 0 ? 'less than a minute' : `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * `Service::settle_lost_segment`: the fallback with no take over. Needs a pause request, or a computer that has written nothing for a
 * day (measured from its file's `written_at`, else from the segment's start). A blank reason takes the default text. Never automatic.
 */
function settleLostSegment(s: MockState, segmentId: string, why: string): Snapshot {
  const seg = s.segments.find((x) => x.id === segmentId);
  if (!seg) throw err('not_found', 'work segment not found');
  if (!isOpen(seg) || seg.deviceId === DEVICE_ID) throw err('conflict', "this segment isn't running on another computer");
  const known = s.remoteDevices?.[seg.deviceId];
  const owner = task(s, seg.taskId);
  // The backend says "another device" for one it has never read a file from. A task card names the computer it runs on, so that name does too.
  const name = known?.name ?? owner.runningElsewhere ?? 'another device';
  const silent = s.now - parseIso(known ? known.writtenAt : seg.start);
  if (!s.pauseRequests.some((q) => q.segmentId === seg.id) && silent < LOST_DEVICE_SILENCE_SECS) {
    throw err('conflict', `${name} was seen ${spanText(silent)} ago, so it may still be running this`);
  }
  const reason = cleanReason(why) || `Closed from ${OWN_DEVICE}: ${name} stopped responding. Ended at its last known moment.`;
  applyEdit(s, seg, { start: seg.start, end: toIso(lastKnownEnd(s, seg)), voided: false, reason }, 'settleLost', reason);
  endRunningElsewhere(s, seg.taskId);
  return snapshot(s);
}

// ---- Saved versions (`versions.rs`). Names, reasons and words follow the backend.

const VERSION_NAME = /^\d{8}T\d{6}Z--[0-9a-f]{8}--(auto|quit|manual|takeover|pre-restore|pre-adopt|restored)$/;
/** Kept for a year whatever the retention rule says. */
const PINNED_REASONS: ReadonlySet<string> = new Set(['takeover', 'pre-restore', 'pre-adopt', 'restored']);
const VERSION_BUDGET_BYTES = 1024 ** 3;
const REASON_WORDS: Record<string, string> = {
  auto: 'automatic hourly copy',
  quit: 'copy when the app was closed',
  manual: 'saved by hand',
  takeover: 'copy when a computer took over',
  'pre-restore': 'copy of the data before a restore',
  'pre-adopt': 'copy of the data before following a restore',
  restored: 'copy of the restored data',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 Nov 2026, 14:25 UTC", the way a change record dates a version. */
function utcLabel(iso: string): string {
  const d = new Date(iso);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** A `.changes.txt` in the shape of the backend's, with the counts of the data as it is now and whatever lines `done` adds. */
function changesText(s: MockState, takenAt: string, reason: string, deviceName: string, done: string[] = []): string {
  const lines = [
    `zWorkTracker version saved ${utcLabel(takenAt)}`,
    `Saved by ${deviceName} (app mock). Reason: ${REASON_WORDS[reason] ?? reason}.`,
    '',
    `Now: ${s.projects.length} projects, ${s.tasks.length} tasks, ${s.segments.length} time segments.`,
  ];
  if (done.length > 0) lines.push('', 'What was done, from the audit trail:', ...done);
  return lines.join('\n');
}

/** `20261102T142530Z--a1b2c3d4--auto`: the writer's UTC time, the first 8 digits of its device id, and the reason. */
export const versionName = (takenAt: string, deviceId: string, reason: string): string => `${takenAt.replace(/[-:]/g, '')}--${deviceId.slice(0, 8)}--${reason}`;

export interface NewVersion {
  takenAt: string;
  /** The reason code. Defaults to `auto`. */
  reason?: string;
  /** Defaults to this computer. */
  deviceName?: string;
  deviceId?: string;
  /** The folders holding a copy. Defaults to every connected one. */
  roots?: string[];
  /** Bytes of each copy. */
  bytes?: number;
  changes?: string;
  data?: string;
  counts?: DataCounts;
  failRead?: MockVersion['failRead'];
  warnings?: string[];
  blockedReason?: string | null;
  pinned?: boolean;
}

/** Adds a saved version, or replaces the one of the same name, like writing the same file again. Returns it. */
export function addVersion(s: MockState, o: NewVersion): MockVersion {
  const reason = o.reason ?? 'auto';
  const deviceName = o.deviceName ?? OWN_DEVICE;
  const deviceId = o.deviceId ?? (deviceName === OWN_DEVICE ? DEVICE_ID : OTHER_DEVICE_ID);
  const roots = o.roots ?? s.targets.map((t) => t.root);
  const bytes = o.bytes ?? (o.data ? Math.ceil(o.data.length / 8) : 150_000);
  const v: MockVersion = {
    name: versionName(o.takenAt, deviceId, reason),
    takenAt: o.takenAt,
    deviceName,
    reason,
    pinned: o.pinned ?? PINNED_REASONS.has(reason),
    locations: roots.map((root) => ({ root, provider: s.targets.find((t) => t.root === root)?.provider ?? 'custom', bytes })),
    changes: o.changes ?? changesText(s, o.takenAt, reason, deviceName),
    data: o.data,
    counts: o.counts,
    failRead: o.failRead,
    warnings: o.warnings,
    blockedReason: o.blockedReason,
  };
  s.versions = [...s.versions.filter((x) => x.name !== v.name), v];
  return v;
}

/**
 * Two connected folders (OneDrive and Google Drive) holding seven versions between them, for the e2e build (`?versions=1`):
 * a copy only one folder has, one that is pinned, and one whose Google Drive copy can't be read, so the page's fallback shows.
 */
export function seedVersions(s: MockState): void {
  for (const [provider, root] of [['oneDrive', SEED_ROOT], ['googleDrive', SEED_SECOND_ROOT]] as const) {
    if (!s.targets.some((t) => t.root === root)) handle(s, 'add_sync_target', { provider, root });
  }
  s.detected = s.detected.filter((d) => !s.targets.some((t) => t.root === d.root));
  const ago = (secs: number): string => toIso(s.now - secs);
  const both = [SEED_ROOT, SEED_SECOND_ROOT];
  const first = ago(55 * 60);
  addVersion(s, {
    takenAt: first,
    roots: both,
    bytes: 182_400,
    counts: { projects: 4, tasks: 6, segments: 118 },
    changes: changesText(s, first, 'auto', OWN_DEVICE, [`${clockAt(s.now - 40 * 60, 'UTC')}  ${OWN_DEVICE}  corrected a time segment on "Logo concepts": 09:00-10:00 became 09:10-10:00. Reason: started late`]),
  });
  addVersion(s, { takenAt: ago(5 * 3600), reason: 'quit', deviceName: OTHER_DEVICE_NAME, roots: both, bytes: 181_000, counts: { projects: 4, tasks: 6, segments: 112 } });
  addVersion(s, { takenAt: ago(26 * 3600), reason: 'manual', roots: [SEED_ROOT], bytes: 176_500, counts: { projects: 4, tasks: 5, segments: 104 } });
  addVersion(s, { takenAt: ago(9 * 86_400), reason: 'pre-restore', roots: both, bytes: 160_200, counts: { projects: 3, tasks: 5, segments: 90 } });
  addVersion(s, { takenAt: ago(20 * 86_400), deviceName: OTHER_DEVICE_NAME, roots: [SEED_SECOND_ROOT], bytes: 140_800, counts: { projects: 3, tasks: 4, segments: 71 } });
  addVersion(s, { takenAt: ago(40 * 86_400), roots: both, bytes: 120_300, counts: { projects: 2, tasks: 3, segments: 40 }, failRead: [SEED_SECOND_ROOT] });
  addVersion(s, { takenAt: ago(75 * 86_400), reason: 'takeover', deviceName: OTHER_DEVICE_NAME, roots: [SEED_ROOT], bytes: 90_000, counts: { projects: 1, tasks: 2, segments: 12 } });
}

function listVersions(s: MockState, extraRoot: string | null): VersionList {
  const roots = s.targets.map((t) => t.root);
  if (extraRoot !== null && !roots.includes(extraRoot)) roots.push(extraRoot);
  const readable = new Set(roots.filter((root) => folderOf(s, root).available));
  const errors = roots.filter((root) => !readable.has(root)).map((root) => ({ root, message: FOLDER_NOT_FOUND }));
  const versions: VersionInfo[] = s.versions
    .map((v) => ({ v, locations: v.locations.filter((l) => readable.has(l.root)) }))
    .filter(({ locations }) => locations.length > 0)
    .map(({ v, locations }) => ({ name: v.name, takenAt: v.takenAt, deviceName: v.deviceName, reason: v.reason, pinned: v.pinned, locations: locations.map((l) => ({ ...l })) }))
    .sort((x, y) => (x.takenAt < y.takenAt ? 1 : x.takenAt > y.takenAt ? -1 : x.name < y.name ? 1 : -1));
  const totalBytes = versions.reduce((sum, v) => sum + v.locations.reduce((n, l) => n + l.bytes, 0), 0);
  return { versions, errors, totalBytes, overBudget: totalBytes > VERSION_BUDGET_BYTES };
}

/** The version as one folder holds it, or the backend's refusal: not a version name, not there, folder unreadable, or a copy that is still syncing. */
function readableVersion(s: MockState, root: string, name: string): MockVersion {
  if (!VERSION_NAME.test(name)) throw err('validation', 'that is not the name of a saved version');
  const v = s.versions.find((x) => x.name === name && x.locations.some((l) => l.root === root));
  if (!v) throw err('not_found', 'version not found');
  if (!folderOf(s, root).available) throw err('io', FOLDER_NOT_FOUND);
  if (v.failRead === true || (Array.isArray(v.failRead) && v.failRead.includes(root))) throw err('io', `${name}.json.gz can't be read in ${root}: it may still be syncing`);
  return v;
}

function versionCounts(v: MockVersion): DataCounts {
  if (v.data) {
    // Written by `captureData`, so these keys are there.
    const held = JSON.parse(v.data) as Partial<Record<'projects' | 'tasks' | 'segments', unknown[]>>;
    return { projects: held.projects?.length ?? 0, tasks: held.tasks?.length ?? 0, segments: held.segments?.length ?? 0 };
  }
  return v.counts ?? { ...NO_COUNTS };
}

function previewRestore(s: MockState, root: string, name: string): RestorePreview {
  const v = readableVersion(s, root, name);
  return {
    name: v.name,
    takenAt: v.takenAt,
    reason: v.reason,
    version: versionCounts(v),
    current: localCounts(s),
    warnings: [...(v.warnings ?? [])],
    blockedReason: leaseView(s).readOnly ? 'Take over first to restore.' : (v.blockedReason ?? null),
  };
}

function saveVersionNow(s: MockState): Snapshot {
  if (s.targets.length === 0) throw err('conflict', 'Connect a sync folder first: versions are saved there.');
  const roots = s.targets.map((t) => t.root).filter((root) => folderOf(s, root).available);
  if (roots.length === 0) throw err('io', "Couldn't save a version: no sync folder could be written.");
  addVersion(s, { takenAt: toIso(s.now), reason: 'manual', roots, data: captureData(s) });
  return snapshot(s);
}

function restoreVersion(s: MockState, root: string, name: string): Snapshot {
  const v = readableVersion(s, root, name);
  const writable = s.targets.map((t) => t.root).filter((r) => folderOf(s, r).available);
  if (s.targets.length > 0 && writable.length === 0) throw err('conflict', "Couldn't save a copy of today's data to any folder first, so nothing was changed.");
  // A running task is closed first, like a quit, so the copies hold the data as it is now.
  closeAllAndPause(s, { kind: 'appQuit' });
  const before = writable.length > 0 ? addVersion(s, { takenAt: toIso(s.now), reason: 'pre-restore', roots: writable, data: captureData(s) }) : null;
  const safety = takeSafetyCopy(s);
  const { names, heartbeat } = installRestored(s, v.data, parseIso(v.takenAt));
  addAudit(s, 'version', name, 'restore', '', null, { safetyCopy: safety, preRestore: before?.name ?? null });
  // The launch counts as cold afterwards.
  s.warm = false;
  s.lastWorked = null;
  const kept = before ? `${safety} and as the version ${before.name}` : safety;
  s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'info', message: `Restored the version from ${utcLabel(v.takenAt)}. The data just before it is kept as ${kept}.` });
  if (names.length > 0) {
    s.notices.push({
      id: `notice-${newId(s, 'n')}`,
      level: 'info',
      message: `${names.join(', ')} was running when this version was saved. It is paused at the last moment the version knows about (${heartbeat === null ? 'its start' : toIso(heartbeat)}).`,
    });
  }
  return snapshot(s);
}

function resolveJoin(s: MockState, root: string, choice: JoinChoice): Snapshot {
  if (choice !== 'follow' && choice !== 'keep') throw err('validation', 'the choice must be follow or keep');
  const waiting = s.joinPending;
  if (!waiting || waiting.root !== root) throw err('conflict', 'that folder is not waiting for a choice');
  // As in Rust: Keep makes a new restore, so it is refused while another computer is making changes. Follow is allowed.
  if (choice === 'keep' && leaseView(s).readOnly) throw readOnlyRefusal(s);
  s.joinPending = null;
  let message = `Kept this computer's data together with the version restored on ${waiting.deviceName}. Rolled-back items may return on every computer.`;
  if (choice === 'follow') {
    // The mock has no restored data in the folder to adopt, so it makes the two copies that come with following, and says so.
    const safety = takeSafetyCopy(s);
    const roots = s.targets.map((t) => t.root).filter((root) => folderOf(s, root).available);
    const before = roots.length > 0 ? addVersion(s, { takenAt: toIso(s.now), reason: 'pre-adopt', roots, data: captureData(s) }) : null;
    message = `${waiting.deviceName} restored the version from ${utcLabel(waiting.at)}. This computer now follows it. What was here before is kept in ${safety}${before ? ` and in the version ${before.name}` : ''}.`;
  }
  s.notices.push({ id: `notice-${newId(s, 'n')}`, level: 'info', message });
  return snapshot(s);
}

/**
 * A folder whose data was restored on the other computer while this one has data from before it, waiting for the user's choice.
 * By default the first connected folder (one is connected when none is). `root` is the folder as given, which need not be connected:
 * a move into a folder past a restore leaves the question on the destination (`restores_before_move`), and the answer is taken for
 * such a root too (`join_folder` skips a root that is not a sync target).
 */
export function seedJoinPending(s: MockState, options: { root?: string } = {}): void {
  if (s.targets.length === 0) handle(s, 'add_sync_target', { provider: 'oneDrive', root: SEED_ROOT });
  const root = options.root ?? s.targets[0]?.root ?? SEED_ROOT;
  const taken = toIso(s.now - 3 * 86_400);
  s.joinPending = { root, takenFrom: versionName(taken, OTHER_DEVICE_ID, 'auto'), at: taken, deviceName: OTHER_DEVICE_NAME };
}

// ---- Start with Windows (`get_autostart_info`). A packaged build asks Windows, which can refuse.

const AUTOSTART_NOTES: Record<AutostartState, string | null> = {
  on: null,
  off: null,
  offByUser: 'You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.',
  offByPolicy: "A policy on this computer doesn't allow this, or the device doesn't support it.",
  onByPolicy: 'A policy on this computer keeps this on.',
  unavailable: "Windows couldn't find this app's startup entry.",
};

/** The whole answer for a state, as the backend words it. */
export function autostartFor(state: AutostartState, packaged = true): AutostartInfo {
  return { packaged, state, canChange: state === 'on' || state === 'off', note: AUTOSTART_NOTES[state] };
}

export const isAutostartState = (value: string): value is AutostartState => Object.hasOwn(AUTOSTART_NOTES, value);

const autostartIsOn = (state: AutostartState): boolean => state === 'on' || state === 'onByPolicy';

/** `on` and `off` follow `MockState.autostart`, which the setup wizard's switch has always used. */
function autostartView(s: MockState): AutostartInfo {
  const kept = s.autostartInfo.state;
  return autostartFor(kept === 'on' || kept === 'off' ? (s.autostart ? 'on' : 'off') : kept, s.packaged);
}

function setAutostart(s: MockState, enabled: boolean): boolean {
  const { state } = autostartView(s);
  // Windows has the last word: a switch it won't move is an error with its reason, never a quiet no-op.
  if (state === 'unavailable' || (enabled && (state === 'offByUser' || state === 'offByPolicy')) || (!enabled && state === 'onByPolicy')) {
    throw err('autostart', AUTOSTART_NOTES[state] ?? '');
  }
  if (state === 'on' || state === 'off') s.autostart = enabled;
  return autostartIsOn(autostartView(s).state);
}

function leaseCommands(s: MockState, cmd: string, a: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'lease_preview_take_over':
      return takeOverPreview(s);
    case 'lease_take_over':
      return leaseTakeOver(s, a.expected as TakeOverExpected | undefined, a.mode as TakeOverMode);
    case 'lease_release':
      return leaseRelease(s);
    case 'settle_lost_segment':
      return settleLostSegment(s, a.segmentId as string, a.reason as string);
    case 'list_versions':
      return listVersions(s, (a.extraRoot as string | null | undefined) ?? null);
    case 'read_version_changes':
      return readableVersion(s, a.root as string, a.name as string).changes;
    case 'save_version_now':
      return saveVersionNow(s);
    case 'preview_restore_version':
      return previewRestore(s, a.root as string, a.name as string);
    case 'restore_version':
      return restoreVersion(s, a.root as string, a.name as string);
    case 'resolve_join':
      return resolveJoin(s, a.root as string, a.choice as JoinChoice);
    case 'get_autostart_info':
      return autostartView(s);
    case 'open_startup_settings':
      return null;
    default:
      return NOT_HANDLED;
  }
}

/**
 * Every command goes through here. While this computer is read-only the commands in `READ_ONLY_BLOCKED` are refused with the
 * backend's `read_only` error before anything else is looked at, so a refused command changes nothing.
 */
export function handle(s: MockState, cmd: string, a: Record<string, unknown>): unknown {
  if (READ_ONLY_BLOCKED.has(cmd) && !(cmd === 'set_setting' && VIEW_SETTINGS.has(String(a.key))) && leaseView(s).readOnly) throw readOnlyRefusal(s);
  return dispatch(s, cmd, a);
}

function dispatch(s: MockState, cmd: string, a: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'get_snapshot':
      return snapshot(s, true);
    case 'create_project': {
      const input = cleanProject(s, a.input as ProjectInput, null);
      const { color, replacedFrom } = resolveColor(s, input.color, s.projects.filter((p) => !p.archived).map((p) => p.color), false);
      const id = newId(s, 'project');
      s.projects.push({ id, ...input, color, archived: false, createdAt: toIso(s.now) });
      return { id, snapshot: snapshot(s), color, replacedFrom };
    }
    case 'update_project': {
      const input = cleanProject(s, a.input as ProjectInput, a.id as string);
      const p = s.projects.find((x) => x.id === a.id);
      if (!p) throw err('not_found', 'project not found');
      const taken = s.projects.filter((x) => !x.archived && x.id !== p.id).map((x) => x.color);
      const { color, replacedFrom } = resolveColor(s, input.color, taken, p.color.toLowerCase() === input.color.toLowerCase());
      Object.assign(p, input, { color });
      return { id: p.id, snapshot: snapshot(s), color, replacedFrom };
    }
    case 'set_project_archived': {
      const p = s.projects.find((x) => x.id === a.id);
      if (!p) throw err('not_found', 'project not found');
      if (a.archived && s.tasks.some((t) => t.projectId === p.id && t.state === 'running')) {
        throw err('conflict', "pause or stop this project's running task before archiving it");
      }
      p.archived = a.archived as boolean;
      return snapshot(s);
    }
    case 'delete_project': {
      if (s.tasks.some((t) => t.projectId === a.id)) throw err('conflict', 'a project with tasks can only be archived');
      // A summary outlives the tasks it lists, voided or not, and it names its project.
      if (s.summaries.some((b) => b.projectId === a.id)) throw err('conflict', 'a project with billing summaries can only be archived');
      s.projects = s.projects.filter((p) => p.id !== a.id);
      return snapshot(s);
    }
    case 'create_task': {
      const input = a.input as TaskInput;
      const name = cleanTaskName(input.name);
      if (!input.projectId) throw err('validation', 'Project is required');
      if (!s.projects.some((p) => p.id === input.projectId)) throw err('not_found', 'project not found');
      checkTagIds(s, input.tags ?? []);
      const id = newId(s, 'task');
      s.tasks.push({
        id, name, projectId: input.projectId, description: assignSubtaskIds(input.description, undefined, () => newId(s, 'sub')), state: 'draft',
        pauseReason: null, createdAt: toIso(s.now), stoppedAt: null, runningElsewhere: null,
        continuedFrom: input.continuedFrom ?? null, tags: input.tags ?? [], activeSubtask: null,
      });
      return { id, snapshot: snapshot(s) };
    }
    case 'update_task': {
      const input = a.input as TaskInput;
      const name = cleanTaskName(input.name);
      checkTagIds(s, input.tags ?? []);
      const t = task(s, a.id as string);
      t.name = name;
      t.projectId = input.projectId;
      t.description = assignSubtaskIds(input.description, t.description, () => newId(s, 'sub'));
      clearMissingActive(t);
      // Like the backend, an empty list here leaves the tags alone; clearing goes through patch_task.
      if (input.tags && input.tags.length > 0 && !sameTagList(t.tags ?? [], input.tags)) {
        t.tags = input.tags;
        pruneSubtaskTags(s, t);
      }
      return snapshot(s);
    }
    case 'patch_task': {
      const patch = a.patch as TaskPatch;
      const expected = (a.expected ?? {}) as TaskExpected;
      const t = task(s, a.id as string);
      // Like the backend: a field with an expected value goes only if the store still holds that value, or already
      // holds what is being saved. A refused value isn't validated: it is going nowhere.
      const conflicts: PatchReply['conflicts'] = [];
      const refuse = (field: PatchReply['conflicts'][number], moved: boolean, already: boolean): boolean => {
        if (!moved || already) return false;
        conflicts.push(field);
        return true;
      };
      const name = patch.name === undefined || refuse('name', expected.name !== undefined && expected.name !== t.name, patch.name.trim() === t.name) ? undefined : cleanTaskName(patch.name);
      const projectId = patch.projectId === undefined || refuse('project', expected.projectId !== undefined && expected.projectId !== t.projectId, patch.projectId === t.projectId) ? undefined : patch.projectId;
      const description =
        patch.description === undefined || refuse('description', expected.description !== undefined && !sameJson(expected.description, t.description), sameJson(assignSubtaskIds(patch.description, t.description, () => 'new'), t.description))
          ? undefined
          : patch.description;
      const tags = patch.tags === undefined || refuse('tags', expected.tags !== undefined && !sameTags(expected.tags, t.tags ?? []), sameTags(patch.tags, t.tags ?? [])) ? undefined : patch.tags;
      if (tags !== undefined) checkTagIds(s, tags);
      if (projectId !== undefined && projectId !== t.projectId) {
        const project = s.projects.find((p) => p.id === projectId);
        if (!project) throw err('not_found', 'project not found');
        if (project.archived) throw err('validation', 'this project is archived; restore it first');
        t.projectId = projectId;
      }
      if (name !== undefined) t.name = name;
      if (description !== undefined) {
        t.description = assignSubtaskIds(description, t.description, () => newId(s, 'sub'));
        clearMissingActive(t);
      }
      if (tags !== undefined && !sameTagList(t.tags ?? [], tags)) {
        t.tags = tags;
        pruneSubtaskTags(s, t);
      }
      const reply: PatchReply = { snapshot: snapshot(s), conflicts, stored: { name: t.name, projectId: t.projectId, description: t.description, tags: t.tags ?? [] } };
      return reply;
    }
    case 'delete_draft': {
      if (task(s, a.id as string).state !== 'draft') throw err('conflict', 'only a draft can be deleted');
      s.tasks = s.tasks.filter((t) => t.id !== a.id);
      return snapshot(s);
    }
    case 'delete_task':
      deleteTask(s, a.id as string);
      return snapshot(s);
    case 'start_task':
      return begin(s, a.id as string, 'draft', 'start');
    case 'resume_task':
      if (!s.warm) throw err('cold_start_required', 'this launch has not started a task yet, so continuing needs every field filled in again');
      return begin(s, a.id as string, 'paused', 'resume');
    case 'pause_task': {
      const t = task(s, a.id as string);
      if (t.state !== 'running') throw err('illegal_transition', `cannot pause a task that is ${t.state}`);
      if (t.runningElsewhere) throw err('running_elsewhere', `this task is running on another device (${t.runningElsewhere}); pause it there`);
      closeOwn(s, t.id);
      setState(t, 'paused', { kind: 'user' });
      return snapshot(s);
    }
    case 'stop_task': {
      const t = task(s, a.id as string);
      if (t.state !== 'running' && t.state !== 'paused') throw err('illegal_transition', `cannot stop a task that is ${t.state}`);
      closeOwn(s, t.id);
      setState(t, 'stopped', null);
      t.stoppedAt = toIso(s.now);
      return snapshot(s);
    }
    case 'save_shift': {
      const input = a.input as ShiftInput;
      if (!input.name.trim()) throw err('validation', 'Shift name is required');
      if (!input.weekdays.length && !input.retired) throw err('validation', 'choose at least one weekday');
      const shiftId = input.shiftId || newId(s, 'shift');
      const existing = s.shifts.find((v) => v.shiftId === shiftId && v.effectiveFrom === input.effectiveFrom && !v.deleted);
      const version: ShiftVersion = {
        id: existing?.id ?? newId(s, 'shiftv'),
        shiftId,
        effectiveFrom: input.effectiveFrom,
        name: input.name.trim(),
        color: input.color,
        start: input.start,
        end: input.end,
        weekdays: [...new Set(input.weekdays)].sort(),
        zone: input.zone,
        breakMinutes: input.breakMinutes,
        retired: input.retired ?? false,
        deleted: false,
        stamp: stamp(s),
      };
      s.shifts = s.shifts.filter((v) => v.id !== version.id).concat(version);
      return { id: shiftId, snapshot: snapshot(s) };
    }
    case 'delete_shift':
      for (const v of s.shifts) if (v.shiftId === a.shiftId) v.deleted = true;
      return snapshot(s);
    case 'set_rate': {
      // machine.rs `set_rate`, in its order: the project, then the date (readable, within the limits), then the confirmation of a
      // backdated price, and only then the price and its currency. A project keeps one live version per instant: setting that instant
      // again changes that version, and a version taken away stays a tombstone.
      const input = a.input as RateInput;
      if (!s.projects.some((p) => p.id === input.projectId)) throw err('not_found', 'project not found');
      const from = input.effectiveFrom ? parseIso(input.effectiveFrom) : s.now;
      if (Number.isNaN(from)) throw err('validation', 'invalid effective date');
      checkChosenDate(from, "the price's start date");
      if (from < s.now && !input.confirmRetroactive) throw err('conflict', 'a backdated price changes past earnings and needs confirmation');
      if (!isCurrency(input.currency)) throw err('validation', 'currency must be EUR or USD');
      if (input.rateCents !== null && (input.rateCents < 0 || input.rateCents > 1_000_000)) throw err('validation', 'price per hour must be between 0 and 10000.00');
      const same = s.rates.find((r) => r.projectId === input.projectId && !r.deleted && parseIso(r.effectiveFrom) === from);
      const version = { id: same?.id ?? newId(s, 'rate'), projectId: input.projectId, effectiveFrom: toIso(from), rateCents: input.rateCents, currency: input.currency, deleted: false, stamp: stamp(s) };
      s.rates = same ? s.rates.map((r) => (r === same ? version : r)) : [...s.rates, version];
      s.lastCurrency = input.currency;
      return snapshot(s);
    }
    case 'delete_rate_version': {
      // machine.rs: a version that has started changes past earnings, so it needs the same confirmation as a backdated one. The tombstone stays, as sync needs it.
      const v = s.rates.find((r) => r.id === a.id && !r.deleted);
      if (!v) throw err('not_found', 'price version not found');
      if (parseIso(v.effectiveFrom) < s.now && !a.confirmRetroactive) throw err('conflict', 'taking away a price that has started changes past earnings and needs confirmation');
      v.deleted = true;
      v.stamp = stamp(s);
      addAudit(s, 'price', v.id, 'removed', '', { projectId: v.projectId, effectiveFrom: v.effectiveFrom, rateCents: v.rateCents, currency: v.currency }, null);
      return snapshot(s);
    }
    case 'set_rounding': {
      const input = a.input as RoundingInput;
      if (input.effectiveFrom < (a.today as string) && !input.confirmRetroactive) {
        throw err('conflict', 'a backdated increment changes past reported figures and needs confirmation');
      }
      const projectId = input.projectId ?? null;
      s.rounding = s.rounding.filter((r) => !(r.projectId === projectId && r.effectiveFrom === input.effectiveFrom));
      s.rounding.push({ id: newId(s, 'round'), projectId, effectiveFrom: input.effectiveFrom, incrementMinutes: input.incrementMinutes, method: input.method, deleted: false, stamp: stamp(s) } satisfies RoundingVersion);
      return snapshot(s);
    }
    case 'delete_rounding':
      s.rounding = s.rounding.filter((r) => r.id !== a.id);
      return snapshot(s);
    case 'set_setting': {
      const key = a.key as string;
      const value = a.value;
      if ((key === 'idleMinutes' || key === 'longRunMinutes') && value !== null && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_080)) {
        throw err('validation', `invalid value for ${key}`);
      }
      if (key === 'remindPastShift' && typeof value !== 'boolean') throw err('validation', `invalid value for ${key}`);
      (s.settings as Record<string, unknown>)[key] = value;
      return snapshot(s);
    }
    case 'set_theme':
      s.theme = a.theme as Theme;
      return snapshot(s);
    case 'set_hide_earnings':
      s.hideEarnings = a.hide as boolean;
      return snapshot(s);
    case 'mark_client_zone_prompt_done':
      s.clientZonePromptDone = true;
      return snapshot(s);
    case 'mark_sync_prompt_done':
      s.syncPromptDone = true;
      return snapshot(s);
    case 'dismiss_notice':
      s.notices = s.notices.filter((n) => n.id !== a.id);
      return snapshot(s);
    case 'add_sync_target':
      s.syncPromptDone = true;
      mergeFolderData(s, a.root as string);
      s.targets.push({
        provider: a.provider as Snapshot['sync']['targets'][number]['provider'],
        root: a.root as string,
        folder: `${a.root as string}/zWorkTracker`,
        status: { lastWrittenAt: toIso(s.now), lastReadAt: toIso(s.now), lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 0 },
      });
      return snapshot(s);
    case 'remove_sync_target':
      s.targets = s.targets.filter((t) => t.root !== a.root);
      // The lease is let go in the folder on the way out; with none left there is nothing to hold. A folder waiting for a choice is forgotten.
      if (s.targets.length === 0 && s.lease.state === 'heldByMe') s.lease = { ...s.lease, state: 'free' };
      if (s.joinPending?.root === a.root) s.joinPending = null;
      return snapshot(s);
    case 'pick_sync_folder':
      return '/mock/picked-folder';
    case 'preview_sync_folder': {
      const f = folderOf(s, a.root as string);
      return { hasData: folderHasData(f), devices: othersIn(f), ...f.counts, warnings: f.available ? [] : [FOLDER_NOT_FOUND] };
    }
    case 'sync_now':
      return snapshot(s);
    case 'preview_sync_move':
      return movePreview(s, (a.from as string | null) ?? null, a.to as string);
    case 'move_sync_target':
      return moveSyncTarget(s, a);
    case 'export_xlsx':
    case 'export_csv': {
      const request = a.request as ExportRequest;
      if (!isZone(request.dayZone)) throw err('validation', `unknown time zone: ${request.dayZone}`);
      checkSelection(s, request.selection, request.dayZone);
      s.exports.push({ kind: cmd === 'export_xlsx' ? 'xlsx' : 'csv', request });
      return cmd === 'export_xlsx' ? '/mock/export.xlsx' : '/mock/export.csv';
    }
    case 'get_autostart':
      return autostartIsOn(autostartView(s).state);
    case 'set_autostart':
      return setAutostart(s, a.enabled as boolean);
    case 'ack_hide_notice':
    case 'quit_app':
      return null;
    case 'plugin:event|listen':
      return 1;
    case 'plugin:event|unlisten':
      return null;
    default: {
      for (const more of [phase2, leaseCommands]) {
        const out = more(s, cmd, a);
        if (out !== NOT_HANDLED) return out;
      }
      throw err('unknown', `mock has no command ${cmd}`);
    }
  }
}

export function installMock(state: MockState): void {
  // Events are mocked too, so tests can `emit('cold-resume', ...)` and the app's listeners fire.
  mockIPC(
    (cmd, args) => {
      state.calls.push({ cmd, args });
    const failing = state.failNext?.indexOf(cmd) ?? -1;
    if (failing >= 0) {
      state.failNext?.splice(failing, 1);
      throw err('io', `mock: ${cmd} failed`);
    }
      return handle(state, cmd, (args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
}

export const paletteColor = (i: number): string => PROJECT_PALETTE[i % PROJECT_PALETTE.length] as string;
