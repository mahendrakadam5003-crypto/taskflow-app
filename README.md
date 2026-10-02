# TaskFlow — self-hosted tasks + attendance

Runs entirely on your always-on PC. No cloud, no item limits (only your disk), no monthly cost.
Everything lives in one file: `taskflow.db` (SQLite), sitting right next to the app.

## What's in it
- **Projects & tasks** — same layout as before: sidebar of projects, task list, detail panel with assignee/due date/description/subtasks/comments. Optional PIN lock per project.
- **Attendance** — employees punch in/punch out from their phone or PC. GPS coordinates are recorded as an indicative reference only; they can be spoofed and do not prove physical presence. Admins get a live "who's on the clock right now" view, full history, and CSV export.
- **Real logins** — every person gets their own username + password (not just a name field). Roles: `admin` (sees attendance for everyone, manages people) and `employee` (sees their own).

## 1. Install Node.js (one-time)
Download and install the **LTS** version from https://nodejs.org (Node 22.5 or newer — the app uses Node's built-in SQLite, so there's nothing else to compile or install). Just click through the installer.

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
Everything is in `taskflow.db` in this folder. Copy that one file anywhere (another drive, OneDrive folder, USB stick) to back it up. To restore, just put it back and restart the app.

## Keeping it running after a PC restart
By default you'd need to re-run `npm start` after a reboot. If you want it to start automatically:
- Windows: use **Task Scheduler** to run `npm start` in this folder "At log on", or install the free tool `pm2` (`npm install -g pm2`, then `pm2 start server.js`, `pm2 save`, `pm2 startup`).

Ask me any time if you get stuck on a step, want more fields (e.g. custom columns like your SRS sheet — Contact/Address/Vendor/Price), or want the attendance view to show weekly hour totals.


## Recommended remote attendance setup (Tailscale)
For remote employees, keep GPS-based attendance and expose TaskFlow through an HTTPS Tailscale address. Employees should open that HTTPS address on their phone/laptop while connected to Tailscale, allow browser location permission, and use the normal Punch in / Punch out buttons. The app records client-reported coordinates as an indicative reference only; a mock-location tool can spoof them. Do not create a plain-HTTP public port for attendance because browser GPS requires a secure context.

A typical deployment is: TaskFlow listens only on `127.0.0.1:3000`, Tailscale Serve provides the HTTPS endpoint, and the Tailscale ACL restricts access to staff devices/users. Exact Tailscale Serve commands depend on your current version; use the current Tailscale admin documentation when enabling HTTPS.
