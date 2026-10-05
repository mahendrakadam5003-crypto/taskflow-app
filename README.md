# TaskFlow — self-hosted tasks + attendance

TaskFlow runs on your PC. Depending on configuration, it can also use Turso for the database and Telegram for uploaded files and attendance location messages. Review [employee privacy and consent](EMPLOYEE_DATA_CONSENT.md) before enabling attendance or cloud storage.

## What's in it
- **Projects & tasks** — same layout as before: sidebar of projects, task list, detail panel with assignee/due date/description/subtasks/comments. Optional PIN lock per project.
- **Attendance** — employees punch in/punch out from their phone or PC. GPS coordinates are recorded as an indicative reference only; they can be spoofed and do not prove physical presence. Admins get a live "who's on the clock right now" view, full history, and CSV export.
- **Real logins** — every person gets their own username + password (not just a name field). Roles: `admin` (sees attendance for everyone, manages people) and `employee` (sees their own).

## Interface and accessibility
The responsive interface includes a live attendance clock and shift timer, mobile-friendly attendance history, keyboard-accessible administrator tabs and dialogs, and a mobile bottom navigation bar. Inter Variable is bundled locally for consistent, offline-capable typography; its SIL Open Font License is included at `public/fonts/OFL.txt`.

## 1. Install Node.js (one-time)
Download and install Node.js **20.18.0 or newer** from https://nodejs.org. The deployed service is pinned to Node 20.18.0; newer compatible releases are supported.

## 2. Install and run
Unzip this folder anywhere on your PC (e.g. `C:\TaskFlow`), then open a terminal/command prompt in that folder and run:

```
npm install
```

For an isolated local SQLite database, explicitly enable local mode before starting:

```powershell
$env:USE_LOCAL_DB = '1'
npm start
```

