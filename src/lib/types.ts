// The backend's read model. Field names match `labor-core`'s `view.rs` exactly.
export type TaskState = 'draft' | 'running' | 'paused' | 'stopped';
export type RoundMethod = 'nearest' | 'up' | 'down';
export type Currency = 'EUR' | 'USD';
export type Theme = 'light' | 'solarizedLight' | 'solarizedDark' | 'dark';
export type SyncProvider = 'oneDrive' | 'googleDrive' | 'custom';

export type PauseReason =
  | { kind: 'user' }
  | { kind: 'autoPaused'; byTaskId: string }
  | { kind: 'appQuit' }
  | { kind: 'crashRecovery' }
  | { kind: 'syncReconciled' };

export interface Project {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  billable: boolean;
  budgetHours: number | null;
  clientZone: string | null;
  createdAt: string;
  hasTasks: boolean;
}

/** TipTap JSON. Only ever rendered through the editor. */
export type RichDoc = Record<string, unknown> | null;

export interface Task {
  id: string;
  name: string;
  projectId: string;
  description: RichDoc;
  state: TaskState;
  pauseReason: PauseReason | null;
  createdAt: string;
  stoppedAt: string | null;
  runningElsewhere: string | null;
  /** The earlier task this one continues. Each copy is a separate task. */
  continuedFrom: string | null;
}

/** Fields that must be filled before the first start of a launch. Data-driven: tags join this later. */
export type RequiredField = 'name' | 'project' | 'description';

/** What a warm start copies: the task most recently worked in this launch. */
export interface CopySource {
  taskId: string;
  name: string;
  projectId: string;
  projectArchived: boolean;
  description: RichDoc;
  lastWorkedAt: string | null;
}

/** Cold until the first task of this launch has started. Hiding to the tray stays warm. */
export interface LaunchState {
  warm: boolean;
  coldRequired: RequiredField[];
  copySource: CopySource | null;
}

export interface Segment {
  id: string;
  taskId: string;
  deviceId: string;
  start: string;
  end: string | null;
  provisionalEnd: string | null;
}

export interface Stamp {
  at: string;
  by: string;
}

export interface ShiftVersion {
  id: string;
  shiftId: string;
  effectiveFrom: string;
  name: string;
  color: string;
  start: string;
  end: string;
  /** ISO weekdays of the date the shift starts on: 1 = Monday .. 7 = Sunday. */
  weekdays: number[];
  zone: string;
  breakMinutes: number;
  retired: boolean;
  deleted: boolean;
  stamp: Stamp;
}

export interface RateVersion {
  id: string;
  projectId: string;
  effectiveFrom: string;
  /** null is "no rate", which is different from 0. */
  rateCents: number | null;
  currency: string;
  deleted: boolean;
  stamp: Stamp;
}

export interface RoundingVersion {
  id: string;
  projectId: string | null;
  effectiveFrom: string;
  /** 0 means exact. */
  incrementMinutes: number;
  method: RoundMethod;
  deleted: boolean;
  stamp: Stamp;
}

export interface Notice {
  id: string;
  level: 'info' | 'warning';
  message: string;
}

export interface TargetStatus {
  lastWrittenAt: string | null;
  lastReadAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  warnings: string[];
  ignoredFiles: number;
  devicesSeen: number;
}

export interface SyncTargetView {
  provider: SyncProvider;
  root: string;
  folder: string;
  status: TargetStatus;
}

export interface Detected {
  provider: SyncProvider;
  root: string;
  source: string;
}

export interface FolderPreview {
  hasData: boolean;
  devices: string[];
  projects: number;
  tasks: number;
  segments: number;
  warnings: string[];
}

/** Replicated settings; every key is optional. */
export interface Settings {
  myZone?: string | null;
  clientZone?: string | null;
  activeZone?: string | null;
  showBoth?: boolean;
  clientWorkStart?: string | null;
  clientWorkEnd?: string | null;
  dailyTargetHours?: number | null;
  weeklyTargetHours?: number | null;
}

export interface Snapshot {
  now: string;
  deviceId: string;
  deviceName: string;
  systemZone: string;
  tzdbVersion: string;
  projects: Project[];
  tasks: Task[];
  segments: Segment[];
  shifts: ShiftVersion[];
  rates: RateVersion[];
  rounding: RoundingVersion[];
  settings: Settings;
  prefs: {
    theme: Theme;
    hideEarnings: boolean;
    lastCurrency: Currency | null;
    clientZonePromptDone: boolean;
  };
  notices: Notice[];
  warnings: string[];
  sync: { targets: SyncTargetView[]; detected: Detected[]; promptPending: boolean };
  launch: LaunchState;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface ProjectInput {
  name: string;
  color: string;
  billable: boolean;
  budgetHours: number | null;
  clientZone: string | null;
}

export interface TaskInput {
  name: string;
  projectId: string;
  description: RichDoc;
  /** Only read when creating a task. */
  continuedFrom?: string | null;
}

/** An edit to some fields of a task. A key left out keeps the stored value; description null clears it. */
export interface TaskPatch {
  name?: string;
  projectId?: string;
  description?: RichDoc;
}

export interface ShiftInput {
  shiftId?: string | null;
  effectiveFrom: string;
  name: string;
  color: string;
  start: string;
  end: string;
  weekdays: number[];
  zone: string;
  breakMinutes: number;
  retired?: boolean;
}

export interface RateInput {
  projectId: string;
  rateCents: number | null;
  currency: Currency;
  effectiveFrom?: string | null;
  confirmRetroactive?: boolean;
}

export interface RoundingInput {
  projectId?: string | null;
  effectiveFrom: string;
  incrementMinutes: number;
  method: RoundMethod;
  confirmRetroactive?: boolean;
}

export type CellKind = 'text' | 'int' | 'number' | 'percent' | 'duration' | 'eur' | 'usd';

export interface AnalyticsSheet {
  name: string;
  title: string;
  columns: { header: string; kind: CellKind }[];
  rows: (string | number | null)[][];
  containsPrices: boolean;
}

export interface ExportRequest {
  dayZone: string;
  myZone: string;
  clientZone: string | null;
  includeEarnings: boolean;
  segmentShifts: Record<string, string>;
  analytics: AnalyticsSheet[];
}

export interface TransitionResult {
  autoPausedTaskId: string | null;
  autoPausedTaskName: string | null;
  snapshot: Snapshot;
}

export interface WithId {
  id: string;
  snapshot: Snapshot;
}
