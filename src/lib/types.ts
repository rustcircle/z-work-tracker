// The backend's read model. Field names match `z-work-core`'s `view.rs` exactly.
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
  | { kind: 'syncReconciled' }
  | { kind: 'backupRestored' };

export type BillingType = 'hourly' | 'fixedFee';

/** Where a project stands against its budget. Whole percent, rounded down; level is 0, 80 or 100. */
export interface BudgetStatus {
  /** `hours`, or `fee` when time value is measured against a fixed fee. */
  basis: 'hours' | 'fee';
  percent: number;
  level: 0 | 80 | 100;
  /** A fixed fee can't be tracked without a price per hour to value the time. */
  needsTargetRate: boolean;
}

export interface ProjectFigures {
  exactSecs: number;
  pauseSecs: number;
  billableSecs: number;
  thinkingSecs: number;
  /** Fixed-fee projects: fee divided by billable hours, in cents per hour. */
  effectiveHourlyCents: number | null;
  /** Time at the project's rate versions, even on a fixed-fee project, per currency. */
  timeValueCents: Partial<Record<Currency, number>>;
  budget: BudgetStatus | null;
}

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
  billingType: BillingType;
  /** The agreed price of a fixed-fee project, in cents of `feeCurrency`. */
  fixedFeeCents: number | null;
  feeCurrency: Currency | null;
  figures: ProjectFigures;
}

/** One task-list item of a task description, the unit that can carry its own tracked time. */
export interface Subtask {
  id: string;
  text: string;
  checked: boolean;
  secs: number;
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
  tags: string[];
  /** The subtask new time is attributed to. */
  activeSubtask: string | null;
  subtasks: Subtask[];
  /** Seconds on a live billing summary, and seconds not yet on one. */
  billedSecs: number;
  unbilledSecs: number;
  thinkingSecs: number;
  pauseSecs: number;
  /** Away with no answer yet: counted nowhere until confirmed. */
  unconfirmedSecs: number;
}

/** Fields that must be filled before the first start of a launch. Data-driven: tags join this later. */
export type RequiredField = 'name' | 'project' | 'description' | 'tags';

/** What a warm start copies: the task most recently worked in this launch. */
export interface CopySource {
  taskId: string;
  name: string;
  projectId: string;
  projectArchived: boolean;
  description: RichDoc;
  lastWorkedAt: string | null;
  tags: string[];
}

/** Cold until the first task of this launch has started. Hiding to the tray stays warm. */
export interface LaunchState {
  warm: boolean;
  coldRequired: RequiredField[];
  copySource: CopySource | null;
}

export type PieceKind = 'work' | 'thinking' | 'billablePause';

/**
 * One piece of counted time, as the backend reports it. A recorded segment can become several pieces
 * (away time cut out, or marked as thinking), and a billable pause is a piece of its own. `kind` and
 * the fields after it may be absent in old fixtures: a missing kind means work.
 */
export interface Segment {
  id: string;
  taskId: string;
  deviceId: string;
  start: string;
  end: string | null;
  provisionalEnd: string | null;
  /** The recorded segment this piece came from, or the pause record for a billable pause. */
  segmentId?: string;
  kind?: PieceKind;
  subtaskId?: string | null;
}

/** One recorded segment with its correction, for the corrections screen. */
export interface RawSegment {
  id: string;
  taskId: string;
  deviceId: string;
  rawStart: string;
  rawEnd: string | null;
  start: string;
  end: string | null;
  voided: boolean;
  corrected: boolean;
  manual: boolean;
  reason: string;
  billed: boolean;
}

export type GapKind = 'sleep' | 'idle' | 'lock';
export type GapDecision = 'pending' | 'keep' | 'drop' | 'thinking';

/** Time away detected inside a running segment. The segment's recorded times don't change. */
export interface IdleGap {
  id: string;
  segmentId: string;
  taskId: string;
  deviceId: string;
  start: string;
  end: string;
  kind: GapKind;
  decision: GapDecision;
  decisionStamp: Stamp;
}

/** A pause marked as still working. It counts in Billable and never in Exact. */
export interface BillablePause {
  id: string;
  taskId: string;
  start: string;
  end: string;
  note: string;
  deleted: boolean;
  stamp: Stamp;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  deleted: boolean;
  stamp: Stamp;
}

export interface Template {
  id: string;
  name: string;
  projectId: string | null;
  description: RichDoc;
  tags: string[];
  deleted: boolean;
  stamp: Stamp;
}

export interface AuditEntry {
  id: string;
  at: string;
  by: string;
  entity: string;
  entityId: string;
  action: string;
  reason: string;
  before: unknown;
  after: unknown;
}

export interface SummaryRow {
  taskId: string;
  taskName: string;
  day: string;
  exactSecs: number;
  pauseSecs: number;
  billableSecs: number;
  cents: Partial<Record<Currency, number>>;
}

