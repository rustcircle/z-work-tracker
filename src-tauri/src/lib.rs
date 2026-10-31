//! Tauri shell around `z-work-core`: commands, tray, heartbeat, sync thread and the real-exit path.
//! Timers live in Rust threads, so they keep going while the window is hidden.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use z_work_core::adjust::{CorrectionInput, ManualEntryInput, PauseInput};
use z_work_core::backup::BackupInfo;
use z_work_core::catalog::{TagInput, TemplateInput};
use z_work_core::detect::{RealEnv, detect, host_os};
use z_work_core::machine::{
    ProjectInput, RateInput, RoundingInput, ShiftInput, TaskInput, TaskPatch,
};
use z_work_core::model::{AuditEntry, GapDecision, SyncProvider, SyncTarget, Theme};
use z_work_core::pdf::{self, PdfRequest};
use z_work_core::report::ExportRequest;
use z_work_core::service::{PDF_LOGO_FILE, Service};
use z_work_core::summary::{self, SummaryPreview, SummaryRequest};
use z_work_core::sync::{
    FolderPreview, MovePreview, MoveResult, RealIo, SyncSchedule, TARGET_TIMEOUT, bounded,
    move_target, preview_folder, preview_move, run_cycle,
};
use z_work_core::tray::{
    CloseDecision, ToggleRoute, TrayAction, close_decision, toggle_route, tray_state,
};
use z_work_core::validate::parse_zone;
use z_work_core::view::Snapshot;
use z_work_core::{CoreError, SystemClock, csv, xlsx};

const HEARTBEAT: Duration = Duration::from_secs(30);
const TRAY_TICK: Duration = Duration::from_secs(5);
const EXIT_SYNC_LIMIT: Duration = Duration::from_secs(5);
const ACTIVITY_TICK: Duration = Duration::from_secs(5);
const CHORES_TICK: Duration = Duration::from_secs(60);
const QUIT_ARG: &str = "--quit";
/// Lets the page save an edit in progress before the process ends.
const EDIT_FLUSH_WAIT: Duration = Duration::from_millis(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    code: &'static str,
    message: String,
}

impl From<CoreError> for CmdError {
    fn from(e: CoreError) -> Self {
        Self {
            code: e.code(),
            message: e.to_string(),
        }
    }
}

type CmdResult<T> = Result<T, CmdError>;

enum SyncMsg {
    /// A major action: start, pause, resume, stop, or a change to a project, shift, rate or setting.
    Changed,
    /// Task text changed: wait for it to settle.
    Edited,
    Now,
    Stop,
}

struct TrayHandles {
    icon: TrayIcon,
    status: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    idle: Image<'static>,
    running: Image<'static>,
    last_running: AtomicBool,
}

/// `service` is an error when the store could not be opened (for example a newer file version).
struct Core {
    service: Result<Arc<Mutex<Service>>, String>,
    sync: Mutex<Option<Sender<SyncMsg>>>,
    tray: Mutex<Option<Arc<TrayHandles>>>,
    quitting: AtomicBool,
    exit_done: AtomicBool,
    /// The first-hide fallback timer still applies. Reading the notice cancels it.
    hide_pending: AtomicBool,
    /// One sync cycle at a time: cycles write the same temporary file.
    cycle_lock: Arc<Mutex<()>>,
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Core {
    fn svc(&self) -> CmdResult<Arc<Mutex<Service>>> {
        self.service
            .as_ref()
            .map(Arc::clone)
            .map_err(|e| CmdError::from(CoreError::StoreUnavailable(e.clone())))
    }

    fn tell_sync(&self, msg: SyncMsg) {
        if let Some(tx) = guard(&self.sync).as_ref() {
            let _ = tx.send(msg);
        }
    }

    /// Runs a change, then schedules a sync and refreshes the tray.
    fn change<R>(
        &self,
        app: &AppHandle,
        f: impl FnOnce(&mut Service) -> Result<R, CoreError>,
    ) -> CmdResult<(R, Snapshot)> {
        let svc = self.svc()?;
        let (out, snap) = {
            let mut s = guard(&svc);
            let out = f(&mut s)?;
            (out, s.snapshot())
        };
        self.tell_sync(SyncMsg::Changed);
        refresh_tray(app, self);
        Ok((out, snap))
    }

    /// The same for an autosaved text edit, which schedules a later sync.
    fn edit(
        &self,
        app: &AppHandle,
        f: impl FnOnce(&mut Service) -> Result<(), CoreError>,
    ) -> CmdResult<Snapshot> {
        let svc = self.svc()?;
        let snap = {
            let mut s = guard(&svc);
            f(&mut s)?;
            s.snapshot()
        };
        self.tell_sync(SyncMsg::Edited);
        refresh_tray(app, self);
        Ok(snap)
    }
}

fn zone_for_tray(snapshot_zone: Option<&serde_json::Value>, fallback: &str) -> chrono_tz::Tz {
    snapshot_zone
        .and_then(serde_json::Value::as_str)
        .and_then(|z| parse_zone(z).ok())
        .or_else(|| parse_zone(fallback).ok())
        .unwrap_or(chrono_tz::UTC)
}

fn refresh_tray(_app: &AppHandle, core: &Core) {
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    let state = {
        let s = guard(svc);
        let settings = &s.file().data.settings;
        let chosen = settings
            .get("activeZone")
            .filter(|e| e.value.is_string())
            .or_else(|| settings.get("myZone"))
            .map(|e| &e.value);
        let zone = zone_for_tray(chosen, &s.snapshot_system_zone());
        tray_state(s.file(), s.now(), zone)
    };
    // Tray calls can wait on the UI thread. Holding the lock across them could deadlock with it.
    let Some(h) = guard(&core.tray).as_ref().map(Arc::clone) else {
        return;
    };
    let _ = h.icon.set_tooltip(Some(&state.tooltip));
    let _ = h.status.set_text(&state.status_line);
    match state.action {
        Some(TrayAction::Pause) => {
            let _ = h.toggle.set_text("Pause");
            let _ = h.toggle.set_enabled(true);
        }
        Some(TrayAction::Resume) => {
            let _ = h.toggle.set_text("Resume");
            let _ = h.toggle.set_enabled(true);
        }
        None => {
            let _ = h.toggle.set_text("Pause / Resume");
            let _ = h.toggle.set_enabled(false);
        }
    }
    if h.last_running.swap(state.running, Ordering::SeqCst) != state.running {
        let image = if state.running {
            h.running.clone()
        } else {
            h.idle.clone()
        };
        let _ = h.icon.set_icon(Some(image));
    }
}

/// To the tray. The page stops its clock, whether or not its webview reports itself as hidden.
fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
        let _ = app.emit("window-hidden", ());
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = app.emit("window-shown", ());
    }
    if let Some(core) = app.try_state::<Arc<Core>>() {
        core.hide_pending.store(false, Ordering::SeqCst);
    }
}

