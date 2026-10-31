use thiserror::Error;

/// Errors returned to the UI. `code()` is stable and machine-readable.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CoreError {
    #[error("{0}")]
    Validation(String),
    #[error("{0} not found")]
    NotFound(&'static str),
    #[error("cannot {action} a task that is {state}")]
    IllegalTransition {
        action: &'static str,
        state: &'static str,
    },
    #[error("this task is running on another device ({0}); pause it there")]
    RunningElsewhere(String),
    #[error("{0}")]
    Conflict(String),
    #[error("could not save data: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not encode data: {0}")]
    Json(#[from] serde_json::Error),
    #[error(
        "data file was written by a newer app version ({found}, this app supports {supported}); it was left untouched"
    )]
    FutureVersion { found: u64, supported: u64 },
    #[error("could not build spreadsheet: {0}")]
    Xlsx(String),
    #[error("data store is not available: {0}")]
    StoreUnavailable(String),
}

impl CoreError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation",
            Self::NotFound(_) => "not_found",
            Self::IllegalTransition { .. } => "illegal_transition",
            Self::RunningElsewhere(_) => "running_elsewhere",
            Self::Conflict(_) => "conflict",
            Self::Io(_) | Self::Json(_) | Self::Xlsx(_) => "io",
            Self::FutureVersion { .. } => "future_version",
            Self::StoreUnavailable(_) => "store_unavailable",
        }
    }
}
