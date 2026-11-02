//! Billing summaries for the user's own guidance, budget status and fixed-fee figures. A summary is
//! not an invoice and has no tax fields. It freezes what it listed and marks that time as billed.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::billing::{cents_from_numerator, day_of, task_days, task_days_of};
use crate::error::CoreError;
use crate::machine::Ctx;
use crate::model::{
    BillingSummary, BillingType, DevicePrefix, GapDecision, Segment, Shared, SummaryRow,
};
use crate::pieces::{Piece, PieceKind, pieces};
use crate::time::Ts;
use crate::validate::{check_date, parse_zone};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRequest {
    pub project_id: String,
    /// Inclusive days, `YYYY-MM-DD`, in `zone`.
    pub from: String,
    pub to: String,
    pub zone: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPreview {
    pub rows: Vec<SummaryRow>,
    pub totals: BTreeMap<String, i64>,
    pub segment_ids: Vec<String>,
    pub pause_ids: Vec<String>,
    pub exact_secs: i64,
    pub pause_secs: i64,
    pub billable_secs: i64,
    /// Time in the period that is still running, so it isn't listed yet.
    pub running_excluded: bool,
    /// Time away inside these segments with no decision yet. It is left out, and a summary freezes that.
    pub unconfirmed_secs: i64,
}

fn view_has(ids: &[String], id: &str) -> bool {
    ids.iter().any(|x| x == id)
}

fn parse_day(raw: &str, field: &str) -> Result<NaiveDate, CoreError> {
    check_date(raw, field)?;
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| CoreError::Validation(format!("{field} is not a date")))
}

impl Shared {
    fn billed_sets(&self) -> (BTreeSet<&str>, BTreeSet<&str>) {
        let mut segs = BTreeSet::new();
        let mut pauses = BTreeSet::new();
        for b in self.summaries.values().filter(|b| !b.voided) {
            segs.extend(b.segment_ids.iter().map(String::as_str));
            pauses.extend(b.pause_ids.iter().map(String::as_str));
        }
        (segs, pauses)
    }

    /// The segment ids on a live summary.
    #[must_use]
    pub fn billed_segments(&self) -> BTreeSet<&str> {
        self.billed_sets().0
    }

    /// The references of the live summaries listing any of this task's time, in order.
    pub(crate) fn summaries_listing(&self, task_id: &str) -> Vec<&str> {
        let own_segment = |id: &String| self.segments.get(id).is_some_and(|s| s.task_id == task_id);
        let own_pause = |id: &String| self.pauses.get(id).is_some_and(|p| p.task_id == task_id);
        let mut references: Vec<&str> = self
            .summaries
            .values()
            .filter(|b| !b.voided)
            .filter(|b| {
                b.rows.iter().any(|r| r.task_id == task_id)
                    || b.segment_ids.iter().any(own_segment)
                    || b.pause_ids.iter().any(own_pause)
            })
            .map(|b| b.reference.as_str())
            .collect();
        references.sort_unstable();
        references.dedup();
        references
    }

