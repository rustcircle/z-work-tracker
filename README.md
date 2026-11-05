# zWorkTracker

[![CI](https://github.com/rustcircle/z-work-tracker/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rustcircle/z-work-tracker/actions/workflows/ci.yml)

A desktop app for Windows 10 and 11 that accounts for labor hours by project and task. It logs start and end times automatically in UTC, shows them on a timeline in any time zone, works out billable time and earnings, analyses how the time was spent, and exports to Excel and CSV.

It runs locally. It makes no network calls and sends no telemetry. Data leaves the machine only if you choose a OneDrive or Google Drive folder for sync.

Status: version 1.4.0. New in 1.4.0: a subtask can keep some of its task's tags, with a tags button on each subtask row; the Timeline shows its days side by side, the oldest on the left and today on the right, with arrows to page through them; and Share of time stays on the level you pick. Since 1.3.2, the app keeps its data in a SQLite database on this computer instead of a JSON file; coming from 1.3.1, see [Upgrading to 1.3.2](#upgrading-to-132) before you install. It has been run and tested on macOS, and the Windows installer and the Microsoft Store package have been built, but the only things to run on Windows so far are the CI test gates and the GitHub build, which signed the installer and checked the signatures on the runner: **the app itself has never run on real Windows**, as either build. See [Known limitations](#known-limitations).

![Timeline](docs/images/timeline-light.png)

## Contents

- [zWorkTracker](#zworktracker)
  - [Install and uninstall](#install-and-uninstall)
  - [Migration guide](#migration-guide)
  - [User guide](#user-guide)
  - [Metrics reference](#metrics-reference)
  - [Data and privacy](#data-and-privacy)
  - [Developer guide](#developer-guide)
  - [Performance](#performance)
  - [Packaging and signing](#packaging-and-signing)
  - [Troubleshooting](#troubleshooting)
  - [Known limitations](#known-limitations)
  - [Roadmap](#roadmap)
  - [Third-party data licences](#third-party-data-licences)
  - [Code signing policy](#code-signing-policy)
  - [Licence](#licence)

`pnpm check:readme` checks that this list and the headings agree.

## Install and uninstall

**Install.** Run `zWorkTracker_1.4.0_x64-setup.exe`. It installs for the current user in `%LOCALAPPDATA%\zWorkTracker` and needs no admin rights. It adds a Start Menu shortcut, offers a desktop shortcut and can launch the app when it finishes. Upgrading installs over the old version and keeps your data folder. From 1.3.1, sync and quit first: the data comes back from your sync folder (see [Upgrading to 1.3.2](#upgrading-to-132)).

An unsigned installer can make Windows SmartScreen say "Windows protected your PC". To continue, choose **More info**, then **Run anyway**. This project's builds are meant for your own PCs, signed with [a self-signed certificate](#trusting-your-own-builds-with-a-self-signed-certificate); SmartScreen may still warn about a downloaded file even then.

**What the app needs from Windows.** It runs on Windows 10 and 11, and needs one thing from them: the Microsoft Edge WebView2 Runtime. Windows 11 includes it. Many Windows 10 computers have it, but not all. The app ships no runtime and never downloads one. Everything else is inside the app: JavaScript, map data, time zone data, chart code and icons.

**If WebView2 is missing.** Neither build opens a blank window:

- The installer checks first. If it doesn't find the runtime, it says so, gives Microsoft's download page, <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>, and asks **Open the download page now?** Yes opens the page in your browser, and either answer carries on with the install. A silent install (`/S`) asks nothing.
- The app checks at every launch, in the installer build and the Microsoft Store build alike. If the runtime isn't there or is turned off, it shows a Windows message titled "zWorkTracker" that starts "zWorkTracker needs the Microsoft Edge WebView2 Runtime, and it wasn't found or is turned off on this computer", gives the same link, and ends "Your data is safe." **Open download page** opens the link and **Close** closes the message. Either way the app then exits, with no window and no tray icon. Install the Evergreen runtime from that page, then open zWorkTracker again.
- If the runtime is there but its window still can't be created, the app shows the same message with the error beneath it, where before it would have closed with nothing on screen.

**Uninstall.** Use **Settings > Apps > Installed apps**. A running copy, even one hidden in the tray, is first asked to quit normally, so an open work segment closes cleanly. Uninstalling removes program files, shortcuts, registry entries and the "Start with Windows" entry.

The uninstaller asks **Also delete my time data**, unticked by default, so your data stays unless you tick it. It never touches your OneDrive or Google Drive folders, and so never touches the versions saved there.

### Microsoft Store build: where your data lives

There is also a Microsoft Store (MSIX) build of the same program. It knows it is the Store build when Windows gives it a package identity, and it then behaves differently in four ways. None of this has been seen on Windows yet; see [Known limitations](#known-limitations).

- **Your data is private to the package, and uninstalling deletes it.** Windows keeps the files a Store app creates under AppData in a private folder of its own, and removes that folder when the app is uninstalled, with no question like the installer's. Your hours, in the database `z-work-data.db`, the dated backups and the safety copies all live there. [Where the Store version keeps its data](#4-where-the-store-version-keeps-its-data) says where that is likely to be. **So a cloud folder is the permanent copy:** connect OneDrive or Google Drive, or both, in **Settings > Sync between devices**. Versions saved there stay when the app is uninstalled.
- **It asks firmly for a cloud folder.** The setup's **Sync between computers** step opens with "Choose a cloud folder." and says Windows removes the app's files when it is uninstalled. Skipping it, or **Finish with defaults** before it, asks **Continue without a folder?** first. Until a folder is connected, a warning stays at the top of the app: "This copy of zWorkTracker keeps its data in a private Windows folder. Uninstalling the app deletes that folder and your hours with it. Connect a OneDrive or Google Drive folder in Settings > Sync between devices." Removing the last folder warns about this too, and **Settings > Backups** says its backups are removed on uninstall.
- **Start with Windows goes through Windows.** The switch turns the package's startup task, `zWorkTrackerStartup`, on and off, as a Store app's Run entry in the registry would never start anything. Windows has the last word: if you turned it off in Task Manager or **Settings > Apps > Startup**, the switch is greyed and says "You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.", with an **Open Startup settings** button. A policy can also hold it off or on, and the switch says so.
- **Notifications are Windows toasts under the package's own name.** Reminders, budget alerts and time-away questions use the package's identity, so Windows shows and lists them as zWorkTracker's. If that fails, the app falls back to the route the installer build uses.

To uninstall the Store build, use **Settings > Apps > Installed apps**. Connect a cloud folder and let it sync first.

## Migration guide

For moving to 1.4.0: upgrading the installer version, moving from the installer version to the Microsoft Store version, and restoring or moving to a new PC. None of these steps has been run on Windows yet. Back up first, whichever you do. Going back to 1.3.x on a computer that has used 1.4 drops the subtask tags that computer holds, because 1.3.x doesn't know them, while the copies other 1.4 computers keep in your sync folder stay.

### 1. Back up first

1. Stop or pause every running task.
2. Quit the app fully: use **Quit** in the tray icon's menu. Closing the window with X only hides it to the tray, and the app goes on running.
3. Copy the data folder somewhere safe. In PowerShell:

```powershell
Copy-Item "$env:APPDATA\com.rustcircle.zworktracker" "$env:USERPROFILE\Documents\zWorkTracker-backup" -Recurse
```

That copies the installer version's data folder, with its `backups` folder inside. If you use sync, the files in your OneDrive or Google Drive folder are a further copy, and both services keep earlier copies of each file of their own (see [Versions and restoring](#versions-and-restoring)).

### 2. Upgrading the installer version in place

1. Back up, as above. Coming from 1.3.1, also sync and quit first, as in [Upgrading to 1.3.2](#upgrading-to-132) below.
2. Run `zWorkTracker_1.4.0_x64-setup.exe` over the version you have. **Don't uninstall the old one first.** The installer is meant to be run over an older one: it asks a running copy to quit through its normal exit path, so an open work segment closes cleanly, replaces the program files in `%LOCALAPPDATA%\zWorkTracker`, and keeps your data folder, `%APPDATA%\com.rustcircle.zworktracker\`, as it is. Uninstalling first would also remove the Start with Windows entry, and would delete your data if **Also delete my time data** were ticked.
3. Open the app and check **Settings > About**: App version should say 1.4.0. Your projects, hours and billing summaries should all be there. Coming from 1.3.1, they appear after the first sync.
4. Update every PC that syncs with yours before you work on them side by side. An older version doesn't know about [one computer at a time](#one-computer-at-a-time), and after a [restore from a version](#versions-and-restoring) its changes are skipped until it is updated.

#### Upgrading to 1.3.2

1.3.2 keeps your data in a database on this computer, `z-work-data.db`, instead of the file `z-work-data.json`. The old file isn't converted. At the first start, 1.3.2 reads only a few settings from it: this computer's device id and name, its sync folders, how far setup got, and how many daily backups to keep. Your projects, hours and the rest come back from your sync folder. The old file is never changed or deleted.

1. **Sync.** In 1.3.1, open **Settings > Sync between devices**, press **Sync now** and wait until each folder says "Written to OneDrive folder" (or Google Drive folder) with a recent time. Check that OneDrive or Google Drive shows the folder as up to date.
2. **Quit** from the tray's **Quit**. Work done after the last sync stays only in the old file, so sync first. The installer also asks a running copy to quit, and that quit syncs once too.
3. **Install 1.3.2 and open it.** A notice says your data is being brought back from your folders. It appears after the first sync. Until data has arrived from a folder, the app writes nothing to the folders, and makes no version and no daily backup. If a folder can't be read, a warning says so and asks you to check that it is synced to this computer.
4. **Check the figures:** projects, this month's hours, and the billing summaries.

**Without a sync folder,** 1.3.2 starts empty and says so. Your data is still on this computer. The old file and every 1.3.1 backup stay where they were, and the app never removes a 1.3.1 backup. At the first start it also copies the old file, once, to `backups/z-work-data-legacy-1.3.1.json`. To bring your data back, restore that copy in **Settings > Backups**.

**What carries over.** The device id and name, the sync folders, whether setup was done, and how many daily backups to keep. Everything else of this computer's own goes back to its default: theme, Hide earnings and the last currency used.

**The Store build** updates through the Microsoft Store. Sync and quit it before the update, as above; its data comes back from the folder in the same way.

**Going back to 1.3.1.** Reinstall 1.3.1. It opens its old file, which 1.3.2 left as it was, and merges your sync folder, so nothing that was synced is lost. Changes made in 1.3.2 that never reached a folder stay only in `z-work-data.db`.

**Signing.** Windows judges the new installer as it judged the old one. A build signed with [your self-signed certificate](#trusting-your-own-builds-with-a-self-signed-certificate) is trusted only on PCs set up for it, and SmartScreen may still say "Windows protected your PC" about a downloaded file: choose **More info**, then **Run anyway**. If Smart App Control is on, it may refuse a self-signed build altogether, as Microsoft says it runs only apps its own service recognises or that a certificate authority in its Trusted Root Program signed. The Store version doesn't depend on your certificate: Microsoft signs it after certification.

### 3. Moving from the installer version to the Store version

The Store version keeps its data in a private folder that Windows deletes on uninstall (see [Microsoft Store build: where your data lives](#microsoft-store-build-where-your-data-lives)), so the move goes through a cloud folder, which also stays your permanent copy afterwards.

1. **Back up**, as in step 1, and note a few figures to compare later: the number of projects, this month's Billable total on the Timeline, and the reference and total of your latest billing summary.
2. **Turn on sync in the installer version.** In **Settings > Sync between devices**, choose **Add a folder** and connect your OneDrive or Google Drive folder, or both. Press **Sync now** and wait until each folder says "Written to OneDrive folder" (or Google Drive folder) with a recent time.
3. **Wait for the upload.** The app can only say it wrote the files, not that they reached the cloud. Check that OneDrive or Google Drive shows the folder as up to date.
4. **Quit the installer version** from the tray's **Quit**. A clean quit also tells the folder that this computer no longer holds the right to make changes, so the Store version can make changes straight away. Leave the installer version installed for now.
5. **Install the Store version and open it.** Its setup offers the folder: if the folder is detected and holds data, the first step is **Connect your other computer**, with the counts it found, and **Connect and bring it in**. Otherwise choose it at the **Sync between computers** step, through **Choose another folder** if it isn't listed. Connecting merges the folder's data into the new, empty store.
6. **Check the figures** against what you noted: projects, this month's hours, and the billing summaries on the Billing tab. **Settings > Sync between devices** lists the installer version as another device, as it has its own device id. Its file in the folder is harmless and is never deleted.
7. **Uninstall the installer version** in **Settings > Apps > Installed apps**, and leave **Also delete my time data** unticked. Its data folder then stays as a fallback until you are sure, and you can delete it yourself later.

**Use one version at a time.** Both versions follow the [one computer at a time](#one-computer-at-a-time) rule. The first to change something holds the right to make changes, and keeps it while a task runs, or until 15 minutes pass with no change, or until it quits. While the installer version holds it, the Store version shows a banner: "**Read-only.** *name* is using zWorkTracker (last seen *time* ago). You can look at everything here. Changes are off so the two computers don't overlap." To hand over, pause any task on the installer version and quit it from the tray, or press **Release now** in its **Settings > Sync between devices**, which refuses while a task runs there. Then press **Check again** on the banner. **Take over…** is offered once the other computer looks inactive, which is 15 minutes without a sign of it. While it still looks in use, quit it or press **Release now** there, or ask it to pause its task with **Pause it from here**.

**On the same PC,** Microsoft documents that a Store app that finds no file of its own under AppData opens the one an installed version left there, so the Store version may open with your data already in it and skip the setup. It then carries on as the same device, with the same device id, and the banner above doesn't come between the two versions, since they count as one computer. Whether this happens hasn't been seen on Windows. Either way, connect a cloud folder in **Settings > Sync between devices** if it isn't connected already, and don't run the two versions at the same time.

### 4. Where the Store version keeps its data

Windows keeps the files a Store app creates under AppData in a private folder per user and per package, and removes it when the app is uninstalled ([Microsoft](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)). Microsoft's page doesn't name that folder. For the Store version it is likely to be:

```
%LOCALAPPDATA%\Packages\PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp\LocalCache\Roaming\com.rustcircle.zworktracker\
```

**This path hasn't been confirmed by a real install.** The app asks Windows for its usual AppData folder and doesn't choose the private one itself. The folder is named after the package family name, which is the identity's name, an underscore, and 13 characters Windows works out from the identity's publisher. This one is worked out from the identity Partner Center issued for the app. To see what Windows reports on a PC, in PowerShell:

```powershell
(Get-AppxPackage *zWorkTracker*).PackageFamilyName
```

That lists every installed package with zWorkTracker in its name. A test package made by `pnpm package:msix` (see [Microsoft Store package from macOS](#microsoft-store-package-from-macos)) is listed too, with its own family name, `rustcircle.zWorkTracker.Test_ym7m1j5c19s9r`, so it has a folder of its own and the two never share data.

The folder holds the same files as the installer version's (see [Data and privacy](#data-and-privacy)): the database `z-work-data.db`, with `z-work-data.db-wal` beside it while the app runs, and the backups. **Uninstalling the Store version deletes it, so the cloud folder is the permanent copy.** To back it up by hand, use the `Copy-Item` command from step 1 with this folder as the source.

### 5. Restoring, and moving to a new PC

**From a version in your cloud folder.** This rolls back every computer that syncs with the folder.

1. Update every computer to 1.3.2 or later first. A version older than 1.3.1 has its changes skipped after a restore until it is updated.
2. Open **Settings > Versions** on a computer that isn't read-only. A read-only one has to take over first, and restoring makes this one the computer that is making changes.
3. Find the version, open **What changed** to read its record, and press **Restore…**. The first step compares the version's counts with this computer's. **Continue**, then **Restore this version**.
4. Before anything changes, a copy of today's data is saved on this computer and as a version in your folders, so restoring that copy undoes the restore. A running task is paused. Each other computer follows the restored data at its next sync, and keeps a copy of what it had as a version too.

**From a backup on this computer.** In **Settings > Backups**, press **Restore** next to a dated backup, then **Restore this backup**. A safety copy is made first. This rolls back this computer only: with sync on, newer records in your sync folders merge back in at the next sync, so turn sync off first to go back for good. A backup from before a restored version is refused while folders are connected, because it would undo that restore everywhere. 1.3.1 backups stay in the list and can be restored the same way, and so can `z-work-data-legacy-1.3.1.json`, the copy of the 1.3.1 data file made at the first 1.3.2 start. To restore the folder you copied in step 1, quit the app fully, put that folder back in place of `%APPDATA%\com.rustcircle.zworktracker\`, and open the app again. A folder copied under 1.3.1 holds no database, so it counts as a first start of 1.3.2: see [Upgrading to 1.3.2](#upgrading-to-132).

**Moving to a new PC.** With sync on, install zWorkTracker on the new PC, sign in to the same OneDrive or Google Drive there, and let it download the folder. If the setup finds the folder, its first step is **Connect your other computer**, where **Connect and bring it in** merges the folder's data, and the setup skips what that data already answers. Check the figures, and quit the old PC from the tray before you work on the new one. Without sync, copy the data folder over instead: quit the app on both, copy the folder from step 1 into `%APPDATA%\com.rustcircle.zworktracker\` on the new PC, then open the app. Copy the whole folder: `z-work-data.db`, and `z-work-data.db-wal` if there is one, belong together. The new PC then carries on as the same device, so don't go on using the old one too. A folder copied from a PC still on 1.3.1 gives the new PC only that PC's identity, its sync folders and its setup: the data then comes from the sync folder, or, with none, from `z-work-data-legacy-1.3.1.json` in **Settings > Backups**. For a Store version on the new PC, go through a cloud folder, as in step 3, since its private folder's place isn't confirmed.

## User guide

### First-run setup

A fresh store opens a full-page setup: Welcome; theme with a live preview; My zone and Client zone; time rules (15 minutes Up, with a plain table); a first project; work shifts from presets; sync, showing detected OneDrive and Google Drive folders with checkboxes where nothing is on without a tick; Start with Windows, off by default; and a summary. Every step has Back and Skip, and **Finish with defaults** ends it in one click. Each step saves through the normal settings, an interrupted setup resumes where it stopped, and no time is logged.

On a second PC, where a detected folder already holds data, it offers to connect first and previews the counts. It then skips what the merged data answers and still asks what belongs to this device. If you already used the app, you won't see it. **Run setup again** in Settings changes settings only after you confirm and never touches your data. The old one-time sync and client zone prompts now appear only for someone who updated and still owes them.

![The first setup page](docs/images/setup-welcome-light.png)

### Projects, price per hour and currency

In **Projects**, create a project with a unique name and a colour. A free colour is suggested, and you can pick your own. A project with tasks can be archived but not deleted; one with no tasks can be deleted. Archived projects can be restored.

**Price per hour** takes EUR (€) or USD ($). Blank means no rate, which differs from 0: a blank project shows "No rate set", while a 0 rate is a real 0. A new price applies from now, so past earnings don't change. To backdate one, choose a date and confirm it. A work segment that crosses a price change is split at that moment. Turning off **billable** means the project earns nothing.

### Tasks and subtasks

Each task has a name, a project and a rich-text description with bold, italic, headings, numbered and bulleted lists and task lists, which is where subtasks and steps go. In a description, Enter starts a new paragraph (or the next list item) and Shift+Enter breaks the line inside the current one.

![The empty form on a cold launch](docs/images/launch-cold-form.png)

**Starting work: cold and warm.** What the new task form asks depends on whether the app has already logged work since it was launched.

| | Cold | Warm |
|---|---|---|
| **When** | A real launch: boot, tray Quit then reopen, or after a crash. Stays cold until the first task of this launch has started | The app has stayed running since then, even hidden in the tray. Showing the window from the tray or a second launch stays warm |
| **Form** | Empty, nothing filled in | Filled with a copy of the most recently worked task, including paused or stopped ones, with a "Copied from" note |
| **Required** | Name, project and a description with real text. Spaces alone don't count | Name and project. The description may be blank |

The backend enforces these rules, not only the form. A warm copy is a separate task: editing it never changes the original. If the original's project has been archived, you choose another project first, and the form says why.

![A warm start with the copied values and note](docs/images/launch-warm-copy.png)

**Editing at any time.** Name and description can be edited in one click from Timeline entries and task details, in every state, including running and stopped. Edits save automatically, and when you leave the field, hide the window or quit. They never touch the timer or the logged time. A blank name isn't saved: the last valid name stays and the field says why. A description can be cleared after the task has started. Timeline, Analysis and exports always show the current values.

**Deleting.** A draft is deleted from the bin on its card, after one question. A task that has started, whether paused or stopped, is deleted from its **Details**: the red **Delete task** button under the tabs, which is on no card and no Timeline row. It opens a review, **Delete this task?**, that names the task and says what goes with it: the time logged and the days it covers, the earnings (masked by Hide earnings), any time away still waiting for an answer, and the tasks that continue it, which stay, without the link. The whole task goes with all its time, not only the entry you came from, from this PC and from synced devices. The review says it can't be undone. With sync on, the delete reaches your other PCs at their next sync, and restoring a backup made before it brings the task back only until the next sync merges the delete in again. Without sync, the way back is a backup made before the delete, restored in Settings. **Continue** leads to a last dialog, **Delete “name” for good?**, and its **Delete task** deletes. **Keep it** and Esc back out of either dialog and change nothing, and the next try starts again at the review. **Deleting is by mouse only.** Only a mouse click or a tap goes on: Enter does nothing in these two dialogs, whatever has focus, and Space, or a screen reader's usual activation of a button, on **Continue** or **Delete task** does nothing either. Each of those two buttons also waits a second after its dialog comes up, and ignores the second click of a double click, so a double click on **Continue** can't carry on to **Delete task**. The only keys that act are Esc and Space on **Keep it**, which back out, and both dialogs say so at the bottom. So a task can't be deleted from the keyboard alone. Its time goes from the Timeline, Analysis, billing, budgets, exports and the tray, on this PC and on the others at their next sync, and no edit from any PC brings it back. A task running on this PC can't be deleted: its button is dimmed, with the reason beside it, so pause or stop it first. One running on another of your PCs can, with or without **Pause it from here**: the review says it is running there right now, that the time it has logged there so far is deleted too, and that the timer on that PC stops the next time it syncs, and the last dialog says so again. A task with time on a billing summary can't be deleted either until that summary is voided, so an issued summary never loses anything it lists, and the reason names the summary and links to Billing. A voided summary keeps its rows and the task's name, and says that time is gone, not unbilled again. If a delete crosses with a new summary from another PC, the summary keeps its numbers. A project with a summary, voided or not, can only be archived, even once its tasks are gone. A PC that was timing the task stops at its next sync and says so, and the time it logged, including up to then, stays hidden on every PC. Selected Timeline entries of the task leave the selection, and an editor open on it lets go of unsaved words without a notice. The delete goes in the audit trail. The records stay in your data file, so a backup from before the delete brings the task back, until a sync folder that holds the delete merges it in again. A PC on an older version goes on showing a task that has started and its time, and timing it if it was, until it's updated.

### Start, Pause, Resume, Stop

| State | Buttons enabled |
|---|---|
| Draft | Start |
| Running | Pause, Stop |
| Paused | Resume, Stop |
| Stopped | None; stopped is final |

Every Start or Resume opens a work segment and every Pause or Stop closes it. Times come only from the backend clock and are stored in UTC. Paused time is excluded from the total.

**Space never touches a timer.** The Space bar does nothing on Start, Pause, Resume, Stop, the Start of the task form, Pause it from here, the reminder's Pause or Confirm close in Corrections, pressed or held. Use the mouse; Enter on a focused button still works.

**Resume after a relaunch.** On a cold launch, Resume doesn't continue the task directly, and the backend refuses it. It opens the same empty form, with every field required. Submitting creates a **new task linked to the paused one** and starts timing it. The paused task keeps its name and description, stays paused, can still be stopped, and shows a link to its continuation. Cancel changes nothing and logs no time. Once a task has started in this launch, Resume works directly again.

![Resume on a cold launch opens the empty form](docs/images/launch-cold-resume.png)

**Continued tasks.** Warm copies and cold continuations are each their own task, linked in task details. They count separately, and each one rounds separately, so a chain of continued tasks can round up more than once in a day. The rounding adjustment metric shows the effect.

Only one task runs at a time on a device. Starting or resuming another task pauses the running one, and the app says so on screen and on the paused task.

### Tray behaviour

Closing the window with X hides it to the tray. **The app keeps running and a running task keeps timing.** The first time this happens, a notice explains it, because Windows may tuck the icon into the overflow area.

- Left-click the tray icon to show the window.
- The menu has Show, the current task with its elapsed time, Pause or Resume, and Quit. On a cold launch, tray Resume opens the window with the form and starts nothing.
- Elapsed time in the tray is h:mm, with no seconds. The tray's text changes only when that minute or your data changes, and the amount is worked out again only when a billing step is due or your data changes. It can lag by up to a minute after a change the app makes by itself, without you doing anything in it.
- The tooltip shows the running task or "No task running". The icon changes shape while a task runs: an open stopwatch when idle, a filled one with a play mark when running.

Only the tray's **Quit** really exits. On a real exit a running segment closes at that moment and the task is marked paused. Opening the app again while it runs brings up the existing window. **Start with Windows** is an optional setting, off by default. When it's on, zWorkTracker opens its window when you sign in to Windows, as at any other launch: it doesn't start hidden in the tray. The Store build turns it on and off through Windows; see [Microsoft Store build: where your data lives](#microsoft-store-build-where-your-data-lives).

If the app crashes, a heartbeat saved about every 30 seconds marks the last moment it was alive. At the next launch the open segment closes at that moment, the task is paused and a notice tells you, including that the next start asks for every field.

**Time away.** While a task runs, the app watches for gaps: the machine slept, the wall clock jumped by more than two minutes between checks, the session was locked, or nobody touched the keyboard or mouse for the idle limit (10 minutes by default; 0 turns idle detection off, but a sleep, clock jump or lock is always noticed). The app checks for a lock every few seconds on Windows, so the gap's ends can be a few seconds off, and a lock of 10 seconds or less can't be measured and stays work. If Windows stops answering during a lock, the gap closes after a minute at the last moment it confirmed the lock, and idle and sleep detection take over. When you return, the app asks what to do with the time:

| Answer | Exact | Billable and earnings |
|---|---|---|
| No answer yet | Doesn't count | Doesn't count |
| **Keep** | Counts | Counts |
| **Drop** | Doesn't count | Doesn't count |
| **Thinking** | Counts, reported separately | Counts, reported separately |

Raw UTC timestamps stay as they were, whatever you answer. An absence in progress when a segment closes, whether by Pause, Stop, Quit or a crash, is recorded the same way. This replaces the first build's behaviour, where sleeping time counted as work.

![The time-away dialog](docs/images/timeaway-dialog-light.png)

**Reminders.** A notification tells you when a task has run a long time (4 hours by default) or is still running after your shift ended. Both can be turned off, and a reminder can be snoozed. Snoozing doesn't pause anything. In the Store build, notifications are Windows toasts under the package's own name.

### Timeline

The main screen. It shows the period total at the top, then the days side by side, the oldest on the left and the newest, today once it has time, on the right. It opens on the newest days. As many days show as fit the window's width, and at least one, so a wider window shows more. Two arrows above the days page through time: **Earlier days** moves back a page of days, and **Later days** moves forward a page. Later days is greyed out once the newest day is in view. They are ordinary buttons, reached with Tab and pressed with Enter or Space, and resizing the window keeps the day at the right edge where it is. Each day has an axis of its real length with blocks in project colours, then entries grouped into Night (00-06), Morning (06-12), Afternoon (12-18) and Evening (18-24). A segment crossing midnight is split across days and bands. Each day header shows Billable and Exact totals plus per-project totals with earnings.

The running task's elapsed clock ticks every second. That is the only figure that does. Earnings everywhere show the **Billable** amount, which moves only when billable time steps at your increment, 15 minutes rounded Up by default. So with rounding Up the first increment shows as soon as work starts on that task-day, and with the increment Off the amount follows exact time. Paused time doesn't move it, and there is no countdown to the next step. The tick stops updating the screen while the window is hidden. Exact amounts appear only in Segment details of an Excel export, labelled, for reconciliation.

**Selecting entries.** A click on a Timeline entry selects it; it doesn't open anything. Ctrl+click (Cmd on macOS) toggles an entry, and Shift+click selects the run from the last one you clicked, across the days shown, in the order they are drawn: oldest on the left to newest on the right, and top to bottom inside a day. If that starting entry is on a day you have paged away from, Shift+click selects just the one you clicked, and Ctrl+Shift+click adds it to the selection. By keyboard: Space selects, Ctrl+Space toggles, Shift+Arrow extends, Ctrl+A selects what's visible (the days shown), and Esc clears. The task's name, which shows its card in the task list, and the pencil, which edits it, keep their own buttons on the row, one click away. The card has Details, where a task is deleted, and the row has no delete button. An entry stands for one task on one day, the same as a row in Excel, so selecting one row selects every row of that task-day, and a task spanning several days can be partly selected. The selection bar shows the count and total Billable, masked by Hide earnings, with Export selected and Clear. A selection survives scrolling, paging to other days and filter changes, and the bar says when a filter, or a day you have paged away from, hides some of it.

![A selection on the Timeline](docs/images/timeline-selection-light.png)

**Filtering tasks.** The task list and the Timeline share one filter: text matched against the name and description, ignoring case and accents and including list items, combined with project and tags. It shows the match count and a clear button, and is forgotten when you quit. Analysis has the same text search among its filters.

![The task filter](docs/images/task-filter-light.png)

![Live earnings](docs/images/timeline-live-earnings.png)

### Analysis

A chart-first dashboard with day, week, month, quarter, year and custom ranges, filters by project, task, tag (or no tag), band and shift, and a comparison with the previous equal period. Sections cover volume, time of day, projects, tasks, focus and sessions, consistency, goals and money, forecast, shifts and zones. Every chart has a **View data** table and tooltips with exact values, and clicking a chart drills down to the tasks and segments behind it.

**Share of time** is a donut with a legend beside it, or below it when the card is narrow, that writes every slice as text, such as `16h 50m (47%)`, in the hours of the Billable or Exact basis, so the rows add up to the total in the centre. A **Projects / Tasks / Subtasks / Tags** switch changes what the slices are. Until you pick a level, it shows the one your filter leaves open and moves with the filter (Projects with no project filter or several, Tasks with one project, Subtasks with one task; Tags is only picked by hand). Once you pick a level it stays on it, however the filter changes afterwards: only you switch it. A row names only what the filter leaves open, such as a task's project only when the tasks come from several, while the tooltip and the screen reader's name always give the whole path. Time on no subtask is its own row, `<Task> (no subtask)`, and Subtasks is off while nothing is logged on one; if you had picked it, the card shows another level meanwhile and goes back to Subtasks when subtask time returns. Tags gives each exact combination of tags a row, such as `Design + Client`, and untagged time `No tag`, with each piece of time counted once, under the tags its subtask counts under: its task's, unless the subtask has tags of its own, so a task whose subtasks differ can have a row for each. The tag filter has a **No tag** choice too: alone it keeps only the time that counts under no tag (a task with none, or a subtask with none ticked), and with tags chosen it keeps that as well. It keeps a task whole unless some of its subtasks have tags of their own; then the hint under the filter says it is time that is kept, each piece by the tags its subtask counts under, and Billable rounds the time that is kept. With more than nine rows only the top eight show, followed by one `Other (N tasks)`, `Other (N subtasks)` or `Other (N combinations)` row, while **View data** still lists every row. The percentages are whole numbers rounded so that they always add up to 100, which can move some slices by a point from plain rounding; a slice whose share rounds to 0 reads `<1%`. The legend shows hours, not earnings, so Hide earnings leaves it as it is.

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

Each change to a shift is kept as a dated version. **Revert** removes one version after a confirmation that says which applies afterwards; a shift's only version can't be reverted, so retire or delete it instead.

**Attribution rule:** work is cut at shift boundaries. Where shifts overlap, the time goes to the one that started earliest, ties by shift id, so totals never double-count. **Overtime precedence:** shift-scheduled hours when shifts exist, otherwise the daily target.

![Shift bands](docs/images/timeline-shift-bands.png)

### Increments and rounding

The default is **15 minutes, rounding up**. Choices are Off (exact), 1, 5, 6, 10, 15, 30, 60 or a custom number of minutes, with Up, Nearest or Down. A project can override the setting.

- Raw UTC times are never rounded. Rounding is a calculation, reversible by changing the setting.
- The unit is **one task on one day** in the zone being viewed, rounded once. Many short pauses neither inflate nor erase time. Day, project and period totals of time are sums of the rounded rows.
- Up: 1 minute bills 15; exactly 15:00 stays 15:00; 15:01 bills 30:00. Timestamps are stored in whole seconds, so sub-second timer noise can't add an increment.
- Rows with no exact time stay at 0 and are flagged. Under Nearest or Down, a row that rounds to 0 is kept and flagged, not dropped.
- Nearest rounds exact halves up.
- A settings change applies from its effective date. Backdating needs confirmation.
- Continued tasks round separately, so a chain can round up more than once in a day. See [Tasks and subtasks](#tasks-and-subtasks).

Totals show **Billable (rounded)** and **Exact**. Exact totals are the same in every zone. Billable totals can differ, because days fall differently: a segment crossing midnight in one zone is two rows there and one elsewhere. Pauses stay excluded from Exact. The rounding adjustment metric shows what rounding adds.

### Corrections, manual entries and billable pauses

You can add a manual entry for time the app didn't log, correct a segment's start and end, or void a segment and bring it back. Each asks for a reason where it helps and warns about overlaps. Nothing destroys the original: the logged UTC times stay in the file, the correction sits beside them, and the audit trail lists every change with when, what and why. A running segment can't be corrected, and neither can time on a billing summary until that summary is voided.

A pause can be marked **billable** when you were still working, for example on a call. It counts in Billable and earnings, is rounded once together with that task-day's exact time, and is included in the rounding adjustment, but it never counts in Exact and is reported on its own. Time covered twice bills once: a pause never bills a span a segment or another pause already covers.

![Corrections on a task](docs/images/task-corrections.png)

### Subtask time

A task-list item in a description can be made active. Exactly one is active at a time. Each segment belongs to the subtask active when it started; switching while running closes the segment and opens the next one, so task totals remain the sum of segments. Copying a task keeps subtask text, clears the ticks and carries no time. Removing the active item from the description clears the active subtask. A subtask can also count under only some of its task's tags: see [Tags and templates](#tags-and-templates).

![Subtasks with their time](docs/images/task-subtasks.png)

### Tags and templates

Tags have a name and a colour, and four starter tags come with the app. A warm start copies them; a cold start requires at least one, while any tag exists. Analysis breaks time down by tag. A template stores a task's name, description, project and tags, and creates an independent draft with unticked subtasks, each on Same as task.

**Tags of a subtask.** A subtask counts under its task's tags unless you choose some of them for it. On a task card, each subtask of a task that has tags has a small tags button that says **Same as task**, **No tag**, or shows the subtask's own tags. It opens a checklist: **Same as task** puts the subtask back, one button reads **Select all** or **Deselect all**, and the task's tags are checkboxes. Each change is saved at once, and ticking none means **No tag**, which is not the same as Same as task. **Select all** makes every tag the subtask's own choice, so it keeps them if the task gets another tag later, while a subtask on Same as task follows the task. A subtask only ever counts under tags its task has, so a tag taken off the task drops out of its subtasks at once, and a subtask left with none of its own tags shows **No tag**. The subtasks' own lists are kept as they were, so a tag put back on the task returns to the subtasks that had it, and a change to the task's tags never undoes a choice made for a subtask. The choice applies to all the time logged on the subtask, past and future, while time on no subtask, or on an item since removed from the description, counts under the task's tags. With the mouse, the button opens the list and a press elsewhere closes it. With the keyboard, Tab reaches the button, Enter or Space opens it and puts focus in the list, the arrow keys, Home and End move, Space or Enter ticks a tag, and Esc closes the list and gives focus back to the button. While another computer holds the lease the button is dimmed, with the reason. If the subtask's tags changed on another computer since the row showed them, nothing is saved, and the row says so and shows what is stored. A copy of a task, a task made from a template and one that continues another start every subtask on Same as task. The tags are chosen on the task card only, not in the description editor or the new-task form. Analysis, the tag filter and the Analytics sheets of an Excel export count each piece of time under the tags its subtask counts under: see [Analysis](#analysis).

**New tag** next to the tag picker opens Settings at the Add tag form, focused. Tags aren't created inside the task form. **Back to task** stays up until you take it, and what you'd typed in the form is still there.

### Colours

Projects and tags share a colour picker: a saturation and brightness area, a hue slider, R, G and B fields from 0 to 255 and a hex field, all kept in step, with a live preview. It works by keyboard in every theme, and also offers curated swatches and your recently used colours. Any colour is allowed. Chip text picks black or white for readability, and you get a gentle warning, never a refusal, if a colour is close to another project's or hard to see on the current theme. The backend stores six-digit lowercase hex, such as `#1a2b3c`, and refuses anything else.

**One colour, one project.** Save a project with the exact colour of another active project and the app replaces it with a random colour that's clearly different from all active ones and readable in all four themes, then tells you, showing the new colour with a **Choose again** button. It never does this silently. Tags follow the same rule among tags. Archived projects don't count, and a colour you left unchanged is never replaced. Two PCs can choose the same colour while offline: after a sync both stay as saved, with a warning, because random choices on each PC would fight. The same generator supplies suggestions once the curated palette runs out.

![The colour notice](docs/images/color-notice-light.png)

![The colour picker](docs/images/color-picker.png)

### Fixed-fee projects and budget alerts

A project bills **hourly** or at a **fixed fee** in EUR or USD. A fixed-fee project earns the fee, not time at a rate, so hourly earnings stay empty, and Analysis shows its effective hourly rate: the fee divided by billable hours. Budgets warn at 80% and 100%, of hours or of the fixed fee, on screen and once per threshold as a system notification. A fee-based budget values time using the project's rate as a target rate, and says so when none is set.

### Billing summaries

**This is for your own guidance. It is not an invoice and not a tax document, and says so on the page and in its exports.**

Pick a project and period to see unbilled closed time per task and day. **Create summary** freezes it into a summary with a reference such as `A-001` and marks that time billed. Tasks then show billed and unbilled time. Copy it or export it as CSV; with Hide earnings on, neither holds an amount. Voiding a summary puts the time back to unbilled; its number isn't reused.

![The Billing tab](docs/images/billing-light.png)

Each device has its own prefix, which you can edit. Numbers count up per prefix across all devices. Two devices offline at once could still pick the same prefix and reference, so the app warns when it finds a shared prefix or a repeated reference.

The preview tells you about time away you haven't answered yet. It's left out of the summary, and answering after that requires voiding the summary, so answer first. Time belongs to the day its segment started. A correction made on another device before the summary syncs still applies, while the frozen summary keeps its numbers.

**A task-day billed in parts rounds once.** The next summary rounds the day's whole time and bills what that comes to, less what live summaries already hold for that day, so 20 minutes and then 20 more at 15 minutes up bill 30 and then 15, the 45 the report shows. The preview says when a row bills a difference like this. It can be less than the row's own time, or nothing, and what's already issued is never taken back or changed.

- Voiding a summary takes what it held off the day, so a later preview rounds again what is left. The other summaries keep their numbers.
- The day rounds under the rule in force for it now, whichever rule the earlier summaries were made under.
- A summary from an older version keeps what it issued, even if it rounded one day twice. Later rows on that day bill only what the day's rounded time has grown past that.
- A summary made in another zone has other days, so its rows are shared out over the days of this one by the time they list.
- If a correction made on another device before a summary synced moved its time to another day, what it holds for that time goes with it. What it holds for time that was cut stays on its day and isn't taken off another day's work, so the summaries can come to more than the report.
- If a rate changes during the day, a row bills at the rates of its own time, so money billed in parts can differ from the report's for that day, whose rounding goes to the last rate.

A summary's amounts are stored when it is made and read as stored, so one from an older version keeps the total it issued, the sum of its rounded rows.

### Timesheet PDF

A local PDF for a period, with or without prices, in the client's zone, with your logo (PNG) if you add one. It's built on this computer by a Rust library with no network access. Its text is set in Noto Sans, which ships with the app, and each PDF embeds only the characters it prints, so text stays selectable and copyable. Latin, Greek and Cyrillic print as typed. Japanese, Chinese, Korean, Hebrew, Arabic and emoji have no glyph in that font: each prints as an empty box, never as `?`. The export then says which on screen and on the timesheet, and copying from the PDF still gives them as typed. The Excel and CSV exports show them normally.

### Quote helper

Enter a job's name and tags to get an estimate from comparable past stopped tasks: a range and the number of tasks behind it. It's labelled as an estimate, and a low sample size is shown.

### Backups

The app writes a dated copy of its data once a day into a `backups` folder beside it, keeping the newest 30 by default; choose 1 to 365. These stay on this computer and are separate from sync. **Restore** in Settings first saves the current data as a safety copy, then rolls back your data and shared settings to the backup. The newest 5 safety copies are kept, apart from the daily ones. A running task pauses first, and the next start counts as cold. A task the backup held running is paused at the last moment that backup knows about. Restoring the safety copy undoes a restore. What belongs to this device stays: its preferences and sync folders, its reference prefix, the reference numbers already used, so none is ever reused, and the audit trail, which records the restore. With sync on, newer records in your sync folders merge back in at the next sync, so to go back in time for good, turn sync off first. To roll back every computer, use [Versions](#versions-and-restoring) instead. While folders are connected, a backup from before a restored version is refused, because restoring it would undo that restore on every computer. In the Store build, backups live in its private folder and are removed with the app.

Backups are still JSON files, as in 1.3.1, though the data itself is now in a database. The backups 1.3.1 made stay listed and can be restored, and the app never removes them, whatever the number to keep says. The same goes for `z-work-data-legacy-1.3.1.json`, a copy of the 1.3.1 data file made once at the first 1.3.2 start. Until data has arrived from your sync folder after that first start, no daily backup is made.

### Earnings and Hide earnings

Earnings are derived from segments, rates and rounding, and stored nowhere as truth. They use billable time when an increment is on. Amounts keep an exact value (rate in cents times seconds). A row shows its own amount rounded half up to cents. A total adds up the exact values of its rows and rounds them once, the same way, so the PDF, summaries, Excel and Analysis come to the same figure for the same time, and visible rows can differ from their total by a cent or so. The PDF, a summary's CSV and copied text and the Billing tab say so when they do, and Excel's Earnings sheet says so in its title. If a rate changes within a task-day, the rounding difference goes to the last rate in force that day.

EUR and USD are never added together; totals sit side by side. There are no exchange-rate lookups.

**Hide earnings** in the header masks amounts everywhere, including the tray, the percent of a fixed fee in Analysis, and the saved fee and price in a project's editor, where **Change** beside each shows it for you to edit. It is remembered. Use it when a client may see the screen.

### Excel and CSV exports

**Export** asks for the format, day zone, your zone, the client's zone and whether to include earnings. Turn earnings off for a client-facing file: no price data appears anywhere in it.

The Excel workbook has these sheets:

1. **Labor by project:** exactly `Project | Day | Time | Task name | Subtasks`, sorted by project, day and start, one row per task per day. Time is billable time as a real `[h]:mm:ss` value that sums, Day is a real date, and Subtasks are the list items from the description with numbering kept. Subtotals and a grand total use formulas with cached values. The title line states the zone and increment. A project filter keeps its subtotal row.
2. **Segment details:** raw UTC start and end, your time, the client's time, Exact, Shift and, if included, rate, currency and exact amount.
3. **Earnings** (if included): per project and currency, with per-currency totals.
4. **Analytics:** KPI summary, Bands, Projects, Weekdays, Tags when any time counts under a tag, Shifts when configured, and earnings sheets if included. On Tags a subtask with tags of its own counts under those, so a task can be in several rows. While the Analysis tab is open they follow its period and filters. Each sheet's title says when a filter is on, and so does the Export dialog. Once you leave the tab, they cover all logged history, the latest 1830 days at most.

**Exporting a selection.** When entries are selected, the dialog's scope defaults to **Selected** instead of **All in period**. The backend gets only task ids and days, checks them, refuses an empty selection or an entry with no time, and recomputes everything itself, with rounding per task-day, so figures match the Timeline. Time and money on Labor by project, Segment details, Earnings, Adjustments and the Analytics sheets cover the selection only, with the first sheet's columns unchanged, and a sheet named **About this selection** says what the file is. The Subtasks column shows each task's full subtask list and ticks as of the export, which can include subtasks worked on days outside the selection, and the dialog and that sheet both say so. CSV and the PDF timesheet print no subtasks. The backend works out those Analytics sheets itself, by the same rules as the Analysis tab: their period runs from the first to the last selected day, each title says it is a selection, and `fixtures/analytics-parity.json` holds both sides to the same figures. A few things differ from a whole-period file, because of what a selection is: the earnings sheet has no row for a day left out, shift figures count only the shifts of selected days (a shift that runs on a selected day is named even with no selected time in it), the Shift column of Segment details covers the selected part of a segment, an effective hourly rate on a fixed fee is over the selected time only, a task counts as in progress only if its latest day is selected, a day holding only a billable pause still counts its project and task, and there is no projected total. Averages per calendar day and per weekday still count the days between selected days. CSV ends with a `selection` row and the PDF timesheet prints a line saying the same. The selection clears after an export only if you ask.

![Export scope](docs/images/export-scope-light.png)

See [docs/sample-export.xlsx](docs/sample-export.xlsx) for a sample built from synthetic data.

CSV has `record_type` rows: `segment` rows carry raw UTC, zone times and exact durations; `task_day` rows carry billable time. Filter by that column before summing. User text is protected against spreadsheet formula injection in CSV, and is always written as plain strings in Excel.

### Themes

**Light** (default), **Solarized Light**, **Solarized Dark** and **Dark**, chosen in Settings per device. The OS theme isn't followed. Project colours stay as you chose them in every theme.

### Folder sync on OneDrive and Google Drive

The app stores everything locally first, and works offline. To sync, it uses the folders of the OneDrive or Google Drive desktop clients, which do the upload. The app itself makes no network calls.

- **Setup.** On first launch, and in Settings, detected folders are listed with checkboxes, plus **Choose another folder**. You can enable either or both. Nothing turns on silently. If nothing is detected, the screen explains that a desktop client is needed and offers the picker.
- **Second PC.** If a folder already holds `zWorkTracker/devices/`, the app previews the counts and offers to connect and merge.
- **One PC at a time.** Only one computer at a time makes changes, as far as plain cloud folders allow: see [One computer at a time](#one-computer-at-a-time). Let sync finish on one before you edit on another. [Known limitations](#known-limitations) says what can still happen.
- **Two folders.** You can connect a OneDrive folder and a Google Drive folder at once: see [Two folders](#two-folders).
- **When.** Once you've turned it on, it's automatic, with no further prompts: at launch, about 2 seconds after each major action (Start, Pause, Resume, Stop, or a change to a project, shift, rate or setting), about 15 seconds after a task's text was edited, every 30 minutes while the app runs, including hidden in the tray and during a running task, and at a real quit. A failed attempt retries after 30 seconds, 1 minute, 2 minutes and so on, up to every 15 minutes.
- **Changing the folder.** You can switch to another folder or provider at any time in Settings; see below.
- **Status.** Each folder shows its own status, such as "Written to OneDrive folder, 2 min ago". The app can't confirm the upload finished, so it only claims the write. A failing folder never affects another one, and never blocks time logging.

Each PC writes only its own file, `<folder>/zWorkTracker/devices/<device-uuid>.json`, and reads the others, so cloud clients have no shared file to fork into conflict copies.

**Merge rules, in plain language.**

- Projects merge per group of fields: identity, billing, budget and archive. In each group the latest edit wins, ties settled by device id, so a rename on one PC and a fixed fee set on another both survive. "Latest" goes by each edit's stamp: see [Clocks and the latest edit](#clocks-and-the-latest-edit).
- Settings, shifts, rates and increments: the latest edit wins per record, ties settled by device id.
- Tasks merge per field. A name edited on one PC and a description edited on another both survive.
- A task editor won't save over a newer value of a field if that value has reached this PC since the editor last showed or saved the field. It can only know what has synced here: if two PCs save the same field before either has synced, the later save wins and the other text is gone, with no notice (see [Known limitations](#known-limitations)). The backend compares the two in the same step as the write, by value, so edits to other fields and the running clock don't count, and the same text arriving from elsewhere isn't a conflict. A field you haven't changed shows the newer value. A field you have changed keeps your words and sends nothing: a notice says so, in the editor or, when the editor is closed, in a banner that stays until you open it. **Done** after that notice saves your words over the newer ones, which you can't read first, as the editor shows one value per field. A press of **Done** in the notice's first second chooses nothing, as focus may well be on **Done** already. **Discard my words** keeps the newer ones. To see both, copy your words, press **Discard my words**, and paste them back. Going on typing does nothing to either.
- Task state follows the same rule, except Stopped is final and always wins.
- Work segments are combined by id, and a closed copy beats an open copy.
- Deleted items leave a marker so they don't come back. Archives don't either. A draft deleted on one PC but started on another stays, with its time. A task deleted with its time stays deleted: that marker beats every edit from every PC, and time that arrives afterwards is hidden with it.
- Conflict copies and unknown files are ignored and never deleted. A damaged or newer-version file is skipped with a warning, and the last good data stays. A record that can be read but fails its checks, such as a time that makes no sense, is skipped on its own and named in the warning, and the rest of the file is read. A newer-version file is never overwritten.
- An unreadable OneDrive Files On-Demand placeholder is retried later and isn't treated as damage.
- If tasks run on two PCs at once, both are kept, a warning stays visible, and neither PC alters the other's segments. A task running on another PC can be stopped here, but its open segment is left for that PC to close. Until then it counts up to that PC's last known heartbeat. If the other PC seems stuck, **Pause it from here** records a synced, audited request. It never rewrites that device's segment: time counts up to the request on every PC, and the other PC closes its own segment when it next syncs, marked as paused by request. That PC then shows one notice naming the task and the device that asked, plus a system notification if its window is hidden.

Two projects created offline with the same name on two PCs stay as two projects.

**Changing the sync folder.** In Settings, choose **Change folder**, or add a second one. A preview shows the source, the destination and the counts in each. The app then:

1. Reads the previous folder's device files and merges them into local data by the rules above. If the new folder already has zWorkTracker data, that's merged too, not overwritten.
2. Copies the other devices' files across and writes this device's merged file. A fresher file already in the new folder is left alone. Conflict copies aren't copied, and damaged or newer-version files are skipped with a warning. A file with a record that can be read but fails its checks is not skipped: it is read without that record and copied as it is, and the warning names the record.
3. Reads the new folder back and compares counts and a content checksum before calling it done. Only then does the setting change.

The old folder is never changed or deleted: it just stops being written to, and you can remove it yourself. Time logging carries on during the copy. If a copy fails, the setting stays on the old folder and local data is unharmed, and running it again is safe. If the previous folder can't be read, for instance when it's offline or its client was removed, the move goes ahead from local data, says so, and offers **Retry copy** for later.

![Changing the sync folder](docs/images/sync-change-folder.png)

**Each PC needs switching.** Other PCs keep using the old folder until you change them too, and PCs on different folders don't see each other's changes.

**Keep the sync folder to yourself.** The files there are plain data, and whoever can write to that folder can change your hours and rates on every connected PC. The app rejects implausible files, such as impossible dates, oversized files or too many devices, but it can't tell a false entry from a real one. Don't use a folder shared with other people.

If a folder stops responding, the app reports it and moves on, and doesn't start more work on that folder until the stuck call returns. After restoring an older local data file, the app recovers what only its own sync file still holds.

#### One computer at a time

With a sync folder connected, only one computer at a time makes changes. **This is a best effort, and the app says so in Settings > Sync between devices:** "Only one computer at a time can make changes. This is a best effort: cloud folders update late and can't lock anything, so two computers may both make changes for a few minutes. If that happens, nothing is lost: the changes merge."

**How it works.** Each computer writes a small record of its own in every connected folder, `zWorkTracker/lease/<device-uuid>.json`, so no file has two writers and no conflict copies arise. The records carry a claim number, and the highest claim across every folder that can be read decides which computer holds the right to make changes. A computer claims it the first time it changes something, not at launch, so two PCs that both start with Windows don't lock each other out. It keeps it while a task runs on it, and lets go by itself after 15 minutes with no change and no task running, when you quit, or when you press **Release now** in **Settings > Sync between devices**, which refuses while a task runs there. While it holds it, it rewrites its record about every 2 minutes, and every computer reads the records about every minute, and at once on **Sync now** or **Check again**.

**What you see.**

| Situation | On this computer |
|---|---|
| No folder, nobody holds it, or this computer holds it | No banner. **Settings > Sync between devices** says "This computer is the one making changes." while it holds it, with **Release now** |
| Another computer holds it and was heard from in the last 15 minutes | "**Read-only.** *name* is using zWorkTracker (last seen *time* ago). You can look at everything here. Changes are off so the two computers don't overlap." **Check again**. No **Take over…** yet: it comes once nothing has come from that computer for 15 minutes |
| Another computer holds it, but nothing has changed in its record for 15 minutes, by this computer's clock | "**Read-only.** *name* looks inactive: nothing from it for *time*. It may be off, or its cloud app may simply not have synced yet." **Check again**, **Take over…** |
| No folder can be read, and another computer was the last known holder within 24 hours | "**Read-only.** The sync folder can't be reached, and *name* was last using zWorkTracker *time* ago." **Check again**, **Work here anyway…** |
| No folder can be read otherwise | A notice that this computer can't check, and that you can keep working: everything merges when the folder is back |

"Looks inactive" is a guess from the time since the last sign, and nothing happens by itself because of it, apart from unlocking **Take over…**. If the other computer's clock seems to differ from this one's, the banner says so.

**Read-only** lets you look at every tab, filter, export, change this computer's own preferences such as the theme and Hide earnings, switch between My time, Client time and Show both, sync, and ask the holder to pause a task with **Pause it from here**. It doesn't let you start, pause, resume or stop a task, edit anything, make corrections or billing summaries, change shared settings, restore a backup, or save or restore a version. Sync still reads, merges and writes this computer's own file, so the view stays current. Text you were typing when the computer went read-only isn't saved, and its editor says "Not saved: *name* is using zWorkTracker. Take over to save."

**Take over** asks twice. **Take over from *name*?** shows when that computer was last heard from and which tasks shown as running there will close, at the last moment it is known to have been running. **Continue** leads to **Are you sure?**, which says the other computer becomes read-only only when it hears about this, which can take a few minutes, or until it reconnects if it's offline, and that until then both could make changes, which merge. Only its **Take over** button acts, and **Back** or **Cancel** change nothing. Take over is offered once the other computer looks inactive: nothing from it for 15 minutes. For one that looks in use there is no **Take over…**. Ask it to pause the task with **Pause it from here**, on the task, or quit it or press **Release now** there. Once its timer has stopped it lets go by itself after 15 minutes with no change, and **Check again** shows that. If the folders show a different holder by the time you confirm, nothing is taken over and the first question comes back with what they say now. If that holder has been heard from again and looks in use, the first question says so and has no **Continue**.

After a take over, this computer syncs at once, saves a version, and the time the other computer left running is closed at its last known moment, which the history of changes records. The other computer, when it next reads the folder, closes its own timer and goes read-only with a notice such as "LAPTOP took over, so this computer is now read-only. "Task" stopped timing here at 14:12. Nothing was lost: it will sync." If it really kept working, its own recorded end replaces the one set by the take over when it next syncs, unless that time is already on a billing summary. **Work here anyway…** makes this computer writable at once while no folder can be read, and takes over when a folder is back, unless another computer took over meanwhile: then it goes back to read-only, and what you did is kept and merges.

A task left running on a computer you can't get to can also be closed without a take over: **Close at last known time** under its time in task details does it once that computer has been silent for 24 hours, or after **Pause it from here**.

#### Two folders

You can connect two folders, typically one in OneDrive and one in Google Drive, through **Add a second folder** in **Settings > Sync between devices**, or by ticking both in the setup. Each holds a full working copy: every sync reads both, merges once and writes the same data to each, and one-computer-at-a-time records go to both. The first is labelled **Main** and the other **Second copy**; a restore tries the main one first, and removing the main one makes the other one main.

Each folder shows its own status, and one failing never stops the other. If a folder hasn't been written for 30 minutes, a warning at the top of the app names it and the error, and says whether the other folder is fine. If one folder's copy of another computer's data is more than an hour behind the other folder's, the folder says so, as its cloud app may be paused. **Remove** stops using a folder and leaves its files where they are.

#### Clocks and the latest edit

Each edit carries a stamp, and the merge rules above keep the edit with the later stamp. From 1.3.2, a stamp follows the newest change this computer has seen, its own or another computer's: an edit is stamped at least one second after that change, even when this computer's clock is behind. So an edit made after another edit has reached this computer wins over it, whatever the clocks say. A stamp is never more than one day past this computer's own clock, because other computers refuse records dated more than two days ahead of theirs. The stamps go in the same files as before, so 1.3.1 reads them. Work times are not stamps: the start and end of every segment still come from this computer's clock, as do heartbeats and the dates of versions.

When this computer's clock is 2 minutes or more behind the newest change it has seen, a warning stays at the top of the app until the clock is right. It can't be dismissed. It reads, for a change from another computer:

> This computer's clock is *gap* behind a change saved on *name* at *time*. New changes here are still dated after it, so they count as the newest. Check the date and time on both computers: one of them is wrong.

and for a change made on this computer:

> This computer's clock is *gap* behind a change saved here at *time*, so it seems to have been set back. New changes are still dated after that one, so they count as the newest. Check this computer's date and time.

*gap* reads like "5 min", "1 h 30 min" or "3 days". From a gap of one day, a new edit can no longer be stamped after that change, and everything after the first sentence becomes: "Changes made here can't be dated after it until the clock is fixed, so they may lose to it. Check the date and time on both computers." When the change was saved on this computer, the last sentence is "Check this computer's date and time." The warning goes away by itself once the clock has caught up.

#### Versions and restoring

**Settings > Versions** lists saved copies of your data, kept in the sync folders, so any computer can restore from them, and uninstalling the app doesn't touch them.

**Where they are.** `zWorkTracker/versions/<YYYY-MM>/` in each folder, one month per folder, for example `zWorkTracker/versions/2026-11/20261102T142530Z--a1b2c3d4--auto.json.gz`. The name gives the UTC time it was saved, the first 8 characters of the saving computer's id, and the reason. The file is gzip of the same data file a sync writes, so any unzip tool opens it. Beside it, `<name>.changes.txt` is a readable record, in UTC and plain words: who saved it and why, the counts, what changed since the version before, and what the history of changes gained in between.

**When one is saved.** The computer that holds the right to make changes saves one after your data changes, at most once an hour. Any computer that may make changes also saves one when you close the app after changes (unless one was saved in the last 15 minutes), when you press **Save a version now**, after a take over, and around a restore. A read-only computer saves only the copy of its own data it keeps before following a restore.

**How long they're kept.** Every version for 7 days, then the newest of each UTC day until 60 days, then the newest of each UTC month, forever. Versions saved around a restore or a take over are kept whole for a year first, and the list marks them **Kept for a year**. Only the computer that holds the right to make changes thins them out, by these rules and by file name alone, so two computers never disagree. If the versions take more than 1 GB in all, the page says so, and nothing is deleted because of it.

**Your cloud provider keeps copies too.** OneDrive and Google Drive keep earlier copies of each file of their own, through **Version history** in OneDrive and **Manage versions** in Google Drive. That stays available as a second safety net, for the versions and for the device files.

**Restoring.** Each row has **What changed**, which shows its record, and **Restore…**. The restore asks twice: first it compares the version's counts with this computer's, then it says what follows. A copy of today's data is saved first, on this computer and as a version in your folders, so restoring that copy undoes the restore. A running task is paused. The restored data then replaces the data on every computer that syncs with these folders: each follows it at its next sync, keeps a copy of what it had, and says so. A restore can't be undone by the next merge, because the restored data carries a number every newer app version respects.

- **Update every computer before restoring.** A computer still on an older app version doesn't know about restores. Its changes are skipped, with "Skipped *name*: it holds data from before a restored version. Update and sync that device.", until it is updated.
- A computer with data of its own that connects a folder holding a restore it hasn't followed is asked first: **Follow the restored data** or **Keep this computer's data too**, which merges, so rolled-back items may return on every computer.
- Versions aren't copied when you change folder. **Look in another folder…** lists the versions in a folder that is no longer connected.
- A read-only computer can list versions and read their records, but has to take over to restore or save one.

The [Migration guide](#5-restoring-and-moving-to-a-new-pc) has the steps.

## Metrics reference

The full list with formulas is in the app's searchable Metrics glossary (source: `src/features/analysis/glossary.ts`). Each entry states which time it uses.

| Uses | Metrics |
|---|---|
| **Exact** | Time of day, hour histogram, weekday by hour heatmap, year calendar, sessions and session length, longest stretch, pauses, focus ratio, context switches, fragmentation, typical start and finish, working span, shift attainment and coverage |
| **Billable** | Project totals and shares, hours over time, billable hours and share, budget burn, earnings, effective hourly rate, rounding adjustment (billable minus exact), projection |

Definitions worth knowing:

- **A pause** is the gap between two consecutive segments of the same task, or from a task's last segment to its Stop, that begins and ends on the same calendar day in the zone you're viewing. Gaps crossing midnight, such as overnight or weekend breaks, aren't pauses and are excluded from every figure. A pause belongs to the day it began, and a still-paused task's open gap isn't counted. Pauses of different tasks add up, so a day can show more paused time than worked time.
- **Exact** leaves out time away that's unanswered or dropped, and billable pauses. **Billable** adds billable pauses and rounds once per task-day. The **rounding adjustment** is Billable minus Exact, with billable pauses shown separately. Thinking counts in both, shown separately.
- **Effective hourly rate** on a fixed-fee project is the fee divided by Billable hours. **Billed** and **unbilled** seconds are the time on and off a live billing summary. Tag analytics count a task's time under each of its tags, or time on a subtask with tags of its own under those, so tag totals can add up to more than the total.
- A band or shift filter hides Billable figures, because rounding works on whole task-days.
- Client working hours count every day of the week, weekends included, because you might work any day. Hours that end before they start, such as 22:00 to 06:00, run overnight into the next day, and 00:00 to 00:00 is round the clock. The Timeline and Analysis use the same rule.
- A forecast is a straight-line projection and needs 7 or more days, 20% of the period elapsed and 2 active days. Budget pace uses the last 28 days.
- Figures with too little data show "Not enough data".

## Data and privacy

| | |
|---|---|
| **Windows** | `%APPDATA%\com.rustcircle.zworktracker\` |
| **Windows, Store build** | A private folder of the package, removed on uninstall; likely `%LOCALAPPDATA%\Packages\PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp\LocalCache\Roaming\com.rustcircle.zworktracker\`, unconfirmed. See [Where the Store version keeps its data](#4-where-the-store-version-keeps-its-data) |
| **macOS** | `~/Library/Application Support/com.rustcircle.zworktracker/` |
| **Main file** | `z-work-data.db`: a SQLite database. Each record is kept as the same JSON a sync file holds, with timestamps in UTC (`2026-03-08T07:00:00Z`). While the app runs, `z-work-data.db-wal` sits beside it and holds the latest changes; there is no `-shm` file. The app holds the database for itself while it runs, so no other program can read it then |
| **Drafts** | `z-work-drafts.json`: descriptions being typed, local only, read at the next launch and then gone: put back, or moved to kept words. If this file is damaged, a notice says so and it is kept as `z-work-drafts.corrupt-<time>.json`. If it can't be read, a notice says that too, and it stays as it is for the launch after that |
| **Kept words** | `z-work-kept-words.json`: words the store wouldn't take, local only, shown in a notice at each launch until it is dismissed. If this file is damaged, a notice says so and it is kept as `z-work-kept-words.corrupt-<time>.json`. If it can't be read or written, a notice says that too |
| **Dated backups** | `backups/`: one JSON copy a day, plus safety copies made before a restore. The 1.3.1 backups stay there, with `z-work-data-legacy-1.3.1.json`, and are never removed by the app |
| **Before a migration** | `z-work-data.v<n>.db`: the database as it was before a later version changed its schema from version *n* |
| **Last version taken** | `versions-base.json.gz`: the data as of the last version this computer saved, which the next version's record of changes is compared with |
| **Damaged files** | Kept as `z-work-data.corrupt-<time>.db`, with its `-wal` file if there was one |
| **Left from 1.3.1, never changed** | `z-work-data.json`, `z-work-data.json.bak`, `z-work-heartbeat.json`, `z-work-data.v1.json`. 1.3.2 only reads `z-work-data.json` (or its `.bak`) once, at its first start, and reads `z-work-heartbeat.json` then and when you restore the kept 1.3.1 copy; it never changes any of them. Once your data is back and you won't go back to 1.3.1, you can delete them yourself |

Every change is one database transaction: it is either saved whole or not at all, and it is on the disk before the app goes on. The heartbeat of a running task is saved in the database too. If the database is damaged, the app sets it aside under the name above and tells you. With a sync folder, the data comes back from the folder. Without one, it restores the newest dated backup that can be read, and the notice names it. A database from a newer app version is refused and left untouched. None of this wipes your data silently.

**What leaves the machine:** nothing, except through your own sync folder. There the app writes `zWorkTracker/devices/` (each computer's data), `zWorkTracker/lease/` (which computer is making changes) and `zWorkTracker/versions/` (saved versions, gzip, with their records of changes). Those files hold your full labor data, including prices, unencrypted. There's no telemetry, and the build contains no HTTP or TLS library; a test enforces this.

## Developer guide

### Prerequisites

- Node 26 (`.nvmrc` and `engines` in `package.json`; CI reads the same file) and pnpm 12.16.1, the version `packageManager` pins
- rustup. The toolchain is pinned in `rust-toolchain.toml` (stable, with the `x86_64-pc-windows-gnu` target) and installs itself on first use. You don't need a global default. The code needs Rust 1.99 or later (`rust-version` in `src-tauri/Cargo.toml`).
- On macOS, Xcode command line tools. To build for Windows: `brew install mingw-w64 nsis`. MinGW's gcc also compiles SQLite, which is C, for the Windows target, so the Windows `cargo check` and `cargo clippy` below need it too

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
pnpm exec playwright test               # e2e against the IPC mock, under the real CSP; ZWT_SHOT_DIR=<folder> saves screenshots there
ZWT_STORE_SHOTS=1 pnpm exec playwright test e2e/store-shots.spec.ts   # the ten Store screenshots, 1920x1080, in ~/msix-build/store-listing-screenshots-1.4.0 (or ZWT_STORE_SHOTS_DIR); skipped without ZWT_STORE_SHOTS
pnpm smoke:native                       # real macOS builds: real webview, IPC and files

cd src-tauri
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check -p z-work-core --tests --locked --target x86_64-pc-windows-gnu        # test code compiles for Windows
cargo clippy --workspace --all-targets --target x86_64-pc-windows-gnu -- -D warnings

# Read a sample selection back, and scan the raw file for anything unselected
ZWT_SAMPLE_SELECTION_XLSX=/tmp/sel.xlsx cargo test --manifest-path src-tauri/Cargo.toml -p z-work-core the_workbook_builds
uv run --no-project --with openpyxl scripts/verify_selection.py /tmp/sel.xlsx
# Read the mixed-script timesheet with a real PDF reader, and render its first page
ZWT_SAMPLE_UNICODE_PDF=/tmp/uni.pdf cargo test --manifest-path src-tauri/Cargo.toml -p z-work-core the_mixed_script_sample
uv run --no-project --with pypdf --with pypdfium2 --with pillow scripts/verify_pdf.py /tmp/uni.pdf /tmp/uni.png
# Read a sample Excel file back with an independent reader
ZWT_SAMPLE_XLSX=/tmp/sample.xlsx cargo test -p z-work-core builds_with_earnings
cd .. && uv run --no-project --with openpyxl scripts/verify_xlsx.py /tmp/sample.xlsx
```

Continuous integration: `.github/workflows/ci.yml` runs these gates on `windows-latest` on each push to `main` and each pull request into `main`, and can be started by hand. Playwright there runs against the IPC mock, so it doesn't drive the real backend, and a green run says nothing about the installer or the app on a real desktop. Before the MinGW check it installs MSYS2's MinGW gcc on the runner, because that check compiles the bundled SQLite. A small macOS job runs the core's lint and tests, for its Unix-only file handling. It uses no secrets and signs nothing. Packaging runs only in `windows-build.yml`, by hand or on a tag. The timing test is too noisy for a shared runner, so run it locally.

`pnpm gen:tz` regenerates `src/generated/tzdata.json` from Rust's time zone database. Run it after updating `chrono-tz`.

### Architecture

The state machine, persistence, recovery, merge, rounding, earnings and exports are in a Rust crate with no Tauri dependency and an injected clock. A thin Tauri shell adds commands, tray, heartbeat and the sync thread, so timing doesn't depend on the window being visible. The UI receives a full snapshot after every change and computes display figures in pure TS modules.

```
src-tauri/
  crates/z-work-core/src/   Pure core
    machine.rs             Task state machine, projects, shifts, rates
    model.rs               Persisted and synced data model
    store.rs               The SQLite store: open, save, heartbeat, damage, schema migrations
    hlc.rs                 Stamps that follow the newest change seen
    persist.rs             Atomic file writes for backups and side files, the 1.3.1 file format
    merge.rs               Deterministic merge between devices
    sync.rs, detect.rs     Folder sync, sync folder detection
    lease.rs, lease_io.rs  One computer at a time: the pure rules, then reading and writing the records
    epoch.rs               The fence that keeps a restored version from being merged away
    versions.rs, gz.rs, changes.rs   Versions in the sync folders, gzip, the record of changes
    webview.rs             The WebView2 check and its message
    billing.rs             Day splitting, rounding, earnings
    report.rs, csv.rs, xlsx.rs, subtasks.rs   Exports
    tray.rs                Close-versus-quit decision, tray content
    service.rs, view.rs    Transactions, the UI's snapshot
  src/lib.rs               Tauri shell
  src/startup_task.rs      Start with Windows for the Store build
  crates/z-work-session/   Windows session and package queries, the workspace's only unsafe code
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

The app icon has two sources on purpose: `app-icon.svg` for large sizes and `app-icon-small.svg`, a variant with heavier strokes, for 16 to 32 px, where the large drawing is hard to read.

Billing and time zone rules exist in both Rust (for exports and the tray) and TS (for the live UI). `fixtures/*.json` runs against both.

### Data model and schema migration

The local store is a SQLite database, compiled into the app by `rusqlite` with its `bundled` feature (SQLite 3.54.1), so every system runs the same SQLite. It has three tables: `schema_version`, `meta` (this device's identity, preferences and sync state in the key `local`, and the heartbeat in `beat`), and `records(kind, id, json)`, which holds every synced record as the exact JSON it has in a device file. So the merge, stamps and deletion markers see the same values as before, and optional fields need no migration. A save writes only the records that changed, in one transaction. The connection uses WAL with `synchronous = FULL` and an exclusive lock, and `PRAGMA quick_check` runs at every open.

Three versions exist. `DB_SCHEMA_VERSION` in `store.rs`, 1, is the database's schema. `version` in the local data and `schemaVersion` in device files are both still 2, so sync files are as they were. To change the database's schema, add a step to `MIGRATIONS` in `store.rs` and raise `DB_SCHEMA_VERSION`. Steps only go forward, each in its own transaction, and a copy is kept as `z-work-data.v<n>.db` first. A database from a newer version is refused and left untouched. To change the data's shape, raise `SCHEMA_VERSION` and add a step to `migrate()` in `persist.rs`, which still upgrades version 1 data, such as an old backup; a test reads a real phase 1 file. Optional fields need no step, because every synced record defaults missing ones. An old build skips a newer device file, warns "Update this device" and never overwrites it. Task lists from version 1 get subtask ids derived from the task id and position, so every device derives the same ones without a new edit stamp. The tags of a subtask are a task's `subtaskTags`: one entry for each subtask that was given tags of its own or put back on Same as task, with its own stamp, so two computers editing different subtasks keep both, and the field is left out while empty, so a task without any is written as before and `SCHEMA_VERSION` stays 2.

The synced state is a set of records with stable ids, merged by taking the maximum under a total order. Property tests check that the merge is idempotent, commutative and associative, for time away, billable pauses, tags, templates, summaries, prefixes and the audit log too. Corrections, time away and billable pauses are overlays on raw segments, and `pieces.rs` turns them into the pieces every report reads. A synced file is untrusted: `validate.rs` refuses out-of-range times, amounts and references before a merge.

### Security model

- Strict CSP in `tauri.conf.json`: no inline scripts or styles, no remote content. E2e tests run under that same CSP and fail on any violation.
- Minimal capabilities: the window can only listen for backend events. No shell or filesystem plugin. The save and folder dialogs run from Rust.
- Every command input is validated in Rust. Descriptions are allow-listed to known nodes and rendered only through the editor; ESLint rejects raw HTML injection.
- Files from sync folders are untrusted: they are limited in size and count, schema-checked and checked for plausible times, durations and settings, and rejected files are skipped. A record that can be read but fails its checks is skipped and named in a warning, and the rest of that file is read. Each folder runs on its own worker with a time limit. Validation doesn't authenticate the writer; see [Folder sync](#folder-sync-on-onedrive-and-google-drive).
- A save checks the data it is about to write, as a load would, and reads back each record it writes from the JSON it is about to store. If either fails, it writes nothing, so a bad value can't replace a good store. A save that fails makes the next one rewrite every record, so what is in memory and what is on disk can't drift apart.
- The database is opened with an exclusive lock: only one copy of the app can write it, and a second one waits rather than writing beside it. It must be a zWorkTracker database, by its application id, and pass SQLite's `quick_check` at every open.
- `unsafe` is forbidden in this project's crates apart from `z-work-session`, which holds the few audited Windows calls, and clippy warns on `unwrap`, `expect`, `panic` and indexing.
- The test-only `smoke` feature (data folder override, extra commands) is never enabled in shipped builds. The demo seed and IPC mock are absent from the production bundle.

### Git workflow

Work happens on feature branches in small commits that end with the co-author line, and `main` is the published branch on GitHub. Merging and pushing are the owner's call. Lockfiles are tracked.

## Performance

Measured on an Apple M3 Ultra on AC power, with a synthetic store of 12 projects, 400 tasks and three years. 50,000 segments is about 13 years at 10 segments a day, so it's a stress size; 5,000 is the more likely one. **All numbers are macOS.** A typical Windows laptop will be several times slower. WebView2, NTFS and antivirus are the most likely to change the picture, above all cold start, the cost of a disk flush, and what a hidden webview does. Nothing here was measured on Windows.

**The SQLite store in 1.3.2**, against 1.3.1's JSON file, measured by `store_bench` on the same machine:

Median milliseconds, in a release build, at 1,000, 10,000 and 50,000 segments (1k, 10k and 50k). A sync cycle reads another device's file of N segments, half of them new to this store, merges it, saves, and writes this device's own file.

| Operation | 1k 1.3.1 | 1k 1.3.2 | 10k 1.3.1 | 10k 1.3.2 | 50k 1.3.1 | 50k 1.3.2 |
|---|---|---|---|---|---|---|
| open | 4.36 | 3.92 | 15.18 | 12.52 | 62.49 | 58.53 |
| save after one action | 31.89 | 9.48 | 47.83 | 10.52 | 113.01 | 20.29 |
| sync cycle, N/2 new segments | 86.35 | 45.37 | 155.94 | 86.22 | 448.37 | 301.68 |
| merge in memory (code unchanged) | 0.94 | 0.96 | 3.33 | 3.38 | 16.23 | 14.27 |

The 1.3.1 numbers were taken under a higher machine load (a load average of about 5, against 2.4 for 1.3.2), so open's small gain is within noise. A save is 3.4 to 5.6 times faster and a sync cycle 1.5 to 1.9 times, and both runs keep full fsync durability. At 50,000 segments the data folder holds one 20.9 MB database, against 31.6 MB in two JSON files.

**The performance pass of 1.3.1,** when the store was still a JSON file:

| | 5,000 segments, before → after | 50,000 segments, before → after |
|---|---|---|
| Cold start to first render, real app | 573 → 490 ms | 1,262 → 832 ms |
| Save after one action | 61 → 44 ms | 249 → 107 ms |
| Heartbeat, every 30 s with a task running | 60 → 13 ms | 252 → 15 ms |
| Disk written per heartbeat, with one store copy to `.bak` on the first beat after a save | 4 MB → 79 bytes | 32 MB → 79 bytes |
| Opening the store | 81 → 9 ms | 383 → 61 ms |
| Building and encoding a snapshot | 18 → 10 ms | 169 → 85 ms |
| Sync cycle with three other devices, nothing new | 150 → 70 ms | 916 → 319 ms |

With a task running and the window hidden, the real app at 50,000 segments used 8.4% of one core before and about 1% after, across all its processes, in the first minutes. WebKit suspends a hidden page after about five minutes, and from then on the main process goes from 2.5% to 0.4% and from 17 to 0.3 idle wakeups a second.

In headless Chromium against the IPC mock, at 50,000 segments, script time a second with a task running goes from 15 to 6 ms on Timeline and from 31 to 6 ms on Analysis with a year selected, and is 0 while hidden. Chromium isn't the app's webview, so these show how the page behaves, not what a user's machine will do. Showing every chart for three years takes about 100 ms the first time and 40 ms after. 200 rounds of tab and range switches grow the JS heap by 2 MB in total, with DOM nodes and listeners flat.

Left alone because measuring showed no case for a change:

- **Lazy-loading TipTap.** Removing it altogether, a 405 KB saving, takes 14 ms off a 569 ms cold start, and the chunk would still ship. Charts would gain no more. The map is already lazy, and its first open takes 415 ms.
- **Exports.** At 50,000 segments Excel takes 0.95 s and PDF 0.15 s, on a request and off the UI thread.
- **`opt-level = 3`.** About 10% faster for most of the backend, for a 23% bigger binary.
- **`panic = "abort"`.** 23% smaller, but a panic in a helper thread would take the app down, where today it survives.
- **The whole snapshot as JSON.** Every action still sends the page a 30 MB snapshot at 50,000 segments. The cost is linear and acceptable at any likely size. Memory follows the same line, with the webview near 800 MB at 50,000 segments and near 180 MB at 5,000. Changing this means a different IPC shape.

To repeat the measurements:

```sh
(cd src-tauri && cargo run --release -p z-work-core --example store_bench -- out.json)     # opening, saving and syncing the store at 1,000, 10,000 and 50,000 segments
cd src-tauri && cargo run --release -p z-work-core --example perf_bench -- 50000 out.json   # also prints digests of every output
pnpm build:e2e && node scripts/perf-frontend.mjs --out out.json                             # headless Chromium against the mock
CARGO_TARGET_DIR=<dir> pnpm tauri build --no-bundle --features smoke
node scripts/perf-native.mjs --exe <dir>/release/zWorkTracker --store <store> --out out.json # real app; needs the display on and the window not covered
```

`perf_bench write-store <dir> <segments> paused` makes such a store. A native run is only valid with the display on, because macOS stops drawing a covered window or one on a sleeping display.

## Packaging and signing

### Windows installer from macOS

```sh
pnpm package:windows
```

This builds with the GNU toolchain and writes `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/zWorkTracker_1.4.0_x64-setup.exe`. MinGW's gcc, `x86_64-w64-mingw32-gcc`, compiles the bundled SQLite into the exe as well as linking it. It then lists the exe's imports in `pe-imports.txt`, fails if a compiler runtime DLL is needed, and reports whether the installer and the files inside it are signed (reading those needs `brew install sevenzip`). `WebView2Loader.dll` ships inside the installer next to the exe.

### Microsoft Store package from macOS

```sh
pnpm package:msix                    # the Store package, from the build that package:windows left
pnpm package:msix --build            # builds the Windows app first, then the Store package
pnpm package:msix --identity both    # the Store and the test package (--identity test for only the test package)
pnpm msix:pri                        # makes the resources.pri of both packages with makepri, in a Windows VM (see below)
pnpm msix:vm                         # all of the Windows side: the indexes, both packages again, and the Windows App Certification Kit on the Store package (see below)
```

A run with `--identity both` packs the Windows build that `pnpm package:windows` left in `src-tauri/target/x86_64-pc-windows-gnu/release` as two packages, made from the same exe and differing only in the identity in their manifests. They are written to `bundle/msix` in that folder:

| File | Identity | For |
|---|---|---|
| `zWorkTracker_1.4.0.0_x64_store.msix` | Name `PedroMiguelRodriguesJorge.zWorkTracker`, Publisher `CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9`, publisher display name "Pedro Miguel Rodrigues Jorge" | Uploading in Partner Center |
| `zWorkTracker_1.4.0.0_x64_test-unsigned.msix` | Name `rustcircle.zWorkTracker.Test`, Publisher `CN=zWorkTracker Test Signing`, publisher display name "zWorkTracker (test)" | Trying the app on a PC, once you have signed it |

It builds nothing itself: `--build` runs the same `tauri build` as `package:windows` first, and without it an exe whose version isn't the app's is refused. `--identity` takes `store`, which is the default, `test` or `both`, and comes in any order with `--build`. A package of the same kind from an earlier run is removed first, and a run that fails leaves none of its own. At the end it checks that what was packed is in each package and that the manifest inside carries the identity the package was made for, and prints for each its path, size and SHA-256 and the identity and package family name read back from that manifest, then the version, build time and SHA-256 of the exe that went in.

**Neither is signed.** The Store re-signs MSIX packages with a Microsoft certificate after certification ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)), so the Store package needs no signature, and can't be installed on a PC as it is. The test package can't be installed until it is signed, which is left to you: sign it with a certificate whose subject is its publisher, `CN=zWorkTracker Test Signing`, and trust that certificate on the PC. The script never signs and holds no key.

**The identities are in `scripts/msix-manifest.mjs`,** not in the environment. The Store one is what Partner Center issued under **Product management > Product identity**, and the Store compares it with the package. It is public, so it is kept in the script and needs no setting. The package family name is the identity's name, an underscore and 13 characters worked out from its publisher, and it names the folder the package keeps its data in. The Store package's is `PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp` and the test package's is `rustcircle.zWorkTracker.Test_ym7m1j5c19s9r`, so the test package has a data folder of its own. `scripts/msix-manifest.test.ts` works both out from the identities. The variables `ZWT_STORE_IDENTITY_NAME`, `ZWT_STORE_PUBLISHER` and `ZWT_STORE_PUBLISHER_DISPLAY_NAME`, which named the identity before Partner Center issued it, are no longer read. The script says so if one is set, so a value left in a shell can't change a package's identity. The other variables are optional:

- `ZWT_MAKEMSIX`: the `makemsix` binary from Microsoft's [MSIX Packaging SDK](https://github.com/microsoft/msix-packaging). The default is `~/msix-packaging/.vs/bin/makemsix`, where `./makemac.sh --pack` builds it; packing is off in that script unless `--pack` is given.
- `ZWT_MSIX_OUT_DIR`: a folder for the packages, instead of `bundle/msix`.
- `CARGO_TARGET_DIR`: as for `package:windows`. A relative path is read from `src-tauri`, as Cargo does.

It also needs `sips` and `unzip`, which macOS has. `--build` needs `brew install mingw-w64 nsis`, as `package:windows` does. Unlike `package:windows`, it doesn't check which DLLs the exe imports, so run that after changing dependencies.

**The logo, the tiles and the taskbar icon** are cut from `src-tauri/icons/icon.png` with `sips`: 60 images in `Assets`, the same in both packages. The manifest names three of them, `StoreLogo.png`, `Square44x44Logo.png` and `Square150x150Logo.png`, and they stay. Each of the three also comes at the five display scales, as `<name>.scale-100.png` to `<name>.scale-400.png`, and the app icon comes at the 14 sizes Windows asks for, 16 to 256 px, as `Square44x44Logo.targetsize-<size>.png` and with `_altform-unplated` and `_altform-lightunplated` added to that name ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-construction)). The unplated images are what lets the taskbar and Start draw the logo without a plate; with only the plain `Square44x44Logo.png`, as in 1.3.2, they put it on one. **Windows finds those images only through a `resources.pri` in the package** ([Microsoft](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)), which `makemsix` can't make and `makepri`, from the Windows SDK, makes only on Windows. A package packed without one still builds, but the plate stays, and the script says so at the end of each run: `pnpm msix:pri`, below, makes the indexes. Not tested on Windows.

**`pnpm msix:pri` makes the two `resources.pri` from the Mac, with a Windows VM.** It needs the Windows 11 VM in UTM (Arm or x64) running on the shared network, which gives the Mac the address `192.168.64.1`, and the .NET SDK on the Mac for `dotnet`. It cuts the 60 images and writes the manifest of each package into `store/` and `test/` in `src-tauri/target/msix-pri`. It gets `makepri.exe` for ARM64 and for x64 from the `Microsoft.Windows.SDK.BuildTools` package on nuget.org, the newest release unless `--sdk-version` names one, checks the package with `dotnet nuget verify --all` and that Microsoft Corporation signed it and nuget.org served it, and keeps it in `~/msix-build/tools/sdk-buildtools/<version>` with its SHA-256: the next run asks nuget.org which release is the newest, and downloads nothing if it is the one it has kept. Nothing from the package is ever run on the Mac. It then serves the folders, both `makepri.exe` and a PowerShell script on `192.168.64.1:8765`, and prints the one line to type in PowerShell in the VM, so that nothing has to be pasted into it:

```
iwr 192.168.64.1:8765/d.ps1 -UseBasicParsing | iex
```

That script is for Windows PowerShell 5.1 and works only in `C:\zwt-test` on the VM. For each package it fetches the files and checks the SHA-256 of each, runs `makepri createconfig`, takes the `<packaging>` element out of `priconfig.xml`, runs `makepri new` and `makepri dump`, checks that the dump lists all 14 `_altform-unplated` images, and sends the `resources.pri` back. A line typed a second time, after one index was sent, asks the Mac (`GET /status`) what it holds and goes on with the other. If the Mac turns an index away, it says why on its own screen and in the answer, and keeps the file it refused in `received/<package>-refused.pri`. Only the PC that fetched the script may send an index back. It prints `OK` lines as it goes and, at the first thing that goes wrong, a `FAIL` line that says what. When both files have arrived, or after `--timeout` minutes (15), or on Ctrl-C, the Mac stops serving, checks each file as `package:msix` does and saves it as `packaging/msix/store/resources.pri` and `packaging/msix/test/resources.pri`. Then run `pnpm package:msix --identity both`. The script for the VM is also written to `src-tauri/target/msix-pri/d.ps1` to be read first, and `pnpm msix:pri --dry-run` does everything but the VM part, with made-up indexes and on 127.0.0.1, and installs nothing in `packaging/`. `--help` lists the options.

`package:msix` takes `packaging/msix/<package>/resources.pri` (or the file that `ZWT_MSIX_PRI_STORE` or `ZWT_MSIX_PRI_TEST` names) into a package only after checking it: it must be a PRI file, must name the identity of its own package and not the other's, and must hold the path of all 60 images, so an index made before the images changed stops the build and says to make it again. An index depends on the identity and on the names of the images, not on the version, so these two serve the next versions too as long as neither changes; keep them with the repo. A `resources.pri` does not depend on the processor either, so an index made in the Arm VM, with the x64 `makepri.exe` under emulation or with the arm64 one, serves the x64 packages. The script on the VM runs the x64 `makepri.exe` on every PC and the arm64 one only if the x64 one does not start, and says which one it used. The Mac side is tested in `scripts/make-pri.test.ts`, with a made-up index standing in for the VM. **Not tested:** the script for the VM on a real Windows VM (it was written and read on a Mac, which has no PowerShell to run it), and whether the taskbar and Start then draw the logo without a plate.

**`pnpm msix:vm` does the whole Windows side in one go, the Windows App Certification Kit (WACK) on the Store package included.** It is `pnpm msix:pri` and more, with the same VM and the same single line to type, which has not changed. Run `pnpm msix:vm` on the Mac, and in the VM open **Windows PowerShell as Administrator** (Start, type PowerShell, right-click Windows PowerShell, Run as administrator: the certificate store and the kit need it) and type, or press the up arrow until it is there:

```
iwr 192.168.64.1:8765/d.ps1 -UseBasicParsing | iex
```

It serves on `192.168.64.1:8765` and nowhere else (`--host` and `--port` change that; the port being busy, or the address not being up because the VM is not running, is said at once and nothing is stopped to make room), and takes a GET or a PUT for exact paths only: the files it was told of, `/status`, the two indexes, `/wack-report.xml` (5 MB at most) and `/vm-status.json` (64 KB at most). Then:

1. **The indexes.** The VM makes both `resources.pri` as above; the Mac checks and saves them in `packaging/msix`.
2. **Both packages again.** The Mac packs them with those indexes (`package:msix --identity both`; the release exe that is there is packed as it is, nothing is built) and checks each: the 60 images and `resources.pri` at the root, the one that was saved, the identity, version 1.4.0.0, x64, the package family name, no signature. If they pass it publishes them in `~/msix-build` (`--publish-dir`), where a package of the same name that was there, which has no index, is first renamed `...no-pri.msix` (`...previous-<time>.msix` if it had one), never deleted; packages of other versions, `vm-test/` and `tools/` are not touched. It prints the SHA-256 of what it published.
3. **A copy of the Store package, signed for the kit alone**: `zWorkTracker_1.4.0.0_x64_store-wack.msix`, signed by `osslsigncode` with a certificate that `openssl` makes for this run: RSA 3072, subject exactly the Store publisher `CN=1DEF8D7B-1D68-4604-8047-048DC92CF3A9`, valid 7 days, for code signing only, no CA. The signature is checked with `osslsigncode verify` against that certificate. The private key is in a temporary folder that only you can open, is deleted the moment the copy is signed, whatever happened, and is never written in the repo, a log or the screen. **The Store package that was published, the one to upload, stays unsigned and untouched**: its SHA-256 is read before and after. With `ZWT_TEST_PFX` (a `.pfx`) and `ZWT_TEST_PFX_PASS_FILE` (a file with its password) both set, a copy of the test package is signed too, with that key, as `...test-signed.msix`; the password is only ever named to the tools as a file.
4. **The kit, in the VM.** It fetches the copy and its public certificate and checks their SHA-256, puts the certificate in `LocalMachine\TrustedPeople`, and, if `appcert.exe` is missing, downloads Microsoft's installer of the Windows SDK from `https://go.microsoft.com/fwlink/?linkid=2382519` (the link for the current SDK, 10.0.28000.2957, on [Windows SDK downloads](https://learn.microsoft.com/windows/apps/windows-sdk/downloads)), checks that its Authenticode signature is valid and Microsoft Corporation's, and runs `winsdksetup.exe /features OptionId.WindowsSoftwareLogoToolkit /quiet /norestart /ceip off`: that one feature is the kit. It takes some minutes and shows nothing while it runs. Then `appcert.exe reset` and `appcert.exe test -appxpackagepath C:\zwt-test\zWorkTracker_1.4.0.0_x64_store-wack.msix -reportoutputpath C:\zwt-test\wack-report.xml`, which installs and starts the app and takes ten to thirty minutes, and sends the XML report back. Whatever happens, it then takes the certificate out again, by its thumbprint, and removes the package the kit installed, by the exact name of the Store identity and no other. If a signed test package was made it installs that over the earlier test install, starts it, and says what to look at: the taskbar and Start icons without a plate, and the tray icon.
5. **The report.** The Mac prints the overall result, then every test as PASS, FAIL or WARN with the text of what failed (a test the kit calls optional that fails is a WARN: it does not change the overall result), and saves the report, `wack-summary.txt` and `wack-summary.json`, the WACK copy, its certificate, the VM's status and a log in `.stack/out/msix-vm/<YYYYMMDD-HHMM>/`. The format of the report was read off a real one and off two public readers of it; see the comment above `parseWackReport` in `scripts/msix-vm.mjs`. It stops when the VM says it has finished, which includes its clean-up, a few minutes at most after the report, or after `--timeout` minutes (60), or on Ctrl-C. The exit status is 0 if the report passed and the VM finished, 2 if the report's overall result is not PASS, 1 for anything else.

Each step in the VM prints `OK`, and the first thing that goes wrong prints `FAIL`, the step and the reason, which it also sends to the Mac, so that both screens say it; then it cleans up and stops. Type the line again after fixing it: what the Mac already holds is not made again. `pnpm msix:vm --dry-run` does the Mac side for real with no VM (made-up indexes, 127.0.0.1, a temporary folder, a made-up report) and deletes what it made; `--help` lists the options. It needs `openssl` (3.4 or newer, `brew install openssl`; the one macOS ships cannot do it) and `osslsigncode` (`brew install osslsigncode`) as well as `makemsix`. **Not tested:** the script for the VM on a real Windows PC (it was written and read on a Mac, which has no PowerShell to run it), the Windows SDK installer's feature name on a machine (it was read off the installer's own manifest by others, and a Windows 11 PC got `appcert.exe` 10.0.28000.2957 from it), and **the kit on Windows on Arm64, which the VM may be**: Microsoft documents no Arm64 build of the kit, and GitHub's `windows-11-arm` images have the Windows SDK with no `appcert.exe`. The script tries, and if `appcert.exe` is not there afterwards it stops with a FAIL that says so; the kit then has to run on an x64 Windows PC. No Store package has been run through the kit yet.

**The version** is the app's with a 0 added, so 1.4.0 is package version 1.4.0.0. The Store keeps the last part for itself and wants 0 there, the other parts are whole numbers up to 65535, and the first can't be 0 ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements#package-version-numbering)). A version that breaks this stops the script, rather than making a package the Store would turn away. The manifest makes it a full-trust x64 app. Its minimum is Windows 10 version 2004 (`MinVersion="10.0.19041.0"`), so it covers the Windows 10 and 11 the rest of this README is written for. It declares a startup task, `zWorkTrackerStartup`, which stays off until it is turned on, and the app's **Start with Windows** switch now turns it on and off.

**What has been tested.** With made-up identity values: `makemsix` accepted the manifest, the startup task included. It checks a manifest against Microsoft's schemas and nothing more, so it also accepts one that names files that aren't there or a version the Store refuses; the script checks those itself. The package unpacks to files identical to the ones packed, and its block map uses SHA-256, as the Store requires. **Not tested:** Partner Center accepting the upload, certification, the Windows App Certification Kit (it runs only on Windows, and Microsoft advises running it before submitting; `pnpm msix:vm`, above, runs it in the VM), and installing or running the package on Windows, including everything in the list below. The [checklist](#manual-windows-test-checklist) covers it.

**How the app handles being packaged, not yet seen on Windows.** Microsoft documents that a packaged app's writes under HKCU, and the new files it creates under AppData, go to a private copy that only that app sees and that is removed on uninstall ([Microsoft](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)). The app now plans for that rather than avoiding it:

- **One restricted capability.** The manifest declares `runFullTrust` (a restricted capability, which needs a short justification in Partner Center) and nothing else, and in particular not `unvirtualizedResources`, which turning that redirection off would take. `scripts/msix-manifest.test.ts` holds it to that.
- **Local data is private and removed on uninstall, so the cloud folder is the permanent copy.** The app asks Windows for its package identity at launch and, when it has one, urges a cloud folder in the setup, keeps a warning up while none is connected, and says so on removing the last folder and under Backups. See [Microsoft Store build: where your data lives](#microsoft-store-build-where-your-data-lives).
- **Start with Windows uses the startup task `zWorkTrackerStartup`,** through Windows' `StartupTask` API, instead of the HKCU `Run` key, which would never start anything from a package. The installer build keeps the `Run` key.
- **Notifications** are sent as toasts under the package's AppUserModelID, which the notification plugin doesn't pass.
- **WebView2:** the same message and download link as the installer build, since it is the same program.

### Trusting your own builds with a self-signed certificate

This is the route for your own PCs, and only those. A self-signed certificate is trusted only on PCs set up as below. It isn't public code signing and must not be described as signed for anyone else.

**What it doesn't do.** SmartScreen may still warn about a downloaded file, because its reputation check is separate from trusting a certificate. Norton and other security tools decide on their own and may still flag the file. If Norton flags it, don't add exclusions; report a false positive through Norton's route: <https://support.norton.com/sp/en/us/home/current/solutions/kb20090410134005EN>.

Smart App Control, on a PC where it is switched on, is a further check. Microsoft says it runs an app only if its own service recognises it or it is signed by a certificate authority in the Microsoft Trusted Root Program, which a self-signed certificate is not: <https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview>. Microsoft doesn't describe trusting a certificate yourself as a way round that, so the steps below may not be enough there. Settings > Windows Security > App and Browser Control shows whether it is on.

**What has been tested.** The PowerShell for creating the certificate (step 1) has been run, and the two GitHub secrets made from it exist. How the certificate then works on a PC, and installing or running the app on a real Windows desktop, are untested. Signing has run from macOS with a throwaway certificate (see [signing from macOS](#signing-from-macos)) and on GitHub with this one (see [Windows installer from GitHub](#windows-installer-from-github)).

**1. Create the certificate, once, on one PC.** It can sign code and nothing else, and lasts 5 years. In PowerShell:

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Pedro Miguel Rodrigues Jorge (zWorkTracker)" `
  -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(5)
$cert.EnhancedKeyUsageList   # should list Code Signing only
$cert.Thumbprint             # note it down: this names the certificate from here on
```

**2. Export the two files.**

```powershell
$folder = New-Item -ItemType Directory -Force "$HOME\zWorkTracker-signing"
$password = Read-Host -AsSecureString "Password for the .pfx"
Export-PfxCertificate -Cert $cert -FilePath "$folder\zWorkTracker-signing.pfx" -Password $password
Export-Certificate -Cert $cert -FilePath "$folder\zWorkTracker-public.cer"
```

- `zWorkTracker-signing.pfx` is **private**: anyone with it and its password can sign as you, and your PCs will believe them. Keep it password-protected and out of this repository and of OneDrive, Google Drive or any other sync folder. Back it up to somewhere offline, such as a USB drive in a drawer, and keep the password in your password manager, not next to it.
- `zWorkTracker-public.cer` is public. It is the only file the other PCs need.

**3. Trust it on each PC, the signing PC included.** Copy the `.cer` over, and in PowerShell run as administrator:

```powershell
Import-Certificate -FilePath .\zWorkTracker-public.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath .\zWorkTracker-public.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

The PC now accepts anything signed with that key, which is why the `.pfx` matters so much.

**4. Build signed.** The exe has to be signed before it goes into the installer, and a finished installer can't be opened to do that afterwards. So signing happens during the build, through `bundle.windows.signCommand`, which runs `scripts/windows-sign.mjs` in this order: the exe and bundled DLLs, then the uninstaller as the installer is written, then the installer. Each file gets SHA-256 and an RFC 3161 timestamp, as in `signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ...`. The timestamp keeps a signature valid after the certificate expires.

On a Windows PC with the Windows SDK's signing tools and this project's build tools:

```powershell
$env:WINDOWS_CERT_THUMBPRINT = "<the thumbprint>"
$env:SIGNTOOL_PATH = (Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1).FullName
pnpm tauri build --bundles nsis
```

Or on GitHub, which never needs the certificate on another machine's disk for longer than the build: put the two secrets in the `windows-signing` environment, then run **Windows build** from the Actions tab. The first command creates the environment, which is needed once. The second reads the file and pipes it straight into the secret, and the third asks for the password:

```powershell
gh api -X PUT repos/rustcircle/z-work-tracker/environments/windows-signing
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\zWorkTracker-signing\zWorkTracker-signing.pfx")) | gh secret set WINDOWS_CERT_PFX_BASE64 --env windows-signing --repo rustcircle/z-work-tracker
gh secret set WINDOWS_CERT_PASSWORD --env windows-signing --repo rustcircle/z-work-tracker
```

The artifact's name then ends in `-self-signed`. With no secrets the workflow still succeeds and the name ends in `-UNSIGNED`.

**5. Check it,** on a PC set up as in step 3. `signtool` comes with the Windows SDK, isn't on the PATH, and is found as in step 4. `Get-AuthenticodeSignature` is part of Windows, so it's enough on a PC without the SDK:

```powershell
& $env:SIGNTOOL_PATH verify /pa /v .\zWorkTracker_1.4.0_x64-setup.exe
Get-AuthenticodeSignature .\zWorkTracker_1.4.0_x64-setup.exe | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

`signtool` should end with `Successfully verified`, and `Status` should read `Valid`, with a `TimeStamperCertificate`. After installing, run the same two commands on `$env:LOCALAPPDATA\zWorkTracker\zWorkTracker.exe` and `uninstall.exe` beside it. Check the installer and the installed files: the exe left in `src-tauri\target` by the build is the unsigned original.

**If the key leaks,** or you lose track of the `.pfx`, stop trusting the certificate. A timestamped signature stays valid for as long as a PC trusts it, so this is the only thing that helps. On each PC, as administrator:

```powershell
$thumbprint = "<the thumbprint>"
Remove-Item "Cert:\LocalMachine\Root\$thumbprint", "Cert:\LocalMachine\TrustedPublisher\$thumbprint"
```

On the PC that made it, also run `Remove-Item "Cert:\CurrentUser\My\$thumbprint" -DeleteKey`. Delete the `.pfx` and its backups, delete the two GitHub secrets, then start again from step 1 and rebuild. They are environment secrets, so the commands name the environment: `gh secret delete WINDOWS_CERT_PFX_BASE64 --env windows-signing --repo rustcircle/z-work-tracker`, and the same for `WINDOWS_CERT_PASSWORD`.

**When it expires,** or a few months before, start again from step 1 with a new certificate and repeat step 3 on each PC. Replace the GitHub secrets. Builds already installed keep verifying while the old certificate stays trusted, thanks to their timestamps, so keep it trusted until they've been replaced by a newer build. Then remove it as above. New builds can't be signed with an expired certificate: the workflow stops with that message.

### Signing from macOS

`pnpm package:windows` signs too, with the `.pfx` copied to the Mac, outside this repository and any sync folder. It needs `brew install osslsigncode sevenzip`:

```sh
export WINDOWS_CERT_PFX_PATH="$HOME/zWorkTracker-signing/zWorkTracker-signing.pfx"
read -rs WINDOWS_CERT_PASSWORD && export WINDOWS_CERT_PASSWORD
pnpm package:windows
unset WINDOWS_CERT_PASSWORD
```

It reports the signatures of the installer and of what's inside it, and fails if any is missing or can't be checked. **What has been tested:** this was run with a throwaway test certificate that has since been deleted, and `osslsigncode verify` accepted the installer and, unpacked from it, `zWorkTracker.exe`, `uninstall.exe` and `WebView2Loader.dll`, each with a DigiCert timestamp. PFX files using the encryption Windows may export (3DES or AES-256) opened fine. **Not tested:** Windows itself accepting those signatures, which `osslsigncode` made. The build on GitHub signs with `signtool`, and `signtool` checked its signatures on a Windows runner; see [Windows installer from GitHub](#windows-installer-from-github).

### Windows installer from GitHub

`.github/workflows/windows-build.yml` builds on `windows-latest`, by manual run or a `v*` tag. That build uses Rust's MSVC target, and the build from macOS uses MinGW; the bundling config is the same. [Run 41358005617](https://github.com/rustcircle/z-work-tracker/actions/runs/41358005617), started by hand on `main` at `88d22de`, passed its gates and built the installer on the MSVC target, signed with the self-signed certificate. On the runner, which had been set to trust that certificate, `signtool verify` accepted the installer and, unpacked from it, `zWorkTracker.exe` and `uninstall.exe`. The artifact was named `z-work-tracker-windows-self-signed`. How a PC treats that certificate and installer is untested, and so is installing or running the app on a real Windows desktop. The workflow needs no secrets: without them it builds, warns, and names the artifact `z-work-tracker-windows-UNSIGNED`. That run had the secrets, so the build without them hasn't run on GitHub.

### Windows code signing

The artifacts are **unsigned** until you add credentials. No certificate is included, and none is created. The route in use is [the self-signed one](#trusting-your-own-builds-with-a-self-signed-certificate), which is Route 2 below; Routes 1 and 3 stay here, unused, in case that changes. Signing runs through `bundle.windows.signCommand` for the exe, the installer, the uninstaller and the bundled DLLs. It always uses SHA-256 with an RFC 3161 timestamp. With no credentials the build prints `UNSIGNED` and succeeds. Partly set credentials fail the build, so a release isn't silently unsigned.

**First, check the metadata.** In `src-tauri/tauri.conf.json`, `bundle.publisher` is what Installed Apps shows, and `bundle.copyright` names the copyright holder. With your own certificate, keep the publisher the same as the name on it. The name Windows shows in security prompts always comes from the certificate.

**Route 1: Azure Artifact Signing (formerly Trusted Signing), recommended.**

1. Create an Artifact Signing account, an identity validation and a certificate profile in Azure.
2. Create an app registration and give it the signer role on the profile.
3. Install the tool on the build machine: `cargo install trusted-signing-cli`
4. Set the variables listed in `.env.example`: `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

**Route 2: your own certificate.**

- On Windows, use a certificate in the store with `WINDOWS_CERT_THUMBPRINT`, or a PFX with `WINDOWS_CERT_PFX_PATH` and `WINDOWS_CERT_PASSWORD`, through signtool.
- From macOS, `brew install osslsigncode` and use the PFX variables.
- `WINDOWS_TIMESTAMP_URL` is optional.

**Route 3: SignPath Foundation, free for open source (if the project is accepted). Not in use: the job is dormant unless `SIGNING_ROUTE` is set.** Acceptance isn't assured, and the routes above and unsigned builds keep working regardless. **The publisher Windows shows will be "SignPath Foundation", not you.**

1. Set the repository variable `SIGNING_ROUTE` to `signpath`. This selects the workflow's `signpath` job; the `build` job then skips.
2. Add the secret `SIGNPATH_API_TOKEN`, and the variables `SIGNPATH_ORGANIZATION_ID` and `SIGNPATH_CONNECTOR_URL`.
3. In SignPath, create project `z-work-tracker`, policy `release-signing` with manual approval, and artifact configurations `exe` and `installer`.

The job runs only on a GitHub-hosted Windows runner, because SignPath won't sign what's built elsewhere, so the installer built from macOS can't take this route. It signs the exe, packs it into the installer with `makensis`, signs the installer, then verifies both with `signtool verify /pa`. That's two approvals per release. The uninstaller embedded in the installer stays unsigned on this route. None of this has run yet.

**On GitHub,** add the same names as secrets of the `windows-signing` environment, with the PFX as base64 in `WINDOWS_CERT_PFX_BASE64`. The workflow writes the PFX to a temporary file, removes it after the build whatever happened, and prints no secret. It unpacks the installer and runs `signtool verify /pa` on it and on the exe and uninstaller inside, and fails if any signature, timestamp or signer is wrong. For a self-signed certificate it first trusts the public part on that runner, which is thrown away afterwards, since the check can't pass otherwise.

Never commit real values. `.env` is ignored by git, and so are certificate and key files. Note that scripts read variables from the environment, so export them or load `.env` first. Signing has been run with a throwaway certificate from macOS, and with the self-signed certificate on GitHub's Windows runner.

### Manual Windows test checklist

None of this has been run yet. Please check on real Windows 10 and Windows 11 PCs, and note for each item the Windows edition and build (`winver`), the build type, pass or fail, and a screenshot of every dialog. The installer build is `zWorkTracker_1.4.0_x64-setup.exe` from `pnpm package:windows`; the Store build is `zWorkTracker_1.4.0.0_x64_test-unsigned.msix` from `pnpm package:msix --build`, installed test-signed with `Add-AppxPackage` or through Partner Center flighting.

**Both builds, and the installer build:**

- [ ] WebView2 is present and the app opens. With WebView2 disabled, a clear message appears, not a blank window
- [ ] The installer runs without admin rights; SmartScreen behaves as described
- [ ] Start Menu shortcut, optional desktop shortcut and launch on finish work
- [ ] Listed in Installed apps with name, version, publisher and icon
- [ ] Start, Pause, Resume and Stop work, with auto-pause on another task
- [ ] Space does nothing on Start, Pause, Resume and Stop, pressed or held, even right after clicking that button; Enter on a focused one still works
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
- [ ] Deleting a task from its Details: Enter and Space do nothing in the two dialogs, a mouse click goes on, and so does a tap on a touch screen, if the PC has one; a screen reader's activation of Continue and Delete task, if you use one, does nothing; a double click on Continue stops at the last dialog; the task leaves the Timeline, Analysis and the tray
- [ ] Start with Windows works
- [ ] Upgrade keeps data, and closes a running app cleanly
- [ ] Uninstall removes files, shortcuts and the autostart entry; unticked keeps data, ticked deletes it; sync folders are untouched

**Both builds, 1.3.2 store** (on Windows 11 at least):

- [ ] After a few actions, the data folder holds `z-work-data.db` and `z-work-data.db-wal`, and no `z-work-data.db-shm`. For the Store build that is the package's folder under `%LOCALAPPDATA%\Packages\PedroMiguelRodriguesJorge.zWorkTracker_54k2cbaqgvhqp\LocalCache\` (for the test package, `rustcircle.zWorkTracker.Test_ym7m1j5c19s9r` in place of that folder name); record its full path. For the installer build it is `%APPDATA%\com.rustcircle.zworktracker\`
- [ ] An action (rename a task, or Start), then at once End task on zWorkTracker in Task Manager, then relaunch: the change is still there
- [ ] On a PC that synced under 1.3.1 and quit, installing 1.3.2 over it: the first start shows the notice that the data is being brought back from the folder, and after the first sync every project, task, hour and billing summary is back; the device keeps its name in **Settings > Sync between devices**, and `z-work-data.json` is unchanged (size and date)
- [ ] On a PC that used 1.3.1 without a folder: 1.3.2 starts empty with its notice, **Settings > Backups** lists the 1.3.1 backups and `z-work-data-legacy-1.3.1.json`, and restoring that copy brings the data back
- [ ] With the clock set 10 minutes back after a change synced from another PC, the warning "This computer's clock is ... behind a change saved on *name* ..." appears, has no close button, and goes once the clock is set right

**WebView2 missing** (a Windows 10 22H2 VM, build 19045, with no "Microsoft Edge WebView2 Runtime" in Installed apps; Windows 11 can't remove it):

- [ ] Starting either build shows one message titled "zWorkTracker", no window and no tray icon. It starts "zWorkTracker needs the Microsoft Edge WebView2 Runtime, and it wasn't found or is turned off on this computer.", shows <https://developer.microsoft.com/en-us/microsoft-edge/webview2/> and ends "Your data is safe." Buttons **Open download page** (default) and **Close**
- [ ] **Open download page** opens that exact page in the default browser, and the process is gone from Task Manager within 2 seconds. **Close**, and Esc, end it with nothing opened
- [ ] The installer, before copying files, shows a Yes/No warning with the same words, the link and "Open the download page now?". Yes opens the page and the install carries on; No carries on. `/S` installs silently with no message. On a PC with the runtime there is no warning
- [ ] Upgrading or uninstalling the installer build with the runtime still missing shows no message from its `--quit` run
- [ ] After installing the Evergreen runtime from that page, the app opens normally
- [ ] With the runtime present, `set WEBVIEW2_USER_DATA_FOLDER=C:\Windows\System32\drivers\etc\hosts` in cmd, then starting `zWorkTracker.exe` from there, shows the same message followed by "Details: Failed to setup app: ..." and the same two buttons. If the window opens normally, try a folder you can't write to, such as `C:\Windows\System32`, and record what happened

**Store build:**

- [ ] First run with no sync folder: the **Sync between computers** step says "Choose a cloud folder." with the Store wording, and Skip asks **Continue without a folder?**. After setup, the warning "This copy of zWorkTracker keeps its data in a private Windows folder ... Settings > Sync between devices." stays until a folder is connected, then goes. The installer build shows no such warning
- [ ] **Start with Windows** on: no Windows prompt, the switch stays on, Task Manager > Startup apps lists zWorkTracker as Enabled, and the app starts at sign-in, showing its window. Off: Disabled there, and it doesn't start
- [ ] Turned on in the app, then disabled in Task Manager > Startup apps: the switch is off and greyed with "You turned this off in Windows, so only Windows can turn it back on: Settings > Apps > Startup.", and **Open Startup settings** opens that page. Turned back on there: the switch is on and movable again. The setup's Start with Windows step behaves the same
- [ ] Optional: a policy that blocks startup tasks gives "A policy on this computer doesn't allow this, or the device doesn't support it." with the switch greyed
- [ ] With the window hidden, a time-away question, a budget alert or the long-running reminder appears as a toast from zWorkTracker, with the package's name and icon, and is listed under zWorkTracker in the notification centre. With its notifications turned off in Settings > System > Notifications, none appears and nothing fails. The installer build's toasts still appear
- [ ] A day of use: the window renders, data saves, **Settings > Backups** lists backups, and nothing complains about the WebView2 data folder. Record where the data folder really is (see [Where the Store version keeps its data](#4-where-the-store-version-keeps-its-data))
- [ ] Uninstalling removes its private data folder

**Installer build, Start with Windows:**

- [ ] On: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` has a zWorkTracker value and sign-in starts the app, showing its window. Off: the value is gone

**Two PCs on real cloud folders** (OneDrive, then Google Drive, then both):

- [ ] A timer started on PC A makes PC B show the read-only banner naming A, within about 2 minutes plus the cloud's delay. Record the delay: the design assumes under 5 minutes each way
- [ ] **Check again** on B shows the current state when it finishes
- [ ] Quitting A from the tray exits within 5 seconds, its `zWorkTracker\lease\<A's id>.json` says `released`, and B's banner clears without a take over
- [ ] On B, while A is read-only, tray Resume shows "A is using zWorkTracker, so this computer is read-only. Take over from the banner to work here." as a toast, brings B's window up with the banner, and starts nothing
- [ ] While A runs a timer and is online, B's banner has **Check again** only. **Pause it from here** on B for that task stops A's timer when A next syncs, and about 15 minutes later, with nothing changed on A, B's banner clears after **Check again**
- [ ] Take over on B once nothing has come from A for 15 minutes, once with a timer left running on A (A's network cut) and once with A switched off: B's banner offers **Take over…** only after those 15 minutes. B syncs at once after the second question, A's settled time appears on A after its next sync, and A goes read-only with its notice
- [ ] Removing one of two folders on the holder marks its lease record released there, and the other stays held
- [ ] **Settings > Versions** lists versions from both folders; **Save a version now** works; **What changed** shows the record; a restore is followed by B at its next sync, which keeps a copy of what it had as a version

**Moving from the installer build to the Store build** (see the [Migration guide](#3-moving-from-the-installer-version-to-the-store-version)):

- [ ] On another PC: after the installer build has synced to a OneDrive folder and quit, the Store build's setup offers the folder, connecting it brings every project, task and hour, **Settings > Sync between devices** counts the installer copy as another device, and uninstalling the installer build with **Also delete my time data** unticked leaves the Store build's data as it was
- [ ] On the same PC, with the installer build's data present and no folder connected: record whether the Store build opens with that data (the same device) or empty. Either is accepted
- [ ] Starting one build while the other runs: record whether the running window comes up instead, or both run

## Troubleshooting

| Problem | What to do |
|---|---|
| "Windows protected your PC" | SmartScreen doesn't know the file yet, signed or not. Choose **More info**, then **Run anyway**. |
| Blank window or WebView2 message | Install the Evergreen WebView2 Runtime from <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>, or run Windows Update, then open the app again. Your data is safe. |
| "Read-only." banner | Another computer is making changes. Quit it from its tray, or press **Release now** there, then **Check again** here. If you can't get to it, ask it to pause its task with **Pause it from here**, on the task. It lets go by itself 15 minutes after its last change. **Take over…** appears once nothing has come from it for 15 minutes. See [One computer at a time](#one-computer-at-a-time). |
| "Skipped *name*: it holds data from before a restored version" | That computer is on an older app version, or hasn't synced since a restore. Update it and let it sync. |
| A folder asks whether to follow restored data | Its data was restored from a version, and this computer has data from before that. Choose in **Settings > Sync between devices**; see [Versions and restoring](#versions-and-restoring). |
| "This copy of zWorkTracker keeps its data in a private Windows folder" | This is the Store build with no cloud folder. Connect one in **Settings > Sync between devices** before you uninstall anything. |
| The app seems gone after closing | It's in the tray; check the overflow arrow. Only tray **Quit** exits. |
| Time kept running overnight | The app asks about a sleep or idle time when you return, and it counts nowhere until you answer. Answer **Drop**, or correct the segment. |
| A summary won't let me answer about time away | That segment is on a billing summary. Void the summary, answer, then create it again. |
| A PDF shows empty boxes | The PDF's font covers Latin, Greek and Cyrillic. Use the Excel or CSV export for other scripts and emoji. |
| Sync folder not detected | Use **Choose another folder**. Only common "My Drive" language variants are detected. |
| A sync folder shows an error | Check the desktop client is running and the drive is connected. Local data and other folders are unaffected. |
| "Written to folder" but another PC has no data | The desktop client may still be uploading. |
| "newer version" warning | Update the app on this device. |
| "The data file was damaged" | The database couldn't be read, so the app set it aside as `z-work-data.corrupt-<time>.db` in the data folder, and the notice gives its path. With a sync folder, your data comes back from it after the first sync. Without one, the app restored the newest dated backup that could be read, and the notice names it: changes made after that backup are missing. Another backup can be restored in **Settings > Backups**. |
| "This computer's clock is ... behind a change saved ..." | This computer's date or time is wrong, or the other computer's is. Correct the clock that is wrong, for example with **Sync now** under **Settings > Time & language > Date & time** in Windows. The warning goes once the clock has caught up. See [Clocks and the latest edit](#clocks-and-the-latest-edit). |
| Empty after upgrading to 1.3.2 | With a sync folder, the data appears after the first sync; if a warning says it hasn't arrived, check that the folder is synced to this computer and press **Sync now**. Without a folder, restore `z-work-data-legacy-1.3.1.json` in **Settings > Backups**. See [Upgrading to 1.3.2](#upgrading-to-132). |
| Focus ratio looks low | It counts same-day gaps between sessions of each task, added across tasks. See [Metrics reference](#metrics-reference). |
| Earnings show "No rate set" | Set a price per hour on the project. |

## Known limitations

**One computer at a time is a best effort.** Cloud folders sync late and offer no lock, so the [lease](#one-computer-at-a-time) can't be exact. Two PCs can both make changes for a few minutes: while a claim is still uploading or downloading, after a take over until the other PC hears of it, and while a PC works offline or with **Work here anyway…**. What both did merges, under the rules above, including the limit below. The 15 minutes after which a PC "looks inactive" assume about 5 minutes for a file to reach the cloud and 5 to come back down. **How long OneDrive and Google Drive really take hasn't been measured**, and the app has never run against their real desktop clients. An app on an older version doesn't take part at all: it writes whenever it is used, so update every PC.

**After a restore, older app versions are left behind.** A PC on an app version from before 1.3.1 doesn't know a version was restored. It merges the restored data with its own and writes on as before, and every newer PC skips its file, with a warning naming it, until it is updated. Once it is updated, it follows the restore: the time it logged since the restore was made is carried into the restored data, and everything else it held is kept in a safety copy and as a version, not merged.

**Upgrading from 1.3.1 goes through the sync folder.** 1.3.2 takes only this computer's identity, folders and a few settings from the 1.3.1 data file. Changes made in 1.3.1 that weren't synced before the upgrade stay only in that old file and in `z-work-data-legacy-1.3.1.json`: restoring that copy in **Settings > Backups** brings them back, along with the rest of this computer's data as it was then.

**Stamps need clocks within a day.** An edit is stamped at most one day past this computer's clock. If another computer's change is dated further ahead, an edit made here can't be stamped after it and may lose to it, and the [warning](#clocks-and-the-latest-edit) says so. A computer whose clock is more than two days behind skips the other computers' files as dated ahead, never sees their changes, and so can't show the warning either.

**The database is the app's alone while it runs.** It is opened with an exclusive lock, so no other program, such as a SQLite browser or a backup tool that reads open files, can read `z-work-data.db` until the app quits. Copy the data folder after a tray **Quit**.

**Clocks that are far out.** The app guards against a clock that jumps, but three cases are known and not fixed:

- **Versions thinned too early.** A computer whose clock is far ahead, and that has never saved a version in a folder, judges the other computers' versions there by its own clock the first time it thins that folder out, so it can remove versions that are still young.
- **Time cut after a restore.** A restore made on a computer whose clock was ahead is dated by that clock. A computer that follows it carries the time it logged since it last read the folder into the restored data. One that has not read the folder yet since it started, or that follows by answering the question in **Settings > Sync between devices**, carries only what it logged after the restore's date on that clock. Time logged between the real restore and that date stays in the copy it kept of its own data, and isn't in the restored data.
- **A clock put back.** If a computer's clock is put back while a task runs, another computer can show extra live time on that task, up to the size of the step, until that clock passes the time it was at before the step. Figures and budget alerts there read the extra time. Open time isn't billed, and it corrects itself. A pause asked for from another computer just before the step is aimed at the old stretch, which the step has closed, so the timer goes on and the pause may need asking again.

**Built for one PC at a time.** Use the app on one PC at a time. Sync carries your work from one PC to the next, but it doesn't make two PCs safe to edit side by side. If you switch PCs before sync has finished, for example because PC A goes offline before its folder has uploaded, and you edit the same field on both, the later save wins and the other text disappears from both PCs with no notice. Neither PC can warn you, because neither has seen the other's text when it saves. So let sync finish before you switch. The app can only say it wrote to the sync folder, so check that OneDrive or Google Drive has finished uploading. Two PCs that each bill their own part of one task-day before their files cross each round it alone, so those summaries can hold more than the report shows, with no warning. They stay as issued, and later rows on that day bill only what the day's rounded time has grown past them.

**Not verified on real Windows.** What has run on Windows is the CI test gates and the GitHub build, on `windows-latest`. A green gates run covers the type check, lint, unit tests, and the Rust format, lint and tests, which run on Windows itself. It also covers the Playwright tests, which run against the IPC mock and so don't drive the real backend. It says nothing about the installer or the app on a real desktop. The build made the installer, signed it with the self-signed certificate and checked the signatures with `signtool` on the runner. The app itself has never run on a real desktop. That includes the installer, uninstaller and hooks, tray, WebView2 check, `--quit` during install, autostart, sync folder detection, Windows file-lock handling, a PC trusting the certificate and accepting the signatures, Segoe UI rendering and shutdown handling. **Nothing added in 1.3.1 has run on Windows either:** the WebView2 message and its download button, the installer's new warning, the Store build as a whole, its package detection, private data folder, startup task and toasts, one computer at a time, two folders and versions on real OneDrive and Google Drive folders, and moving from the installer build to the Store build. They were checked from macOS by compiling for Windows and by tests of the logic behind them, with fake cloud folders that delay and hold files. **Nothing added in 1.3.2 has run on Windows either:** the SQLite database and its WAL file on NTFS, in the installer build's folder and in the Store build's private one, a kill right after a change, the first start after 1.3.1, and the clock warning. The [checklist](#manual-windows-test-checklist) has rows for them, under **Both builds, 1.3.2 store**. **Nothing added in 1.4.0 has run on Windows either:** the tags button and its list on a subtask row, and the Timeline's days side by side with their arrows. The tags are covered by tests against the IPC mock and by Rust tests of their rules, and the days by tests against the IPC mock; neither has had a run on a real desktop. Where the Store build's data really lives, and whether on the same PC it opens the installer build's data, are unknown until it is installed. See the [checklist](#manual-windows-test-checklist).

**Verified only on macOS or against a mock.**

- Every phase 2 screen is tested against the mock, which reimplements the backend's rules in TypeScript and can drift from them. The native smoke script runs time away, manual entries, corrections, billing, the PDF, tag colours and backup restore against the real backend by calling its commands, without clicking those screens. The real file dialogs and clipboard weren't exercised.
- Warm copy, cold form and cold Resume UI are tested against the mock, and inline editing mostly is, with the mock and the Rust core held to one table for `patch_task`. The native smoke script checks the backend rules and the tray route against the real backend, and types into the real inline editor to meet a conflict, with Done, Discard and the banner.
- Real backend, webview and exit paths were tested on macOS with the native smoke script, which doesn't click the real tray icon. Tray icon appearance is unverified.
- The real OneDrive and Google Drive clients have not been exercised. Detection is tested with an injected environment.
- Most UI flows are tested with Playwright against the IPC mock.
- The 1.4.0 MSIX packages carry taskbar and Start images without a plate, but get no `resources.pri` until `pnpm msix:vm` makes one, and Windows uses those images only through one, so without it the taskbar and Start still show the logo on a plate. The index and a Windows App Certification Kit run come from `pnpm msix:vm`, which hasn't been run on a real VM yet; 1.4.0 isn't submitted to the Store. The window, opaque since Mica was removed in 1.3.3, hasn't been seen on Windows either.

**Not done.**

- OS shutdown relies on the app's exit event, which is unverified on Windows; if it doesn't fire, heartbeat recovery closes the segment within about 30 seconds of the real time.
- Google Drive detection reads DriveFS's registry settings first, then scans drive letters and common folder names. The registry key names come from public descriptions and haven't been checked against a real install; if they're wrong, the scan and the picker still work.
- macOS gets no lock signal. Windows is the target, and this wasn't small enough to be worth the risk.
- The lock signal (`WTSQuerySessionInformationW`) has not been seen answering on a real locked Windows session; its logic is tested with injected events. On macOS there is no lock signal, so locks are noticed only through idle time.
- Idle reading (`user-idle`) has not run on Windows. After a wake it could report idle time spanning the sleep; the code clamps that, tested with injected values only.
- The reminder and budget notifications come from the system's notification service, not run on Windows.
- A restore with sync on merges newer records back, and the app warns about that.
- A task can't be deleted from the keyboard alone, by design: its two dialogs ignore Enter, and Space or a screen reader's usual activation of a button on **Continue** and **Delete task**, so that no held or stray key can delete one. Keyboard users have no way to delete a started task, and a screen reader user has one only if their reader sends a real mouse click, which hasn't been tried. A run of quick clicks around the moment a button becomes ready is ignored too: pause a moment and click again.
- The PDF prints Japanese, Chinese, Korean, Hebrew, Arabic and emoji as empty boxes, and warns when it does. A font covering CJK would add about 10.8 MB to the installer, against about 0.4 MB for Noto Sans. Right-to-left text isn't laid out as such: its boxes sit on a left-to-right line, and when several such words are copied from the PDF, their order depends on the PDF reader.
- A correction made on another device before a summary syncs lands on billed time; the summary keeps its frozen numbers.
- **Done** saves held words over the newer text, which you can't read first. The notice says so and gives the way to see both.
- A press of **Done** counts as a choice from one second after the notice first names a field, whether or not you have read it by then. A press that begins in that first second chooses nothing for that field, even if it ends later, and the notice stays. The second click of a double click whose first click began in that second chooses nothing either, though it comes after it; a third click, or a click on its own after the second, counts. Opening the editor again starts the second again. A hold that only the press itself brings on is not sent.
- Description edits on an existing task are stashed in a small local file about 300 ms after each change. At the next launch they're put back, once, with a notice, if the description they were typed over is still stored. If it changed elsewhere meanwhile, or a sync brings over them an edit stamped elsewhere before that launch or up to an hour after it, the newer text stays and a notice shows your words instead, as plain text. The hour is there because clocks differ and the words take time to reach the other PC, and an edit in that hour that did go on from them gets the notice too, which only needs dismissing. After it they're stored text like any other, so an edit made elsewhere goes on from them, or falls under the one-PC limit above. They're kept in a file of their own, `z-work-kept-words.json`, so the notice comes back at each launch whatever you type in that task meanwhile, and only dismissing it ends them. If that file can't be read or written, another notice says so: words kept in that run may not come back at the next launch, so copy any you want before closing the app. If the file of stashed edits can't be read at a launch, a notice says so, the words stay in it for the next launch, and nothing typed in that run is stashed. If a stash fails while words are held back, the notice on them says they come back only if the disk takes them, and to copy what you want to keep. The new-task form isn't covered, and nothing typed in the last 300 ms is.
- A name, project or tags held back because they changed elsewhere live only in memory, so a restart loses them. The notice says so while they're held.
- A save that keeps failing after its editor is closed is tried five times over about a minute, then again after the next change that does save, and when the window hides, the app quits or the editor reopens. A banner says so until it lands. Until then it lives in memory, apart from words in the description, which are stashed as above if the disk takes them. A save the backend refuses for what it holds, such as a name that is too long, isn't retried by itself. It goes again when you change it or leave its field, when you press **Done** or the editor reopens, and when the window hides or the app quits: the banner gives the reason.
- The words of an unsaved edit to a task deleted elsewhere, a new name or a description, go in the same kind of notice, as plain text. A project or tags picked on it are dropped along with the task.
- Map zone boundaries are approximate near borders, and the highlight is clipped to country outlines. The list is the exact choice.
- Time zone rules run from 2000 to 2045; earlier times use the first known offset.
- Rate is fixed to the task's current project: moving a task to another project re-derives its earnings from that project's rates.

## Roadmap

The approved phase 2 list is built, and is described in the [User guide](#user-guide). The performance pass is done; see [Performance](#performance). The gap-fill round is done apart from these: CJK, right-to-left and emoji in the PDF (see above), and the macOS lock signal.

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
- **Contact:** pmrj@rustcircle.com

## Licence

[MIT](LICENSE).
