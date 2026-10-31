//! Local store: versioned JSON, atomic write (temp, fsync, rename), one `.bak`, corrupt-file recovery.
//! Corrupt files are moved aside and kept. Nothing is ever silently wiped.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use uuid::Uuid;

use crate::error::CoreError;
use crate::model::{LocalFile, SCHEMA_VERSION, Shared};
use crate::time::Ts;
use crate::validate::check_core;

pub const MAIN_FILE: &str = "z-work-data.json";

#[derive(Clone, Debug)]
pub struct Paths {
    pub dir: PathBuf,
}

impl Paths {
    #[must_use]
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
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
fn migrate(value: Value) -> Value {
    value
}

#[derive(Debug)]
enum Parsed {
    Good(Box<LocalFile>),
    Corrupt(String),
    Newer(u64),
}

fn parse_local(bytes: &[u8]) -> Parsed {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return Parsed::Corrupt(e.to_string()),
    };
    let version = value.get("version").and_then(Value::as_u64);
    match version {
        None | Some(0) => return Parsed::Corrupt("no schema version".into()),
        Some(v) if v > SCHEMA_VERSION => return Parsed::Newer(v),
        Some(_) => {}
    }
    let value = migrate(value);
    let file: LocalFile = match serde_json::from_value(value) {
        Ok(f) => f,
        Err(e) => return Parsed::Corrupt(e.to_string()),
    };
    if let Err(e) = check_core(&file.data) {
        return Parsed::Corrupt(e.to_string());
    }
    Parsed::Good(Box::new(file))
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
            Parsed::Good(file) => return Ok((*file, outcome)),
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
            Parsed::Good(file) => {
                outcome.notices.push(if had_main {
                    "Your data was restored from the automatic backup. The most recent change may be missing.".to_owned()
                } else {
                    "The data file was missing, so your data was restored from the automatic backup.".to_owned()
                });
                return Ok((*file, outcome));
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

/// Saves the store. The current main file is rotated to `.bak` only when it is still valid, so a
/// main file damaged while running can never replace a good backup.
pub fn save(paths: &Paths, file: &LocalFile, now: Ts) -> Result<(), CoreError> {
    let bytes = serde_json::to_vec(file)?;
    // What cannot be read back must never replace the file that can.
    if let Parsed::Corrupt(why) = parse_local(&bytes) {
        return Err(CoreError::Validation(format!(
            "refusing to save data that cannot be read back: {why}"
        )));
    }
    let tmp = paths.tmp();
    with_local_retry(|| write_new(&tmp, &bytes))?;
    if let Some(current) = read_opt(&paths.main())? {
        if matches!(parse_local(&current), Parsed::Corrupt(_)) {
            quarantine(paths, &paths.main(), now)?;
        } else if let Err(e) =
            with_local_retry(|| write_atomic(&paths.bak(), &paths.bak_tmp(), &current))
        {
            // A locked backup must not stop time logging; the next save rotates it again.
            eprintln!("could not refresh the backup: {e}");
        }
    }
    with_local_retry(|| fs::rename(&tmp, paths.main()))?;
    Ok(())
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