    /// Unbilled, closed time of a project in a period. Time belongs to the day its segment started.
    pub fn summary_preview(&self, req: &SummaryRequest) -> Result<SummaryPreview, CoreError> {
        let tz: Tz = parse_zone(&req.zone)?;
        let from = parse_day(&req.from, "the start date")?;
        let to = parse_day(&req.to, "the end date")?;
        if to < from {
            return Err(CoreError::Validation(
                "the end date must not be before the start date".into(),
            ));
        }
        let project = self
            .projects
            .get(&req.project_id)
            .ok_or(CoreError::NotFound("project"))?;
        let in_period = |t: Ts| {
            let d = day_of(t, tz);
            d >= from && d <= to
        };
        let (billed_segs, billed_pauses) = self.billed_sets();
        let mut view = Shared {
            projects: BTreeMap::from([(project.id.clone(), project.clone())]),
            rates: self.rates.clone(),
            rounding: self.rounding.clone(),
            ..Shared::default()
        };
        view.tasks = self
            .tasks
            .iter()
            .filter(|(_, t)| t.project_id == req.project_id && t.is_live())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut out = SummaryPreview::default();
        for s in self.segments.values() {
            let Some((start, end)) = s.effective() else {
                continue;
            };
            if !view.tasks.contains_key(&s.task_id) || !in_period(start) {
                continue;
            }
            if end.is_none() {
                out.running_excluded = true;
                continue;
            }
            if !billed_segs.contains(s.id.as_str()) {
                out.segment_ids.push(s.id.clone());
            }
        }
        for p in self.pauses.values().filter(|p| !p.deleted) {
            if view.tasks.contains_key(&p.task_id)
                && in_period(p.start)
                && !billed_pauses.contains(p.id.as_str())
            {
                out.pause_ids.push(p.id.clone());
            }
        }
        out.unconfirmed_secs = self
            .gaps
            .values()
            .filter(|g| {
                g.decision == GapDecision::Pending && view_has(&out.segment_ids, &g.segment_id)
            })
            .map(|g| (g.end.secs() - g.start.secs()).max(0))
            .fold(0, i64::saturating_add);
        // Pieces come from the whole store, so a pause never bills what an already billed segment
        // covers, and are then narrowed to what this summary lists.
        let open_end = |s: &Segment| s.end.unwrap_or(s.start);
        let listed: Vec<_> = pieces(self, &open_end)
            .into_iter()
            .filter(|p| {
                let ids = if p.kind == PieceKind::BillablePause {
                    &out.pause_ids
                } else {
                    &out.segment_ids
                };
                view_has(ids, &p.source_id)
            })
            .collect();
        for td in task_days_of(&view, tz, listed) {
            let Some(task) = view.tasks.get(&td.task_id) else {
                continue;
            };
            let cents: BTreeMap<String, i64> = td
                .numerators()
                .into_iter()
                .map(|(c, n)| (c, cents_from_numerator(n)))
                .collect();
            for (c, v) in &cents {
                *out.totals.entry(c.clone()).or_insert(0) += v;
            }
            out.exact_secs += td.exact_secs;
            out.pause_secs += td.pause_secs;
            out.billable_secs += td.billable_secs;
            out.rows.push(SummaryRow {
                task_id: td.task_id.clone(),
                task_name: task.name.clone(),
                day: td.day.format("%Y-%m-%d").to_string(),
                exact_secs: td.exact_secs,
                pause_secs: td.pause_secs,
                billable_secs: td.billable_secs,
                cents,
            });
        }
        Ok(out)
    }

    /// This device's prefix, or the first letter no other device uses.
    #[must_use]
    pub fn prefix_of(&self, device: &str) -> String {
        if let Some(p) = self.prefixes.get(device) {
            return p.prefix.clone();
        }
        let used: BTreeSet<&str> = self.prefixes.values().map(|p| p.prefix.as_str()).collect();
        ('A'..='Z')
            .map(String::from)
            .find(|p| !used.contains(p.as_str()))
            .unwrap_or_else(|| "PC".to_owned())
    }