fn apply_native_theme(app: &AppHandle, theme: Theme) {
    if let Some(w) = app.get_webview_window("main") {
        let native = match theme {
            Theme::Light | Theme::SolarizedLight => tauri::Theme::Light,
            Theme::SolarizedDark | Theme::Dark => tauri::Theme::Dark,
        };
        let _ = w.set_theme(Some(native));
    }
}

/// The one way the app really ends: close open segments, sync once within a limit, then exit.
fn finish_exit(core: &Core) {
    if core.exit_done.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    if let Err(e) = guard(svc).on_exit() {
        eprintln!("could not close the running segment at exit: {e}");
    }
    core.tell_sync(SyncMsg::Stop);
    let svc = Arc::clone(svc);
    let lock = Arc::clone(&core.cycle_lock);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _cycle = guard(&lock);
        run_cycle(&svc, &RealIo);
        let _ = tx.send(());
    });
    // A stuck network drive must not hold the app open.
    let _ = rx.recv_timeout(EXIT_SYNC_LIMIT);
}

fn request_quit(app: &AppHandle) {
    if let Some(core) = app.try_state::<Arc<Core>>() {
        core.quitting.store(true, Ordering::SeqCst);
    }
    let _ = app.emit("flush-edits", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EDIT_FLUSH_WAIT);
        handle.exit(0);
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HideNotice {
    running: bool,
    task_name: Option<String>,
}

fn handle_close(app: &AppHandle, core: &Core) -> bool {
    let _ = app.emit("flush-edits", ());
    let shown = core
        .service
        .as_ref()
        .map_or(true, |s| guard(s).hide_notice_shown());
    match close_decision(core.quitting.load(Ordering::SeqCst), shown) {
        CloseDecision::Exit => false,
        CloseDecision::Hide => {
            core.hide_pending.store(false, Ordering::SeqCst);
            hide_main(app);
            true
        }
        CloseDecision::HideWithNotice => {
            let payload = core.service.as_ref().map_or(
                HideNotice {
                    running: false,
                    task_name: None,
                },
                |s| {
                    let mut s = guard(s);
                    let _ = s.mark_hide_notice_shown();
                    let file = s.file();
                    let task = file
                        .data
                        .segments
                        .values()
                        .find(|x| x.end.is_none() && x.device_id == file.device_id)
                        .and_then(|x| file.data.tasks.get(&x.task_id))
                        .map(|t| t.name.clone());
                    HideNotice {
                        running: task.is_some(),
                        task_name: task,
                    }
                },
            );
            let _ = app.emit("first-hide-notice", payload);
            // If the page cannot show the notice, the window still goes to the tray.
            core.hide_pending.store(true, Ordering::SeqCst);
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(30));
                let still_due = handle
                    .try_state::<Arc<Core>>()
                    .is_some_and(|c| c.hide_pending.swap(false, Ordering::SeqCst));
                if still_due {
                    hide_main(&handle);
                }
            });
            true
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WithId {
    id: String,
    snapshot: Snapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransitionResult {
    auto_paused_task_id: Option<String>,
    auto_paused_task_name: Option<String>,
    snapshot: Snapshot,
}

type CoreState<'a> = State<'a, Arc<Core>>;

#[tauri::command(async)]
fn get_snapshot(core: CoreState<'_>) -> CmdResult<Snapshot> {
    Ok(guard(&*core.svc()?).snapshot())
}

#[tauri::command(async)]
fn create_project(app: AppHandle, core: CoreState<'_>, input: ProjectInput) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.create_project(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn update_project(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    input: ProjectInput,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.update_project(&id, &input))?.1)
}

#[tauri::command(async)]
fn set_project_archived(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    archived: bool,
) -> CmdResult<Snapshot> {
    Ok(core
        .change(&app, |s| s.set_project_archived(&id, archived))?
        .1)
}

#[tauri::command(async)]
fn delete_project(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_project(&id))?.1)
}

