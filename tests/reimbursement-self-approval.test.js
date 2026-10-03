const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const dbPath = require.resolve('../db');
const auditPath = require.resolve('../audit');
const originalDbModule = require.cache[dbPath];
const originalAuditModule = require.cache[auditPath];
const employee = {
  id: 41,
  name: 'Approver Employee',
  username: 'approver',
  department: 'Testing',
  role: 'employee',
  active: 1,
  must_change_password: 0,
  token_version: 1
};
const ownClaim = {
  id: 501,
  user_id: employee.id,
  status: 'approved_level_1',
  amount: 12.34,
  currency: 'INR',
  category: 'Travel'
};
let reimbursementWrites = 0;

const mockDb = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM users WHERE id')) return Number(args.at(-1)) === employee.id ? { ...employee } : null;
        if (sql.includes('FROM reimbursement_access')) return { approval_level: 2, can_pay: 1 };
        if (sql.includes('FROM reimbursements WHERE id')) return Number(args.at(-1)) === ownClaim.id ? { ...ownClaim } : null;
        return null;
      },
      all: async () => [],
      run: async () => {
        reimbursementWrites += 1;
        return { changes: 1 };
      }
    };
  }
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { logActivity: async () => {} }
};

const reimbursementsRouter = require('../routes/reimbursements');
const app = express();
app.use(express.json());
app.use(session({
  name: 'reimbursement-test.sid',
  secret: 'reimbursement-test-session-secret-at-least-32-chars',
  resave: false,
  saveUninitialized: false
}));
app.post('/test-session', (req, res) => {
  req.session.userId = employee.id;
  req.session.role = employee.role;
  req.session.tokenVersion = employee.token_version;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api/reimbursements', reimbursementsRouter);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

let server;
let baseUrl;
let cookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = login.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (originalDbModule) require.cache[dbPath] = originalDbModule;
  else delete require.cache[dbPath];
  if (originalAuditModule) require.cache[auditPath] = originalAuditModule;
  else delete require.cache[auditPath];
  delete require.cache[require.resolve('../routes/reimbursements')];
  delete require.cache[require.resolve('../routes/auth')];
});

async function submit(route, body) {
  return fetch(`${baseUrl}/api/reimbursements${route}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });
}

test('approvers cannot approve or pay their own claim, including in bulk', async () => {
  reimbursementWrites = 0;
  const approve = await submit(`/${ownClaim.id}/status`, { status: 'approved' });
  const pay = await submit(`/${ownClaim.id}/status`, { status: 'paid' });
  const bulk = await submit('/bulk-status', { ids: [ownClaim.id] });

  assert.equal(approve.status, 403);
  assert.equal(pay.status, 403);
  assert.equal(bulk.status, 403);

  employee.role = 'admin';
  const adminSelfApproval = await submit(`/${ownClaim.id}/status`, { status: 'approved' });
  employee.role = 'employee';
  assert.equal(adminSelfApproval.status, 403, 'administrators cannot approve their own claims');
  assert.equal(reimbursementWrites, 0, 'self-approval requests must not write reimbursement status');
});
