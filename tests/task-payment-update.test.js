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
const task = {
  id: 900,
  project_id: 200,
  assignee_id: 44,
  payment_member_id: 44,
  payment_status: 'pending',
  payment_received_date: null,
  total_amount: 100,
  amount_received: 25
};
let isProjectMember = false;
let writes = [];
const auditEntries = [];

const mockDb = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM payment_history_access')) return { allowed: 1 };
        if (sql.includes('SELECT id, project_id, assignee_id, payment_member_id')) return Number(args.at(-1)) === task.id ? { ...task } : null;
        if (sql.includes('SELECT project_id, assignee_id FROM tasks')) return { project_id: task.project_id, assignee_id: task.assignee_id };
        if (sql.includes('FROM projects p LEFT JOIN project_members')) return isProjectMember ? { allowed: 1 } : null;
        if (sql.includes('SELECT id FROM users WHERE id=? AND active=1')) return Number(args[0]) === 44 ? { id: 44 } : null;
        return null;
      },
      all: async () => [],
      run: async (...args) => {
        writes.push({ sql, args });
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
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { logActivity: async (...args) => { auditEntries.push(args); } }
};
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadToTelegram: async () => {} } };
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: async () => { throw new Error('unexpected HTTP call'); } };
const tasksRouter = require('../routes/tasks');
const app = express();
app.use(express.json());
app.use(session({ name: 'task-payment-update.sid', secret: 'task-payment-update-session-secret-32-chars', resave: false, saveUninitialized: false }));
app.post('/test-session', (req, res) => {
  req.session.userId = 77;
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

async function updatePayment() {
  return fetch(`${baseUrl}/api/payment-history/${task.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ payment_status: 'received', amount_received: 75, payment_member_id: 44 })
  });
}

test('payment-history editor must have task access and successful edits are audited', async () => {
  writes = [];
  auditEntries.length = 0;
  isProjectMember = false;
  const denied = await updatePayment();
  assert.equal(denied.status, 403);
  assert.equal(writes.length, 0);
  assert.equal(auditEntries.length, 0);

  isProjectMember = true;
  const allowed = await updatePayment();
  assert.equal(allowed.status, 200);
  assert.equal(writes.length, 1);
  const audit = auditEntries.find(entry => entry[1] === 'Invoice payment updated');
  assert.ok(audit);
  assert.match(audit[4], /Status: pending -> received/);
  assert.match(audit[4], /received: 25\.00 -> 75\.00/);
});