#[tauri::command(async)]
fn create_task(app: AppHandle, core: CoreState<'_>, input: TaskInput) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.create_task(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn update_task(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    input: TaskInput,
) -> CmdResult<Snapshot> {
    core.edit(&app, |s| s.update_task(&id, &input))
}

#[tauri::command(async)]
fn patch_task(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    patch: TaskPatch,
) -> CmdResult<Snapshot> {
    core.edit(&app, |s| s.patch_task(&id, &patch))
}

#[tauri::command(async)]
fn delete_draft(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_draft(&id))?.1)
}

#[tauri::command(async)]
fn start_task(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<TransitionResult> {
    let (t, snapshot) = core.change(&app, |s| s.start_task(&id))?;
    Ok(TransitionResult {
        auto_paused_task_id: t.auto_paused_task_id,
        auto_paused_task_name: t.auto_paused_task_name,
        snapshot,
    })
}

#[tauri::command(async)]
fn resume_task(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<TransitionResult> {
    let (t, snapshot) = core.change(&app, |s| s.resume_task(&id))?;
    Ok(TransitionResult {
        auto_paused_task_id: t.auto_paused_task_id,
        auto_paused_task_name: t.auto_paused_task_name,
        snapshot,
    })
}

#[tauri::command(async)]
fn pause_task(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.pause_task(&id))?.1)
}

#[tauri::command(async)]
fn stop_task(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.stop_task(&id))?.1)
}

#[tauri::command(async)]
fn save_shift(app: AppHandle, core: CoreState<'_>, input: ShiftInput) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.save_shift(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn delete_shift(app: AppHandle, core: CoreState<'_>, shift_id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_shift(&shift_id))?.1)
}

#[tauri::command(async)]
fn set_rate(app: AppHandle, core: CoreState<'_>, input: RateInput) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_rate(&input))?.1)
}

#[tauri::command(async)]
fn set_rounding(
    app: AppHandle,
    core: CoreState<'_>,
    input: RoundingInput,
    today: String,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_rounding(&input, &today))?.1)
}

#[tauri::command(async)]
fn delete_rounding(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_rounding(&id))?.1)
}

#[tauri::command(async)]
fn set_setting(
    app: AppHandle,
    core: CoreState<'_>,
    key: String,
    value: serde_json::Value,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_setting(&key, value))?.1)
}

#[tauri::command(async)]
fn set_theme(app: AppHandle, core: CoreState<'_>, theme: Theme) -> CmdResult<Snapshot> {
    let snapshot = core.change(&app, |s| s.set_theme(theme))?.1;
    apply_native_theme(&app, theme);
    Ok(snapshot)
}

#[tauri::command(async)]
fn set_hide_earnings(app: AppHandle, core: CoreState<'_>, hide: bool) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_hide_earnings(hide))?.1)
}

#[tauri::command(async)]
fn mark_client_zone_prompt_done(app: AppHandle, core: CoreState<'_>) -> CmdResult<Snapshot> {
    Ok(core.change(&app, Service::mark_client_zone_prompt_done)?.1)
}

#[tauri::command(async)]
fn mark_sync_prompt_done(app: AppHandle, core: CoreState<'_>) -> CmdResult<Snapshot> {
    Ok(core.change(&app, Service::mark_sync_prompt_done)?.1)
}

#[tauri::command(async)]
fn dismiss_notice(core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    let mut s = guard(&svc);
    s.dismiss_notice(&id);
    Ok(s.snapshot())
}

fn usable_folder(root: &str) -> Result<(), CoreError> {
    let path = Path::new(root);
    if path.is_absolute() && path.is_dir() {
        Ok(())
    } else {
        Err(CoreError::Validation("that folder does not exist".into()))
    }
}

#[tauri::command(async)]
fn add_sync_target(
    app: AppHandle,
    core: CoreState<'_>,
    provider: SyncProvider,
    root: String,
) -> CmdResult<Snapshot> {
    usable_folder(&root)?;
    let snapshot = core
        .change(&app, |s| s.add_sync_target(SyncTarget { provider, root }))?
        .1;
    core.tell_sync(SyncMsg::Now);
    Ok(snapshot)
}

#[tauri::command(async)]
fn remove_sync_target(app: AppHandle, core: CoreState<'_>, root: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.remove_sync_target(&root))?.1)
}

#[tauri::command(async)]
fn pick_sync_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn preview_sync_folder(core: CoreState<'_>, root: String) -> CmdResult<FolderPreview> {
    let (own, now, hung) = {
        let svc = core.svc()?;
        let s = guard(&svc);
        (s.file().device_id.clone(), s.now(), s.hung_targets())
    };
    // A hung drive must not hold a command thread. Its own key: a sync of this folder may be running.
    bounded(
        &hung,
        &format!("preview:{root}"),
        TARGET_TIMEOUT,
        move || usable_folder(&root).map(|()| preview_folder(&RealIo, Path::new(&root), &own, now)),
    )
    .map_err(|e| CmdError::from(CoreError::Conflict(e)))?
    .map_err(CmdError::from)
}

