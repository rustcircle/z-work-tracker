//! Tauri shell around `z-work-core`: commands, tray, heartbeat, sync and lease threads and the real-exit path.
//! Timers live in Rust threads, so they keep going while the window is hidden.

mod startup_task;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use startup_task::{AutostartInfo, AutostartState};
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
use z_work_core::epoch;
use z_work_core::lease::LEASE_IO_LIMIT;
use z_work_core::lease_io::{
    self, TakeOverExpected, TakeOverMode, TakeOverPreview, TakeOverResult, TickOutcome,
};
use z_work_core::machine::{
    PatchOutcome, ProjectInput, RateInput, RoundingInput, ShiftInput, TaskExpected, TaskInput,
    TaskPatch,
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
    CloseDecision, ToggleRoute, TrayAction, TrayCache, TrayState, close_decision, toggle_route,
    tray_state,
};
use z_work_core::versions::{self, RestorePreview, VERSION_IO_LIMIT, VersionList};
use z_work_core::view::Snapshot;
use z_work_core::{CoreError, SystemClock, csv, xlsx};

const HEARTBEAT: Duration = Duration::from_secs(30);
const EXIT_SYNC_LIMIT: Duration = Duration::from_secs(5);
/// How often the lease thread looks whether a pass is due: a read every minute, a beat every two minutes while holding.
const LEASE_TICK: Duration = Duration::from_secs(15);
/// The release written when quitting, out of `EXIT_SYNC_LIMIT`, so another computer can go ahead without a take over.
const LEASE_RELEASE_LIMIT: Duration = Duration::from_millis(1500);
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

enum LeaseMsg {
    /// Something may have made a pass due, such as a change that needs the lease claimed: one runs if it is.
    Wake,
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
    lease: Mutex<Option<Sender<LeaseMsg>>>,
    tray: Mutex<Option<Arc<TrayHandles>>>,
    /// Wakes the tray thread. It alone writes the tray, so an older text can never overwrite a newer one.
    tray_wake: Mutex<Option<Sender<()>>>,
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

    /// Also wakes the lease thread, unless stopping: a data change may need the lease claimed, which happens at once.
    fn tell_sync(&self, msg: SyncMsg) {
        if !matches!(msg, SyncMsg::Stop) {
            self.tell_lease(LeaseMsg::Wake);
        }
        if let Some(tx) = guard(&self.sync).as_ref() {
            let _ = tx.send(msg);
        }
    }

