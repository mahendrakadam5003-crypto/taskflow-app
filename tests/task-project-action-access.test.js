const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const dbPath = require.resolve('../db');
const authPath = require.resolve('../routes/auth');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const axiosPath = require.resolve('axios');
const originals = new Map([dbPath, authPath, auditPath, storagePath, axiosPath].map(modulePath => [modulePath, require.cache[modulePath]]));

const mockDb = {
  prepare() {
    return {
      get: async () => { throw new Error('sensitive database failure detail'); },
      all: async () => { throw new Error('sensitive database failure detail'); },
      run: async () => { throw new Error('sensitive database failure detail'); }
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
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadToTelegram: async () => {} } };
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: async () => { throw new Error('unexpected network call'); } };
const tasksRouter = require('../routes/tasks');
const app = express();
app.use(express.json());
app.use(session({ name: 'task-access-error-test.sid', secret: 'task-access-error-test-session-secret-32-chars', resave: false, saveUninitialized: false }));
app.post('/test-session/:role', (req, res) => {
  req.session.userId = 7;
  req.session.role = req.params.role;
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api', tasksRouter);
app.use((error, req, res, next) => res.status(500).json({ error: 'Internal server error.' }));

let server;
let baseUrl;
let adminCookie;
let employeeCookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = await fetch(`${baseUrl}/test-session/admin`, { method: 'POST' });
  const employee = await fetch(`${baseUrl}/test-session/employee`, { method: 'POST' });
  adminCookie = admin.headers.get('set-cookie').split(';', 1)[0];
  employeeCookie = employee.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/tasks')];
});

test('project-action access endpoints return generic JSON errors on DB failures', async () => {
  const list = await fetch(`${baseUrl}/api/project-action-access`, { headers: { Cookie: adminCookie } });
  const mine = await fetch(`${baseUrl}/api/project-action-access/me`, { headers: { Cookie: employeeCookie } });
  const update = await fetch(`${baseUrl}/api/project-action-access/8`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ edit_task: false })
  });
  for (const response of [list, mine, update]) {
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Internal server error.' });
    assert.doesNotMatch(JSON.stringify(body), /sensitive database failure detail/);
  }
});
