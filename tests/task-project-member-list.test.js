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
let memberQuery = '';

const mockDb = {
  prepare(sql) {
    return {
      get: async () => sql.includes('FROM projects p LEFT JOIN project_members') ? { allowed: 1 } : null,
      all: async () => {
        if (sql.includes('FROM project_members pm JOIN users u')) {
          memberQuery = sql;
          return [{ id: 7, name: 'Project member' }];
        }
        return [];
      },
      run: async () => ({ changes: 0 })
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
app.use(session({ name: 'project-member-list.sid', secret: 'project-member-list-session-secret-at-least-32', resave: false, saveUninitialized: false }));
app.post('/test-session', (req, res) => {
  req.session.userId = 22;
  req.session.role = 'employee';
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
  const response = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = response.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/tasks')];
});

test('project members response exposes only the ID and display name', async () => {
  const response = await fetch(`${baseUrl}/api/projects/200/members`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 7, name: 'Project member' }]);
  assert.match(memberQuery, /SELECT\s+u\.id,\s*u\.name\s+FROM/);
  assert.doesNotMatch(memberQuery, /username|role/i);
});
