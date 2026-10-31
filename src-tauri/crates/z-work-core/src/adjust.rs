//! Manual entries, corrections, away-time decisions and billable pauses. Each one writes to the audit
//! trail, and none of them changes a segment's raw times.

use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::CoreError;
use crate::machine::Ctx;
use crate::model::{
    AuditEntry, BillablePause, GapDecision, GapKind, IdleGap, Segment, SegmentEdit, Shared,
};
use crate::time::Ts;
use crate::validate::MAX_SEGMENT_SECS;

const MAX_REASON: usize = 500;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualEntryInput {
    pub task_id: String,
    pub start: Ts,
    pub end: Ts,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub subtask_id: Option<String>,
    /// The user saw the overlap warning and wants the entry anyway.
    #[serde(default)]
    pub allow_overlap: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionInput {
    pub segment_id: String,
    pub start: Ts,
    pub end: Ts,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub allow_overlap: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseInput {
    pub task_id: String,
    pub start: Ts,
    pub end: Ts,
    #[serde(default)]
    pub note: String,
}

fn clean_reason(raw: &str) -> Result<String, CoreError> {
    let reason = raw.trim();
    if reason.chars().count() > MAX_REASON {
        return Err(CoreError::Validation("the reason is too long".into()));
    }
    if reason.chars().any(char::is_control) {
        return Err(CoreError::Validation(
            "the reason has characters that can't be stored".into(),
        ));
    }
    Ok(reason.to_owned())
}

fn check_range(ctx: &Ctx<'_>, start: Ts, end: Ts) -> Result<(), CoreError> {
    if end <= start {
        return Err(CoreError::Validation(
            "the end must be after the start".into(),
        ));
    }
    if end > ctx.now {
        return Err(CoreError::Validation(
            "the end can't be in the future".into(),
        ));
    }
    if end.secs() - start.secs() > MAX_SEGMENT_SECS {
        return Err(CoreError::Validation("that span is too long".into()));
    }
    Ok(())
}

fn seg_json(s: &Segment) -> Value {
    json!({
        "rawStart": s.start,
        "rawEnd": s.end,
        "edit": s.edit,
        "subtaskId": s.subtask_id,
    })
}

impl Shared {
    pub fn audit(
        &mut self,
        ctx: &Ctx<'_>,
        entity: &str,
        entity_id: &str,
        action: &str,
        reason: &str,
        before: Value,
        after: Value,
    ) {
        let id = Uuid::new_v4().to_string();
        self.audit_log.insert(
            id.clone(),
            AuditEntry {
                id,
                at: ctx.now,
                by: ctx.device.to_owned(),
                entity: entity.to_owned(),
                entity_id: entity_id.to_owned(),
                action: action.to_owned(),
                reason: reason.to_owned(),
                before,
                after,
            },
        );
    }

    fn is_billed(&self, segment_id: &str) -> bool {
        self.summaries
            .values()
            .any(|b| !b.voided && b.segment_ids.iter().any(|s| s == segment_id))
    }

    /// Other time logged on this device that the span overlaps. Segments on other PCs may overlap.
    fn overlapping(&self, device: &str, except: Option<&str>, start: Ts, end: Ts) -> Vec<String> {
        self.segments
            .values()
            .filter(|s| s.device_id == device && Some(s.id.as_str()) != except)
            .filter(|s| {
                s.effective()
                    .is_some_and(|(a, b)| a < end && b.is_none_or(|b| b > start))
            })
            .filter_map(|s| self.tasks.get(&s.task_id).map(|t| t.name.clone()))
            .collect()
    }

    fn refuse_overlap(&self, names: &[String]) -> Result<(), CoreError> {
        if names.is_empty() {
            return Ok(());
        }
        Err(CoreError::Overlap(names.join(", ")))
    }

    pub fn add_manual_entry(
        &mut self,
        ctx: &Ctx<'_>,
        input: &ManualEntryInput,
    ) -> Result<String, CoreError> {
        self.live_task(&input.task_id)?;
        check_range(ctx, input.start, input.end)?;
        let reason = clean_reason(&input.reason)?;
        if !input.allow_overlap {
            self.refuse_overlap(&self.overlapping(ctx.device, None, input.start, input.end))?;
        }
        let id = Uuid::new_v4().to_string();
        let seg = Segment {
            id: id.clone(),
            task_id: input.task_id.clone(),
            device_id: ctx.device.to_owned(),
            start: input.start,
            end: Some(input.end),
            manual: true,
            subtask_id: input.subtask_id.clone(),
            edit: None,
            edit_stamp: ctx.stamp(),
        };
        let after = seg_json(&seg);
        self.segments.insert(id.clone(), seg);
        self.audit(ctx, "segment", &id, "manualEntry", &reason, Value::Null, after);
        Ok(id)
    }

    pub fn correct_segment(
        &mut self,
        ctx: &Ctx<'_>,
        input: &CorrectionInput,
    ) -> Result<(), CoreError> {
        check_range(ctx, input.start, input.end)?;
        let reason = clean_reason(&input.reason)?;
        let seg = self.correctable(&input.segment_id)?;
        let device = seg.device_id.clone();
        if !input.allow_overlap {
            let names = self.overlapping(&device, Some(&input.segment_id), input.start, input.end);
            self.refuse_overlap(&names)?;
        }
        self.apply_edit(
            ctx,
            &input.segment_id,
            Some(SegmentEdit {
                start: input.start,
                end: input.end,
                voided: false,
                reason: reason.clone(),
            }),
            "correct",
            &reason,
        )
    }

    /// Removes the time from every report. The raw record stays, and this can be undone.
    pub fn void_segment(&mut self, ctx: &Ctx<'_>, id: &str, reason: &str) -> Result<(), CoreError> {
        let reason = clean_reason(reason)?;
        let seg = self.correctable(id)?;
        let (start, end) = (seg.start, seg.end.unwrap_or(seg.start));
        self.apply_edit(
            ctx,
            id,
            Some(SegmentEdit {
                start,
                end,
                voided: true,
                reason: reason.clone(),
            }),
            "void",
            &reason,
        )
    }

    /// Takes off any correction or void, back to the raw times.
    pub fn restore_segment(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        reason: &str,
    ) -> Result<(), CoreError> {
        let reason = clean_reason(reason)?;
        self.correctable(id)?;
        self.apply_edit(ctx, id, None, "restore", &reason)
    }

    fn correctable(&self, id: &str) -> Result<&Segment, CoreError> {
        let seg = self
            .segments
            .get(id)
            .ok_or(CoreError::NotFound("work segment"))?;
        if seg.end.is_none() {
            return Err(CoreError::Conflict(
                "this segment is still running; pause the task first".into(),
            ));
        }
        if self.is_billed(id) {
            return Err(CoreError::Conflict(
                "this time is on a billing summary; void that summary first".into(),
            ));
        }
        self.live_task(&seg.task_id)?;
        Ok(seg)
    }

    fn apply_edit(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        edit: Option<SegmentEdit>,
        action: &str,
        reason: &str,
    ) -> Result<(), CoreError> {
        let seg = self
            .segments
            .get_mut(id)
            .ok_or(CoreError::NotFound("work segment"))?;
        let before = seg_json(seg);
        seg.edit = edit;
        seg.edit_stamp = ctx.next(&seg.edit_stamp);
        let after = seg_json(seg);
        self.audit(ctx, "segment", id, action, reason, before, after);
        Ok(())
    }

    /// Records time away inside a running segment. It counts nowhere until the user decides.
    pub fn add_gap(
        &mut self,
        ctx: &Ctx<'_>,
        segment_id: &str,
        start: Ts,
        end: Ts,
        kind: GapKind,
    ) -> Option<String> {
        let seg = self.segments.get(segment_id)?;
        let start = start.max(seg.start);
        if end <= start {
            return None;
        }
        let id = Uuid::new_v4().to_string();
        let gap = IdleGap {
            id: id.clone(),
            segment_id: segment_id.to_owned(),
            task_id: seg.task_id.clone(),
            device_id: seg.device_id.clone(),
            start,
            end,
            kind,
            decision: GapDecision::Pending,
            decision_stamp: ctx.stamp(),
        };
        self.gaps.insert(id.clone(), gap);
        self.audit(
            ctx,
            "gap",
            &id,
            "detected",
            "",
            Value::Null,
            json!({"start": start, "end": end, "kind": kind}),
        );
        Some(id)
    }

    pub fn decide_gap(
        &mut self,
        ctx: &Ctx<'_>,
        id: &str,
        decision: GapDecision,
    ) -> Result<(), CoreError> {
        let segment_id = self
            .gaps
            .get(id)
            .ok_or(CoreError::NotFound("time away"))?
            .segment_id
            .clone();
        if self.is_billed(&segment_id) {
            return Err(CoreError::Conflict(
                "this time is on a billing summary; void that summary first".into(),
            ));
        }
        let gap = self
            .gaps
            .get_mut(id)
            .ok_or(CoreError::NotFound("time away"))?;
        let before = json!({"decision": gap.decision});
        gap.decision = decision;
        gap.decision_stamp = ctx.next(&gap.decision_stamp);
        self.audit(
            ctx,
            "gap",
            id,
            "decide",
            "",
            before,
            json!({"decision": decision}),
        );
        Ok(())
    }

    pub fn mark_billable_pause(
        &mut self,
        ctx: &Ctx<'_>,
        input: &PauseInput,
    ) -> Result<String, CoreError> {
        self.live_task(&input.task_id)?;
        check_range(ctx, input.start, input.end)?;
        let note = clean_reason(&input.note)?;
        let id = Uuid::new_v4().to_string();
        self.pauses.insert(
            id.clone(),
            BillablePause {
                id: id.clone(),
                task_id: input.task_id.clone(),
                start: input.start,
                end: input.end,
                note: note.clone(),
                deleted: false,
                stamp: ctx.stamp(),
            },
        );
        self.audit(
            ctx,
            "pause",
            &id,
            "markBillable",
            &note,
            Value::Null,
            json!({"start": input.start, "end": input.end}),
        );
        Ok(id)
    }

    pub fn unmark_billable_pause(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        if self
            .summaries
            .values()
            .any(|b| !b.voided && b.pause_ids.iter().any(|p| p == id))
        {
            return Err(CoreError::Conflict(
                "this time is on a billing summary; void that summary first".into(),
            ));
        }
        let pause = self
            .pauses
            .get_mut(id)
            .ok_or(CoreError::NotFound("billable pause"))?;
        pause.deleted = true;
        pause.stamp = ctx.next(&pause.stamp);
        let after = json!({"start": pause.start, "end": pause.end});
        self.audit(ctx, "pause", id, "unmarkBillable", "", after, Value::Null);
        Ok(())
    }

    /// Makes one subtask active. If the task is running here, time up to now stays on the previous
    /// subtask and a new segment starts, so each segment belongs to exactly one subtask.
    pub fn set_active_subtask(
        &mut self,
        ctx: &Ctx<'_>,
        task_id: &str,
        subtask_id: Option<&str>,
    ) -> Result<(), CoreError> {
        let task = self.live_task(task_id)?;
        if let Some(id) = subtask_id
            && !crate::subtasks::items(&task.description)
                .iter()
                .any(|i| i.id == id)
        {
            return Err(CoreError::NotFound("subtask"));
        }
        let t = self
            .tasks
            .get_mut(task_id)
            .ok_or(CoreError::NotFound("task"))?;
        let changed = t.active_subtask.as_deref() != subtask_id;
        t.active_subtask = subtask_id.map(str::to_owned);
        t.active_subtask_stamp = ctx.next(&t.active_subtask_stamp);
        if changed {
            let open: Vec<String> = self
                .segments
                .values()
                .filter(|s| s.task_id == task_id && s.device_id == ctx.device && s.end.is_none())
                .map(|s| s.id.clone())
                .collect();
            if !open.is_empty() {
                for id in &open {
                    self.close_segment(id, ctx.now);
                }
                self.open_segment(ctx, task_id);
            }
        }
        Ok(())
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::tests::{ctx, project_input, task_input};
    use crate::model::{Segment, TaskState};
    use crate::pieces::{PieceKind, pieces};

    fn world() -> (Shared, String) {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = s.create_project(&c, &project_input("A")).unwrap();
        let t = s.create_task(&c, &task_input("T", &p)).unwrap();
        (s, t)
    }
    fn ts(x: &str) -> Ts {
        Ts::parse(x).unwrap()
    }
    fn secs_by(s: &Shared, kind: PieceKind) -> i64 {
        let end = |seg: &Segment| seg.end.unwrap_or(seg.start);
        pieces(s, &end)
            .iter()
            .filter(|p| p.kind == kind)
            .map(crate::pieces::Piece::secs)
            .sum()
    }
    fn manual(t: &str, a: &str, b: &str) -> ManualEntryInput {
        ManualEntryInput {
            task_id: t.into(),
            start: ts(a),
            end: ts(b),
            reason: "forgot".into(),
            subtask_id: None,
            allow_overlap: false,
        }
    }

    #[test]
    fn a_manual_entry_counts_and_is_audited() {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T12:00:00Z");
        let id = s
            .add_manual_entry(&c, &manual(&t, "2026-01-02T09:00:00Z", "2026-01-02T10:00:00Z"))
            .unwrap();
        assert!(s.segments[&id].manual);
        assert_eq!(secs_by(&s, PieceKind::Work), 3600);
        let log: Vec<_> = s.audit_log.values().collect();
        assert_eq!((log[0].action.as_str(), log[0].reason.as_str()), ("manualEntry", "forgot"));
    }

    #[test]
    fn manual_entries_refuse_nonsense_and_warn_about_overlap() {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T12:00:00Z");
        assert!(s.add_manual_entry(&c, &manual(&t, "2026-01-02T10:00:00Z", "2026-01-02T09:00:00Z")).is_err());
        assert!(s.add_manual_entry(&c, &manual(&t, "2026-01-02T11:00:00Z", "2026-01-02T13:00:00Z")).is_err());
        s.add_manual_entry(&c, &manual(&t, "2026-01-02T09:00:00Z", "2026-01-02T10:00:00Z")).unwrap();
        let over = manual(&t, "2026-01-02T09:30:00Z", "2026-01-02T10:30:00Z");
        assert!(matches!(s.add_manual_entry(&c, &over), Err(CoreError::Overlap(_))));
        let ok = ManualEntryInput { allow_overlap: true, ..over };
        assert!(s.add_manual_entry(&c, &ok).is_ok());
    }

    #[test]
    fn a_correction_keeps_raw_times_and_can_be_undone() {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T12:00:00Z");
        let id = s.add_manual_entry(&c, &manual(&t, "2026-01-02T09:00:00Z", "2026-01-02T10:00:00Z")).unwrap();
        s.correct_segment(&c, &CorrectionInput {
            segment_id: id.clone(), start: ts("2026-01-02T09:00:00Z"), end: ts("2026-01-02T09:30:00Z"),
            reason: "left early".into(), allow_overlap: false,
        }).unwrap();
        assert_eq!(s.segments[&id].end, Some(ts("2026-01-02T10:00:00Z")), "raw stays");
        assert_eq!(secs_by(&s, PieceKind::Work), 1800);
        s.void_segment(&c, &id, "duplicate").unwrap();
        assert_eq!(secs_by(&s, PieceKind::Work), 0);
        s.restore_segment(&c, &id, "my mistake").unwrap();
        assert_eq!(secs_by(&s, PieceKind::Work), 3600);
        let actions: Vec<_> = s.audit_log.values().map(|a| a.action.clone()).collect();
        for want in ["manualEntry", "correct", "void", "restore"] {
            assert!(actions.iter().any(|a| a == want), "{want}");
        }
    }

    #[test]
    fn a_running_segment_cannot_be_corrected() {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T09:00:00Z");
        s.start(&c, &t).unwrap();
        let id = s.segments.keys().next().unwrap().clone();
        assert!(s.void_segment(&ctx("2026-01-02T10:00:00Z"), &id, "x").is_err());
    }

    fn with_gap(decision: GapDecision) -> Shared {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T09:00:00Z");
        s.start(&c, &t).unwrap();
        let later = ctx("2026-01-02T12:00:00Z");
        s.pause(&later, &t).unwrap();
        let id = s.segments.keys().next().unwrap().clone();
        let g = s.add_gap(&later, &id, ts("2026-01-02T10:00:00Z"), ts("2026-01-02T11:00:00Z"), GapKind::Sleep).unwrap();
        if decision != GapDecision::Pending {
            s.decide_gap(&later, &g, decision).unwrap();
        }
        s
    }

    #[test]
    fn time_away_counts_only_after_it_is_confirmed() {
        let s = with_gap(GapDecision::Pending);
        assert_eq!(secs_by(&s, PieceKind::Work), 2 * 3600, "unanswered counts nowhere");
        let seg = s.segments.values().next().unwrap();
        assert_eq!(seg.end, Some(ts("2026-01-02T12:00:00Z")), "raw stays");
        assert_eq!(secs_by(&with_gap(GapDecision::Drop), PieceKind::Work), 2 * 3600);
        assert_eq!(secs_by(&with_gap(GapDecision::Keep), PieceKind::Work), 3 * 3600);
        let thinking = with_gap(GapDecision::Thinking);
        assert_eq!(secs_by(&thinking, PieceKind::Work), 2 * 3600);
        assert_eq!(secs_by(&thinking, PieceKind::Thinking), 3600);
    }

    #[test]
    fn a_billable_pause_never_counts_time_already_counted() {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T18:00:00Z");
        s.add_manual_entry(&c, &manual(&t, "2026-01-02T09:00:00Z", "2026-01-02T10:00:00Z")).unwrap();
        s.add_manual_entry(&c, &manual(&t, "2026-01-02T11:00:00Z", "2026-01-02T12:00:00Z")).unwrap();
        let id = s.mark_billable_pause(&c, &PauseInput {
            task_id: t.clone(), start: ts("2026-01-02T09:30:00Z"), end: ts("2026-01-02T11:30:00Z"), note: "sketching".into(),
        }).unwrap();
        assert_eq!(secs_by(&s, PieceKind::Work), 2 * 3600);
        assert_eq!(secs_by(&s, PieceKind::BillablePause), 3600);
        s.unmark_billable_pause(&c, &id).unwrap();
        assert_eq!(secs_by(&s, PieceKind::BillablePause), 0);
    }

    #[test]
    fn switching_subtask_while_running_splits_the_segment_and_keeps_the_total() {
        let (mut s, t) = world();
        let c = ctx("2026-01-02T09:00:00Z");
        let doc = serde_json::json!({"type":"doc","content":[{"type":"taskList","content":[
            {"type":"taskItem","attrs":{"checked":false,"subtaskId":"a"},"content":[{"type":"paragraph","content":[{"type":"text","text":"One"}]}]},
            {"type":"taskItem","attrs":{"checked":false,"subtaskId":"b"},"content":[{"type":"paragraph","content":[{"type":"text","text":"Two"}]}]}]}]});
        s.tasks.get_mut(&t).unwrap().description = doc;
        s.set_active_subtask(&c, &t, Some("a")).unwrap();
        s.start(&c, &t).unwrap();
        s.set_active_subtask(&ctx("2026-01-02T09:10:00Z"), &t, Some("b")).unwrap();
        s.pause(&ctx("2026-01-02T09:30:00Z"), &t).unwrap();
        let end = |seg: &Segment| seg.end.unwrap_or(seg.start);
        let all = pieces(&s, &end);
        let on = |id: &str| -> i64 { all.iter().filter(|p| p.subtask_id.as_deref() == Some(id)).map(crate::pieces::Piece::secs).sum() };
        assert_eq!((on("a"), on("b")), (600, 1200));
        assert_eq!(all.iter().map(crate::pieces::Piece::secs).sum::<i64>(), 1800);
        assert_eq!(s.tasks[&t].state, TaskState::Paused);
        assert!(s.set_active_subtask(&c, &t, Some("nope")).is_err());
    }
}