    fn tell_lease(&self, msg: LeaseMsg) {
        if let Some(tx) = guard(&self.lease).as_ref() {
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
    fn edit<R>(
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
        self.tell_sync(SyncMsg::Edited);
        refresh_tray(app, self);
        Ok((out, snap))
    }
}

/// Asks the tray thread to look now, for example after a data change. Tray calls can wait on the UI
/// thread, so nothing here waits for them.
fn refresh_tray(_app: &AppHandle, core: &Core) {
    if let Some(tx) = guard(&core.tray_wake).as_ref() {
        let _ = tx.send(());
    }
}

/// Writes whatever changed to the tray, and returns how long until its text can next change by itself.
fn update_tray(core: &Core, cache: &mut TrayCache) -> Duration {
    const IDLE: Duration = Duration::from_secs(60);
    let Ok(svc) = core.service.as_ref() else {
        return IDLE;
    };
    let (state, wait) = {
        let s = guard(svc);
        let zone = s.viewing_zone();
        let now = s.now();
        let state = cache.refresh(s.file(), s.revision(), now, zone);
        (state, Duration::from_secs(cache.next_wake_secs(now)))
    };
    if let Some(state) = state {
        show_tray_state(core, &state);
    }
    wait
}

fn show_tray_state(core: &Core, state: &TrayState) {
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

/// The one way the app really ends: close open segments, release the lease, sync once and write the version due,
/// all within a limit, then exit.
fn finish_exit(core: &Core) {
    if core.exit_done.swap(true, Ordering::SeqCst) {
        return;
    }
    core.tell_lease(LeaseMsg::Stop);
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    if let Err(e) = guard(svc).on_exit() {
        eprintln!("could not close the running segment at exit: {e}");
    }
    core.tell_sync(SyncMsg::Stop);
    let svc = Arc::clone(svc);
    let lock = Arc::clone(&core.cycle_lock);
    let deadline = Instant::now() + EXIT_SYNC_LIMIT;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        lease_io::release(&svc, &RealIo, LEASE_RELEASE_LIMIT);
        let _cycle = guard(&lock);
        run_cycle(&svc, &RealIo);
        if let Some(left) = deadline.checked_duration_since(Instant::now()) {
            versions::run_at_quit(&svc, &RealIo, left);
        }
        let _ = tx.send(());
    });
    // A stuck network drive must not hold the app open.
    let _ = rx.recv_timeout(EXIT_SYNC_LIMIT);
}

/// One sync, then the version that is due, if any, both under the cycle lock.
fn sync_cycle(core: &Core, svc: &Mutex<Service>) -> bool {
    let _cycle = guard(&core.cycle_lock);
    let changed = run_cycle(svc, &RealIo);
    versions::run_due(svc, &RealIo, VERSION_IO_LIMIT);
    changed
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

/// A saved project or tag, with the colour it got and what was asked for if that had to change.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedColor {
    id: String,
    snapshot: Snapshot,
    color: String,
    replaced_from: Option<String>,
}

#[tauri::command(async)]
fn create_project(
    app: AppHandle,
    core: CoreState<'_>,
    input: ProjectInput,
) -> CmdResult<SavedColor> {
    let ((id, replaced_from), snapshot) = core.change(&app, |s| {
        let id = s.create_project(&input)?;
        Ok((id, s.take_color_replaced()))
    })?;
    let color = project_color(&snapshot, &id);
    Ok(SavedColor {
        id,
        snapshot,
        color,
        replaced_from,
    })
}

fn project_color(snapshot: &Snapshot, id: &str) -> String {
    snapshot
        .projects
        .iter()
        .find(|p| p.id == id)
        .map_or_else(String::new, |p| p.color.clone())
}

#[tauri::command(async)]
fn update_project(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    input: ProjectInput,
) -> CmdResult<SavedColor> {
    let (replaced_from, snapshot) = core.change(&app, |s| {
        s.update_project(&id, &input)?;
        Ok(s.take_color_replaced())
    })?;
    let color = project_color(&snapshot, &id);
    Ok(SavedColor {
        id,
        snapshot,
        color,
        replaced_from,
    })
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
    Ok(core.edit(&app, |s| s.update_task(&id, &input))?.1)
}

/// The snapshot and the outcome come from one hold of the store's lock.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PatchReply {
    snapshot: Snapshot,
    #[serde(flatten)]
    outcome: PatchOutcome,
}

#[tauri::command(async)]
fn patch_task(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    patch: TaskPatch,
    expected: Option<TaskExpected>,
) -> CmdResult<PatchReply> {
    let expected = expected.unwrap_or_default();
    let (outcome, snapshot) = core.edit(&app, |s| s.patch_task(&id, &patch, &expected))?;
    Ok(PatchReply { snapshot, outcome })
}

#[tauri::command(async)]
fn delete_draft(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_draft(&id))?.1)
}

#[tauri::command(async)]
fn delete_task(app: AppHandle, core: CoreState<'_>, id: String) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.delete_task(&id))?.1)
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
fn delete_rate_version(
    app: AppHandle,
    core: CoreState<'_>,
    id: String,
    confirm_retroactive: bool,
) -> CmdResult<Snapshot> {
    Ok(core
        .change(&app, |s| s.delete_rate_version(&id, confirm_retroactive))?
        .1)
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
    // A lease held here is let go in that folder first, so a computer reading only that folder finds it free.
    lease_io::release_one(&*core.svc()?, &RealIo, &root, LEASE_IO_LIMIT);
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
    // A folder connected already under another spelling is refused before any lease is let go.
    guard(&svc).folder_gate(&to)?;
    // The folder being replaced is left as `remove_sync_target` leaves one. If the move then fails, the lease comes back
    // to it at a later pass.
    if let Some(old) = from.as_deref().filter(|_| replacing) {
        lease_io::release_one(&svc, &RealIo, old, LEASE_IO_LIMIT);
    }
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
fn save_tag(app: AppHandle, core: CoreState<'_>, input: TagInput) -> CmdResult<SavedColor> {
    let ((id, replaced_from), snapshot) = core.change(&app, |s| {
        let id = s.save_tag(&input)?;
        Ok((id, s.take_color_replaced()))
    })?;
    let color = snapshot
        .tags
        .iter()
        .find(|t| t.id == id)
        .map_or_else(String::new, |t| t.color.clone());
    Ok(SavedColor {
        id,
        snapshot,
        color,
        replaced_from,
    })
}

#[tauri::command(async)]
fn revert_shift_version(
    app: AppHandle,
    core: CoreState<'_>,
    version_id: String,
) -> CmdResult<Snapshot> {
    Ok(core
        .change(&app, |s| s.revert_shift_version(&version_id))?
        .1)
}

#[tauri::command(async)]
fn request_remote_pause(
    app: AppHandle,
    core: CoreState<'_>,
    task_id: String,
) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.request_remote_pause(&task_id))?.1)
}

