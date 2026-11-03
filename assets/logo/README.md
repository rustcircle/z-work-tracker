# zWorkTracker logo

`logo.svg` is the only hand-made file here: a pendulum regulator wall clock with a rainbow dial.
Everything else is generated from it, never edited by hand:
the app icons in `src-tauri/icons` (PNGs, `.ico`, `.icns`) and `site/assets` (`logo.svg`, `favicon.svg`, `icon-64.png`, `apple-touch-icon.png`).
The Store logos are cut from `icon.png` by `scripts/package-msix.mjs`.

Regenerate from the repo root with `uv run assets/logo/build-icons.py`.
The `.icns` needs macOS (`iconutil`). The tray icons are separate files and are not generated.
