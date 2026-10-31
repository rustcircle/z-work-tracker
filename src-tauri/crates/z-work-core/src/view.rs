//! The read model the UI receives. Tokens of internal bookkeeping (stamps) stay out of it.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::detect::Detected;
use crate::machine::RequiredField;
use crate::model::{
    PauseReason, PendingCopy, RateVersion, RoundingVersion, ShiftVersion, SyncProvider, TaskState,
    Theme,
};
use crate::sync::TargetStatus;
use crate::time::Ts;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub color: String,
    pub archived: bool,
    pub billable: bool,
    pub budget_hours: Option<f64>,
    pub client_zone: Option<String>,
    pub created_at: Ts,
    pub has_tasks: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub description: Value,
    pub state: TaskState,
    pub pause_reason: Option<PauseReason>,
    pub created_at: Ts,
    pub stopped_at: Option<Ts>,
    /// Name of the other device this task is running on, if any.
    pub running_elsewhere: Option<String>,
    pub continued_from: Option<String>,
}

/// What a warm start copies into a new task, a snapshot of the most recently worked task.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySource {
    pub task_id: String,
    pub name: String,
    pub project_id: String,
    pub project_archived: bool,
    pub description: Value,
    pub last_worked_at: Option<Ts>,
}

/// Cold until the first task of this launch has started.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchView {
    pub warm: bool,
    pub cold_required: &'static [RequiredField],
    pub copy_source: Option<CopySource>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentView {
    pub id: String,
    pub task_id: String,
    pub device_id: String,
    pub start: Ts,
    pub end: Option<Ts>,
    /// For a segment still open on another device: the last moment known about it.
    pub provisional_end: Option<Ts>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub level: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetView {
    pub provider: SyncProvider,
    pub root: String,
    pub folder: String,
    pub status: TargetStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncView {
    pub targets: Vec<TargetView>,
    pub detected: Vec<Detected>,
    pub prompt_pending: bool,
    pub pending_copy: Option<PendingCopy>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsView {
    pub theme: Theme,
    pub hide_earnings: bool,
    pub last_currency: Option<String>,
    pub client_zone_prompt_done: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub now: Ts,
    pub device_id: String,
    pub device_name: String,
    pub system_zone: String,
    pub tzdb_version: &'static str,
    pub projects: Vec<ProjectView>,
    pub tasks: Vec<TaskView>,
    pub segments: Vec<SegmentView>,
    pub shifts: Vec<ShiftVersion>,
    pub rates: Vec<RateVersion>,
    pub rounding: Vec<RoundingVersion>,
    pub settings: BTreeMap<String, Value>,
    pub prefs: PrefsView,
    pub notices: Vec<Notice>,
    /// Always shown while they apply, such as a task running on two devices at once.
    pub warnings: Vec<String>,
    pub sync: SyncView,
    pub launch: LaunchView,
}