    /// Other devices using the same prefix as this one. Their numbers could collide.
    #[must_use]
    pub fn prefix_clashes(&self, device: &str) -> Vec<String> {
        let mine = self.prefix_of(device);
        self.prefixes
            .iter()
            .filter(|(id, p)| id.as_str() != device && p.prefix == mine)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Raises each prefix's mark to the highest number on any summary here, voided ones included.
    pub fn raise_reference_marks(&self, marks: &mut BTreeMap<String, u32>) {
        for b in self.summaries.values() {
            let mark = marks.entry(b.prefix.clone()).or_insert(0);
            *mark = (*mark).max(b.number);
        }
    }

    /// References on more than one live summary, which offline devices can produce.
    #[must_use]
    pub fn reference_clashes(&self) -> Vec<String> {
        let mut seen: BTreeMap<&str, u32> = BTreeMap::new();
        for b in self.summaries.values().filter(|b| !b.voided) {
            *seen.entry(b.reference.as_str()).or_insert(0) += 1;
        }
        seen.into_iter()
            .filter(|(_, n)| *n > 1)
            .map(|(r, _)| r.to_owned())
            .collect()
    }

    pub fn set_device_prefix(&mut self, ctx: &Ctx<'_>, raw: &str) -> Result<(), CoreError> {
        let prefix = raw.trim().to_uppercase();
        let ok =
            (1..=4).contains(&prefix.len()) && prefix.bytes().all(|b| b.is_ascii_alphanumeric());
        if !ok {
            return Err(CoreError::Validation(
                "a prefix is 1 to 4 letters or digits".into(),
            ));
        }
        let stamp = self
            .prefixes
            .get(ctx.device)
            .map_or_else(|| ctx.stamp(), |p| ctx.next(&p.stamp));
        self.prefixes
            .insert(ctx.device.to_owned(), DevicePrefix { prefix, stamp });
        Ok(())
    }

    /// Freezes the preview into a summary with this device's next number, and marks the time billed.
    pub fn create_summary(
        &mut self,
        ctx: &Ctx<'_>,
        req: &SummaryRequest,
    ) -> Result<String, CoreError> {
        self.create_summary_above(ctx, req, &BTreeMap::new())
    }

    /// As `create_summary`, with a number above `marks` too: numbers issued before a restore.
    pub fn create_summary_above(
        &mut self,
        ctx: &Ctx<'_>,
        req: &SummaryRequest,
        marks: &BTreeMap<String, u32>,
    ) -> Result<String, CoreError> {
        let preview = self.summary_preview(req)?;
        if preview.rows.is_empty() {
            return Err(CoreError::Validation(
                "there is no unbilled time in that period".into(),
            ));
        }
        let prefix = self.prefix_of(ctx.device);
        if !self.prefixes.contains_key(ctx.device) {
            self.set_device_prefix(ctx, &prefix)?;
        }
        // Across all devices: a prefix can change hands, and the number must not repeat under it.
        let number = self
            .summaries
            .values()
            .filter(|b| b.prefix == prefix)
            .map(|b| b.number)
            .max()
            .unwrap_or(0)
            .max(marks.get(&prefix).copied().unwrap_or(0))
            .checked_add(1)
            .ok_or_else(|| CoreError::Validation("this prefix has run out of numbers".into()))?;
        let id = Uuid::new_v4().to_string();
        let reference = format!("{prefix}-{number:03}");
        self.summaries.insert(
            id.clone(),
            BillingSummary {
                id: id.clone(),
                reference: reference.clone(),
                prefix,
                number,
                device_id: ctx.device.to_owned(),
                project_id: req.project_id.clone(),
                from: req.from.clone(),
                to: req.to.clone(),
                zone: req.zone.clone(),
                created_at: ctx.now,
                segment_ids: preview.segment_ids,
                pause_ids: preview.pause_ids,
                rows: preview.rows,
                totals: preview.totals,
                voided: false,
                stamp: ctx.stamp(),
            },
        );
        self.audit(
            ctx,
            "summary",
            &id,
            "create",
            "",
            Value::Null,
            json!({"reference": reference}),
        );
        Ok(id)
    }

    /// Puts the time back to unbilled. The reference number is not reused.
    pub fn void_summary(&mut self, ctx: &Ctx<'_>, id: &str) -> Result<(), CoreError> {
        let b = self
            .summaries
            .get_mut(id)
            .ok_or(CoreError::NotFound("billing summary"))?;
        if b.voided {
            return Ok(());
        }
        b.voided = true;
        b.stamp = ctx.next(&b.stamp);
        let reference = b.reference.clone();
        self.audit(
            ctx,
            "summary",
            id,
            "void",
            "",
            json!({"reference": reference}),
            Value::Null,
        );
        Ok(())
    }
}

/// Per project, from the task-day rows of the given zone.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFigures {
    pub exact_secs: i64,
    pub pause_secs: i64,
    pub billable_secs: i64,
    pub thinking_secs: i64,
    /// Fixed-fee projects: fee divided by billable hours, in cents per hour.
    pub effective_hourly_cents: Option<i64>,
    /// Time at the project's rate versions, even on a fixed-fee project, per currency.
    pub time_value_cents: BTreeMap<String, i64>,
    pub budget: Option<BudgetStatus>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// `hours`, or `fee` when time value is measured against a fixed fee.
    pub basis: &'static str,
    /// Whole percent used, rounded down so 79.9% doesn't alert early.
    pub percent: i64,
    /// 0, 80 or 100: the highest threshold reached.
    pub level: u8,
    /// A fixed fee can't be tracked without a price per hour to value the time.
    pub needs_target_rate: bool,
}

fn level_of(percent: i64) -> u8 {
    match percent {
        p if p >= 100 => 100,
        p if p >= 80 => 80,
        _ => 0,
    }
}

