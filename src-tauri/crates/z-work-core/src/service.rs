//! The application service: owns the store, applies each change transactionally and builds the view.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::adjust::{CorrectionInput, ManualEntryInput, PauseInput};
use crate::backup::{self, BackupInfo};
use crate::catalog::{TagInput, TemplateInput};
use crate::detect::Detected;
use crate::error::CoreError;
use crate::idle::{IdleTracker, NewGap};
use crate::machine::{
    Ctx, ProjectInput, RateInput, RequiredField, RoundingInput, ShiftInput, TaskInput, TaskPatch,
    Transition, cold_required, doc_has_text,
};
use crate::merge::merge;
use crate::model::{
    AuditEntry, DeviceFile, GapDecision, GapKind, LocalFile, PauseReason, PendingCopy,
    RemoteDevice, SCHEMA_VERSION, Segment, Shared, SyncTarget, Task, TaskState, Theme,
};
use crate::persist::{self, Paths};
use crate::pieces;
use crate::reminder::{self, Reminder};
use crate::report::ExportSource;
use crate::subtasks;
use crate::summary::{
    ProjectFigures, SummaryPreview, SummaryRequest, project_figures, task_totals,
};
use crate::sync::{APP_FOLDER, HungTargets, TargetStatus};
use crate::time::{Clock, Ts};
use crate::view::{
    BillingView, CopySource, LaunchView, Notice, PrefsView, ProjectView, RawSegmentView,
    ReminderSettings, SegmentView, Snapshot, SubtaskView, SyncView, TargetView, TaskView,
};

pub struct Service {
    paths: Paths,
    file: LocalFile,
    clock: Arc<dyn Clock>,
    notices: Vec<Notice>,
    next_notice: u64,
    targets: BTreeMap<String, TargetStatus>,
    detected: Vec<Detected>,
    system_zone: String,
    /// Bumped on every committed change, so the app knows when to schedule a sync.
    revision: u64,
    /// False on every real launch, until the first task of this launch has started. Never saved.
    warm: bool,
    /// The task most recently worked in this launch: what a warm start copies.
    last_worked: Option<String>,
    /// A failure to save merged data. Folder writes must not clear it.
    local_error: Option<String>,
    hung: HungTargets,
    idle: IdleTracker,
    /// The reminder is quiet until this moment.
    reminder_quiet_until: Option<Ts>,
    /// The reminder last shown as a system notification, so it isn't repeated each minute.
    reminder_told: Option<Reminder>,
    /// Time away found but not yet saved, with the segment it belongs to. Kept until a save works.
    unsaved_gaps: Vec<(String, NewGap)>,
}

/// The setting's value in minutes, or the default when it was never set. `null` or 0 is off.
fn minutes_setting(data: &Shared, key: &str, default: i64) -> i64 {
    match data.settings.get(key).map(|e| &e.value) {
        None => default,
        Some(v) => v.as_i64().unwrap_or(0).max(0),
    }
}

const DEFAULT_IDLE_MINUTES: i64 = 10;
pub const PDF_LOGO_FILE: &str = "pdf-logo.png";

impl Service {
    /// Opens the store. An open segment left by a crash is closed at the last heartbeat here.
    pub fn open(dir: &Path, clock: Arc<dyn Clock>, device_name: &str) -> Result<Self, CoreError> {
        let paths = Paths::new(dir);
        let now = clock.now();
        let (file, outcome) = persist::load(&paths, device_name, now)?;
        let mut svc = Self {
            paths,
            file,
            clock,
            notices: Vec::new(),
            next_notice: 1,
            targets: BTreeMap::new(),
            detected: Vec::new(),
            system_zone: "UTC".to_owned(),
            revision: 0,
            warm: false,
            last_worked: None,
            local_error: None,
            hung: HungTargets::default(),
            idle: IdleTracker::default(),
            reminder_quiet_until: None,
            reminder_told: None,
            unsaved_gaps: Vec::new(),
        };
        svc.file.data.seed_tags();
        svc.file.data.normalize();
        for n in outcome.notices {
            svc.notify("warning", n);
        }
        svc.recover_crash()?;
        // Writes the store on first launch too, so the data folder always holds a valid file.
        persist::save(&svc.paths, &svc.file, now)?;
        Ok(svc)
    }

    fn recover_crash(&mut self) -> Result<(), CoreError> {
        let device = self.file.device_id.clone();
        let away = self.file.prefs.away_since.take();
        let Some(segment) = self.file.data.own_open_segments(&device).into_iter().next() else {
            return Ok(());
        };
        let now = self.now();
        let ctx = Ctx {
            now,
            device: &device,
        };
        // The last heartbeat is the last moment the app is known to have been alive.
        let at = self.file.last_heartbeat.unwrap_or(Ts(i64::MIN / 2));
        // The app was alive but nobody was there, so that time stays unconfirmed.
        if let Some(away) = away {
            self.file
                .data
                .add_gap(&ctx, &segment, away, at, GapKind::Idle);
        }
        let names = self
            .file
            .data
            .close_own_open(&ctx, at, &PauseReason::CrashRecovery);
        self.notify(
            "warning",
            format!(
                "The app did not shut down cleanly. {} was paused at its last recorded moment ({}). Time after that was not logged. The next start asks for every field.",
                names.join(", "),
                self.file.last_heartbeat.map_or_else(|| "its start".to_owned(), |h| h.iso()),
            ),
        );
        Ok(())
    }

    fn notify(&mut self, level: &'static str, message: String) {
        self.notices.push(Notice {
            id: self.next_notice.to_string(),
            level,
            message,
        });
        self.next_notice += 1;
    }

    #[must_use]
    pub fn now(&self) -> Ts {
        self.clock.now()
    }

    #[must_use]
    pub fn file(&self) -> &LocalFile {
        &self.file
    }

    #[must_use]
    pub fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub fn data_dir(&self) -> &Path {
        &self.paths.dir
    }

    #[must_use]
    pub fn snapshot_system_zone(&self) -> String {
        self.system_zone.clone()
    }

    pub fn set_system_zone(&mut self, zone: String) {
        self.system_zone = zone;
    }

    pub fn set_detected(&mut self, detected: Vec<Detected>) {
        self.detected = detected;
    }

