//! Validation of everything entering the core from the UI or from another device's file.

use std::str::FromStr;

use chrono_tz::Tz;
use serde_json::Value;

use crate::error::CoreError;
use crate::model::{
    DeviceFile, Project, RateVersion, RoundingVersion, Shared, ShiftVersion, Stamp, Task,
};
use crate::time::Ts;

pub const MAX_NAME: usize = 200;
pub const MAX_PROJECT_NAME: usize = 80;
pub const MAX_DESCRIPTION_BYTES: usize = 512 * 1024;
const MAX_DOC_DEPTH: usize = 24;

const NODE_TYPES: &[&str] = &[
    "doc",
    "paragraph",
    "text",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "hardBreak",
];
const MARK_TYPES: &[&str] = &["bold", "italic"];

fn bad(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

pub fn clean_text(raw: &str, field: &str, max: usize) -> Result<String, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(bad(format!("{field} is required")));
    }
    if trimmed.chars().count() > max {
        return Err(bad(format!("{field} is longer than {max} characters")));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(bad(format!("{field} contains control characters")));
    }
    Ok(trimmed.to_owned())
}

pub fn clean_color(raw: &str) -> Result<String, CoreError> {
    let ok = raw.len() == 7
        && raw.starts_with('#')
        && raw.chars().skip(1).all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(raw.to_ascii_lowercase())
    } else {
        Err(bad("a color must look like #1a2b3c"))
    }
}

pub fn parse_zone(raw: &str) -> Result<Tz, CoreError> {
    Tz::from_str(raw).map_err(|_| bad(format!("unknown time zone: {raw}")))
}

pub const MAX_RATE_CENTS: i64 = 1_000_000;
pub const MAX_INCREMENT_MINUTES: u32 = 24 * 60;

#[must_use]
pub fn is_currency(raw: &str) -> bool {
    matches!(raw, "EUR" | "USD")
}

pub fn check_rate(v: &RateVersion) -> Result<(), CoreError> {
    if !is_currency(&v.currency) {
        return Err(bad("currency must be EUR or USD"));
    }
    match v.rate_cents {
        Some(c) if !(0..=MAX_RATE_CENTS).contains(&c) => {
            Err(bad("price per hour must be between 0 and 10000.00"))
        }
        _ => Ok(()),
    }
}

pub fn check_rounding(v: &RoundingVersion) -> Result<(), CoreError> {
    check_date(&v.effective_from, "Effective date")?;
    if v.increment_minutes > MAX_INCREMENT_MINUTES {
        return Err(bad("increment must be at most 1440 minutes"));
    }
    Ok(())
}

pub fn clean_non_negative(v: f64, field: &str) -> Result<f64, CoreError> {
    if v.is_finite() && (0.0..=1e9).contains(&v) {
        Ok(v)
    } else {
        Err(bad(format!(
            "{field} must be a number between 0 and 1000000000"
        )))
    }
}

/// Allow-lists the TipTap document so nothing except known nodes and marks is ever stored.
pub fn check_description(doc: &Value) -> Result<(), CoreError> {
    if doc.is_null() {
        return Ok(());
    }
    if serde_json::to_string(doc)?.len() > MAX_DESCRIPTION_BYTES {
        return Err(bad("description is too large"));
    }
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(bad("description must be a document"));
    }
    check_node(doc, 0)
}

fn check_node(node: &Value, depth: usize) -> Result<(), CoreError> {
    if depth > MAX_DOC_DEPTH {
        return Err(bad("description is nested too deeply"));
    }
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    if !NODE_TYPES.contains(&kind) {
        return Err(bad(format!(
            "description contains an unsupported node: {kind}"
        )));
    }
    if let Some(id) = node.get("attrs").and_then(|a| a.get("subtaskId"))
        && !id.is_null()
        && !id.as_str().is_some_and(|i| i.len() <= 64)
    {
        return Err(bad("description contains an invalid subtask id"));
    }
    if let Some(marks) = node.get("marks") {
        let marks = marks
            .as_array()
            .ok_or_else(|| bad("description marks are invalid"))?;
        for m in marks {
            let name = m.get("type").and_then(Value::as_str).unwrap_or_default();
            if !MARK_TYPES.contains(&name) {
                return Err(bad(format!(
                    "description contains an unsupported mark: {name}"
                )));
            }
        }
    }
    if let Some(content) = node.get("content") {
        let content = content
            .as_array()
            .ok_or_else(|| bad("description content is invalid"))?;
        for child in content {
            check_node(child, depth + 1)?;
        }
    }
    Ok(())
}

