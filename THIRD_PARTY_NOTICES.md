# Third-party notices

zWorkTracker is MIT licensed (see `LICENSE`). It includes or is built with the components below, under their own licences. The per-package list comes from package metadata; regenerate it before a release with `pnpm licenses list --prod` and `cargo metadata`.

## Data bundled in the app

| Component | Licence | Used for | Note |
|---|---|---|---|
| Time zone boundaries in `@photostructure/tz-lookup`, derived from [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) | Package: CC0-1.0. Source boundaries: derived from OpenStreetMap, © OpenStreetMap contributors, Open Database License (ODbL) | Map click to time zone | **ODbL is not an OSI licence.** See below |
| [Natural Earth](https://www.naturalearthdata.com/) country outlines in `world-atlas` | Data: public domain. Package: ISC, © Michael Bostock | Map outlines | |
| IANA Time Zone Database in `chrono-tz` and `src/generated/tzdata.json` | Data: public domain. `chrono-tz`: MIT OR Apache-2.0 | Time zone rules | |

### The ODbL question

The app's source code is MIT licensed, but the map lookup carries data that derives from an ODbL database. The package declares CC0-1.0, and the attribution above is kept either way. SignPath Foundation's terms ask for an OSI-approved licence "for all components", so this data may need a ruling from them.

All boundary lookups go through one file, `src/features/zones/geo.ts`, and the map is optional: the searchable zone list works without it. To replace or remove the data, change that file and the `@photostructure/tz-lookup` dependency.

## Binaries included in the installer

| Component | Licence | Note |
|---|---|---|
| `WebView2Loader` from the Microsoft WebView2 SDK, through `webview2-com-sys` | Microsoft's SDK licence; the crate itself declares MIT | Bundled as a DLL in the MinGW build, linked statically in the MSVC build. Check the SDK licence text before a public release |
| NSIS installer stub | zlib/libpng, with bzip2 and other notices | Installer only |
| `nsis_tauri_utils` plugin | MIT OR Apache-2.0 | Installer only |
| GCC runtime and winpthreads | GPL with the GCC Runtime Library Exception, and MIT/BSD | Statically linked into the MinGW build only |

## Libraries

**Rust (shipped):** Tauri and its plugins, chrono, chrono-tz, rust_xlsxwriter, pdf-writer, png, miniz_oxide, user-idle, winreg, serde and their dependencies, under MIT, Apache-2.0, BSD-3-Clause, ISC, Zlib, Unlicense, MPL-2.0 and Unicode-3.0, each as declared by the crate.

**JavaScript (shipped):** React, TipTap, ProseMirror, `@tauri-apps/api`, `topojson-client` and their dependencies, under MIT, ISC, Apache-2.0 OR MIT and CC0-1.0.

## Not bundled

Fonts come from the operating system (Segoe UI, Cascadia Mono), and none ship with the app. The app icon and interface icons were drawn for this project. The WebView2 Runtime is part of Windows 11 and isn't redistributed.