Without `USE_LOCAL_DB=1`, TaskFlow requires both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` and stops if either is missing or the database is unreachable.

### Multi-company control panel and database
The control tables (company registry, plans, super-admin accounts and sessions, usage snapshots, backup records, billing notes, and audit entries) use the same database as `TURSO_DATABASE_URL` by default, authenticated by `TURSO_AUTH_TOKEN`. On startup, TaskFlow registers the current workspace as **Existing Company** (code `existing-company` by default) in the super-admin overview. This only adds registry metadata and an encrypted copy of the existing Turso token to that same database; it does not copy, move, rename, or change any company users or other existing records. To keep using the same database, leave `CONTROL_DATABASE_URL` and `CONTROL_AUTH_TOKEN` unset. You can customize the display label with `LEGACY_COMPANY_NAME` and code with `LEGACY_COMPANY_CODE` before the first link.

For super-admin sign-in, set `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD` as private environment variables on the deployed service. The Render blueprint defaults the username to `super admin`; set a unique, randomly generated password of at least 16 characters (72 UTF-8 bytes maximum) in Render's secret environment settings. On startup, TaskFlow creates the account if none exists, or updates the password only for an existing account with the matching username. It refuses to replace an account with a different username. `SUPERADMIN_NAME` is optional and defaults to the username. Usernames are case-insensitive. After startup reports that the account was created, updated, or is ready, remove `SUPERADMIN_PASSWORD` from the service environment and redeploy. If the password is left configured, each startup will continue to synchronize that account's password from the secret.

Alternatively, run `npm run migrate:control` and then `npm run superadmin:create` from a trusted terminal with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and the bootstrap variables set.

The bootstrap refuses to add or replace accounts if one already exists and never prints the password. Sign in at `/superadmin`; this login is separate from the company admin login. The overview lists companies registered in the control tables. Super-admins can change a company's status or plan assignment; these changes are audited and update registry metadata only, leaving its database URL, credentials, and records untouched. A suspended company's admin retains read-only access with a support notice; employees are blocked, and cancelled/deleted companies are blocked. Assigned plan limits are enforced in the company workspace: active-user seats are checked when users are added or reactivated; storage quotas combine tenant database size and tracked Telegram attachment sizes and are enforced before uploads; attendance, reimbursements, and data exports respect their plan feature flags. Existing standalone installs without a control database retain the unlimited, all-features-enabled behavior.

Create `APP_ENCRYPTION_KEY` yourself as a private 32-byte key encoded as 64 hexadecimal characters; generate one locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set it as a Render secret, and keep a backup in a password manager or other secure storage that you control outside Render. It is not company data, but registered database tokens cannot be decrypted without this key. Preserve the same key when moving to another host; do not commit it, send it in chat, or rotate it casually.

The existing-company registry link runs automatically after app startup. It assigns the existing workspace the `Internal / Unlimited` plan without changing its database or records; on repeat runs it repairs that plan assignment without overriding a manually selected company status. To invoke it manually, run `npm run company:register-existing` with the same Turso credentials and encryption key. It is safe to repeat and refuses to reuse a company code that points to a different database.

The company sign-in accepts an optional company code. Leave it blank to continue using the existing workspace and credentials as before; when the existing workspace is registered, sign-in resolves to that same database through its company route. Or enter `existing-company` to select it explicitly. The code is used at login only; authenticated requests resolve the company from the server-side session. When control-database configuration is available, company sessions are stored there with their company ID; local-only mode uses the local session file store. Login attempts are rate-limited per IP, username, and company code. Suspended company admins can sign in to a read-only workspace view and see a support notice; other company members are denied access, and cancelled/deleted workspaces are blocked. New companies use their own registered database and code. In local multi-tenant tests, registered tenants use separate `tenants/<company-code>.db` files. Run `npm run migrate:all` to lazily initialize the legacy database and every registered trial, active, or suspended tenant database.

Control database migrations v9-v13 are repeatable. They create pricing, subscription, invoice, payment-event, demo-request, notification-outbox, and subscription-change-request tables and seed editable defaults (INR, 18% tax, seven-day trial, three users, 1 GB, manual trial approval, three-day payment grace, seven read-only days). Migration v13 enforces the selected manual-only trial approval policy. Existing plan and company rows are retained. Tenant schema v4 adds nullable email and Google identity fields; existing users keep their IDs, credentials, and sessions. Run `npm run migrate:all` to apply tenant schema changes across registered databases; the app also applies them when opening each tenant.

Entitlements are checked server-side on every authenticated API request. New provisioned companies receive a seven-day trial and a notice that access may be limited after expiry. Automatic tenant deletion is disabled: expired trials and cancelled companies are not purged by scheduled maintenance, and existing company data is retained. Payment and trial reminder emails use the mailer interface; until an SMTP provider is configured, messages are console previews only.

Company admins can submit seat-count or billing-cycle requests from **Billing & Plan**. Super-admins review requests and can issue an open invoice or reject the request. Existing subscriptions retain their original versioned prices; a requested change takes effect only after its manual invoice is marked paid. No payment is collected automatically. Paid invoices include a downloadable HTML receipt; invoices are scoped to the authenticated company.

Public demo requests are consent-gated, validated, IP-rate-limited (five per hour), and checked with a honeypot field. They remain pending until a super-admin approves them; approval only pre-fills trial setup and does not create a workspace automatically. A super-admin must review the details and provision the trial. Trial durations and the selected limits (three active users and 1,024 MB by default) come from pricing settings, and scheduled maintenance sends reminders without purging tenant data.

To provision companies from **Super Admin → Add a company**, configure `TURSO_PLATFORM_TOKEN` and `TURSO_ORG` as private service secrets; `TURSO_GROUP` is optional and defaults to `default`. The platform token needs permission to create databases, issue database tokens, and delete a newly created database if setup fails. The company code is also used in the Turso database name (`tf-<code>`), so it is limited to 61 lowercase letters, numbers, and hyphens. Each new company starts with a separate database and a trial ending after the configured trial duration (seven days by default). The first administrator receives a randomly generated one-time password, must change it at first sign-in, and sees it only in the creation response; save and deliver it securely before dismissing the details. Provisioning secrets are unnecessary for `USE_LOCAL_DB=1`, which creates a separate local `tenants/<company-code>.db` file.

The super-admin overview records a usage snapshot for each trial, active, or suspended company at startup and once per day. Snapshots count active users, estimate database size from its SQLite page count, and total locally stored attachment files referenced by that company's records together with the tracked sizes of newly uploaded Telegram attachments. Snapshots older than one year are removed.

At `/superadmin`, operators can search and filter companies, inspect usage history, maintain plans and company-specific limit overrides, add billing notes, and mark notes as paid. Seat/storage limits are checked against live tenant usage before they can be lowered, and override audit entries include the old and new values. Operators can also review billing-change requests, issue manual invoices, and record payments. Support mode opens the selected company admin session for 30 minutes and is recorded in the super-admin audit log. **Backup now** writes a JSON snapshot of the tenant database under the application root's `backups/` directory; it includes sensitive company records and must be protected and included in the host's persistent backup plan. It does not copy local upload files or Telegram-hosted attachments, so back those up separately.

To enable daily private Telegram backups, set `AUTO_DAILY_BACKUPS=true`, `TELEGRAM_BACKUP_CHANNEL_ID` to a separate private channel where the bot is an administrator, and `TELEGRAM_BACKUP_ALERT_CHAT_ID` to your private Telegram chat ID. The attachment channel in `TELEGRAM_CHANNEL_ID` is not used for backup archives. Archives larger than the configured part size are split and reconstructed in order. The service keeps the newest seven daily archive sets per active company, runs one temporary-database restore/count check per active company each month, and sends backup failures to the alert chat. Daily backups are off by default.

Cancelling a company blocks sign-in immediately and schedules retirement 30 days later. At retirement, TaskFlow creates a final backup, removes referenced Telegram file/location messages and local uploads, deletes the tenant database, then anonymizes the registry row while retaining its audit history. If the final backup or cleanup fails, the company remains pending and the alert chat is notified. Restoring a backup always creates a separate database; review its verified table/row counts in the super-admin panel before explicitly switching the company to it. The previous database is retained for rollback. Staged restores can be discarded before activation.

Unexpected server errors appear in the super-admin **User error inbox** when the control database is configured. Reports include a request ID, company, route, method, status, and safe event label only; they never store exception text, request bodies, passwords, tokens, or GPS coordinates. Expected client errors such as validation failures and permission denials are not reported as incidents.

The responsive public landing page is served at `http://127.0.0.1:3000`; open `/app` on that same host to sign in to the workspace. The local server listens on `127.0.0.1:3000`, so local installs do not accept connections from other LAN devices. Public pricing is loaded from the current control-database settings. Demo requests are rate-limited, stored for manual super-admin review, and do not create an account or trial automatically. See the [demo request privacy notice](public/privacy.html).

