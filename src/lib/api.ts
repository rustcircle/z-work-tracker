// Typed wrappers for the backend's commands. The frontend never sends a timestamp for time logging.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  AuditEntry,
  BackupInfo,
  CorrectionInput,
  ExportRequest,
  GapDecision,
  ManualEntryInput,
  PauseInput,
  PdfRequest,
  SavedColor,
  SummaryPreview,
  SummaryRequest,
  TagInput,
  TemplateInput,
  FolderPreview,
  MovePreview,
  MoveProgress,
  MoveResult,
  ProjectInput,
  RichDoc,
  RateInput,
  RoundingInput,
  ShiftInput,
  Snapshot,
  SyncProvider,
  TaskInput, TaskPatch,
  Theme,
  TransitionResult,
  WithId,
} from './types';

export const api = {
  getSnapshot: () => invoke<Snapshot>('get_snapshot'),
  createProject: (input: ProjectInput) => invoke<SavedColor>('create_project', { input }),
  updateProject: (id: string, input: ProjectInput) => invoke<SavedColor>('update_project', { id, input }),
  setProjectArchived: (id: string, archived: boolean) => invoke<Snapshot>('set_project_archived', { id, archived }),
  deleteProject: (id: string) => invoke<Snapshot>('delete_project', { id }),
  createTask: (input: TaskInput) => invoke<WithId>('create_task', { input }),
  updateTask: (id: string, input: TaskInput) => invoke<Snapshot>('update_task', { id, input }),
  /** Edits only the fields given, so an autosave never reverts another device's newer edit. */
  patchTask: (id: string, patch: TaskPatch) => invoke<Snapshot>('patch_task', { id, patch }),
  deleteDraft: (id: string) => invoke<Snapshot>('delete_draft', { id }),
  startTask: (id: string) => invoke<TransitionResult>('start_task', { id }),
  resumeTask: (id: string) => invoke<TransitionResult>('resume_task', { id }),
  pauseTask: (id: string) => invoke<Snapshot>('pause_task', { id }),
  stopTask: (id: string) => invoke<Snapshot>('stop_task', { id }),
  saveShift: (input: ShiftInput) => invoke<WithId>('save_shift', { input }),
  deleteShift: (shiftId: string) => invoke<Snapshot>('delete_shift', { shiftId }),
  setRate: (input: RateInput) => invoke<Snapshot>('set_rate', { input }),
  setRounding: (input: RoundingInput, today: string) => invoke<Snapshot>('set_rounding', { input, today }),
  deleteRounding: (id: string) => invoke<Snapshot>('delete_rounding', { id }),
  setSetting: (key: string, value: unknown) => invoke<Snapshot>('set_setting', { key, value }),
  setTheme: (theme: Theme) => invoke<Snapshot>('set_theme', { theme }),
  setHideEarnings: (hide: boolean) => invoke<Snapshot>('set_hide_earnings', { hide }),
  markClientZonePromptDone: () => invoke<Snapshot>('mark_client_zone_prompt_done'),
  markSyncPromptDone: () => invoke<Snapshot>('mark_sync_prompt_done'),
  dismissNotice: (id: string) => invoke<Snapshot>('dismiss_notice', { id }),
  addSyncTarget: (provider: SyncProvider, root: string) => invoke<Snapshot>('add_sync_target', { provider, root }),
  removeSyncTarget: (root: string) => invoke<Snapshot>('remove_sync_target', { root }),
  pickSyncFolder: () => invoke<string | null>('pick_sync_folder'),
  previewSyncFolder: (root: string) => invoke<FolderPreview>('preview_sync_folder', { root }),
  syncNow: () => invoke<Snapshot>('sync_now'),
  previewSyncMove: (from: string | null, to: string) => invoke<MovePreview>('preview_sync_move', { from, to }),
  /** Rejects with a message on failure, and then no setting has changed. */
  moveSyncTarget: (from: string | null, to: string, provider: SyncProvider, replacing: boolean) => invoke<MoveResult>('move_sync_target', { from, to, provider, replacing }),
  exportXlsx: (request: ExportRequest) => invoke<string | null>('export_xlsx', { request }),
  exportCsv: (request: ExportRequest) => invoke<string | null>('export_csv', { request }),
  getAutostart: () => invoke<boolean>('get_autostart'),
  setAutostart: (enabled: boolean) => invoke<boolean>('set_autostart', { enabled }),
  ackHideNotice: () => invoke<void>('ack_hide_notice'),
  quitApp: () => invoke<void>('quit_app'),

  // Manual entries and corrections. An `overlap` error means the span clashes with logged time; the page
  // may ask again with `allowOverlap`. Billed time can't change until its summary is voided.
  addManualEntry: (input: ManualEntryInput) => invoke<WithId>('add_manual_entry', { input }),
  correctSegment: (input: CorrectionInput) => invoke<Snapshot>('correct_segment', { input }),
  voidSegment: (id: string, reason: string) => invoke<Snapshot>('void_segment', { id, reason }),
  restoreSegment: (id: string, reason: string) => invoke<Snapshot>('restore_segment', { id, reason }),
  getAudit: (entityId: string | null) => invoke<AuditEntry[]>('get_audit', { entityId }),
  // Time away and billable pauses.
  decideGap: (id: string, decision: GapDecision) => invoke<Snapshot>('decide_gap', { id, decision }),
  markBillablePause: (input: PauseInput) => invoke<WithId>('mark_billable_pause', { input }),
  unmarkBillablePause: (id: string) => invoke<Snapshot>('unmark_billable_pause', { id }),
  setActiveSubtask: (taskId: string, subtaskId: string | null) => invoke<Snapshot>('set_active_subtask', { taskId, subtaskId }),
  // Tags and templates.
  saveTag: (input: TagInput) => invoke<SavedColor>('save_tag', { input }),
  deleteTag: (id: string) => invoke<Snapshot>('delete_tag', { id }),
  saveTemplate: (input: TemplateInput) => invoke<WithId>('save_template', { input }),
  deleteTemplate: (id: string) => invoke<Snapshot>('delete_template', { id }),
  taskFromTemplate: (id: string, projectId: string | null) => invoke<WithId>('task_from_template', { id, projectId }),
  // Billing summaries: for the user's own guidance, never an invoice.
  summaryPreview: (request: SummaryRequest) => invoke<SummaryPreview>('summary_preview', { request }),
  createSummary: (request: SummaryRequest) => invoke<WithId>('create_summary', { request }),
  voidSummary: (id: string) => invoke<Snapshot>('void_summary', { id }),
  setDevicePrefix: (prefix: string) => invoke<Snapshot>('set_device_prefix', { prefix }),
  exportSummaryCsv: (id: string) => invoke<string | null>('export_summary_csv', { id }),
  // PDF timesheet and its logo (PNG, kept on this computer only).
  exportPdf: (request: PdfRequest) => invoke<string | null>('export_pdf', { request }),
  pickPdfLogo: () => invoke<Snapshot>('pick_pdf_logo'),
  clearPdfLogo: () => invoke<Snapshot>('clear_pdf_logo'),
  // Backups and reminders.
  listBackups: () => invoke<BackupInfo[]>('list_backups'),
  restoreBackup: (name: string) => invoke<Snapshot>('restore_backup', { name }),
  setBackupKeep: (keep: number) => invoke<Snapshot>('set_backup_keep', { keep }),
  snoozeReminder: (minutes: number) => invoke<Snapshot>('snooze_reminder', { minutes }),
  // Gap-fill round.
  revertShiftVersion: (versionId: string) => invoke<Snapshot>('revert_shift_version', { versionId }),
  requestRemotePause: (taskId: string) => invoke<Snapshot>('request_remote_pause', { taskId }),
  /** A durable local draft of what is being typed. Cheap; never syncs. */
  stashDraft: (taskId: string, description: RichDoc) => invoke<void>('stash_draft', { taskId, description }),
  clearDraft: (taskId: string) => invoke<void>('clear_draft', { taskId }),
  setSetupStep: (step: number) => invoke<Snapshot>('set_setup_step', { step }),
  finishSetup: () => invoke<Snapshot>('finish_setup'),
  setMica: (on: boolean) => invoke<Snapshot>('set_mica', { on }),
};

