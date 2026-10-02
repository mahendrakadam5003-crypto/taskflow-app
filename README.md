# TaskFlow — self-hosted tasks + attendance

TaskFlow runs on your PC. Depending on configuration, it can also use Turso for the database and Telegram for uploaded files and attendance location messages. Review [employee privacy and consent](EMPLOYEE_DATA_CONSENT.md) before enabling attendance or cloud storage.

## What's in it
- **Projects & tasks** — same layout as before: sidebar of projects, task list, detail panel with assignee/due date/description/subtasks/comments. Optional PIN lock per project.
- **Attendance** — employees punch in/punch out from their phone or PC. GPS coordinates are recorded as an indicative reference only; they can be spoofed and do not prove physical presence. Admins get a live "who's on the clock right now" view, full history, and CSV export.
- **Real logins** — every person gets their own username + password (not just a name field). Roles: `admin` (sees attendance for everyone, manages people) and `employee` (sees their own).

## 1. Install Node.js (one-time)
Download and install Node.js **20.18.0 or newer** from https://nodejs.org. The deployed service is pinned to Node 20.18.0; newer compatible releases are supported.

## 2. Install and run
Unzip this folder anywhere on your PC (e.g. `C:\TaskFlow`), then open a terminal/command prompt in that folder and run:

```
npm install
npm start
```

The local server listens on `127.0.0.1:3000`. Open `http://127.0.0.1:3000` on the PC itself. Local installs do not accept connections from other LAN devices.

On an empty database, the app creates the first admin account with username `admin` and a random one-time password printed to the server console. Set `INITIAL_ADMIN_PASSWORD` before first startup to provide your own initial password instead. The admin must change that password at first login. Existing databases are not reseeded.

Existing admin accounts still using the old `admin123` password are required to change it at next login. Admin password resets also require the recipient to change the password before continuing.

If you deployed using credentials previously present in this repository's `.env.example`, rotate those credentials at their providers before relying on the deployment.

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