/// What is being typed, kept where a shutdown can't lose it. Doesn't trigger a sync.
#[tauri::command(async)]
fn stash_draft(
    core: CoreState<'_>,
    task_id: String,
    description: serde_json::Value,
    expected: Option<serde_json::Value>,
) -> CmdResult<()> {
    let base = expected.unwrap_or(serde_json::Value::Null);
    Ok(guard(&*core.svc()?).stash_draft(&task_id, &description, &base)?)
}

#[tauri::command(async)]
fn clear_draft(core: CoreState<'_>, task_id: String) -> CmdResult<()> {
    Ok(guard(&*core.svc()?).clear_draft(&task_id)?)
}

/// The words of an edit whose task no longer exists, shown in a notice. Doesn't trigger a sync.
#[tauri::command(async)]
fn keep_unsaved_words(
    core: CoreState<'_>,
    task_id: String,
    name: String,
    new_name: Option<String>,
    description: Option<serde_json::Value>,
) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    let mut s = guard(&svc);
    s.keep_unsaved_words(&task_id, &name, new_name.as_deref(), description.as_ref());
    Ok(s.snapshot())
}

#[tauri::command(async)]
fn set_setup_step(app: AppHandle, core: CoreState<'_>, step: u32) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.set_setup_step(step))?.1)
}

#[tauri::command(async)]
fn finish_setup(app: AppHandle, core: CoreState<'_>) -> CmdResult<Snapshot> {
    Ok(core.change(&app, |s| s.finish_setup())?.1)
}

/// Shows the window once, after the page has first painted, so it does not appear as an empty frame. The first frame can
/// still be the light loading page: the theme is applied when the snapshot arrives, after that.
static WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);

fn show_main_once(app: &AppHandle) {
    if !WINDOW_SHOWN.swap(true, Ordering::SeqCst)
        && let Some(w) = app.get_webview_window("main")
    {
        let _ = w.show();
    }
}