/// Longest a folder move may take before the app reports it as stuck. Time logging is unaffected.
const MOVE_TIMEOUT: Duration = Duration::from_secs(600);

#[tauri::command(async)]
fn preview_sync_move(
    core: CoreState<'_>,
    from: Option<String>,
    to: String,
) -> CmdResult<MovePreview> {
    let (own, now, data, hung) = {
        let svc = core.svc()?;
        let s = guard(&svc);
        (
            s.file().device_id.clone(),
            s.now(),
            s.file().data.clone(),
            s.hung_targets(),
        )
    };
    bounded(&hung, &format!("preview:{to}"), TARGET_TIMEOUT, move || {
        usable_folder(&to).map(|()| {
            preview_move(
                &RealIo,
                from.as_deref().map(Path::new),
                Path::new(&to),
                &own,
                now,
                &data,
            )
        })
    })
    .map_err(|e| CmdError::from(CoreError::Conflict(e)))?
    .map_err(CmdError::from)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveProgress {
    step: String,
    done: usize,
    total: usize,
}

/// `replacing` true stops using `from` once the copy has checked out. Failure changes no setting.
#[tauri::command(async)]
fn move_sync_target(
    app: AppHandle,
    core: CoreState<'_>,
    from: Option<String>,
    to: String,
    provider: SyncProvider,
    replacing: bool,
) -> CmdResult<MoveResult> {
    usable_folder(&to)?;
    let svc = core.svc()?;
    let hung = guard(&svc).hung_targets();
    let target = SyncTarget {
        provider,
        root: to.clone(),
    };
    let events = app.clone();
    let outcome = bounded(&hung, &format!("move:{to}"), MOVE_TIMEOUT, move || {
        let replace = from.clone().filter(|_| replacing);
        move_target(
            &svc,
            &RealIo,
            from.as_deref(),
            &target,
            replace.as_deref(),
            &mut |step, done, total| {
                let _ = events.emit(
                    "sync-move-progress",
                    MoveProgress {
                        step: step.to_owned(),
                        done,
                        total,
                    },
                );
            },
        )
    })
    .map_err(|e| CmdError::from(CoreError::Conflict(e)))?
    .map_err(|e| CmdError::from(CoreError::Conflict(e)))?;
    core.tell_sync(SyncMsg::Now);
    let _ = app.emit("state-changed", ());
    Ok(outcome)
}

#[tauri::command(async)]
fn add_manual_entry(
    app: AppHandle,
    core: CoreState<'_>,
    input: ManualEntryInput,
) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.add_manual_entry(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn correct_segment(
    app: AppHandle,
    core: CoreState<'_>,
    input: CorrectionInput,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.correct_segment(&input))?.1)
}

#[tauri::command(async)]
fn void_segment(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    reason: String,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.void_segment(&id, &reason))?.1)
}

#[tauri::command(async)]
fn restore_segment(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    reason: String,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.restore_segment(&id, &reason))?.1)
}

#[tauri::command(async)]
fn decide_gap(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    decision: GapDecision,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.decide_gap(&id, decision))?.1)
}

#[tauri::command(async)]
fn mark_billable_pause(
    app: AppHandle,
    core: CoreState<'_>,
    input: PauseInput,
) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.mark_billable_pause(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn unmark_billable_pause(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.unmark_billable_pause(&id))?.1)
}

#[tauri::command(async)]
fn set_active_subtask(
    app: AppHandle,
    core: CoreState<'_>,
    task_id: String,
    subtask_id: Option<String>,
) -> CmdResult<Snapshot> {
    Ok(core
        .change(&app, |s| {
            s.set_active_subtask(&task_id, subtask_id.as_deref())
        })?
        .1)
}

#[tauri::command(async)]
fn save_tag(app: AppHandle, core: CoreState<'_>, input: TagInput) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.save_tag(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn delete_tag(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_tag(&id))?.1)
}

#[tauri::command(async)]
fn save_template(app: AppHandle, core: CoreState<'_>, input: TemplateInput) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.save_template(&input))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn delete_template(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_template(&id))?.1)
}

#[tauri::command(async)]
fn task_from_template(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    project_id: Option<String>,
) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.task_from_template(&id, project_id.as_deref()))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn summary_preview(core: CoreState<'_>, request: SummaryRequest) -> CmdResult<SummaryPreview> {
    Ok(guard(&*core.svc()?).summary_preview(&request)?)
}

#[tauri::command(async)]
fn create_summary(
    app: AppHandle,
    core: CoreState<'_>,
    request: SummaryRequest,
) -> CmdResult<WithId> {
    let (id, snapshot) = core.change(&app, |s| s.create_summary(&request))?;
    Ok(WithId { id, snapshot })
}

#[tauri::command(async)]
fn void_summary(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.void_summary(&id))?.1)
}

#[tauri::command(async)]
fn set_device_prefix(app: AppHandle, core: CoreState<'_>, prefix: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_device_prefix(&prefix))?.1)
}

