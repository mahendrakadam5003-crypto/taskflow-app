const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const dbPath = require.resolve('../db');
const authPath = require.resolve('../routes/auth');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const originals = new Map([dbPath, authPath, auditPath, storagePath].map(modulePath => [modulePath, require.cache[modulePath]]));
let failAccessQuery = false;
let failAccessList = false;
let writes = 0;

const mockDb = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('SELECT 1 FROM payment_history_access')) {
          if (failAccessQuery) throw new Error('database unavailable');
          return null;
        }
        if (sql.includes('SELECT id, active FROM users')) return null;
        return null;
      },
      all: async () => {
        if (sql.includes('LEFT JOIN payment_history_access')) {
          if (failAccessList) throw new Error('database unavailable');
          return [];
        }
        return [];
      },
      run: async () => {
        writes += 1;
        return { changes: 1 };
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
    requireAuth(req, res, next) {
      if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
      next();
    },
    requireAdmin(req, res, next) {
      return req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
    }
  }
};
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { logActivity: async () => {} } };
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadToTelegram: async () => {}, streamFromTelegram: async () => {} } };
const tasksRouter = require('../routes/tasks');
const app = express();
app.use(express.json());
app.use(session({
  name: 'task-payment-access-test.sid',
  secret: 'task-payment-access-test-session-secret-32-chars',
  resave: false,
  saveUninitialized: false
}));
app.post('/test-session/:role', (req, res) => {
  req.session.userId = req.params.role === 'admin' ? 1 : 2;
  req.session.role = req.params.role;
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api', tasksRouter);
app.use((error, req, res, next) => res.status(500).json({ error: 'Internal server error.' }));

let server;
let baseUrl;
let employeeCookie;
let adminCookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const employee = await fetch(`${baseUrl}/test-session/employee`, { method: 'POST' });
  const admin = await fetch(`${baseUrl}/test-session/admin`, { method: 'POST' });
  employeeCookie = employee.headers.get('set-cookie').split(';', 1)[0];
  adminCookie = admin.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/tasks')];
});

test('granting payment-history access to a missing user returns 404 without a write', async () => {
  writes = 0;
  const response = await fetch(`${baseUrl}/api/payment-history/access/999`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ allowed: true })
  });
  assert.equal(response.status, 404);
  assert.equal(writes, 0);
});

test('payment-history access lookup/list database errors return JSON 500 responses', async () => {
  failAccessQuery = true;
  const employeeResponse = await fetch(`${baseUrl}/api/payment-history/access/me`, { headers: { Cookie: employeeCookie } });
  assert.equal(employeeResponse.status, 500);
  assert.deepEqual(await employeeResponse.json(), { error: 'Internal server error.' });
  failAccessQuery = false;

  failAccessList = true;
  const adminResponse = await fetch(`${baseUrl}/api/payment-history/access`, { headers: { Cookie: adminCookie } });
  assert.equal(adminResponse.status, 500);
  assert.deepEqual(await adminResponse.json(), { error: 'Internal server error.' });
  failAccessList = false;
});
