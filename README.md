# zWorkTracker

A desktop app for Windows 11 that accounts for labor hours by project and task. It logs start and end times automatically in UTC, shows them on a timeline in any time zone, works out billable time and earnings, analyses how the time was spent, and exports to Excel and CSV.

It runs locally. It makes no network calls and sends no telemetry. Data leaves the machine only if you choose a OneDrive or Google Drive folder for sync.

Status: first build. It has been run and tested on macOS, and the Windows installer has been built, but **nothing has been run on real Windows yet**. See [Known limitations](#known-limitations).

![Timeline](docs/images/timeline-light.png)

## Contents

- [Install and uninstall](#install-and-uninstall)
- [User guide](#user-guide)
- [Metrics reference](#metrics-reference)
- [Data and privacy](#data-and-privacy)
- [Developer guide](#developer-guide)
- [Packaging and signing](#packaging-and-signing)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Third-party data licences](#third-party-data-licences)
- [Code signing policy](#code-signing-policy)
- [Licence](#licence)

## Install and uninstall

**Install.** Run `zWorkTracker_0.1.0_x64-setup.exe`. It installs for the current user and needs no admin rights. It adds a Start Menu shortcut, offers a desktop shortcut and can launch the app when it finishes. Upgrading installs over the old version and keeps your data.

The installer is **not signed yet**, so Windows SmartScreen may say "Windows protected your PC". To continue, choose **More info**, then **Run anyway**. Signing removes that warning over time; see [signing](#windows-code-signing).

**What the app needs from Windows.** It needs one thing: the Microsoft Edge WebView2 Runtime that comes with Windows 11. The app ships no runtime and never downloads one. If WebView2 is missing or disabled, both the installer and the app say so instead of opening a blank window. Everything else is inside the app: JavaScript, map data, time zone data, chart code and icons.

**Uninstall.** Use **Settings > Apps > Installed apps**. A running copy, even one hidden in the tray, is first asked to quit normally, so an open work segment closes cleanly. Uninstalling removes program files, shortcuts, registry entries and the "Start with Windows" entry.

The uninstaller asks **Also delete my time data**, unticked by default, so your data stays unless you tick it. It never touches your OneDrive or Google Drive folders.

## User guide

### Projects, price per hour and currency

In **Projects**, create a project with a unique name and a colour. A free colour is suggested, and you can pick your own. A project with tasks can be archived but not deleted; one with no tasks can be deleted. Archived projects can be restored.

**Price per hour** takes EUR (€) or USD ($). Blank means no rate, which differs from 0: a blank project shows "No rate set", while a 0 rate is a real 0. A new price applies from now, so past earnings don't change. To backdate one, choose a date and confirm it. A work segment that crosses a price change is split at that moment. Turning off **billable** means the project earns nothing.

### Tasks and subtasks

Each task has a name, a project and a rich-text description with bold, italic, headings, numbered and bulleted lists and task lists, which is where subtasks and steps go.

**Starting work: cold and warm.** What the new task form asks depends on whether the app has already logged work since it was launched.

| | Cold | Warm |
|---|---|---|
| **When** | A real launch: boot, tray Quit then reopen, or after a crash. Stays cold until the first task of this launch has started | The app has stayed running since then, even hidden in the tray. Showing the window from the tray or a second launch stays warm |
| **Form** | Empty, nothing filled in | Filled with a copy of the most recently worked task, including paused or stopped ones, with a "Copied from" note |
| **Required** | Name, project and a description with real text. Spaces alone don't count | Name and project. The description may be blank |

The backend enforces these rules, not only the form. A warm copy is a separate task: editing it never changes the original. If the original's project has been archived, you choose another project first, and the form says why.

**Editing at any time.** Name and description can be edited in one click from Timeline entries and task details, in every state, including running and stopped. Edits save automatically, and when you leave the field, hide the window or quit. They never touch the timer or the logged time. A blank name isn't saved: the last valid name stays and the field says why. A description can be cleared after the task has started. Timeline, Analysis and exports always show the current values.

### Start, Pause, Resume, Stop

| State | Buttons enabled |
|---|---|
| Draft | Start |
| Running | Pause, Stop |
| Paused | Resume, Stop |
| Stopped | None; stopped is final |

Every Start or Resume opens a work segment and every Pause or Stop closes it. Times come only from the backend clock and are stored in UTC. Paused time is excluded from the total.

**Resume after a relaunch.** On a cold launch, Resume doesn't continue the task directly, and the backend refuses it. It opens the same empty form, with every field required. Submitting creates a **new task linked to the paused one** and starts timing it. The paused task keeps its name and description, stays paused, can still be stopped, and shows a link to its continuation. Cancel changes nothing and logs no time. Once a task has started in this launch, Resume works directly again.

**Continued tasks.** Warm copies and cold continuations are each their own task, linked in task details. They count separately, and each one rounds separately, so a chain of continued tasks can round up more than once in a day. The rounding adjustment metric shows the effect.

Only one task runs at a time on a device. Starting or resuming another task pauses the running one, and the app says so on screen and on the paused task.

### Tray behaviour

Closing the window with X hides it to the tray. **The app keeps running and a running task keeps timing.** The first time this happens, a notice explains it, because Windows 11 may tuck the icon into the overflow area.

- Left-click the tray icon to show the window.
- The menu has Show, the current task with its elapsed time, Pause or Resume, and Quit. On a cold launch, tray Resume opens the window with the form and starts nothing.
- The tooltip shows the running task or "No task running". The icon changes while a task runs.

Only the tray's **Quit** really exits. On a real exit a running segment closes at that moment and the task is marked paused. Opening the app again while it runs brings up the existing window. **Start with Windows** is an optional setting, off by default.

If the app crashes, a heartbeat saved about every 30 seconds marks the last moment it was alive. At the next launch the open segment closes at that moment, the task is paused and a notice tells you, including that the next start asks for every field.

If the computer sleeps while a task is running, the sleeping time counts as work, because the segment stays open. Pause before closing the lid.

### Timeline

The main screen. It shows the period total at the top, then days with the newest first. Each day has an axis of its real length with blocks in project colours, then entries grouped into Night (00-06), Morning (06-12), Afternoon (12-18) and Evening (18-24). A segment crossing midnight is split across days and bands. Each day header shows Billable and Exact totals plus per-project totals with earnings.

The running task ticks every second and shows two figures, labelled separately: **exact accrual**, which ticks continuously, and **billable now**, which steps at each increment. Both stop while paused.

![Live earnings](docs/images/timeline-live-earnings.png)

### Analysis

A chart-first dashboard with day, week, month, quarter, year and custom ranges, filters by project, task, band and shift, and a comparison with the previous equal period. Sections cover volume, time of day, projects, tasks, focus and sessions, consistency, goals and money, forecast, shifts and zones. Every chart has a **View data** table and tooltips with exact values, and clicking a chart drills down to the tasks and segments behind it.

Each metric has an info popover and an entry in the searchable Metrics glossary. Written Insights are generated from the numbers, with no AI. There's no productivity score: logged time measures logged time, not output.

![Analysis overview](docs/images/analysis-overview-light.png)

### Time zones, the map and Show both

Stored times are always UTC. Zones affect only display, grouping and exports. The header selector switches between **My time** (the default), **Client time**, **UTC** and **Other**, always labelled, for example "New York, EDT, UTC-4". Set your zone and the client's in **Settings**; a project can have its own client zone, used for that project's entry times in Show both.

The picker has a searchable list and an interactive world map. Click anywhere to select the zone there; an ocean click picks the nearest named zone. Zoom with the wheel or buttons. The list is the keyboard route.

![Zone picker](docs/images/zone-picker-light.png)

**Show both** adds a second axis for the client's zone on the same instants, and entries read "14:00-16:30 Lisbon / 09:00-11:30 New York". A marker shows where the zones' dates differ, and the client's working hours (default 09:00-17:00, set in Settings) are shaded with the overlap reported.

![Show both](docs/images/timeline-show-both.png)

### Daylight saving and hour shifts

Every segment converts with the offset in force at that instant, never today's offset. So the same two zones can show different gaps in March and July, and the app says so for the date viewed ("New York is 4h behind you on this date").

- When a range contains a clock change, the Timeline axis and Analysis time charts mark it, for example "New York clocks went forward 1h, 8 Mar". Zones without DST show no marker.
- The picker shows the next change in each zone and warns about the weeks when US and EU dates differ.
- Day axes draw 23-hour and 25-hour days at their true length, and the repeated hour is labelled "01:00 again". Durations come from UTC, so a 25-hour day can total 25 hours.
- Hour charts bucket by wall-clock hour: both passes of a repeated hour land in one bucket, and a skipped hour stays empty.

Rust and the UI use one time zone database, generated at build time and shown in **Settings > About**. App updates carry time zone rule changes.

### Work shifts

In **Settings**, define your own shifts with a name, colour, start and end time, weekdays, zone and optional unpaid break. Morning, Afternoon and Night presets are provided and editable. Shifts crossing midnight work and belong to the date they start on. A shift follows its own zone's clock through DST, so a night shift can be 7h or 9h on a change night. To change a shift without rewriting past analysis, save a new version with a later effective date.

Shifts appear as background bands on the Timeline and have their own Analysis charts: scheduled versus worked, time outside any shift, late start and early finish, and client-hours coverage.

**Attribution rule:** work is cut at shift boundaries. Where shifts overlap, the time goes to the one that started earliest, ties by shift id, so totals never double-count. **Overtime precedence:** shift-scheduled hours when shifts exist, otherwise the daily target.

![Shift bands](docs/images/timeline-shift-bands.png)

### Increments and rounding

The default is **15 minutes, rounding up**. Choices are Off (exact), 1, 5, 6, 10, 15, 30, 60 or a custom number of minutes, with Up, Nearest or Down. A project can override the setting.

- Raw UTC times are never rounded. Rounding is a calculation, reversible by changing the setting.
- The unit is **one task on one day** in the zone being viewed, rounded once. Many short pauses neither inflate nor erase time. Day, project and period totals are sums of the rounded rows.
- Up: 1 minute bills 15; exactly 15:00 stays 15:00; 15:01 bills 30:00. Timestamps are stored in whole seconds, so sub-second timer noise can't add an increment.
- Rows with no exact time stay at 0 and are flagged. Under Nearest or Down, a row that rounds to 0 is kept and flagged, not dropped.
- Nearest rounds exact halves up.
- A settings change applies from its effective date. Backdating needs confirmation.
- Continued tasks round separately, so a chain can round up more than once in a day. See [Tasks and subtasks](#tasks-and-subtasks).

Totals show **Billable (rounded)** and **Exact**. Exact totals are the same in every zone. Billable totals can differ, because days fall differently: a segment crossing midnight in one zone is two rows there and one elsewhere. Pauses stay excluded from Exact. The rounding adjustment metric shows what rounding adds.

### Earnings and Hide earnings

Earnings are derived from segments, rates and rounding, and stored nowhere as truth. They use billable time when an increment is on. Amounts keep an exact value (rate in cents times seconds) and round half up to cents only at the total shown, so visible rows can differ from a total by a cent. If a rate changes within a task-day, the rounding difference goes to the last rate in force that day.

EUR and USD are never added together; totals sit side by side. There are no exchange-rate lookups.

**Hide earnings** in the header masks amounts everywhere, including the tray, and is remembered. Use it when a client may see the screen.

### Excel and CSV exports

**Export** asks for the format, day zone, your zone, the client's zone and whether to include earnings. Turn earnings off for a client-facing file: no price data appears anywhere in it.

The Excel workbook has these sheets:

1. **Labor by project:** exactly `Project | Day | Time | Task name | Subtasks`, sorted by project, day and start, one row per task per day. Time is billable time as a real `[h]:mm:ss` value that sums, Day is a real date, and Subtasks are the list items from the description with numbering kept. Subtotals and a grand total use formulas with cached values. The title line states the zone and increment. A project filter keeps its subtotal row.
2. **Segment details:** raw UTC start and end, your time, the client's time, Exact, Shift and, if included, rate, currency and exact amount.
3. **Earnings** (if included): per project and currency, with per-currency totals.
4. **Analytics:** KPI summary, Bands, Projects, Weekdays, Shifts when configured, and earnings sheets if included. These follow the last Analysis view, or all logged history if Analysis was never opened.

See [docs/sample-export.xlsx](docs/sample-export.xlsx) for a sample built from synthetic data.

CSV has `record_type` rows: `segment` rows carry raw UTC, zone times and exact durations; `task_day` rows carry billable time. Filter by that column before summing. User text is protected against spreadsheet formula injection in CSV, and is always written as plain strings in Excel.

### Themes

**Light** (default), **Solarized Light**, **Solarized Dark** and **Dark**, chosen in Settings per device. The OS theme isn't followed. Project colours stay as you chose them in every theme.

### Folder sync on OneDrive and Google Drive

The app stores everything locally first, and works offline. To sync, it uses the folders of the OneDrive or Google Drive desktop clients, which do the upload. The app itself makes no network calls.

- **Setup.** On first launch, and in Settings, detected folders are listed with checkboxes, plus **Choose another folder**. You can enable either or both. Nothing turns on silently. If nothing is detected, the screen explains that a desktop client is needed and offers the picker.
- **Second PC.** If a folder already holds `zWorkTracker/devices/`, the app previews the counts and offers to connect and merge.
- **When.** After each saved change (debounced), at launch, on window focus, on quit and every 3 minutes, including while hidden in the tray.
- **Status.** Each folder shows its own status, such as "Written to OneDrive folder, 2 min ago". The app can't confirm the upload finished, so it only claims the write. A failing folder never affects another one, and never blocks time logging.

Each PC writes only its own file, `<folder>/zWorkTracker/devices/<device-uuid>.json`, and reads the others, so cloud clients have no shared file to fork into conflict copies.

**Merge rules, in plain language.**

- Projects, settings, shifts, rates and increments: the latest edit wins per record, ties settled by device id.
- Tasks merge per field. A name edited on one PC and a description edited on another both survive.
- Task state follows the same rule, except Stopped is final and always wins.
- Work segments are combined by id, and a closed copy beats an open copy.
- Deleted items leave a marker so they don't come back. Archives don't either. A draft deleted on one PC but started on another stays, because logged work is never hidden.
- Conflict copies and unknown files are ignored and never deleted. A damaged or newer-version file is skipped with a warning, and the last good data stays. A newer-version file is never overwritten.
- An unreadable OneDrive Files On-Demand placeholder is retried later and isn't treated as damage.
- If tasks run on two PCs at once, both are kept, a warning stays visible, and neither PC alters the other's segments. A task running on another PC can be stopped here, but its open segment is left for that PC to close. Until then it counts up to that PC's last known heartbeat.

Two projects created offline with the same name on two PCs stay as two projects.

**Keep the sync folder to yourself.** The files there are plain data, and whoever can write to that folder can change your hours and rates on every connected PC. The app rejects implausible files, such as impossible dates, oversized files or too many devices, but it can't tell a false entry from a real one. Don't use a folder shared with other people.

If a folder stops responding, the app reports it and moves on, and doesn't start more work on that folder until the stuck call returns. After restoring an older local data file, the app recovers what only its own sync file still holds.

## Metrics reference

The full list with formulas is in the app's searchable Metrics glossary (source: `src/features/analysis/glossary.ts`). Each entry states which time it uses.

| Uses | Metrics |
|---|---|
| **Exact** | Time of day, hour histogram, weekday by hour heatmap, year calendar, sessions and session length, longest stretch, pauses, focus ratio, context switches, fragmentation, typical start and finish, working span, shift attainment and coverage |
| **Billable** | Project totals and shares, hours over time, billable hours and share, budget burn, earnings, effective hourly rate, rounding adjustment (billable minus exact), projection |

Definitions worth knowing:

- **Paused time** is the gap between consecutive segments of a task, plus the last segment's end to its Stop. A still-paused task's open gap isn't counted. Overnight and weekend gaps between sessions of one task count too, so **focus ratio** falls sharply for tasks worked across several days. Read it with that in mind.
- A band or shift filter hides Billable figures, because rounding works on whole task-days.
- Client working hours apply Monday to Friday.
- A forecast is a straight-line projection and needs 7 or more days, 20% of the period elapsed and 2 active days. Budget pace uses the last 28 days.
- Figures with too little data show "Not enough data".

## Data and privacy

| | |
|---|---|
| **Windows** | `%APPDATA%\com.rustcircle.zworktracker\` |
| **macOS** | `~/Library/Application Support/com.rustcircle.zworktracker/` |
| **Main file** | `z-work-data.json`: versioned JSON with timestamps in UTC (`2026-03-08T07:00:00Z`) |
| **Backup** | `z-work-data.json.bak`: the previous good version |
| **Damaged files** | Kept as `z-work-data.corrupt-<time>.json` |

Saves are atomic: a temporary file, then a rename. If the main file is damaged the app restores from the backup and tells you. If both are damaged it keeps both copies, starts empty and says so. A file from a newer app version is refused and left untouched. Data is never silently wiped.

**What leaves the machine:** nothing, except through your own sync folder. Those files hold your full labor data, including prices, unencrypted. There's no telemetry, and the build contains no HTTP or TLS library; a test enforces this.

## Developer guide

### Prerequisites

- Node 24 and pnpm
- rustup. The toolchain is pinned in `rust-toolchain.toml` (stable, with the `x86_64-pc-windows-gnu` target) and installs itself on first use. You don't need a global default.
- On macOS, Xcode command line tools. To build for Windows: `brew install mingw-w64 nsis`

### Install and run

```sh
pnpm install
pnpm exec playwright install chromium   # only for e2e tests
pnpm tauri dev
```

### Tests

```sh
pnpm exec tsc --noEmit                  # types
pnpm exec eslint . --max-warnings 0     # lint
pnpm exec vitest run                    # unit and component tests
pnpm test:perf                          # 50k-segment timings
pnpm exec playwright test               # e2e against the IPC mock, under the real CSP
pnpm smoke:native                       # real macOS builds: real webview, IPC and files

cd src-tauri
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Read a sample Excel file back with an independent reader
ZWT_SAMPLE_XLSX=/tmp/sample.xlsx cargo test -p z-work-core builds_with_earnings
cd .. && uv run --no-project --with openpyxl scripts/verify_xlsx.py /tmp/sample.xlsx
```

`pnpm gen:tz` regenerates `src/generated/tzdata.json` from Rust's time zone database. Run it after updating `chrono-tz`.

### Architecture

The state machine, persistence, recovery, merge, rounding, earnings and exports are in a Rust crate with no Tauri dependency and an injected clock. A thin Tauri shell adds commands, tray, heartbeat and the sync thread, so timing doesn't depend on the window being visible. The UI receives a full snapshot after every change and computes display figures in pure TS modules.

```
src-tauri/
  crates/z-work-core/src/   Pure core
    machine.rs             Task state machine, projects, shifts, rates
    model.rs               Persisted and synced data model
    persist.rs             Atomic save, backup, recovery, migrations
    merge.rs               Deterministic merge between devices
    sync.rs, detect.rs     Folder sync, sync folder detection
    billing.rs             Day splitting, rounding, earnings
    report.rs, csv.rs, xlsx.rs, subtasks.rs   Exports
    tray.rs                Close-versus-quit decision, tray content
    service.rs, view.rs    Transactions, the UI's snapshot
  src/lib.rs               Tauri shell
  windows/                 NSIS hooks and strings
src/
  lib/                     tz engine, band splitting, billing, shifts, colour, themes, API
  app/store.tsx            Snapshot, clock, zones
  components/              Shell and shared UI
  features/                tasks, projects, timeline, settings, export, analysis, zones
  mocks/                   IPC mock and demo seed, for tests only
  generated/tzdata.json    Generated from Rust's tz database
fixtures/                  Tests shared by Rust and TS, so they can't drift
e2e/                       Playwright specs
scripts/                   Native smoke, Excel check, packaging, signing
```

Billing and time zone rules exist in both Rust (for exports and the tray) and TS (for the live UI). `fixtures/*.json` runs against both.

### Data model and schema migration

Two versions exist: `version` in the local file and `schemaVersion` in device files, both 1. To change the schema, raise `SCHEMA_VERSION` and add a step to `migrate()` in `persist.rs`. Optional fields need no step, because every synced record defaults missing ones. An old build skips a newer device file and never overwrites it.

The synced state is a set of records with stable ids, merged by taking the maximum under a total order. Property tests check that the merge is idempotent, commutative and associative.

### Security model

- Strict CSP in `tauri.conf.json`: no inline scripts or styles, no remote content. E2e tests run under that same CSP and fail on any violation.
- Minimal capabilities: the window can only listen for backend events. No shell or filesystem plugin. The save and folder dialogs run from Rust.
- Every command input is validated in Rust. Descriptions are allow-listed to known nodes and rendered only through the editor; ESLint rejects raw HTML injection.
- Files from sync folders are untrusted: they are limited in size and count, schema-checked and checked for plausible times, durations and settings, and rejected files are skipped. Each folder runs on its own worker with a time limit. Validation doesn't authenticate the writer; see [Folder sync](#folder-sync-on-onedrive-and-google-drive).
- A save re-reads what it is about to write and refuses it if it wouldn't load, so a bad value can't replace a good store.
- `unsafe` is forbidden in this project's crates, and clippy warns on `unwrap`, `expect`, `panic` and indexing.
- The test-only `smoke` feature (data folder override, extra commands) is never enabled in shipped builds. The demo seed and IPC mock are absent from the production bundle.

### Git workflow

`main` holds the first commit; work happens on `phase-1-build` in small commits that end with the co-author line. No remote is configured. Merging and pushing are the owner's call. Lockfiles are tracked.

## Packaging and signing

### Windows installer from macOS

```sh
pnpm package:windows
```

This builds with the GNU toolchain and writes `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/zWorkTracker_0.1.0_x64-setup.exe`. It then lists the exe's imports in `pe-imports.txt`, fails if a compiler runtime DLL is needed, and reports whether the files are signed. `WebView2Loader.dll` ships inside the installer next to the exe.

### Windows installer from GitHub

`.github/workflows/windows-build.yml` builds on `windows-latest`, by manual run or a `v*` tag. That build uses Rust's MSVC target, and the build from macOS uses MinGW; the bundling config is the same, but only the MinGW build has been produced so far. It hasn't been pushed or run yet.

### Windows code signing

The artifacts are **unsigned** until you add credentials. No certificate is included, and none is created. Signing runs through `bundle.windows.signCommand` for the exe, the installer, the uninstaller and the bundled DLLs. It always uses SHA-256 with an RFC 3161 timestamp. With no credentials the build prints `UNSIGNED` and succeeds. Partly set credentials fail the build, so a release isn't silently unsigned.

**First, check the metadata.** In `src-tauri/tauri.conf.json`, `bundle.publisher` is what Installed Apps shows, and `bundle.copyright` holds a placeholder until the copyright holder is confirmed. With your own certificate, set the publisher to the name on it. The name Windows shows in security prompts always comes from the certificate.

**Route 1: Azure Artifact Signing (formerly Trusted Signing), recommended.**

1. Create an Artifact Signing account, an identity validation and a certificate profile in Azure.
2. Create an app registration and give it the signer role on the profile.
3. Install the tool on the build machine: `cargo install trusted-signing-cli`
4. Set the variables listed in `.env.example`: `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

**Route 2: your own certificate.**

- On Windows, use a certificate in the store with `WINDOWS_CERT_THUMBPRINT`, or a PFX with `WINDOWS_CERT_PFX_PATH` and `WINDOWS_CERT_PASSWORD`, through signtool.
- From macOS, `brew install osslsigncode` and use the PFX variables.
- `WINDOWS_TIMESTAMP_URL` is optional.

**Route 3: SignPath Foundation, free for open source (if the project is accepted).** Acceptance isn't assured, and the routes above and unsigned builds keep working regardless. **The publisher Windows shows will be "SignPath Foundation", not you.**

1. Set the repository variable `SIGNING_ROUTE` to `signpath`. This selects the workflow's `signpath` job; the `build` job then skips.
2. Add the secret `SIGNPATH_API_TOKEN`, and the variables `SIGNPATH_ORGANIZATION_ID` and `SIGNPATH_CONNECTOR_URL`.
3. In SignPath, create project `z-work-tracker`, policy `release-signing` with manual approval, and artifact configurations `exe` and `installer`.

The job runs only on a GitHub-hosted Windows runner, because SignPath won't sign what's built elsewhere, so the installer built from macOS can't take this route. It signs the exe, packs it into the installer with `makensis`, signs the installer, then verifies both with `signtool verify /pa`. That's two approvals per release. The uninstaller embedded in the installer stays unsigned on this route. None of this has run yet.

**On GitHub,** add the same names as repository secrets, with the PFX as base64 in `WINDOWS_CERT_PFX_BASE64`. The workflow runs `signtool verify /pa` and fails if credentials were supplied but verification fails.

Never commit real values. `.env` is ignored by git. Note that scripts read variables from the environment, so export them or load `.env` first. Signing routes have been tested for command construction and secret handling, not with a real certificate.

### Manual Windows test checklist

None of this has been run yet. Please check on a real Windows 11 PC:

- [ ] WebView2 is present and the app opens. With WebView2 disabled, a clear message appears, not a blank window
- [ ] The installer runs without admin rights; SmartScreen behaves as described
- [ ] Start Menu shortcut, optional desktop shortcut and launch on finish work
- [ ] Listed in Installed apps with name, version, publisher and icon
- [ ] Start, Pause, Resume and Stop work, with auto-pause on another task
- [ ] X hides to the tray with the one-time notice; a running task keeps timing
- [ ] Tray left-click, menu, tooltip and running icon work; Pause/Resume from the tray work
- [ ] Tray Quit closes the segment and marks the task paused
- [ ] Windows shutdown or sign-out with a running task loses at most the last 30 seconds
- [ ] A second launch shows the existing window and stays warm
- [ ] After tray Quit and reopening: the form is empty and all fields are required; Resume opens the form; tray Resume opens the window with the form and starts nothing
- [ ] Task Manager kill, then relaunch: crash notice appears
- [ ] Time zone display matches a known clock; a client zone and the map work
- [ ] OneDrive and Google Drive folders (Stream and Mirror) are detected, and sync works between two PCs
- [ ] Excel export opens in Excel with working totals; save dialogs work
- [ ] Start with Windows works
- [ ] Upgrade keeps data, and closes a running app cleanly
- [ ] Uninstall removes files, shortcuts and the autostart entry; unticked keeps data, ticked deletes it; sync folders are untouched

## Troubleshooting

| Problem | What to do |
|---|---|
| "Windows protected your PC" | The installer is unsigned. Choose **More info**, then **Run anyway**. |
| Blank window or WebView2 message | Run Windows Update, or reinstall the WebView2 Runtime from Microsoft. Your data is safe. |
| The app seems gone after closing | It's in the tray; check the overflow arrow. Only tray **Quit** exits. |
| Time kept running overnight | The app was hidden or the PC slept with a task running. Pause first. |
| Sync folder not detected | Use **Choose another folder**. Only common "My Drive" language variants are detected. |
| A sync folder shows an error | Check the desktop client is running and the drive is connected. Local data and other folders are unaffected. |
| "Written to folder" but another PC has no data | The desktop client may still be uploading. |
| "newer version" warning | Update the app on this device. |
| A restored-data notice | The previous file was damaged. The damaged copy is kept in the data folder. |
| Focus ratio looks very low | It counts gaps between sessions of one task, including overnight. See [Metrics reference](#metrics-reference). |
| Earnings show "No rate set" | Set a price per hour on the project. |

## Known limitations

**Not verified on real Windows.** Nothing has run on Windows. That includes the installer, uninstaller and hooks, tray, WebView2 check, `--quit` during install, autostart, sync folder detection, Windows file-lock handling, signing, Segoe UI rendering and shutdown handling. See the [checklist](#manual-windows-test-checklist).

**Verified only on macOS or against a mock.**

- Warm copy, cold form, cold Resume and inline editing UI are tested against the mock. The native smoke script checks the backend rules and the tray route against the real backend.
- Real backend, webview and exit paths were tested on macOS with the native smoke script, which doesn't click the real tray icon. Tray icon appearance is unverified.
- The real OneDrive and Google Drive clients have not been exercised. Detection is tested with an injected environment.
- Most UI flows are tested with Playwright against the IPC mock.

**Not done.**

- OS shutdown relies on the app's exit event, which is unverified on Windows; if it doesn't fire, heartbeat recovery closes the segment within about 30 seconds of the real time.
- Mica isn't used, so it can't wash out the themes.
- Google Drive detection scans drive letters and common folder names and doesn't read the DriveFS registry. Use the picker otherwise.
- Time spent asleep counts as running time.
- At a Windows shutdown or sign-out, an edit typed in the last moment before the autosave may be lost: the page gets no save signal on that path. Tray Quit and hiding the window do flush edits, after a 300 ms wait.
- Shift analysis can't revert a single version; retire or delete instead.
- Heatmap and calendar cells have no keyboard drill-down; their View data tables hold the same numbers.
- Map zone boundaries are approximate near borders and blocky at high zoom. The list is the exact choice.
- Time zone rules run from 2000 to 2045; earlier times use the first known offset.
- Rate is fixed to the task's current project: moving a task to another project re-derives its earnings from that project's rates.

## Roadmap

Approved for phase 2. **None of this is built yet.**

1. Manual time entry and corrections, with an audit trail
2. Idle detection: keep, drop or count as thinking time
3. "Still working" pauses that can be marked billable
4. Forgotten timer reminders
5. Client-ready timesheet PDF
6. Billing summary for your own guidance (not a tax document), with per-PC reference numbers and billed marks
7. Budget alerts at 80% and 100%, including fixed fees
8. Task templates
9. Subtask checkboxes with their own tracked time
10. Tags with analytics
11. Effective hourly rate on fixed-fee projects
12. Quote helper from similar past projects
13. Automatic dated backups with self-service restore

After that, a performance pass with measurements on its own branch.

## Third-party data licences

| Data or package | Licence | Used for |
|---|---|---|
| [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder), through `@photostructure/tz-lookup` | Package: CC0-1.0. Boundary data derives from OpenStreetMap, © OpenStreetMap contributors, ODbL | Click on the map to get a zone. Shown in **Settings > About**. |
| [Natural Earth](https://www.naturalearthdata.com/), through `world-atlas` | Public domain; package: ISC | Country outlines on the map |
| `topojson-client` | ISC | Reading the outlines |
| IANA Time Zone Database, through `chrono-tz` | Public domain | Time zone rules |

The map shows outlines for orientation only and takes no position on borders, names or status.

The full list of components, including a note on the ODbL data behind the map lookup, is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Code signing policy

**No release has been signed yet.** If SignPath Foundation accepts the project: free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/), and Windows will show "SignPath Foundation" as the publisher.

- **Team:** Authors, Reviewers and Approvers are named in [docs/code-signing-policy.md](docs/code-signing-policy.md).
- **Approval:** every signing request, and so every release, needs manual approval by an Approver.
- **Accounts:** multi-factor authentication is required for all team members.
- **Builds:** only builds by this repository's workflow on GitHub-hosted runners are submitted.
- **Privacy:** this program makes no network calls and sends no telemetry. Data leaves your computer only through a OneDrive or Google Drive folder you choose, uploaded by that service's own desktop client.
- **Contact:** p@rustcircle.com

## Licence

[MIT](LICENSE). The copyright line holds a placeholder until the holder is confirmed.
