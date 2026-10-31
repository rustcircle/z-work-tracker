// Test-only stand-in for the Rust backend, installed in the `e2e` build mode and in component tests.
// It mirrors labor-core's command behaviour. Real-backend behaviour is covered by the Rust tests and
// by scripts/native-smoke.mjs; anything verified only against this mock is reported as such.
import { mockIPC } from '@tauri-apps/api/mocks';

import { PROJECT_PALETTE } from '../lib/color';
import { isCurrency } from '../lib/billing';
import { docHasText } from '../lib/docText';
import { isZone, parseIso, toIso } from '../lib/tz';
import type {
  CopySource,
  ExportRequest,
  PauseReason,
  Project,
  ProjectInput,
  RateInput,
  RateVersion,
  RequiredField,
  RoundingInput,
  RoundingVersion,
  Segment,
  Settings,
  ShiftInput,
  ShiftVersion,
  Snapshot,
  Task,
  TaskInput,
  TaskState,
  Theme,
} from '../lib/types';

export const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

export interface MockState {
  now: number;
  projects: Project[];
  tasks: Task[];
  segments: Segment[];
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
  detected: Snapshot['sync']['detected'];
  notices: Snapshot['notices'];
  warnings: string[];
  exports: { kind: 'xlsx' | 'csv'; request: ExportRequest }[];
  calls: { cmd: string; args: unknown }[];
  autostart: boolean;
  nextId: number;
  /** Launch-scoped, like the Rust service: false until the first task of this launch has started. */
  warm: boolean;
  lastWorked: string | null;
}

export function emptyState(now = '2026-10-31T12:00:00Z'): MockState {
  return {
    now: parseIso(now),
    projects: [],
    tasks: [],
    segments: [],
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
    detected: [],
    notices: [],
    warnings: [],
    exports: [],
    calls: [],
    autostart: false,
    nextId: 1,
    warm: false,
    lastWorked: null,
  };
}

const err = (code: string, message: string) => ({ code, message });

const COLD_REQUIRED: RequiredField[] = ['name', 'project', 'description'];

function copySource(s: MockState): CopySource | null {
  const t = s.tasks.find((x) => x.id === s.lastWorked);
  if (!t) return null;
  const ends = s.segments.filter((x) => x.taskId === t.id).map((x) => x.end ?? x.start).sort();
  return {
    taskId: t.id,
    name: t.name,
    projectId: t.projectId,
    projectArchived: s.projects.find((p) => p.id === t.projectId)?.archived ?? true,
    description: t.description,
    lastWorkedAt: ends.at(-1) ?? null,
  };
}