#[tauri::command]
fn window_ready(app: AppHandle) {
    show_main_once(&app);
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
) -> CmdResult<pdf::PdfSaved> {
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
    let sheet = pdf::build(&source, &request, logo.as_ref())?;
    let name = format!("timesheet-{}-to-{}.pdf", request.from, request.to);
    let path = save_via_dialog(&app, &name, "PDF document", "pdf", &sheet.bytes)?;
    Ok(pdf::PdfSaved {
        path,
        unprintable: sheet.unprintable.iter().map(char::to_string).collect(),
    })
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

/// "Sync now", and "Check again" on the read-only banner.
#[tauri::command(async)]
fn sync_now(app: AppHandle, core: CoreState<'_>) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    // Who holds the lease first, read now whether due or not, so the answer says it. A timer closed because another
    // computer holds it goes out with this sync.
    let lease = lease_io::check_now(&svc, &RealIo, LEASE_IO_LIMIT);
    let changed = sync_cycle(&core, &svc);
    after_cycle(&app, &core, &svc, changed || lease.lost);
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

/// Reads the lease folders afresh for the take over dialog.
#[tauri::command(async)]
fn lease_preview_take_over(app: AppHandle, core: CoreState<'_>) -> CmdResult<TakeOverPreview> {
    let svc = core.svc()?;
    let before = guard(&svc).revision();
    let preview = lease_io::preview_take_over(&svc, &RealIo, LEASE_IO_LIMIT);
    // The fresh read may have changed what the banner says.
    if guard(&svc).revision() != before {
        let _ = app.emit("state-changed", ());
    }
    Ok(preview)
}

#[tauri::command(async)]
fn lease_take_over(
    app: AppHandle,
    core: CoreState<'_>,
    expected: TakeOverExpected,
    mode: TakeOverMode,
) -> CmdResult<TakeOverResult> {
    let result = lease_io::take_over(&*core.svc()?, &RealIo, expected, mode, LEASE_IO_LIMIT)?;
    // At once, so the other computer sees the new holder and the closed segments before its owner goes on there.
    core.tell_sync(SyncMsg::Now);
    refresh_tray(&app, &core);
    Ok(result)
}

/// "Release now".
#[tauri::command(async)]
fn lease_release(core: CoreState<'_>) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    lease_io::release_now(&svc, &RealIo, LEASE_IO_LIMIT)?;
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

#[tauri::command(async)]
fn settle_lost_segment(
    app: AppHandle,
    core: CoreState<'_>,
    segment_id: String,
    reason: String,
) -> CmdResult<Snapshot> {
    Ok(core
        .change(&app, |s| s.settle_lost_segment(&segment_id, &reason))?
        .1)
}

/// `extra_root` also looks in a folder that is no longer connected.
#[tauri::command(async)]
fn list_versions(core: CoreState<'_>, extra_root: Option<String>) -> CmdResult<VersionList> {
    Ok(versions::list(
        &*core.svc()?,
        &RealIo,
        extra_root.as_deref(),
        VERSION_IO_LIMIT,
    ))
}

#[tauri::command(async)]
fn read_version_changes(core: CoreState<'_>, root: String, name: String) -> CmdResult<String> {
    Ok(versions::read_changes_within(
        &*core.svc()?,
        &RealIo,
        &root,
        &name,
        VERSION_IO_LIMIT,
    )?)
}

#[tauri::command(async)]
fn save_version_now(core: CoreState<'_>) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    {
        let _cycle = guard(&core.cycle_lock);
        versions::save_now(&svc, &RealIo, VERSION_IO_LIMIT)?;
    }
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

#[tauri::command(async)]
fn preview_restore_version(
    core: CoreState<'_>,
    root: String,
    name: String,
) -> CmdResult<RestorePreview> {
    Ok(versions::preview_restore(
        &*core.svc()?,
        &RealIo,
        &root,
        &name,
        VERSION_IO_LIMIT,
    )?)
}

/// Restores a version on every computer that syncs with these folders.
#[tauri::command(async)]
fn restore_version(
    app: AppHandle,
    core: CoreState<'_>,
    root: String,
    name: String,
) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    {
        let _cycle = guard(&core.cycle_lock);
        versions::restore(&svc, &RealIo, &root, &name, VERSION_IO_LIMIT)?;
    }
    // The other computers follow it from the next sync, so that is now. This wakes the lease thread too.
    core.tell_sync(SyncMsg::Now);
    refresh_tray(&app, &core);
    let snapshot = guard(&svc).snapshot();
    Ok(snapshot)
}

/// The answer for a folder whose data was restored while this computer has data from before that.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum JoinChoice {
    Follow,
    Keep,
}

#[tauri::command(async)]
fn resolve_join(
    app: AppHandle,
    core: CoreState<'_>,
    root: String,
    choice: JoinChoice,
) -> CmdResult<Snapshot> {
    let svc = core.svc()?;
    {
        let _cycle = guard(&core.cycle_lock);
        let follow = matches!(choice, JoinChoice::Follow);
        epoch::resolve_join(&svc, &RealIo, &root, follow, TARGET_TIMEOUT)?;
    }
    core.tell_sync(SyncMsg::Now);
    refresh_tray(&app, &core);
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

/// Whether this copy runs from the Microsoft Store package. Asked once, as it can't change while running.
fn packaged() -> bool {
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(|| z_work_session::package_full_name().is_some())
}

/// The AppUserModelID toasts must carry in the Store build. None in the installer build.
#[cfg(windows)]
fn packaged_aumid() -> Option<&'static str> {
    static AUMID: OnceLock<Option<String>> = OnceLock::new();
    AUMID
        .get_or_init(|| {
            packaged()
                .then(z_work_session::application_user_model_id)
                .flatten()
        })
        .as_deref()
}

/// Start with Windows as it stands: from Windows for the Store build, else from the autostart plugin.
fn autostart_state(app: &AppHandle) -> AutostartState {
    #[cfg(windows)]
    if packaged() {
        return startup_task::state();
    }
    if app.autolaunch().is_enabled().unwrap_or(false) {
        AutostartState::On
    } else {
        AutostartState::Off
    }
}

#[tauri::command(async)]
fn get_autostart(app: AppHandle) -> bool {
    autostart_state(&app).is_on()
}

#[tauri::command(async)]
fn get_autostart_info(app: AppHandle) -> AutostartInfo {
    AutostartInfo::of(packaged(), autostart_state(&app))
}

/// Windows' own list of startup apps, where only the user can turn back on what they turned off.
#[tauri::command(async)]
fn open_startup_settings() -> CmdResult<()> {
    open_startup_page()
}

#[cfg(windows)]
fn open_startup_page() -> CmdResult<()> {
    open_in_shell("ms-settings:startupapps").map_err(|e| CmdError {
        code: "io",
        message: format!("could not open Startup settings: {e}"),
    })
}

#[cfg(not(windows))]
fn open_startup_page() -> CmdResult<()> {
    Err(CmdError {
        code: "unsupported",
        message: "Startup settings are a Windows page.".to_owned(),
    })
}

/// Hands a URL or a Settings page to Windows, as a click on a link would.
#[cfg(windows)]
fn open_in_shell(target: &str) -> std::io::Result<()> {
    let mut child = std::process::Command::new("explorer.exe")
        .arg(target)
        .spawn()?;
    // Explorer passes it on and ends; nothing here needs its answer.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command(async)]
fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<bool> {
    // The Store build's Run entry would be private to it, so it asks Windows, which can refuse.
    #[cfg(windows)]
    if packaged() {
        let state = if enabled {
            startup_task::request_enable()
        } else {
            startup_task::disable()
        };
        return startup_task::outcome(enabled, state).map_err(|why| CmdError {
            code: "autostart",
            message: why.to_owned(),
        });
    }
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

    /// Makes saves of the store fail for real, or lets them through again: a blocked save fails inside its
    /// transaction, through the same path as a full disk, and the first save after writes every row.
    #[tauri::command(async)]
    pub fn smoke_block_saves(app: AppHandle, blocked: bool) -> Result<(), String> {
        let core = app
            .try_state::<std::sync::Arc<super::Core>>()
            .ok_or("the app hasn't started")?;
        let svc = core.service.as_ref().map_err(Clone::clone)?;
        super::guard(svc).set_saves_blocked(blocked);
        Ok(())
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
    match result {
        // Nothing changed. The window's banner says who holds the lease and offers the way out.
        Err(e @ CoreError::ReadOnly { .. }) => {
            notify(app, &e.to_string());
            show_main(app);
            return;
        }
        Err(e) => eprintln!("tray action failed: {e}"),
        Ok(()) => {}
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
            refresh_tray(app, core);
        }
        Ok(false) => {}
        Err(e) => eprintln!("time away could not be saved: {e}"),
    }
}

/// Budget alerts, the forgotten-timer reminder, today's backup, and a change of the computer's time zone.
fn run_chores(app: &AppHandle, core: &Core) {
    let Ok(svc) = core.service.as_ref() else {
        return;
    };
    let reported_zone = iana_time_zone::get_timezone().ok();
    let (zone_changed, backed_up, alerts) = {
        let mut s = guard(svc);
        let zone_changed = s.observe_system_zone(reported_zone);
        let backed_up = s.run_daily_backup().unwrap_or_else(|e| {
            eprintln!("daily backup failed: {e}");
            false
        });
        (zone_changed, backed_up, s.take_alerts())
    };
    if zone_changed {
        refresh_tray(app, core);
    }
    // A new backup is in no snapshot, but the list in Settings reads again when one arrives.
    if zone_changed || backed_up || !alerts.is_empty() {
        let _ = app.emit("state-changed", ());
    }
    for text in alerts {
        notify(app, &text);
    }
}

/// Whether someone is looking at the window. Open behind another app reports as visible, so it needs focus.
fn main_window_in_view(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
    })
}

