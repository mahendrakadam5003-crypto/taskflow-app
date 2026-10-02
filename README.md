# TaskFlow — self-hosted tasks + attendance

Runs entirely on your always-on PC. No cloud, no item limits (only your disk), no monthly cost.
Everything lives in one file: `taskflow.db` (SQLite), sitting right next to the app.

## What's in it
- **Projects & tasks** — same layout as before: sidebar of projects, task list, detail panel with assignee/due date/description/subtasks/comments. Optional PIN lock per project.
- **Attendance** — employees punch in/punch out from their phone or PC. If you set your office's coordinates in Admin, the app automatically tags each punch **🟢 On-site** or **🟡 Remote** based on GPS distance. Admins get a live "who's on the clock right now" view, full history, and CSV export.
- **Real logins** — every person gets their own username + password (not just a name field). Roles: `admin` (sees attendance for everyone, manages people) and `employee` (sees their own).

## 1. Install Node.js (one-time)
Download and install the **LTS** version from https://nodejs.org (Node 22.5 or newer — the app uses Node's built-in SQLite, so there's nothing else to compile or install). Just click through the installer.

## 2. Install and run
Unzip this folder anywhere on your PC (e.g. `C:\TaskFlow`), then open a terminal/command prompt in that folder and run:

```
npm install
npm start
```

You'll see:
```
TaskFlow running:
  On this PC:      http://localhost:3000
  On your network: http://<this-PC's-LAN-IP>:3000
```

Open `http://localhost:3000` on the PC itself. On an empty database, the app creates the first admin account with username `admin` and a random one-time password printed to the server console. Set `INITIAL_ADMIN_PASSWORD` before first startup to provide your own initial password instead. The admin must change that password at first login. Existing databases are not reseeded.

Existing admin accounts still using the old `admin123` password are required to change it at next login. Admin password resets also require the recipient to change the password before continuing.

If you deployed using credentials previously present in this repository's `.env.example`, rotate those credentials at their providers before relying on the deployment.

## 3. Access from phones (same WiFi)
1. Find this PC's local IP address: on Windows, open Command Prompt and run `ipconfig`, look for "IPv4 Address" (something like `192.168.1.23`).
2. On each phone, connect to the **same WiFi** and open `http://192.168.1.23:3000` in the browser.
3. Tap the browser's menu → **Add to Home Screen** so it behaves like an app icon.

Since the PC needs to stay on 24/7 for this to work (which you said it already is), this just works — no extra setup.

## 4. Access from outside the office (optional)
Phones on mobile data or a different WiFi won't be able to reach `192.168.1.23`. If you need that:
- **Easiest, free: Tailscale** (https://tailscale.com) — install it on the PC and on each phone, sign in with the same account, and each device gets a private address that works from anywhere, fully encrypted, no port forwarding, free for small teams.
- Alternative: forward port 3000 on your router to this PC and use a free dynamic-DNS name — more exposed to the internet, only recommended if you're comfortable with basic router security (and even then, put a stronger `SESSION_SECRET` in place first — see below).

## 5. Set your office location (for on-site detection)
Log in as admin → **Admin** tab → "Office location". Get your coordinates by opening Google Maps, right-clicking your office, and clicking the lat/lng that pops up at the top of the menu. Set a radius in meters (150m is a reasonable default for a single building). Leave it blank if you don't want automatic on-site detection — punches will just show "location not confirmed."

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
Restart VS Code or open a new PowerShell window after setting it. Never commit the value. The Render blueprint generates `SESSION_SECRET` for new services; for an existing service, set or rotate it in the Render environment settings before deploying. Rotating the secret signs out all users.

## Backing up your data
Everything is in `taskflow.db` in this folder. Copy that one file anywhere (another drive, OneDrive folder, USB stick) to back it up. To restore, just put it back and restart the app.

## Keeping it running after a PC restart
By default you'd need to re-run `npm start` after a reboot. If you want it to start automatically:
- Windows: use **Task Scheduler** to run `npm start` in this folder "At log on", or install the free tool `pm2` (`npm install -g pm2`, then `pm2 start server.js`, `pm2 save`, `pm2 startup`).

Ask me any time if you get stuck on a step, want more fields (e.g. custom columns like your SRS sheet — Contact/Address/Vendor/Price), or want the attendance view to show weekly hour totals.


## Recommended remote attendance setup (Tailscale)
For remote employees, keep GPS-based attendance and expose TaskFlow through an HTTPS Tailscale address. Employees should open that HTTPS address on their phone/laptop while connected to Tailscale, allow browser location permission, and use the normal Punch in / Punch out buttons. The server compares the submitted GPS coordinates with the configured office radius: office punches are marked **On-site**, remote coordinates are marked **Remote**. Do not create a plain-HTTP public port for attendance because browser GPS requires a secure context.

A typical deployment is: TaskFlow listens on `127.0.0.1:3000`/`0.0.0.0:3000`, Tailscale provides the HTTPS endpoint, and the Tailscale ACL restricts access to your staff devices/users. Exact Tailscale `serve`/HTTPS commands depend on your current Tailscale version; use the current Tailscale admin documentation when enabling the certificate.