#[tauri::command(async)]
fn export_summary_csv(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
) -> CmdResult<Option<String>> {
    let (text, name) = {
        let svc = core.svc()?;
        let s = guard(&svc);
        let data = &s.file().data;
        let b = data
            .summaries
            .get(&id)
            .ok_or(CoreError::NotFound("billing summary"))?;
        let project = data
            .projects
            .get(&b.project_id)
            .map_or("", |p| p.name.as_str());
        (
            summary::summary_csv(b, project, s.file().prefs.hide_earnings),
            format!("{}.csv", b.reference),
        )
    };
    save_via_dialog(&app, &name, "CSV file", "csv", text.as_bytes())
}

#[tauri::command(async)]
fn export_pdf(
    app: AppHandle,
    core: CoreState<'_>,
    request: PdfRequest,
) -> CmdResult<Option<String>> {
    let svc = core.svc()?;
    let (source, dir) = {
        let s = guard(&svc);
        (s.export_source(), s.data_dir().to_path_buf())
    };
    let logo = if request.use_logo {
        match std::fs::read(dir.join(PDF_LOGO_FILE)) {
            Ok(bytes) => Some(pdf::decode_logo(&bytes)?),
            Err(_) => None,
        }
    } else {
        None
    };
    let bytes = pdf::build(&source, &request, logo.as_ref())?;
    let name = format!("timesheet-{}-to-{}.pdf", request.from, request.to);
    save_via_dialog(&app, &name, "PDF document", "pdf", &bytes)
}

/// Keeps a checked copy of the logo in the data folder. It stays on this computer.
#[tauri::command(async)]
fn pick_pdf_logo(app: AppHandle, core: CoreState<'_>) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    let picked = app
        .dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok());
    if let Some(path) = picked {
        let size = std::fs::metadata(&path).map_err(CoreError::from)?.len();
        if size > pdf::MAX_LOGO_BYTES {
            return Err(CmdError::from(CoreError::Validation(
                "the logo must be 5 MB or smaller".into(),
            )));
        }
        let bytes = std::fs::read(&path).map_err(CoreError::from)?;
        pdf::decode_logo(&bytes)?;
        let dir = guard(&svc).data_dir().to_path_buf();
        let tmp = dir.join(format!("{PDF_LOGO_FILE}.tmp"));
        z_work_core::persist::write_atomic(&dir.join(PDF_LOGO_FILE), &tmp, &bytes)
            .map_err(CoreError::from)?;
    }
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

#[tauri::command(async)]
fn clear_pdf_logo(core: CoreState<'_>) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    let dir = guard(&svc).data_dir().to_path_buf();
    if let Err(e) = std::fs::remove_file(dir.join(PDF_LOGO_FILE))
        && e.kind() != std::io::ErrorKind::NotFound
    {
        return Err(CmdError::from(CoreError::from(e)));
    }
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

#[tauri::command(async)]
fn list_backups(core: CoreState<'_>) -> CmdResult<Vec<BackupInfo>> {
    Ok(guard(&*core.svc()?).list_backups()?)
}

#[tauri::command(async)]
fn restore_backup(app: AppHandle, core: CoreState<'_>, name: String) -> CmdResult<Snapshot> {
    let (_, snapshot) = core.change(&app, |s| s.restore_backup(&name))?;
    core.tell_sync(SyncMsg::Now);
    Ok(snapshot)
}

#[tauri::command(async)]
fn set_backup_keep(app: AppHandle, core: CoreState<'_>, keep: u32) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_backup_keep(keep))?.1)
}

#[tauri::command(async)]
fn snooze_reminder(core: CoreState<'_>, minutes: i64) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    let mut s = guard(&svc);
    s.snooze_reminder(minutes);
    Ok(s.snapshot())
}

#[tauri::command(async)]
fn get_audit(core: CoreState<'_>, entity_id: Option<String>) -> CmdResult<Vec<AuditEntry>> {
    Ok(guard(&*core.svc()?).audit_entries(entity_id.as_deref()))
}

#[tauri::command(async)]
fn sync_now(core: CoreState<'_>) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    {
        let _cycle = guard(&core.cycle_lock);
        run_cycle(&svc, &RealIo);
    }
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

fn save_via_dialog(
    app: &AppHandle,
    name: &str,
    label: &str,
    ext: &str,
    bytes: &[u8],
) -> CmdResult<Option<String>> {
    #[cfg(feature = "smoke")]
    let chosen = std::env::var("ZWT_SMOKE_EXPORT_DIR")
        .ok()
        .map(|d| PathBuf::from(d).join(name));
    #[cfg(not(feature = "smoke"))]
    let chosen: Option<PathBuf> = None;
    let chosen = chosen.or_else(|| {
        app.dialog()
            .file()
            .set_file_name(name)
            .add_filter(label, &[ext])
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
    });
    let Some(path) = chosen else { return Ok(None) };
    let tmp = path.with_extension("tmp-export");
    z_work_core::persist::write_atomic(&path, &tmp, bytes).map_err(CoreError::from)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command(async)]
fn export_xlsx(
    app: AppHandle,
    core: CoreState<'_>,
    request: ExportRequest,
) -> CmdResult<Option<String>> {
    let source = guard(&*core.svc()?).export_source();
    let bytes = xlsx::build(&source, &request)?;
    let name = format!(
        "zWorkTracker-{}.xlsx",
        source.now.datetime().format("%Y-%m-%d")
    );
    save_via_dialog(&app, &name, "Excel workbook", "xlsx", &bytes)
}

#[tauri::command(async)]
fn export_csv(
    app: AppHandle,
    core: CoreState<'_>,
    request: ExportRequest,
) -> CmdResult<Option<String>> {
    let source = guard(&*core.svc()?).export_source();
    let text = csv::build(&source, &request)?;
    let name = format!(
        "zWorkTracker-{}.csv",
        source.now.datetime().format("%Y-%m-%d")
    );
    save_via_dialog(&app, &name, "CSV file", "csv", text.as_bytes())
}

#[tauri::command(async)]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command(async)]
fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<bool> {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|e| CmdError {
        code: "autostart",
        message: e.to_string(),
    })?;
    Ok(enabled)
}