/// What every sync cycle owes the tray and the user, whoever started it.
fn after_cycle(app: &AppHandle, core: &Core, svc: &Mutex<Service>, changed: bool) {
    if changed {
        refresh_tray(app, core);
    }
    // The banner covers a window in view. Nobody sees that in the tray, so say it there too.
    let alerts = guard(svc).take_pause_alerts();
    if !main_window_in_view(app) {
        for text in alerts {
            notify(app, &text);
        }
    }
}

/// What a lease pass owes the page and the user, whoever ran it.
fn after_lease(app: &AppHandle, core: &Core, svc: &Mutex<Service>, outcome: TickOutcome) {
    if outcome.lost {
        // Another computer holds the lease now and a timer here may have closed: told as after a sync, and the
        // closed timer goes out with the next one.
        after_cycle(app, core, svc, true);
        core.tell_sync(SyncMsg::Changed);
    }
    if outcome.changed || outcome.lost {
        let _ = app.emit("state-changed", ());
    }
}

fn notify(app: &AppHandle, text: &str) {
    // In the Store build Windows knows the app by its package's AppUserModelID, which the notification plugin doesn't
    // pass, and the plugin drops the answer, so a failure there would be silent.
    #[cfg(windows)]
    if let Some(aumid) = packaged_aumid() {
        match tauri_winrt_notification::Toast::new(aumid)
            .title("zWorkTracker")
            .text1(text)
            .show()
        {
            Ok(()) => return,
            Err(e) => eprintln!("toast failed, trying the plugin: {e}"),
        }
    }
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
    let (tray_wake, tray_woken) = mpsc::channel();
    *guard(&core.tray_wake) = Some(tray_wake);
    std::thread::spawn(move || {
        let mut cache = TrayCache::default();
        while !core.exit_done.load(Ordering::SeqCst) {
            let wait = update_tray(&core, &mut cache);
            let _ = tray_woken.recv_timeout(wait);
            while tray_woken.try_recv().is_ok() {}
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
            let changed = sync_cycle(&core, &svc);
            let failed = guard(&svc).any_target_failed();
            schedule.cycle_done(clock(), failed);
            after_cycle(&app, &core, &svc, changed);
            // Status also changes without data changing, so the UI always hears about it.
            let _ = app.emit("state-changed", ());
        }
    });
}

