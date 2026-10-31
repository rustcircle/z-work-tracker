//! Persisted and synced data model. Every replicated record carries the clock that merging needs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::time::Ts;

pub const SCHEMA_VERSION: u64 = 2;

fn yes() -> bool {
    true
}

/// Version-stamped writer info for last-writer-wins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    pub at: Ts,
    pub by: String,
}

/// The stamp of a field a schema 1 file didn't have: older than any real edit, so any edit wins.
impl Default for Stamp {
    fn default() -> Self {
        Self {
            at: Ts::EARLIEST,
            by: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BillingType {
    #[default]
    Hourly,
    FixedFee,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub archived: bool,
    /// Tombstone so a deleted project never comes back through sync.
    #[serde(default)]
    pub deleted: bool,
    /// When false the project earns nothing, whatever its rate history says.
    #[serde(default = "yes")]
    pub billable: bool,
    #[serde(default)]
    pub budget_hours: Option<f64>,
    #[serde(default)]
    pub client_zone: Option<String>,
    #[serde(default)]
    pub billing_type: BillingType,
    /// The agreed price of a fixed-fee project, in cents of `fee_currency`.
    #[serde(default)]
    pub fixed_fee_cents: Option<i64>,
    #[serde(default)]
    pub fee_currency: Option<String>,
    pub created_at: Ts,
    pub stamp: Stamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Draft,
    Running,
    Paused,
    Stopped,
}

impl TaskState {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
        }
    }
    /// Join rank: stopped is final and beats every other state in a merge.
    #[must_use]
    pub fn rank(self) -> u8 {
        u8::from(self == Self::Stopped)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PauseReason {
    User,
    AutoPaused {
        #[serde(rename = "byTaskId")]
        by_task_id: String,
    },
    AppQuit,
    CrashRecovery,
    SyncReconciled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub name: String,
    pub name_stamp: Stamp,
    pub project_id: String,
    pub project_stamp: Stamp,
    /// TipTap document JSON or null. Rendered only through the editor.
    #[serde(default)]
    pub description: Value,
    pub description_stamp: Stamp,
    #[serde(default)]
    pub deleted: bool,
    pub deleted_stamp: Stamp,
    /// The task this one continues. Set once at creation, for traceability.
    #[serde(default)]
    pub continued_from: Option<String>,
    pub created_at: Ts,
    pub state: TaskState,
    #[serde(default)]
    pub pause_reason: Option<PauseReason>,
    /// Clock for state and pause reason, independent of edits to metadata.
    pub state_stamp: Stamp,
    #[serde(default)]
    pub stopped_at: Option<Ts>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tags_stamp: Stamp,
    /// The subtask new segments of this task are attributed to.
    #[serde(default)]
    pub active_subtask: Option<String>,
    #[serde(default)]
    pub active_subtask_stamp: Stamp,
}

impl Task {
    /// A deleted draft is gone. If another device logged time on it meanwhile, the time wins.
    #[must_use]
    pub fn is_live(&self) -> bool {
        !self.deleted || self.state != TaskState::Draft
    }
}

/// One unit of work. Only the owning device ever closes its own segment.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub task_id: String,
    pub device_id: String,
    /// Raw times. Corrections go in `edit`, so these stay exactly as recorded.
    pub start: Ts,
    pub end: Option<Ts>,
    /// Entered by hand rather than timed.
    #[serde(default)]
    pub manual: bool,
    #[serde(default)]
    pub subtask_id: Option<String>,
    /// A correction laid over the raw times.
    #[serde(default)]
    pub edit: Option<SegmentEdit>,
    #[serde(default)]
    pub edit_stamp: Stamp,
}

impl Segment {
    /// The times that count, or `None` when voided. The end is `None` while running.
    #[must_use]
    pub fn effective(&self) -> Option<(Ts, Option<Ts>)> {
        match &self.edit {
            Some(e) if e.voided => None,
            Some(e) => Some((e.start, Some(e.end))),
            None => Some((self.start, self.end)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentEdit {
    pub start: Ts,
    pub end: Ts,
    #[serde(default)]
    pub voided: bool,
    #[serde(default)]
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GapKind {
    /// The machine slept, or the clock jumped between heartbeats.
    Sleep,
    /// No keyboard or mouse input, including while the screen was locked.
    Idle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GapDecision {
    /// Unanswered. Counts in nothing until confirmed.
    Pending,
    Keep,
    Drop,
    Thinking,
}

/// Time away detected inside a running segment. The segment's raw times don't change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleGap {
    pub id: String,
    pub segment_id: String,
    pub task_id: String,
    pub device_id: String,
    pub start: Ts,
    pub end: Ts,
    pub kind: GapKind,
    pub decision: GapDecision,
    pub decision_stamp: Stamp,
}

/// A pause the user marked as still working. It counts in Billable and never in Exact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillablePause {
    pub id: String,
    pub task_id: String,
    pub start: Ts,
    pub end: Ts,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub deleted: bool,
    pub stamp: Stamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub deleted: bool,
    pub stamp: Stamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub description: Value,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub deleted: bool,
    pub stamp: Stamp,
}

/// One line of the record of changes to logged time. Entries are only ever added.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub at: Ts,
    pub by: String,
    pub entity: String,
    pub entity_id: String,
    pub action: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub before: Value,
    #[serde(default)]
    pub after: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub task_id: String,
    pub task_name: String,
    pub day: String,
    pub exact_secs: i64,
    #[serde(default)]
    pub pause_secs: i64,
    pub billable_secs: i64,
    pub cents: BTreeMap<String, i64>,
}

/// A billing summary for the user's own guidance. Not an invoice, and not a tax document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingSummary {
    pub id: String,
    /// `<prefix>-<number>`, such as `A-001`. Unique per device, not one global sequence.
    pub reference: String,
    pub prefix: String,
    pub number: u32,
    pub device_id: String,
    pub project_id: String,
    pub from: String,
    pub to: String,
    pub zone: String,
    pub created_at: Ts,
    pub segment_ids: Vec<String>,
    #[serde(default)]
    pub pause_ids: Vec<String>,
    pub rows: Vec<SummaryRow>,
    pub totals: BTreeMap<String, i64>,
    #[serde(default)]
    pub voided: bool,
    pub stamp: Stamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePrefix {
    pub prefix: String,
    pub stamp: Stamp,
}

/// One date-effective version of a work shift. A shift's history is a set of versions sharing
/// `shift_id`; for a given date the version with the latest `effective_from` on or before it applies.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftVersion {
    pub id: String,
    pub shift_id: String,
    /// `YYYY-MM-DD`, in the shift's own zone.
    pub effective_from: String,
    pub name: String,
    pub color: String,
    /// Wall-clock `HH:MM` in `zone`. `end <= start` means the shift crosses midnight.
    pub start: String,
    pub end: String,
    /// ISO weekdays, 1 = Monday .. 7 = Sunday, of the date the shift starts on.
    pub weekdays: Vec<u8>,
    pub zone: String,
    #[serde(default)]
    pub break_minutes: u32,
    /// From `effective_from` on, this shift no longer exists. Earlier dates keep their versions.
    #[serde(default)]
    pub retired: bool,
    #[serde(default)]
    pub deleted: bool,
    pub stamp: Stamp,
}

/// A project's price per hour from `effective_from` on. Past earnings never change when a new
/// version is added. `rate_cents: None` means "no rate" from that moment, which is not the same as 0.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateVersion {
    pub id: String,
    pub project_id: String,
    pub effective_from: Ts,
    pub rate_cents: Option<i64>,
    /// `EUR` or `USD`.
    pub currency: String,
    #[serde(default)]
    pub deleted: bool,
    pub stamp: Stamp,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoundMethod {
    Nearest,
    #[default]
    Up,
    Down,
}

/// How time is rounded for days on or after `effective_from`. `increment_minutes: 0` means exact.
/// With `project_id` set it overrides the global setting for that project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundingVersion {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// `YYYY-MM-DD`, compared with the row's day in the zone being reported.
    pub effective_from: String,
    pub increment_minutes: u32,
    pub method: RoundMethod,
    #[serde(default)]
    pub deleted: bool,
    pub stamp: Stamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingEntry {
    pub value: Value,
    pub stamp: Stamp,
}

/// The replicated state: a join-semilattice, see `merge`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shared {
    #[serde(default)]
    pub projects: BTreeMap<String, Project>,
    #[serde(default)]
    pub tasks: BTreeMap<String, Task>,
    #[serde(default)]
    pub segments: BTreeMap<String, Segment>,
    #[serde(default)]
    pub settings: BTreeMap<String, SettingEntry>,
    #[serde(default)]
    pub shifts: BTreeMap<String, ShiftVersion>,
    #[serde(default)]
    pub rates: BTreeMap<String, RateVersion>,
    #[serde(default)]
    pub rounding: BTreeMap<String, RoundingVersion>,
    #[serde(default)]
    pub gaps: BTreeMap<String, IdleGap>,
    #[serde(default)]
    pub pauses: BTreeMap<String, BillablePause>,
    #[serde(default)]
    pub tags: BTreeMap<String, Tag>,
    #[serde(default)]
    pub templates: BTreeMap<String, Template>,
    #[serde(default)]
    pub summaries: BTreeMap<String, BillingSummary>,
    /// Summary reference prefix per device id.
    #[serde(default)]
    pub prefixes: BTreeMap<String, DevicePrefix>,
    #[serde(default)]
    pub audit_log: BTreeMap<String, AuditEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncProvider {
    OneDrive,
    GoogleDrive,
    Custom,
}

/// A local folder kept in the cloud by a desktop client. Data lives in `<root>/zWorkTracker/`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTarget {
    pub provider: SyncProvider,
    pub root: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    Light,
    SolarizedLight,
    SolarizedDark,
    Dark,
}

/// Device-local preferences, never replicated.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPrefs {
    /// Every enabled folder. Empty means sync is off. Never filled without the user's choice.
    #[serde(default)]
    pub sync_targets: Vec<SyncTarget>,
    #[serde(default)]
    pub sync_prompt_done: bool,
    #[serde(default)]
    pub client_zone_prompt_done: bool,
    #[serde(default)]
    pub hide_notice_shown: bool,
    #[serde(default)]
    pub theme: Theme,
    #[serde(default)]
    pub hide_earnings: bool,
    #[serde(default)]
    pub last_currency: Option<String>,
    /// How many daily backups to keep. `None` means the default.
    #[serde(default)]
    pub backup_keep: Option<u32>,
    /// The highest budget alert already shown per project, so each threshold notifies once.
    #[serde(default)]
    pub budget_alerts_seen: BTreeMap<String, u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub name: String,
    pub last_heartbeat: Option<Ts>,
    pub written_at: Ts,
}

/// The local store: `z-work-data.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub version: u64,
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub last_heartbeat: Option<Ts>,
    #[serde(default)]
    pub prefs: LocalPrefs,
    #[serde(default)]
    pub remote_devices: BTreeMap<String, RemoteDevice>,
    #[serde(default)]
    pub data: Shared,
}

/// What each device writes to `<root>/zWorkTracker/devices/<device-uuid>.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFile {
    pub schema_version: u64,
    pub device_id: String,
    pub device_name: String,
    pub written_at: Ts,
    #[serde(default)]
    pub last_heartbeat: Option<Ts>,
    pub data: Shared,
}
