//! Rows for the spreadsheet and CSV exports, sorted for reading. All user text stays plain text here.

use std::collections::BTreeMap;

use chrono_tz::Tz;
use serde::Deserialize;

use crate::billing::{TaskDay, task_days};
use crate::model::{RemoteDevice, Segment, Shared};
use crate::subtasks;
use crate::time::Ts;

/// What exports read: a consistent copy taken under the lock, so writing can happen outside it.
#[derive(Clone, Debug)]
pub struct ExportSource {
    pub data: Shared,
    pub device_id: String,
    pub remote_devices: BTreeMap<String, RemoteDevice>,
    pub now: Ts,
}

impl ExportSource {
    /// Own open segments run to now. Another device's open segment counts only up to its last
    /// heartbeat, since nothing newer is known about it.
    #[must_use]
    pub fn end_of(&self, seg: &Segment) -> Ts {
        match seg.end {
            Some(e) => e.max(seg.start),
            None if seg.device_id == self.device_id => self.now.max(seg.start),
            None => self
                .remote_devices
                .get(&seg.device_id)
                .and_then(|d| d.last_heartbeat)
                .map_or(seg.start, |h| h.max(seg.start)),
        }
    }

    #[must_use]
    pub fn rows(&self, tz: Tz) -> Vec<DayRow> {
        let end = |s: &Segment| self.end_of(s);
        let mut rows: Vec<DayRow> = task_days(&self.data, tz, &end)
            .into_iter()
            .map(|td| {
                let project = self.data.projects.get(&td.project_id);
                let task = self.data.tasks.get(&td.task_id);
                DayRow {
                    project_name: project
                        .map_or_else(|| "(unknown project)".to_owned(), |p| p.name.clone()),
                    project_color: project
                        .map_or_else(|| "#808080".to_owned(), |p| p.color.clone()),
                    task_name: task.map_or_else(String::new, |t| t.name.clone()),
                    subtasks: task.map_or_else(String::new, |t| subtasks::extract(&t.description)),
                    row: td,
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            a.project_name
                .to_lowercase()
                .cmp(&b.project_name.to_lowercase())
                .then_with(|| a.project_name.cmp(&b.project_name))
                .then_with(|| a.row.day.cmp(&b.row.day))
                .then_with(|| a.row.first_start.cmp(&b.row.first_start))
                .then_with(|| a.row.task_id.cmp(&b.row.task_id))
        });
        rows
    }

    /// Segments in start order, with names resolved.
    #[must_use]
    pub fn segments(&self) -> Vec<SegmentRow> {
        let mut rows: Vec<SegmentRow> = self
            .data
            .segments
            .values()
            .filter_map(|s| {
                let task = self.data.tasks.get(&s.task_id).filter(|t| !t.deleted)?;
                let project = self.data.projects.get(&task.project_id);
                Some(SegmentRow {
                    segment_id: s.id.clone(),
                    task_name: task.name.clone(),
                    project_id: task.project_id.clone(),
                    project_name: project
                        .map_or_else(|| "(unknown project)".to_owned(), |p| p.name.clone()),
                    start: s.start,
                    end: s.end,
                    effective_end: self.end_of(s),
                })
            })
            .collect();
        rows.sort_by(|a, b| {
            a.start
                .cmp(&b.start)
                .then_with(|| a.segment_id.cmp(&b.segment_id))
        });
        rows
    }
}

#[derive(Clone, Debug)]
pub struct DayRow {
    pub project_name: String,
    pub project_color: String,
    pub task_name: String,
    pub subtasks: String,
    pub row: TaskDay,
}

#[derive(Clone, Debug)]
pub struct SegmentRow {
    pub segment_id: String,
    pub task_name: String,
    pub project_id: String,
    pub project_name: String,
    pub start: Ts,
    /// `None` while the segment is still open.
    pub end: Option<Ts>,
    pub effective_end: Ts,
}

/// Chosen in the export dialog. Zones are validated before use.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub day_zone: String,
    pub my_zone: String,
    #[serde(default)]
    pub client_zone: Option<String>,
    #[serde(default)]
    pub include_earnings: bool,
    /// Segment id to shift attribution text, computed by the UI's shift module.
    #[serde(default)]
    pub segment_shifts: BTreeMap<String, String>,
    /// Summary sheets computed by the UI's analytics modules, so they match the screen exactly.
    #[serde(default)]
    pub analytics: Vec<AnalyticsSheet>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CellKind {
    Text,
    Int,
    Number,
    Percent,
    /// Seconds, written as an Excel duration.
    Duration,
    /// Exact amount in cents, written with a currency format.
    Eur,
    Usd,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsColumn {
    pub header: String,
    pub kind: CellKind,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSheet {
    pub name: String,
    pub title: String,
    pub columns: Vec<AnalyticsColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// Sheets holding prices are left out of a client-facing export.
    #[serde(default)]
    pub contains_prices: bool,
}

/// `2026-03-08 09:00:00 -04:00`. The offset keeps repeated fall-back hours unambiguous.
#[must_use]
pub fn zoned(t: Ts, tz: Tz) -> String {
    t.datetime()
        .with_timezone(&tz)
        .format("%Y-%m-%d %H:%M:%S %:z")
        .to_string()
}

#[must_use]
pub fn hms(secs: i64) -> String {
    format!("{}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::billing::tests::{fixture, seg};
    use crate::machine::tests::{DEV, ctx, project_input, task_input};
    use crate::model::RoundMethod;
    use crate::validate::parse_zone;

    pub fn source(data: Shared, now: &str) -> ExportSource {
        ExportSource {
            data,
            device_id: DEV.into(),
            remote_devices: BTreeMap::new(),
            now: Ts::parse(now).unwrap(),
        }
    }

    #[test]
    fn sorted_by_project_day_then_start_with_a_row_per_task_per_day() {
        let (mut s, p, t) = fixture(Some((0, RoundMethod::Nearest)));
        let c = ctx("2026-01-01T00:00:00Z");
        let other = s.create_project(&c, &project_input("aardvark")).unwrap();
        let t2 = s.create_task(&c, &task_input("Other", &other)).unwrap();
        let t3 = s.create_task(&c, &task_input("Second", &p)).unwrap();
        seg(
            &mut s,
            &t,
            "a",
            "2026-02-03T09:00:00Z",
            "2026-02-03T10:00:00Z",
        );
        seg(
            &mut s,
            &t3,
            "b",
            "2026-02-02T15:00:00Z",
            "2026-02-02T15:30:00Z",
        );
        seg(
            &mut s,
            &t,
            "c",
            "2026-02-02T09:00:00Z",
            "2026-02-02T09:15:00Z",
        );
        seg(
            &mut s,
            &t,
            "d",
            "2026-02-02T11:00:00Z",
            "2026-02-02T11:15:00Z",
        );
        seg(
            &mut s,
            &t2,
            "e",
            "2026-02-09T09:00:00Z",
            "2026-02-09T09:15:00Z",
        );
        let rows = source(s, "2026-03-01T00:00:00Z").rows(parse_zone("UTC").unwrap());
        let got: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.project_name.as_str(),
                    r.row.day.to_string(),
                    r.task_name.as_str(),
                    r.row.exact_secs,
                )
            })
            .collect();
        assert_eq!(
            got,
            [
                ("aardvark", "2026-02-09".to_string(), "Other", 900),
                ("Alpha", "2026-02-02".to_string(), "Write", 1800),
                ("Alpha", "2026-02-02".to_string(), "Second", 1800),
                ("Alpha", "2026-02-03".to_string(), "Write", 3600),
            ]
        );
    }

    #[test]
    fn day_follows_the_zone() {
        let (mut s, _, t) = fixture(Some((0, RoundMethod::Nearest)));
        seg(
            &mut s,
            &t,
            "a",
            "2026-02-03T02:00:00Z",
            "2026-02-03T03:00:00Z",
        );
        let src = source(s, "2026-03-01T00:00:00Z");
        assert_eq!(
            src.rows(parse_zone("UTC").unwrap())[0].row.day.to_string(),
            "2026-02-03"
        );
        assert_eq!(
            src.rows(parse_zone("America/Los_Angeles").unwrap())[0]
                .row
                .day
                .to_string(),
            "2026-02-02"
        );
        assert_eq!(
            src.rows(parse_zone("Asia/Kathmandu").unwrap())[0]
                .row
                .day
                .to_string(),
            "2026-02-03"
        );
    }

    #[test]
    fn open_segments_end_now_when_own_and_at_heartbeat_when_remote() {
        let (mut s, _, t) = fixture(Some((0, RoundMethod::Nearest)));
        s.segments.insert(
            "o".into(),
            Segment {
                id: "o".into(),
                task_id: t.clone(),
                device_id: DEV.into(),
                start: Ts::parse("2026-02-02T09:00:00Z").unwrap(),
                end: None,
            },
        );
        s.segments.insert(
            "r".into(),
            Segment {
                id: "r".into(),
                task_id: t,
                device_id: "other".into(),
                start: Ts::parse("2026-02-02T09:00:00Z").unwrap(),
                end: None,
            },
        );
        let mut src = source(s, "2026-02-02T09:10:00Z");
        src.remote_devices.insert(
            "other".into(),
            RemoteDevice {
                name: "PC2".into(),
                last_heartbeat: Ts::parse("2026-02-02T09:05:00Z"),
                written_at: Ts(0),
            },
        );
        let segs = src.segments();
        let by = |id: &str| {
            segs.iter()
                .find(|x| x.segment_id == id)
                .unwrap()
                .effective_end
                .iso()
        };
        assert_eq!(by("o"), "2026-02-02T09:10:00Z");
        assert_eq!(by("r"), "2026-02-02T09:05:00Z");
    }
}