/// The first-hide notice was read: hide now.
#[tauri::command(async)]
fn ack_hide_notice(app: AppHandle, core: CoreState<'_>) {
    core.hide_pending.store(false, Ordering::SeqCst);
    hide_main(&app);
}

#[tauri::command(async)]
fn quit_app(app: AppHandle) {
    request_quit(&app);
}

#[cfg(feature = "smoke")]
mod smoke {
    //! Test-only commands for scripts/native-smoke.mjs. Compiled only with the `smoke` feature.
    use super::{AppHandle, Manager};

    #[tauri::command(async)]
    pub fn smoke_report(text: String) -> Result<(), String> {
        let path = std::env::var("ZWT_SMOKE_OUT").map_err(|e| e.to_string())?;
        std::fs::write(path, text).map_err(|e| e.to_string())
    }

    #[tauri::command(async)]
    pub fn smoke_close_window(app: AppHandle) -> Result<(), String> {
        app.get_webview_window("main")
            .ok_or("no window")?
            .close()
            .map_err(|e| e.to_string())
    }

    #[tauri::command(async)]
    pub fn smoke_window_visible(app: AppHandle) -> Result<bool, String> {
        app.get_webview_window("main")
            .ok_or("no window")?
            .is_visible()
            .map_err(|e| e.to_string())
    }

    #[tauri::command(async)]
    pub fn smoke_tray_toggle(app: AppHandle) {
        super::tray_toggle(&app);
    }

    /// Feeds the activity watcher a chosen idle time, so the real path can be driven.
    #[tauri::command(async)]
    pub fn smoke_observe(app: AppHandle, idle: u64, locked: Option<bool>, locked_ago: Option<i64>) {
        if let Some(core) = app.try_state::<std::sync::Arc<super::Core>>() {
            // Backdated, because a page left waiting for a real long lock can stop running.
            if let (Some(ago), Ok(svc)) = (locked_ago, core.service.as_ref()) {
                let _ = super::guard(svc).observe_lock_at(ago, locked);
            }
            super::observe_activity(&app, &core, Some(idle), locked);
        }
    }

    #[tauri::command(async)]
    pub fn smoke_emit_changed(app: AppHandle) -> Result<(), String> {
        use tauri::Emitter;
        app.emit("state-changed", ()).map_err(|e| e.to_string())
    }
}