/// Computes the figures for every project in one pass.
#[must_use]
pub fn project_figures(
    shared: &Shared,
    tz: Tz,
    end_of: &dyn Fn(&Segment) -> Ts,
) -> BTreeMap<String, ProjectFigures> {
    let mut out: BTreeMap<String, ProjectFigures> = BTreeMap::new();
    // Rates apply to every project here, so a fixed-fee project's time can be valued.
    let wanted: BTreeSet<&str> = shared
        .projects
        .values()
        .filter(|p| p.budget_hours.is_some() || p.billing_type == BillingType::FixedFee)
        .map(|p| p.id.as_str())
        .collect();
    let mut all_hourly = Shared::default();
    if !wanted.is_empty() {
        all_hourly.rates = shared.rates.clone();
        all_hourly.rounding = shared.rounding.clone();
        all_hourly.gaps = shared.gaps.clone();
        all_hourly.pauses = shared.pauses.clone();
        for p in shared
            .projects
            .values()
            .filter(|p| wanted.contains(p.id.as_str()))
        {
            let mut p = p.clone();
            p.billing_type = BillingType::Hourly;
            p.billable = true;
            all_hourly.projects.insert(p.id.clone(), p);
        }
        for t in shared
            .tasks
            .values()
            .filter(|t| wanted.contains(t.project_id.as_str()))
        {
            all_hourly.tasks.insert(t.id.clone(), t.clone());
        }
        for s in shared
            .segments
            .values()
            .filter(|s| all_hourly.tasks.contains_key(&s.task_id))
        {
            all_hourly.segments.insert(s.id.clone(), s.clone());
        }
    }
    for td in task_days(&all_hourly, tz, end_of) {
        let f = out.entry(td.project_id.clone()).or_default();
        f.exact_secs += td.exact_secs;
        f.pause_secs += td.pause_secs;
        f.thinking_secs += td.thinking_secs;
        f.billable_secs += td.billable_secs;
        for (c, n) in td.numerators() {
            *f.time_value_cents.entry(c).or_insert(0) += cents_from_numerator(n);
        }
    }
    for p in shared.projects.values() {
        let f = out.entry(p.id.clone()).or_default();
        let fee = (p.billing_type == BillingType::FixedFee)
            .then_some(p.fixed_fee_cents)
            .flatten();
        if let Some(fee) = fee
            && f.billable_secs > 0
        {
            f.effective_hourly_cents = Some(
                i64::try_from(i128::from(fee) * 3600 / i128::from(f.billable_secs))
                    .unwrap_or(i64::MAX),
            );
        }
        f.budget = if let Some(hours) = p.budget_hours.filter(|h| *h > 0.0) {
            #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
            let percent = (f.billable_secs as f64 / (hours * 3600.0) * 100.0).floor() as i64;
            Some(BudgetStatus {
                basis: "hours",
                percent,
                level: level_of(percent),
                needs_target_rate: false,
            })
        } else if let Some(fee) = fee.filter(|f| *f > 0) {
            let value = p
                .fee_currency
                .as_ref()
                .and_then(|c| f.time_value_cents.get(c))
                .copied();
            let percent = value.map_or(0, |v| v.saturating_mul(100) / fee);
            Some(BudgetStatus {
                basis: "fee",
                percent,
                level: level_of(percent),
                needs_target_rate: value.is_none(),
            })
        } else {
            None
        };
    }
    out
}

/// Per task: seconds on a live summary, and seconds per subtask.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskTotals {
    pub billed_secs: i64,
    pub unbilled_secs: i64,
    pub thinking_secs: i64,
    pub pause_secs: i64,
    pub subtask_secs: BTreeMap<String, i64>,
}

#[must_use]
pub fn task_totals(shared: &Shared, all: &[Piece]) -> BTreeMap<String, TaskTotals> {
    let (segs, pauses) = shared.billed_sets();
    let mut out: BTreeMap<String, TaskTotals> = BTreeMap::new();
    for p in all {
        let t = out.entry(p.task_id.clone()).or_default();
        let billed = match p.kind {
            PieceKind::BillablePause => pauses.contains(p.source_id.as_str()),
            _ => segs.contains(p.source_id.as_str()),
        };
        if billed {
            t.billed_secs += p.secs();
        } else {
            t.unbilled_secs += p.secs();
        }
        match p.kind {
            PieceKind::Thinking => t.thinking_secs += p.secs(),
            PieceKind::BillablePause => t.pause_secs += p.secs(),
            PieceKind::Work => {}
        }
        if let Some(id) = &p.subtask_id {
            *t.subtask_secs.entry(id.clone()).or_insert(0) += p.secs();
        }
    }
    out
}