/// `HH:MM`, 24-hour.
pub fn check_hhmm(raw: &str, field: &str) -> Result<(), CoreError> {
    let parsed = raw.split_once(':').and_then(|(h, m)| {
        if h.len() == 2 && m.len() == 2 {
            Some((h.parse::<u8>().ok()?, m.parse::<u8>().ok()?))
        } else {
            None
        }
    });
    match parsed {
        Some((h, m)) if h < 24 && m < 60 => Ok(()),
        _ => Err(bad(format!("{field} must look like 09:30"))),
    }
}

pub fn check_date(raw: &str, field: &str) -> Result<(), CoreError> {
    chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| bad(format!("{field} must look like 2026-03-08")))
}

pub fn check_shift(s: &ShiftVersion) -> Result<(), CoreError> {
    clean_text(&s.name, "Shift name", MAX_PROJECT_NAME)?;
    clean_color(&s.color)?;
    check_hhmm(&s.start, "Shift start")?;
    check_hhmm(&s.end, "Shift end")?;
    check_date(&s.effective_from, "Effective date")?;
    parse_zone(&s.zone)?;
    if s.weekdays.is_empty() && !s.retired {
        return Err(bad("choose at least one weekday"));
    }
    if s.weekdays.iter().any(|d| !(1..=7).contains(d)) {
        return Err(bad("weekdays must be 1 (Monday) to 7 (Sunday)"));
    }
    if s.break_minutes > 24 * 60 {
        return Err(bad("break allowance is longer than a day"));
    }
    Ok(())
}

fn check_project(p: &Project) -> Result<(), CoreError> {
    clean_color(&p.color)?;
    if p.name.chars().count() > MAX_PROJECT_NAME * 4 {
        return Err(bad("project name too long"));
    }
    if let Some(b) = p.budget_hours {
        clean_non_negative(b, "budget")?;
    }
    if let Some(z) = &p.client_zone {
        parse_zone(z)?;
    }
    Ok(())
}

fn check_task(t: &Task) -> Result<(), CoreError> {
    if t.name.chars().count() > MAX_NAME * 4 {
        return Err(bad("task name too long"));
    }
    check_description(&t.description)
}

/// The oldest date a synced record may carry, and how far ahead of this clock it may be.
const EARLIEST: Ts = Ts::EARLIEST;
const MAX_SKEW_SECS: i64 = 2 * 86_400;
const FAR_FUTURE: Ts = Ts(4_102_444_800); // 2100-01-01, for chosen effective dates
pub const MAX_SEGMENT_SECS: i64 = 366 * 86_400;
const MAX_RECORDS: usize = 1_000_000;
const MAX_ID_LEN: usize = 64;

fn check_time(t: Ts, now: Ts, what: &str) -> Result<(), CoreError> {
    if t < EARLIEST || t > now.later(MAX_SKEW_SECS) {
        return Err(bad(format!("{what} is outside the plausible time range")));
    }
    Ok(())
}

fn check_stamp(s: &Stamp, now: Ts) -> Result<(), CoreError> {
    check_time(s.at, now, "a change stamp")?;
    if s.by.len() > MAX_ID_LEN {
        Err(bad("a device id is too long"))
    } else {
        Ok(())
    }
}

fn check_id(id: &str) -> Result<(), CoreError> {
    if id.is_empty() || id.len() > MAX_ID_LEN {
        Err(bad("an id has an invalid length"))
    } else {
        Ok(())
    }
}

fn check_plain(text: &str, max: usize, what: &str) -> Result<(), CoreError> {
    if text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(bad(format!("{what} is too long or has control characters")));
    }
    Ok(())
}

