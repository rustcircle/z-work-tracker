# Microsoft Store listing notes

Text to paste into Partner Center for zWorkTracker, and what to check first. It is written for version 1.4.0, the first version planned for the Store.

**Before you paste anything:**

- Items marked **[check in the build]** describe work that isn't finished yet. Remove or reword any that the final build doesn't do.
- The character limits here are from memory. Partner Center shows the real limit beside each field.
- Have the privacy text checked before relying on it. It is a draft, not legal advice.

## App name

zWorkTracker

## Store identity

| Value | |
|---|---|
| Store ID | 9P9RM9G0QBRC |
| Store page | https://apps.microsoft.com/detail/9P9RM9G0QBRC |
| Store protocol link | `ms-windows-store://pdp/?productid=9P9RM9G0QBRC` |
| Package/Identity/Name | PedroMiguelRodriguesJorge.zWorkTracker |
| Package/Identity/Publisher | CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9 |
| PublisherDisplayName | Pedro Miguel Rodrigues Jorge |
| Package Family Name | PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp |
| MSA app ID | 561b212b-0a7a-4a47-a49d-94c7b6d51893 (not used: the app signs in to no Microsoft account) |

The Store page and links only work once the app passes certification and is published. The website already links to the Store page, so push the site change around launch day.

## Category

Productivity. Use Business only if Partner Center's choice of subcategories suits it better.

## Short description

Use this where Partner Center asks for a short summary (about 200 characters is safe):

> Track labor hours by project and task, see billable time and earnings, and export to Excel, CSV and PDF. Runs locally with no account and no telemetry.

## Description

> zWorkTracker is a time tracker for freelancers and anyone who bills by the hour. Start a timer on a task, and it records exact start and end times, then shows what you worked, what you can bill and what you earned.
>
> Your data stays with you. There is no account to create, and the app makes no network calls and sends no telemetry. If you want a permanent copy, or want to carry on from another PC, point the app at a OneDrive or Google Drive folder. Your OneDrive or Google Drive desktop app does the upload.
>
> Work across time zones without doing the sums. Times are recorded in UTC and shown in your zone, your client's zone or any other, including across daylight saving changes.
>
> See where the time went. The timeline shows each day at a glance, and Analysis compares periods with metrics such as total time, focus ratio, weekly targets, earnings and time per project.
>
> Bill with confidence. Set a price per hour or a fixed fee, apply rounding rules, mark billable pauses, and create billing summaries that track what has and hasn't been billed. Export timesheets to PDF, and your data to Excel and CSV.
>
> zWorkTracker is not an invoicing or accounting app. Its summaries and figures are for your own guidance, so check them before you bill a client.
>
> Important: on this version, data on your PC is removed when you uninstall the app. Connect a OneDrive or Google Drive folder to keep a permanent copy.

## What's new in this version

Use this where Partner Center asks for "What's new in this version" (1.4.0). It is plain text, well under the 1,500 characters the field allows:

> Tags for subtasks. A subtask can now count under some of its task's tags instead of all of them. On a task card, press the tags button on the subtask's row and tick the tags it should count under. Select all and Deselect all tick or untick every tag at once, and Same as task puts it back. Analysis, the tag filter, the Tags view of Share of time and the Tags sheet of the Excel export count each subtask's time under its own tags.
>
> A new Timeline. Days now sit side by side, the oldest on the left and today on the right. As many days show as fit the window, and the Earlier days and Later days arrows page through the rest.
>
> Share of time stays on the level you pick (Projects, Tasks, Subtasks or Tags) until you switch it.
>
> A computer still on 1.3.3 can share the same sync folder: it doesn't show subtask tags, and your 1.4 computers keep them.

Each line describes something the 1.4.0 build does, and a test covers it: the Playwright specs for subtask tags, the Timeline and Share of time, the Analysis tests, and the core's tests of a folder shared with a 1.3.3 computer. None of it has run on real Windows yet (see the README's Known limitations), and the text names no figures to measure.

## Functionalities

Use these for the Product features list (up to about 20 items, each kept short):

