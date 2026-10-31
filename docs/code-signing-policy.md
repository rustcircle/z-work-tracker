# Code signing policy

**Status: no release of zWorkTracker has been signed.** This policy applies once a signing service has accepted the project. Current builds are unsigned.

If SignPath Foundation accepts the project: free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). **The publisher shown by Windows will then be "SignPath Foundation", not the project's author.**

## Team roles

| Role | Who | Responsibility |
|---|---|---|
| Authors | Pedro Jorge | Commit to the repository |
| Reviewers | Pedro Jorge | Review external contributions before they merge |
| Approvers | Pedro Jorge | Approve each signing request |

The project lives in the GitHub organization `rustcircle` and has one maintainer, who holds all three roles. SignPath has not confirmed that one person may hold them all.

Contact: p@rustcircle.com

## Rules

- **Every signing request needs manual approval by an Approver.** Every release is approved by hand.
- Only builds made by the repository's GitHub Actions workflow on GitHub-hosted runners are submitted. Nothing built on a developer's machine is signed.
- Multi-factor authentication is required for every team member, on both GitHub and SignPath.
- Only the project's own binaries are signed: the application and its installer. Upstream components keep their own signatures.
- Pull requests from people outside the team are reviewed by a Reviewer before they merge.

## Privacy

zWorkTracker makes no network calls. It contains no telemetry and no HTTP library, and a test enforces this. Your data stays on your computer unless you choose a local OneDrive or Google Drive folder to sync through. In that case the desktop client you installed, not this app, uploads the files.

## Licensing

The source is MIT licensed. Third-party components are listed in `THIRD_PARTY_NOTICES.md`.