/// Who may change the data: a pass over the lease folders whenever one is due, looked at every `LEASE_TICK` and
/// whenever data changes. Each folder's I/O has its own time limit, and the service lock is never held across it.
fn spawn_lease(app: AppHandle, core: Arc<Core>, svc: Arc<Mutex<Service>>) {
    let (tx, rx) = mpsc::channel();
    *guard(&core.lease) = Some(tx);
    std::thread::spawn(move || {
        loop {
            if core.exit_done.load(Ordering::SeqCst) {
                return;
            }
            // The first look after opening is due at once.
            let outcome = lease_io::run_tick(&svc, &RealIo, LEASE_IO_LIMIT);
            after_lease(&app, &core, &svc, outcome);
            match rx.recv_timeout(LEASE_TICK) {
                Ok(LeaseMsg::Wake) | Err(RecvTimeoutError::Timeout) => {}
                Ok(LeaseMsg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            }
            // Wakes that piled up are one pass.
            while let Ok(msg) = rx.try_recv() {
                if matches!(msg, LeaseMsg::Stop) {
                    return;
                }
            }
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

/// A clear message instead of a blank window when the one system dependency is missing. `quiet` for the installer's
/// `--quit`, which has nothing to ask to quit then: a running copy would have needed the runtime.
#[cfg(windows)]
fn webview_available(quiet: bool) -> bool {
    use z_work_core::webview::{WebviewCheck, decide, missing_text};
    let found = tauri::webview_version().map_err(|e| e.to_string());
    if decide(found.as_deref().map_err(String::as_str)) == WebviewCheck::Ready {
        return true;
    }
    if !quiet {
        show_start_problem(&missing_text(), true);
    }
    false
}

#[cfg(not(windows))]
const fn webview_available(_quiet: bool) -> bool {
    true
}

/// A native message, as there is no window to show one in, offering the runtime's download page when that is the cure.
#[cfg(windows)]
fn show_start_problem(text: &str, offer_download: bool) {
    use z_work_core::webview::{CLOSE, DOWNLOAD_URL, OPEN_DOWNLOAD};
    let dialog = rfd::MessageDialog::new()
        .set_title("zWorkTracker")
        .set_level(rfd::MessageLevel::Error)
        .set_description(text);
    if !offer_download {
        let _ = dialog.show();
        return;
    }
    let choice = dialog
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            OPEN_DOWNLOAD.to_owned(),
            CLOSE.to_owned(),
        ))
        .show();
    if choice == rfd::MessageDialogResult::Custom(OPEN_DOWNLOAD.to_owned())
        && let Err(e) = open_in_shell(DOWNLOAD_URL)
    {
        eprintln!("could not open the download page: {e}");
    }
}

/// Tauri ends a start it can't finish, such as a webview that can't be created, with a panic, and a release build has
/// no console to show it in. This says it in a message too, once.
#[cfg(windows)]
fn report_startup_panics() {
    static REPORTED: AtomicBool = AtomicBool::new(false);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or_default();
        if let Some(failure) = z_work_core::webview::startup_failure(message)
            && !REPORTED.swap(true, Ordering::SeqCst)
        {
            show_start_problem(&failure.text, failure.offer_download);
        }
    }));
}

