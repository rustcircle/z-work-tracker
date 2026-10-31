//! Tauri shell around `labor-core`: commands, tray, heartbeat, sync thread and the real-exit path.
//! Timers live in Rust threads, so they keep going while the window is hidden.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use labor_core::detect::{RealEnv, detect, host_os};
use labor_core::machine::{ProjectInput, RateInput, RoundingInput, ShiftInput, TaskInput};
use labor_core::model::{SyncProvider, SyncTarget, Theme};
use labor_core::report::ExportRequest;
use labor_core::service::Service;
use labor_core::sync::{FolderPreview, RealIo, preview_folder, run_cycle};
use labor_core::tray::{CloseDecision, TrayAction, close_decision, tray_state};
use labor_core::validate::parse_zone;
use labor_core::view::Snapshot;
use labor_core::{CoreError, SystemClock, csv, xlsx};
use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;

const HEARTBEAT: Duration = Duration::from_secs(30);
const TRAY_TICK: Duration = Duration::from_secs(5);
const SYNC_DEBOUNCE: Duration = Duration::from_secs(5);
const SYNC_PERIOD: Duration = Duration::from_secs(180);
const EXIT_SYNC_LIMIT: Duration = Duration::from_secs(5);
const QUIT_ARG: &str = "--quit";

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
    Changed,
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
    tray: Mutex<Option<TrayHandles>>,
    quitting: AtomicBool,
    exit_done: AtomicBool,
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
            .or_else(|| settings.get("myZone"))
            .map(|e| &e.value);
        let zone = zone_for_tray(chosen, &s.snapshot_system_zone());
        tray_state(s.file(), s.now(), zone)
    };
    let handles = guard(&core.tray);
    let Some(h) = handles.as_ref() else { return };
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

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(core) = app.try_state::<Arc<Core>>() {
        core.tell_sync(SyncMsg::Now);
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
    app.exit(0);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HideNotice {
    running: bool,
    task_name: Option<String>,
}

fn handle_close(app: &AppHandle, core: &Core) -> bool {
    let shown = core
        .service
        .as_ref()
        .map_or(true, |s| guard(s).hide_notice_shown());
    match close_decision(core.quitting.load(Ordering::SeqCst), shown) {
        CloseDecision::Exit => false,
        CloseDecision::Hide => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
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
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(30));
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
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
    Ok(core.change(&app, |s| s.update_task(&id, &input))?.1)
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
    usable_folder(&root)?;
    let own = guard(&*core.svc()?).file().device_id.clone();
    Ok(preview_folder(&RealIo, Path::new(&root), &own))
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
    let chosen = std::env::var("LABOR_SMOKE_EXPORT_DIR")
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
    labor_core::persist::write_atomic(&path, &tmp, bytes).map_err(CoreError::from)?;
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
        "labor-tracker-{}.xlsx",
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
        "labor-tracker-{}.csv",
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
fn ack_hide_notice(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
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
        let path = std::env::var("LABOR_SMOKE_OUT").map_err(|e| e.to_string())?;
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
    let state = {
        let s = guard(svc);
        tray_state(s.file(), s.now(), chrono_tz::UTC)
    };
    if let Some(task) = state.task_id {
        let result = {
            let mut s = guard(svc);
            match state.action {
                Some(TrayAction::Pause) => s.pause_task(&task),
                Some(TrayAction::Resume) => s.resume_task(&task).map(|_| ()),
                None => Ok(()),
            }
        };
        if let Err(e) = result {
            eprintln!("tray action failed: {e}");
        }
        core.tell_sync(SyncMsg::Changed);
        refresh_tray(app, &core);
        let _ = app.emit("state-changed", ());
    }
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
    *guard(&core.tray) = Some(TrayHandles {
        icon,
        status,
        toggle,
        idle,
        running,
        last_running: AtomicBool::new(false),
    });
    Ok(())
}

/// Heartbeat and tray refresh. Independent of the webview, so they run while it is hidden.
fn spawn_ticker(app: AppHandle, core: Arc<Core>) {
    std::thread::spawn(move || {
        let mut last_beat = Instant::now();
        while !core.exit_done.load(Ordering::SeqCst) {
            std::thread::sleep(TRAY_TICK);
            refresh_tray(&app, &core);
            if last_beat.elapsed() >= HEARTBEAT {
                last_beat = Instant::now();
                if let Ok(svc) = core.service.as_ref()
                    && let Err(e) = guard(svc).heartbeat()
                {
                    eprintln!("heartbeat could not be saved: {e}");
                }
            }
        }
    });
}

/// Debounced sync after changes, plus periodic sync. Failures only ever reach the status.
fn spawn_sync(app: AppHandle, core: Arc<Core>, svc: Arc<Mutex<Service>>) {
    let (tx, rx) = mpsc::channel();
    *guard(&core.sync) = Some(tx);
    std::thread::spawn(move || {
        let mut due = Some(Instant::now());
        let mut next_periodic = Instant::now() + SYNC_PERIOD;
        loop {
            let wake = due.map_or(next_periodic, |d| d.min(next_periodic));
            match rx.recv_timeout(wake.saturating_duration_since(Instant::now())) {
                Ok(SyncMsg::Changed) => {
                    due = Some(Instant::now() + SYNC_DEBOUNCE);
                    continue;
                }
                Ok(SyncMsg::Now) => due = Some(Instant::now()),
                Ok(SyncMsg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            if due.is_some_and(|d| d <= now) || next_periodic <= now {
                due = None;
                next_periodic = now + SYNC_PERIOD;
                let changed = {
                    let _cycle = guard(&core.cycle_lock);
                    run_cycle(&svc, &RealIo)
                };
                if changed {
                    refresh_tray(&app, &core);
                }
                // Status also changes without data changing, so the UI always hears about it.
                let _ = app.emit("state-changed", ());
            }
        }
    });
}

fn data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    #[cfg(feature = "smoke")]
    if let Ok(dir) = std::env::var("LABOR_SMOKE_DATA_DIR") {
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
        .set_title("Labor Tracker")
        .set_level(rfd::MessageLevel::Error)
        .set_description(
            "Microsoft Edge WebView2 Runtime was not found or is disabled. It normally comes with Windows 11.\n\n\
             Run Windows Update or reinstall the WebView2 Runtime from Microsoft, then open Labor Tracker again. Your data is safe.",
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
                if let Ok(path) = std::env::var("LABOR_SMOKE_SCRIPT")
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
        smoke::smoke_emit_changed
    ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(e) => {
            eprintln!("could not start Labor Tracker: {e}");
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
