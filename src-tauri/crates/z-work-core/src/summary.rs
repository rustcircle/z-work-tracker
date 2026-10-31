//! Billing summaries for the user's own guidance, budget status and fixed-fee figures. A summary is
//! not an invoice and has no tax fields. It freezes what it listed and marks that time as billed.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::billing::{cents_from_numerator, day_of, task_days};
use crate::error::CoreError;
use crate::machine::Ctx;
use crate::model::{BillingSummary, BillingType, DevicePrefix, Segment, Shared, SummaryRow};
use crate::pieces::{PieceKind, pieces};
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
            gaps: self.gaps.clone(),
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
                view.segments.insert(s.id.clone(), s.clone());
            }
        }
        for p in self.pauses.values().filter(|p| !p.deleted) {
            if view.tasks.contains_key(&p.task_id)
                && in_period(p.start)
                && !billed_pauses.contains(p.id.as_str())
            {
                out.pause_ids.push(p.id.clone());
                view.pauses.insert(p.id.clone(), p.clone());
            }
        }
        // Time outside this view still blocks a pause from billing it twice: a voided copy in `view`
        // doesn't count, and only a real span subtracts, so such pauses are clipped here instead.
        for pause in view.pauses.values_mut() {
            for seg in self.segments.values() {
                if seg.task_id != pause.task_id || view_has(&out.segment_ids, &seg.id) {
                    continue;
                }
                let Some((s, Some(e))) = seg.effective() else {
                    continue;
                };
                if s <= pause.start && e > pause.start {
                    pause.start = e.min(pause.end);
                } else if s > pause.start && s < pause.end {
                    pause.end = s;
                }
            }
        }
        let open_end = |s: &Segment| s.end.unwrap_or(s.start);
        for td in task_days(&view, tz, &open_end) {
            let task = &view.tasks[&td.task_id];
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

    pub fn set_device_prefix(&mut self, ctx: &Ctx<'_>, raw: &str) -> Result<(), CoreError> {
        let prefix = raw.trim().to_uppercase();
        let ok = (1..=4).contains(&prefix.len()) && prefix.bytes().all(|b| b.is_ascii_alphanumeric());
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
        let number = self
            .summaries
            .values()
            .filter(|b| b.device_id == ctx.device && b.prefix == prefix)
            .map(|b| b.number)
            .max()
            .unwrap_or(0)
            + 1;
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
    let mut all_hourly = shared.clone();
    for p in all_hourly.projects.values_mut() {
        p.billing_type = BillingType::Hourly;
        p.billable = true;
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
pub fn task_totals(
    shared: &Shared,
    end_of: &dyn Fn(&Segment) -> Ts,
) -> BTreeMap<String, TaskTotals> {
    let (segs, pauses) = shared.billed_sets();
    let mut out: BTreeMap<String, TaskTotals> = BTreeMap::new();
    for p in pieces(shared, end_of) {
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
pub fn summary_csv(b: &BillingSummary, project_name: &str) -> String {
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
    line(&["Not a tax document. For your own guidance only.".to_owned()]);
    line(&["Reference".to_owned(), crate::csv::text(&b.reference)]);
    line(&["Project".to_owned(), crate::csv::text(project_name)]);
    line(&[
        "Period".to_owned(),
        format!("{} to {} ({})", b.from, b.to, b.zone),
    ]);
    let currencies: Vec<&String> = b.totals.keys().collect();
    let mut head: Vec<String> = ["Day", "Task", "Exact hours", "Billable pause hours", "Billable hours"]
        .map(str::to_owned)
        .to_vec();
    head.extend(currencies.iter().map(|c| (*c).clone()));
    line(&head);
    #[allow(clippy::cast_precision_loss)]
    let hours = |s: i64| format!("{:.2}", s as f64 / 3600.0);
    #[allow(clippy::cast_precision_loss)]
    let amount = |c: i64| format!("{:.2}", c as f64 / 100.0);
    for r in &b.rows {
        let mut cells = vec![
            r.day.clone(),
            crate::csv::text(&r.task_name),
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
        hours(b.rows.iter().map(|r| r.exact_secs).sum()),
        hours(b.rows.iter().map(|r| r.pause_secs).sum()),
        hours(b.rows.iter().map(|r| r.billable_secs).sum()),
    ];
    total.extend(currencies.iter().map(|c| amount(b.totals[*c])));
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

    fn ts(x: &str) -> Ts {
        Ts::parse(x).unwrap()
    }
    fn world(input: &ProjectInput) -> (Shared, String, String) {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = s.create_project(&c, input).unwrap();
        s.set_rate(&c, &RateInput {
            project_id: p.clone(), rate_cents: Some(6000), currency: "EUR".into(),
            effective_from: Some(ts("2026-01-01T00:00:00Z")), confirm_retroactive: true,
        }).unwrap();
        let t = s.create_task(&c, &task_input("Job", &p)).unwrap();
        (s, p, t)
    }
    fn entry(s: &mut Shared, t: &str, a: &str, b: &str) -> String {
        s.add_manual_entry(&ctx(NOW), &ManualEntryInput {
            task_id: t.into(), start: ts(a), end: ts(b), reason: String::new(), subtask_id: None, allow_overlap: true,
        }).unwrap()
    }
    fn req(p: &str) -> SummaryRequest {
        SummaryRequest { project_id: p.into(), from: "2026-03-01".into(), to: "2026-03-31".into(), zone: "UTC".into() }
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
        let totals = task_totals(&s, &|x| x.end.unwrap_or(x.start));
        assert_eq!((totals[&t].billed_secs, totals[&t].unbilled_secs), (3600, 0));
    }

    #[test]
    fn billed_time_cannot_be_corrected_until_the_summary_is_voided() {
        let (mut s, p, t) = world(&project_input("A"));
        let seg = entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        let id = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        assert!(matches!(s.void_segment(&ctx(NOW), &seg, "x"), Err(CoreError::Conflict(_))));
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
        let a = Ctx { now: ts(NOW), device: "pc-a" };
        let b = Ctx { now: ts(NOW), device: "pc-b" };
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
        s.mark_billable_pause(&ctx(NOW), &PauseInput {
            task_id: t.clone(), start: ts("2026-03-02T10:00:00Z"), end: ts("2026-03-02T11:00:00Z"), note: String::new(),
        }).unwrap();
        let pre = s.summary_preview(&req(&p)).unwrap();
        assert_eq!((pre.exact_secs, pre.pause_secs, pre.billable_secs), (7200, 3600, 10800));
        assert_eq!(pre.totals["EUR"], 18000);
    }

    #[test]
    fn budget_levels_on_hours() {
        let input = ProjectInput { budget_hours: Some(10.0), ..project_input("A") };
        let (mut s, p, t) = world(&input);
        // Rounding is off here so the percentages are exact.
        s.set_rounding(&ctx(NOW), &crate::machine::RoundingInput {
            project_id: None, effective_from: "2000-01-01".into(), increment_minutes: 0, method: crate::model::RoundMethod::Up, confirm_retroactive: true,
        }, "2026-03-20").unwrap();
        let end = |x: &Segment| x.end.unwrap_or(x.start);
        let tz = parse_zone("UTC").unwrap();
        entry(&mut s, &t, "2026-03-02T00:00:00Z", "2026-03-02T07:59:00Z");
        assert_eq!(project_figures(&s, tz, &end)[&p].budget.as_ref().unwrap().level, 0);
        entry(&mut s, &t, "2026-03-03T00:00:00Z", "2026-03-03T00:01:00Z");
        let b = project_figures(&s, tz, &end)[&p].budget.clone().unwrap();
        assert_eq!((b.percent, b.level, b.basis), (80, 80, "hours"));
        entry(&mut s, &t, "2026-03-04T00:00:00Z", "2026-03-04T02:00:00Z");
        assert_eq!(project_figures(&s, tz, &end)[&p].budget.as_ref().unwrap().level, 100);
    }

    #[test]
    fn a_fixed_fee_project_earns_no_hourly_money_but_has_an_effective_rate() {
        let input = ProjectInput {
            billing_type: BillingType::FixedFee, fixed_fee_cents: Some(100_000), fee_currency: Some("EUR".into()),
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
        assert_eq!((b.basis, b.percent, b.level, b.needs_target_rate), ("fee", 60, 0, false));
    }

    #[test]
    fn a_fixed_fee_without_a_rate_says_it_needs_one() {
        let mut s = Shared::default();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = s.create_project(&c, &ProjectInput {
            billing_type: BillingType::FixedFee, fixed_fee_cents: Some(100), fee_currency: Some("EUR".into()), ..project_input("A")
        }).unwrap();
        let f = &project_figures(&s, parse_zone("UTC").unwrap(), &|x: &Segment| x.end.unwrap_or(x.start))[&p];
        assert!(f.budget.as_ref().unwrap().needs_target_rate);
    }

    #[test]
    fn the_csv_says_it_is_no_tax_document_and_neutralises_names() {
        let (mut s, p, t) = world(&project_input("A"));
        s.tasks.get_mut(&t).unwrap().name = "=HYPERLINK(1)".into();
        entry(&mut s, &t, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
        let id = s.create_summary(&ctx(NOW), &req(&p)).unwrap();
        let text = summary_csv(&s.summaries[&id], "A");
        assert!(text.starts_with("Not a tax document"));
        assert!(text.contains("'=HYPERLINK"));
        assert!(text.contains("60.00"));
    }
}
