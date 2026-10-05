# Pre-Launch Test Sheet

Use a staging deployment only. Do not create these fixtures in the live customer database. Use fake names, files, reimbursement records, and attendance data.

## Test Companies

| Company | Plan | Expected active-user limit | Data |
| --- | --- | ---: | --- |
| Solo Test | Solo | 1 | One admin and one test employee identity |
| Small Test | Team | 5 | Set a temporary company override of 5 users; the default Team plan allows 10 |
| Big Test | Business | 20+ | At least 20 fake users plus fake projects, tasks, receipts, and attendance |

Status: **Not run**. The current local clone has no `.env` or staging connection, so no companies have been provisioned.

## Staging Verification

- [ ] Create each company from Super Admin; record time from opening the form to receiving the one-time admin credentials. Target: under 2 minutes.
- [ ] Confirm each company has a distinct tenant database and an independent first admin.
- [ ] Add, suspend, reactivate, cancel, and change plans for test companies; verify sign-in behavior and audit records.
- [ ] Reset an admin password, verify old sessions are invalidated, and use the support-mode login-as-admin action.
- [ ] Add users up to each limit, then one beyond; verify the last request is rejected with a clear message.
- [ ] Set a temporary low storage override in staging; test warning and rejection behavior with files near each threshold, then restore the original plan value.
- [ ] Compare the company plan and usage figures with the tenant's active users, database size, and tracked files.
- [ ] Sign in as each company admin and employee; verify company-code login, tasks, attendance punches, and reimbursement access.
- [ ] Attempt reads, updates, deletes, and attachment downloads using another company's guessed record IDs and file IDs from separate browsers and phones.
- [ ] Create and download a backup, stage a restore, verify row counts, activate and revert it, test download-my-data, and exercise scheduled company deletion with fake data.
- [ ] Confirm the pre-existing company and its old records remain unchanged throughout the drill.
- [ ] Repeat the employee flows in the Capacitor app and mobile browser on both iOS and Android, including slow network, background/resume, device sleep/wake, and session expiry.
- [ ] Record browser/device, company, screen, request ID, expected result, actual result, and severity for every issue.

## Must Fix Before Launch

- [ ] Complete every staging verification above; clear all critical/high-severity bugs and rerun the affected tests.
- [ ] Confirm the Render build gate runs the complete automated suite against the release commit.
- [ ] Rotate historical public credentials at their providers and update deployment secrets: session, Telegram bot, Turso database, and Turso platform tokens.
- [ ] Complete the postponed real-launch work: payment gateway/webhooks and GST invoices; durable file storage; paid hosting, staging, uptime/error monitoring; email; company subdomains; independent encrypted backups and restore drills; super-admin 2FA; legal/privacy/consent/GST review; and customer self-signup.

## Bug List

No manual device or staging findings have been recorded yet; this is **not** a verified empty bug list. Add one row per issue:

| Date/build | Screen | Company | Device/browser | Steps and expected result | Actual result | Request ID | Severity/status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
