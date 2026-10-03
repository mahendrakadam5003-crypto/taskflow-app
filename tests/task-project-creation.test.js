const assert = require('node:assert/strict');
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
let activeUserIds = [1, 2];
let createdProjects = 0;
let membershipBatches = [];
let savedProjectPinHash = null;

const mockDb = {
  batch: async statements => {
    membershipBatches.push(statements);
    return [];
  },
  prepare(sql) {
    return {
      get: async () => null,
      all: async (...args) => sql.includes('SELECT id FROM users WHERE active=1')
        ? args.filter(id => activeUserIds.includes(id)).map(id => ({ id }))
        : [],
      run: async (...args) => {
        if (sql.includes('INSERT INTO projects')) {
          createdProjects += 1;
          savedProjectPinHash = args[1];
          return { changes: 1, lastInsertRowid: 20 };
        }
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
app.use(session({ name: 'project-create-test.sid', secret: 'project-create-test-session-secret-at-least-32-chars', resave: false, saveUninitialized: false }));
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

async function createProject(body) {
  return fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });
}

test('project PINs must be 4 to 12 digits and are asynchronously hashed', async () => {
  createdProjects = 0;
  const rejected = await createProject({ name: 'Bad PIN', pin: '12ab' });
  assert.equal(rejected.status, 400);
  assert.equal(createdProjects, 0);

  const accepted = await createProject({ name: 'Valid PIN', pin: '12345', member_ids: [2] });
  assert.equal(accepted.status, 200);
  assert.ok(savedProjectPinHash);
  assert.equal(await bcrypt.compare('12345', savedProjectPinHash), true);
  assert.deepEqual(membershipBatches.at(-1)[0].args, [20, 1]);
  assert.deepEqual(membershipBatches.at(-1)[1].args, [20, 2]);
});

test('project creation rejects missing or inactive member IDs before creating the project', async () => {
  createdProjects = 0;
  activeUserIds = [1];
  const response = await createProject({ name: 'Invalid member', member_ids: [999] });
  assert.equal(response.status, 400);
  assert.equal(createdProjects, 0);
  activeUserIds = [1, 2];
});
