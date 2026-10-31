// Typed wrappers for the backend's commands. The frontend never sends a timestamp for time logging.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  ExportRequest,
  FolderPreview,
  MovePreview,
  MoveProgress,
  MoveResult,
  ProjectInput,
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
  createProject: (input: ProjectInput) => invoke<WithId>('create_project', { input }),
  updateProject: (id: string, input: ProjectInput) => invoke<Snapshot>('update_project', { id, input }),
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
};
