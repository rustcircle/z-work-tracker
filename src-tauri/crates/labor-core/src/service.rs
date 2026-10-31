//! The application service: owns the store, applies each change transactionally and builds the view.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use crate::detect::Detected;
use crate::error::CoreError;
use crate::machine::{
    COLD_REQUIRED, Ctx, ProjectInput, RateInput, RequiredField, RoundingInput, ShiftInput,
    TaskInput, Transition, doc_has_text,
};
use crate::merge::merge;
use crate::model::{
    DeviceFile, LocalFile, PauseReason, RemoteDevice, SCHEMA_VERSION, Shared, SyncTarget, Task,
    TaskState, Theme,
};
use crate::persist::{self, Paths};
use crate::report::ExportSource;
use crate::sync::{APP_FOLDER, HungTargets, TargetStatus};
use crate::time::{Clock, Ts};
use crate::view::{
    CopySource, LaunchView, Notice, PrefsView, ProjectView, SegmentView, Snapshot, SyncView,
    TargetView, TaskView,
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
}

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
        };
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
        if self.file.data.own_open_segments(&device).is_empty() {
            return Ok(());
        }
        let now = self.now();
        let ctx = Ctx {
            now,
            device: &device,
        };
        // The last heartbeat is the last moment the app is known to have been alive.
        let at = self.file.last_heartbeat.unwrap_or(Ts(i64::MIN / 2));
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
        for field in COLD_REQUIRED {
            let missing = match field {
                RequiredField::Name => task.name.trim().is_empty(),
                RequiredField::Project => task.project_id.is_empty(),
                RequiredField::Description => !doc_has_text(&task.description),
            };
            if missing {
                let label = match field {
                    RequiredField::Name => "Task name",
                    RequiredField::Project => "Project",
                    RequiredField::Description => "Description",
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
        let out = self.mutate(|f, c| {
            let out = f.data.resume(c, id)?;
            Ok(Self::with_beat(f, c, out))
        })?;
        self.last_worked = Some(id.to_owned());
        Ok(out)
    }

    pub fn pause_task(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| {
            f.data
                .pause(c, id)
                .map_err(|e| name_device(e, f.remote_devices.clone()))
        })?;
        self.last_worked = Some(id.to_owned());
        Ok(())
    }

    pub fn stop_task(&mut self, id: &str) -> Result<(), CoreError> {
        self.mutate(|f, c| f.data.stop(c, id))?;
        self.last_worked = Some(id.to_owned());
        Ok(())
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
            description: task.description.clone(),
            last_worked_at: data
                .segments
                .values()
                .filter(|s| s.task_id == task.id)
                .map(|s| s.end.unwrap_or(s.start))
                .max(),
        })
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
        // This device's own file can hold what a restored store lost. An open segment that comes
        // back this way belongs to a past run, so it closes at that file's last heartbeat.
        for mut own in own_files {
            for seg in own.data.segments.values_mut() {
                let open_here = seg.end.is_none() && seg.device_id == self.file.device_id;
                if open_here && !self.file.data.segments.contains_key(&seg.id) {
                    seg.end = Some(own.last_heartbeat.unwrap_or(seg.start).max(seg.start));
                }
            }
            merged = merge(&merged, &own.data);
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

        let source = self.export_source();
        let segments = data
            .segments
            .values()
            .filter(|s| data.tasks.get(&s.task_id).is_some_and(Task::is_live))
            .map(|s| SegmentView {
                id: s.id.clone(),
                task_id: s.task_id.clone(),
                device_id: s.device_id.clone(),
                start: s.start,
                end: s.end,
                provisional_end: (s.end.is_none() && s.device_id != own).then(|| source.end_of(s)),
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
            },
            launch: LaunchView {
                warm: self.warm,
                cold_required: COLD_REQUIRED,
                copy_source: if self.warm { self.copy_source() } else { None },
            },
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
        }
    }
    fn tinput(name: &str, p: &str) -> TaskInput {
        TaskInput {
            name: name.into(),
            project_id: p.into(),
            description: doc("Details"),
            continued_from: None,
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
        assert_eq!(s.snapshot().launch.cold_required, COLD_REQUIRED);
        let p = s.create_project(&pinput("P")).unwrap();
        let blank = TaskInput {
            name: "T".into(),
            project_id: p.clone(),
            description: Value::Null,
            continued_from: None,
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
}
