//! The application service: owns the store, applies each change transactionally and builds the view.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::adjust::{CorrectionInput, ManualEntryInput, PauseInput};
use crate::backup::{self, BackupInfo};
use crate::catalog::{TagInput, TemplateInput};
use crate::colors;
use crate::detect::Detected;
use crate::drafts::{Draft, Kept, KeptBecause};
use crate::error::CoreError;
use crate::idle::{IdleTracker, NewGap};
use crate::machine::{
    Ctx, PatchOutcome, PauseRequestDue, ProjectInput, RateInput, RequiredField, RoundingInput,
    ShiftInput, TaskExpected, TaskInput, TaskPatch, Transition, cold_required, doc_has_text,
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
    ReminderSettings, SegmentView, SetupView, Snapshot, SubtaskView, SyncView, TargetView,
    TaskView,
};

pub struct Service {
    paths: Paths,
    file: LocalFile,
    clock: Arc<dyn Clock>,
    notices: Vec<Notice>,
    next_notice: u64,
    pause_alerts: Vec<String>,
    targets: BTreeMap<String, TargetStatus>,
    detected: Vec<Detected>,
    system_zone: String,
    /// Bumped on every committed change, so the app knows when to schedule a sync.
    revision: u64,
    /// Words kept out of the store, by the id of the notice showing them.
    kept_out: BTreeMap<String, Kept>,
    /// When this launch began. Nothing it had to write can have reached another device by then.
    opened: Ts,
    /// Drafts put back at this launch, as stored, until something else replaces them.
    recovered: BTreeMap<String, Draft>,
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
    /// Where a replacement colour's randomness comes from. Injected in tests.
    random: Box<dyn FnMut() -> u64 + Send>,
    color_replaced: Option<String>,
    mica_available: bool,
}

/// Saved colours and what happened to them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ColorOutcome {
    pub color: String,
    /// What was asked for, when it matched another's exactly and so was replaced.
    pub replaced: Option<String>,
}

