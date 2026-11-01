//! Pure core of zWorkTracker. Nothing here depends on Tauri, and time only comes from a [`Clock`].
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod adjust;
pub mod backup;
pub mod billing;
pub mod catalog;
pub mod colors;
pub mod csv;
pub mod detect;
pub mod drafts;
pub mod error;
pub mod idle;
pub mod machine;
pub mod merge;
pub mod model;
pub mod pdf;
mod pdffont;
pub mod persist;
pub mod pieces;
pub mod reminder;
pub mod report;
pub mod service;
pub mod subtasks;
pub mod summary;
pub mod sync;
pub mod time;
pub mod tray;
pub mod validate;
pub mod view;
pub mod xlsx;

pub use error::CoreError;
pub use time::{Clock, ManualClock, SystemClock, Ts};

#[cfg(test)]
mod licence {
    /// The repository is public and every manifest says MIT, so an empty file here must fail the gates.
    #[test]
    fn the_licence_file_holds_the_mit_text_and_names_the_holder() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../LICENSE");
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.starts_with("MIT License"));
        assert!(text.contains("Copyright (c) 2026 Pedro Jorge"));
        assert!(text.contains("THE SOFTWARE IS PROVIDED \"AS IS\""));
    }
}

#[cfg(test)]
mod no_network {
    /// The app makes no network calls. This fails if an HTTP or TLS stack enters the compiled graph
    /// of either desktop target. The lockfile itself may list crates only mobile targets would use.
    #[test]
    fn no_http_or_tls_crate_is_compiled() {
        for target in ["x86_64-pc-windows-gnu", "aarch64-apple-darwin"] {
            let out = std::process::Command::new(env!("CARGO"))
                .args([
                    "tree",
                    "--offline",
                    "--workspace",
                    "--prefix",
                    "none",
                    "--target",
                    target,
                ])
                .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "cargo tree failed for {target}; run `cargo fetch --locked` first if crates are missing: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let tree = String::from_utf8_lossy(&out.stdout);
            assert!(
                tree.lines().count() > 100,
                "unexpectedly small tree for {target}"
            );
            for banned in [
                "reqwest",
                "hyper",
                "rustls",
                "ureq",
                "native-tls",
                "openssl",
                "isahc",
                "curl",
                "keyring",
                "oauth2",
                "h2",
            ] {
                assert!(
                    !tree.lines().any(|l| l.starts_with(&format!("{banned} "))),
                    "{banned} is compiled for {target}"
                );
            }
        }
    }
}