export interface HideNoticePayload {
  running: boolean;
  taskName: string | null;
}

export const events = {
  onStateChanged: (handler: () => void): Promise<UnlistenFn> => listen('state-changed', () => handler()),
  onFirstHide: (handler: (p: HideNoticePayload) => void): Promise<UnlistenFn> =>
    listen<HideNoticePayload>('first-hide-notice', (e) => handler(e.payload)),
  /** The tray asked to resume on a cold launch: open the form, start nothing. */
  onColdResume: (handler: (taskId: string) => void): Promise<UnlistenFn> =>
    listen<{ taskId: string }>('cold-resume', (e) => handler(e.payload.taskId)),
  /** Copy progress while a sync folder is being changed. */
  onSyncMoveProgress: (handler: (p: MoveProgress) => void): Promise<UnlistenFn> => listen<MoveProgress>('sync-move-progress', (e) => handler(e.payload)),
  /** The window is hiding or the app is quitting: save any edit in progress now. */
  onFlushEdits: (handler: () => void): Promise<UnlistenFn> => listen('flush-edits', () => handler()),
  /** The window went to the tray. The backend goes on working. */
  onWindowHidden: (handler: () => void): Promise<UnlistenFn> => listen('window-hidden', () => handler()),
  /** The window came back from the tray. */
  onWindowShown: (handler: () => void): Promise<UnlistenFn> => listen('window-shown', () => handler()),
};
