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

let deletedStatements = [];
let loggedActivity = [];

const mockDb = {
  batch: async statements => {
    deletedStatements = statements;
    return [];
  },
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('SELECT 1 FROM projects p LEFT JOIN project_members pm')) {
          return { allowed: 1 };
        }
        if (sql.includes('FROM project_action_access WHERE user_id=?')) {
          return { allowed: 1 };
        }
        if (sql.includes('SELECT id, name, created_by FROM projects')) {
          return { id: Number(args[0]), name: 'Alpha Project', created_by: 7 };
        }
        return null;
      },
      all: async (...args) => {
        if (sql.includes('SELECT id FROM tasks WHERE project_id')) {
          return [{ id: 11 }, { id: 12 }];
        }
        return [];
      },
      run: async (...args) => ({ changes: 1 })
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
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { logActivity: async (...args) => { loggedActivity.push(args); } } };
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadToTelegram: async () => {} } };
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: async () => { throw new Error('unexpected network call'); } };

const tasksRouter = require('../routes/tasks');
const app = express();
app.use(express.json());
app.use(session({ name: 'project-delete-protection.sid', secret: 'project-delete-protection-secret-at-least-32', resave: false, saveUninitialized: false }));
app.post('/test-session', (req, res) => {
  req.session.userId = 7;
  req.session.role = 'employee';
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api', tasksRouter);

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

test('project deletion records an audit trail and clears related rows before removing the project', async () => {
  deletedStatements = [];
  loggedActivity = [];

  const response = await fetch(`${baseUrl}/api/projects/42`, {
    method: 'DELETE',
    headers: { Cookie: cookie }
  });

  assert.equal(response.status, 200);
  assert.equal(loggedActivity.length >= 1, true);
  assert.ok(deletedStatements.some(statement => /DELETE FROM project_members WHERE project_id = \?/.test(statement.sql)));
  assert.ok(deletedStatements.some(statement => /DELETE FROM tasks WHERE project_id = \?/.test(statement.sql)));
  assert.ok(deletedStatements.some(statement => /DELETE FROM projects WHERE id = \?/.test(statement.sql)));
});