fn tray_toggle(app: &AppHandle) {
    let Some(core) = app.try_state::<Arc<Core>>() else {
        return;
    };
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    let (state, warm) = {
        let s = guard(svc);
        (tray_state(s.file(), s.now(), chrono_tz::UTC), s.is_warm())
    };
    let Some(task) = state.task_id else {
        return;
    };
    let result = match toggle_route(state.action, warm) {
        ToggleRoute::Pause => guard(svc).pause_task(&task),
        ToggleRoute::Resume => guard(svc).resume_task(&task).map(|_| ()),
        ToggleRoute::OpenColdForm => {
            // Nothing starts here: the form decides, and Cancel leaves everything as it was.
            show_main(app);
            let _ = app.emit("cold-resume", ColdResume { task_id: task });
            return;
        }
        ToggleRoute::Nothing => return,
    };
    if let Err(e) = result {
        eprintln!("tray action failed: {e}");
    }
    core.tell_sync(SyncMsg::Changed);
    refresh_tray(app, &core);
    let _ = app.emit("state-changed", ());
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ColdResume {
    task_id: String,
}

fn build_tray(app: &AppHandle, core: &Core) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "No task running", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Pause / Resume", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &status, &toggle, &sep, &quit])?;
    let idle = Image::from_bytes(include_bytes!("../icons/tray-idle.png"))?.to_owned();
    let running = Image::from_bytes(include_bytes!("../icons/tray-running.png"))?.to_owned();
    let icon = TrayIconBuilder::with_id("main")
        .icon(idle.clone())
        .tooltip("No task running")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "toggle" => tray_toggle(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    *guard(&core.tray) = Some(Arc::new(TrayHandles {
        icon,
        status,
        toggle,
        idle,
        running,
        last_running: AtomicBool::new(false),
    }));
    Ok(())
}

fn os_idle_secs() -> Option<u64> {
    user_idle::UserIdle::get_time().ok().map(|t| t.as_seconds())
}

/// Notices sleep, clock jumps and time away, and asks about them when the user is back.
fn observe_activity(app: &AppHandle, core: &Core, idle: Option<u64>, locked: Option<bool>) {
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    let found = {
        let mut s = guard(svc);
        // The lock first: a tick made while locked belongs to the lock.
        let lock = s.observe_lock(locked);
        let activity = s.observe_activity(idle);
        match (lock, activity) {
            (Ok(a), Ok(b)) => Ok(a || b),
            (Err(e), _) | (_, Err(e)) => Err(e),
        }
    };
    match found {
        Ok(true) => {
            notify(
                app,
                "Were you working while away? That time won't count until you confirm it.",
            );
            let _ = app.emit("state-changed", ());
            core.tell_sync(SyncMsg::Changed);
        }
        Ok(false) => {}
        Err(e) => eprintln!("time away could not be saved: {e}"),
    }
}

/// Budget alerts, the forgotten-timer reminder and today's backup.
fn run_chores(app: &AppHandle, core: &Core) {
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    let alerts = {
        let mut s = guard(svc);
        if let Err(e) = s.run_daily_backup() {
            eprintln!("daily backup failed: {e}");
        }
        s.take_alerts()
    };
    if !alerts.is_empty() {
        let _ = app.emit("state-changed", ());
    }
    for text in alerts {
        notify(app, &text);
    }
}

fn notify(app: &AppHandle, text: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title("zWorkTracker")
        .body(text)
        .show()
    {
        eprintln!("notification failed: {e}");
    }
}

/// Heartbeat and tray refresh, independent of the webview so they run while it is hidden. Separate
/// threads, because a tray call stuck on the UI thread must never delay the heartbeat.
fn spawn_ticker(app: AppHandle, core: Arc<Core>) {
    let beat = Arc::clone(&core);
    std::thread::spawn(move || {
        while !beat.exit_done.load(Ordering::SeqCst) {
            std::thread::sleep(HEARTBEAT);
            if let Ok(svc) = beat.service.as_ref()
                && let Err(e) = guard(svc).heartbeat()
            {
                eprintln!("heartbeat could not be saved: {e}");
            }
        }
    });
    let watcher = Arc::clone(&core);
    let watcher_app = app.clone();
    std::thread::spawn(move || {
        while !watcher.exit_done.load(Ordering::SeqCst) {
            std::thread::sleep(ACTIVITY_TICK);
            observe_activity(
                &watcher_app,
                &watcher,
                os_idle_secs(),
                z_work_session::is_locked(),
            );
        }
    });
    let chores = Arc::clone(&core);
    let chores_app = app.clone();
    std::thread::spawn(move || {
        while !chores.exit_done.load(Ordering::SeqCst) {
            run_chores(&chores_app, &chores);
            std::thread::sleep(CHORES_TICK);
        }
    });
    std::thread::spawn(move || {
        while !core.exit_done.load(Ordering::SeqCst) {
            std::thread::sleep(TRAY_TICK);
            refresh_tray(&app, &core);
        }
    });
}

/// Runs the schedule in `SyncSchedule`. Failures only ever reach the status, and retry with backoff.
fn spawn_sync(app: AppHandle, core: Arc<Core>, svc: Arc<Mutex<Service>>) {
    let (tx, rx) = mpsc::channel();
    *guard(&core.sync) = Some(tx);
    std::thread::spawn(move || {
        let started = Instant::now();
        let clock = || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut schedule = SyncSchedule::new(clock());
        loop {
            let wait = schedule.next_wake().saturating_sub(clock());
            match rx.recv_timeout(Duration::from_millis(wait)) {
                Ok(SyncMsg::Changed) => schedule.on_major_action(clock()),
                Ok(SyncMsg::Edited) => schedule.on_text_edit(clock()),
                Ok(SyncMsg::Now) => schedule.on_now(clock()),
                Ok(SyncMsg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {}
            }
            if !schedule.is_due(clock()) {
                continue;
            }
            let changed = {
                let _cycle = guard(&core.cycle_lock);
                run_cycle(&svc, &RealIo)
            };
            let failed = guard(&svc).any_target_failed();
            schedule.cycle_done(clock(), failed);
            if changed {
                refresh_tray(&app, &core);
            }
            // Status also changes without data changing, so the UI always hears about it.
            let _ = app.emit("state-changed", ());
        }
    });
}

fn data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    #[cfg(feature = "smoke")]
    if let Ok(dir) = std::env::var("ZWT_SMOKE_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_data_dir()
}

fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "This PC".to_owned())
}

/// A clear message instead of a blank window when the one system dependency is missing.
#[cfg(windows)]
fn webview_available() -> bool {
    if tauri::webview_version().is_ok() {
        return true;
    }
    rfd::MessageDialog::new()
        .set_title("zWorkTracker")
        .set_level(rfd::MessageLevel::Error)
        .set_description(
            "Microsoft Edge WebView2 Runtime was not found or is disabled. It normally comes with Windows 11.\n\n\
             Run Windows Update or reinstall the WebView2 Runtime from Microsoft, then open zWorkTracker again. Your data is safe.",
        )
        .show();
    false
}

#[cfg(not(windows))]
fn webview_available() -> bool {
    true
}

