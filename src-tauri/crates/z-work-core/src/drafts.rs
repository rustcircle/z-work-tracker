//! Edits as they are typed, kept in a small file of their own, so a shutdown that gives the page no
//! chance to save can't lose them. Replayed once at the next launch. Never synced.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::CoreError;
use crate::persist;
use crate::time::Ts;

const FILE: &str = "z-work-drafts.json";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub description: Value,
    pub at: Ts,
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