    /// Applies a change to a copy, saves it, and only then adopts it. If saving fails nothing changes.
    pub fn mutate<R>(
        &mut self,
        f: impl FnOnce(&mut LocalFile, &Ctx<'_>) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        let now = self.now();
        let device = self.file.device_id.clone();
        let ctx = Ctx {
            now,
            device: &device,
        };
        let mut next = self.file.clone();
        let out = f(&mut next, &ctx)?;
        persist::save(&self.paths, &next, now)?;
        self.file = next;
        self.revision += 1;
        self.local_error = None;
        Ok(out)
    }

    pub fn create_project(&mut self, input: &ProjectInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.create_project(c, input))
    }
    pub fn update_project(&mut self, id: &str, input: &ProjectInput) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.update_project(c, id, input))
    }
    pub fn set_project_archived(&mut self, id: &str, archived: bool) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.set_project_archived(c, id, archived))
    }
    pub fn delete_project(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.delete_project(c, id))
    }
    pub fn create_task(&mut self, input: &TaskInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.create_task(c, input))
    }
    pub fn update_task(&mut self, id: &str, input: &TaskInput) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.update_task(c, id, input))
    }
    pub fn patch_task(&mut self, id: &str, patch: &TaskPatch) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.patch_task(c, id, patch))
    }
    pub fn delete_draft(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.delete_draft(c, id))
    }

    fn with_beat<R>(f: &mut LocalFile, c: &Ctx<'_>, r: R) -> R {
        f.last_heartbeat = Some(c.now);
        r
    }

    /// A cold launch: every required field must be filled before the first start, enforced here.
    fn check_cold_fields(&self, id: &str) -> Result<(), CoreError> {
        if self.warm {
            return Ok(());
        }
        let task = self
            .file
            .data
            .tasks
            .get(id)
            .filter(|t| t.is_live())
            .ok_or(CoreError::NotFound("task"))?;
        for field in cold_required(&self.file.data) {
            let missing = match field {
                RequiredField::Name => task.name.trim().is_empty(),
                RequiredField::Project => task.project_id.is_empty(),
                RequiredField::Description => !doc_has_text(&task.description),
                RequiredField::Tags => !task
                    .tags
                    .iter()
                    .any(|t| self.file.data.tags.get(t).is_some_and(|x| !x.deleted)),
            };
            if missing {
                let label = match field {
                    RequiredField::Name => "Task name",
                    RequiredField::Project => "Project",
                    RequiredField::Description => "Description",
                    RequiredField::Tags => "A tag",
                };
                return Err(CoreError::Validation(format!(
                    "{label} is required for the first start after launch"
                )));
            }
        }
        Ok(())
    }

    pub fn start_task(&mut self, id: &str) -> Result<Transition, CoreError> {
        self.check_cold_fields(id)?;
        self.settle_away()?;
        let out = self.mutate(|f, c| {
            let out = f.data.start(c, id)?;
            Ok(Self::with_beat(f, c, out))
        })?;
        self.warm = true;
        self.last_worked = Some(id.to_owned());
        Ok(out)
    }

    /// Refused on a cold launch: continuing then means a new linked task with every field filled in.
    pub fn resume_task(&mut self, id: &str) -> Result<Transition, CoreError> {
        if !self.warm {
            return Err(CoreError::ColdStartRequired);
        }
        self.settle_away()?;
        let out = self.mutate(|f, c| {
            let out = f.data.resume(c, id)?;
            Ok(Self::with_beat(f, c, out))
        })?;
        self.last_worked = Some(id.to_owned());
        Ok(out)
    }

    pub fn pause_task(&mut self, id: &str) -> Result<(), CoreError> {
        self.settle_away()?;
        self.mutate(|f, c| {
            f.data
                .pause(c, id)
                .map_err(|e| name_device(e, f.remote_devices.clone()))
        })
    }

    pub fn stop_task(&mut self, id: &str) -> Result<(), CoreError> {
        self.settle_away()?;
        self.mutate(|f, c| f.data.stop(c, id))
    }

    #[must_use]
    pub fn is_warm(&self) -> bool {
        self.warm
    }

    #[must_use]
    pub fn hung_targets(&self) -> HungTargets {
        Arc::clone(&self.hung)
    }

    fn copy_source(&self) -> Option<CopySource> {
        let data = &self.file.data;
        let task = data
            .tasks
            .get(self.last_worked.as_ref()?)
            .filter(|t| t.is_live())?;
        let project = data.projects.get(&task.project_id);
        Some(CopySource {
            task_id: task.id.clone(),
            name: task.name.clone(),
            project_id: task.project_id.clone(),
            project_archived: project.is_none_or(|p| p.archived || p.deleted),
            // A copy keeps subtask text, with ticks cleared and no time carried over.
            description: crate::subtasks::reset(&task.description),
            tags: task
                .tags
                .iter()
                .filter(|t| data.tags.get(*t).is_some_and(|x| !x.deleted))
                .cloned()
                .collect(),
            last_worked_at: data
                .segments
                .values()
                .filter(|s| s.task_id == task.id)
                .map(|s| s.end.unwrap_or(s.start))
                .max(),
        })
    }

    pub fn add_manual_entry(&mut self, input: &ManualEntryInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.add_manual_entry(c, input))
    }
    pub fn correct_segment(&mut self, input: &CorrectionInput) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.correct_segment(c, input))
    }
    pub fn void_segment(&mut self, id: &str, reason: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.void_segment(c, id, reason))
    }
    pub fn restore_segment(&mut self, id: &str, reason: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.restore_segment(c, id, reason))
    }
    pub fn decide_gap(&mut self, id: &str, decision: GapDecision) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.decide_gap(c, id, decision))
    }
    pub fn mark_billable_pause(&mut self, input: &PauseInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.mark_billable_pause(c, input))
    }
    pub fn unmark_billable_pause(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.unmark_billable_pause(c, id))
    }
    pub fn set_active_subtask(
        &mut self,
        task: &str,
        subtask: Option<&str>,
    ) -> Result<(), CoreError> {
        self.settle_away()?;
        self.mutate(|f, c| f.data.set_active_subtask(c, task, subtask))
    }
    pub fn save_tag(&mut self, input: &TagInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.save_tag(c, input))
    }
    pub fn delete_tag(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.delete_tag(c, id))
    }
    pub fn save_template(&mut self, input: &TemplateInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.save_template(c, input))
    }
    pub fn delete_template(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.delete_template(c, id))
    }
    pub fn task_from_template(
        &mut self,
        id: &str,
        project: Option<&str>,
    ) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.task_from_template(c, id, project))
    }
    pub fn summary_preview(&self, req: &SummaryRequest) -> Result<SummaryPreview, CoreError> {
        self.file.data.summary_preview(req)
    }
    pub fn create_summary(&mut self, req: &SummaryRequest) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.create_summary(c, req))
    }
    pub fn void_summary(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.void_summary(c, id))
    }
    pub fn set_device_prefix(&mut self, prefix: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.set_device_prefix(c, prefix))
    }

    /// The record of changes to one item, newest first, or all of them.
    #[must_use]
    pub fn audit_entries(&self, entity_id: Option<&str>) -> Vec<AuditEntry> {
        let mut out: Vec<AuditEntry> = self
            .file
            .data
            .audit_log
            .values()
            .filter(|a| entity_id.is_none_or(|id| a.entity_id == id))
            .cloned()
            .collect();
        out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// Called every few seconds with the OS's idle time. Returns true when time away was found.
    pub fn observe_activity(&mut self, idle_secs: Option<u64>) -> Result<bool, CoreError> {
        let device = self.file.device_id.clone();
        let running = self.file.data.own_open_segments(&device).into_iter().next();
        let threshold = minutes_setting(&self.file.data, "idleMinutes", DEFAULT_IDLE_MINUTES);
        let gaps = self.idle.tick(
            self.now(),
            running.is_some(),
            idle_secs,
            u64::try_from(threshold).unwrap_or(0) * 60,
        );
        if let Some(segment) = running {
            self.unsaved_gaps
                .extend(gaps.into_iter().map(|g| (segment.clone(), g)));
        }
        self.save_away()
    }

    /// Writes found time away and the absence in progress. True when time away was recorded.
    fn save_away(&mut self) -> Result<bool, CoreError> {
        let away = self.idle.away_since();
        if self.unsaved_gaps.is_empty() && self.file.prefs.away_since == away {
            return Ok(false);
        }
        let gaps = self.unsaved_gaps.clone();
        self.mutate(|f, c| {
            for (segment, g) in &gaps {
                f.data.add_gap(c, segment, g.start, g.end, g.kind);
            }
            f.prefs.away_since = away;
            Ok(())
        })?;
        self.unsaved_gaps.clear();
        Ok(!gaps.is_empty())
    }

    /// Every path that closes the running segment comes through here first, so time away already
    /// under way is recorded and never silently counts as work.
    fn settle_away(&mut self) -> Result<(), CoreError> {
        let device = self.file.device_id.clone();
        let running = self.file.data.own_open_segments(&device).into_iter().next();
        let gaps = self.idle.settle(self.now());
        if let Some(segment) = running {
            self.unsaved_gaps
                .extend(gaps.into_iter().map(|g| (segment.clone(), g)));
        }
        self.save_away().map(|_| ())
    }

    #[must_use]
    pub fn current_reminder(&self) -> Option<Reminder> {
        if self.reminder_quiet_until.is_some_and(|q| q > self.now()) {
            return None;
        }
        let data = &self.file.data;
        reminder::due(
            data,
            &self.file.device_id,
            self.now(),
            minutes_setting(data, "longRunMinutes", reminder::DEFAULT_LONG_RUN_MINUTES),
            data.settings
                .get("remindPastShift")
                .and_then(|e| e.value.as_bool())
                .unwrap_or(true),
        )
    }

    /// Quiets the reminder for a while. Keeps running: this isn't a pause.
    pub fn snooze_reminder(&mut self, minutes: i64) {
        self.reminder_quiet_until = Some(self.now().later(minutes.clamp(1, 24 * 60) * 60));
    }

    fn figures(&self) -> BTreeMap<String, ProjectFigures> {
        let tz = crate::validate::parse_zone(&self.system_zone).unwrap_or(chrono_tz::UTC);
        let source = self.export_source();
        project_figures(&self.file.data, tz, &|s: &Segment| source.end_of(s))
    }

    /// What deserves a system notification now. Each budget threshold and reminder notifies once.
    pub fn take_alerts(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        let figures = self.figures();
        let mut seen = self.file.prefs.budget_alerts_seen.clone();
        for (id, f) in &figures {
            let Some(b) = &f.budget else { continue };
            if b.level > seen.get(id).copied().unwrap_or(0)
                && let Some(p) = self.file.data.projects.get(id).filter(|p| !p.archived)
            {
                out.push(format!(
                    "{} has reached {}% of its {}.",
                    p.name,
                    b.percent,
                    if b.basis == "fee" {
                        "fixed fee"
                    } else {
                        "budget"
                    }
                ));
                seen.insert(id.clone(), b.level);
            }
        }
        if seen != self.file.prefs.budget_alerts_seen {
            let _ = self.mutate(|f, _| {
                f.prefs.budget_alerts_seen = seen;
                Ok(())
            });
        }
        let reminder = self.current_reminder();
        if reminder != self.reminder_told {
            if let Some(r) = &reminder {
                let name = |id: &str| {
                    self.file
                        .data
                        .tasks
                        .get(id)
                        .map_or_else(String::new, |t| t.name.clone())
                };
                out.push(match r {
                    Reminder::LongRun { task_id, .. } => {
                        format!(
                            "{} has been running a long time. Still working on it?",
                            name(task_id)
                        )
                    }
                    Reminder::PastShift { task_id, shift, .. } => {
                        format!("{} is still running after {shift} ended.", name(task_id))
                    }
                });
            }
            self.reminder_told = reminder;
        }
        out
    }

    /// Writes today's dated copy if it's missing.
    pub fn run_daily_backup(&self) -> Result<bool, CoreError> {
        backup::daily(&self.paths, &self.file, self.now(), self.backup_keep())
    }

    fn backup_keep(&self) -> u32 {
        self.file.prefs.backup_keep.unwrap_or(backup::DEFAULT_KEEP)
    }

    pub fn set_backup_keep(&mut self, keep: u32) -> Result<(), CoreError> {
        if !(1..=365).contains(&keep) {
            return Err(CoreError::Validation(
                "keep between 1 and 365 backups".into(),
            ));
        }
        self.mutate(|f, _| {
            f.prefs.backup_keep = Some(keep);
            Ok(())
        })
    }

    pub fn list_backups(&self) -> Result<Vec<BackupInfo>, CoreError> {
        Ok(backup::list(&self.paths)?)
    }

    /// Replaces the store with a backup, keeping a safety copy of the current one first. Settings of
    /// this device, such as sync folders, stay as they are. The launch counts as cold afterwards.
    pub fn restore_backup(&mut self, name: &str) -> Result<String, CoreError> {
        let mut restored = backup::read(&self.paths, name)?;
        self.on_exit()?;
        let safety = backup::safety_copy(&self.paths, &self.file, self.now())?;
        restored.prefs = self.file.prefs.clone();
        restored.device_id = self.file.device_id.clone();
        restored.device_name = self.file.device_name.clone();
        restored.remote_devices = self.file.remote_devices.clone();
        persist::save(&self.paths, &restored, self.now())?;
        self.file = restored;
        self.file.data.seed_tags();
        self.file.data.normalize();
        self.recover_crash()?;
        persist::save(&self.paths, &self.file, self.now())?;
        self.revision += 1;
        self.warm = false;
        self.last_worked = None;
        self.notify(
            "info",
            format!("Restored {name}. The data just before it is kept as {safety}."),
        );
        if !self.file.prefs.sync_targets.is_empty() {
            self.notify(
                "warning",
                "Sync is on, so newer records in your sync folders will merge back in at the next sync.".to_owned(),
            );
        }
        Ok(safety)
    }

    pub fn save_shift(&mut self, input: &ShiftInput) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.save_shift(c, input))
    }
    pub fn delete_shift(&mut self, shift_id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.delete_shift(c, shift_id))
    }
    pub fn set_rate(&mut self, input: &RateInput) -> Result<(), CoreError> {
        self.mutate(|f, c| {
            f.data.set_rate(c, input)?;
            f.prefs.last_currency = Some(input.currency.clone());
            Ok(())
        })
    }
    pub fn set_rounding(&mut self, input: &RoundingInput, today: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.set_rounding(c, input, today))
    }
    pub fn delete_rounding(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.delete_rounding(c, id))
    }
    pub fn set_setting(&mut self, key: &str, value: Value) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.set_setting(c, key, value))
    }

    pub fn set_theme(&mut self, theme: Theme) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.theme = theme;
            Ok(())
        })
    }
    pub fn set_hide_earnings(&mut self, hide: bool) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.hide_earnings = hide;
            Ok(())
        })
    }
    pub fn mark_client_zone_prompt_done(&mut self) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.client_zone_prompt_done = true;
            Ok(())
        })
    }
    pub fn mark_sync_prompt_done(&mut self) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.sync_prompt_done = true;
            Ok(())
        })
    }
    pub fn mark_hide_notice_shown(&mut self) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.hide_notice_shown = true;
            Ok(())
        })
    }

    pub fn add_sync_target(&mut self, target: SyncTarget) -> Result<(), CoreError> {
        if target.root.trim().is_empty() {
            return Err(CoreError::Validation("choose a folder".into()));
        }
        self.mutate(|f, _| {
            f.prefs.sync_prompt_done = true;
            if !f.prefs.sync_targets.iter().any(|t| t.root == target.root) {
                f.prefs.sync_targets.push(target);
            }
            Ok(())
        })
    }

    /// Stops using a folder. Everything already in it stays where it is.
    pub fn remove_sync_target(&mut self, root: &str) -> Result<(), CoreError> {
        self.targets.remove(root);
        self.mutate(|f, _| {
            f.prefs.sync_targets.retain(|t| t.root != root);
            Ok(())
        })
    }

    /// Records a heartbeat while something is running, so a crash loses at most one interval.
    pub fn heartbeat(&mut self) -> Result<(), CoreError> {
        if self
            .file
            .data
            .own_open_segments(&self.file.device_id)
            .is_empty()
        {
            return Ok(());
        }
        let now = self.now();
        let mut next = self.file.clone();
        next.last_heartbeat = Some(now);
        persist::save(&self.paths, &next, now)?;
        self.file = next;
        Ok(())
    }

    /// The real exit: closes this device's open segments now and marks their tasks paused.
    pub fn on_exit(&mut self) -> Result<(), CoreError> {
        self.settle_away()?;
        if self
            .file
            .data
            .own_open_segments(&self.file.device_id)
            .is_empty()
        {
            return Ok(());
        }
        self.mutate(|f, c| {
            f.data.close_own_open(c, c.now, &PauseReason::AppQuit);
            f.last_heartbeat = Some(c.now);
            Ok(())
        })
    }

    /// Merges what other devices wrote. Local invariants are then restored, touching only segments
    /// this device owns. Persisted only when something changed.
    pub fn absorb_remote(
        &mut self,
        incoming: &Shared,
        seen: BTreeMap<String, RemoteDevice>,
        own_files: Vec<DeviceFile>,
    ) -> bool {
        let mut merged = merge(&self.file.data, incoming);
        // This device's own file can hold what a restored store lost.
        let mut last_beat = None;
        for own in &own_files {
            last_beat = last_beat.max(own.last_heartbeat);
            merged = merge(&merged, &own.data);
        }
        merged.normalize();
        // An open segment of this device that the store doesn't hold belongs to a past run, whichever
        // file brought it back. Nothing is timing it now, so it closes at the last known heartbeat.
        for seg in merged.segments.values_mut() {
            let past_run = seg.end.is_none()
                && seg.device_id == self.file.device_id
                && !self.file.data.segments.contains_key(&seg.id);
            if past_run {
                seg.end = Some(last_beat.unwrap_or(seg.start).max(seg.start));
            }
        }
        let mut known = self.file.remote_devices.clone();
        for (id, device) in seen {
            match known.get(&id) {
                Some(old) if old.written_at >= device.written_at => {}
                _ => {
                    known.insert(id, device);
                }
            }
        }
        let data_changed = merged != self.file.data;
        let devices_changed = known != self.file.remote_devices;
        if !data_changed && !devices_changed {
            let device = self.file.device_id.clone();
            let mut probe = self.file.data.clone();
            if !probe.reconcile(&Ctx {
                now: self.now(),
                device: &device,
            }) {
                return false;
            }
        }
        let outcome = self.mutate(|f, c| {
            f.data = merged;
            f.remote_devices = known;
            f.data.reconcile(c);
            Ok(())
        });
        match outcome {
            Ok(()) => data_changed,
            Err(e) => {
                self.local_error = Some(format!(
                    "Could not save data merged from the sync folder: {e}"
                ));
                false
            }
        }
    }

    /// A save of merged data failed. Folder writes don't clear this.
    #[must_use]
    pub fn local_error(&self) -> Option<&str> {
        self.local_error.as_deref()
    }

    /// Any enabled folder's last attempt failed, so the schedule should retry.
    #[must_use]
    pub fn any_target_failed(&self) -> bool {
        self.local_error.is_some()
            || self.file.prefs.sync_targets.iter().any(|t| {
                self.targets
                    .get(&t.root)
                    .is_some_and(|s| s.last_error.is_some())
            })
    }

    /// Makes `to` a sync folder, in place of `replacing` when given. One atomic settings change.
    pub fn switch_targets(
        &mut self,
        replacing: Option<&str>,
        to: SyncTarget,
        pending: Option<PendingCopy>,
    ) -> Result<(), CoreError> {
        let result = self.mutate(|f, _| {
            f.prefs.sync_prompt_done = true;
            if let Some(old) = replacing {
                f.prefs.sync_targets.retain(|t| t.root != old);
            }
            if !f.prefs.sync_targets.iter().any(|t| t.root == to.root) {
                f.prefs.sync_targets.push(to);
            }
            f.prefs.pending_copy = pending;
            Ok(())
        });
        if result.is_ok()
            && let Some(old) = replacing
        {
            self.targets.remove(old);
        }
        result
    }

    pub fn record_sync_failure(&mut self, message: &str) {
        let now = self.now();
        for status in self.targets.values_mut() {
            status.last_error = Some(message.to_owned());
            status.last_error_at = Some(now);
        }
    }

    pub fn target_status_mut(&mut self, root: &str) -> &mut TargetStatus {
        self.targets.entry(root.to_owned()).or_default()
    }

    #[must_use]
    pub fn device_file(&self) -> DeviceFile {
        DeviceFile {
            schema_version: SCHEMA_VERSION,
            device_id: self.file.device_id.clone(),
            device_name: self.file.device_name.clone(),
            written_at: self.now(),
            last_heartbeat: self.file.last_heartbeat,
            data: self.file.data.clone(),
        }
    }

    #[must_use]
    pub fn export_source(&self) -> ExportSource {
        ExportSource {
            data: self.file.data.clone(),
            device_id: self.file.device_id.clone(),
            remote_devices: self.file.remote_devices.clone(),
            now: self.now(),
        }
    }

    pub fn dismiss_notice(&mut self, id: &str) {
        self.notices.retain(|n| n.id != id);
    }

    #[must_use]
    pub fn hide_notice_shown(&self) -> bool {
        self.file.prefs.hide_notice_shown
    }

    #[must_use]
    pub fn device_name_of(&self, id: &str) -> String {
        self.file
            .remote_devices
            .get(id)
            .map_or_else(|| "another device".to_owned(), |d| d.name.clone())
    }

    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let data = &self.file.data;
        let own = self.file.device_id.as_str();
        let with_tasks: BTreeSet<&str> = data
            .tasks
            .values()
            .filter(|t| t.is_live())
            .map(|t| t.project_id.as_str())
            .collect();
        let open_devices: BTreeSet<&str> = data
            .segments
            .values()
            .filter(|s| s.end.is_none())
            .map(|s| s.device_id.as_str())
            .collect();

        let figures = self.figures();
        let source = self.export_source();
        let end_of = |s: &Segment| source.end_of(s);
        let all_pieces = pieces::pieces(data, &end_of);
        let totals = task_totals(data, &all_pieces);
        let unconfirmed = pieces::unconfirmed_secs(data);
        let billed = data.billed_segments();

        let projects = data
            .projects
            .values()
            // A tombstoned project that gained a task on another device stays visible as archived.
            .filter(|p| !p.deleted || with_tasks.contains(p.id.as_str()))
            .map(|p| ProjectView {
                id: p.id.clone(),
                name: p.name.clone(),
                color: p.color.clone(),
                archived: p.archived || p.deleted,
                billable: p.billable,
                budget_hours: p.budget_hours,
                client_zone: p.client_zone.clone(),
                created_at: p.created_at,
                has_tasks: with_tasks.contains(p.id.as_str()),
                billing_type: p.billing_type,
                fixed_fee_cents: p.fixed_fee_cents,
                fee_currency: p.fee_currency.clone(),
                figures: figures.get(&p.id).cloned().unwrap_or_default(),
            })
            .collect();

        let mut open_elsewhere: BTreeMap<&str, &str> = BTreeMap::new();
        let mut open_here: BTreeSet<&str> = BTreeSet::new();
        for s in data.segments.values().filter(|s| s.end.is_none()) {
            if s.device_id == own {
                open_here.insert(s.task_id.as_str());
            } else {
                open_elsewhere.insert(s.task_id.as_str(), s.device_id.as_str());
            }
        }
        let tasks = data
            .tasks
            .values()
            .filter(|t| t.is_live())
            .map(|t| TaskView {
                id: t.id.clone(),
                name: t.name.clone(),
                project_id: t.project_id.clone(),
                description: t.description.clone(),
                state: t.state,
                pause_reason: t.pause_reason.clone(),
                created_at: t.created_at,
                stopped_at: t.stopped_at,
                continued_from: t.continued_from.clone(),
                tags: t.tags.clone(),
                active_subtask: t.active_subtask.clone(),
                subtasks: subtasks::items(&t.description)
                    .into_iter()
                    .map(|i| SubtaskView {
                        secs: totals
                            .get(&t.id)
                            .and_then(|x| x.subtask_secs.get(&i.id))
                            .copied()
                            .unwrap_or(0),
                        id: i.id,
                        text: i.text,
                        checked: i.checked,
                    })
                    .collect(),
                billed_secs: totals.get(&t.id).map_or(0, |x| x.billed_secs),
                unbilled_secs: totals.get(&t.id).map_or(0, |x| x.unbilled_secs),
                thinking_secs: totals.get(&t.id).map_or(0, |x| x.thinking_secs),
                pause_secs: totals.get(&t.id).map_or(0, |x| x.pause_secs),
                unconfirmed_secs: unconfirmed.get(&t.id).copied().unwrap_or(0),
                running_elsewhere: if t.state == TaskState::Running
                    && !open_here.contains(t.id.as_str())
                {
                    open_elsewhere
                        .get(t.id.as_str())
                        .map(|d| self.device_name_of(d))
                } else {
                    None
                },
            })
            .collect();

        let mut segments: Vec<SegmentView> = all_pieces
            .iter()
            .map(|p| {
                let device = p.device_id.clone().unwrap_or_default();
                SegmentView {
                    id: p.id.clone(),
                    task_id: p.task_id.clone(),
                    start: p.start,
                    end: (!p.open).then_some(p.end),
                    provisional_end: (p.open && device != own).then_some(p.end),
                    device_id: device,
                    segment_id: p.source_id.clone(),
                    kind: p.kind,
                    subtask_id: p.subtask_id.clone(),
                }
            })
            .collect();
        segments.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.id.cmp(&b.id)));
        let raw_segments = data
            .segments
            .values()
            .filter(|s| data.tasks.get(&s.task_id).is_some_and(Task::is_live))
            .map(|s| {
                let effective = s.effective();
                RawSegmentView {
                    id: s.id.clone(),
                    task_id: s.task_id.clone(),
                    device_id: s.device_id.clone(),
                    raw_start: s.start,
                    raw_end: s.end,
                    start: effective.map_or(s.start, |e| e.0),
                    end: effective.map_or(s.end, |e| e.1),
                    voided: effective.is_none(),
                    corrected: s.edit.as_ref().is_some_and(|e| !e.voided),
                    manual: s.manual,
                    reason: s
                        .edit
                        .as_ref()
                        .map_or_else(String::new, |e| e.reason.clone()),
                    billed: billed.contains(s.id.as_str()),
                }
            })
            .collect();

        let mut warnings = Vec::new();
        if open_devices.len() >= 2 {
            let names: Vec<String> = open_devices
                .iter()
                .map(|d| {
                    if *d == own {
                        format!("{} (this device)", self.file.device_name)
                    } else {
                        self.device_name_of(d)
                    }
                })
                .collect();
            warnings.push(format!(
                "Tasks are running on more than one device at once: {}. Both are kept as logged; pause one of them on its own device.",
                names.join(", ")
            ));
        }

        warnings.extend(self.local_error.clone());
        let repeated = data.reference_clashes();
        if !repeated.is_empty() {
            warnings.push(format!(
                "More than one billing summary uses the same reference: {}. Change a device's prefix and void and reissue one of them.",
                repeated.join(", ")
            ));
        }
        let clashes: Vec<String> = data
            .prefix_clashes(own)
            .iter()
            .map(|d| self.device_name_of(d))
            .collect();
        if !clashes.is_empty() {
            warnings.push(format!(
                "Another device uses the same reference prefix: {}. Choose a different prefix, or references can repeat.",
                clashes.join(", ")
            ));
        }

        let targets = self
            .file
            .prefs
            .sync_targets
            .iter()
            .map(|t| TargetView {
                provider: t.provider,
                root: t.root.clone(),
                folder: PathBuf::from(&t.root)
                    .join(APP_FOLDER)
                    .to_string_lossy()
                    .into_owned(),
                status: self.targets.get(&t.root).cloned().unwrap_or_default(),
            })
            .collect();

        Snapshot {
            now: self.now(),
            device_id: self.file.device_id.clone(),
            device_name: self.file.device_name.clone(),
            system_zone: self.system_zone.clone(),
            tzdb_version: chrono_tz::IANA_TZDB_VERSION,
            projects,
            tasks,
            segments,
            shifts: data
                .shifts
                .values()
                .filter(|s| !s.deleted)
                .cloned()
                .collect(),
            rates: data
                .rates
                .values()
                .filter(|r| !r.deleted)
                .cloned()
                .collect(),
            rounding: data
                .rounding
                .values()
                .filter(|r| !r.deleted)
                .cloned()
                .collect(),
            settings: data
                .settings
                .iter()
                .map(|(k, v)| (k.clone(), v.value.clone()))
                .collect(),
            prefs: PrefsView {
                theme: self.file.prefs.theme,
                hide_earnings: self.file.prefs.hide_earnings,
                last_currency: self.file.prefs.last_currency.clone(),
                client_zone_prompt_done: self.file.prefs.client_zone_prompt_done,
            },
            notices: self.notices.clone(),
            warnings,
            sync: SyncView {
                targets,
                detected: self.detected.clone(),
                prompt_pending: !self.file.prefs.sync_prompt_done
                    && self.file.prefs.sync_targets.is_empty(),
                pending_copy: self.file.prefs.pending_copy.clone(),
            },
            launch: LaunchView {
                warm: self.warm,
                cold_required: cold_required(data),
                copy_source: if self.warm { self.copy_source() } else { None },
            },
            raw_segments,
            gaps: data
                .gaps
                .values()
                .filter(|g| data.tasks.get(&g.task_id).is_some_and(Task::is_live))
                .cloned()
                .collect(),
            pauses: data
                .pauses
                .values()
                .filter(|p| !p.deleted)
                .cloned()
                .collect(),
            tags: data.tags.values().filter(|t| !t.deleted).cloned().collect(),
            templates: data
                .templates
                .values()
                .filter(|t| !t.deleted)
                .cloned()
                .collect(),
            billing: BillingView {
                prefix: data.prefix_of(own),
                clashes,
                summaries: data.summaries.values().cloned().collect(),
            },
            reminder: self.current_reminder(),
            reminder_settings: ReminderSettings {
                idle_minutes: minutes_setting(data, "idleMinutes", DEFAULT_IDLE_MINUTES),
                long_run_minutes: minutes_setting(
                    data,
                    "longRunMinutes",
                    reminder::DEFAULT_LONG_RUN_MINUTES,
                ),
                remind_past_shift: data
                    .settings
                    .get("remindPastShift")
                    .and_then(|e| e.value.as_bool())
                    .unwrap_or(true),
            },
            backup_keep: self.backup_keep(),
            has_pdf_logo: self.paths.dir.join(PDF_LOGO_FILE).exists(),
        }
    }
}