pub fn run() {
    let quit_only = std::env::args().any(|a| a == QUIT_ARG);
    if !webview_available(quit_only) {
        return;
    }
    #[cfg(windows)]
    if !quit_only {
        report_startup_panics();
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
            let service = Service::open_when_free(&dir, Arc::new(SystemClock), &device_name())
                .map_err(|e| e.to_string());
            let core = Arc::new(Core {
                service: service.map(|mut s| {
                    s.set_system_zone(
                        iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned()),
                    );
                    s.set_detected(detect(&RealEnv, host_os()));
                    s.set_packaged(packaged());
                    Arc::new(Mutex::new(s))
                }),
                sync: Mutex::new(None),
                lease: Mutex::new(None),
                tray: Mutex::new(None),
                tray_wake: Mutex::new(None),
                quitting: AtomicBool::new(false),
                exit_done: AtomicBool::new(false),
                hide_pending: AtomicBool::new(false),
                cycle_lock: Arc::new(Mutex::new(())),
            });
            app.manage(Arc::clone(&core));
            build_tray(&handle, &core)?;
            spawn_ticker(handle.clone(), Arc::clone(&core));
            if let Ok(svc) = &core.service {
                spawn_sync(handle.clone(), Arc::clone(&core), Arc::clone(svc));
                spawn_lease(handle.clone(), Arc::clone(&core), Arc::clone(svc));
                let theme = guard(svc).file().prefs.theme;
                apply_native_theme(&handle, theme);
            }
            // The page says when it has painted. If it never does, the window still has to appear.
            let late = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                show_main_once(&late);
            });
            #[cfg(feature = "smoke")]
            if let Some(w) = app.get_webview_window("main")
                && let Ok(path) = std::env::var("ZWT_SMOKE_SCRIPT")
                && let Ok(js) = std::fs::read_to_string(path)
            {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    let _ = w.eval(js);
                });
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
        delete_task,
        start_task,
        resume_task,
        pause_task,
        stop_task,
        save_shift,
        delete_shift,
        set_rate,
        delete_rate_version,
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
        revert_shift_version,
        request_remote_pause,
        stash_draft,
        clear_draft,
        keep_unsaved_words,
        set_setup_step,
        finish_setup,
        window_ready,
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
        lease_preview_take_over,
        lease_take_over,
        lease_release,
        settle_lost_segment,
        list_versions,
        read_version_changes,
        save_version_now,
        preview_restore_version,
        restore_version,
        resolve_join,
        get_autostart_info,
        open_startup_settings
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
        delete_task,
        start_task,
        resume_task,
        pause_task,
        stop_task,
        save_shift,
        delete_shift,
        set_rate,
        delete_rate_version,
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
        revert_shift_version,
        request_remote_pause,
        stash_draft,
        clear_draft,
        keep_unsaved_words,
        set_setup_step,
        finish_setup,
        window_ready,
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
        lease_preview_take_over,
        lease_take_over,
        lease_release,
        settle_lost_segment,
        list_versions,
        read_version_changes,
        save_version_now,
        preview_restore_version,
        restore_version,
        resolve_join,
        get_autostart_info,
        open_startup_settings,
        smoke::smoke_report,
        smoke::smoke_close_window,
        smoke::smoke_window_visible,
        smoke::smoke_tray_toggle,
        smoke::smoke_observe,
        smoke::smoke_emit_changed,
        smoke::smoke_block_saves
    ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("could not start zWorkTracker: {e}");
            #[cfg(windows)]
            if !quit_only {
                let failure = z_work_core::webview::build_failure(&e.to_string());
                show_start_problem(&failure.text, failure.offer_download);
            }
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
