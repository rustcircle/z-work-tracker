//! Close-versus-quit decision and tray content, free of any windowing code.

use chrono_tz::Tz;

use crate::billing::{cents_from_numerator, money, task_days};
use crate::model::{LocalFile, Segment, TaskState};
use crate::report::{ExportSource, hms};
use crate::time::Ts;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// Hide the window. The app, its timers and any running task keep going.
    Hide,
    /// Hide after telling the user, once, that the app stays in the tray.
    HideWithNotice,
    /// The tray's Quit or an OS shutdown: really exit.
    Exit,
}

#[must_use]
pub fn close_decision(quit_requested: bool, notice_already_shown: bool) -> CloseDecision {
    if quit_requested {
        CloseDecision::Exit
    } else if notice_already_shown {
        CloseDecision::Hide
    } else {
        CloseDecision::HideWithNotice
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAction {
    Pause,
    Resume,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrayState {
    pub running: bool,
    pub tooltip: String,
    /// The disabled menu line that names the current task.
    pub status_line: String,
    pub action: Option<TrayAction>,
    pub task_id: Option<String>,
}

fn own_running(file: &LocalFile) -> Option<&Segment> {
    file.data.segments.values().find(|s| {
        s.end.is_none()
            && s.device_id == file.device_id
            && file
                .data
                .tasks
                .get(&s.task_id)
                .is_some_and(|t| !t.deleted && t.state == TaskState::Running)
    })
}

/// Today's money for a task in the reporting zone, unless earnings are hidden.
fn earnings_text(file: &LocalFile, task_id: &str, now: Ts, tz: Tz) -> Option<String> {
    if file.prefs.hide_earnings {
        return None;
    }
    // Only this task's records: the tray refreshes often and must stay cheap with years of data.
    let task = file.data.tasks.get(task_id)?.clone();
    let mut data = crate::model::Shared {
        projects: file
            .data
            .projects
            .iter()
            .filter(|(id, _)| **id == task.project_id)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        rates: file.data.rates.clone(),
        rounding: file.data.rounding.clone(),
        segments: file
            .data
            .segments
            .iter()
            .filter(|(_, s)| s.task_id == task_id)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        ..Default::default()
    };
    data.tasks.insert(task.id.clone(), task);
    let source = ExportSource {
        data,
        device_id: file.device_id.clone(),
        remote_devices: file.remote_devices.clone(),
        now,
    };
    let end = |s: &Segment| source.end_of(s);
    let today = crate::billing::day_of(now, tz);
    let row = task_days(&source.data, tz, &end)
        .into_iter()
        .find(|r| r.task_id == task_id && r.day == today)?;
    let parts: Vec<String> = row
        .numerators()
        .iter()
        .map(|(cur, n)| money(cur, cents_from_numerator(*n)))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" + "))
    }
}

/// `zone` is the zone the user is viewing, used for "today".
#[must_use]
pub fn tray_state(file: &LocalFile, now: Ts, zone: Tz) -> TrayState {
    if let Some(seg) = own_running(file) {
        let name = file
            .data
            .tasks
            .get(&seg.task_id)
            .map_or("Task", |t| t.name.as_str());
        let elapsed = (now.secs() - seg.start.secs()).max(0);
        let earnings = earnings_text(file, &seg.task_id, now, zone);
        let money_part = earnings
            .map(|m| format!(" - {m} today"))
            .unwrap_or_default();
        return TrayState {
            running: true,
            tooltip: format!("Running: {name} ({}){money_part}", hms(elapsed)),
            status_line: format!("{name} - {}{money_part}", hms(elapsed)),
            action: Some(TrayAction::Pause),
            task_id: Some(seg.task_id.clone()),
        };
    }
    let latest_paused = file
        .data
        .tasks
        .values()
        .filter(|t| !t.deleted && t.state == TaskState::Paused)
        .filter(|t| {
            file.data
                .projects
                .get(&t.project_id)
                .is_some_and(|p| !p.deleted && !p.archived)
        })
        .max_by_key(|t| {
            file.data
                .segments
                .values()
                .filter(|s| s.task_id == t.id)
                .filter_map(|s| s.end)
                .max()
        });
    match latest_paused {
        Some(t) => TrayState {
            running: false,
            tooltip: "No task running".to_owned(),
            status_line: format!("Paused: {}", t.name),
            action: Some(TrayAction::Resume),
            task_id: Some(t.id.clone()),
        },
        None => TrayState {
            running: false,
            tooltip: "No task running".to_owned(),
            status_line: "No task running".to_owned(),
            action: None,
            task_id: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine::RateInput;
    use crate::machine::tests::{DEV, ctx, project_input, task_input};
    use crate::persist::new_local_file;
    use crate::validate::parse_zone;

    fn file() -> (LocalFile, String) {
        let mut f = new_local_file("pc");
        f.device_id = DEV.into();
        let c = ctx("2026-01-01T08:00:00Z");
        let p = f.data.create_project(&c, &project_input("Alpha")).unwrap();
        f.data
            .set_rate(
                &c,
                &RateInput {
                    project_id: p.clone(),
                    rate_cents: Some(3600),
                    currency: "USD".into(),
                    effective_from: None,
                    confirm_retroactive: false,
                },
            )
            .unwrap();
        let t = f.data.create_task(&c, &task_input("Write", &p)).unwrap();
        (f, t)
    }

    #[test]
    fn close_versus_quit() {
        assert_eq!(close_decision(false, false), CloseDecision::HideWithNotice);
        assert_eq!(close_decision(false, true), CloseDecision::Hide);
        assert_eq!(close_decision(true, false), CloseDecision::Exit);
        assert_eq!(close_decision(true, true), CloseDecision::Exit);
    }

    #[test]
    fn idle_running_paused_and_hidden_earnings() {
        let utc = parse_zone("UTC").unwrap();
        let (mut f, t) = file();
        let now = Ts::parse("2026-01-01T09:30:00Z").unwrap();
        let st = tray_state(&f, now, utc);
        assert!(!st.running);
        assert_eq!(st.tooltip, "No task running");
        assert_eq!(st.action, None);

        f.data.start(&ctx("2026-01-01T09:00:00Z"), &t).unwrap();
        let st = tray_state(&f, now, utc);
        assert!(st.running);
        assert_eq!(st.action, Some(TrayAction::Pause));
        assert!(st.status_line.contains("Write - 0:30:00"));
        // Default rounding: 30 min at $36/h.
        assert!(st.tooltip.contains("$18.00"), "{}", st.tooltip);

        f.prefs.hide_earnings = true;
        let st = tray_state(&f, now, utc);
        assert!(!st.tooltip.contains('$') && !st.status_line.contains('$'));
        f.prefs.hide_earnings = false;

        f.data.pause(&ctx("2026-01-01T09:30:00Z"), &t).unwrap();
        let st = tray_state(&f, now, utc);
        assert!(!st.running);
        assert_eq!(st.action, Some(TrayAction::Resume));
        assert_eq!(st.task_id.as_deref(), Some(t.as_str()));
        assert_eq!(st.tooltip, "No task running");
    }

    #[test]
    fn a_task_running_on_another_device_is_not_this_trays_task() {
        let utc = parse_zone("UTC").unwrap();
        let (mut f, t) = file();
        f.data
            .start(
                &crate::machine::Ctx {
                    now: Ts::parse("2026-01-01T09:00:00Z").unwrap(),
                    device: "other",
                },
                &t,
            )
            .unwrap();
        let st = tray_state(&f, Ts::parse("2026-01-01T09:30:00Z").unwrap(), utc);
        assert!(!st.running);
        assert_eq!(st.action, None);
    }
}
