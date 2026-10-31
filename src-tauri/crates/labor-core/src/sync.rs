//! Folder sync. Each device writes only `<root>/LaborTracker/devices/<device-uuid>.json` to every
//! enabled folder and reads the other devices' files from all of them. A desktop client (OneDrive,
//! Google Drive) does the upload; this code never touches the network. Nothing here can block time
//! logging or damage the local store: every failure only ends up in the status.

use std::collections::BTreeMap;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::merge::merge;
use crate::model::{DeviceFile, RemoteDevice, SCHEMA_VERSION, Shared, SyncTarget};
use crate::persist;
use crate::service::Service;
use crate::time::Ts;
use crate::validate::check_shared;

pub const APP_FOLDER: &str = "LaborTracker";
pub const DEVICES_FOLDER: &str = "devices";
pub const MAX_REMOTE_FILE_BYTES: u64 = 256 * 1024 * 1024;
const RETRY_BASE_MS: u64 = 100;
const RETRY_ATTEMPTS: u32 = 5;

/// Filesystem access, injected so locks and offline placeholders can be simulated in tests.
pub trait SyncIo: Send + Sync {
    fn is_dir(&self, path: &Path) -> bool;
    fn create_dir_all(&self, path: &Path) -> io::Result<()>;
    fn list(&self, path: &Path) -> io::Result<Vec<String>>;
    fn file_size(&self, path: &Path) -> io::Result<u64>;
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn write_atomic(&self, dest: &Path, tmp: &Path, bytes: &[u8]) -> io::Result<()>;
    fn sleep(&self, d: Duration);
}

pub struct RealIo;

