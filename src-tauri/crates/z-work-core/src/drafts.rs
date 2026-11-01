//! Edits as they are typed, kept in a small file of their own, so a shutdown that gives the page no
//! chance to save can't lose them. Replayed once at the next launch. Never synced.
//!
//! Words the store won't take go to a second file. They are the only copy left, and what is typed
//! next replaces a draft, so only dismissing their notice ends them. Never synced either.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::CoreError;
use crate::persist;
use crate::time::Ts;

const FILE: &str = "z-work-drafts.json";
const KEPT_FILE: &str = "z-work-kept-words.json";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub description: Value,
    pub at: Ts,
    /// The stored description the words were typed over, as the editor showed it. Null for no
    /// description, and in a draft written before this was kept.
    #[serde(default)]
    pub base: Value,
}

/// A damaged or missing file is simply no drafts: this is only ever a second copy.
#[must_use]
pub fn read(dir: &Path) -> BTreeMap<String, Draft> {
    fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn write(dir: &Path, drafts: &BTreeMap<String, Draft>) -> Result<(), CoreError> {
    let path = dir.join(FILE);
    if drafts.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    let bytes = serde_json::to_vec(drafts)?;
    persist::write_atomic(&path, &dir.join(format!("{FILE}.tmp")), &bytes)?;
    Ok(())
}

/// Why the store won't take some words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeptBecause {
    /// The description they were typed over changed elsewhere while they waited.
    ChangedElsewhere,
    /// Their task no longer exists.
    TaskGone,
}

/// Words shown in a notice until it is dismissed, as plain text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub task_id: String,
    /// The task's name when they were kept, for a task that may be gone by the time they are read.
    pub name: String,
    pub words: String,
    pub at: Ts,
    pub because: KeptBecause,
}

/// The words kept. `None` if the file is there but can't be read, which unlike a draft is worth saying.
#[must_use]
pub fn read_kept(dir: &Path) -> Option<Vec<Kept>> {
    match fs::read(dir.join(KEPT_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
        Err(_) => None,
    }
}

pub fn write_kept(dir: &Path, kept: &[&Kept]) -> Result<(), CoreError> {
    let path = dir.join(KEPT_FILE);
    if kept.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        }
    }
    let bytes = serde_json::to_vec(kept)?;
    persist::write_atomic(&path, &dir.join(format!("{KEPT_FILE}.tmp")), &bytes)?;
    Ok(())
}

/// Moves a file that can't be read out of the way of the next write. Returns its new name.
pub fn set_aside_kept(dir: &Path) -> String {
    let name = format!("{KEPT_FILE}.damaged");
    let _ = fs::rename(dir.join(KEPT_FILE), dir.join(&name));
    name
}