fn name_device(e: CoreError, devices: BTreeMap<String, RemoteDevice>) -> CoreError {
    match e {
        CoreError::RunningElsewhere(id) => CoreError::RunningElsewhere(
            devices
                .get(&id)
                .map_or_else(|| "another device".to_owned(), |d| d.name.clone()),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SyncProvider;
    use crate::time::ManualClock;

    const T0: &str = "2026-03-01T09:00:00Z";

    fn pinput(name: &str) -> ProjectInput {
        ProjectInput {
            name: name.into(),
            color: "#336699".into(),
            billable: true,
            budget_hours: None,
            client_zone: None,
            billing_type: Default::default(),
            fixed_fee_cents: None,
            fee_currency: None,
        }
    }
    fn tinput(name: &str, p: &str) -> TaskInput {
        TaskInput {
            name: name.into(),
            project_id: p.into(),
            description: doc("Details"),
            continued_from: None,
            tags: vec!["tag-concept".to_owned()],
        }
    }
    fn doc(text: &str) -> Value {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
    }
    fn open(dir: &Path, clock: &ManualClock) -> Service {
        Service::open(dir, Arc::new(clock.clone()), "pc").unwrap()
    }

    fn running(dir: &Path, clock: &ManualClock) -> (Service, String) {
        let mut s = open(dir, clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        s.start_task(&t).unwrap();
        (s, t)
    }

    #[test]
    fn cold_launch_needs_every_field_and_the_flag_is_launch_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        assert!(!s.snapshot().launch.warm);
        assert_eq!(s.snapshot().launch.cold_required.len(), 4);
        let p = s.create_project(&pinput("P")).unwrap();
        let blank = TaskInput {
            name: "T".into(),
            project_id: p.clone(),
            description: Value::Null,
            continued_from: None,
            tags: Vec::new(),
        };
        let t = s.create_task(&blank).unwrap();
        assert!(matches!(s.start_task(&t), Err(CoreError::Validation(_))));
        let spaces = TaskInput {
            description: doc("   "),
            ..blank.clone()
        };
        s.update_task(&t, &spaces).unwrap();
        assert!(matches!(s.start_task(&t), Err(CoreError::Validation(_))));
        assert!(!s.is_warm());
        assert!(s.file().data.segments.is_empty());
        let filled = TaskInput {
            description: doc("Real"),
            tags: vec!["tag-concept".to_owned()],
            ..blank.clone()
        };
        s.update_task(&t, &filled).unwrap();
        s.start_task(&t).unwrap();
        assert!(s.is_warm());
        // Warm: a blank description is allowed, name and project are still mandatory.
        let other = s.create_task(&blank).unwrap();
        s.start_task(&other).unwrap();
        assert!(
            s.create_task(&TaskInput {
                name: " ".into(),
                ..blank.clone()
            })
            .is_err()
        );
        // A real relaunch is cold again.
        drop(s);
        let s = open(dir.path(), &clock);
        assert!(!s.is_warm());
        assert!(s.snapshot().launch.copy_source.is_none());
    }

    #[test]
    fn resume_is_refused_while_cold_and_accepted_once_warm() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        s.pause_task(&t).unwrap();
        assert!(
            s.resume_task(&t).is_ok(),
            "warm: resume continues the same task"
        );
        s.on_exit().unwrap();
        drop(s);
        let mut s = open(dir.path(), &clock);
        let before = s.file().data.tasks[&t].clone();
        let segs = s.file().data.segments.len();
        assert!(matches!(
            s.resume_task(&t),
            Err(CoreError::ColdStartRequired)
        ));
        assert_eq!(
            s.file().data.segments.len(),
            segs,
            "a refused resume logs nothing"
        );
        // The continuation is a new task linked to the old, which stays as it was.
        let p = before.project_id.clone();
        let next = s
            .create_task(&TaskInput {
                name: "Next".into(),
                project_id: p,
                description: doc("More"),
                continued_from: Some(t.clone()),
                tags: vec!["tag-concept".to_owned()],
            })
            .unwrap();
        s.start_task(&next).unwrap();
        assert_eq!(
            s.file().data.tasks[&next].continued_from.as_deref(),
            Some(t.as_str())
        );
        let old = &s.file().data.tasks[&t];
        assert_eq!(
            (&old.name, &old.description, old.state),
            (&before.name, &before.description, TaskState::Paused)
        );
        // Now warm, the old task can be stopped or resumed directly.
        assert!(s.resume_task(&t).is_ok());
    }

    #[test]
    fn crash_recovery_leaves_the_launch_cold_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (s, t) = running(dir.path(), &clock);
        drop(s);
        let mut s = open(dir.path(), &clock);
        assert!(
            s.snapshot().notices[0]
                .message
                .contains("next start asks for every field")
        );
        assert!(matches!(
            s.resume_task(&t),
            Err(CoreError::ColdStartRequired)
        ));
    }

    #[test]
    fn stopping_an_older_task_does_not_change_the_copy_source() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, old) = running(dir.path(), &clock);
        let p = s.file().data.tasks[&old].project_id.clone();
        let new = s.create_task(&tinput("New", &p)).unwrap();
        s.start_task(&new).unwrap();
        s.stop_task(&old).unwrap();
        assert_eq!(s.snapshot().launch.copy_source.unwrap().task_id, new);
    }

    #[test]
    fn a_past_open_segment_from_another_devices_file_is_closed_and_leaves_no_running_task() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        let mut incoming = s.file().data.clone();
        s.mutate(|f, _| {
            f.data = Shared::default();
            Ok(())
        })
        .unwrap();
        clock.advance(86_400);
        assert!(incoming.tasks.contains_key(&t));
        incoming.settings.clear();
        s.absorb_remote(&incoming, BTreeMap::new(), Vec::new());
        let device = s.file().device_id.clone();
        assert!(s.file().data.own_open_segments(&device).is_empty());
        assert_ne!(s.file().data.tasks[&t].state, TaskState::Running);
    }

    #[test]
    fn warm_copy_source_is_the_most_recently_worked_task() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, a) = running(dir.path(), &clock);
        let src = s.snapshot().launch.copy_source.unwrap();
        assert_eq!(src.task_id, a);
        assert!(!src.project_archived);
        clock.advance(60);
        s.stop_task(&a).unwrap();
        assert_eq!(
            s.snapshot().launch.copy_source.unwrap().task_id,
            a,
            "a stopped task can still be the source"
        );
        let p = s.file().data.tasks[&a].project_id.clone();
        s.set_project_archived(&p, true).unwrap();
        assert!(s.snapshot().launch.copy_source.unwrap().project_archived);
    }

    #[test]
    fn crash_recovery_closes_at_the_last_heartbeat_and_notifies() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        clock.advance(30);
        s.heartbeat().unwrap();
        clock.advance(30);
        s.heartbeat().unwrap();
        clock.advance(3600);
        drop(s); // the crash: nothing closes the segment

        let s = open(dir.path(), &clock);
        let seg = s.file().data.segments.values().next().unwrap();
        assert_eq!(seg.end.unwrap().iso(), "2026-03-01T09:01:00Z");
        assert_eq!(s.file().data.tasks[&t].state, TaskState::Paused);
        assert_eq!(
            s.file().data.tasks[&t].pause_reason,
            Some(PauseReason::CrashRecovery)
        );
        assert!(
            s.snapshot()
                .notices
                .iter()
                .any(|n| n.message.contains("did not shut down cleanly"))
        );
        // Recovery was saved, so a second launch has nothing to do.
        let again = open(dir.path(), &clock);
        assert!(again.snapshot().notices.is_empty());
    }

    #[test]
    fn crash_with_heartbeat_older_than_the_segment_gives_zero_not_negative() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.mutate(|f, _| {
            f.last_heartbeat = Ts::parse("2020-01-01T00:00:00Z");
            Ok(())
        })
        .unwrap();
        drop(s);
        let s = open(dir.path(), &clock);
        let seg = s.file().data.segments.values().next().unwrap();
        assert_eq!(seg.end, Some(seg.start));
    }

    #[test]
    fn clean_exit_closes_at_exit_time_and_marks_paused() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        clock.advance(120);
        s.on_exit().unwrap();
        s.on_exit().unwrap();
        drop(s);
        let s = open(dir.path(), &clock);
        assert_eq!(
            s.file()
                .data
                .segments
                .values()
                .next()
                .unwrap()
                .end
                .unwrap()
                .iso(),
            "2026-03-01T09:02:00Z"
        );
        assert_eq!(
            s.file().data.tasks[&t].pause_reason,
            Some(PauseReason::AppQuit)
        );
        assert!(s.snapshot().notices.is_empty());
    }

    #[test]
    fn data_survives_reopen_and_device_id_is_stable() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (s, _) = running(dir.path(), &clock);
        let id = s.file().device_id.clone();
        drop(s);
        assert_eq!(open(dir.path(), &clock).file().device_id, id);
    }

    #[test]
    fn a_failed_save_leaves_memory_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let before = s.file().clone();
        // Validation failure inside the transaction.
        assert!(s.create_project(&pinput(" ")).is_err());
        assert_eq!(*s.file(), before);
        assert_eq!(s.revision(), 0);
    }

    #[test]
    fn nothing_syncs_until_the_user_chooses_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        s.set_detected(vec![Detected {
            provider: SyncProvider::OneDrive,
            root: "/x".into(),
            source: "test".into(),
        }]);
        let snap = s.snapshot();
        assert!(snap.sync.prompt_pending);
        assert!(snap.sync.targets.is_empty());
        assert_eq!(snap.sync.detected.len(), 1);
        s.mark_sync_prompt_done().unwrap();
        assert!(!s.snapshot().sync.prompt_pending);
        assert!(s.snapshot().sync.targets.is_empty());
    }

    #[test]
    fn theme_and_hide_earnings_persist_across_relaunch() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        assert_eq!(s.snapshot().prefs.theme, Theme::Light);
        s.set_theme(Theme::SolarizedDark).unwrap();
        s.set_hide_earnings(true).unwrap();
        drop(s);
        let s = open(dir.path(), &clock);
        assert_eq!(s.snapshot().prefs.theme, Theme::SolarizedDark);
        assert!(s.snapshot().prefs.hide_earnings);
    }

    #[test]
    fn snapshot_timestamps_are_utc_z_strings() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (s, _) = running(dir.path(), &clock);
        let j = serde_json::to_value(s.snapshot()).unwrap();
        assert_eq!(j["segments"][0]["start"], "2026-03-01T09:00:00Z");
        assert_eq!(j["now"], "2026-03-01T09:00:00Z");
        assert!(j["segments"][0]["end"].is_null());
        assert!(j["tzdbVersion"].as_str().unwrap().starts_with("20"));
    }

    // ---- Phase 2 service paths

    fn pending_gaps(s: &Service) -> Vec<crate::model::IdleGap> {
        s.file()
            .data
            .gaps
            .values()
            .filter(|g| g.decision == GapDecision::Pending)
            .cloned()
            .collect()
    }

    #[test]
    fn time_asleep_is_not_billable_until_confirmed_and_the_raw_segment_stays() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        let raw_start = s.file().data.segments.values().next().unwrap().start;
        assert!(
            !s.observe_activity(Some(0)).unwrap(),
            "first tick only arms"
        );
        clock.advance(5);
        assert!(!s.observe_activity(Some(0)).unwrap());
        // The machine slept for three hours: the next tick arrives late.
        clock.advance(3 * 3600);
        assert!(s.observe_activity(Some(0)).unwrap());
        let gaps = pending_gaps(&s);
        assert_eq!(gaps.len(), 1);
        let task_secs = |s: &Service| {
            s.snapshot()
                .segments
                .iter()
                .filter(|x| x.task_id == t && x.kind == crate::pieces::PieceKind::Work)
                .map(|x| x.end.unwrap_or_else(|| clock.now()).0 - x.start.0)
                .sum::<i64>()
        };
        assert!(task_secs(&s) < 3 * 3600, "unanswered gap counts nowhere");
        let seg = s.file().data.segments.values().next().unwrap();
        assert_eq!(seg.start, raw_start, "raw timestamps are preserved");
        assert!(seg.edit.is_none());
        s.decide_gap(&gaps[0].id, GapDecision::Keep).unwrap();
        assert!(pending_gaps(&s).is_empty());
        assert!(task_secs(&s) >= 3 * 3600, "kept time counts again");
    }

    #[test]
    fn a_restore_keeps_a_safety_copy_and_comes_back_cold() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        s.pause_task(&t).unwrap();
        assert!(s.run_daily_backup().unwrap());
        let name = s.list_backups().unwrap()[0].name.clone();
        clock.advance(60);
        let late = s
            .create_task(&tinput(
                "Added after",
                &s.file().data.tasks[&t].project_id.clone(),
            ))
            .unwrap();
        let safety = s.restore_backup(&name).unwrap();
        assert!(!s.file().data.tasks.contains_key(&late));
        assert!(s.file().data.tasks.contains_key(&t));
        assert!(!s.is_warm(), "a restore counts as a cold start");
        let listed: Vec<String> = s
            .list_backups()
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert!(listed.contains(&safety), "{listed:?}");
        // The safety copy brings the undone work back.
        s.restore_backup(&safety).unwrap();
        assert!(s.file().data.tasks.contains_key(&late));
    }

    #[test]
    fn a_restore_refuses_a_name_outside_the_backup_folder_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        assert!(s.restore_backup("../z-work-data.json").is_err());
        assert!(s.file().data.tasks.contains_key(&t));
        assert!(s.is_warm());
    }

    #[test]
    fn a_warm_copy_keeps_tags_and_subtask_text_and_clears_ticks_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let description = serde_json::json!({"type":"doc","content":[
            {"type":"taskList","content":[
                {"type":"taskItem","attrs":{"checked":true},"content":[
                    {"type":"paragraph","content":[{"type":"text","text":"Sketch"}]}]}]}]});
        let t = s
            .create_task(&TaskInput {
                description: description.clone(),
                ..tinput("T", &p)
            })
            .unwrap();
        s.start_task(&t).unwrap();
        let copy = s.snapshot().launch.copy_source.unwrap();
        assert_eq!(copy.tags, vec!["tag-concept".to_owned()]);
        let items = crate::subtasks::items(&copy.description);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Sketch");
        assert!(!items[0].checked);
        // The copy is a new task with no time of its own.
        let copied = s
            .create_task(&TaskInput {
                description: copy.description,
                tags: copy.tags,
                ..tinput("T again", &p)
            })
            .unwrap();
        assert!(s.file().data.segments.values().all(|x| x.task_id != copied));
    }

    #[test]
    fn a_cold_start_refuses_missing_tags_and_a_warm_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let bare = TaskInput {
            tags: Vec::new(),
            ..tinput("T", &p)
        };
        let t = s.create_task(&bare).unwrap();
        assert!(matches!(s.start_task(&t), Err(CoreError::Validation(_))));
        assert!(s.file().data.segments.is_empty());
        let tagged = s.create_task(&tinput("Tagged", &p)).unwrap();
        s.start_task(&tagged).unwrap();
        s.start_task(&t).unwrap();
    }

    #[test]
    fn colors_are_canonical_on_tags_and_projects_and_anything_else_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let tag = crate::catalog::TagInput {
            id: None,
            name: "Pick".into(),
            color: "#AbCdEf".into(),
        };
        let id = s.save_tag(&tag).unwrap();
        assert_eq!(s.file().data.tags[&id].color, "#abcdef");
        let p = s
            .create_project(&ProjectInput {
                color: "#010203".into(),
                ..pinput("Coloured")
            })
            .unwrap();
        assert_eq!(s.file().data.projects[&p].color, "#010203");
        for bad in [
            "",
            "abcdef",
            "#abc",
            "#abcdefff",
            "#ggggGG",
            "rgb(1,2,3)",
            "#12345\u{e9}",
        ] {
            let refused = s.save_tag(&crate::catalog::TagInput {
                id: None,
                name: format!("Bad {bad}"),
                color: bad.into(),
            });
            assert!(matches!(refused, Err(CoreError::Validation(_))), "{bad}");
            let refused = s.create_project(&ProjectInput {
                color: bad.into(),
                ..pinput(&format!("Bad {bad}"))
            });
            assert!(matches!(refused, Err(CoreError::Validation(_))), "{bad}");
        }
    }

    fn gap_total(s: &Service) -> i64 {
        s.file()
            .data
            .gaps
            .values()
            .map(|g| g.end.secs() - g.start.secs())
            .sum()
    }

    #[test]
    fn leaving_while_away_records_the_time_on_every_path_that_closes_the_segment() {
        for path in ["exit", "pause", "stop"] {
            let dir = tempfile::tempdir().unwrap();
            let clock = ManualClock::at(T0);
            let (mut s, t) = running(dir.path(), &clock);
            s.observe_activity(Some(0)).unwrap();
            for _ in 0..3 {
                clock.advance(5);
                s.observe_activity(Some(3 * 3600)).unwrap();
            }
            assert_eq!(gap_total(&s), 0, "still away, nothing decided yet");
            match path {
                "exit" => s.on_exit().unwrap(),
                "pause" => s.pause_task(&t).unwrap(),
                _ => s.stop_task(&t).unwrap(),
            }
            assert!(gap_total(&s) > 0, "{path}");
            assert_eq!(pending_gaps(&s).len(), 1, "{path}");
        }
    }

    #[test]
    fn a_crash_while_away_still_leaves_the_time_unconfirmed() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        for _ in 0..3 {
            clock.advance(5);
            s.heartbeat().unwrap();
            s.observe_activity(Some(1800)).unwrap();
        }
        assert!(s.file().prefs.away_since.is_some());
        drop(s); // No exit: the process died.
        clock.advance(600);
        let s = open(dir.path(), &clock);
        assert_eq!(pending_gaps(&s).len(), 1);
        assert!(s.file().prefs.away_since.is_none());
    }

    #[test]
    fn found_time_away_survives_a_save_that_fails() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        clock.advance(3600);
        let store = dir.path().join("z-work-data.json");
        let keep = std::fs::read(&store).unwrap();
        // A directory in the way of the temp file makes the write fail on every platform.
        let tmp = dir.path().join("z-work-data.json.tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(s.observe_activity(Some(0)).is_err());
        assert!(pending_gaps(&s).is_empty());
        std::fs::remove_dir_all(&tmp).unwrap();
        std::fs::write(&store, keep).unwrap();
        clock.advance(5);
        assert!(s.observe_activity(Some(0)).unwrap());
        assert_eq!(pending_gaps(&s).len(), 1);
    }

    #[test]
    fn a_phase_1_task_list_gets_stable_ids_when_it_opens() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        s.mutate(|f, _| {
            f.data.tasks.get_mut(&t).unwrap().description = serde_json::json!({"type":"doc","content":[
                {"type":"taskList","content":[
                    {"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"One"}]}]},
                    {"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Two"}]}]}]}]});
            Ok(())
        })
        .unwrap();
        drop(s);
        let mut s = open(dir.path(), &clock);
        let ids: Vec<String> = crate::subtasks::items(&s.file().data.tasks[&t].description)
            .into_iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, vec![format!("{t}-0"), format!("{t}-1")]);
        assert!(s.set_active_subtask(&t, Some("")).is_err());
        assert!(s.set_active_subtask(&t, Some(&ids[1])).is_ok());
    }

    #[test]
    fn removing_the_active_subtask_clears_it_and_new_segments_do_not_use_it() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let listed = serde_json::json!({"type":"doc","content":[{"type":"taskList","content":[
            {"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"One"}]}]}]}]});
        let input = TaskInput {
            description: listed,
            ..tinput("T", &p)
        };
        let t = s.create_task(&input).unwrap();
        let id = crate::subtasks::items(&s.file().data.tasks[&t].description)[0]
            .id
            .clone();
        s.set_active_subtask(&t, Some(&id)).unwrap();
        s.update_task(
            &t,
            &TaskInput {
                description: doc("No list now"),
                ..input.clone()
            },
        )
        .unwrap();
        assert_eq!(s.file().data.tasks[&t].active_subtask, None);
        s.start_task(&t).unwrap();
        assert!(
            s.file()
                .data
                .segments
                .values()
                .all(|x| x.subtask_id.is_none())
        );
    }
}
