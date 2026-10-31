//! Local store: versioned JSON, atomic write (temp, fsync, rename), one `.bak`, corrupt-file recovery.
//! Corrupt files are moved aside and kept. Nothing is ever silently wiped.

use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::hash::{DefaultHasher, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::CoreError;
use crate::model::{LocalFile, SCHEMA_VERSION, Shared};
use crate::time::Ts;
use crate::validate::check_core;

pub const MAIN_FILE: &str = "z-work-data.json";
/// The latest heartbeat, when it is newer than the one in the main file. See `save_heartbeat`.
pub const HEARTBEAT_FILE: &str = "z-work-heartbeat.json";

#[derive(Clone, Debug)]
pub struct Paths {
    pub dir: PathBuf,
    /// Hash of the main file as it was last read and checked, or written, so an unchanged file is
    /// not parsed again on every save. 0 until then, and no file is trusted because of it.
    checked: Arc<AtomicU64>,
}

impl Paths {
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            checked: Arc::new(AtomicU64::new(0)),
        }
    }
    #[must_use]
    pub fn main(&self) -> PathBuf {
        self.dir.join(MAIN_FILE)
    }
    #[must_use]
    pub fn bak(&self) -> PathBuf {
        self.dir.join(format!("{MAIN_FILE}.bak"))
    }
    fn tmp(&self) -> PathBuf {
        self.dir.join(format!("{MAIN_FILE}.tmp"))
    }
    fn bak_tmp(&self) -> PathBuf {
        self.dir.join(format!("{MAIN_FILE}.bak.tmp"))
    }
    fn heartbeat(&self) -> PathBuf {
        self.dir.join(HEARTBEAT_FILE)
    }
    fn heartbeat_tmp(&self) -> PathBuf {
        self.dir.join(format!("{HEARTBEAT_FILE}.tmp"))
    }
    fn remember_checked(&self, bytes: &[u8]) {
        self.checked.store(content_hash(bytes), Ordering::Relaxed);
    }
    fn is_checked(&self, bytes: &[u8]) -> bool {
        self.checked.load(Ordering::Relaxed) == content_hash(bytes)
    }
}

/// Never 0, which `Paths` uses for "nothing checked yet".
fn content_hash(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    h.write(bytes);
    h.finish().max(1)
}