/// Device-level checks on a file from a sync folder, on top of `check_shared`.
pub fn check_device_file(f: &DeviceFile, now: Ts) -> Result<(), CoreError> {
    check_plain(&f.device_name, MAX_NAME, "the device name")?;
    check_time(f.written_at, now, "the file's write time")?;
    if let Some(h) = f.last_heartbeat {
        check_time(h, now, "the heartbeat")?;
    }
    check_shared(&f.data, now)
}

/// A file from a sync folder that fails this is skipped as a whole, so nothing implausible enters
/// the store. Timestamps must stay in a sane window: a far-future stamp would otherwise win every
/// merge and could not be saved.
pub fn check_shared(s: &Shared, now: Ts) -> Result<(), CoreError> {
    check_core(s)?;
    let total = s.projects.len()
        + s.tasks.len()
        + s.segments.len()
        + s.settings.len()
        + s.shifts.len()
        + s.rates.len()
        + s.rounding.len()
        + s.gaps.len()
        + s.pauses.len()
        + s.tags.len()
        + s.templates.len()
        + s.summaries.len()
        + s.prefixes.len()
        + s.audit_log.len();
    if total > MAX_RECORDS {
        return Err(bad("too many records"));
    }
    for p in s.projects.values() {
        check_id(&p.id)?;
        check_plain(&p.name, MAX_PROJECT_NAME * 4, "a project name")?;
        check_time(p.created_at, now, "a project date")?;
        check_stamp(&p.stamp, now)?;
    }
    for t in s.tasks.values() {
        check_id(&t.id)?;
        check_plain(&t.name, MAX_NAME * 4, "a task name")?;
        check_time(t.created_at, now, "a task date")?;
        for stamp in [
            &t.name_stamp,
            &t.project_stamp,
            &t.description_stamp,
            &t.deleted_stamp,
            &t.state_stamp,
        ] {
            check_stamp(stamp, now)?;
        }
        if let Some(at) = t.stopped_at {
            check_time(at, now, "a stop time")?;
        }
    }
    for seg in s.segments.values() {
        check_id(&seg.id)?;
        check_time(seg.start, now, "a segment start")?;
        if let Some(end) = seg.end {
            check_time(end, now, "a segment end")?;
            if end < seg.start || end.secs() - seg.start.secs() > MAX_SEGMENT_SECS {
                return Err(bad("a segment has an impossible duration"));
            }
        }
    }
    for (key, entry) in &s.settings {
        crate::machine::check_setting(key, &entry.value)?;
        check_stamp(&entry.stamp, now)?;
    }
    for v in s.shifts.values() {
        check_id(&v.id)?;
        check_stamp(&v.stamp, now)?;
    }
    for v in s.rates.values() {
        check_id(&v.id)?;
        check_stamp(&v.stamp, now)?;
        if v.effective_from < EARLIEST || v.effective_from > FAR_FUTURE {
            return Err(bad("a price date is outside the plausible range"));
        }
    }
    for v in s.rounding.values() {
        check_id(&v.id)?;
        check_stamp(&v.stamp, now)?;
    }

    check_phase2(s, now)?;

    for (id, v) in &s.rates {
        if *id != v.id {
            return Err(bad("rate id mismatch"));
        }
        check_rate(v)?;
    }
    for (id, v) in &s.rounding {
        if *id != v.id {
            return Err(bad("rounding id mismatch"));
        }
        check_rounding(v)?;
    }
    Ok(())
}

fn check_span(start: Ts, end: Ts, now: Ts, what: &str) -> Result<(), CoreError> {
    check_time(start, now, what)?;
    check_time(end, now, what)?;
    if end < start || end.secs() - start.secs() > MAX_SEGMENT_SECS {
        return Err(bad(format!("{what} has an impossible duration")));
    }
    Ok(())
}