On an empty database, set `INITIAL_ADMIN_PASSWORD` as a private environment variable before first startup. It must contain 10 to 72 UTF-8 bytes; the password is never printed to logs, and the admin must change it at first login. Existing databases are not reseeded.

Existing admin accounts still using the old `admin123` password are required to change it at next login. Admin password resets also require the recipient to change the password before continuing.

Older public Git history contains values for `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `TURSO_AUTH_TOKEN`, and `TURSO_PLATFORM_TOKEN`. Rotate each at its provider and update the deployment environment; changing the current `.env.example` does not remove values from Git history.

Run `npm test` before every deployment. The Render build runs this suite automatically; it includes two-company guessed-ID read/update/delete checks and guards API routes against bypassing the tenant-bound database client.

## 3. Access from phones or remotely
Do not open TaskFlow over LAN HTTP or forward port 3000 on your router. Passwords and other private data would cross the network without transport encryption.

Use Tailscale to provide private HTTPS access:
1. Install Tailscale on the TaskFlow PC and each staff device, and connect them to the same tailnet.
2. Start TaskFlow with Tailscale mode enabled:
  ```powershell
  $env:TAILSCALE_SERVE = 'true'
  npm start
  ```
3. Configure Tailscale Serve to proxy HTTPS traffic to `http://127.0.0.1:3000`, following the current Tailscale documentation.
4. Open the machine's Tailscale HTTPS address on each phone or PC. You can then add it to the phone's Home Screen.

Tailscale mode keeps TaskFlow bound to loopback, trusts the local HTTPS proxy, and enables Secure session cookies. Do not expose the Node server directly to the LAN or public internet.

## 5. Set your office location (GPS reference)
Log in as admin → **Admin** tab → "Office location" to save the office coordinates and radius. The saved coordinates are only a reference; the client-reported GPS can be spoofed. Do not treat it as proof of presence or use it alone for disciplinary or payroll decisions.

## 6. Add your team
Admin → Team members → fill in name, username, password, role → **Add person**. Give each person their own login and phone/PC to use it from.

## Data retention and privacy
In Admin → **Data retention**, attachment retention defaults to `0` (no automatic deletion). Ask your accountant before setting a finite period. If enabled, comment files are aged from comment creation and reimbursement receipts from the expense date; after successful file deletion, the matching database paths and metadata are cleared.

