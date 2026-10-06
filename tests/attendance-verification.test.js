const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const dbPath = require.resolve('../db');
const authPath = require.resolve('../routes/auth');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const axiosPath = require.resolve('axios');
const originals = new Map([dbPath, authPath, auditPath, storagePath, axiosPath].map(modulePath => [modulePath, require.cache[modulePath]]));

const userId = 7;
const deviceId = 'a'.repeat(48);
const passwordHash = bcrypt.hashSync('AttendancePassword123', 4);
const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex');
const writes = [];
const auditEntries = [];
let timelineQuery = '';
let liveShiftQuery = '';
let taskCheckinsQuery = '';
let officeSettingsReadCount = 0;
let attendanceRecordForPunchOut = null;

const mockDb = {
  ready: Promise.resolve(),
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM attendance_verification_access')) return { user_id: userId };
        if (sql.includes('SELECT password_hash FROM users')) return { password_hash: passwordHash };
        if (sql.includes('SELECT device_token_hash, device_name FROM attendance_registered_devices')) {
          return { device_token_hash: deviceHash, device_name: 'Test device' };
        }
        if (sql.includes('SELECT allow_phone, allow_laptop FROM attendance_device_access')) return { allow_phone: 1, allow_laptop: 1 };
        if (sql.includes('SELECT * FROM attendance WHERE user_id = ? AND date = ?')) return attendanceRecordForPunchOut;
        if (sql.includes('SELECT latitude, longitude FROM attendance_locations')) return null;
        return null;
      },
      all: async () => {
        if (sql.includes('FROM settings') && sql.includes('office_radius_m')) {
          officeSettingsReadCount += 1;
          return [
            { key: 'office_lat', value: '18.52' },
            { key: 'office_lng', value: '73.85' },
            { key: 'office_radius_m', value: '100' }
          ];
        }
        if (sql.includes('FROM attendance_locations al JOIN users u')) {
          timelineQuery = sql;
          return [
            { recorded_at: '2026-10-05T04:00:00.000Z', latitude: 18.52, longitude: 73.85, distance_meters: 0, place_changed: 0, activity_type: 'in_vehicle', activity_confidence: 93, user_name: 'Employee' },
            { recorded_at: '2026-10-05T04:05:00.000Z', latitude: 18.53, longitude: 73.86, distance_meters: 71.5, place_changed: 1, activity_type: 'walking', activity_confidence: 81, user_name: 'Employee' }
          ];
        }
        if (sql.includes('FROM attendance a JOIN users u')) {
          liveShiftQuery = sql;
          return [
            { id: 1, user_id: 7, date: '2026-10-04', punch_in: '2026-10-04T03:00:00.000Z', punch_out: null, in_lat: null, in_lng: null, user_name: 'Employee' },
            { id: 2, user_id: 8, date: '2026-10-05', punch_in: '2026-10-05T03:00:00.000Z', punch_out: null, in_lat: null, in_lng: null, user_name: 'Today Employee' }
          ];
        }
        if (sql.includes('FROM task_checkins c')) {
          taskCheckinsQuery = sql;
          return [
            { check_in_at: '2026-10-04T19:00:00.000Z', check_in_lat: 18.52, check_in_lng: 73.85, check_out_at: '2026-10-05T18:45:00.000Z', check_out_lat: 18.53, check_out_lng: 73.86, task_title: 'IST boundary task', customer_name: '', project_name: 'Project' }
          ];
        }
        return [];
      },
      run: async (...args) => {
        writes.push({ sql, args });
        if (sql.includes('INSERT OR IGNORE INTO attendance')) return { changes: 1, lastInsertRowid: 35 };
        if (sql.includes('INSERT INTO attendance_locations')) return { changes: 1, lastInsertRowid: 51 };
        return { changes: 1, lastInsertRowid: 1 };
      }
    };
  }
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireAuth(req, res, next) { return req.session?.userId ? next() : res.status(401).end(); },
    requireAdmin(req, res, next) { return req.session?.role === 'admin' ? next() : res.status(403).end(); }
  }
};
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    async logActivity(...args) { auditEntries.push(args); return auditEntries.length; },
    async notifyAdmins() {}
  }
};
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: { sendLocationToTelegram: async () => 72 }
};
require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: { get: async () => ({ data: { address: { road: 'Main Street', city: 'Pune' } } }) }
};