pub fn run() {
    let quit_only = std::env::args().any(|a| a == QUIT_ARG);
    if !webview_available() {
        return;
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch shows the existing window; the installer's `--quit` asks it to exit.
            if args.iter().any(|a| a == QUIT_ARG) {
                request_quit(app);
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .setup(move |app| {
            if quit_only {
                // `--quit` with nothing running: there is nothing to do.
                app.handle().exit(0);
                return Ok(());
            }
            let handle = app.handle().clone();
            let dir = data_dir(&handle)?;
            let service = Service::open(&dir, Arc::new(SystemClock), &device_name())
                .map_err(|e| e.to_string());
            let core = Arc::new(Core {
                service: service.map(|mut s| {
                    s.set_system_zone(
                        iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned()),
                    );
                    s.set_detected(detect(&RealEnv, host_os()));
                    Arc::new(Mutex::new(s))
                }),
                sync: Mutex::new(None),
                tray: Mutex::new(None),
                quitting: AtomicBool::new(false),
                exit_done: AtomicBool::new(false),
                hide_pending: AtomicBool::new(false),
                cycle_lock: Arc::new(Mutex::new(())),
            });
            app.manage(Arc::clone(&core));
            build_tray(&handle, &core)?;
            refresh_tray(&handle, &core);
            spawn_ticker(handle.clone(), Arc::clone(&core));
            if let Ok(svc) = &core.service {
                spawn_sync(handle.clone(), Arc::clone(&core), Arc::clone(svc));
                let theme = guard(svc).file().prefs.theme;
                apply_native_theme(&handle, theme);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                #[cfg(feature = "smoke")]
                if let Ok(path) = std::env::var("ZWT_SMOKE_SCRIPT")
                    && let Ok(js) = std::fs::read_to_string(path)
                {
                    let target = w.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(1500));
                        let _ = target.eval(js);
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let Some(core) = app.try_state::<Arc<Core>>() else {
                return;
            };
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if handle_close(app, &core) {
                        api.prevent_close();
                    }
                }
                WindowEvent::Focused(true) => core.tell_sync(SyncMsg::Now),
                _ => {}
            }
        });

    #[cfg(not(feature = "smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_snapshot,
        create_project,
        update_project,
        set_project_archived,
        delete_project,
        create_task,
        update_task,
        patch_task,
        delete_draft,
        start_task,
        resume_task,
        pause_task,
        stop_task,
        save_shift,
        delete_shift,
        set_rate,
        set_rounding,
        delete_rounding,
        set_setting,
        set_theme,
        set_hide_earnings,
        mark_client_zone_prompt_done,
        mark_sync_prompt_done,
        dismiss_notice,
        add_sync_target,
        remove_sync_target,
        pick_sync_folder,
        preview_sync_folder,
        preview_sync_move,
        move_sync_target,
        add_manual_entry,
        correct_segment,
        void_segment,
        restore_segment,
        decide_gap,
        mark_billable_pause,
        unmark_billable_pause,
        set_active_subtask,
        save_tag,
        delete_tag,
        save_template,
        delete_template,
        task_from_template,
        summary_preview,
        create_summary,
        void_summary,
        set_device_prefix,
        export_summary_csv,
        export_pdf,
        pick_pdf_logo,
        clear_pdf_logo,
        list_backups,
        restore_backup,
        set_backup_keep,
        snooze_reminder,
        get_audit,
        sync_now,
        export_xlsx,
        export_csv,
        get_autostart,
        set_autostart,
        ack_hide_notice,
        quit_app
    ]);
    #[cfg(feature = "smoke")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_snapshot,
        create_project,
        update_project,
        set_project_archived,
        delete_project,
        create_task,
        update_task,
        patch_task,
        delete_draft,
        start_task,
        resume_task,
        pause_task,
        stop_task,
        save_shift,
        delete_shift,
        set_rate,
        set_rounding,
        delete_rounding,
        set_setting,
        set_theme,
        set_hide_earnings,
        mark_client_zone_prompt_done,
        mark_sync_prompt_done,
        dismiss_notice,
        add_sync_target,
        remove_sync_target,
        pick_sync_folder,
        preview_sync_folder,
        preview_sync_move,
        move_sync_target,
        add_manual_entry,
        correct_segment,
        void_segment,
        restore_segment,
        decide_gap,
        mark_billable_pause,
        unmark_billable_pause,
        set_active_subtask,
        save_tag,
        delete_tag,
        save_template,
        delete_template,
        task_from_template,
        summary_preview,
        create_summary,
        void_summary,
        set_device_prefix,
        export_summary_csv,
        export_pdf,
        pick_pdf_logo,
        clear_pdf_logo,
        list_backups,
        restore_backup,
        set_backup_keep,
        snooze_reminder,
        get_audit,
        sync_now,
        export_xlsx,
        export_csv,
        get_autostart,
        set_autostart,
        ack_hide_notice,
        quit_app,
        smoke::smoke_report,
        smoke::smoke_close_window,
        smoke::smoke_window_visible,
        smoke::smoke_tray_toggle,
        smoke::smoke_observe,
        smoke::smoke_emit_changed
    ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("could not start zWorkTracker: {e}");
            std::process::exit(1);
        }
    };

    app.run(|handle, event| match event {
        RunEvent::Exit => {
            if let Some(core) = handle.try_state::<Arc<Core>>() {
                finish_exit(&core);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(handle),
        _ => {}
    });
}
