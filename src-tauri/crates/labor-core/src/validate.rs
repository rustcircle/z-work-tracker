//! Validation of everything entering the core from the UI or from another device's file.

use std::str::FromStr;

use chrono_tz::Tz;
use serde_json::Value;

use crate::error::CoreError;
use crate::model::{Project, RateVersion, RoundingVersion, Shared, ShiftVersion, Task};

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
        Err(bad("project color must look like #1a2b3c"))
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

/// A remote device file that fails this is skipped as a whole.
pub fn check_shared(s: &Shared) -> Result<(), CoreError> {
    check_core(s)?;
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