/// Creates `tmp` afresh and fills it. A leftover file or planted link is removed, never followed.
fn write_new(tmp: &Path, bytes: &[u8]) -> io::Result<()> {
    match fs::symlink_metadata(tmp) {
        Ok(meta) if meta.is_dir() => return Err(io::Error::other("temporary path is a directory")),
        Ok(_) => fs::remove_file(tmp)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// Antivirus or backup tools can hold a file for a moment. Retried for about half a second.
fn with_local_retry(mut op: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut wait = 50;
    for _ in 0..3 {
        match op() {
            Err(e) if crate::sync::is_transient(&e) => {
                std::thread::sleep(std::time::Duration::from_millis(wait))
            }
            other => return other,
        }
        wait *= 2;
    }
    op()
}

/// Writes `bytes` to `tmp`, flushes it to disk and renames it over `dest`.
pub fn write_atomic(dest: &Path, tmp: &Path, bytes: &[u8]) -> io::Result<()> {
    write_new(tmp, bytes)?;
    fs::rename(tmp, dest)?;
    #[cfg(unix)]
    if let Some(parent) = dest.parent()
        && let Ok(d) = File::open(parent)
    {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Upgrades an older store step by step before it is parsed. New fields that are optional need no
/// step here, since every replicated record defaults missing fields. Add `1 => ...` for a schema 2.
fn migrate(mut value: Value) -> Value {
    // Schema 2 adds optional records and fields only, all of which default when missing. Starter
    // tags are added when the store opens, so the step just records the new version.
    if value.get("version").and_then(Value::as_u64) == Some(1)
        && let Some(obj) = value.as_object_mut()
    {
        obj.insert("version".to_owned(), Value::from(2u64));
    }
    value
}

/// Reads a store file from elsewhere, such as a backup, without touching the disk.
pub fn parse_checked(bytes: &[u8]) -> Result<LocalFile, CoreError> {
    match parse_local(bytes) {
        Parsed::Good(f, _) => Ok(*f),
        Parsed::Newer(found) => Err(CoreError::FutureVersion {
            found,
            supported: SCHEMA_VERSION,
        }),
        Parsed::Corrupt(why) => Err(CoreError::Validation(format!(
            "that file can't be read: {why}"
        ))),
    }
}

#[derive(Debug)]
enum Parsed {
    /// The file and the schema version it was written in.
    Good(Box<LocalFile>, u64),
    Corrupt(String),
    Newer(u64),
}

fn parse_local(bytes: &[u8]) -> Parsed {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return Parsed::Corrupt(e.to_string()),
    };
    let version = value.get("version").and_then(Value::as_u64);
    let found = match version {
        None | Some(0) => return Parsed::Corrupt("no schema version".into()),
        Some(v) if v > SCHEMA_VERSION => return Parsed::Newer(v),
        Some(v) => v,
    };
    let value = migrate(value);
    let file: LocalFile = match serde_json::from_value(value) {
        Ok(f) => f,
        Err(e) => return Parsed::Corrupt(e.to_string()),
    };
    if let Err(e) = check_core(&file.data) {
        return Parsed::Corrupt(e.to_string());
    }
    Parsed::Good(Box::new(file), found)
}

/// True when the bytes this program just produced read back as a valid store. They are in the current
/// schema by construction, so there is nothing to migrate and no need for the generic JSON tree.
fn reads_back(bytes: &[u8], file: &LocalFile) -> Result<(), String> {
    if file.version != SCHEMA_VERSION {
        return match parse_local(bytes) {
            Parsed::Corrupt(why) => Err(why),
            _ => Ok(()),
        };
    }
    let read: LocalFile = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    check_core(&read.data).map_err(|e| e.to_string())
}

fn read_opt(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Moves a damaged file aside under a unique name so it stays available for hand recovery.
fn quarantine(paths: &Paths, from: &Path, now: Ts) -> io::Result<PathBuf> {
    let stamp = now.datetime().format("%Y%m%dT%H%M%SZ");
    for n in 0..1000 {
        let name = if n == 0 {
            format!("z-work-data.corrupt-{stamp}.json")
        } else {
            format!("z-work-data.corrupt-{stamp}-{n}.json")
        };
        let target = paths.dir.join(name);
        if !target.exists() {
            fs::rename(from, &target)?;
            return Ok(target);
        }
    }
    Err(io::Error::other("too many quarantined files"))
}

#[derive(Debug, Default)]
pub struct LoadOutcome {
    pub notices: Vec<String>,
}

#[must_use]
pub fn new_local_file(device_name: &str) -> LocalFile {
    LocalFile {
        version: SCHEMA_VERSION,
        device_id: Uuid::new_v4().to_string(),
        device_name: device_name.to_owned(),
        last_heartbeat: None,
        prefs: crate::model::LocalPrefs::default(),
        remote_devices: std::collections::BTreeMap::new(),
        data: Shared::default(),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatFile {
    device_id: String,
    at: Ts,
}

/// Records that the app is alive, in a small file of its own. A heartbeat every 30 seconds used to
/// rewrite the whole store and its backup, which at 50k segments is 32 MB each time, for one number.
/// It is durable like any save. The next real save folds it into the main file and removes this.
pub fn save_heartbeat(paths: &Paths, device_id: &str, at: Ts) -> Result<(), CoreError> {
    let bytes = serde_json::to_vec(&HeartbeatFile {
        device_id: device_id.to_owned(),
        at,
    })?;
    with_local_retry(|| write_atomic(&paths.heartbeat(), &paths.heartbeat_tmp(), &bytes))?;
    Ok(())
}

/// The heartbeat on record for this device. An unreadable file says nothing, so the main file's stands.
fn read_heartbeat(paths: &Paths, device_id: &str) -> Option<Ts> {
    let bytes = fs::read(paths.heartbeat()).ok()?;
    let beat: HeartbeatFile = serde_json::from_slice(&bytes).ok()?;
    (beat.device_id == device_id).then_some(beat.at)
}

/// Brings a store just read up to date with the heartbeat recorded after it was last saved.
fn apply_heartbeat(paths: &Paths, mut file: LocalFile) -> LocalFile {
    if let Some(at) = read_heartbeat(paths, &file.device_id) {
        file.last_heartbeat = file.last_heartbeat.max(Some(at));
    }
    file
}

/// Keeps the original bytes of an older-format store the first time it is upgraded.
fn keep_before_migration(paths: &Paths, bytes: &[u8], version: u64) -> io::Result<()> {
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    let copy = paths.dir.join(format!("z-work-data.v{version}.json"));
    if copy.exists() {
        return Ok(());
    }
    let tmp = paths.dir.join(format!("z-work-data.v{version}.tmp"));
    write_atomic(&copy, &tmp, bytes)
}

/// Loads the store, recovering from `.bak` when needed. A newer-version file is refused and left alone.
pub fn load(
    paths: &Paths,
    device_name: &str,
    now: Ts,
) -> Result<(LocalFile, LoadOutcome), CoreError> {
    fs::create_dir_all(&paths.dir)?;
    let mut outcome = LoadOutcome::default();
    let main = read_opt(&paths.main())?;
    let bak = read_opt(&paths.bak())?;
    let had_main = main.is_some();

    if let Some(bytes) = &main {
        match parse_local(bytes) {
            Parsed::Good(file, version) => {
                keep_before_migration(paths, bytes, version)?;
                paths.remember_checked(bytes);
                return Ok((apply_heartbeat(paths, *file), outcome));
            }
            Parsed::Newer(found) => {
                return Err(CoreError::FutureVersion {
                    found,
                    supported: SCHEMA_VERSION,
                });
            }
            Parsed::Corrupt(why) => {
                let kept = quarantine(paths, &paths.main(), now)?;
                outcome.notices.push(format!(
                    "The data file was damaged ({why}). A copy was kept at {}.",
                    kept.display()
                ));
            }
        }
    }

    if let Some(bytes) = &bak {
        match parse_local(bytes) {
            Parsed::Good(file, _) => {
                outcome.notices.push(if had_main {
                    "Your data was restored from the automatic backup. The most recent change may be missing.".to_owned()
                } else {
                    "The data file was missing, so your data was restored from the automatic backup.".to_owned()
                });
                return Ok((apply_heartbeat(paths, *file), outcome));
            }
            Parsed::Newer(found) => {
                return Err(CoreError::FutureVersion {
                    found,
                    supported: SCHEMA_VERSION,
                });
            }
            Parsed::Corrupt(why) => {
                let kept = quarantine(paths, &paths.bak(), now)?;
                outcome.notices.push(format!(
                    "The automatic backup was also damaged ({why}). A copy was kept at {}. The app started with empty data.",
                    kept.display()
                ));
            }
        }
    }
    Ok((new_local_file(device_name), outcome))
}

/// Makes the current main file the backup. A hard link does it without copying the store: the backup
/// keeps those very bytes when the rename in `save` gives the main name to a new file. Where links
/// aren't available, such as FAT or exFAT, it falls back to a copy.
fn rotate_backup(paths: &Paths, current: &[u8]) -> io::Result<()> {
    let (bak, tmp) = (paths.bak(), paths.bak_tmp());
    let linked = with_local_retry(|| {
        let main = fs::symlink_metadata(paths.main())?;
        if !main.is_file() {
            return Err(io::Error::other("the main file is not a plain file"));
        }
        match fs::remove_file(&tmp) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        fs::hard_link(paths.main(), &tmp)?;
        fs::rename(&tmp, &bak)
    });
    match linked {
        Ok(()) => Ok(()),
        Err(_) => {
            // A failed attempt may have left the link behind. write_atomic replaces it, never follows it.
            with_local_retry(|| write_atomic(&bak, &tmp, current))
        }
    }
}

/// Saves the store. The current main file is rotated to `.bak` only when it is still valid, so a
/// main file damaged while running can never replace a good backup. Costs at 50k segments, in order:
/// serialising, reading back what will be written, then the writes. A main file this process wrote or
/// checked and that still hashes the same is not parsed again, and an unchanged store isn't rewritten.
pub fn save(paths: &Paths, file: &LocalFile, now: Ts) -> Result<(), CoreError> {
    let bytes = serde_json::to_vec(file)?;
    let current = read_opt(&paths.main())?;
    let known_good = current.as_ref().is_some_and(|c| paths.is_checked(c));
    if known_good && current.as_ref().is_some_and(|c| *c == bytes) {
        return Ok(());
    }
    // What cannot be read back must never replace the file that can.
    if let Err(why) = reads_back(&bytes, file) {
        return Err(CoreError::Validation(format!(
            "refusing to save data that cannot be read back: {why}"
        )));
    }
    let tmp = paths.tmp();
    with_local_retry(|| write_new(&tmp, &bytes))?;
    if let Some(current) = current {
        if !known_good && matches!(parse_local(&current), Parsed::Corrupt(_)) {
            quarantine(paths, &paths.main(), now)?;
        } else if let Err(e) = rotate_backup(paths, &current) {
            // A locked backup must not stop time logging; the next save rotates it again.
            eprintln!("could not refresh the backup: {e}");
        }
    }
    with_local_retry(|| fs::rename(&tmp, paths.main()))?;
    paths.remember_checked(&bytes);
    // The main file now holds the latest heartbeat. Left behind, an old one could outlive a restore.
    if let Err(e) = fs::remove_file(paths.heartbeat())
        && e.kind() != io::ErrorKind::NotFound
    {
        eprintln!("could not remove the old heartbeat: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// A store written by the phase 1 build, as it was on disk.
    const V1: &str = r##"{"version":1,"deviceId":"11111111-1111-4111-8111-111111111111","deviceName":"pc",
      "lastHeartbeat":"2026-03-01T09:10:00Z","prefs":{"theme":"dark","hideEarnings":true},
      "remoteDevices":{},"data":{
        "projects":{"p":{"id":"p","name":"Old","color":"#112233","billable":true,"createdAt":"2026-01-01T00:00:00Z",
          "stamp":{"at":"2026-01-01T00:00:00Z","by":"d"}}},
        "tasks":{"t":{"id":"t","name":"Old task","nameStamp":{"at":"2026-01-01T00:00:00Z","by":"d"},"projectId":"p",
          "projectStamp":{"at":"2026-01-01T00:00:00Z","by":"d"},"description":null,
          "descriptionStamp":{"at":"2026-01-01T00:00:00Z","by":"d"},"deletedStamp":{"at":"2026-01-01T00:00:00Z","by":"d"},
          "createdAt":"2026-01-01T00:00:00Z","state":"paused","pauseReason":{"kind":"user"},
          "stateStamp":{"at":"2026-01-01T00:00:00Z","by":"d"}}},
        "segments":{"s":{"id":"s","taskId":"t","deviceId":"d","start":"2026-03-01T09:00:00Z","end":"2026-03-01T09:10:00Z"}}
      }}"##;

    #[test]
    fn a_phase_1_store_loads_keeps_its_data_and_a_copy_of_the_original() {
        let d = tempfile::tempdir().unwrap();
        let paths = Paths::new(d.path());
        fs::write(paths.main(), V1).unwrap();
        let now = Ts::parse("2026-04-01T00:00:00Z").unwrap();
        let (file, _) = load(&paths, "pc", now).unwrap();
        assert_eq!(file.version, SCHEMA_VERSION);
        assert_eq!(file.data.tasks["t"].name, "Old task");
        assert!(file.data.tasks["t"].tags.is_empty());
        assert_eq!(
            file.data.segments["s"].effective().unwrap().0,
            Ts::parse("2026-03-01T09:00:00Z").unwrap()
        );
        assert_eq!(
            file.data.projects["p"].billing_type,
            crate::model::BillingType::Hourly
        );
        assert_eq!(
            fs::read_to_string(d.path().join("z-work-data.v1.json")).unwrap(),
            V1
        );
        save(&paths, &file, now).unwrap();
        let (again, _) = load(&paths, "pc", now).unwrap();
        assert_eq!(again, file);
    }

    #[test]
    fn a_phase_1_device_file_is_readable_and_passes_the_sync_checks() {
        let v: Value = serde_json::from_str(V1).unwrap();
        let text = serde_json::json!({
            "schemaVersion": 1, "deviceId": "d", "deviceName": "old pc",
            "writtenAt": "2026-03-01T09:10:00Z", "data": v["data"],
        })
        .to_string();
        let f: crate::model::DeviceFile = serde_json::from_str(&text).unwrap();
        let now = Ts::parse("2026-04-01T00:00:00Z").unwrap();
        crate::validate::check_device_file(&f, now).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::tests::{ctx, project_input};

    const NOW: Ts = Ts(1_800_000_000);

    fn with_project(name: &str) -> LocalFile {
        let mut f = new_local_file("pc");
        f.data
            .create_project(&ctx("2026-01-01T00:00:00Z"), &project_input(name))
            .unwrap();
        f
    }

    fn corrupt_files(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".corrupt-")
            })
            .count()
    }

    #[test]
    fn fresh_then_round_trip_keeps_one_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let (f0, o) = load(&p, "pc", NOW).unwrap();
        assert!(o.notices.is_empty());
        assert!(f0.data.projects.is_empty());
        let f1 = with_project("One");
        save(&p, &f1, NOW).unwrap();
        assert!(!p.bak().exists());
        let f2 = with_project("Two");
        save(&p, &f2, NOW).unwrap();
        assert_eq!(load(&p, "pc", NOW).unwrap().0, f2);
        assert_eq!(
            serde_json::from_slice::<LocalFile>(&fs::read(p.bak()).unwrap()).unwrap(),
            f1
        );
        assert!(!p.tmp().exists());
    }

    #[test]
    fn corrupt_main_recovers_from_backup_and_keeps_the_damaged_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let f1 = with_project("One");
        save(&p, &f1, NOW).unwrap();
        save(&p, &with_project("Two"), NOW).unwrap();
        fs::write(p.main(), b"{ not json").unwrap();
        let (loaded, o) = load(&p, "pc", NOW).unwrap();
        assert_eq!(loaded, f1);
        assert_eq!(o.notices.len(), 2, "{:?}", o.notices);
        assert_eq!(corrupt_files(dir.path()), 1);
    }

    #[test]
    fn truncated_main_and_empty_main_recover() {
        for damaged in [&b""[..], &b"{\"version\":1,\"deviceId\""[..]] {
            let dir = tempfile::tempdir().unwrap();
            let p = Paths::new(dir.path());
            let f1 = with_project("One");
            save(&p, &f1, NOW).unwrap();
            save(&p, &with_project("Two"), NOW).unwrap();
            fs::write(p.main(), damaged).unwrap();
            assert_eq!(load(&p, "pc", NOW).unwrap().0, f1);
        }
    }

    #[test]
    fn both_corrupt_keeps_both_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        fs::write(p.main(), b"junk").unwrap();
        fs::write(p.bak(), b"junk2").unwrap();
        let (f, o) = load(&p, "pc", NOW).unwrap();
        assert!(f.data.projects.is_empty());
        assert_eq!(corrupt_files(dir.path()), 2);
        assert!(o.notices.iter().any(|n| n.contains("empty data")));
    }

    #[test]
    fn missing_main_uses_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let f1 = with_project("One");
        save(&p, &f1, NOW).unwrap();
        fs::copy(p.main(), p.bak()).unwrap();
        fs::remove_file(p.main()).unwrap();
        let (loaded, o) = load(&p, "pc", NOW).unwrap();
        assert_eq!(loaded, f1);
        assert_eq!(o.notices.len(), 1);
    }

    #[test]
    fn newer_version_is_refused_and_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let bytes = br#"{"version":99,"future":true}"#;
        fs::write(p.main(), bytes).unwrap();
        assert!(matches!(
            load(&p, "pc", NOW),
            Err(CoreError::FutureVersion { found: 99, .. })
        ));
        assert_eq!(fs::read(p.main()).unwrap(), bytes);
    }

    #[test]
    fn a_heartbeat_touches_only_its_own_file_and_is_read_back_on_load() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let mut one = with_project("One");
        one.last_heartbeat = Some(Ts(NOW.0 - 60));
        save(&p, &one, NOW).unwrap();
        let before = fs::read(p.main()).unwrap();
        save_heartbeat(&p, &one.device_id, NOW).unwrap();
        assert_eq!(fs::read(p.main()).unwrap(), before);
        assert!(!p.bak().exists());
        assert_eq!(load(&p, "pc", NOW).unwrap().0.last_heartbeat, Some(NOW));
    }

    #[test]
    fn a_heartbeat_never_moves_the_store_backwards_or_crosses_stores() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let mut one = with_project("One");
        one.last_heartbeat = Some(NOW);
        save(&p, &one, NOW).unwrap();
        save_heartbeat(&p, &one.device_id, Ts(NOW.0 - 600)).unwrap();
        assert_eq!(load(&p, "pc", NOW).unwrap().0.last_heartbeat, Some(NOW));
        save_heartbeat(&p, "another-device", Ts(NOW.0 + 600)).unwrap();
        assert_eq!(load(&p, "pc", NOW).unwrap().0.last_heartbeat, Some(NOW));
        for junk in [&b""[..], b"{", b"{\"deviceId\":1}"] {
            fs::write(p.heartbeat(), junk).unwrap();
            assert_eq!(load(&p, "pc", NOW).unwrap().0.last_heartbeat, Some(NOW));
        }
    }

    #[test]
    fn a_real_save_folds_the_heartbeat_in_and_removes_its_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let mut one = with_project("One");
        save(&p, &one, NOW).unwrap();
        save_heartbeat(&p, &one.device_id, NOW).unwrap();
        one.last_heartbeat = Some(NOW);
        save(&p, &one, NOW).unwrap();
        assert!(!p.heartbeat().exists());
        assert!(!p.heartbeat_tmp().exists());
        // A store rolled back to an older heartbeat keeps it: nothing newer lingers to overrule it.
        one.last_heartbeat = Some(Ts(NOW.0 - 3600));
        save(&p, &one, NOW).unwrap();
        assert_eq!(load(&p, "pc", NOW).unwrap().0.last_heartbeat, Some(Ts(NOW.0 - 3600)));
    }

    #[test]
    fn a_store_recovered_from_the_backup_still_knows_the_latest_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let one = with_project("One");
        save(&p, &one, NOW).unwrap();
        save(&p, &with_project("Two"), NOW).unwrap();
        let bak: LocalFile = serde_json::from_slice(&fs::read(p.bak()).unwrap()).unwrap();
        save_heartbeat(&p, &bak.device_id, NOW).unwrap();
        fs::write(p.main(), b"junk").unwrap();
        let (loaded, _) = load(&p, "pc", NOW).unwrap();
        assert_eq!(loaded.device_id, one.device_id);
        assert_eq!(loaded.last_heartbeat, Some(NOW));
    }

    #[test]
    fn a_store_that_did_not_change_is_not_written_again() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let one = with_project("One");
        save(&p, &one, NOW).unwrap();
        let written = fs::metadata(p.main()).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        save(&p, &one, NOW).unwrap();
        assert_eq!(fs::metadata(p.main()).unwrap().modified().unwrap(), written);
        assert!(!p.bak().exists(), "the only version has nothing to back up");
    }

    #[test]
    fn a_file_changed_behind_the_app_is_parsed_again_even_when_it_still_parses() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let one = with_project("One");
        save(&p, &one, NOW).unwrap();
        // Valid, and not what this process wrote: it is rotated like any other good file.
        let other = with_project("Other");
        fs::write(p.main(), serde_json::to_vec(&other).unwrap()).unwrap();
        // The same store as last time must still be written, because the disk no longer holds it.
        save(&p, &one, NOW).unwrap();
        assert_eq!(load(&p, "pc", NOW).unwrap().0, one);
        assert_eq!(
            serde_json::from_slice::<LocalFile>(&fs::read(p.bak()).unwrap()).unwrap(),
            other
        );
    }

    #[test]
    fn a_file_that_already_held_these_bytes_is_still_checked_before_it_is_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let one = with_project("One");
        let bytes = serde_json::to_vec(&one).unwrap();
        fs::write(p.main(), &bytes).unwrap();
        // Nothing has checked this file yet, so it is written and rotated in the ordinary way.
        save(&p, &one, NOW).unwrap();
        assert_eq!(fs::read(p.bak()).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn rotating_leaves_the_backup_and_the_main_file_independent() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let (one, two, three) = (with_project("1"), with_project("2"), with_project("3"));
        for f in [&one, &two, &three] {
            save(&p, f, NOW).unwrap();
        }
        assert_eq!(fs::metadata(p.main()).unwrap().nlink(), 1);
        assert_eq!(fs::metadata(p.bak()).unwrap().nlink(), 1);
        assert_ne!(fs::metadata(p.main()).unwrap().ino(), fs::metadata(p.bak()).unwrap().ino());
        assert!(!p.bak_tmp().exists());
        assert_eq!(
            serde_json::from_slice::<LocalFile>(&fs::read(p.bak()).unwrap()).unwrap(),
            two
        );
        // Damage done to one file now stays in that file.
        fs::write(p.main(), b"junk").unwrap();
        assert_eq!(load(&p, "pc", NOW).unwrap().0, two);
    }

    #[cfg(unix)]
    #[test]
    fn a_main_file_that_is_a_link_is_copied_to_the_backup_and_its_target_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("store.json");
        let one = with_project("One");
        let bytes = serde_json::to_vec(&one).unwrap();
        fs::write(&target, &bytes).unwrap();
        let p = Paths::new(dir.path());
        std::os::unix::fs::symlink(&target, p.main()).unwrap();
        save(&p, &with_project("Two"), NOW).unwrap();
        assert_eq!(fs::read(p.bak()).unwrap(), bytes);
        assert_eq!(fs::read(&target).unwrap(), bytes);
        assert!(!fs::symlink_metadata(p.bak()).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_blocked_backup_does_not_stop_the_save() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        save(&p, &with_project("One"), NOW).unwrap();
        fs::create_dir(p.bak()).unwrap();
        let two = with_project("Two");
        save(&p, &two, NOW).unwrap();
        assert_eq!(
            serde_json::from_slice::<LocalFile>(&fs::read(p.main()).unwrap()).unwrap(),
            two
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_link_at_the_temporary_path_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, b"precious").unwrap();
        let p = Paths::new(dir.path());
        std::os::unix::fs::symlink(&victim, p.tmp()).unwrap();
        save(&p, &with_project("One"), NOW).unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"precious");
        let dest = dir.path().join("d");
        let tmp = dir.path().join("t");
        std::os::unix::fs::symlink(&victim, &tmp).unwrap();
        write_atomic(&dest, &tmp, b"data").unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"precious");
        assert_eq!(fs::read(&dest).unwrap(), b"data");
    }

    #[test]
    fn data_that_cannot_be_read_back_is_refused_and_the_store_survives() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let good = with_project("One");
        save(&p, &good, NOW).unwrap();
        let mut bad = with_project("Two");
        bad.last_heartbeat = Some(Ts(Ts::MAX.0 + 86_400));
        assert!(save(&p, &bad, NOW).is_err());
        assert_eq!(load(&p, "pc", NOW).unwrap().0, good);
        assert_eq!(corrupt_files(dir.path()), 0);
    }

    #[test]
    fn damaged_main_never_replaces_a_good_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path());
        let f1 = with_project("One");
        save(&p, &f1, NOW).unwrap();
        save(&p, &with_project("Two"), NOW).unwrap();
        let good_bak = fs::read(p.bak()).unwrap();
        fs::write(p.main(), b"oops").unwrap();
        save(&p, &with_project("Three"), NOW).unwrap();
        assert_eq!(fs::read(p.bak()).unwrap(), good_bak);
        assert_eq!(corrupt_files(dir.path()), 1);
    }
}