fn default_random() -> u64 {
    let (hi, _) = uuid::Uuid::new_v4().as_u64_pair();
    hi
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
            pause_alerts: Vec::new(),
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
            random: Box::new(default_random),
            color_replaced: None,
            mica_available: false,
            kept_out: BTreeMap::new(),
            opened: now,
            recovered: BTreeMap::new(),
        };
        svc.file.data.seed_tags();
        svc.file.data.normalize();
        svc.load_kept();
        let kept_drafts = svc.replay_drafts();
        svc.file
            .data
            .raise_reference_marks(&mut svc.file.prefs.reference_marks);
        for n in outcome.notices {
            svc.notify("warning", n);
        }
        svc.recover_crash()?;
        // Writes the store on first launch too, so the data folder always holds a valid file.
        persist::save(&svc.paths, &svc.file, now)?;
        // Only now are recovered drafts safe in the store, and words it won't take safe in their own
        // file. Either failing keeps them as drafts for next time.
        let stay = if svc.save_kept().is_ok() {
            BTreeMap::new()
        } else {
            kept_drafts
        };
        let _ = crate::drafts::write(&svc.paths.dir, &stay);
        Ok(svc)
    }

    fn recover_crash(&mut self) -> Result<(), CoreError> {
        let device = self.file.device_id.clone();
        let away = self.file.prefs.away_since.take();
        let away_kind = self.file.prefs.away_kind.take();
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
                .add_gap(&ctx, &segment, away, at, away_kind.unwrap_or(GapKind::Idle));
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

    /// The zone the user is viewing: the active one, else their own, else this computer's.
    #[must_use]
    pub fn viewing_zone(&self) -> chrono_tz::Tz {
        let settings = &self.file.data.settings;
        settings
            .get("activeZone")
            .filter(|e| e.value.is_string())
            .or_else(|| settings.get("myZone"))
            .and_then(|e| e.value.as_str())
            .and_then(|z| crate::validate::parse_zone(z).ok())
            .or_else(|| crate::validate::parse_zone(&self.system_zone).ok())
            .unwrap_or(chrono_tz::UTC)
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

    /// Replaces a colour that exactly matches another active project's. A saved colour left unchanged
    /// stays, so two devices that picked the same one offline don't fight over it.
    fn project_with_unique_color(
        &mut self,
        id: Option<&str>,
        input: &ProjectInput,
    ) -> Result<ProjectInput, CoreError> {
        let taken: Vec<String> = self
            .file
            .data
            .projects
            .values()
            .filter(|p| !p.deleted && !p.archived && Some(p.id.as_str()) != id)
            .map(|p| p.color.clone())
            .collect();
        let unchanged = id
            .and_then(|i| self.file.data.projects.get(i))
            .is_some_and(|p| p.color.eq_ignore_ascii_case(&input.color));
        self.color_replaced = None;
        if unchanged {
            return Ok(input.clone());
        }
        let (color, replaced) = colors::resolve(&input.color, &taken, &mut *self.random)?;
        if replaced {
            self.color_replaced = Some(input.color.clone());
        }
        Ok(ProjectInput {
            color,
            ..input.clone()
        })
    }

    /// The colour just saved, and what was asked for if it had to be replaced.
    pub fn take_color_replaced(&mut self) -> Option<String> {
        self.color_replaced.take()
    }

    #[cfg(test)]
    pub fn set_random(&mut self, random: Box<dyn FnMut() -> u64 + Send>) {
        self.random = random;
    }

    pub fn create_project(&mut self, input: &ProjectInput) -> Result<String, CoreError> {
        let input = self.project_with_unique_color(None, input)?;
        self.mutate(|f, c| f.data.create_project(c, &input))
    }
    pub fn update_project(&mut self, id: &str, input: &ProjectInput) -> Result<(), CoreError> {
        let input = self.project_with_unique_color(Some(id), input)?;
        self.mutate(|f, c| f.data.update_project(c, id, &input))
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
    pub fn patch_task(
        &mut self,
        id: &str,
        patch: &TaskPatch,
        expected: &TaskExpected,
    ) -> Result<PatchOutcome, CoreError> {
        self.mutate(|f, c| f.data.patch_task(c, id, patch, expected))
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
        let own = input.id.as_deref();
        let taken: Vec<String> = self
            .file
            .data
            .tags
            .values()
            .filter(|t| !t.deleted && Some(t.id.as_str()) != own)
            .map(|t| t.color.clone())
            .collect();
        let unchanged = own
            .and_then(|i| self.file.data.tags.get(i))
            .is_some_and(|t| t.color.eq_ignore_ascii_case(&input.color));
        self.color_replaced = None;
        let mut input = input.clone();
        if !unchanged {
            let (color, replaced) = colors::resolve(&input.color, &taken, &mut *self.random)?;
            if replaced {
                self.color_replaced = Some(input.color.clone());
            }
            input.color = color;
        }
        self.mutate(|f, c| f.data.save_tag(c, &input))
    }

    pub fn revert_shift_version(&mut self, version_id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.revert_shift_version(c, version_id))
    }

    pub fn request_remote_pause(&mut self, task_id: &str) -> Result<String, CoreError> {
        self.mutate(|f, c| f.data.request_remote_pause(c, task_id))
    }

    /// Stores what is being typed, so a shutdown can't lose it. Validated like a real edit. `base` is
    /// the stored description the words were typed over: only if it is still there can they replace it.
    pub fn stash_draft(
        &self,
        task_id: &str,
        description: &Value,
        base: &Value,
    ) -> Result<(), CoreError> {
        crate::validate::check_description(description)?;
        let dir = &self.paths.dir;
        let mut all = crate::drafts::read(dir);
        all.insert(
            task_id.to_owned(),
            Draft {
                description: description.clone(),
                at: self.now(),
                base: base.clone(),
            },
        );
        crate::drafts::write(dir, &all)
    }

    pub fn clear_draft(&self, task_id: &str) -> Result<(), CoreError> {
        let dir = &self.paths.dir;
        let mut all = crate::drafts::read(dir);
        if all.remove(task_id).is_some() {
            crate::drafts::write(dir, &all)?;
        }
        Ok(())
    }

    /// Puts back words a shutdown left unsaved, where that replaces nothing the user has not seen: the
    /// description they were typed over is still stored, or what is stored is this device's own older
    /// text. Any other stored text stays, and the words go in a notice instead. Returns those drafts,
    /// which stay on disk until the words are safe in a file of their own.
    fn replay_drafts(&mut self) -> BTreeMap<String, Draft> {
        let dir = self.paths.dir.clone();
        let all = crate::drafts::read(&dir);
        let device = self.file.device_id.clone();
        let mut restored = Vec::new();
        let mut kept = Vec::new();
        for (task_id, draft) in all {
            let stored = self.file.data.tasks.get_mut(&task_id);
            let saved = stored.as_ref().is_some_and(|t| {
                crate::subtasks::assign_ids(&draft.description, Some(&t.description))
                    == t.description
            });
            if saved || crate::validate::check_description(&draft.description).is_err() {
                continue;
            }
            let because = match stored {
                Some(task) if task.is_live() => {
                    let own = task.description_stamp.by == device;
                    if draft.base == task.description
                        || (own && draft.at > task.description_stamp.at)
                    {
                        let ctx = Ctx {
                            now: draft.at,
                            device: &device,
                        };
                        task.description = crate::subtasks::assign_ids(
                            &draft.description,
                            Some(&task.description),
                        );
                        task.description_stamp = ctx.next(&task.description_stamp);
                        crate::machine::clear_missing_active(task, &ctx);
                        restored.push(task.name.clone());
                        self.recovered.insert(
                            task_id,
                            Draft {
                                description: task.description.clone(),
                                ..draft
                            },
                        );
                        continue;
                    }
                    KeptBecause::ChangedElsewhere
                }
                _ => KeptBecause::TaskGone,
            };
            if !crate::subtasks::plain_text(&draft.description)
                .trim()
                .is_empty()
            {
                kept.push((task_id, because, draft));
            }
        }
        if !restored.is_empty() {
            self.notify(
                "info",
                format!(
                    "Recovered an edit to {} that was typed just before the app closed.",
                    restored.join(", ")
                ),
            );
        }
        let mut stay = BTreeMap::new();
        for (task_id, because, draft) in kept {
            self.keep_draft(&task_id, &draft, because);
            stay.insert(task_id, draft);
        }
        stay
    }

    /// Words kept at an earlier launch and not yet dismissed.
    fn load_kept(&mut self) {
        let Some(mut all) = crate::drafts::read_kept(&self.paths.dir) else {
            let name = crate::drafts::set_aside_kept(&self.paths.dir);
            self.notify(
                "warning",
                format!(
                    "Words kept for you from an earlier launch can't be shown, because the file holding them can't be read. It is now {name} in the data folder."
                ),
            );
            return;
        };
        all.sort_by_key(|k| k.at);
        for mut kept in all {
            if let Some(task) = self.file.data.tasks.get(&kept.task_id) {
                kept.name.clone_from(&task.name);
            }
            self.notify_kept_out(kept);
        }
    }

    /// Writes the words kept out of the store to their file, or removes it if none are left.
    fn save_kept(&self) -> Result<(), CoreError> {
        let all: Vec<&Kept> = self.kept_out.values().collect();
        crate::drafts::write_kept(&self.paths.dir, &all)
    }

    /// Words of a draft the store won't take. A launch cut short after it wrote them finds that draft again.
    fn keep_draft(&mut self, task_id: &str, draft: &Draft, because: KeptBecause) {
        let name = self
            .file
            .data
            .tasks
            .get(task_id)
            .map_or("a deleted task", |t| t.name.as_str());
        let kept = Kept {
            task_id: task_id.to_owned(),
            name: name.to_owned(),
            words: crate::subtasks::plain_text(&draft.description),
            at: draft.at,
            because,
        };
        let known =
            |k: &Kept| k.task_id == kept.task_id && k.at == kept.at && k.words == kept.words;
        if !self.kept_out.values().any(known) {
            self.notify_kept_out(kept);
        }
    }

    /// The words of an edit that no save can take, because its task no longer exists.
    pub fn keep_unsaved_words(&mut self, task_id: &str, name: &str, words: &str) {
        self.notify_kept_out(Kept {
            task_id: task_id.to_owned(),
            name: name.to_owned(),
            words: words.to_owned(),
            at: self.now(),
            because: KeptBecause::TaskGone,
        });
        let _ = self.save_kept();
    }

    /// Tells of words the store won't take, in the only place left to read them.
    fn notify_kept_out(&mut self, kept: Kept) {
        let why = match kept.because {
            KeptBecause::ChangedElsewhere => {
                "were not put back, because its description changed elsewhere while they waited. The newer text is kept."
            }
            KeptBecause::TaskGone => "were not saved, because the task no longer exists.",
        };
        let message = format!(
            "Your unsaved words on “{}” {why} Copy your words from here if you want them, as dismissing this notice ends them: {}",
            kept.name, kept.words
        );
        self.kept_out.insert(self.next_notice.to_string(), kept);
        self.notify("warning", message);
    }

    /// Words put back at launch lose to an edit from elsewhere, or to the task being deleted there, when a
    /// sync brings that. It stands, as any other does, and the words go in a notice rather than vanish, if it
    /// was done before this launch and so without them. From then on they are text like any other, which
    /// another device may well go on from. A clock that is off moves that line by as much as it is off.
    fn check_recovered(&mut self) {
        if self.recovered.is_empty() {
            return;
        }
        let device = self.file.device_id.clone();
        for (task_id, draft) in std::mem::take(&mut self.recovered) {
            let Some(task) = self.file.data.tasks.get(&task_id) else {
                continue;
            };
            let (stamp, because) = if task.is_live() {
                (&task.description_stamp, KeptBecause::ChangedElsewhere)
            } else {
                (&task.deleted_stamp, KeptBecause::TaskGone)
            };
            let without_them = stamp.by != device && stamp.at <= self.opened;
            if task.is_live() && task.description == draft.description {
                self.recovered.insert(task_id, draft);
            } else if without_them {
                self.keep_draft(&task_id, &draft, because);
                let _ = self.save_kept();
            }
        }
    }

    /// A fresh store, or a setup already under way. Someone who updated with data, or has already
    /// answered the sync prompt, is not asked.
    fn setup_pending(&self) -> bool {
        let prefs = &self.file.prefs;
        if prefs.setup_done {
            return false;
        }
        let data = &self.file.data;
        prefs.setup_step > 0
            || (!prefs.sync_prompt_done && data.projects.is_empty() && data.tasks.is_empty())
    }

    pub fn set_setup_step(&mut self, step: u32) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.setup_step = step;
            Ok(())
        })
    }

    /// Ends the first-run setup, which also answers the prompts it replaced.
    pub fn finish_setup(&mut self) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.setup_done = true;
            f.prefs.sync_prompt_done = true;
            f.prefs.client_zone_prompt_done = true;
            Ok(())
        })
    }

    pub fn set_mica(&mut self, on: bool) -> Result<(), CoreError> {
        self.mutate(|f, _| {
            f.prefs.mica = on;
            Ok(())
        })
    }

    pub fn set_mica_available(&mut self, available: bool) {
        self.mica_available = available;
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
        self.mutate(|f, c| {
            let id = f
                .data
                .create_summary_above(c, req, &f.prefs.reference_marks)?;
            f.data.raise_reference_marks(&mut f.prefs.reference_marks);
            Ok(id)
        })
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

    /// The OS says whether the session is locked. `None` when it can't say, which ends a lock if it
    /// goes on too long.
    pub fn observe_lock(&mut self, locked: Option<bool>) -> Result<bool, CoreError> {
        self.observe_lock_at(0, locked)
    }

    /// As `observe_lock`, as if it had been reported this many seconds ago.
    pub fn observe_lock_at(&mut self, ago: i64, locked: Option<bool>) -> Result<bool, CoreError> {
        let at = Ts(self.now().secs() - ago);
        let device = self.file.device_id.clone();
        let running = self.file.data.own_open_segments(&device).into_iter().next();
        let gaps = match locked {
            Some(locked) => self.idle.set_locked(at, locked),
            None => self.idle.lock_unknown(at),
        };
        if let Some(segment) = running {
            self.unsaved_gaps
                .extend(gaps.into_iter().map(|g| (segment.clone(), g)));
        }
        self.save_away()
    }

    /// Writes found time away and the absence in progress. True when time away was recorded.
    fn save_away(&mut self) -> Result<bool, CoreError> {
        let away = self.idle.away_since();
        let kind = self.idle.away_kind();
        if self.unsaved_gaps.is_empty()
            && self.file.prefs.away_since == away
            && self.file.prefs.away_kind == kind
        {
            return Ok(false);
        }
        let gaps = self.unsaved_gaps.clone();
        self.mutate(|f, c| {
            for (segment, g) in &gaps {
                f.data.add_gap(c, segment, g.start, g.end, g.kind);
            }
            f.prefs.away_since = away;
            f.prefs.away_kind = kind;
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
        let source = self.end_source();
        project_figures(&self.file.data, tz, &|s: &Segment| source.end_of(s))
    }

    /// Pauses by request not yet offered as a system notification, for a window that may be hidden. Each
    /// is also a dismissible notice, so a person who doesn't see this still reads it in the app.
    pub fn take_pause_alerts(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pause_alerts)
    }

    /// What the owner of a task needs to hear: it stopped by itself, and time since the request is gone.
    fn pause_request_message(&self, due: &PauseRequestDue) -> String {
        let task = self
            .file
            .data
            .tasks
            .get(&due.task_id)
            .map_or("A task", |t| t.name.as_str());
        let device = self
            .file
            .remote_devices
            .get(&due.requested_by)
            .map_or("another device", |d| d.name.as_str());
        let zone = self.viewing_zone();
        let when = chrono::DateTime::from_timestamp(due.at.secs(), 0).map_or_else(
            || due.at.iso(),
            |t| t.with_timezone(&zone).format("%Y-%m-%d %H:%M").to_string(),
        );
        format!(
            "\"{task}\" was paused because {device} asked for it. Its time stopped at {when}, when that was asked, so anything you did on it after then isn't counted. Resume it if you're still working."
        )
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

    /// Rolls replicated data and settings back to a backup, keeping a safety copy of the current
    /// store first. What belongs to this device stays: its preferences and sync folders, the reference
    /// prefixes and marks, so no number is reused, and the audit trail, which only grows.
    pub fn restore_backup(&mut self, name: &str) -> Result<String, CoreError> {
        let mut restored = backup::read(&self.paths, name)?;
        self.on_exit()?;
        let safety = backup::safety_copy(&self.paths, &self.file, self.now())?;
        let mut prefs = self.file.prefs.clone();
        self.file
            .data
            .raise_reference_marks(&mut prefs.reference_marks);
        restored
            .data
            .raise_reference_marks(&mut prefs.reference_marks);
        prefs.away_since = None;
        prefs.away_kind = None;
        restored.prefs = prefs;
        restored.device_id = self.file.device_id.clone();
        restored.device_name = self.file.device_name.clone();
        restored.remote_devices = self.file.remote_devices.clone();
        restored.data.prefixes = self.file.data.prefixes.clone();
        restored
            .data
            .audit_log
            .extend(self.file.data.audit_log.clone());
        restored.data.seed_tags();
        restored.data.normalize();
        // A task the backup held running stopped being timed when the backup was taken.
        let now = self.now();
        let device = restored.device_id.clone();
        let ctx = Ctx {
            now,
            device: &device,
        };
        let at = restored.last_heartbeat.unwrap_or(Ts(i64::MIN / 2));
        let names = restored
            .data
            .close_own_open(&ctx, at, &PauseReason::BackupRestored);
        restored.data.audit(
            &ctx,
            "backup",
            name,
            "restore",
            "",
            Value::Null,
            serde_json::json!({"safetyCopy": safety}),
        );
        persist::save(&self.paths, &restored, now)?;
        persist::clear_heartbeat(&self.paths);
        self.file = restored;
        self.revision += 1;
        self.warm = false;
        self.last_worked = None;
        self.notify(
            "info",
            format!("Restored {name}. The data just before it is kept as {safety}."),
        );
        if !names.is_empty() {
            self.notify(
                "info",
                format!(
                    "{} was running when this backup was taken. It is paused at the last moment the backup knows about ({}).",
                    names.join(", "),
                    self.file.last_heartbeat.map_or_else(|| "its start".to_owned(), |h| h.iso()),
                ),
            );
        }
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
        let under_way = self.setup_pending();
        self.mutate(|f, _| {
            if under_way {
                f.prefs.setup_step = f.prefs.setup_step.max(1);
            }
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
        persist::save_heartbeat(&self.paths, &self.file.device_id, now)?;
        self.file.last_heartbeat = Some(now);
        Ok(())
    }

    /// The real exit: closes this device's open segments now and marks their tasks paused.
    pub fn on_exit(&mut self) -> Result<(), CoreError> {
        // Words a failed write left only in a notice get one more try.
        let _ = self.save_kept();
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
        let mut paused = Vec::new();
        let outcome = self.mutate(|f, c| {
            f.data = merged;
            f.remote_devices = known;
            paused = f.data.pause_requests_due(c.device);
            f.data.reconcile(c);
            f.data.raise_reference_marks(&mut f.prefs.reference_marks);
            Ok(())
        });
        match outcome {
            Ok(()) => {
                self.check_recovered();
                // Saved with the segment closed, so a later cycle finds nothing left to do for it.
                for due in &paused {
                    let message = self.pause_request_message(due);
                    self.pause_alerts.push(message.clone());
                    self.notify("warning", message);
                }
                data_changed || !paused.is_empty()
            }
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
        let under_way = self.setup_pending();
        let result = self.mutate(|f, _| {
            if under_way {
                f.prefs.setup_step = f.prefs.setup_step.max(1);
            }
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
            only: None,
            data: self.file.data.clone(),
            device_id: self.file.device_id.clone(),
            remote_devices: self.file.remote_devices.clone(),
            now: self.now(),
        }
    }

    /// What `end_of` reads, without a copy of the data it doesn't read. For reports use `export_source`.
    fn end_source(&self) -> ExportSource {
        ExportSource {
            only: None,
            data: Shared {
                pause_requests: self.file.data.pause_requests.clone(),
                ..Shared::default()
            },
            device_id: self.file.device_id.clone(),
            remote_devices: self.file.remote_devices.clone(),
            now: self.now(),
        }
    }

    pub fn dismiss_notice(&mut self, id: &str) {
        self.notices.retain(|n| n.id != id);
        // Words kept out of the store end here, and nowhere else. If this write fails the notice just
        // comes back at the next launch.
        if self.kept_out.remove(id).is_some() {
            let _ = self.save_kept();
        }
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
        let source = self.end_source();
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
        for (kind, colors) in [
            (
                "projects",
                data.projects
                    .values()
                    .filter(|p| !p.deleted && !p.archived)
                    .map(|p| (p.name.as_str(), p.color.as_str()))
                    .collect::<Vec<_>>(),
            ),
            (
                "tags",
                data.tags
                    .values()
                    .filter(|t| !t.deleted)
                    .map(|t| (t.name.as_str(), t.color.as_str()))
                    .collect::<Vec<_>>(),
            ),
        ] {
            let mut by_color: BTreeMap<String, Vec<&str>> = BTreeMap::new();
            for (name, color) in colors {
                by_color
                    .entry(color.to_ascii_lowercase())
                    .or_default()
                    .push(name);
            }
            for names in by_color.values().filter(|n| n.len() > 1) {
                warnings.push(format!(
                    "These {kind} have the same colour, probably from two devices: {}. Change one if that is confusing.",
                    names.join(", ")
                ));
            }
        }
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
            revision: self.revision,
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
                mica: self.file.prefs.mica,
                mica_available: self.mica_available,
            },
            setup: SetupView {
                pending: self.setup_pending(),
                step: self.file.prefs.setup_step,
            },
            pause_requests: self.file.data.pause_requests.values().cloned().collect(),
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
    fn a_heartbeat_leaves_the_store_file_alone_and_a_crash_still_stops_at_it() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        let main = dir.path().join(persist::MAIN_FILE);
        let before = std::fs::read(&main).unwrap();
        clock.advance(30);
        s.heartbeat().unwrap();
        assert_eq!(std::fs::read(&main).unwrap(), before);
        // In memory it counts at once, for what other devices are told.
        assert_eq!(
            s.device_file().last_heartbeat.unwrap().iso(),
            "2026-03-01T09:00:30Z"
        );
        clock.advance(3600);
        drop(s);
        let again = open(dir.path(), &clock);
        let seg = again.file().data.segments.values().next().unwrap();
        assert_eq!(seg.end.unwrap().iso(), "2026-03-01T09:00:30Z");
    }

    /// A run of work with main damaged at the end. `.bak` must still tell the truth about it, as it did
    /// when every heartbeat rotated the store, whichever moment the damage comes.
    fn damage_main(dir: &Path) {
        std::fs::write(dir.join(persist::MAIN_FILE), b"junk").unwrap();
    }
    fn minutes_of(s: &Service, task: &str) -> i64 {
        s.file()
            .data
            .segments
            .values()
            .filter(|x| x.task_id == task)
            .map(|x| x.end.unwrap_or(x.start).secs() - x.start.secs())
            .sum::<i64>()
            / 60
    }
    /// Time passing with a task running, in two beats: each one waits for a real disk flush.
    fn beats(s: &mut Service, clock: &ManualClock, minutes: i64) {
        clock.advance(minutes * 60 - 30);
        s.heartbeat().unwrap();
        clock.advance(30);
        s.heartbeat().unwrap();
    }

    #[test]
    fn with_main_damaged_after_a_switch_hours_stay_on_the_right_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, a) = running(dir.path(), &clock);
        beats(&mut s, &clock, 60);
        let b = s
            .create_task(&tinput("B", &s.file().data.tasks[&a].project_id.clone()))
            .unwrap();
        s.start_task(&b).unwrap();
        beats(&mut s, &clock, 420);
        drop(s);
        damage_main(dir.path());
        let again = open(dir.path(), &clock);
        assert_eq!(minutes_of(&again, &a), 60);
        assert_eq!(minutes_of(&again, &b), 420);
    }

    #[test]
    fn with_main_damaged_right_after_a_pause_the_hours_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, a) = running(dir.path(), &clock);
        beats(&mut s, &clock, 180);
        clock.advance(10);
        s.pause_task(&a).unwrap();
        drop(s);
        damage_main(dir.path());
        let again = open(dir.path(), &clock);
        assert_eq!(minutes_of(&again, &a), 180);
    }

    #[test]
    fn with_main_damaged_after_a_clean_quit_the_hours_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, a) = running(dir.path(), &clock);
        beats(&mut s, &clock, 480);
        s.on_exit().unwrap();
        drop(s);
        damage_main(dir.path());
        let again = open(dir.path(), &clock);
        assert_eq!(minutes_of(&again, &a), 480);
    }

    #[test]
    fn with_main_damaged_an_edit_older_than_one_beat_survives() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, a) = running(dir.path(), &clock);
        beats(&mut s, &clock, 10);
        let project = s.create_project(&pinput("Later")).unwrap();
        beats(&mut s, &clock, 20);
        drop(s);
        damage_main(dir.path());
        let again = open(dir.path(), &clock);
        assert!(again.file().data.projects.contains_key(&project));
        assert_eq!(minutes_of(&again, &a), 30);
    }

    #[test]
    fn restoring_a_backup_is_not_overruled_by_a_heartbeat_from_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.run_daily_backup().unwrap();
        let name = s.list_backups().unwrap().remove(0).name;
        clock.advance(86_400);
        s.heartbeat().unwrap();
        s.restore_backup(&name).unwrap();
        assert!(!dir.path().join(persist::HEARTBEAT_FILE).exists());
        assert_eq!(s.file().last_heartbeat.unwrap().iso(), T0);
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

    #[test]
    fn a_lock_opens_one_unconfirmed_gap_whatever_the_idle_limit_says() {
        for (limit, lock_secs) in [(10i64, 9 * 60i64), (0, 3 * 3600)] {
            let dir = tempfile::tempdir().unwrap();
            let clock = ManualClock::at(T0);
            let (mut s, _) = running(dir.path(), &clock);
            s.set_setting("idleMinutes", serde_json::json!(limit))
                .unwrap();
            s.observe_lock(Some(false)).unwrap();
            s.observe_activity(Some(0)).unwrap();
            clock.advance(5);
            assert!(!s.observe_lock(Some(true)).unwrap());
            assert_eq!(s.file().prefs.away_since, Some(clock.now()));
            let mut left = lock_secs;
            while left > 0 {
                clock.advance(5);
                left -= 5;
                assert!(!s.observe_lock(Some(true)).unwrap());
                assert!(
                    !s.observe_activity(Some(0)).unwrap(),
                    "no idle count at all"
                );
            }
            assert!(s.observe_lock(Some(false)).unwrap());
            let gaps = pending_gaps(&s);
            assert_eq!(gaps.len(), 1, "limit {limit}");
            assert_eq!(gaps[0].kind, GapKind::Lock);
            assert_eq!(gaps[0].end.secs() - gaps[0].start.secs(), lock_secs);
            assert_eq!(s.file().prefs.away_since, None);
            s.decide_gap(&gaps[0].id, GapDecision::Thinking).unwrap();
        }
    }

    #[test]
    fn no_lock_signal_changes_nothing_and_a_lock_with_no_task_running_records_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        assert!(!s.observe_lock(None).unwrap());
        s.observe_lock(Some(true)).unwrap();
        clock.advance(3600);
        assert!(!s.observe_lock(Some(false)).unwrap());
        assert!(s.file().data.gaps.is_empty());
    }

    #[test]
    fn quitting_while_locked_records_the_time() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        s.observe_lock(Some(true)).unwrap();
        clock.advance(100);
        s.on_exit().unwrap();
        assert_eq!(pending_gaps(&s).len(), 1);
    }

    /// One summary, then a backup, then more summaries: the store a restore goes back from.
    fn billed_world(dir: &Path, clock: &ManualClock) -> (Service, String, String) {
        let mut s = open(dir, clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        s.start_task(&t).unwrap();
        clock.advance(3600);
        s.stop_task(&t).unwrap();
        (s, p, t)
    }
    fn this_month(p: &str) -> crate::summary::SummaryRequest {
        crate::summary::SummaryRequest {
            project_id: p.to_owned(),
            from: "2026-03-01".into(),
            to: "2026-03-31".into(),
            zone: "UTC".into(),
        }
    }

    #[test]
    fn restoring_an_older_backup_never_reuses_a_reference_number() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, p, _) = billed_world(dir.path(), &clock);
        s.run_daily_backup().unwrap();
        let name = s.list_backups().unwrap()[0].name.clone();
        let first = s.create_summary(&this_month(&p)).unwrap();
        assert_eq!(s.file().data.summaries[&first].reference, "A-001");
        s.restore_backup(&name).unwrap();
        assert!(
            s.file().data.summaries.is_empty(),
            "the summary was rolled back"
        );
        let again = s.create_summary(&this_month(&p)).unwrap();
        assert_eq!(s.file().data.summaries[&again].reference, "A-002");
        // The mark survives a relaunch too.
        drop(s);
        let s = open(dir.path(), &clock);
        assert_eq!(s.file().prefs.reference_marks["A"], 2);
    }

    #[test]
    fn a_restore_rolls_back_data_and_settings_and_keeps_what_belongs_to_the_device() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, p, _) = billed_world(dir.path(), &clock);
        s.set_setting("idleMinutes", serde_json::json!(25)).unwrap();
        s.run_daily_backup().unwrap();
        let name = s.list_backups().unwrap()[0].name.clone();
        let audits_at_backup = s.file().data.audit_log.len();
        clock.advance(60);
        s.set_setting("idleMinutes", serde_json::json!(5)).unwrap();
        s.set_device_prefix("Q").unwrap();
        s.set_backup_keep(7).unwrap();
        s.set_theme(Theme::SolarizedDark).unwrap();
        let later = s.create_project(&pinput("Later")).unwrap();
        s.create_summary(&this_month(&p)).unwrap();
        let audits_before = s.file().data.audit_log.len();
        assert!(audits_before > audits_at_backup);
        s.restore_backup(&name).unwrap();
        let f = s.file();
        assert!(!f.data.projects.contains_key(&later), "data rolls back");
        assert_eq!(
            f.data.settings["idleMinutes"].value,
            serde_json::json!(25),
            "settings roll back"
        );
        assert_eq!(f.data.prefix_of(&f.device_id), "Q", "the prefix stays");
        assert_eq!(
            f.prefs.backup_keep,
            Some(7),
            "this device's preferences stay"
        );
        assert_eq!(f.prefs.theme, Theme::SolarizedDark);
        assert_eq!(f.prefs.reference_marks["Q"], 1, "the mark stays");
        assert_eq!(
            f.data.audit_log.len(),
            audits_before + 1,
            "nothing leaves the audit trail"
        );
        let entry = f
            .data
            .audit_log
            .values()
            .find(|a| a.action == "restore")
            .unwrap();
        assert_eq!(entry.entity_id, name);
    }

    #[test]
    fn a_task_running_in_a_backup_closes_at_its_heartbeat_with_no_crash_notice() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        clock.advance(600);
        s.heartbeat().unwrap();
        let beat = clock.now();
        s.run_daily_backup().unwrap();
        let name = s.list_backups().unwrap()[0].name.clone();
        clock.advance(3600);
        s.restore_backup(&name).unwrap();
        let f = s.file();
        assert_eq!(f.data.tasks[&t].state, TaskState::Paused);
        assert_eq!(
            f.data.tasks[&t].pause_reason,
            Some(PauseReason::BackupRestored)
        );
        assert!(f.data.segments.values().all(|x| x.end == Some(beat)));
        let notices = s.snapshot().notices;
        assert!(
            notices
                .iter()
                .all(|n| !n.message.contains("did not shut down cleanly")),
            "{notices:?}"
        );
        assert!(
            notices
                .iter()
                .any(|n| n.message.contains("running when this backup was taken"))
        );
    }

    #[test]
    fn the_list_of_backups_is_newest_first_across_both_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.run_daily_backup().unwrap();
        let name = s.list_backups().unwrap()[0].name.clone();
        clock.advance(86_400 * 2);
        s.run_daily_backup().unwrap();
        clock.advance(60);
        let safety = s.restore_backup(&name).unwrap();
        assert_eq!(s.list_backups().unwrap()[0].name, safety);
    }

    /// One poll round as the app makes it: the lock first, then the activity tick.
    fn poll(s: &mut Service, clock: &ManualClock, secs: i64, locked: Option<bool>) {
        clock.advance(secs);
        s.observe_lock(locked).unwrap();
        s.observe_activity(Some(0)).unwrap();
    }

    #[test]
    fn a_query_that_never_answers_leaves_idle_and_sleep_detection_working() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        for _ in 0..50 {
            poll(&mut s, &clock, 5, None);
        }
        assert!(pending_gaps(&s).is_empty(), "working is not an absence");
        poll(&mut s, &clock, 3600, None);
        assert_eq!(pending_gaps(&s).len(), 1, "the sleep is still found");
    }

    #[test]
    fn a_query_failing_after_a_lock_closes_it_at_the_last_confirmed_moment() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        poll(&mut s, &clock, 5, Some(true));
        for _ in 0..60 {
            poll(&mut s, &clock, 5, Some(true));
        }
        for _ in 0..720 {
            poll(&mut s, &clock, 5, None);
        }
        assert!(
            s.file().prefs.away_since.is_none(),
            "the lock no longer latches"
        );
        let gaps = pending_gaps(&s);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].kind, GapKind::Lock);
        assert_eq!(
            gaps[0].end.secs() - gaps[0].start.secs(),
            300,
            "not the hour of work after it"
        );
        // The answer coming back later adds nothing.
        s.observe_lock(Some(false)).unwrap();
        assert_eq!(s.file().data.gaps.len(), 1);
    }

    #[test]
    fn a_lock_seen_once_before_the_query_fails_stays_work_and_a_later_sleep_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        poll(&mut s, &clock, 5, Some(true));
        for _ in 0..720 {
            poll(&mut s, &clock, 5, None);
        }
        assert!(pending_gaps(&s).is_empty());
        poll(&mut s, &clock, 3600, None);
        let gaps = pending_gaps(&s);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].kind, GapKind::Sleep);
        s.on_exit().unwrap();
        assert_eq!(pending_gaps(&s).len(), 1);
    }

    #[test]
    fn one_failed_poll_does_not_split_a_lock() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        poll(&mut s, &clock, 5, Some(true));
        poll(&mut s, &clock, 5, None);
        poll(&mut s, &clock, 5, Some(true));
        poll(&mut s, &clock, 5, Some(false));
        let gaps = pending_gaps(&s);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].end.secs() - gaps[0].start.secs(), 15);
    }

    #[test]
    fn a_clock_going_back_during_a_lock_records_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        clock.advance(5);
        s.observe_activity(Some(0)).unwrap();
        s.observe_lock(Some(true)).unwrap();
        clock.advance(-300);
        s.observe_lock(Some(false)).unwrap();
        assert!(pending_gaps(&s).is_empty());
    }

    #[test]
    fn a_crash_during_a_lock_is_labelled_a_lock() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, _) = running(dir.path(), &clock);
        s.observe_activity(Some(0)).unwrap();
        poll(&mut s, &clock, 5, Some(true));
        clock.advance(60);
        s.heartbeat().unwrap();
        assert_eq!(s.file().prefs.away_kind, Some(GapKind::Lock));
        drop(s);
        clock.advance(600);
        let s = open(dir.path(), &clock);
        let gaps = pending_gaps(&s);
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].kind, GapKind::Lock);
        assert_eq!(s.file().prefs.away_kind, None);
    }

    // ---- Gap-fill round

    fn fixed_random() -> Box<dyn FnMut() -> u64 + Send> {
        let mut n = 11u64;
        Box::new(move || {
            n = n.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            n >> 16
        })
    }

    #[test]
    fn an_exact_colour_clash_is_replaced_and_reported_and_a_similar_one_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        s.set_random(fixed_random());
        let a = s
            .create_project(&ProjectInput {
                color: "#2563eb".into(),
                ..pinput("A")
            })
            .unwrap();
        assert_eq!(s.take_color_replaced(), None);
        let b = s
            .create_project(&ProjectInput {
                color: "#2563EB".into(),
                ..pinput("B")
            })
            .unwrap();
        assert_eq!(s.take_color_replaced().as_deref(), Some("#2563EB"));
        assert_ne!(s.file().data.projects[&b].color, "#2563eb");
        let c = s
            .create_project(&ProjectInput {
                color: "#2563ec".into(),
                ..pinput("C")
            })
            .unwrap();
        assert_eq!(s.take_color_replaced(), None);
        assert_eq!(s.file().data.projects[&c].color, "#2563ec");
        // Archived projects don't count.
        s.set_project_archived(&a, true).unwrap();
        let d = s
            .create_project(&ProjectInput {
                color: "#2563eb".into(),
                ..pinput("D")
            })
            .unwrap();
        assert_eq!(s.take_color_replaced(), None);
        assert_eq!(s.file().data.projects[&d].color, "#2563eb");
        // Saving a colour left unchanged never replaces it.
        s.mutate(|f, _| {
            f.data.projects.get_mut(&c).unwrap().color = "#2563eb".into();
            Ok(())
        })
        .unwrap();
        s.update_project(
            &c,
            &ProjectInput {
                color: "#2563eb".into(),
                ..pinput("C renamed")
            },
        )
        .unwrap();
        assert_eq!(s.take_color_replaced(), None);
        assert_eq!(s.file().data.projects[&c].color, "#2563eb");
        assert!(
            s.snapshot()
                .warnings
                .iter()
                .any(|w| w.contains("same colour"))
        );
    }

    #[test]
    fn tags_follow_the_same_rule_within_their_own_kind() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        s.set_random(fixed_random());
        s.create_project(&ProjectInput {
            color: "#123456".into(),
            ..pinput("A")
        })
        .unwrap();
        let tag = TagInput {
            id: None,
            name: "New".into(),
            color: "#123456".into(),
        };
        let id = s.save_tag(&tag).unwrap();
        assert_eq!(
            s.take_color_replaced(),
            None,
            "a project's colour doesn't count"
        );
        let again = s
            .save_tag(&TagInput {
                name: "Again".into(),
                ..tag
            })
            .unwrap();
        assert_eq!(s.take_color_replaced().as_deref(), Some("#123456"));
        assert_ne!(
            s.file().data.tags[&again].color,
            s.file().data.tags[&id].color
        );
    }

    #[test]
    fn colours_two_devices_picked_offline_stay_as_saved_after_a_merge() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let a = s.create_project(&pinput("A")).unwrap();
        let mut other = s.file().data.clone();
        let mut twin = other.projects[&a].clone();
        twin.id = "twin".into();
        twin.name = "Twin".into();
        other.projects.insert("twin".into(), twin);
        s.absorb_remote(&other, BTreeMap::new(), Vec::new());
        assert_eq!(
            s.file().data.projects["twin"].color,
            s.file().data.projects[&a].color
        );
        assert!(
            s.snapshot()
                .warnings
                .iter()
                .any(|w| w.contains("same colour"))
        );
    }

    #[test]
    fn setup_is_pending_only_on_a_fresh_store_resumes_and_answers_the_old_prompts() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        assert!(s.snapshot().setup.pending);
        s.set_setup_step(3).unwrap();
        drop(s);
        let mut s = open(dir.path(), &clock);
        assert!(s.snapshot().setup.pending);
        assert_eq!(s.snapshot().setup.step, 3, "resumes");
        s.finish_setup().unwrap();
        let snap = s.snapshot();
        assert!(!snap.setup.pending);
        assert!(!snap.sync.prompt_pending);
        assert!(snap.prefs.client_zone_prompt_done);
        drop(s);
        assert!(
            !open(dir.path(), &clock).snapshot().setup.pending,
            "shown once"
        );
    }

    #[test]
    fn connecting_a_folder_during_setup_does_not_end_it_and_a_user_with_data_is_not_asked() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        s.add_sync_target(SyncTarget {
            provider: SyncProvider::Custom,
            root: "/somewhere".into(),
        })
        .unwrap();
        assert!(
            s.snapshot().setup.pending,
            "the rest of the steps are still owed"
        );
        s.finish_setup().unwrap();
        assert!(!s.snapshot().setup.pending);

        let dir = tempfile::tempdir().unwrap();
        let mut s = open(dir.path(), &clock);
        s.create_project(&pinput("Mine")).unwrap();
        assert!(!s.snapshot().setup.pending, "data from before the wizard");
        s.add_sync_target(SyncTarget {
            provider: SyncProvider::Custom,
            root: "/elsewhere".into(),
        })
        .unwrap();
        assert!(!s.snapshot().setup.pending, "connecting doesn't start it");
    }

    #[test]
    fn an_existing_user_is_not_shown_setup() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        s.mark_sync_prompt_done().unwrap();
        assert!(!s.snapshot().setup.pending);
    }

    #[test]
    fn a_draft_typed_before_a_shutdown_is_recovered_once_and_a_stale_one_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        let stale = s.create_task(&tinput("Stale", &p)).unwrap();
        clock.advance(5);
        s.stash_draft(&t, &doc("Typed at the last moment"), &Value::Null)
            .unwrap();
        s.stash_draft(&stale, &doc("Older than the save"), &Value::Null)
            .unwrap();
        assert!(
            s.stash_draft(&t, &serde_json::json!("<b>no</b>"), &Value::Null)
                .is_err()
        );
        clock.advance(5);
        s.update_task(
            &stale,
            &TaskInput {
                description: doc("Saved later"),
                ..tinput("Stale", &p)
            },
        )
        .unwrap();
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(dir.path(), &clock);
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("Typed at the last moment")
        );
        assert_eq!(s.file().data.tasks[&stale].description, doc("Saved later"));
        assert!(
            s.snapshot()
                .notices
                .iter()
                .any(|n| n.message.contains("Recovered"))
        );
        // The stale one replaces nothing, and its words are shown rather than dropped, until dismissed.
        let older = s
            .snapshot()
            .notices
            .into_iter()
            .find(|n| n.message.contains("Older than the save"))
            .unwrap();
        s.dismiss_notice(&older.id);
        s.on_exit().unwrap();
        drop(s);
        let s = open(dir.path(), &clock);
        assert!(s.snapshot().notices.is_empty(), "replayed once");
    }

    /// Two devices, the task shared. Returns them with the task id.
    fn two_devices(here: &Path, there: &Path, clock: &ManualClock) -> (Service, Service, String) {
        let mut s = open(here, clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        let mut other = open(there, clock);
        other.absorb_remote(&s.file().data.clone(), BTreeMap::new(), Vec::new());
        (s, other, t)
    }

    /// The description `other` holds, saved there and merged here.
    fn edited_elsewhere(s: &mut Service, other: &mut Service, t: &str, text: &str) {
        other
            .patch_task(
                t,
                &TaskPatch {
                    description: Some(doc(text)),
                    ..TaskPatch::default()
                },
                &TaskExpected::default(),
            )
            .unwrap();
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
    }

    #[test]
    fn a_draft_never_replaces_text_that_came_from_elsewhere_meanwhile() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(3);
        other
            .patch_task(
                &t,
                &TaskPatch {
                    description: Some(doc("From another device")),
                    ..TaskPatch::default()
                },
                &TaskExpected::default(),
            )
            .unwrap();
        // Typed after the other device saved, so the old rule (the newer stamp wins) would replace it.
        clock.advance(2);
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        clock.advance(1);
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here.path(), &clock);
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("From another device")
        );
        let notices = s.snapshot().notices;
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].level, "warning");
        assert!(notices[0].message.contains("Typed here"));
        assert!(notices[0].message.contains("changed elsewhere"));
        // The notice is the only place left for them, so they outlast a launch nobody read it in.
        assert_eq!(kept_words(here.path()), ["Typed here"]);
        assert!(crate::drafts::read(here.path()).is_empty());
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here.path(), &clock);
        let notices = s.snapshot().notices;
        assert_eq!(notices.len(), 1);
        assert!(notices[0].message.contains("Typed here"));
        // Dismissing it ends them.
        s.dismiss_notice(&notices[0].id);
        assert!(kept_words(here.path()).is_empty());
        s.on_exit().unwrap();
        drop(s);
        let s = open(here.path(), &clock);
        assert!(s.snapshot().notices.is_empty());
    }

    #[test]
    fn a_draft_older_than_the_text_from_elsewhere_is_shown_too() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(2);
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let s = open(here.path(), &clock);
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("From another device")
        );
        assert!(
            s.snapshot().notices[0].message.contains("Typed here"),
            "words older than the newer text still may not vanish"
        );
    }

    #[test]
    fn a_draft_over_text_from_elsewhere_the_editor_was_showing_is_recovered() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        clock.advance(2);
        s.stash_draft(&t, &doc("Typed here"), &doc("From another device"))
            .unwrap();
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let s = open(here.path(), &clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Typed here"));
        assert!(
            s.snapshot()
                .notices
                .iter()
                .any(|n| n.message.contains("Recovered"))
        );
    }

    #[test]
    fn a_draft_typed_after_a_slow_save_of_this_device_is_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(5);
        s.patch_task(
            &t,
            &TaskPatch {
                description: Some(doc("Saved")),
                ..TaskPatch::default()
            },
            &TaskExpected::default(),
        )
        .unwrap();
        // The save's reply hadn't come, so the draft still names the text before it.
        clock.advance(1);
        s.stash_draft(&t, &doc("Saved and more"), &shown).unwrap();
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let s = open(dir.path(), &clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Saved and more"));
    }

    #[test]
    fn dismissing_a_notice_leaves_words_stashed_since() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here.path(), &clock);
        clock.advance(5);
        s.stash_draft(&t, &doc("Typed later"), &doc("From another device"))
            .unwrap();
        let id = s.snapshot().notices[0].id.clone();
        s.dismiss_notice(&id);
        assert_eq!(
            crate::drafts::read(here.path())[&t].description,
            doc("Typed later")
        );
    }

    /// Words a launch could not put back: stored, stashed over and saved over on the same task.
    fn words_kept_at_a_launch(here: &Path, there: &Path, clock: &ManualClock) -> (Service, String) {
        let (mut s, mut other, t) = two_devices(here, there, clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(3);
        s.stash_draft(&t, &doc("Held words before the restart"), &shown)
            .unwrap();
        clock.advance(1);
        edited_elsewhere(&mut s, &mut other, &t, "Newer from elsewhere");
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let s = open(here, clock);
        assert_eq!(kept_notices(&s).len(), 1);
        (s, t)
    }

    /// The words in their file.
    fn kept_words(dir: &Path) -> Vec<String> {
        crate::drafts::read_kept(dir)
            .unwrap()
            .into_iter()
            .map(|k| k.words)
            .collect()
    }

    /// What the notices say of the words kept at a launch.
    fn kept_notices(s: &Service) -> Vec<String> {
        s.snapshot()
            .notices
            .into_iter()
            .filter(|n| n.message.contains("Your unsaved words"))
            .map(|n| n.message)
            .collect()
    }

    #[test]
    fn typing_on_a_task_leaves_the_words_its_notice_shows() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = words_kept_at_a_launch(here.path(), there.path(), &clock);
        // Without dismissing the notice, the user goes on in that task, as they would to merge the words in.
        let stored = s.file().data.tasks[&t].description.clone();
        clock.advance(1);
        s.stash_draft(&t, &doc("Newer from elsewhere and more"), &stored)
            .unwrap();
        clock.advance(1);
        s.patch_task(
            &t,
            &TaskPatch {
                description: Some(doc("Newer from elsewhere and more")),
                ..TaskPatch::default()
            },
            &TaskExpected {
                description: Some(stored),
                ..TaskExpected::default()
            },
        )
        .unwrap();
        s.clear_draft(&t).unwrap();
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here.path(), &clock);
        let words = kept_notices(&s);
        assert_eq!(
            words.len(),
            1,
            "the notice comes back until it is dismissed"
        );
        assert!(words[0].contains("Held words before the restart"));
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("Newer from elsewhere and more")
        );
        // Only dismissing it ends them.
        let id = s.snapshot().notices[0].id.clone();
        s.dismiss_notice(&id);
        s.on_exit().unwrap();
        drop(s);
        let s = open(here.path(), &clock);
        assert!(kept_notices(&s).is_empty());
    }

    #[test]
    fn a_stash_alone_leaves_the_words_a_notice_shows_and_is_put_back_itself() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (s, t) = words_kept_at_a_launch(here.path(), there.path(), &clock);
        // Typed, and the app killed before the save: the stash is replayed, and the notice stays.
        let stored = s.file().data.tasks[&t].description.clone();
        clock.advance(1);
        s.stash_draft(&t, &doc("Typed after the notice"), &stored)
            .unwrap();
        drop(s);
        clock.advance(60);
        let s = open(here.path(), &clock);
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("Typed after the notice")
        );
        let words = kept_notices(&s);
        assert_eq!(words.len(), 1);
        assert!(words[0].contains("Held words before the restart"));
    }

    #[test]
    fn two_lots_of_words_kept_on_one_task_each_have_their_notice() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(3);
        s.stash_draft(&t, &doc("First words"), &shown).unwrap();
        clock.advance(1);
        edited_elsewhere(&mut s, &mut other, &t, "Newer one");
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here.path(), &clock);
        assert_eq!(kept_notices(&s).len(), 1);
        clock.advance(1);
        s.stash_draft(&t, &doc("Second words"), &doc("Newer one"))
            .unwrap();
        clock.advance(1);
        edited_elsewhere(&mut s, &mut other, &t, "Newer two");
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here.path(), &clock);
        let words = kept_notices(&s);
        assert_eq!(words.len(), 2);
        assert!(words.iter().any(|w| w.contains("First words")));
        assert!(words.iter().any(|w| w.contains("Second words")));
        // Dismissing one leaves the other.
        let first = s
            .snapshot()
            .notices
            .into_iter()
            .find(|n| n.message.contains("First words"))
            .unwrap();
        s.dismiss_notice(&first.id);
        s.on_exit().unwrap();
        drop(s);
        let s = open(here.path(), &clock);
        let words = kept_notices(&s);
        assert_eq!(words.len(), 1);
        assert!(words[0].contains("Second words"));
    }

    #[test]
    fn a_draft_on_a_task_deleted_elsewhere_is_shown_until_dismissed() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        clock.advance(3);
        other.delete_draft(&t).unwrap();
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let s = open(here.path(), &clock);
        let words = kept_notices(&s);
        assert_eq!(words.len(), 1);
        assert!(words[0].contains("Typed here"));
        assert!(words[0].contains("“T”"));
        assert!(words[0].contains("no longer exists"));
        drop(s);
        let mut s = open(here.path(), &clock);
        let id = s.snapshot().notices[0].id.clone();
        s.dismiss_notice(&id);
        drop(s);
        let s = open(here.path(), &clock);
        assert!(s.snapshot().notices.is_empty());
    }

    #[test]
    fn a_draft_already_saved_or_empty_on_a_task_deleted_elsewhere_is_nothing_to_tell() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        let empty = s
            .create_task(&tinput(
                "Empty",
                &s.file().data.tasks[&t].project_id.clone(),
            ))
            .unwrap();
        s.patch_task(
            &t,
            &TaskPatch {
                description: Some(doc("Saved")),
                ..TaskPatch::default()
            },
            &TaskExpected::default(),
        )
        .unwrap();
        s.stash_draft(&t, &doc("Saved"), &shown).unwrap();
        s.stash_draft(&empty, &Value::Null, &Value::Null).unwrap();
        other.absorb_remote(&s.file().data.clone(), BTreeMap::new(), Vec::new());
        clock.advance(3);
        other.delete_draft(&t).unwrap();
        other.delete_draft(&empty).unwrap();
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        s.on_exit().unwrap();
        drop(s);
        let s = open(here.path(), &clock);
        assert!(s.snapshot().notices.is_empty());
    }

    #[test]
    fn words_put_back_at_launch_whose_task_the_first_sync_deletes_are_shown_not_lost() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(2);
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        s.on_exit().unwrap();
        drop(s);
        clock.advance(30);
        other.delete_draft(&t).unwrap();
        clock.advance(30);
        let mut s = open(here.path(), &clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Typed here"));
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        assert!(!s.file().data.tasks[&t].is_live());
        let words = kept_notices(&s);
        assert_eq!(words.len(), 1);
        assert!(words[0].contains("Typed here"));
        assert!(words[0].contains("no longer exists"));
    }

    #[test]
    fn words_the_page_gives_up_on_a_gone_task_are_shown_until_dismissed() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        s.keep_unsaved_words("gone", "Old name", "New name\nTyped here");
        let words = kept_notices(&s);
        assert_eq!(words.len(), 1);
        assert!(words[0].contains("“Old name”"));
        assert!(words[0].contains("New name\nTyped here"));
        s.on_exit().unwrap();
        drop(s);
        let mut s = open(dir.path(), &clock);
        assert_eq!(kept_notices(&s), words, "the same again at the next launch");
        let id = s.snapshot().notices[0].id.clone();
        s.dismiss_notice(&id);
        assert!(kept_words(dir.path()).is_empty());
    }

    /// Words put back at launch, and the other device has them too.
    fn words_put_back_and_synced(
        here: &Path,
        there: &Path,
        clock: &ManualClock,
    ) -> (Service, Service, String) {
        let (mut s, mut other, t) = two_devices(here, there, clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(2);
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let mut s = open(here, clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Typed here"));
        other.absorb_remote(&s.file().data.clone(), BTreeMap::new(), Vec::new());
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        (s, other, t)
    }

    #[test]
    fn an_edit_made_after_the_launch_goes_on_from_words_put_back_and_tells_nothing() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = words_put_back_and_synced(here.path(), there.path(), &clock);
        clock.advance(4 * 3600);
        edited_elsewhere(&mut s, &mut other, &t, "Typed here, and on from it");
        assert!(kept_notices(&s).is_empty());
        assert!(kept_words(here.path()).is_empty());
    }

    #[test]
    fn a_task_deleted_after_the_launch_with_words_put_back_in_it_tells_nothing() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = words_put_back_and_synced(here.path(), there.path(), &clock);
        clock.advance(60);
        s.delete_draft(&t).unwrap();
        clock.advance(60);
        let p = s.file().data.tasks[&t].project_id.clone();
        other.create_task(&tinput("Another", &p)).unwrap();
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        assert!(kept_notices(&s).is_empty());
    }

    #[test]
    fn a_task_deleted_elsewhere_after_the_launch_with_words_put_back_in_it_tells_nothing() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = words_put_back_and_synced(here.path(), there.path(), &clock);
        clock.advance(60);
        other.delete_draft(&t).unwrap();
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        assert!(!s.file().data.tasks[&t].is_live());
        assert!(kept_notices(&s).is_empty());
    }

    #[test]
    fn words_stay_a_draft_until_their_own_file_has_them() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        s.on_exit().unwrap();
        drop(s);
        // A folder where the file's temporary copy goes makes the write fail.
        let blocker = here.path().join("z-work-kept-words.json.tmp");
        std::fs::create_dir(&blocker).unwrap();
        let s = open(here.path(), &clock);
        assert_eq!(kept_notices(&s).len(), 1);
        assert!(!crate::drafts::read(here.path()).is_empty());
        assert!(kept_words(here.path()).is_empty());
        drop(s);
        std::fs::remove_dir(&blocker).unwrap();
        let s = open(here.path(), &clock);
        assert_eq!(kept_notices(&s).len(), 1);
        assert_eq!(kept_words(here.path()), ["Typed here"]);
        assert!(crate::drafts::read(here.path()).is_empty());
    }

    #[test]
    fn a_launch_cut_short_before_it_cleared_a_draft_tells_of_its_words_once() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        let draft = crate::drafts::read(here.path());
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        s.on_exit().unwrap();
        drop(s);
        drop(open(here.path(), &clock));
        // As if the launch had stopped between writing the words and clearing the draft.
        crate::drafts::write(here.path(), &draft).unwrap();
        let s = open(here.path(), &clock);
        assert_eq!(kept_notices(&s).len(), 1);
        assert_eq!(kept_words(here.path()), ["Typed here"]);
        assert!(crate::drafts::read(here.path()).is_empty());
    }

    #[test]
    fn a_file_of_kept_words_that_cannot_be_read_is_told_of_and_not_written_over() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        drop(open(dir.path(), &clock));
        let path = dir.path().join("z-work-kept-words.json");
        std::fs::write(&path, b"{ not the words").unwrap();
        let s = open(dir.path(), &clock);
        let notices = s.snapshot().notices;
        assert_eq!(notices.len(), 1);
        assert!(notices[0].message.contains("can't be read"));
        assert!(!path.exists());
        assert_eq!(
            std::fs::read(dir.path().join("z-work-kept-words.json.damaged")).unwrap(),
            b"{ not the words"
        );
        drop(s);
        let s = open(dir.path(), &clock);
        assert!(s.snapshot().notices.is_empty(), "told once");
    }

    /// Stamps run ahead of the clock when saves come faster than one a second or another device's clock is
    /// ahead, so a stamp later than a draft does not show the draft is older than the save.
    #[test]
    fn a_draft_with_an_earlier_time_than_this_devices_save_is_shown_not_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        let shown = s.file().data.tasks[&t].description.clone();
        s.stash_draft(&t, &doc("Saved three and more"), &shown)
            .unwrap();
        for words in ["Saved one", "Saved two", "Saved three"] {
            s.patch_task(
                &t,
                &TaskPatch {
                    description: Some(doc(words)),
                    ..TaskPatch::default()
                },
                &TaskExpected::default(),
            )
            .unwrap();
        }
        s.on_exit().unwrap();
        drop(s);
        let s = open(dir.path(), &clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Saved three"));
        let notices = s.snapshot().notices;
        assert!(notices[0].message.contains("Saved three and more"));
    }

    #[test]
    fn a_draft_that_differs_from_the_stored_text_only_in_subtask_ids_was_saved() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        let shown = s.file().data.tasks[&t].description.clone();
        let list = serde_json::json!({"type":"doc","content":[{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":false,"subtaskId":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"One"}]}]}]}]});
        s.stash_draft(&t, &list, &shown).unwrap();
        clock.advance(1);
        s.patch_task(
            &t,
            &TaskPatch {
                description: Some(list),
                ..TaskPatch::default()
            },
            &TaskExpected::default(),
        )
        .unwrap();
        s.on_exit().unwrap();
        drop(s);
        let s = open(dir.path(), &clock);
        assert!(s.snapshot().notices.is_empty());
    }

    #[test]
    fn words_put_back_at_launch_that_lose_to_the_first_sync_are_shown_not_lost() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        clock.advance(2);
        s.stash_draft(&t, &doc("Typed here"), &shown).unwrap();
        s.on_exit().unwrap();
        drop(s);
        // The other device edits while this one is off, and later than the words were typed.
        clock.advance(30);
        other
            .patch_task(
                &t,
                &TaskPatch {
                    description: Some(doc("From another device")),
                    ..TaskPatch::default()
                },
                &TaskExpected::default(),
            )
            .unwrap();
        clock.advance(30);
        let mut s = open(here.path(), &clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Typed here"));
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("From another device")
        );
        let notices = s.snapshot().notices;
        assert!(notices.iter().any(|n| n.message.contains("Typed here")));
        // Told once in this run, and kept for the next like any other.
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        assert_eq!(s.snapshot().notices.len(), notices.len());
        assert_eq!(kept_words(here.path()), ["Typed here"]);
        s.on_exit().unwrap();
        drop(s);
        let s = open(here.path(), &clock);
        assert!(
            s.snapshot()
                .notices
                .iter()
                .any(|n| n.message.contains("Typed here"))
        );
    }

    #[test]
    fn a_draft_with_no_text_that_met_newer_text_is_nothing_to_tell() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let shown = s.file().data.tasks[&t].description.clone();
        s.stash_draft(&t, &Value::Null, &shown).unwrap();
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        s.on_exit().unwrap();
        drop(s);
        clock.advance(60);
        let s = open(here.path(), &clock);
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("From another device")
        );
        assert!(s.snapshot().notices.is_empty());
    }

    /// A known limitation, in the README: a save checks only against what has reached its own PC. If this
    /// behaviour changes, so does that entry.
    #[test]
    fn two_pcs_saving_one_field_before_a_sync_keep_the_later_save_and_say_nothing() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let base = s.file().data.tasks[&t].description.clone();
        let expected = TaskExpected {
            description: Some(base),
            ..TaskExpected::default()
        };
        let save = |svc: &mut Service, words: &str| {
            let patch = TaskPatch {
                description: Some(doc(words)),
                ..TaskPatch::default()
            };
            svc.patch_task(&t, &patch, &expected).unwrap().conflicts
        };
        clock.advance(5);
        assert!(save(&mut s, "Words on this PC").is_empty());
        clock.advance(5);
        assert!(save(&mut other, "Words on the other PC").is_empty());
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        other.absorb_remote(&s.file().data.clone(), BTreeMap::new(), Vec::new());
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("Words on the other PC")
        );
        assert_eq!(
            other.file().data.tasks[&t].description,
            doc("Words on the other PC")
        );
        assert!(s.snapshot().notices.is_empty());
        assert!(other.snapshot().notices.is_empty());
    }

    #[test]
    fn a_merge_landing_between_the_read_and_the_save_is_refused_at_the_write() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        // The editor reads what is stored.
        let task = s.snapshot().tasks.into_iter().find(|x| x.id == t).unwrap();
        let revision = s.revision();
        // A sync lands before the save does.
        clock.advance(3);
        edited_elsewhere(&mut s, &mut other, &t, "From another device");
        assert!(s.revision() > revision, "a merge counts as a change");
        clock.advance(2);
        let out = s
            .patch_task(
                &t,
                &TaskPatch {
                    name: Some("Mine".into()),
                    description: Some(doc("My words")),
                    ..TaskPatch::default()
                },
                &TaskExpected {
                    name: Some(task.name),
                    description: Some(task.description),
                    ..TaskExpected::default()
                },
            )
            .unwrap();
        assert_eq!(out.conflicts, vec![crate::machine::TaskField::Description]);
        assert_eq!(out.stored.description, doc("From another device"));
        assert_eq!(out.stored.name, "Mine", "the rest of the patch goes");
        let stored = &s.file().data.tasks[&t];
        assert_eq!(stored.description, doc("From another device"));
        assert_eq!(stored.name, "Mine");
        // And the refusal holds across a restart: what was written is what the reply said.
        s.on_exit().unwrap();
        drop(s);
        let s = open(here.path(), &clock);
        assert_eq!(
            s.file().data.tasks[&t].description,
            doc("From another device")
        );
    }

    #[test]
    fn a_merge_of_another_field_never_conflicts_and_the_snapshot_counts_changes() {
        let here = tempfile::tempdir().unwrap();
        let there = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, mut other, t) = two_devices(here.path(), there.path(), &clock);
        let task = s.snapshot().tasks.into_iter().find(|x| x.id == t).unwrap();
        let before = s.snapshot().revision;
        clock.advance(3);
        other
            .patch_task(
                &t,
                &TaskPatch {
                    name: Some("Renamed elsewhere".into()),
                    ..TaskPatch::default()
                },
                &TaskExpected::default(),
            )
            .unwrap();
        s.absorb_remote(&other.file().data.clone(), BTreeMap::new(), Vec::new());
        let out = s
            .patch_task(
                &t,
                &TaskPatch {
                    description: Some(doc("My words")),
                    ..TaskPatch::default()
                },
                &TaskExpected {
                    description: Some(task.description),
                    ..TaskExpected::default()
                },
            )
            .unwrap();
        assert_eq!(out.conflicts, Vec::new());
        assert_eq!(out.stored.name, "Renamed elsewhere");
        assert_eq!(out.stored.description, doc("My words"));
        assert!(s.snapshot().revision > before);
    }

    #[test]
    fn a_failed_save_at_launch_keeps_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        clock.advance(5);
        s.stash_draft(&t, &doc("Typed"), &Value::Null).unwrap();
        s.on_exit().unwrap();
        drop(s);
        // The temporary file the save writes through is a folder, so the save fails.
        let blocked = dir.path().join("z-work-data.json.tmp");
        std::fs::create_dir(&blocked).unwrap();
        clock.advance(5);
        assert!(Service::open(dir.path(), Arc::new(clock.clone()), "pc").is_err());
        assert!(!crate::drafts::read(dir.path()).is_empty());
        std::fs::remove_dir(&blocked).unwrap();
        let s = open(dir.path(), &clock);
        assert_eq!(s.file().data.tasks[&t].description, doc("Typed"));
    }

    #[test]
    fn two_pause_requests_close_at_the_earliest_with_one_audit_entry() {
        let dir_a = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut owner, t) = running(dir_a.path(), &clock);
        clock.advance(600);
        let mut data = owner.file().data.clone();
        let seg = data.segments.keys().next().unwrap().clone();
        let at = |n: i64| Ts(Ts::parse(T0).unwrap().0 + n);
        for (id, n) in [("late", 500), ("early", 100)] {
            data.pause_requests.insert(
                id.into(),
                crate::model::PauseRequest {
                    id: id.into(),
                    task_id: t.clone(),
                    segment_id: seg.clone(),
                    requested_by: "pc-b".into(),
                    at: at(n),
                    stamp: crate::model::Stamp::default(),
                },
            );
        }
        owner.absorb_remote(&data, BTreeMap::new(), Vec::new());
        assert_eq!(owner.file().data.segments[&seg].end, Some(at(100)));
        let audits = owner
            .file()
            .data
            .audit_log
            .values()
            .filter(|a| a.action == "pausedByRequest")
            .count();
        assert_eq!(audits, 1);
    }

    #[test]
    fn a_saved_edit_clears_its_draft() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let p = s.create_project(&pinput("P")).unwrap();
        let t = s.create_task(&tinput("T", &p)).unwrap();
        clock.advance(5);
        s.stash_draft(&t, &doc("Draft"), &Value::Null).unwrap();
        s.clear_draft(&t).unwrap();
        drop(s);
        clock.advance(5);
        let s = open(dir.path(), &clock);
        assert_ne!(s.file().data.tasks[&t].description, doc("Draft"));
    }

    #[test]
    fn the_owner_is_told_once_which_task_was_paused_and_by_which_device() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut owner, t) = running(dir_a.path(), &clock);
        owner.set_system_zone("UTC".into());
        let mut asker = open(dir_b.path(), &clock);
        clock.advance(600);
        asker.absorb_remote(&owner.file().data.clone(), BTreeMap::new(), Vec::new());
        asker.request_remote_pause(&t).unwrap();
        let at = asker.file().data.pause_requests.values().next().unwrap().at;
        let by = asker.file().device_id.clone();
        clock.advance(600);
        let seen = BTreeMap::from([(
            by,
            crate::model::RemoteDevice {
                name: "Office PC".into(),
                last_heartbeat: None,
                written_at: clock.now(),
            },
        )]);
        assert!(owner.absorb_remote(&asker.file().data.clone(), seen.clone(), Vec::new()));
        let name = owner.file().data.tasks[&t].name.clone();
        let notices = owner.snapshot().notices;
        assert_eq!(notices.len(), 1, "{notices:?}");
        let text = &notices[0].message;
        assert!(text.contains(&format!("\"{name}\"")), "{text}");
        assert!(text.contains("Office PC"), "{text}");
        assert!(text.contains(&at.iso()[11..16]), "{text}");
        assert_eq!(notices[0].level, "warning");
        // One system notification too, for when the window is hidden, and only one.
        assert_eq!(owner.take_pause_alerts(), std::slice::from_ref(text));
        assert!(owner.take_pause_alerts().is_empty());

        // The next cycles bring the same request again: it has done its work.
        clock.advance(600);
        owner.absorb_remote(&asker.file().data.clone(), seen.clone(), Vec::new());
        assert_eq!(owner.snapshot().notices.len(), 1);
        assert!(owner.take_pause_alerts().is_empty());
        let id = owner.snapshot().notices[0].id.clone();
        owner.dismiss_notice(&id);
        owner.absorb_remote(&asker.file().data.clone(), seen, Vec::new());
        assert!(
            owner.snapshot().notices.is_empty(),
            "dismissed stays dismissed"
        );
    }

    #[test]
    fn the_pause_notice_gives_the_time_in_the_zone_being_viewed() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut owner, t) = running(dir_a.path(), &clock);
        owner.set_system_zone("UTC".into());
        owner
            .set_setting("myZone", serde_json::json!("Asia/Tokyo"))
            .unwrap();
        let mut asker = open(dir_b.path(), &clock);
        asker.absorb_remote(&owner.file().data.clone(), BTreeMap::new(), Vec::new());
        asker.request_remote_pause(&t).unwrap();
        let at = asker.file().data.pause_requests.values().next().unwrap().at;
        owner.absorb_remote(&asker.file().data.clone(), BTreeMap::new(), Vec::new());
        let expected = chrono::DateTime::from_timestamp(at.secs(), 0)
            .unwrap()
            .with_timezone(&chrono_tz::Asia::Tokyo)
            .format("%Y-%m-%d %H:%M")
            .to_string();
        let notices = owner.snapshot().notices;
        assert!(notices[0].message.contains(&expected), "{notices:?}");
    }

    #[test]
    fn a_requesting_device_with_no_known_name_is_still_mentioned() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut owner, t) = running(dir_a.path(), &clock);
        let mut asker = open(dir_b.path(), &clock);
        clock.advance(600);
        asker.absorb_remote(&owner.file().data.clone(), BTreeMap::new(), Vec::new());
        asker.request_remote_pause(&t).unwrap();
        owner.absorb_remote(&asker.file().data.clone(), BTreeMap::new(), Vec::new());
        let notices = owner.snapshot().notices;
        assert!(notices[0].message.contains("another device"), "{notices:?}");
    }

    #[test]
    fn a_pause_request_reaches_the_owner_who_closes_its_own_segment() {
        let dir_a = tempfile::tempdir().unwrap();
        let dir_b = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut owner, t) = running(dir_a.path(), &clock);
        let mut asker = open(dir_b.path(), &clock);
        clock.advance(600);
        asker.absorb_remote(&owner.file().data.clone(), BTreeMap::new(), Vec::new());
        let seg_before = asker.file().data.segments.values().next().unwrap().clone();
        let id = asker.request_remote_pause(&t).unwrap();
        assert_eq!(
            asker.request_remote_pause(&t).unwrap(),
            id,
            "asking twice is one request"
        );
        assert_eq!(
            asker.file().data.segments.values().next().unwrap(),
            &seg_before,
            "the asker never rewrites the owner's segment"
        );
        assert!(
            asker
                .file()
                .data
                .audit_log
                .values()
                .any(|a| a.action == "requestPause")
        );
        let at = asker.file().data.pause_requests[&id].at;
        clock.advance(600);
        owner.absorb_remote(&asker.file().data.clone(), BTreeMap::new(), Vec::new());
        let task = &owner.file().data.tasks[&t];
        assert_eq!(task.state, TaskState::Paused);
        assert_eq!(task.pause_reason, Some(PauseReason::RemoteRequest));
        assert_eq!(
            owner.file().data.segments.values().next().unwrap().end,
            Some(at)
        );
        assert!(
            owner
                .file()
                .data
                .audit_log
                .values()
                .any(|a| a.action == "pausedByRequest")
        );
        // A request can't be made for a task running here.
        owner.resume_task(&t).unwrap();
        assert!(matches!(
            owner.request_remote_pause(&t),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn one_shift_version_can_be_reverted_and_the_last_one_cannot() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let mut s = open(dir.path(), &clock);
        let input = |from: &str, id: Option<String>| ShiftInput {
            shift_id: id,
            name: "Day".into(),
            color: "#336699".into(),
            start: "09:00".into(),
            end: "17:00".into(),
            weekdays: vec![1],
            zone: "UTC".into(),
            break_minutes: 0,
            effective_from: from.into(),
            retired: false,
        };
        let id = s.save_shift(&input("2026-01-01", None)).unwrap();
        s.save_shift(&input("2026-02-01", Some(id.clone())))
            .unwrap();
        let later = s
            .file()
            .data
            .shifts
            .values()
            .find(|v| v.effective_from == "2026-02-01")
            .unwrap()
            .id
            .clone();
        s.revert_shift_version(&later).unwrap();
        assert!(s.file().data.shifts[&later].deleted);
        let first = s
            .file()
            .data
            .shifts
            .values()
            .find(|v| v.effective_from == "2026-01-01")
            .unwrap()
            .id
            .clone();
        assert!(matches!(
            s.revert_shift_version(&first),
            Err(CoreError::Conflict(_))
        ));
        assert!(matches!(
            s.revert_shift_version(&later),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn billable_pause_audit_entries_name_the_task() {
        let dir = tempfile::tempdir().unwrap();
        let clock = ManualClock::at(T0);
        let (mut s, t) = running(dir.path(), &clock);
        clock.advance(7200);
        let id = s
            .mark_billable_pause(&crate::adjust::PauseInput {
                task_id: t.clone(),
                start: Ts::parse(T0).unwrap(),
                end: Ts::parse("2026-03-01T09:30:00Z").unwrap(),
                note: String::new(),
            })
            .unwrap();
        s.unmark_billable_pause(&id).unwrap();
        let entries = s.audit_entries(Some(&id));
        assert_eq!(entries.len(), 2);
        for e in entries {
            let named = [&e.before, &e.after]
                .iter()
                .any(|v| v["taskId"] == t.as_str());
            assert!(named, "{e:?}");
        }
    }
}