function checkColdFields(s: MockState, t: Task): void {
  if (s.warm) return;
  if (!t.name.trim()) throw err('validation', 'Task name is required for the first start after launch');
  if (!t.projectId) throw err('validation', 'Project is required for the first start after launch');
  if (!docHasText(t.description)) throw err('validation', 'Description is required for the first start after launch');
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

function snapshot(s: MockState): Snapshot {
  const withTasks = new Set(s.tasks.map((t) => t.projectId));
  return structuredClone({
    now: toIso(s.now),
    deviceId: DEVICE_ID,
    deviceName: 'Mock PC',
    systemZone: s.systemZone,
    tzdbVersion: 'mock',
    projects: s.projects.map((p) => ({ ...p, hasTasks: withTasks.has(p.id) })),
    tasks: s.tasks,
    segments: s.segments,
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
    warnings: s.warnings,
    sync: { targets: s.targets, detected: s.detected, promptPending: !s.syncPromptDone && s.targets.length === 0 },
    launch: { warm: s.warm, coldRequired: COLD_REQUIRED, copySource: s.warm ? copySource(s) : null },
  });
}

const stamp = (s: MockState) => ({ at: toIso(s.now), by: DEVICE_ID });

function newId(s: MockState, prefix: string): string {
  const id = `${prefix}-${s.nextId}`;
  s.nextId += 1;
  return id;
}

function cleanProject(s: MockState, input: ProjectInput, except: string | null): ProjectInput {
  const name = input.name.trim();
  if (!name) throw err('validation', 'Project name is required');
  if (s.projects.some((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase())) {
    throw err('conflict', `a project named "${name}" already exists`);
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) throw err('validation', 'project color must look like #1a2b3c');
  if (input.clientZone && !isZone(input.clientZone)) throw err('validation', `unknown time zone: ${input.clientZone}`);
  return { ...input, name, color: input.color.toLowerCase() };
}

function task(s: MockState, id: string): Task {
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

function setState(t: Task, state: TaskState, reason: PauseReason | null): void {
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
  s.segments.push({ id: newId(s, 'seg'), taskId: id, deviceId: DEVICE_ID, start: toIso(s.now), end: null, provisionalEnd: null });
  setState(t, 'running', null);
  s.warm = true;
  s.lastWorked = id;
  return { autoPausedTaskId, autoPausedTaskName, snapshot: snapshot(s) };
}

export function handle(s: MockState, cmd: string, a: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'get_snapshot':
      return snapshot(s);
    case 'create_project': {
      const input = cleanProject(s, a.input as ProjectInput, null);
      const id = newId(s, 'project');
      s.projects.push({ id, ...input, archived: false, createdAt: toIso(s.now), hasTasks: false });
      return { id, snapshot: snapshot(s) };
    }
    case 'update_project': {
      const input = cleanProject(s, a.input as ProjectInput, a.id as string);
      const p = s.projects.find((x) => x.id === a.id);
      if (!p) throw err('not_found', 'project not found');
      Object.assign(p, input);
      return snapshot(s);
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
      s.projects = s.projects.filter((p) => p.id !== a.id);
      return snapshot(s);
    }
    case 'create_task': {
      const input = a.input as TaskInput;
      if (!input.name.trim()) throw err('validation', 'Task name is required');
      if (!input.projectId) throw err('validation', 'Project is required');
      if (!s.projects.some((p) => p.id === input.projectId)) throw err('not_found', 'project not found');
      const id = newId(s, 'task');
      s.tasks.push({
        id, name: input.name.trim(), projectId: input.projectId, description: input.description, state: 'draft',
        pauseReason: null, createdAt: toIso(s.now), stoppedAt: null, runningElsewhere: null,
        continuedFrom: input.continuedFrom ?? null,
      });
      return { id, snapshot: snapshot(s) };
    }
    case 'update_task': {
      const input = a.input as TaskInput;
      if (!input.name.trim()) throw err('validation', 'Task name is required');
      const t = task(s, a.id as string);
      t.name = input.name.trim();
      t.projectId = input.projectId;
      t.description = input.description;
      return snapshot(s);
    }
    case 'delete_draft': {
      if (task(s, a.id as string).state !== 'draft') throw err('conflict', 'only a draft can be deleted');
      s.tasks = s.tasks.filter((t) => t.id !== a.id);
      return snapshot(s);
    }
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
      s.lastWorked = t.id;
      return snapshot(s);
    }
    case 'stop_task': {
      const t = task(s, a.id as string);
      if (t.state !== 'running' && t.state !== 'paused') throw err('illegal_transition', `cannot stop a task that is ${t.state}`);
      closeOwn(s, t.id);
      setState(t, 'stopped', null);
      t.stoppedAt = toIso(s.now);
      s.lastWorked = t.id;
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
      const input = a.input as RateInput;
      if (!isCurrency(input.currency)) throw err('validation', 'currency must be EUR or USD');
      const from = input.effectiveFrom ? parseIso(input.effectiveFrom) : s.now;
      if (from < s.now && !input.confirmRetroactive) throw err('conflict', 'a backdated price changes past earnings and needs confirmation');
      if (input.rateCents !== null && (input.rateCents < 0 || input.rateCents > 1_000_000)) throw err('validation', 'price per hour must be between 0 and 10000.00');
      s.rates = s.rates.filter((r) => !(r.projectId === input.projectId && parseIso(r.effectiveFrom) === from));
      s.rates.push({ id: newId(s, 'rate'), projectId: input.projectId, effectiveFrom: toIso(from), rateCents: input.rateCents, currency: input.currency, deleted: false, stamp: stamp(s) });
      s.lastCurrency = input.currency;
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
    case 'set_setting':
      (s.settings as Record<string, unknown>)[a.key as string] = a.value;
      return snapshot(s);
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
      s.targets.push({
        provider: a.provider as Snapshot['sync']['targets'][number]['provider'],
        root: a.root as string,
        folder: `${a.root as string}/LaborTracker`,
        status: { lastWrittenAt: toIso(s.now), lastReadAt: toIso(s.now), lastError: null, lastErrorAt: null, warnings: [], ignoredFiles: 0, devicesSeen: 0 },
      });
      return snapshot(s);
    case 'remove_sync_target':
      s.targets = s.targets.filter((t) => t.root !== a.root);
      return snapshot(s);
    case 'pick_sync_folder':
      return '/mock/picked-folder';
    case 'preview_sync_folder':
      return { hasData: false, devices: [], projects: 0, tasks: 0, segments: 0, warnings: [] };
    case 'sync_now':
      return snapshot(s);
    case 'export_xlsx':
      s.exports.push({ kind: 'xlsx', request: a.request as ExportRequest });
      return '/mock/export.xlsx';
    case 'export_csv':
      s.exports.push({ kind: 'csv', request: a.request as ExportRequest });
      return '/mock/export.csv';
    case 'get_autostart':
      return s.autostart;
    case 'set_autostart':
      s.autostart = a.enabled as boolean;
      return s.autostart;
    case 'ack_hide_notice':
    case 'quit_app':
      return null;
    case 'plugin:event|listen':
      return 1;
    case 'plugin:event|unlisten':
      return null;
    default:
      throw err('unknown', `mock has no command ${cmd}`);
  }
}

export function installMock(state: MockState): void {
  // Events are mocked too, so tests can `emit('cold-resume', ...)` and the app's listeners fire.
  mockIPC(
    (cmd, args) => {
      state.calls.push({ cmd, args });
      return handle(state, cmd, (args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
}

export const paletteColor = (i: number): string => PROJECT_PALETTE[i % PROJECT_PALETTE.length] as string;