fn check_phase2(s: &Shared, now: Ts) -> Result<(), CoreError> {
    for seg in s.segments.values() {
        check_stamp(&seg.edit_stamp, now)?;
        if let Some(e) = &seg.edit {
            check_span(e.start, e.end, now, "a correction")?;
            check_plain(&e.reason, MAX_NAME * 8, "a reason")?;
        }
    }
    for t in s.tasks.values() {
        check_stamp(&t.tags_stamp, now)?;
        check_stamp(&t.active_subtask_stamp, now)?;
        if t.tags.len() > 64 {
            return Err(bad("a task has too many tags"));
        }
    }
    for g in s.gaps.values() {
        check_id(&g.id)?;
        check_span(g.start, g.end, now, "time away")?;
        check_stamp(&g.decision_stamp, now)?;
    }
    for p in s.pauses.values() {
        check_id(&p.id)?;
        check_span(p.start, p.end, now, "a billable pause")?;
        check_plain(&p.note, MAX_NAME * 8, "a note")?;
        check_stamp(&p.stamp, now)?;
    }
    for t in s.tags.values() {
        check_id(&t.id)?;
        check_plain(&t.name, MAX_NAME, "a tag name")?;
        clean_color(&t.color)?;
        check_stamp(&t.stamp, now)?;
    }
    for t in s.templates.values() {
        check_id(&t.id)?;
        check_plain(&t.name, MAX_NAME * 4, "a template name")?;
        check_description(&t.description)?;
        check_stamp(&t.stamp, now)?;
    }
    for b in s.summaries.values() {
        check_id(&b.id)?;
        check_plain(&b.reference, MAX_NAME, "a reference")?;
        check_time(b.created_at, now, "a summary date")?;
        check_stamp(&b.stamp, now)?;
    }
    for p in s.prefixes.values() {
        check_plain(&p.prefix, 16, "a reference prefix")?;
        check_stamp(&p.stamp, now)?;
    }
    for a in s.audit_log.values() {
        check_id(&a.id)?;
        check_time(a.at, now, "an audit entry")?;
        check_plain(&a.reason, MAX_NAME * 8, "an audit reason")?;
    }
    Ok(())
}

/// Used for the local file, where an unusable rate or rounding record is ignored when computing
/// rather than treated as file corruption, so a single bad record can never cost the user their data.
pub fn check_core(s: &Shared) -> Result<(), CoreError> {
    for (id, p) in &s.projects {
        if *id != p.id {
            return Err(bad("project id mismatch"));
        }
        check_project(p)?;
    }
    for (id, t) in &s.tasks {
        if *id != t.id {
            return Err(bad("task id mismatch"));
        }
        check_task(t)?;
    }
    for (id, v) in &s.shifts {
        if *id != v.id {
            return Err(bad("shift id mismatch"));
        }
        check_shift(v)?;
    }
    for (id, seg) in &s.segments {
        if *id != seg.id {
            return Err(bad("segment id mismatch"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_rules() {
        assert!(clean_text("   ", "Name", 10).is_err());
        assert_eq!(clean_text("  ok ", "Name", 10).unwrap(), "ok");
        assert!(clean_text("abcdefghijk", "Name", 10).is_err());
        assert!(clean_text("a\u{0007}b", "Name", 10).is_err());
    }

    #[test]
    fn colors_and_zones() {
        assert_eq!(clean_color("#AABBCC").unwrap(), "#aabbcc");
        assert!(clean_color("red").is_err());
        assert!(clean_color("#12345g").is_err());
        assert!(parse_zone("America/New_York").is_ok());
        assert!(parse_zone("Asia/Kolkata").is_ok());
        assert!(parse_zone("Mars/Olympus").is_err());
    }

    #[test]
    fn description_allow_list() {
        let ok = json!({"type":"doc","content":[{"type":"orderedList","content":[{"type":"listItem",
            "content":[{"type":"paragraph","content":[{"type":"text","text":"a","marks":[{"type":"bold"}]}]}]}]}]});
        assert!(check_description(&ok).is_ok());
        assert!(check_description(&Value::Null).is_ok());
        let img =
            json!({"type":"doc","content":[{"type":"image","attrs":{"src":"http://x/y.png"}}]});
        assert!(check_description(&img).is_err());
        let link = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a",
            "marks":[{"type":"link","attrs":{"href":"http://x"}}]}]}]});
        assert!(check_description(&link).is_err());
        assert!(check_description(&json!({"type":"paragraph"})).is_err());
        assert!(check_description(&json!("<b>html</b>")).is_err());
    }
}
