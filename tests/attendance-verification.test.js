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
        if (sql.includes('SELECT * FROM attendance WHERE user_id = ? AND date = ?')) return null;
        if (sql.includes('SELECT latitude, longitude FROM attendance_locations')) return null;
        return null;
      },
      all: async () => [],
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
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { logActivity: async () => {} } };
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
app.use('/api/attendance', attendanceRouter);
app.use((error, req, res, next) => res.status(500).json({ error: 'Internal server error.' }));

let server;
let baseUrl;
let cookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = response.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/attendance')];
});

test('required attendance verification blocks direct punches without password and accepts a valid re-check', async () => {
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

  const verified = await request('AttendancePassword123');
  assert.equal(verified.status, 200);
  assert.ok(writes.some(write => write.sql.includes('INSERT OR IGNORE INTO attendance')));
});