GPS points and exact attendance/task coordinates, location names, and device detail fields are cleared after 60 days by default. Attendance punch/check-in timestamps remain. Old Telegram location messages are deleted on a best-effort basis; failed deletions are retried, with local coordinates erased and only a coordinate-free marker retained. Device names are anonymized and model/browser details cleared after 60 days; the device-binding hash remains while the device is registered. Activity logs, task history, and comment text have no automatic expiry.

TaskFlow requests browser model/platform client hints. It stores a derived device type/model/browser label, not a raw full User-Agent string. Attendance coordinates are sent to Telegram as location messages and to OpenStreetMap Nominatim for reverse geocoding. Uploaded receipts and comment images may be stored in Telegram; configured database records are stored in Turso. Provider processing/storage regions depend on your account and configuration; confirm them before collecting consent. Review retention, transfers, notices, consent and other DPDP Act obligations with your Indian legal adviser and accountant. The included form is a template, not legal advice.

## Session secret
The app exits at startup unless `SESSION_SECRET` is set to a random value at least 32 characters long. On Windows PowerShell, generate and persist a 48-byte value for your user account:
```powershell
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Environment]::SetEnvironmentVariable('SESSION_SECRET', [Convert]::ToBase64String($bytes), 'User')
$rng.Dispose()
```
Restart VS Code or open a new PowerShell window after setting it. Never commit the value. Sessions expire after 14 days and do not extend while in use. The cookie is `HttpOnly`; Render uses `Secure` over HTTPS, while local HTTP development keeps it disabled. The deployment uses a new cookie name, so the first release signs out existing users once.

The Render blueprint generates `SESSION_SECRET` for new services. For an existing service, set or rotate it in the Render environment settings before deploying; rotating it signs out all users. Render proxy trust is configured for its single forwarded proxy so secure cookies work behind HTTPS termination.

## Backing up your data
For a local SQLite fallback, stop TaskFlow and back up both `taskflow.db` and the `uploads/` folder. Keep the copies somewhere separate from the computer running TaskFlow.

For a Turso database, install and authenticate the [Turso CLI](https://docs.turso.tech/cli/introduction), then export a SQLite snapshot. Get the database name with `turso db list` or from `TURSO_DATABASE_URL`:
```powershell
turso auth login
New-Item -ItemType Directory -Force .\backups
$backup = ".\backups\taskflow-$(Get-Date -Format yyyyMMdd-HHmmss).db"
turso db export YOUR_DATABASE_NAME --output-file $backup
```
See the [Turso `db export` reference](https://docs.turso.tech/cli/db/export). Turso notes that an exported snapshot may not include the latest writes; follow its SDK sync guidance when a fully current export is required. Back up `uploads/` as well for any locally stored files. Telegram-hosted attachments and location messages are separate from both the Turso database and `uploads/`; include Telegram storage in your recovery plan. Protect backup files as sensitive data and periodically test restoring them.

## Keeping it running after a PC restart
By default you'd need to re-run `npm start` after a reboot. If you want it to start automatically:
- Windows: use **Task Scheduler** with a trigger set to **At startup** (not **At log on**). Set the action to start `C:\Program Files\nodejs\npm.cmd` with arguments `start`, and set **Start in** to the TaskFlow folder. Run it under the same Windows account that has TaskFlow's environment variables configured. `pm2 startup` is not supported on Windows.

Ask me any time if you get stuck on a step, want more fields (e.g. custom columns like your SRS sheet — Contact/Address/Vendor/Price), or want the attendance view to show weekly hour totals.


## Recommended remote attendance setup (Tailscale)
For remote employees, keep GPS-based attendance and expose TaskFlow through an HTTPS Tailscale address. Employees should open that HTTPS address on their phone/laptop while connected to Tailscale, allow browser location permission, and use the normal Punch in / Punch out buttons. The app records client-reported coordinates as an indicative reference only; a mock-location tool can spoof them. Do not create a plain-HTTP public port for attendance because browser GPS requires a secure context.

A typical deployment is: TaskFlow listens only on `127.0.0.1:3000`, Tailscale Serve provides the HTTPS endpoint, and the Tailscale ACL restricts access to staff devices/users. Exact Tailscale Serve commands depend on your current version; use the current Tailscale admin documentation when enabling HTTPS.
