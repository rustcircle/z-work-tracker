//! Project and task operations on the replicated state, including the task state machine:
//! draft -> running <-> paused -> stopped. All timestamps come from `Ctx`, never from the UI.

use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::CoreError;
use crate::model::{
    BillingType, PauseReason, PauseRequest, Project, RateVersion, RoundMethod, RoundingVersion,
    Segment, SettingEntry, Shared, ShiftVersion, Stamp, Task, TaskState,
};
use crate::subtasks;
use crate::time::Ts;
use crate::validate::{
    MAX_NAME, MAX_PROJECT_NAME, check_date, check_description, check_hhmm, check_rate,
    check_rounding, check_shift, clean_color, clean_non_negative, clean_text, is_currency,
    parse_zone,
};

/// The moment and the device an operation happens on.
#[derive(Clone, Copy, Debug)]
pub struct Ctx<'a> {
    pub now: Ts,
    pub device: &'a str,
}

impl Ctx<'_> {
    #[must_use]
    pub fn stamp(&self) -> Stamp {
        Stamp {
            at: self.now,
            by: self.device.to_owned(),
        }
    }
    /// A new edit must beat the version it is based on, even when the clock went backwards.
    #[must_use]
    pub fn next(&self, prev: &Stamp) -> Stamp {
        Stamp {
            at: self.now.max(prev.at.later(1)),
            by: self.device.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub name: String,
    pub color: String,
    #[serde(default = "yes")]
    pub billable: bool,
    #[serde(default)]
    pub budget_hours: Option<f64>,
    #[serde(default)]
    pub client_zone: Option<String>,
    #[serde(default)]
    pub billing_type: BillingType,
    #[serde(default)]
    pub fixed_fee_cents: Option<i64>,
    #[serde(default)]
    pub fee_currency: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateInput {
    pub project_id: String,
    /// `None` is "no rate", different from `Some(0)`.
    #[serde(default)]
    pub rate_cents: Option<i64>,
    pub currency: String,
    /// `None` applies from now. An earlier moment needs `confirm_retroactive`.
    #[serde(default)]
    pub effective_from: Option<String>,
    #[serde(default)]
    pub confirm_retroactive: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundingInput {
    #[serde(default)]
    pub project_id: Option<String>,
    pub effective_from: String,
    pub increment_minutes: u32,
    pub method: RoundMethod,
    #[serde(default)]
    pub confirm_retroactive: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub name: String,
    pub project_id: String,
    #[serde(default)]
    pub description: Value,
    /// Only read when creating a task: the task this one continues.
    #[serde(default)]
    pub continued_from: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// An edit to some fields of a task. A field left out keeps whatever the store holds now, so an
/// autosave never reverts what another device has just changed.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// `null` from the page clears the description; leaving the key out keeps it.
    #[serde(default, deserialize_with = "present_value")]
    pub description: Option<Value>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// Fields that must be filled before the first start of a launch. Add tags here when they exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RequiredField {
    Name,
    Project,
    Description,
    Tags,
}

pub const COLD_REQUIRED: &[RequiredField] = &[
    RequiredField::Name,
    RequiredField::Project,
    RequiredField::Description,
];

/// True when a rich-text document holds real text, not just empty markup.
#[must_use]
pub fn doc_has_text(doc: &Value) -> bool {
    if doc.get("type").and_then(Value::as_str) == Some("text") {
        return doc
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty());
    }
    doc.get("content")
        .and_then(Value::as_array)
        .is_some_and(|c| c.iter().any(doc_has_text))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftInput {
    /// Absent for a new shift.
    #[serde(default)]
    pub shift_id: Option<String>,
    pub effective_from: String,
    pub name: String,
    pub color: String,
    pub start: String,
    pub end: String,
    pub weekdays: Vec<u8>,
    pub zone: String,
    #[serde(default)]
    pub break_minutes: u32,
    #[serde(default)]
    pub retired: bool,
}

/// What a start or resume did to another task, so the UI can show it clearly.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub auto_paused_task_id: Option<String>,
    pub auto_paused_task_name: Option<String>,
}

/// Two devices can add a version for the same date offline. The newest edit is the one in force.
#[must_use]
pub fn stamp_order(sa: &Stamp, ia: &str, sb: &Stamp, ib: &str) -> std::cmp::Ordering {
    sa.at
        .cmp(&sb.at)
        .then_with(|| sa.by.cmp(&sb.by))
        .then_with(|| ia.cmp(ib))
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

impl Shared {
    pub(crate) fn live_project(&self, id: &str) -> Result<&Project, CoreError> {
        self.projects
            .get(id)
            .filter(|p| !p.deleted)
            .ok_or(CoreError::NotFound("project"))
    }

    pub(crate) fn live_task(&self, id: &str) -> Result<&Task, CoreError> {
        self.tasks
            .get(id)
            .filter(|t| t.is_live())
            .ok_or(CoreError::NotFound("task"))
    }

    fn check_project_name(&self, name: &str, except: Option<&str>) -> Result<(), CoreError> {
        let folded = name.to_lowercase();
        let clash = self.projects.values().any(|p| {
            !p.deleted && Some(p.id.as_str()) != except && p.name.to_lowercase() == folded
        });
        if clash {
            return Err(CoreError::Conflict(format!(
                "a project named \"{name}\" already exists"
            )));
        }
        Ok(())
    }

    fn clean_project(
        &self,
        input: &ProjectInput,
        except: Option<&str>,
    ) -> Result<ProjectInput, CoreError> {
        let name = clean_text(&input.name, "Project name", MAX_PROJECT_NAME)?;
        self.check_project_name(&name, except)?;
        let client_zone = input.client_zone.as_deref().filter(|z| !z.is_empty());
        if let Some(z) = client_zone {
            parse_zone(z)?;
        }
        Ok(ProjectInput {
            name,
            color: clean_color(&input.color)?,
            billable: input.billable,
            budget_hours: input
                .budget_hours
                .map(|b| clean_non_negative(b, "Budget"))
                .transpose()?,
            client_zone: client_zone.map(str::to_owned),
            billing_type: input.billing_type,
            fixed_fee_cents: self.clean_fee(input)?,
            fee_currency: input
                .fee_currency
                .clone()
                .filter(|_| input.billing_type == BillingType::FixedFee),
        })
    }

    fn clean_fee(&self, input: &ProjectInput) -> Result<Option<i64>, CoreError> {
        if input.billing_type != BillingType::FixedFee {
            return Ok(None);
        }
        let Some(fee) = input.fixed_fee_cents else {
            return Err(CoreError::Validation("enter the fixed fee".into()));
        };
        if !(0..=1_000_000_000_000).contains(&fee) {
            return Err(CoreError::Validation("that fee is out of range".into()));
        }
        if !input.fee_currency.as_deref().is_some_and(is_currency) {
            return Err(CoreError::Validation(
                "the fee's currency must be EUR or USD".into(),
            ));
        }
        Ok(Some(fee))
    }

    pub fn create_project(
        &mut self,
        ctx: &Ctx<'_>,
        input: &ProjectInput,
    ) -> Result<String, CoreError> {
        let clean = self.clean_project(input, None)?;
        let id = new_id();
        self.projects.insert(
            id.clone(),
            Project {
                id: id.clone(),
                name: clean.name,
                color: clean.color,
                archived: false,
                deleted: false,
                billable: clean.billable,
                budget_hours: clean.budget_hours,
                client_zone: clean.client_zone,
                billing_type: clean.billing_type,
                fixed_fee_cents: clean.fixed_fee_cents,
                fee_currency: clean.fee_currency,
                created_at: ctx.now,
                stamp: ctx.stamp(),
            },
        );
        Ok(id)
    }

    pub fn update_project(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        input: &ProjectInput,
    ) -> Result<(), CoreError> {
        self.live_project(id)?;
        let clean = self.clean_project(input, Some(id))?;
        let p = self
            .projects
            .get_mut(id)
            .ok_or(CoreError::NotFound("project"))?;
        p.name = clean.name;
        p.color = clean.color;
        p.billable = clean.billable;
        p.budget_hours = clean.budget_hours;
        p.client_zone = clean.client_zone;
        p.billing_type = clean.billing_type;
        p.fixed_fee_cents = clean.fixed_fee_cents;
        p.fee_currency = clean.fee_currency;
        p.stamp = ctx.next(&p.stamp);
        Ok(())
    }

    #[must_use]
    pub fn project_has_tasks(&self, id: &str) -> bool {
        self.tasks
            .values()
            .any(|t| t.is_live() && t.project_id == id)
    }

    pub fn set_project_archived(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        archived: bool,
    ) -> Result<(), CoreError> {
        self.live_project(id)?;
        if archived {
            let running = self
                .tasks
                .values()
                .any(|t| t.is_live() && t.project_id == id && t.state == TaskState::Running);
            if running {
                return Err(CoreError::Conflict(
                    "pause or stop this project's running task before archiving it".into(),
                ));
            }
        }
        let p = self
            .projects
            .get_mut(id)
            .ok_or(CoreError::NotFound("project"))?;
        p.archived = archived;
        p.stamp = ctx.next(&p.stamp);
        Ok(())
    }

    /// Only a project without tasks can be deleted. The tombstone stops it coming back through sync.
    pub fn delete_project(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        self.live_project(id)?;
        if self.project_has_tasks(id) {
            return Err(CoreError::Conflict(
                "a project with tasks can only be archived".into(),
            ));
        }
        let p = self
            .projects
            .get_mut(id)
            .ok_or(CoreError::NotFound("project"))?;
        p.deleted = true;
        p.stamp = ctx.next(&p.stamp);
        Ok(())
    }

    fn clean_task(
        &self,
        input: &TaskInput,
        previous_project: Option<&str>,
    ) -> Result<(String, String), CoreError> {
        let name = clean_text(&input.name, "Task name", MAX_NAME)?;
        if input.project_id.trim().is_empty() {
            return Err(CoreError::Validation("Project is required".into()));
        }
        let project = self.live_project(&input.project_id)?;
        if project.archived && previous_project != Some(project.id.as_str()) {
            return Err(CoreError::Validation(
                "this project is archived; restore it first".into(),
            ));
        }
        check_description(&input.description)?;
        Ok((name, project.id.clone()))
    }

    pub fn create_task(&mut self, ctx: &Ctx<'_>, input: &TaskInput) -> Result<String, CoreError> {
        let (name, project_id) = self.clean_task(input, None)?;
        self.check_tag_ids(&input.tags)?;
        if let Some(source) = &input.continued_from {
            self.live_task(source)?;
        }
        let id = new_id();
        self.tasks.insert(
            id.clone(),
            Task {
                id: id.clone(),
                name,
                name_stamp: ctx.stamp(),
                project_id,
                project_stamp: ctx.stamp(),
                description: subtasks::assign_ids(&input.description, None),
                description_stamp: ctx.stamp(),
                deleted: false,
                deleted_stamp: ctx.stamp(),
                continued_from: input.continued_from.clone(),
                created_at: ctx.now,
                state: TaskState::Draft,
                pause_reason: None,
                state_stamp: ctx.stamp(),
                stopped_at: None,
                tags: input.tags.clone(),
                tags_stamp: ctx.stamp(),
                active_subtask: None,
                active_subtask_stamp: ctx.stamp(),
            },
        );
        Ok(id)
    }

    /// Name, project and description stay editable in every state, including stopped.
    pub fn update_task(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        input: &TaskInput,
    ) -> Result<(), CoreError> {
        let previous = self.live_task(id)?.project_id.clone();
        let (name, project_id) = self.clean_task(input, Some(&previous))?;
        self.check_tag_ids(&input.tags)?;
        let t = self.tasks.get_mut(id).ok_or(CoreError::NotFound("task"))?;
        // Each field has its own clock, so edits to different fields on two devices both survive.
        if t.name != name {
            t.name = name;
            t.name_stamp = ctx.next(&t.name_stamp);
        }
        if t.project_id != project_id {
            t.project_id = project_id;
            t.project_stamp = ctx.next(&t.project_stamp);
        }
        let description = subtasks::assign_ids(&input.description, Some(&t.description));
        if t.description != description {
            t.description = description;
            t.description_stamp = ctx.next(&t.description_stamp);
            clear_missing_active(t, ctx);
        }
        if !input.tags.is_empty() && t.tags != input.tags {
            t.tags = input.tags.clone();
            t.tags_stamp = ctx.next(&t.tags_stamp);
        }
        Ok(())
    }

    /// Edits only the given fields, in any state. Never touches segments or the task's state.
    pub fn patch_task(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        patch: &TaskPatch,
    ) -> Result<(), CoreError> {
        let previous = self.live_task(id)?.project_id.clone();
        let name = patch
            .name
            .as_deref()
            .map(|n| clean_text(n, "Task name", MAX_NAME))
            .transpose()?;
        let project_id = match patch.project_id.as_deref() {
            Some(p) if p != previous => {
                let project = self.live_project(p)?;
                if project.archived {
                    return Err(CoreError::Validation(
                        "this project is archived; restore it first".into(),
                    ));
                }
                Some(project.id.clone())
            }
            _ => None,
        };
        if let Some(d) = &patch.description {
            check_description(d)?;
        }
        if let Some(tags) = &patch.tags {
            self.check_tag_ids(tags)?;
        }
        let t = self.tasks.get_mut(id).ok_or(CoreError::NotFound("task"))?;
        if let Some(name) = name
            && t.name != name
        {
            t.name = name;
            t.name_stamp = ctx.next(&t.name_stamp);
        }
        if let Some(project_id) = project_id {
            t.project_id = project_id;
            t.project_stamp = ctx.next(&t.project_stamp);
        }
        if let Some(d) = &patch.description {
            let d = subtasks::assign_ids(d, Some(&t.description));
            if t.description != d {
                t.description = d;
                t.description_stamp = ctx.next(&t.description_stamp);
                clear_missing_active(t, ctx);
            }
        }
        if let Some(tags) = &patch.tags
            && t.tags != *tags
        {
            t.tags.clone_from(tags);
            t.tags_stamp = ctx.next(&t.tags_stamp);
        }
        Ok(())
    }

    pub fn delete_draft(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        let t = self.live_task(id)?;
        if t.state != TaskState::Draft {
            return Err(CoreError::Conflict("only a draft can be deleted".into()));
        }
        if self.segments.values().any(|s| s.task_id == id) {
            return Err(CoreError::Conflict(
                "this draft has time entered by hand; void that time first".into(),
            ));
        }
        let t = self.tasks.get_mut(id).ok_or(CoreError::NotFound("task"))?;
        t.deleted = true;
        t.deleted_stamp = ctx.next(&t.deleted_stamp);
        Ok(())
    }

    /// The open segments owned by this device.
    #[must_use]
    pub fn own_open_segments(&self, device: &str) -> Vec<String> {
        self.segments
            .values()
            .filter(|s| s.end.is_none() && s.device_id == device)
            .map(|s| s.id.clone())
            .collect()
    }

    pub(crate) fn close_segment(&mut self, id: &str, at: Ts) {
        if let Some(seg) = self.segments.get_mut(id) {
            // A clock that went backwards yields a zero-length segment, never a negative one.
            seg.end = Some(at.max(seg.start));
        }
    }

    fn set_state(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        state: TaskState,
        reason: Option<PauseReason>,
    ) {
        if let Some(t) = self.tasks.get_mut(id) {
            t.state = state;
            t.pause_reason = reason;
            t.state_stamp = ctx.next(&t.state_stamp);
        }
    }

    fn pause_local_running(&mut self, ctx: &Ctx<'_>, by_task: &str) -> Transition {
        let mut outcome = Transition::default();
        for seg_id in self.own_open_segments(ctx.device) {
            let Some(task_id) = self.segments.get(&seg_id).map(|s| s.task_id.clone()) else {
                continue;
            };
            self.close_segment(&seg_id, ctx.now);
            if task_id != by_task {
                self.set_state(
                    ctx,
                    &task_id,
                    TaskState::Paused,
                    Some(PauseReason::AutoPaused {
                        by_task_id: by_task.to_owned(),
                    }),
                );
                outcome.auto_paused_task_name = self.tasks.get(&task_id).map(|t| t.name.clone());
                outcome.auto_paused_task_id = Some(task_id);
            }
        }
        outcome
    }

    pub(crate) fn open_segment(&mut self, ctx: &Ctx<'_>, task_id: &str) {
        let last_end = self
            .segments
            .values()
            .filter(|s| s.task_id == task_id && s.device_id == ctx.device)
            .filter_map(|s| s.end)
            .max(); // own device only: another's clock may run ahead
        let start = last_end.map_or(ctx.now, |e| e.max(ctx.now));
        let subtask_id = self.tasks.get(task_id).and_then(|t| {
            // Merged state can hold an active id whose item is gone.
            t.active_subtask
                .clone()
                .filter(|a| subtasks::items(&t.description).iter().any(|i| i.id == *a))
        });
        let id = new_id();
        self.segments.insert(
            id.clone(),
            Segment {
                id,
                task_id: task_id.to_owned(),
                device_id: ctx.device.to_owned(),
                start,
                end: None,
                subtask_id,
                edit_stamp: ctx.stamp(),
                ..Segment::default()
            },
        );
    }

    fn check_startable(&self, t: &Task) -> Result<(), CoreError> {
        if t.name.trim().is_empty() {
            return Err(CoreError::Validation("Task name is required".into()));
        }
        let project = self
            .projects
            .get(&t.project_id)
            .filter(|p| !p.deleted)
            .ok_or_else(|| CoreError::Validation("Project is required".into()))?;
        if project.archived {
            return Err(CoreError::Validation(format!(
                "project \"{}\" is archived; restore it first",
                project.name
            )));
        }
        Ok(())
    }

    fn begin(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        required: TaskState,
        action: &'static str,
    ) -> Result<Transition, CoreError> {
        let task = self.live_task(id)?;
        if task.state != required {
            return Err(CoreError::IllegalTransition {
                action,
                state: task.state.label(),
            });
        }
        self.check_startable(task)?;
        let outcome = self.pause_local_running(ctx, id);
        self.open_segment(ctx, id);
        self.set_state(ctx, id, TaskState::Running, None);
        Ok(outcome)
    }

    pub fn start(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<Transition, CoreError> {
        self.begin(ctx, id, TaskState::Draft, "start")
    }

    pub fn resume(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<Transition, CoreError> {
        self.begin(ctx, id, TaskState::Paused, "resume")
    }

    fn own_open_for(&self, task_id: &str, device: &str) -> Vec<String> {
        self.segments
            .values()
            .filter(|s| s.task_id == task_id && s.device_id == device && s.end.is_none())
            .map(|s| s.id.clone())
            .collect()
    }

    pub fn pause(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        let task = self.live_task(id)?;
        if task.state != TaskState::Running {
            return Err(CoreError::IllegalTransition {
                action: "pause",
                state: task.state.label(),
            });
        }
        let own = self.own_open_for(id, ctx.device);
        if own.is_empty() {
            let other = self
                .segments
                .values()
                .find(|s| s.task_id == id && s.end.is_none())
                .map(|s| s.device_id.clone());
            if let Some(device) = other {
                return Err(CoreError::RunningElsewhere(device));
            }
        }
        for seg in own {
            self.close_segment(&seg, ctx.now);
        }
        self.set_state(ctx, id, TaskState::Paused, Some(PauseReason::User));
        Ok(())
    }

    /// Allowed from running and paused. A segment open on another device is left to that device.
    pub fn stop(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        let task = self.live_task(id)?;
        if !matches!(task.state, TaskState::Running | TaskState::Paused) {
            return Err(CoreError::IllegalTransition {
                action: "stop",
                state: task.state.label(),
            });
        }
        for seg in self.own_open_for(id, ctx.device) {
            self.close_segment(&seg, ctx.now);
        }
        let last_end = self
            .segments
            .values()
            .filter(|s| s.task_id == id)
            .filter_map(|s| s.end)
            .max();
        let stopped_at = last_end.map_or(ctx.now, |e| e.max(ctx.now));
        self.set_state(ctx, id, TaskState::Stopped, None);
        if let Some(t) = self.tasks.get_mut(id) {
            t.stopped_at = Some(stopped_at);
        }
        Ok(())
    }

    /// Closes every open segment of this device at `at` and pauses their tasks. Returns task names.
    pub fn close_own_open(&mut self, ctx: &Ctx<'_>, at: Ts, reason: &PauseReason) -> Vec<String> {
        let mut names = Vec::new();
        for seg_id in self.own_open_segments(ctx.device) {
            let Some(task_id) = self.segments.get(&seg_id).map(|s| s.task_id.clone()) else {
                continue;
            };
            self.close_segment(&seg_id, at);
            let still_open = self
                .segments
                .values()
                .any(|s| s.task_id == task_id && s.end.is_none());
            let is_running = self
                .tasks
                .get(&task_id)
                .is_some_and(|t| t.state == TaskState::Running);
            if is_running && !still_open {
                self.set_state(ctx, &task_id, TaskState::Paused, Some(reason.clone()));
            }
            if let Some(t) = self.tasks.get(&task_id) {
                names.push(t.name.clone());
            }
        }
        names
    }

    /// Restores local invariants after a merge. Only this device's own segments are ever altered.
    /// Returns true when something changed.
    pub fn reconcile(&mut self, ctx: &Ctx<'_>) -> bool {
        let mut changed = false;
        // A pause asked for from another device: this device closes its own segment, at the moment
        // of the request or at once if that has passed the segment's own start.
        // Several devices may have asked: the earliest stands, which is also what `end_of` counts.
        let mut asked = std::collections::BTreeMap::<String, (String, Ts)>::new();
        for q in self.pause_requests.values().filter(|q| {
            self.segments
                .get(&q.segment_id)
                .is_some_and(|s| s.end.is_none() && s.device_id == ctx.device)
        }) {
            asked
                .entry(q.segment_id.clone())
                .and_modify(|(_, at)| *at = (*at).min(q.at))
                .or_insert((q.task_id.clone(), q.at));
        }
        for (seg_id, (task_id, at)) in asked {
            self.close_segment(&seg_id, at.min(ctx.now));
            self.set_state(
                ctx,
                &task_id,
                TaskState::Paused,
                Some(PauseReason::RemoteRequest),
            );
            self.audit(
                ctx,
                "task",
                &task_id,
                "pausedByRequest",
                "",
                serde_json::Value::Null,
                serde_json::json!({"segmentId": seg_id, "at": at}),
            );
            changed = true;
        }
        for seg_id in self.own_open_segments(ctx.device) {
            let Some(task_id) = self.segments.get(&seg_id).map(|s| s.task_id.clone()) else {
                continue;
            };
            let keep = self
                .tasks
                .get(&task_id)
                .is_some_and(|t| t.is_live() && t.state == TaskState::Running);
            if !keep {
                self.close_segment(&seg_id, ctx.now);
                changed = true;
            }
        }
        let orphaned: Vec<String> = self
            .tasks
            .values()
            .filter(|t| t.state == TaskState::Running)
            .filter(|t| {
                !self
                    .segments
                    .values()
                    .any(|s| s.task_id == t.id && s.end.is_none())
            })
            .map(|t| t.id.clone())
            .collect();
        for id in orphaned {
            self.set_state(
                ctx,
                &id,
                TaskState::Paused,
                Some(PauseReason::SyncReconciled),
            );
            changed = true;
        }
        changed
    }

    /// Saves a shift version. Re-saving the same `effective_from` edits that version, while a later
    /// date adds a new one, so analysis of earlier dates keeps using the earlier version.
    pub fn save_shift(&mut self, ctx: &Ctx<'_>, input: &ShiftInput) -> Result<String, CoreError> {
        let shift_id = input
            .shift_id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(new_id);
        let existing = self
            .shifts
            .values()
            .filter(|v| {
                !v.deleted && v.shift_id == shift_id && v.effective_from == input.effective_from
            })
            .max_by(|a, b| stamp_order(&a.stamp, &a.id, &b.stamp, &b.id))
            .cloned();
        let id = existing.as_ref().map_or_else(new_id, |v| v.id.clone());
        let stamp = existing
            .as_ref()
            .map_or_else(|| ctx.stamp(), |v| ctx.next(&v.stamp));
        let mut weekdays = input.weekdays.clone();
        weekdays.sort_unstable();
        weekdays.dedup();
        let version = ShiftVersion {
            id: id.clone(),
            shift_id: shift_id.clone(),
            effective_from: input.effective_from.clone(),
            name: input.name.trim().to_owned(),
            color: input.color.to_ascii_lowercase(),
            start: input.start.clone(),
            end: input.end.clone(),
            weekdays,
            zone: input.zone.clone(),
            break_minutes: input.break_minutes,
            retired: input.retired,
            deleted: false,
            stamp,
        };
        check_shift(&version)?;
        self.shifts.insert(id, version);
        Ok(shift_id)
    }

    /// Removes one version, so the version before it applies again. A shift keeps at least one.
    pub fn revert_shift_version(
        &mut self,
        ctx: &Ctx<'_>,
        version_id: &str,
    ) -> Result<(), CoreError> {
        let shift_id = self
            .shifts
            .get(version_id)
            .filter(|v| !v.deleted)
            .ok_or(CoreError::NotFound("shift version"))?
            .shift_id
            .clone();
        let live = self
            .shifts
            .values()
            .filter(|v| v.shift_id == shift_id && !v.deleted)
            .count();
        if live < 2 {
            return Err(CoreError::Conflict(
                "this is the shift's only version; delete the shift instead".into(),
            ));
        }
        if let Some(v) = self.shifts.get_mut(version_id) {
            v.deleted = true;
            v.stamp = ctx.next(&v.stamp);
        }
        Ok(())
    }

    /// Asks the device that owns a running task's open segment to pause it. Nothing of that device's
    /// is changed here: it closes its own segment when the request reaches it.
    pub fn request_remote_pause(
        &mut self,
        ctx: &Ctx<'_>,
        task_id: &str,
    ) -> Result<String, CoreError> {
        self.live_task(task_id)?;
        let segment_id = self
            .segments
            .values()
            .find(|s| s.task_id == task_id && s.end.is_none() && s.device_id != ctx.device)
            .map(|s| s.id.clone())
            .ok_or_else(|| {
                CoreError::Conflict("this task isn't running on another device".into())
            })?;
        if let Some(open) = self
            .pause_requests
            .values()
            .find(|q| q.segment_id == segment_id)
        {
            return Ok(open.id.clone());
        }
        let id = new_id();
        self.pause_requests.insert(
            id.clone(),
            PauseRequest {
                id: id.clone(),
                task_id: task_id.to_owned(),
                segment_id: segment_id.clone(),
                requested_by: ctx.device.to_owned(),
                at: ctx.now,
                stamp: ctx.stamp(),
            },
        );
        self.audit(
            ctx,
            "task",
            task_id,
            "requestPause",
            "",
            Value::Null,
            serde_json::json!({"segmentId": segment_id, "at": ctx.now}),
        );
        Ok(id)
    }

    /// Removes every version of a shift (a tombstone on each, so sync does not resurrect them).
    pub fn delete_shift(&mut self, ctx: &Ctx<'_>, shift_id: &str) -> Result<(), CoreError> {
        let mut found = false;
        for v in self
            .shifts
            .values_mut()
            .filter(|v| v.shift_id == shift_id && !v.deleted)
        {
            v.deleted = true;
            v.stamp = ctx.next(&v.stamp);
            found = true;
        }
        if found {
            Ok(())
        } else {
            Err(CoreError::NotFound("shift"))
        }
    }

    /// Adds a rate version. Never rewrites earlier earnings unless the user confirmed a backdated change.
    pub fn set_rate(&mut self, ctx: &Ctx<'_>, input: &RateInput) -> Result<(), CoreError> {
        self.live_project(&input.project_id)?;
        let from = match &input.effective_from {
            None => ctx.now,
            Some(raw) => Ts::parse(raw)
                .ok_or_else(|| CoreError::Validation("invalid effective date".into()))?,
        };
        if from < ctx.now && !input.confirm_retroactive {
            return Err(CoreError::Conflict(
                "a backdated price changes past earnings and needs confirmation".into(),
            ));
        }
        let existing = self
            .rates
            .values()
            .filter(|r| !r.deleted && r.project_id == input.project_id && r.effective_from == from)
            .max_by(|a, b| stamp_order(&a.stamp, &a.id, &b.stamp, &b.id))
            .cloned();
        let id = existing.as_ref().map_or_else(new_id, |r| r.id.clone());
        let stamp = existing
            .as_ref()
            .map_or_else(|| ctx.stamp(), |r| ctx.next(&r.stamp));
        let version = RateVersion {
            id: id.clone(),
            project_id: input.project_id.clone(),
            effective_from: from,
            rate_cents: input.rate_cents,
            currency: input.currency.clone(),
            deleted: false,
            stamp,
        };
        check_rate(&version)?;
        self.rates.insert(id, version);
        Ok(())
    }

    /// Adds a rounding version. `today` is the current date in the zone the user is looking at.
    pub fn set_rounding(
        &mut self,
        ctx: &Ctx<'_>,
        input: &RoundingInput,
        today: &str,
    ) -> Result<(), CoreError> {
        check_date(&input.effective_from, "Effective date")?;
        check_date(today, "Today")?;
        if input.effective_from.as_str() < today && !input.confirm_retroactive {
            return Err(CoreError::Conflict(
                "a backdated increment changes past reported figures and needs confirmation".into(),
            ));
        }
        let project_id = input.project_id.clone().filter(|p| !p.is_empty());
        if let Some(p) = &project_id {
            self.live_project(p)?;
        }
        let existing = self
            .rounding
            .values()
            .filter(|r| {
                !r.deleted && r.project_id == project_id && r.effective_from == input.effective_from
            })
            .max_by(|a, b| stamp_order(&a.stamp, &a.id, &b.stamp, &b.id))
            .cloned();
        let id = existing.as_ref().map_or_else(new_id, |r| r.id.clone());
        let stamp = existing
            .as_ref()
            .map_or_else(|| ctx.stamp(), |r| ctx.next(&r.stamp));
        let version = RoundingVersion {
            id: id.clone(),
            project_id,
            effective_from: input.effective_from.clone(),
            increment_minutes: input.increment_minutes,
            method: input.method,
            deleted: false,
            stamp,
        };
        check_rounding(&version)?;
        self.rounding.insert(id, version);
        Ok(())
    }

    pub fn delete_rounding(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        let v = self
            .rounding
            .get_mut(id)
            .ok_or(CoreError::NotFound("rounding version"))?;
        v.deleted = true;
        v.stamp = ctx.next(&v.stamp);
        Ok(())
    }

    pub fn set_setting(&mut self, ctx: &Ctx<'_>, key: &str, value: Value) -> Result<(), CoreError> {
        check_setting(key, &value)?;
        let stamp = self
            .settings
            .get(key)
            .map_or_else(|| ctx.stamp(), |e| ctx.next(&e.stamp));
        self.settings
            .insert(key.to_owned(), SettingEntry { value, stamp });
        Ok(())
    }
}

/// An edit removed the active subtask's item: no subtask is active now.
pub(crate) fn clear_missing_active(t: &mut Task, ctx: &Ctx<'_>) {
    let gone = t
        .active_subtask
        .as_ref()
        .is_some_and(|a| !subtasks::items(&t.description).iter().any(|i| i.id == *a));
    if gone {
        t.active_subtask = None;
        t.active_subtask_stamp = ctx.next(&t.active_subtask_stamp);
    }
}

/// What a cold start needs. Tags join the list as soon as any exist.
#[must_use]
pub fn cold_required(shared: &Shared) -> Vec<RequiredField> {
    let mut out = COLD_REQUIRED.to_vec();
    if shared.tags.values().any(|t| !t.deleted) {
        out.push(RequiredField::Tags);
    }
    out
}

/// Allow-list of replicated settings. `null` clears a value.
pub fn check_setting(key: &str, value: &Value) -> Result<(), CoreError> {
    let invalid = || CoreError::Validation(format!("invalid value for {key}"));
    match key {
        "myZone" | "clientZone" | "activeZone" => {
            if !value.is_null() {
                parse_zone(value.as_str().ok_or_else(invalid)?)?;
            }
        }
        "showBoth" => {
            if !value.is_boolean() {
                return Err(invalid());
            }
        }
        "clientWorkStart" | "clientWorkEnd" => {
            if !value.is_null() {
                check_hhmm(value.as_str().ok_or_else(invalid)?, key)?;
            }
        }
        "remindPastShift" => {
            if !value.is_boolean() {
                return Err(invalid());
            }
        }
        // Whole minutes. `null` or 0 turns the feature off.
        "idleMinutes" | "longRunMinutes" => {
            if !value.is_null() && !value.as_i64().is_some_and(|m| (0..=10_080).contains(&m)) {
                return Err(invalid());
            }
        }
        "dailyTargetHours" | "weeklyTargetHours" => {
            if !value.is_null() {
                clean_non_negative(value.as_f64().ok_or_else(invalid)?, key)?;
            }
        }
        _ => return Err(CoreError::Validation(format!("unknown setting: {key}"))),
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub const DEV: &str = "device-a";

    pub fn ctx(iso: &str) -> Ctx<'static> {
        Ctx {
            now: Ts::parse(iso).unwrap(),
            device: DEV,
        }
    }

    pub fn project_input(name: &str) -> ProjectInput {
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

    pub fn task_input(name: &str, project: &str) -> TaskInput {
        TaskInput {
            name: name.into(),
            project_id: project.into(),
            description: Value::Null,
            continued_from: None,
            tags: Vec::new(),
        }
    }

    fn base() -> (Shared, String, String) {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = s.create_project(&c, &project_input("Alpha")).unwrap();
        let t = s.create_task(&c, &task_input("Write", &p)).unwrap();
        (s, p, t)
    }

    fn state(s: &Shared, id: &str) -> TaskState {
        s.tasks[id].state
    }

    #[test]
    fn full_lifecycle_records_segments_in_utc() {
        let (mut s, _, t) = base();
        s.start(&ctx("2026-01-01T09:00:00Z"), &t).unwrap();
        assert_eq!(state(&s, &t), TaskState::Running);
        s.pause(&ctx("2026-01-01T09:30:00Z"), &t).unwrap();
        assert_eq!(state(&s, &t), TaskState::Paused);
        s.resume(&ctx("2026-01-01T10:00:00Z"), &t).unwrap();
        s.stop(&ctx("2026-01-01T10:15:00Z"), &t).unwrap();
        assert_eq!(state(&s, &t), TaskState::Stopped);
        let mut segs: Vec<_> = s.segments.values().collect();
        segs.sort_by_key(|x| x.start);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start.iso(), "2026-01-01T09:00:00Z");
        assert_eq!(segs[0].end.unwrap().iso(), "2026-01-01T09:30:00Z");
        assert_eq!(segs[1].end.unwrap().iso(), "2026-01-01T10:15:00Z");
        let total: i64 = segs
            .iter()
            .map(|x| x.end.unwrap().secs() - x.start.secs())
            .sum();
        assert_eq!(total, 45 * 60);
    }

    #[test]
    fn illegal_transitions_are_rejected_and_change_nothing() {
        let (mut s, _, t) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        assert!(matches!(
            s.pause(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        assert!(matches!(
            s.resume(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        assert!(matches!(
            s.stop(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        s.start(&c, &t).unwrap();
        assert!(matches!(
            s.start(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        assert!(matches!(
            s.resume(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        s.pause(&c, &t).unwrap();
        assert!(matches!(
            s.pause(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        assert!(matches!(
            s.start(&c, &t),
            Err(CoreError::IllegalTransition { .. })
        ));
        s.stop(&c, &t).unwrap();
        for r in [
            s.start(&c, &t).map(|_| ()),
            s.resume(&c, &t).map(|_| ()),
            s.pause(&c, &t),
            s.stop(&c, &t),
        ] {
            assert!(matches!(r, Err(CoreError::IllegalTransition { .. })));
        }
        assert_eq!(state(&s, &t), TaskState::Stopped);
        assert_eq!(s.segments.len(), 1);
    }

    #[test]
    fn stop_from_paused_adds_no_time() {
        let (mut s, _, t) = base();
        s.start(&ctx("2026-01-01T09:00:00Z"), &t).unwrap();
        s.pause(&ctx("2026-01-01T09:10:00Z"), &t).unwrap();
        s.stop(&ctx("2026-01-01T12:00:00Z"), &t).unwrap();
        let seg = s.segments.values().next().unwrap();
        assert_eq!(seg.end.unwrap().iso(), "2026-01-01T09:10:00Z");
        assert_eq!(
            s.tasks[&t].stopped_at.unwrap().iso(),
            "2026-01-01T12:00:00Z"
        );
    }

    #[test]
    fn auto_pause_when_another_task_starts() {
        let (mut s, p, a) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        let b = s.create_task(&c, &task_input("Review", &p)).unwrap();
        s.start(&c, &a).unwrap();
        let out = s.start(&ctx("2026-01-01T09:20:00Z"), &b).unwrap();
        assert_eq!(out.auto_paused_task_id.as_deref(), Some(a.as_str()));
        assert_eq!(out.auto_paused_task_name.as_deref(), Some("Write"));
        assert_eq!(state(&s, &a), TaskState::Paused);
        assert_eq!(state(&s, &b), TaskState::Running);
        assert!(matches!(
            s.tasks[&a].pause_reason,
            Some(PauseReason::AutoPaused { .. })
        ));
        assert_eq!(s.segments.values().filter(|x| x.end.is_none()).count(), 1);
        let out = s.resume(&ctx("2026-01-01T09:30:00Z"), &a).unwrap();
        assert_eq!(out.auto_paused_task_id.as_deref(), Some(b.as_str()));
        assert_eq!(state(&s, &b), TaskState::Paused);
    }

    #[test]
    fn backend_validates_task_and_project() {
        let (mut s, p, _) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        assert!(matches!(
            s.create_task(&c, &task_input("  ", &p)),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            s.create_task(&c, &task_input("x", "")),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            s.create_task(&c, &task_input("x", "nope")),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            s.create_project(&c, &project_input("alpha ")),
            Err(CoreError::Conflict(_))
        ));
        let mut bad_color = project_input("Beta");
        bad_color.color = "blue".into();
        assert!(s.create_project(&c, &bad_color).is_err());
        let mut img = task_input("x", &p);
        img.description = json!({"type":"doc","content":[{"type":"image"}]});
        assert!(s.create_task(&c, &img).is_err());
    }

    #[test]
    fn start_is_refused_when_file_has_blank_name_or_missing_project() {
        let (mut s, _, t) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        s.tasks.get_mut(&t).unwrap().name = " ".into();
        assert!(matches!(s.start(&c, &t), Err(CoreError::Validation(_))));
        s.tasks.get_mut(&t).unwrap().name = "ok".into();
        s.tasks.get_mut(&t).unwrap().project_id = "gone".into();
        assert!(matches!(s.start(&c, &t), Err(CoreError::Validation(_))));
        assert!(s.segments.is_empty());
    }

    #[test]
    fn project_with_tasks_archives_instead_of_deleting() {
        let (mut s, p, t) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        assert!(matches!(
            s.delete_project(&c, &p),
            Err(CoreError::Conflict(_))
        ));
        s.start(&c, &t).unwrap();
        assert!(s.set_project_archived(&c, &p, true).is_err());
        s.pause(&c, &t).unwrap();
        s.set_project_archived(&c, &p, true).unwrap();
        assert!(matches!(s.resume(&c, &t), Err(CoreError::Validation(_))));
        let empty = s.create_project(&c, &project_input("Empty")).unwrap();
        s.delete_project(&c, &empty).unwrap();
        assert!(s.projects[&empty].deleted);
        s.create_project(&c, &project_input("Empty")).unwrap();
    }

    #[test]
    fn a_patch_changes_only_the_fields_it_names() {
        let (mut s, _, t) = base();
        let c = ctx("2026-01-02T09:00:00Z");
        let before = s.tasks[&t].clone();
        let keep_name = TaskPatch {
            description: Some(Value::Null),
            ..TaskPatch::default()
        };
        s.patch_task(&c, &t, &keep_name).unwrap();
        let after = &s.tasks[&t];
        assert_eq!(after.description, Value::Null);
        assert_eq!(
            after.name_stamp, before.name_stamp,
            "untouched field keeps its clock"
        );
        assert_eq!(after.project_stamp, before.project_stamp);
        let blank = TaskPatch {
            name: Some("  ".into()),
            ..TaskPatch::default()
        };
        assert!(s.patch_task(&c, &t, &blank).is_err());
        assert_eq!(s.tasks[&t].name, "Write");
        let parsed: TaskPatch = serde_json::from_str(r#"{"name":"N"}"#).unwrap();
        assert_eq!(
            parsed.description, None,
            "a missing description is left alone"
        );
        let parsed: TaskPatch = serde_json::from_str(r#"{"description":null}"#).unwrap();
        assert_eq!(parsed.description, Some(Value::Null), "null clears it");
    }

    #[test]
    fn stopped_task_stays_editable() {
        let (mut s, p, t) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        s.start(&c, &t).unwrap();
        s.stop(&c, &t).unwrap();
        s.update_task(&c, &t, &task_input("Renamed", &p)).unwrap();
        assert_eq!(s.tasks[&t].name, "Renamed");
        assert!(s.update_task(&c, &t, &task_input("", &p)).is_err());
    }

    #[test]
    fn clock_going_backwards_never_gives_negative_durations() {
        let (mut s, _, t) = base();
        s.start(&ctx("2026-01-01T10:00:00Z"), &t).unwrap();
        s.pause(&ctx("2026-01-01T09:00:00Z"), &t).unwrap();
        let seg = s.segments.values().next().unwrap();
        assert_eq!(seg.end, Some(seg.start));
        s.resume(&ctx("2026-01-01T08:00:00Z"), &t).unwrap();
        s.stop(&ctx("2026-01-01T07:00:00Z"), &t).unwrap();
        for x in s.segments.values() {
            assert!(x.end.unwrap() >= x.start);
        }
        // The state edit still beats the version it was based on despite the earlier clock.
        assert!(s.tasks[&t].state_stamp.at > Ts::parse("2026-01-01T10:00:00Z").unwrap());
    }

    #[test]
    fn remote_segment_is_not_altered() {
        let (mut s, _, t) = base();
        s.start(
            &Ctx {
                now: Ts::parse("2026-01-01T09:00:00Z").unwrap(),
                device: "device-b",
            },
            &t,
        )
        .unwrap();
        let c = ctx("2026-01-01T09:10:00Z");
        assert!(matches!(
            s.pause(&c, &t),
            Err(CoreError::RunningElsewhere(_))
        ));
        s.stop(&c, &t).unwrap();
        assert!(s.segments.values().next().unwrap().end.is_none());
        assert_eq!(state(&s, &t), TaskState::Stopped);
    }

    #[test]
    fn editing_leaves_segments_and_state_alone_in_every_state() {
        let (mut s, p, t) = base();
        let c = ctx("2026-01-01T09:00:00Z");
        s.update_task(&c, &t, &task_input("Draft edit", &p))
            .unwrap();
        s.start(&c, &t).unwrap();
        let open = s.segments.clone();
        s.update_task(
            &ctx("2026-01-01T09:30:00Z"),
            &t,
            &task_input("Running edit", &p),
        )
        .unwrap();
        assert_eq!(s.segments, open);
        assert_eq!(state(&s, &t), TaskState::Running);
        s.pause(&c, &t).unwrap();
        s.update_task(&c, &t, &task_input("Paused edit", &p))
            .unwrap();
        assert_eq!(state(&s, &t), TaskState::Paused);
        s.stop(&c, &t).unwrap();
        let closed = s.segments.clone();
        let mut described = task_input("Stopped edit", &p);
        described.description = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]});
        s.update_task(&c, &t, &described).unwrap();
        assert_eq!(s.segments, closed);
        assert_eq!(state(&s, &t), TaskState::Stopped);
        assert_eq!(s.tasks[&t].name, "Stopped edit");
        // The description can be cleared after start, and a blank name is refused.
        s.update_task(&c, &t, &task_input("Stopped edit", &p))
            .unwrap();
        assert!(s.tasks[&t].description.is_null());
        assert!(s.update_task(&c, &t, &task_input("  ", &p)).is_err());
        assert_eq!(s.tasks[&t].name, "Stopped edit");
    }

    #[test]
    fn only_changed_fields_get_a_new_clock() {
        let (mut s, p, t) = base();
        let before = s.tasks[&t].clone();
        let mut edit = task_input("Write", &p);
        edit.description = json!({"type":"doc","content":[]});
        s.update_task(&ctx("2026-01-01T10:00:00Z"), &t, &edit)
            .unwrap();
        let after = &s.tasks[&t];
        assert_eq!(after.name_stamp, before.name_stamp);
        assert_eq!(after.project_stamp, before.project_stamp);
        assert_ne!(after.description_stamp, before.description_stamp);
    }

    #[test]
    fn real_text_is_needed_for_a_description_to_count() {
        assert!(!doc_has_text(&Value::Null));
        assert!(!doc_has_text(
            &json!({"type":"doc","content":[{"type":"paragraph"}]})
        ));
        assert!(!doc_has_text(
            &json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"  \n "}]}]})
        ));
        assert!(!doc_has_text(
            &json!({"type":"doc","content":[{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph"}]}]}]})
        ));
        assert!(doc_has_text(
            &json!({"type":"doc","content":[{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]}]}]}]})
        ));
    }

    #[test]
    fn a_clock_ahead_on_another_device_does_not_swallow_work_here() {
        let (mut s, _, t) = base();
        let b = |iso: &str| Ctx {
            now: Ts::parse(iso).unwrap(),
            device: "device-b",
        };
        s.start(&b("2026-01-01T09:00:00Z"), &t).unwrap();
        s.pause(&b("2026-01-01T09:10:00Z"), &t).unwrap();
        s.resume(&ctx("2026-01-01T09:01:00Z"), &t).unwrap();
        let mine = s.segments.values().find(|x| x.device_id == DEV).unwrap();
        assert_eq!(mine.start.iso(), "2026-01-01T09:01:00Z");
    }

    #[test]
    fn shift_versions_are_date_effective() {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T09:00:00Z");
        let input = ShiftInput {
            shift_id: None,
            effective_from: "2026-01-01".into(),
            name: "Night".into(),
            color: "#123456".into(),
            start: "22:00".into(),
            end: "06:00".into(),
            weekdays: vec![1, 2, 2, 3],
            zone: "Europe/Lisbon".into(),
            break_minutes: 30,
            retired: false,
        };
        let id = s.save_shift(&c, &input).unwrap();
        let mut later = input.clone();
        later.shift_id = Some(id.clone());
        later.effective_from = "2026-06-01".into();
        later.start = "21:00".into();
        s.save_shift(&c, &later).unwrap();
        assert_eq!(s.shifts.len(), 2);
        let first = s
            .shifts
            .values()
            .find(|v| v.effective_from == "2026-01-01")
            .unwrap();
        assert_eq!(first.start, "22:00");
        assert_eq!(first.weekdays, vec![1, 2, 3]);
        // Saving the same date edits that version in place.
        later.start = "20:00".into();
        s.save_shift(&c, &later).unwrap();
        assert_eq!(s.shifts.len(), 2);
        let mut bad = input.clone();
        bad.start = "25:00".into();
        assert!(s.save_shift(&c, &bad).is_err());
        s.delete_shift(&c, &id).unwrap();
        assert!(s.shifts.values().all(|v| v.deleted));
    }

    #[test]
    fn settings_are_allow_listed() {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T09:00:00Z");
        s.set_setting(&c, "clientZone", json!("America/Chicago"))
            .unwrap();
        assert!(s.set_setting(&c, "clientZone", json!("Nope/Zone")).is_err());
        assert!(s.set_setting(&c, "evil", json!(1)).is_err());
        assert!(s.set_setting(&c, "dailyTargetHours", json!(-1)).is_err());
        s.set_setting(&c, "dailyTargetHours", Value::Null).unwrap();
    }
}
