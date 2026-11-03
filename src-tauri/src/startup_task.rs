//! Start with Windows for the Microsoft Store (packaged) build, through the manifest's `StartupTask`.
//!
//! A packaged app's writes to HKCU are private to it, so the Run entry the autostart plugin writes would never start
//! anything there. Windows decides about the task and can refuse, so what it reports is what the page shows. The
//! installer build keeps the plugin. The mapping is pure and tested everywhere; only the calls are Windows-only.

use serde::Serialize;

/// The `TaskId` of the manifest's startup task, in `scripts/msix-manifest.mjs`.
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only the Windows calls use it")
)]
pub const TASK_ID: &str = "zWorkTrackerStartup";

/// Start with Windows as Windows reports it, or as the plugin does for the installer build (`on` or `off`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only the Windows calls use it")
)]
pub enum AutostartState {
    On,
    Off,
    /// Turned off in Task Manager or Settings. Only the user can turn it back on, there.
    OffByUser,
    OffByPolicy,
    OnByPolicy,
    /// Windows couldn't find or read the task.
    Unavailable,
}

impl AutostartState {
    /// From the value of `Windows.ApplicationModel.StartupTaskState`, or `None` when the task couldn't be read.
    #[must_use]
    #[cfg_attr(
        not(windows),
        allow(dead_code, reason = "only the Windows calls use it")
    )]
    pub const fn from_windows(state: Option<i32>) -> Self {
        match state {
            Some(0) => Self::Off,
            Some(1) => Self::OffByUser,
            Some(2) => Self::On,
            Some(3) => Self::OffByPolicy,
            Some(4) => Self::OnByPolicy,
            _ => Self::Unavailable,
        }
    }

    #[must_use]
    pub const fn is_on(self) -> bool {
        matches!(self, Self::On | Self::OnByPolicy)
    }

    /// Whether the switch can move from here.
    #[must_use]
    pub const fn can_change(self) -> bool {
        matches!(self, Self::On | Self::Off)
    }

    /// Why the switch can't move, for the page.
    #[must_use]
    pub const fn note(self) -> Option<&'static str> {
        match self {
            Self::On | Self::Off => None,
            Self::OffByUser => Some(
                "You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.",
            ),
            Self::OffByPolicy => Some(
                "A policy on this computer doesn't allow this, or the device doesn't support it.",
            ),
            Self::OnByPolicy => Some("A policy on this computer keeps this on."),
            Self::Unavailable => Some("Windows couldn't find this app's startup entry."),
        }
    }
}

/// What the Start with Windows switch shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartInfo {
    pub packaged: bool,
    pub state: AutostartState,
    pub can_change: bool,
    pub note: Option<&'static str>,
}

impl AutostartInfo {
    #[must_use]
    pub const fn of(packaged: bool, state: AutostartState) -> Self {
        Self {
            packaged,
            state,
            can_change: state.can_change(),
            note: state.note(),
        }
    }
}

/// What asking to turn it on or off came to: whether it is on now, or why Windows wouldn't do it.
#[cfg_attr(
    not(windows),
    allow(dead_code, reason = "only the Windows calls use it")
)]
pub fn outcome(enabled: bool, state: AutostartState) -> Result<bool, &'static str> {
    if state == AutostartState::Unavailable || state.is_on() != enabled {
        return Err(state.note().unwrap_or(if enabled {
            "Windows didn't turn this on. You can turn it on in Settings > Apps > Startup."
        } else {
            "Windows didn't turn this off. You can turn it off in Settings > Apps > Startup."
        }));
    }
    Ok(enabled)
}

#[cfg(windows)]
mod task {
    use windows::ApplicationModel::StartupTask;
    use windows::core::{HSTRING, Result};

    use super::{AutostartState, TASK_ID};

    /// Each call waits for Windows, so these run on a command thread, never the UI thread.
    fn task() -> Result<StartupTask> {
        StartupTask::GetAsync(&HSTRING::from(TASK_ID))?.join()
    }

    fn report(
        asked: &str,
        answer: Result<windows::ApplicationModel::StartupTaskState>,
    ) -> AutostartState {
        match answer {
            Ok(state) => AutostartState::from_windows(Some(state.0)),
            Err(e) => {
                eprintln!("startup task: {asked} failed: {e}");
                AutostartState::Unavailable
            }
        }
    }