1. One-click start, pause, resume and stop timers
2. Projects, tasks, subtasks, tags and templates, with tags you can choose for each subtask
3. Timeline with the days side by side and a clear view of work and pauses
4. Corrections and hand-entered time, with a recorded reason and history
5. Billable and exact time shown side by side
6. Price per hour by project, with rate history and multiple currencies
7. Fixed-fee projects with effective hourly rate and budget alerts
8. Rounding and billing increments
9. Billing summaries that track billed and unbilled time
10. Analysis with period comparison, insights and project breakdowns
11. Weekly targets and work shifts
12. Any time zone, with daylight saving handled
13. Timesheet PDF with your logo
14. Excel and CSV exports
15. Idle and time-away detection you decide how to count
16. Hide earnings when sharing your screen
17. Light and dark themes
18. Tray icon for quick control
19. Daily local backups
20. Sync through your own OneDrive or Google Drive folder

**[check in the build]** Add these if they ship, replacing weaker items if you run out of room:

- Copies to both OneDrive and Google Drive at once
- Saved versions you can restore, with a readable record of changes
- One-device-at-a-time lock with a safe take-over
- Start with Windows

## What makes it special

Use these as the opening lines of your description, or for promotional text:

- **Private by design:** no account, no telemetry and no network calls from the app.
- **Your files, your cloud:** it uses your own OneDrive or Google Drive folder rather than a company's server.
- **Exact and billable time, kept apart:** you always see what really happened and what you can bill.
- **Corrections leave a trail:** every change is written to the history, so a figure can be explained later.
- **Built for working across time zones:** times are stored in UTC and shown in whichever zone you need.

Avoid claims you can't prove, such as "the most accurate" or "the best". Store certification can reject listings with misleading claims.

## Notices

Put the first four in the description or in the Additional information section. Keep the wording plain.

1. **Uninstalling removes local data.** Windows removes this app's local data on uninstall. Connect a OneDrive or Google Drive folder to keep a permanent copy.
2. **One device at a time.** The app is built for one person on one device at a time. Sync carries your work between devices, but doesn't make it safe to edit on two at once.
3. **Sync files aren't encrypted by the app.** Files in your sync folder hold your full labor data, including prices. They are protected only by your OneDrive or Google Drive account.
4. **Not an invoice or tax tool.** Billing summaries and figures are for guidance only, and aren't invoices, accounting or tax advice.
5. **Cloud sync needs the provider's app.** OneDrive or Google Drive desktop must be installed and signed in. Those services have their own terms and are not part of this app.
6. **WebView2.** The app needs the Microsoft Edge WebView2 Runtime. Windows 11 includes it, and some Windows 10 PCs may need to install it. **[check in the build]** The app shows a message with a download link if it is missing.

## Partner Center fields

| Field | What to enter |
|---|---|
| Supported systems | Windows 10 version 2004 or later, and Windows 11 (x64) |
| Age rating | Complete the questionnaire. It has no user-generated content shared with others, no ads and no purchases |
| Price | Free, with no in-app purchases |
| Copyright | Copyright (c) 2026 Pedro Miguel Rodrigues Jorge |
| Developed by | Pedro Miguel Rodrigues Jorge |
| Website | The project page, if you want it public |
| Support contact | pmrj@rustcircle.com |
| Privacy policy URL | **You need to provide this:** a public page with the text below |
| Screenshots | `~/msix-build/store-listing-screenshots-1.4.0/`: ten 1920x1080 PNGs of sample data, made by `ZWT_STORE_SHOTS=1 pnpm exec playwright test e2e/store-shots.spec.ts`. Retake them if the UI changes |
| Notes for certification | See below |

## Privacy policy draft

> zWorkTracker stores your data on your device. The app does not collect, send or sell personal data, has no account, and sends no telemetry.
>
> If you choose a sync folder, the app writes your data to that folder, including projects, tasks, logged times, prices and device names. Your OneDrive or Google Drive app may then upload it, under that provider's own terms. The app does not encrypt these files.
>
> Uninstalling the app removes its local data. Files in a sync folder remain until you delete them.
>
> Questions: pmrj@rustcircle.com

## Notes for certification

> This is a Win32 desktop app built with Tauri, and it needs runFullTrust because it is a full-trust desktop application. It needs no account or test login, and no network access. On first launch, complete the short setup and skip the cloud folder prompt. Then create a project and a task, and press Start.

**[check in the build]** Confirm that the cloud folder prompt can be skipped and that these steps match the final first-run setup.

## Before you submit

- [ ] The final build installs and runs on real Windows 10 and Windows 11 PCs
- [ ] The Windows App Certification Kit passes
- [ ] Every **[check in the build]** item is resolved
- [ ] The README no longer says the app has never run on real Windows
- [ ] "No network calls" is still true of the final build, including the WebView2 download link, which should only open your browser
- [ ] The package has your real Partner Center identity values
- [ ] The privacy policy page and support contact are live