/// The summary as CSV. User text is neutralised against spreadsheet formula injection.
#[must_use]
pub fn summary_csv(b: &BillingSummary, project_name: &str, hide_earnings: bool) -> String {
    let mut out = String::new();
    let mut line = |cells: &[String]| {
        out.push_str(
            &cells
                .iter()
                .map(|c| crate::csv::quote(c))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    };
    line(&["For your own guidance. Not an invoice, not a tax document.".to_owned()]);
    if hide_earnings {
        line(&["Amounts are left out because Hide earnings is on.".to_owned()]);
    }
    if b.voided {
        line(&["Status".to_owned(), "Voided".to_owned()]);
    }
    line(&["Reference".to_owned(), crate::csv::neutralize(&b.reference)]);
    line(&["Project".to_owned(), crate::csv::neutralize(project_name)]);
    line(&[
        "Period".to_owned(),
        crate::csv::neutralize(&format!("{} to {} ({})", b.from, b.to, b.zone)),
    ]);
    // With amounts hidden there are simply no currency columns, and so nothing to read back.
    let currencies: Vec<&String> = if hide_earnings {
        Vec::new()
    } else {
        b.totals.keys().collect()
    };
    let mut head: Vec<String> = [
        "Day",
        "Task",
        "Exact hours",
        "Billable pause hours",
        "Billable hours",
    ]
    .map(str::to_owned)
    .to_vec();
    head.extend(currencies.iter().map(|c| crate::csv::neutralize(c)));
    line(&head);
    #[allow(clippy::cast_precision_loss)]
    let hours = |s: i64| format!("{:.2}", s as f64 / 3600.0);
    #[allow(clippy::cast_precision_loss)]
    let amount = |c: i64| format!("{:.2}", c as f64 / 100.0);
    for r in &b.rows {
        let mut cells = vec![
            crate::csv::neutralize(&r.day),
            crate::csv::neutralize(&r.task_name),
            hours(r.exact_secs),
            hours(r.pause_secs),
            hours(r.billable_secs),
        ];
        cells.extend(
            currencies
                .iter()
                .map(|c| amount(r.cents.get(*c).copied().unwrap_or(0))),
        );
        line(&cells);
    }
    let mut total = vec![
        "Total".to_owned(),
        String::new(),
        hours(
            b.rows
                .iter()
                .map(|r| r.exact_secs)
                .fold(0, i64::saturating_add),
        ),
        hours(
            b.rows
                .iter()
                .map(|r| r.pause_secs)
                .fold(0, i64::saturating_add),
        ),
        hours(
            b.rows
                .iter()
                .map(|r| r.billable_secs)
                .fold(0, i64::saturating_add),
        ),
    ];
    total.extend(
        currencies
            .iter()
            .map(|c| amount(b.totals.get(*c).copied().unwrap_or(0))),
    );
    line(&total);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adjust::{ManualEntryInput, PauseInput};
    use crate::machine::tests::{ctx, project_input, task_input};
    use crate::machine::{ProjectInput, RateInput};

    const NOW: &str = "2026-03-20T12:00:00Z";

    fn at(device: &str) -> Ctx<'_> {
        Ctx {
            now: Ts::parse("2026-03-20T12:00:00Z").unwrap(),
            device,
        }
    }
    fn rate_for(s: &mut Shared, project: &str) {
        s.set_rate(
            &at("pc-a"),
            &RateInput {
                project_id: project.to_owned(),
                rate_cents: Some(6000),
                currency: "EUR".into(),
                effective_from: Some("2026-01-01T00:00:00Z".to_owned()),
                confirm_retroactive: true,
            },
        )
        .unwrap();
    }

    fn ts(x: &str) -> Ts {
        Ts::parse(x).unwrap()
    }
    fn world(input: &ProjectInput) -> (Shared, String, String) {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = s.create_project(&c, input).unwrap();
        s.set_rate(
            &c,
            &RateInput {
                project_id: p.clone(),
                rate_cents: Some(6000),
                currency: "EUR".into(),
                effective_from: Some("2026-01-01T00:00:00Z".to_owned()),
                confirm_retroactive: true,
            },
        )
        .unwrap();
        let t = s.create_task(&c, &task_input("Job", &p)).unwrap();
        (s, p, t)
    }
    fn entry(s: &mut Shared, t: &str, a: &str, b: &str) -> String {
        s.add_manual_entry(
            &ctx(NOW),
            &ManualEntryInput {
                task_id: t.into(),
                start: ts(a),
                end: ts(b),
                reason: String::new(),
                subtask_id: None,
                allow_overlap: true,
            },
        )
        .unwrap()
    }
    fn req(p: &str) -> SummaryRequest {
        SummaryRequest {
            project_id: p.into(),
            from: "2026-03-01".into(),
            to: "2026-03-31".into(),
            zone: "UTC".into(),
        }
    }

    #[test]
    fn a_summary_lists_unbilled_time_marks_it_and_a_second_one_finds_nothing() {
        let (mut s, p, t) = world(&project_input("A"));
        entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        let id = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        let b = &s.summaries[&id];
        assert_eq!(b.reference, "A-001");
        assert_eq!(b.totals["EUR"], 6000);
        assert_eq!(b.rows[0].billable_secs, 3600);
        assert!(s.create_summary(&ctx(NOW), &req(&p)).is_err());
        let all = crate::pieces::pieces(&s, &|x: &Segment| x.end.unwrap_or(x.start));
        let totals = task_totals(&s, &all);
        assert_eq!(
            (totals[&t].billed_secs, totals[&t].unbilled_secs),
            (3600, 0)
        );
    }

    #[test]
    fn billed_time_cannot_be_corrected_until_the_summary_is_voided() {
        let (mut s, p, t) = world(&project_input("A"));
        let seg = entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        let id = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        assert!(matches!(
            s.void_segment(&ctx(NOW), &seg, "x"),
            Err(CoreError::Conflict(_))
        ));
        s.void_summary(&ctx(NOW), &id).unwrap();
        assert!(s.void_segment(&ctx(NOW), &seg, "x").is_ok());
    }

    #[test]
    fn numbers_count_per_prefix_and_are_not_reused_after_a_void() {
        let (mut s, p, t) = world(&project_input("A"));
        entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        let first = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        s.void_summary(&ctx(NOW), &first).unwrap();
        let second = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        assert_eq!(s.summaries[&second].reference, "A-002");
        s.set_device_prefix(&ctx(NOW), " b2 ").unwrap();
        entry(&mut s, &t, "2026-03-03T09:00:00Z", "2026-03-03T10:00:00Z");
        let third = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        assert_eq!(s.summaries[&third].reference, "B2-001");
        assert!(s.set_device_prefix(&ctx(NOW), "too long").is_err());
    }

    #[test]
    fn two_devices_get_different_prefixes_and_a_forced_clash_is_reported() {
        let mut s = Shared::default();
        let a = Ctx {
            now: ts(NOW),
            device: "pc-a",
        };
        let b = Ctx {
            now: ts(NOW),
            device: "pc-b",
        };
        s.set_device_prefix(&a, &s.prefix_of("pc-a")).unwrap();
        assert_eq!(s.prefix_of("pc-b"), "B");
        s.set_device_prefix(&b, "A").unwrap();
        assert_eq!(s.prefix_clashes("pc-a"), vec!["pc-b".to_owned()]);
    }

    #[test]
    fn a_billable_pause_is_on_the_summary_and_reported_separately() {
        let (mut s, p, t) = world(&project_input("A"));
        entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        entry(&mut s, &t, "2026-03-02T11:00:00Z", "2026-03-02T12:00:00Z");
        s.mark_billable_pause(
            &ctx(NOW),
            &PauseInput {
                task_id: t.clone(),
                start: ts("2026-03-02T10:00:00Z"),
                end: ts("2026-03-02T11:00:00Z"),
                note: String::new(),
            },
        )
        .unwrap();
        let pre = s.summary_preview(&req(&p)).unwrap();
        assert_eq!(
            (pre.exact_secs, pre.pause_secs, pre.billable_secs),
            (7200, 3600, 10800)
        );
        assert_eq!(pre.totals["EUR"], 18000);
    }

    #[test]
    fn budget_levels_on_hours() {
        let input = ProjectInput {
            budget_hours: Some(10.0),
            ..project_input("A")
        };
        let (mut s, p, t) = world(&input);
        // Rounding is off here so the percentages are exact.
        s.set_rounding(
            &ctx(NOW),
            &crate::machine::RoundingInput {
                project_id: None,
                effective_from: "2000-01-01".into(),
                increment_minutes: 0,
                method: crate::model::RoundMethod::Up,
                confirm_retroactive: true,
            },
            "2026-03-20",
        )
        .unwrap();
        let end = |x: &Segment| x.end.unwrap_or(x.start);
        let tz = parse_zone("UTC").unwrap();
        entry(&mut s, &t, "2026-03-02T00:00:00Z", "2026-03-02T07:59:00Z");
        assert_eq!(
            project_figures(&s, tz, &end)[&p]
                .budget
                .as_ref()
                .unwrap()
                .level,
            0
        );
        entry(&mut s, &t, "2026-03-03T00:00:00Z", "2026-03-03T00:01:00Z");
        let b = project_figures(&s, tz, &end)[&p].budget.clone().unwrap();
        assert_eq!((b.percent, b.level, b.basis), (80, 80, "hours"));
        entry(&mut s, &t, "2026-03-04T00:00:00Z", "2026-03-04T02:00:00Z");
        assert_eq!(
            project_figures(&s, tz, &end)[&p]
                .budget
                .as_ref()
                .unwrap()
                .level,
            100
        );
    }

    #[test]
    fn a_fixed_fee_project_earns_no_hourly_money_but_has_an_effective_rate() {
        let input = ProjectInput {
            billing_type: BillingType::FixedFee,
            fixed_fee_cents: Some(100_000),
            fee_currency: Some("EUR".into()),
            ..project_input("A")
        };
        let (mut s, p, t) = world(&input);
        entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T19:00:00Z");
        let end = |x: &Segment| x.end.unwrap_or(x.start);
        let tz = parse_zone("UTC").unwrap();
        let rows = task_days(&s, tz, &end);
        assert!(rows[0].numerators().is_empty(), "no hourly earnings");
        let f = &project_figures(&s, tz, &end)[&p];
        assert_eq!(f.effective_hourly_cents, Some(10_000));
        let b = f.budget.clone().unwrap();
        // 10 h at 60.00 is 600.00 of a 1000.00 fee.
        assert_eq!(
            (b.basis, b.percent, b.level, b.needs_target_rate),
            ("fee", 60, 0, false)
        );
    }

    #[test]
    fn a_fixed_fee_without_a_rate_says_it_needs_one() {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = s
            .create_project(
                &c,
                &ProjectInput {
                    billing_type: BillingType::FixedFee,
                    fixed_fee_cents: Some(100),
                    fee_currency: Some("EUR".into()),
                    ..project_input("A")
                },
            )
            .unwrap();
        let f = &project_figures(&s, parse_zone("UTC").unwrap(), &|x: &Segment| {
            x.end.unwrap_or(x.start)
        })[&p];
        assert!(f.budget.as_ref().unwrap().needs_target_rate);
    }

    #[test]
    fn the_csv_says_it_is_no_tax_document_and_neutralises_names() {
        let (mut s, p, t) = world(&project_input("A"));
        s.tasks.get_mut(&t).unwrap().name = "=HYPERLINK(1)".into();
        entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        let id = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        let text = summary_csv(&s.summaries[&id], "A", false);
        assert!(text.starts_with("\"For your own guidance. Not an invoice, not a tax document.\""));
        assert!(text.contains("'=HYPERLINK"));
        assert!(text.contains("60.00"));
    }

    #[test]
    fn a_reference_number_never_repeats_when_a_prefix_changes_hands() {
        let (mut s, p, t) = crate::billing::tests::fixture(None);
        rate_for(&mut s, &p);
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s1",
            "2026-03-01T09:00:00Z",
            "2026-03-01T10:00:00Z",
        );
        let a = at("pc-a");
        let first = s.create_summary(&a, &req(&p)).unwrap();
        assert_eq!(s.summaries[&first].reference, "A-001");
        s.set_device_prefix(&a, "X").unwrap();
        let b = at("pc-b");
        s.set_device_prefix(&b, "A").unwrap();
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s2",
            "2026-03-02T09:00:00Z",
            "2026-03-02T10:00:00Z",
        );
        let second = s.create_summary(&b, &req(&p)).unwrap();
        assert_eq!(s.summaries[&second].reference, "A-002");
        assert!(s.reference_clashes().is_empty());
        // Two offline devices can still pick the same one: that is reported.
        let mut copy = s.summaries[&second].clone();
        copy.id = "other".into();
        s.summaries.insert("other".into(), copy);
        assert_eq!(s.reference_clashes(), vec!["A-002".to_owned()]);
        s.summaries.get_mut("other").unwrap().voided = true;
        assert!(s.reference_clashes().is_empty());
    }

    #[test]
    fn a_pause_around_a_billed_segment_keeps_its_unbilled_time_on_the_summary() {
        let (mut s, p, t) =
            crate::billing::tests::fixture(Some((0, crate::model::RoundMethod::Nearest)));
        rate_for(&mut s, &p);
        crate::billing::tests::seg(
            &mut s,
            &t,
            "billed",
            "2026-03-01T10:30:00Z",
            "2026-03-01T11:00:00Z",
        );
        let c = at("pc-a");
        s.create_summary(&c, &req(&p)).unwrap();
        s.pauses.insert(
            "pz".into(),
            crate::model::BillablePause {
                id: "pz".into(),
                task_id: t.clone(),
                start: Ts::parse("2026-03-01T10:00:00Z").unwrap(),
                end: Ts::parse("2026-03-01T12:00:00Z").unwrap(),
                note: String::new(),
                deleted: false,
                stamp: crate::model::Stamp::default(),
            },
        );
        let preview = s.summary_preview(&req(&p)).unwrap();
        assert_eq!(preview.pause_secs, 5400, "both sides of the billed segment");
    }

    #[test]
    fn the_same_pause_marked_twice_bills_once_in_either_order() {
        let (mut s, p, t) =
            crate::billing::tests::fixture(Some((0, crate::model::RoundMethod::Nearest)));
        rate_for(&mut s, &p);
        for id in ["pa", "pb"] {
            s.pauses.insert(
                id.into(),
                crate::model::BillablePause {
                    id: id.into(),
                    task_id: t.clone(),
                    start: Ts::parse("2026-03-01T10:00:00Z").unwrap(),
                    end: Ts::parse("2026-03-01T11:00:00Z").unwrap(),
                    note: String::new(),
                    deleted: false,
                    stamp: crate::model::Stamp::default(),
                },
            );
        }
        let preview = s.summary_preview(&req(&p)).unwrap();
        assert_eq!(preview.pause_secs, 3600);
        assert_eq!(preview.billable_secs, 3600);
    }

    #[test]
    fn a_preview_says_how_much_time_away_it_leaves_out() {
        let (mut s, p, t) = crate::billing::tests::fixture(None);
        rate_for(&mut s, &p);
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s1",
            "2026-03-01T09:00:00Z",
            "2026-03-01T12:00:00Z",
        );
        s.add_gap(
            &at("pc-a"),
            "s1",
            Ts::parse("2026-03-01T10:00:00Z").unwrap(),
            Ts::parse("2026-03-01T11:00:00Z").unwrap(),
            crate::model::GapKind::Sleep,
        )
        .unwrap();
        let preview = s.summary_preview(&req(&p)).unwrap();
        assert_eq!(preview.unconfirmed_secs, 3600);
        assert_eq!(preview.exact_secs, 2 * 3600);
    }

    #[test]
    fn hostile_summary_payloads_are_refused_at_the_sync_check() {
        let (mut s, p, t) = crate::billing::tests::fixture(None);
        rate_for(&mut s, &p);
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s1",
            "2026-03-01T09:00:00Z",
            "2026-03-01T10:00:00Z",
        );
        let id = s.create_summary(&at("pc-a"), &req(&p)).unwrap();
        let now = Ts::parse("2026-06-01T00:00:00Z").unwrap();
        crate::validate::check_shared(&s, now).unwrap();
        type Attack = fn(&mut BillingSummary);
        let attacks: [Attack; 8] = [
            |b| b.number = u32::MAX,
            |b| b.rows[0].exact_secs = i64::MAX,
            |b| b.from = "=HYPERLINK(1)".into(),
            |b| b.rows[0].day = "=1+1".into(),
            |b| b.zone = "=cmd".into(),
            |b| b.reference = "=1+1".into(),
            |b| {
                b.totals.insert("=X".into(), 1);
            },
            |b| {
                b.totals.insert("EUR".into(), i64::MAX);
            },
        ];
        for attack in attacks {
            let mut bad = s.clone();
            attack(bad.summaries.get_mut(&id).unwrap());
            assert!(crate::validate::check_shared(&bad, now).is_err());
        }
        let mut wrong_key = s.clone();
        let moved = wrong_key.summaries.remove(&id).unwrap();
        wrong_key.summaries.insert("elsewhere".into(), moved);
        assert!(crate::validate::check_shared(&wrong_key, now).is_err());
        let mut fee = s.clone();
        fee.projects.get_mut(&p).unwrap().fixed_fee_cents = Some(-5);
        assert!(crate::validate::check_shared(&fee, now).is_err());
    }

    #[test]
    fn a_name_with_a_comma_is_quoted_once_and_a_formula_is_neutralised() {
        let (mut s, p, t) = crate::billing::tests::fixture(None);
        rate_for(&mut s, &p);
        s.tasks.get_mut(&t).unwrap().name = "Logo, phase 2".into();
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s1",
            "2026-03-01T09:00:00Z",
            "2026-03-01T10:00:00Z",
        );
        let id = s.create_summary(&at("pc-a"), &req(&p)).unwrap();
        let csv = summary_csv(&s.summaries[&id], "=evil()", false);
        assert!(csv.contains(",\"Logo, phase 2\","), "{csv}");
        assert!(!csv.contains("\"\"\""), "{csv}");
        assert!(csv.contains("'=evil()"), "{csv}");
    }

    #[test]
    fn a_hidden_csv_has_no_amount_and_a_voided_one_says_so() {
        let (mut s, p, t) = crate::billing::tests::fixture(None);
        rate_for(&mut s, &p);
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s1",
            "2026-03-01T09:00:00Z",
            "2026-03-01T10:00:00Z",
        );
        let id = s.create_summary(&at("pc-a"), &req(&p)).unwrap();
        let shown = summary_csv(&s.summaries[&id], "P", false);
        assert!(shown.contains("EUR") && shown.contains("60.00"), "{shown}");
        assert!(
            shown.starts_with("\"For your own guidance. Not an invoice, not a tax document.\"")
        );
        let hidden = summary_csv(&s.summaries[&id], "P", true);
        assert!(
            !hidden.contains("EUR") && !hidden.contains("60.00"),
            "{hidden}"
        );
        assert!(hidden.contains("left out because Hide earnings"));
        assert!(!shown.contains("Voided"));
        s.void_summary(&at("pc-a"), &id).unwrap();
        assert!(summary_csv(&s.summaries[&id], "P", false).contains("Status,Voided"));
    }

    #[test]
    fn voiding_twice_writes_one_audit_entry() {
        let (mut s, p, t) = crate::billing::tests::fixture(None);
        rate_for(&mut s, &p);
        crate::billing::tests::seg(
            &mut s,
            &t,
            "s1",
            "2026-03-01T09:00:00Z",
            "2026-03-01T10:00:00Z",
        );
        let id = s.create_summary(&at("pc-a"), &req(&p)).unwrap();
        s.void_summary(&at("pc-a"), &id).unwrap();
        let stamp = s.summaries[&id].stamp.clone();
        let audits = s.audit_log.len();
        s.void_summary(&at("pc-a"), &id).unwrap();
        assert_eq!(s.audit_log.len(), audits);
        assert_eq!(s.summaries[&id].stamp, stamp);
    }
}