    pub fn state() -> AutostartState {
        report("reading", task().and_then(|t| t.State()))
    }

    /// Windows shows no prompt to a packaged desktop app, and leaves a task the user turned off as it is.
    pub fn request_enable() -> AutostartState {
        report(
            "turning on",
            task().and_then(|t| t.RequestEnableAsync()?.join()),
        )
    }

    pub fn disable() -> AutostartState {
        report(
            "turning off",
            task().and_then(|t| {
                t.Disable()?;
                t.State()
            }),
        )
    }
}

#[cfg(windows)]
pub use task::{disable, request_enable, state};

#[cfg(test)]
mod tests {
    use super::*;

    /// Test 63: the task the app asks Windows for is the one the package declares.
    #[test]
    fn task_id_matches_manifest() {
        let manifest = include_str!("../../scripts/msix-manifest.mjs");
        let ids: Vec<&str> = manifest
            .split("TaskId=\"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert_eq!(ids, [TASK_ID], "one startup task, with this id");
    }

    #[test]
    fn each_windows_state_reads_as_the_design_says() {
        let table = [
            (Some(2), AutostartState::On, true, true),
            (Some(0), AutostartState::Off, false, true),
            (Some(1), AutostartState::OffByUser, false, false),
            (Some(3), AutostartState::OffByPolicy, false, false),
            (Some(4), AutostartState::OnByPolicy, true, false),
            (None, AutostartState::Unavailable, false, false),
            (Some(99), AutostartState::Unavailable, false, false),
        ];
        for (raw, state, on, can_change) in table {
            assert_eq!(AutostartState::from_windows(raw), state, "{raw:?}");
            assert_eq!(state.is_on(), on, "{state:?}");
            let info = AutostartInfo::of(true, state);
            assert_eq!(info.can_change, can_change, "{state:?}");
            assert_eq!(
                info.note.is_none(),
                can_change,
                "a note exactly when it can't move"
            );
        }
    }

    /// The same words as the page's mock (`AUTOSTART_NOTES` in src/mocks/ipcMock.ts).
    #[test]
    fn info_serializes_as_the_page_expects() {
        let v = serde_json::to_value(AutostartInfo::of(true, AutostartState::OffByUser))
            .unwrap_or_default();
        assert_eq!(
            v,
            serde_json::json!({
                "packaged": true,
                "state": "offByUser",
                "canChange": false,
                "note": "You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup."
            })
        );
        let v =
            serde_json::to_value(AutostartInfo::of(false, AutostartState::On)).unwrap_or_default();
        assert_eq!(
            v,
            serde_json::json!({"packaged": false, "state": "on", "canChange": true, "note": null})
        );
    }

    #[test]
    fn a_switch_windows_will_not_move_is_an_error_with_its_reason() {
        assert_eq!(outcome(true, AutostartState::On), Ok(true));
        assert_eq!(outcome(false, AutostartState::Off), Ok(false));
        assert_eq!(outcome(true, AutostartState::OnByPolicy), Ok(true));
        assert_eq!(outcome(false, AutostartState::OffByUser), Ok(false));
        assert_eq!(outcome(false, AutostartState::OffByPolicy), Ok(false));
        assert_eq!(
            outcome(true, AutostartState::OffByUser),
            Err(AutostartState::OffByUser.note().unwrap_or_default())
        );
        assert_eq!(
            outcome(true, AutostartState::OffByPolicy),
            Err(AutostartState::OffByPolicy.note().unwrap_or_default())
        );
        assert_eq!(
            outcome(false, AutostartState::OnByPolicy),
            Err(AutostartState::OnByPolicy.note().unwrap_or_default())
        );
        for enabled in [true, false] {
            assert_eq!(
                outcome(enabled, AutostartState::Unavailable),
                Err(AutostartState::Unavailable.note().unwrap_or_default())
            );
        }
        assert!(outcome(true, AutostartState::Off).is_err());
        assert!(outcome(false, AutostartState::On).is_err());
    }
}
