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
let activeUserIds = [1, 2];
let batches = [];

const mockDb = {
  batch: async statements => {
    batches.push(statements);
    return [];
  },
  prepare(sql) {
    return {
      get: async () => sql.includes('SELECT created_by FROM projects') ? { created_by: 1 } : null,
      all: async (...args) => sql.includes('SELECT id FROM users WHERE active = 1')
        ? args.filter(id => activeUserIds.includes(id)).map(id => ({ id }))
        : [],
      run: async () => ({ changes: 1 })
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
app.use(session({ name: 'task-members-test.sid', secret: 'task-members-test-session-secret-at-least-32-chars', resave: false, saveUninitialized: false }));
app.post('/test-session', (req, res) => {
  req.session.userId = 1;
  req.session.role = 'admin';
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api', tasksRouter);
app.use((error, req, res, next) => res.status(500).json({ error: 'Internal server error.' }));

let server;
let baseUrl;
let cookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sessionResponse = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/tasks')];
});

async function replaceMembers(userIds) {
  return fetch(`${baseUrl}/api/projects/10/members`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ user_ids: userIds })
  });
}

test('project member replacement uses one batch and preserves the creator', async () => {
  batches = [];
  activeUserIds = [1, 2];
  const response = await replaceMembers([2, 2]);
  assert.equal(response.status, 200);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.match(batches[0][0].sql, /^DELETE FROM project_members/);
  assert.deepEqual(batches[0].slice(1).map(statement => statement.args[1]).sort(), [1, 2]);
});

test('member replacement rejects inactive/missing users before deleting current members', async () => {
  batches = [];
  activeUserIds = [1];
  const response = await replaceMembers([99]);
  assert.equal(response.status, 400);
  assert.equal(batches.length, 0);
});
