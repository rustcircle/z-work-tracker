# Third-party notices

zWorkTracker is MIT licensed (see `LICENSE`). It includes or is built with the components below, under their own licences. The per-package list comes from package metadata; regenerate it before a release with `pnpm licenses list --prod` and `cargo metadata`.

## Data bundled in the app

| Component | Licence | Used for | Note |
|---|---|---|---|
| Time zone boundaries in `@photostructure/tz-lookup`, derived from [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) | Package: CC0-1.0. Source boundaries: derived from OpenStreetMap, © OpenStreetMap contributors, Open Database License (ODbL) | Map click to time zone | **ODbL is not an OSI licence.** See below |
| [Natural Earth](https://www.naturalearthdata.com/) country outlines in `world-atlas` | Data: public domain. Package: ISC, © Michael Bostock | Map outlines | |
| IANA Time Zone Database in `chrono-tz` and `src/generated/tzdata.json` | Data: public domain. `chrono-tz`: MIT OR Apache-2.0 | Time zone rules | |
| [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) 2.015, Regular and Bold, © 2022 The Noto Project Authors | SIL Open Font License 1.1, no Reserved Font Name | Text of the PDF timesheet. A subset goes into each PDF | Licence text in `src-tauri/crates/z-work-core/fonts/OFL.txt`, installed as `licenses/NotoSans-OFL.txt`. Source and checksums in `fonts/SOURCE.md` beside it |

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

## Compiled into the app

| Component | Licence | Used for | Note |
|---|---|---|---|
| [SQLite](https://sqlite.org/) 3.54.1, the `sqlite3.c` amalgamation in `libsqlite3-sys` 0.39.1 | Public domain ([sqlite.org/copyright.html](https://sqlite.org/copyright.html)) | The local store, `z-work-data.db` | Compiled from C into the app on every build, the same version on every system. The app doesn't use the operating system's SQLite |
| `rusqlite` 0.41.1 and `libsqlite3-sys` 0.39.1, © 2014 The rusqlite developers | MIT | Rust's access to SQLite | Licence text below |

### rusqlite and libsqlite3-sys licence

Both crates carry this text:

```
Copyright (c) 2014 The rusqlite developers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Libraries

**Rust (shipped):** Tauri and its plugins, rusqlite, chrono, chrono-tz, rust_xlsxwriter, pdf-writer, subsetter, ttf-parser, png, miniz_oxide, user-idle, winreg, serde and their dependencies, under MIT, Apache-2.0, BSD-3-Clause, ISC, Zlib, Unlicense, MPL-2.0 and Unicode-3.0, each as declared by the crate.

**JavaScript (shipped):** React, TipTap, ProseMirror, `@tauri-apps/api`, `topojson-client` and their dependencies, under MIT, ISC, Apache-2.0 OR MIT and CC0-1.0.

## Not bundled

The interface's fonts come from the operating system (Segoe UI, Cascadia Mono). The only bundled font is the PDF one above. The app icon and interface icons were drawn for this project. The WebView2 Runtime is part of Windows 11 and isn't redistributed.