impl SyncIo for RealIo {
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        std::fs::create_dir_all(path)
    }
    fn list(&self, path: &Path) -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(path)? {
            names.push(entry?.file_name().to_string_lossy().into_owned());
        }
        Ok(names)
    }
    fn file_size(&self, path: &Path) -> io::Result<u64> {
        Ok(std::fs::metadata(path)?.len())
    }
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }
    fn write_atomic(&self, dest: &Path, tmp: &Path, bytes: &[u8]) -> io::Result<()> {
        persist::write_atomic(dest, tmp, bytes)
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// Worth retrying: sharing violations, lock contention and cloud placeholders that are not ready.
#[must_use]
pub fn is_transient(e: &io::Error) -> bool {
    if matches!(
        e.kind(),
        ErrorKind::PermissionDenied
            | ErrorKind::WouldBlock
            | ErrorKind::Interrupted
            | ErrorKind::TimedOut
    ) {
        return true;
    }
    cfg!(windows) && e.raw_os_error().is_some_and(is_windows_transient_code)
}

/// Access denied, sharing violation, lock violation and the cloud-files provider errors.
#[must_use]
pub fn is_windows_transient_code(code: i32) -> bool {
    matches!(code, 5 | 32 | 33 | 362 | 379 | 381 | 388 | 390)
}

fn with_retry<T>(io_impl: &dyn SyncIo, mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 0;
    loop {
        match op() {
            Err(e) if is_transient(&e) && attempt + 1 < RETRY_ATTEMPTS => {
                io_impl.sleep(Duration::from_millis(RETRY_BASE_MS << attempt));
                attempt += 1;
            }
            other => return other,
        }
    }
}

#[must_use]
pub fn devices_dir(root: &Path) -> PathBuf {
    root.join(APP_FOLDER).join(DEVICES_FOLDER)
}

/// Exactly `<lowercase hyphenated uuid>.json`. Conflict copies such as `<uuid> (1).json` or
/// `<uuid>-PC2.json`, and anything else in the folder, are ignored and never deleted.
#[must_use]
pub fn device_id_from_name(name: &str) -> Option<&str> {
    let id = name.strip_suffix(".json")?;
    let parsed = uuid::Uuid::parse_str(id).ok()?;
    (parsed.hyphenated().to_string() == id).then_some(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    schema_version: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    pub last_written_at: Option<Ts>,
    pub last_read_at: Option<Ts>,
    pub last_error: Option<String>,
    pub last_error_at: Option<Ts>,
    pub warnings: Vec<String>,
    pub ignored_files: usize,
    pub devices_seen: usize,
}

#[derive(Debug, Default)]
pub struct TargetRead {
    pub files: Vec<DeviceFile>,
    pub warnings: Vec<String>,
    pub ignored: usize,
    pub error: Option<String>,
}

/// Reads every other device's file. Damaged, newer or unreadable files are skipped with a warning.
pub fn read_target(io_impl: &dyn SyncIo, root: &Path, own_id: &str) -> TargetRead {
    let mut out = TargetRead::default();
    let dir = devices_dir(root);
    if !io_impl.is_dir(root) {
        out.error = Some(
            "Folder not found. Is the drive connected and the desktop client running?".to_owned(),
        );
        return out;
    }
    if !io_impl.is_dir(&dir) {
        return out;
    }
    let names = match with_retry(io_impl, || io_impl.list(&dir)) {
        Ok(n) => n,
        Err(e) => {
            out.error = Some(format!("Could not list the folder: {e}"));
            return out;
        }
    };
    for name in names {
        let Some(id) = device_id_from_name(&name) else {
            out.ignored += 1;
            continue;
        };
        if id == own_id {
            continue;
        }
        let path = dir.join(&name);
        let too_big = io_impl
            .file_size(&path)
            .is_ok_and(|s| s > MAX_REMOTE_FILE_BYTES);
        if too_big {
            out.warnings
                .push(format!("Skipped {name}: the file is unreasonably large."));
            continue;
        }
        // A failed read is not corruption: a cloud placeholder may simply not be available offline.
        let bytes = match with_retry(io_impl, || io_impl.read(&path)) {
            Ok(b) => b,
            Err(e) => {
                out.warnings
                    .push(format!("Could not read {name} right now, will retry: {e}"));
                continue;
            }
        };
        let version = serde_json::from_slice::<VersionProbe>(&bytes)
            .ok()
            .and_then(|p| p.schema_version);
        match version {
            Some(v) if v > SCHEMA_VERSION => {
                out.warnings.push(format!("Skipped {name}: it was written by a newer version of the app. Update this device to read it."));
                continue;
            }
            Some(v) if v > 0 => {}
            _ => {
                out.warnings.push(format!(
                    "Skipped {name}: the file is incomplete or damaged. Keeping the last good data."
                ));
                continue;
            }
        }
        match serde_json::from_slice::<DeviceFile>(&bytes) {
            Ok(file) if file.device_id == id && check_shared(&file.data).is_ok() => {
                out.files.push(file)
            }
            Ok(_) | Err(_) => {
                out.warnings.push(format!(
                    "Skipped {name}: the file is incomplete or damaged. Keeping the last good data."
                ));
            }
        }
    }
    out
}

/// Writes this device's own file. Refuses to replace a file from a newer app version.
pub fn write_target(
    io_impl: &dyn SyncIo,
    root: &Path,
    file: &DeviceFile,
    bytes: &[u8],
) -> Result<(), String> {
    if !io_impl.is_dir(root) {
        return Err(
            "Folder not found. Is the drive connected and the desktop client running?".to_owned(),
        );
    }
    let dir = devices_dir(root);
    with_retry(io_impl, || io_impl.create_dir_all(&dir))
        .map_err(|e| format!("Could not create the folder: {e}"))?;
    let dest = dir.join(format!("{}.json", file.device_id));
    if let Ok(existing) = io_impl.read(&dest)
        && let Ok(probe) = serde_json::from_slice::<VersionProbe>(&existing)
        && probe.schema_version.is_some_and(|v| v > SCHEMA_VERSION)
    {
        return Err(
            "This device's file was written by a newer app version; it was not overwritten."
                .to_owned(),
        );
    }
    // A dot-prefixed temporary never matches a device file name, so readers ignore it.
    let tmp = dir.join(format!(".{}.tmp", file.device_id));
    with_retry(io_impl, || io_impl.write_atomic(&dest, &tmp, bytes))
        .map_err(|e| format!("Could not write the file: {e}"))
}

/// What a folder holds, for the "connect and merge" preview.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreview {
    pub has_data: bool,
    pub devices: Vec<String>,
    pub projects: usize,
    pub tasks: usize,
    pub segments: usize,
    pub warnings: Vec<String>,
}

#[must_use]
pub fn preview_folder(io_impl: &dyn SyncIo, root: &Path, own_id: &str) -> FolderPreview {
    let read = read_target(io_impl, root, own_id);
    let mut merged = Shared::default();
    let mut devices = Vec::new();
    for f in &read.files {
        merged = merge(&merged, &f.data);
        devices.push(f.device_name.clone());
    }
    let mut warnings = read.warnings;
    warnings.extend(read.error);
    FolderPreview {
        has_data: !read.files.is_empty(),
        devices,
        projects: merged.projects.values().filter(|p| !p.deleted).count(),
        tasks: merged.tasks.values().filter(|t| !t.deleted).count(),
        segments: merged.segments.len(),
        warnings,
    }
}

/// One full sync over every enabled folder. The lock is never held during file I/O, and a failing
/// target never affects another. Returns true when the merge changed local data.
pub fn run_cycle(service: &Mutex<Service>, io_impl: &dyn SyncIo) -> bool {
    let lock = || {
        service
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    let (targets, own_id): (Vec<SyncTarget>, String) = {
        let s = lock();
        (
            s.file().prefs.sync_targets.clone(),
            s.file().device_id.clone(),
        )
    };
    if targets.is_empty() {
        return false;
    }

    let mut reads: Vec<(SyncTarget, TargetRead)> = Vec::with_capacity(targets.len());
    for t in targets {
        let read = read_target(io_impl, Path::new(&t.root), &own_id);
        reads.push((t, read));
    }

    let changed = {
        let mut s = lock();
        let mut incoming = Shared::default();
        let mut seen: BTreeMap<String, RemoteDevice> = BTreeMap::new();
        for (_, read) in &reads {
            for f in &read.files {
                incoming = merge(&incoming, &f.data);
                let entry = RemoteDevice {
                    name: f.device_name.clone(),
                    last_heartbeat: f.last_heartbeat,
                    written_at: f.written_at,
                };
                // The same device can be stale in one folder and fresh in another: keep the freshest.
                match seen.get(&f.device_id) {
                    Some(old) if old.written_at >= entry.written_at => {}
                    _ => {
                        seen.insert(f.device_id.clone(), entry);
                    }
                }
            }
        }
        s.absorb_remote(&incoming, seen)
    };

    let (device_file, bytes) = {
        let s = lock();
        let f = s.device_file();
        let b = serde_json::to_vec(&f);
        (f, b)
    };
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            lock().record_sync_failure(&format!("Could not prepare the sync file: {e}"));
            return changed;
        }
    };

    for (target, read) in reads {
        let root = Path::new(&target.root);
        let written = if read.error.is_none() {
            write_target(io_impl, root, &device_file, &bytes)
        } else {
            Err(read.error.clone().unwrap_or_default())
        };
        let mut s = lock();
        let now = s.now();
        let status = s.target_status_mut(&target.root);
        status.warnings = read.warnings;
        status.ignored_files = read.ignored;
        status.devices_seen = read.files.len();
        match written {
            Ok(()) => {
                status.last_written_at = Some(now);
                status.last_read_at = Some(now);
                status.last_error = None;
                status.last_error_at = None;
            }
            Err(e) => {
                status.last_error = Some(e);
                status.last_error_at = Some(now);
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::{ProjectInput, TaskInput};
    use crate::model::{SyncProvider, TaskState};
    use crate::time::ManualClock;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    const T0: &str = "2026-03-01T09:00:00Z";

    struct Device {
        svc: Mutex<Service>,
        _dir: tempfile::TempDir,
    }

    fn device(clock: &ManualClock, roots: &[&Path]) -> Device {
        let dir = tempfile::tempdir().unwrap();
        let svc = Service::open(dir.path(), Arc::new(clock.clone()), "pc").unwrap();
        let svc = Mutex::new(svc);
        for r in roots {
            svc.lock()
                .unwrap()
                .add_sync_target(SyncTarget {
                    provider: SyncProvider::Custom,
                    root: r.to_string_lossy().into_owned(),
                })
                .unwrap();
        }
        Device { svc, _dir: dir }
    }

    fn pinput(name: &str) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            color: "#336699".into(),
            billable: true,
            budget_hours: None,
            client_zone: None,
        }
    }

    fn tinput(name: &str, p: &str) -> TaskInput {
        TaskInput {
            name: name.into(),
            project_id: p.into(),
            description: serde_json::Value::Null,
        }
    }

    impl Device {
        fn s(&self) -> std::sync::MutexGuard<'_, Service> {
            self.svc.lock().unwrap()
        }
        fn cycle(&self) -> bool {
            run_cycle(&self.svc, &RealIo)
        }
        fn data(&self) -> Shared {
            self.s().file().data.clone()
        }
        fn id(&self) -> String {
            self.s().file().device_id.clone()
        }
    }

    fn own_file(d: &Device, root: &Path) -> PathBuf {
        devices_dir(root).join(format!("{}.json", d.id()))
    }

    #[test]
    fn name_filter_accepts_only_exact_device_files() {
        let id = "123e4567-e89b-42d3-a456-426614174000";
        assert_eq!(device_id_from_name(&format!("{id}.json")), Some(id));
        for bad in [
            format!("{id} (1).json"),
            format!("{id}-DESKTOP-PC.json"),
            format!("{id}(conflicted copy).json"),
            format!(".{id}.tmp"),
            format!("{id}.json.tmp"),
            id.to_uppercase() + ".json",
            "notes.txt".to_owned(),
            "desktop.ini".to_owned(),
        ] {
            assert_eq!(device_id_from_name(&bad), None, "{bad}");
        }
    }

    #[test]
    fn three_devices_converge() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let (a, b, c) = (
            device(&clock, &[root.path()]),
            device(&clock, &[root.path()]),
            device(&clock, &[root.path()]),
        );
        let pa = a.s().create_project(&pinput("A")).unwrap();
        clock.advance(60);
        b.s().create_project(&pinput("B")).unwrap();
        clock.advance(60);
        let tc = c.s().create_project(&pinput("C")).unwrap();
        c.s().create_task(&tinput("Task", &tc)).unwrap();
        a.s().create_task(&tinput("TaskA", &pa)).unwrap();
        for _ in 0..3 {
            for d in [&a, &b, &c] {
                d.cycle();
            }
        }
        assert_eq!(a.data(), b.data());
        assert_eq!(b.data(), c.data());
        assert_eq!(a.data().projects.len(), 3);
        assert_eq!(a.data().tasks.len(), 2);
        // Further cycles change nothing: merging is idempotent.
        assert!(!a.cycle());
    }

    #[test]
    fn conflict_copies_and_unknown_files_are_ignored_and_kept() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        b.s().create_project(&pinput("Real")).unwrap();
        b.cycle();
        let bfile = own_file(&b, root.path());
        let bytes = std::fs::read(&bfile).unwrap();
        let mut evil = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap();
        evil["data"]["projects"] = serde_json::json!({});
        let dir = devices_dir(root.path());
        let copies = [
            format!("{} (1).json", b.id()),
            format!("{}-DESKTOP.json", b.id()),
            "notes.txt".to_owned(),
        ];
        for c in &copies {
            std::fs::write(dir.join(c), evil.to_string()).unwrap();
        }
        a.cycle();
        assert_eq!(a.data().projects.len(), 1);
        for c in &copies {
            assert!(dir.join(c).exists(), "{c} must not be deleted");
        }
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert_eq!(status.ignored_files, 3);
        assert!(status.last_error.is_none());
    }

    #[test]
    fn corrupt_remote_is_skipped_and_last_good_merge_is_kept() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        b.s().create_project(&pinput("Real")).unwrap();
        b.cycle();
        a.cycle();
        assert_eq!(a.data().projects.len(), 1);
        let good = std::fs::read(own_file(&b, root.path())).unwrap();
        std::fs::write(own_file(&b, root.path()), &good[..good.len() / 2]).unwrap();
        clock.advance(60);
        a.s().create_project(&pinput("Mine")).unwrap();
        a.cycle();
        assert_eq!(a.data().projects.len(), 2);
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(
            status.warnings.iter().any(|w| w.contains("damaged")),
            "{:?}",
            status.warnings
        );
        assert!(status.last_written_at.is_some());
    }

    #[test]
    fn invalid_currency_in_a_remote_file_skips_it_without_crashing() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        let p = b.s().create_project(&pinput("Real")).unwrap();
        b.s()
            .mutate(|f, ctx| {
                f.data.set_rate(
                    ctx,
                    &crate::machine::RateInput {
                        project_id: p.clone(),
                        rate_cents: Some(1),
                        currency: "USD".into(),
                        effective_from: None,
                        confirm_retroactive: false,
                    },
                )
            })
            .unwrap();
        b.cycle();
        let path = own_file(&b, root.path());
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"USD\"", "\"GBP\"");
        std::fs::write(&path, text).unwrap();
        a.cycle();
        assert!(a.data().rates.is_empty());
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(status.warnings.iter().any(|w| w.contains("damaged")));
    }

    #[test]
    fn newer_schema_is_never_read_or_overwritten() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        b.s().create_project(&pinput("Future")).unwrap();
        b.cycle();
        let path = own_file(&b, root.path());
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"schemaVersion\":1", "\"schemaVersion\":99");
        std::fs::write(&path, &text).unwrap();
        a.cycle();
        assert!(a.data().projects.is_empty());
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(status.warnings.iter().any(|w| w.contains("newer version")));
        // The newer file's owner, running old code, must not overwrite it.
        b.cycle();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        let status = b
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(status.last_error.unwrap().contains("newer"));
    }

    #[test]
    fn missing_folder_reports_and_does_not_harm_local_data_or_create_it() {
        let clock = ManualClock::at(T0);
        let base = tempfile::tempdir().unwrap();
        let gone = base.path().join("unplugged");
        let a = device(&clock, &[gone.as_path()]);
        a.s().create_project(&pinput("Local")).unwrap();
        assert!(!a.cycle());
        assert_eq!(a.data().projects.len(), 1);
        assert!(!gone.exists());
        let status = a.s().target_status_mut(&gone.to_string_lossy()).clone();
        assert!(status.last_error.unwrap().contains("not found"));
        // Logging continues.
        let p = a.data().projects.keys().next().unwrap().clone();
        let t = a.s().create_task(&tinput("T", &p)).unwrap();
        a.s().start_task(&t).unwrap();
        assert_eq!(a.data().tasks[&t].state, TaskState::Running);
    }

    #[test]
    fn locked_folder_does_not_block_and_clears_after_unlock() {
        use std::os::unix::fs::PermissionsExt;
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        a.cycle();
        let dir = devices_dir(root.path());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        struct Fast;
        impl SyncIo for Fast {
            fn is_dir(&self, p: &Path) -> bool {
                RealIo.is_dir(p)
            }
            fn create_dir_all(&self, p: &Path) -> io::Result<()> {
                RealIo.create_dir_all(p)
            }
            fn list(&self, p: &Path) -> io::Result<Vec<String>> {
                RealIo.list(p)
            }
            fn file_size(&self, p: &Path) -> io::Result<u64> {
                RealIo.file_size(p)
            }
            fn read(&self, p: &Path) -> io::Result<Vec<u8>> {
                RealIo.read(p)
            }
            fn write_atomic(&self, d: &Path, t: &Path, b: &[u8]) -> io::Result<()> {
                RealIo.write_atomic(d, t, b)
            }
            fn sleep(&self, _: Duration) {}
        }
        run_cycle(&a.svc, &Fast);
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(status.last_error.is_some());
        a.cycle();
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(status.last_error.is_none());
    }

    /// Fails with a sharing violation a set number of times, like a client holding the file.
    struct Flaky {
        fails: AtomicU32,
        sleeps: AtomicU32,
    }
    impl SyncIo for Flaky {
        fn is_dir(&self, p: &Path) -> bool {
            RealIo.is_dir(p)
        }
        fn create_dir_all(&self, p: &Path) -> io::Result<()> {
            RealIo.create_dir_all(p)
        }
        fn list(&self, p: &Path) -> io::Result<Vec<String>> {
            RealIo.list(p)
        }
        fn file_size(&self, p: &Path) -> io::Result<u64> {
            RealIo.file_size(p)
        }
        fn read(&self, p: &Path) -> io::Result<Vec<u8>> {
            RealIo.read(p)
        }
        fn write_atomic(&self, d: &Path, t: &Path, b: &[u8]) -> io::Result<()> {
            if self.fails.load(Ordering::SeqCst) > 0 {
                self.fails.fetch_sub(1, Ordering::SeqCst);
                return Err(io::Error::from(ErrorKind::PermissionDenied));
            }
            RealIo.write_atomic(d, t, b)
        }
        fn sleep(&self, _: Duration) {
            self.sleeps.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn sharing_violations_are_retried_with_backoff() {
        assert!(
            is_windows_transient_code(32)
                && is_windows_transient_code(33)
                && is_windows_transient_code(362)
        );
        assert!(!is_windows_transient_code(2));
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let flaky = Flaky {
            fails: AtomicU32::new(2),
            sleeps: AtomicU32::new(0),
        };
        run_cycle(&a.svc, &flaky);
        assert_eq!(flaky.sleeps.load(Ordering::SeqCst), 2);
        assert!(own_file(&a, root.path()).exists());
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(status.last_error.is_none());
    }

    #[test]
    fn unreadable_placeholder_is_not_called_corrupt_and_retries_later() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        b.s().create_project(&pinput("Remote")).unwrap();
        b.cycle();
        struct Offline;
        impl SyncIo for Offline {
            fn is_dir(&self, p: &Path) -> bool {
                RealIo.is_dir(p)
            }
            fn create_dir_all(&self, p: &Path) -> io::Result<()> {
                RealIo.create_dir_all(p)
            }
            fn list(&self, p: &Path) -> io::Result<Vec<String>> {
                RealIo.list(p)
            }
            fn file_size(&self, p: &Path) -> io::Result<u64> {
                RealIo.file_size(p)
            }
            fn read(&self, _: &Path) -> io::Result<Vec<u8>> {
                Err(io::Error::new(
                    ErrorKind::TimedOut,
                    "cloud file not available",
                ))
            }
            fn write_atomic(&self, d: &Path, t: &Path, b: &[u8]) -> io::Result<()> {
                RealIo.write_atomic(d, t, b)
            }
            fn sleep(&self, _: Duration) {}
        }
        run_cycle(&a.svc, &Offline);
        assert!(a.data().projects.is_empty());
        let status = a
            .s()
            .target_status_mut(&root.path().to_string_lossy())
            .clone();
        assert!(
            status.warnings.iter().any(|w| w.contains("will retry")),
            "{:?}",
            status.warnings
        );
        assert!(!status.warnings.iter().any(|w| w.contains("damaged")));
        a.cycle();
        assert_eq!(a.data().projects.len(), 1);
    }

    #[test]
    fn two_targets_one_failing_does_not_affect_the_other() {
        let clock = ManualClock::at(T0);
        let good = tempfile::tempdir().unwrap();
        let base = tempfile::tempdir().unwrap();
        let bad = base.path().join("gone");
        let a = device(&clock, &[good.path(), bad.as_path()]);
        a.s().create_project(&pinput("X")).unwrap();
        a.cycle();
        assert!(own_file(&a, good.path()).exists());
        let ok = a
            .s()
            .target_status_mut(&good.path().to_string_lossy())
            .clone();
        let ko = a.s().target_status_mut(&bad.to_string_lossy()).clone();
        assert!(ok.last_written_at.is_some() && ok.last_error.is_none());
        assert!(ko.last_written_at.is_none() && ko.last_error.is_some());
    }

    #[test]
    fn same_device_stale_in_one_target_and_fresh_in_the_other() {
        let clock = ManualClock::at(T0);
        let t1 = tempfile::tempdir().unwrap();
        let t2 = tempfile::tempdir().unwrap();
        let b = device(&clock, &[t1.path(), t2.path()]);
        let a = device(&clock, &[t1.path(), t2.path()]);
        let p = b.s().create_project(&pinput("Old")).unwrap();
        b.cycle();
        let stale = std::fs::read(own_file(&b, t1.path())).unwrap();
        clock.advance(600);
        b.s().update_project(&p, &pinput("New")).unwrap();
        b.cycle();
        std::fs::write(own_file(&b, t1.path()), &stale).unwrap();
        a.cycle();
        assert_eq!(a.data().projects[&p].name, "New");
        assert_eq!(
            a.s().file().remote_devices[&b.id()].written_at.iso(),
            "2026-03-01T09:10:00Z"
        );
        a.cycle();
        assert_eq!(a.data(), b.data());
    }

    #[test]
    fn tombstones_and_archives_do_not_resurrect() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        let gone = a.s().create_project(&pinput("Gone")).unwrap();
        let arch = a.s().create_project(&pinput("Arch")).unwrap();
        let t = a.s().create_task(&tinput("T", &arch)).unwrap();
        a.cycle();
        b.cycle();
        clock.advance(60);
        a.s().delete_project(&gone).unwrap();
        a.s().set_project_archived(&arch, true).unwrap();
        a.cycle();
        b.cycle();
        a.cycle();
        assert!(b.data().projects[&gone].deleted);
        assert!(b.data().projects[&arch].archived);
        assert!(a.data().projects[&gone].deleted);
        assert_eq!(a.data().tasks[&t].state, TaskState::Draft);
    }

    #[test]
    fn segments_open_on_two_devices_are_kept_warned_and_unaltered() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        let p = a.s().create_project(&pinput("P")).unwrap();
        let ta = a.s().create_task(&tinput("TA", &p)).unwrap();
        let tb = a.s().create_task(&tinput("TB", &p)).unwrap();
        a.cycle();
        b.cycle();
        a.s().start_task(&ta).unwrap();
        clock.advance(10);
        b.s().start_task(&tb).unwrap();
        a.cycle();
        b.cycle();
        a.cycle();
        let d = a.data();
        assert_eq!(d.segments.values().filter(|s| s.end.is_none()).count(), 2);
        assert_eq!(d.tasks[&ta].state, TaskState::Running);
        assert_eq!(d.tasks[&tb].state, TaskState::Running);
        let warning = a.s().snapshot().warnings;
        assert!(
            warning.iter().any(|w| w.contains("more than one device")),
            "{warning:?}"
        );
        // Pausing the other device's task from here is refused, and nothing of theirs changes.
        assert!(a.s().pause_task(&tb).is_err());
        assert_eq!(
            a.data()
                .segments
                .values()
                .filter(|s| s.end.is_none())
                .count(),
            2
        );
    }

    #[test]
    fn a_task_stopped_elsewhere_closes_only_the_owners_segment_on_its_next_cycle() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let a = device(&clock, &[root.path()]);
        let b = device(&clock, &[root.path()]);
        let p = a.s().create_project(&pinput("P")).unwrap();
        let t = a.s().create_task(&tinput("T", &p)).unwrap();
        a.cycle();
        b.cycle();
        b.s().start_task(&t).unwrap();
        b.cycle();
        a.cycle();
        clock.advance(600);
        a.s().stop_task(&t).unwrap();
        assert!(
            a.data().segments.values().next().unwrap().end.is_none(),
            "A may not alter B's segment"
        );
        a.cycle();
        b.cycle();
        let seg = b.data().segments.values().next().unwrap().clone();
        assert_eq!(seg.end.unwrap().iso(), "2026-03-01T09:10:00Z");
        a.cycle();
        assert_eq!(a.data(), b.data());
        assert_eq!(a.data().tasks[&t].state, TaskState::Stopped);
    }

    #[test]
    fn preview_counts_what_a_folder_holds() {
        let clock = ManualClock::at(T0);
        let root = tempfile::tempdir().unwrap();
        let b = device(&clock, &[root.path()]);
        let p = b.s().create_project(&pinput("P")).unwrap();
        b.s().create_task(&tinput("T", &p)).unwrap();
        b.cycle();
        let pv = preview_folder(&RealIo, root.path(), "someone-else");
        assert!(pv.has_data);
        assert_eq!((pv.projects, pv.tasks, pv.segments), (1, 1, 0));
        assert_eq!(pv.devices, ["pc"]);
        let empty = tempfile::tempdir().unwrap();
        assert!(!preview_folder(&RealIo, empty.path(), "x").has_data);
    }

    #[test]
    fn sync_failure_never_rolls_back_a_saved_local_change() {
        let clock = ManualClock::at(T0);
        let dir = tempfile::tempdir().unwrap();
        let svc = Service::open(dir.path(), Arc::new(clock.clone()), "pc").unwrap();
        let svc = Mutex::new(svc);
        svc.lock()
            .unwrap()
            .add_sync_target(SyncTarget {
                provider: SyncProvider::OneDrive,
                root: "/nonexistent/place".into(),
            })
            .unwrap();
        let id = svc.lock().unwrap().create_project(&pinput("Kept")).unwrap();
        run_cycle(&svc, &RealIo);
        drop(svc);
        let reopened = Service::open(dir.path(), Arc::new(clock), "pc").unwrap();
        assert!(reopened.file().data.projects.contains_key(&id));
    }
}