const attendanceRouter = require('../routes/attendance');
const app = express();
app.use(express.json());
app.use(session({ name: 'attendance-verification.sid', secret: 'attendance-verification-session-secret-32', resave: false, saveUninitialized: false }));
app.post('/test-session', (req, res) => {
  req.session.userId = userId;
  req.session.role = 'employee';
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.post('/test-admin-session', (req, res) => {
  req.session.userId = 99;
  req.session.role = 'admin';
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api/attendance', attendanceRouter);
app.use((error, req, res, next) => res.status(500).json({ error: 'Internal server error.' }));

let server;
let baseUrl;
let cookie;
let adminCookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const adminResponse = await fetch(`${baseUrl}/test-admin-session`, { method: 'POST' });
  adminCookie = adminResponse.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/attendance')];
});

test('required attendance verification blocks unverified punches and accepts native phone verification', async () => {
  writes.length = 0;
  const request = verificationPassword => fetch(`${baseUrl}/api/attendance/punch-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ device_id: deviceId, lat: 18.52, lng: 73.85, verification_password: verificationPassword })
  });

  const missingPassword = await request(undefined);
  assert.equal(missingPassword.status, 403);
  assert.deepEqual(await missingPassword.json(), { error: 'Re-enter your TaskFlow password to verify this attendance punch.' });
  assert.equal(writes.length, 0);

  const wrongPassword = await request('incorrect-password');
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await wrongPassword.json(), { error: 'Attendance password verification failed.' });
  assert.equal(writes.length, 0);

  const desktopClaim = await fetch(`${baseUrl}/api/attendance/punch-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'
    },
    body: JSON.stringify({
      device_id: deviceId,
      lat: 19.076,
      lng: 72.8777,
      verification_method: 'native-device-credential'
    })
  });
  assert.equal(desktopClaim.status, 403);
  assert.deepEqual(await desktopClaim.json(), { error: 'Re-enter your TaskFlow password to verify this attendance punch.' });
  assert.equal(writes.length, 0);

  const verified = await fetch(`${baseUrl}/api/attendance/punch-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'
    },
    body: JSON.stringify({
      device_id: deviceId,
      lat: 19.076,
      lng: 72.8777,
      verification_method: 'native-device-credential',
      activity_type: 'in_vehicle',
      activity_confidence: 93
    })
  });
  assert.equal(verified.status, 200);
  assert.ok(writes.some(write => write.sql.includes('INSERT OR IGNORE INTO attendance')));
  const recordedActivity = writes.find(write => write.sql.includes('INSERT INTO attendance_locations'));
  assert.deepEqual(recordedActivity.args.slice(7, 9), ['in_vehicle', 93]);
  assert.equal(officeSettingsReadCount, 0, 'office radius must not block an off-site punch');
});

test('employees can punch out away from the configured office', async () => {
  writes.length = 0;
  attendanceRecordForPunchOut = {
    id: 35,
    punch_in: '2026-10-06T03:00:00.000Z',
    punch_out: null,
    location_status: '📍 In: Office'
  };
  try {
    const response = await fetch(`${baseUrl}/api/attendance/punch-out`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'
      },
      body: JSON.stringify({
        device_id: deviceId,
        lat: 19.076,
        lng: 72.8777,
        verification_method: 'native-device-credential'
      })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.match(result.status, /Out: Main Street, Pune/);
    assert.equal(officeSettingsReadCount, 0, 'office radius must not block an off-site punch-out');
    const punchOutUpdate = writes.find(write => write.sql.includes('UPDATE attendance SET punch_out'));
    assert.deepEqual(punchOutUpdate.args.slice(1, 3), [19.076, 72.8777]);
  } finally {
    attendanceRecordForPunchOut = null;
  }
});

test('admin live timeline returns stored distance and place-change totals', async () => {
  const response = await fetch(`${baseUrl}/api/attendance/live/7/timeline?date=2026-10-05`, {
    headers: { Cookie: adminCookie }
  });

  assert.equal(response.status, 200);
  assert.match(timelineQuery, /al\.distance_meters,\s*al\.place_changed/);
  assert.match(timelineQuery, /al\.activity_type,\s*al\.activity_confidence/);
  assert.deepEqual(await response.json(), {
    points: [
      { recorded_at: '2026-10-05T04:00:00.000Z', latitude: 18.52, longitude: 73.85, distance_meters: 0, place_changed: 0, activity_type: 'in_vehicle', activity_confidence: 93, user_name: 'Employee' },
      { recorded_at: '2026-10-05T04:05:00.000Z', latitude: 18.53, longitude: 73.86, distance_meters: 71.5, place_changed: 1, activity_type: 'walking', activity_confidence: 81, user_name: 'Employee' }
    ],
    total_distance_meters: 71.5,
    place_changes: 1
  });
});

test('admin live list includes open shifts from earlier dates', async () => {
  const response = await fetch(`${baseUrl}/api/attendance/live`, {
    headers: { Cookie: adminCookie }
  });

  assert.equal(response.status, 200);
  assert.match(liveShiftQuery, /a\.date\s*<=\s*\?/);
  assert.doesNotMatch(liveShiftQuery, /a\.date\s*=\s*\?/);
  const rows = await response.json();
  assert.deepEqual(rows.map(row => row.date), ['2026-10-04', '2026-10-05']);
});

test('employee location timeline views are audited with viewer, target, and date', async () => {
  auditEntries.length = 0;
  const response = await fetch(`${baseUrl}/api/attendance/live/7/timeline?date=2026-10-05`, {
    headers: { Cookie: adminCookie }
  });

  assert.equal(response.status, 200);
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0][0].session.userId, 99);
  assert.equal(auditEntries[0][1], 'Viewed employee location timeline');
  assert.equal(auditEntries[0][3], 7);
  assert.equal(auditEntries[0][4], 'Attendance date: 2026-10-05');
  assert.equal(auditEntries[0][5], 7);
});

test('employee timeline filters task events by India date across UTC midnight', async () => {
  const response = await fetch(`${baseUrl}/api/attendance/tracking/7/timeline?date=2026-10-05`, {
    headers: { Cookie: adminCookie }
  });

  assert.equal(response.status, 200);
  assert.match(taskCheckinsQuery, /substr\(c\.check_in_at, 1, 10\) BETWEEN \? AND \?/);
  const result = await response.json();
  assert.deepEqual(result.events.map(event => event.action), ['Checked in to task']);
  assert.equal(result.events[0].recorded_at, '2026-10-04T19:00:00.000Z');
});