/** For the user's own guidance. Not an invoice, and not a tax document. */
export interface BillingSummary {
  id: string;
  /** `<prefix>-<number>`, such as `A-001`. Unique per device. */
  reference: string;
  prefix: string;
  number: number;
  deviceId: string;
  projectId: string;
  from: string;
  to: string;
  zone: string;
  createdAt: string;
  segmentIds: string[];
  pauseIds: string[];
  rows: SummaryRow[];
  totals: Partial<Record<Currency, number>>;
  voided: boolean;
  stamp: Stamp;
}

export interface BillingView {
  prefix: string;
  /** Names of other devices using the same prefix. */
  clashes: string[];
  summaries: BillingSummary[];
}

export interface SummaryRequest {
  projectId: string;
  /** Inclusive days, `YYYY-MM-DD`, in `zone`. */
  from: string;
  to: string;
  zone: string;
}

export interface SummaryPreview {
  rows: SummaryRow[];
  totals: Partial<Record<Currency, number>>;
  segmentIds: string[];
  pauseIds: string[];
  exactSecs: number;
  pauseSecs: number;
  billableSecs: number;
  /** Time in the period that is still running, so it isn't listed yet. */
  runningExcluded: boolean;
  /** Time away inside these segments with no decision yet. It is left out, and a summary freezes that. */
  unconfirmedSecs: number;
}

export type Reminder = { kind: 'longRun'; taskId: string; since: string } | { kind: 'pastShift'; taskId: string; shift: string; ended: string };

export interface ReminderSettings {
  idleMinutes: number;
  longRunMinutes: number;
  remindPastShift: boolean;
}

export interface BackupInfo {
  name: string;
  bytes: number;
  /** A copy made automatically just before a restore. */
  safety: boolean;
}

export interface PdfRequest {
  projectId: string | null;
  from: string;
  to: string;
  zone: string;
  title: string;
  includePrices: boolean;
  useLogo: boolean;
}

export interface ManualEntryInput {
  taskId: string;
  start: string;
  end: string;
  reason: string;
  subtaskId?: string | null;
  /** The user saw the overlap warning and wants the entry anyway. */
  allowOverlap?: boolean;
}

export interface CorrectionInput {
  segmentId: string;
  start: string;
  end: string;
  reason: string;
  allowOverlap?: boolean;
}

export interface PauseInput {
  taskId: string;
  start: string;
  end: string;
  note: string;
}

export interface TagInput {
  id?: string | null;
  name: string;
  /** `#rrggbb`; the backend stores it lowercase. */
  color: string;
}

export interface TemplateInput {
  id?: string | null;
  name: string;
  projectId: string | null;
  description: RichDoc;
  tags: string[];
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

/** Counts of what a sync folder (or this computer) holds. */
export interface DataCounts {
  projects: number;
  tasks: number;
  segments: number;
}

/** What moving sync to another folder would do, read without changing anything. */
export interface MovePreview {
  sourceAvailable: boolean;
  sourceDevices: string[];
  sourceCounts: DataCounts;
  destinationHasData: boolean;
  destinationDevices: string[];
  destinationCounts: DataCounts;
  localCounts: DataCounts;
  warnings: string[];
}

export interface MoveResult {
  filesCopied: number;
  filesAlreadyThere: number;
  filesIgnored: number;
  sourceMissing: boolean;
  counts: DataCounts;
  checksum: string;
  warnings: string[];
}

/** Payload of the `sync-move-progress` event. */
export interface MoveProgress {
  /** The backend's own words for the step, such as "Copying device files". Shown as it is. */
  step: string;
  done: number;
  total: number;
}

/** The previous folder could not be read, so a copy into `to` is still owed. */
export interface PendingCopy {
  from: string;
  to: string;
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
  /** Whole minutes; 0 or null turns the feature off. */
  idleMinutes?: number | null;
  longRunMinutes?: number | null;
  remindPastShift?: boolean;
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
  sync: { targets: SyncTargetView[]; detected: Detected[]; promptPending: boolean; pendingCopy: PendingCopy | null };
  launch: LaunchState;
  rawSegments: RawSegment[];
  /** Time away. Pending gaps count nowhere until the user decides. */
  gaps: IdleGap[];
  pauses: BillablePause[];
  tags: Tag[];
  templates: Template[];
  billing: BillingView;
  reminder: Reminder | null;
  reminderSettings: ReminderSettings;
  backupKeep: number;
  hasPdfLogo: boolean;
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
  billingType?: BillingType;
  fixedFeeCents?: number | null;
  feeCurrency?: Currency | null;
}

export interface TaskInput {
  name: string;
  projectId: string;
  description: RichDoc;
  /** Only read when creating a task. */
  continuedFrom?: string | null;
  tags?: string[];
}

/** An edit to some fields of a task. A key left out keeps the stored value; description null clears it. */
export interface TaskPatch {
  name?: string;
  projectId?: string;
  description?: RichDoc;
  tags?: string[];
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
