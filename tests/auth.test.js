const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const dbPath = require.resolve('../db');
const auditPath = require.resolve('../audit');
const originalDbModule = require.cache[dbPath];
const originalAuditModule = require.cache[auditPath];

const user = {
  id: 1,
  name: 'Test Employee',
  username: 'employee',
  department: 'Testing',
  role: 'employee',
  active: 1,
  must_change_password: 0,
  token_version: 0,
  password_hash: ''
};
const otherUser = {
  id: 2,
  name: 'Second Employee',
  username: 'second',
  department: 'Testing',
  role: 'employee',
  active: 1,
  must_change_password: 0,
  token_version: 0,
  password_hash: ''
};
const users = new Map([[user.id, user], [otherUser.id, otherUser]]);
const deletedSessionUsers = [];

const mockDb = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM users WHERE username = ?')) {
          const found = [...users.values()].find(row => row.username === args[0]);
          return found ? { ...found } : null;
        }
        if (sql.includes('FROM users WHERE id')) {
          const found = users.get(Number(args.at(-1)));
          return found ? { ...found } : null;
        }
        return null;
      },
      all: async () => [],
      run: async (...args) => {
        if (sql.includes('DELETE FROM web_sessions WHERE user_id')) {
          deletedSessionUsers.push(Number(args[0]));
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET password_hash')) {
          const target = users.get(Number(args.at(-1)));
          target.password_hash = args[0];
          target.must_change_password = sql.includes('must_change_password=0') ? 0 : 1;
          target.token_version += 1;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET token_version')) {
          const target = users.get(Number(args.at(-1)));
          target.token_version += 1;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET active')) {
          const target = users.get(Number(args.at(-1)));
          target.active = Number(args[0]);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET role')) {
          const target = users.get(Number(args.at(-1)));
          target.role = args[0];
          return { changes: 1 };
        }
        return { changes: 0 };
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

const { router, requireAuth } = require('../routes/auth');
const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json());
app.use(session({
  name: 'taskflow.sid.v2',
  secret: 'auth-route-test-session-secret-at-least-32-chars',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));
app.get('/api/company-status-probe', (req, res, next) => {
  req.companyStatus = 'suspended';
  next();
}, requireAuth, (req, res) => res.json({ ok: true }));
app.use('/api/auth', router);
app.use((error, req, res, next) => {
  const status = Number(error.statusCode || error.status);
  const clientError = status >= 400 && status < 500;
  res.status(clientError ? status : 500).json({ error: clientError ? 'Invalid request.' : 'Internal server error.' });
});

let server;
let baseUrl;
let requestNumber = 0;

before(async () => {
  user.password_hash = await bcrypt.hash('initial-password-123', 4);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (originalDbModule) require.cache[dbPath] = originalDbModule;
  else delete require.cache[dbPath];
  if (originalAuditModule) require.cache[auditPath] = originalAuditModule;
  else delete require.cache[auditPath];
  delete require.cache[require.resolve('../routes/auth')];
});

function nextIp() {
  requestNumber += 1;
  return `198.51.100.${requestNumber}`;
}

async function request(route, { method = 'GET', body, cookie, timeoutMs = 3000 } = {}) {
  const headers = { 'X-Forwarded-For': nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}/api/auth${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function login(password = 'initial-password-123') {
  const response = await request('/login', {
    method: 'POST',
    body: { username: 'employee', password }
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'login should issue a session cookie');
  return setCookie.split(';', 1)[0];
}

test('malformed login bodies fail quickly without server errors', async () => {
  const cases = [
    { body: {} },
    { body: { username: 123, password: 'password' } },
    { body: { username: 'employee', password: 123 } },
    { body: [] },
    { body: 123 },
    { body: { username: 'employee', password: 'x'.repeat(10000) } }
  ];

  for (const [index, loginCase] of cases.entries()) {
    const response = await request('/login', { method: 'POST', ...loginCase, timeoutMs: 5000 });
    assert.ok([400, 401].includes(response.status), `case ${index + 1} returned ${response.status}: ${await response.text()}`);
  }
});

test('password change invalidates the other browser session', async () => {
  deletedSessionUsers.length = 0;
  const browserOne = await login();
  const browserTwo = await login();

  const changeResponse = await request('/change-password', {
    method: 'POST',
    cookie: browserOne,
    body: { current_password: 'initial-password-123', new_password: 'replacement-password-456' }
  });
  assert.equal(changeResponse.status, 200);
  assert.deepEqual(deletedSessionUsers, [user.id]);

  const changedSessionCookie = changeResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(changedSessionCookie, 'password change should issue a regenerated session cookie');
  const firstBrowserResponse = await request('/me', { cookie: changedSessionCookie });
  const oldFirstBrowserResponse = await request('/me', { cookie: browserOne });
  const secondBrowserResponse = await request('/me', { cookie: browserTwo });
  assert.equal(firstBrowserResponse.status, 200);
  assert.equal(oldFirstBrowserResponse.status, 401);
  assert.equal(secondBrowserResponse.status, 401);

  const replacementLogin = await request('/login', {
    method: 'POST',
    body: { username: 'employee', password: 'replacement-password-456' }
  });
  assert.equal(replacementLogin.status, 200);
});

test('inactive company status blocks authenticated requests', async () => {
  const cookie = await login('replacement-password-456');
  const response = await fetch(`${baseUrl}/api/company-status-probe`, {
    headers: { Cookie: cookie, 'X-Forwarded-For': nextIp() }
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'This company workspace is not active.' });
});

test('employee sessions receive 403 from every admin-only auth route', async () => {
  const employeeCookie = await login('replacement-password-456');
  const adminRoutes = [
    ['GET', '/users'],
    ['POST', '/users', { name: 'Promoted', username: 'promoted', password: 'valid-password-123' }],
    ['PUT', '/users/1/reset-password', { password: 'valid-password-123' }],
    ['PUT', '/users/1', { role: 'admin' }],
    ['DELETE', '/users/1'],
    ['GET', '/departments'],
    ['POST', '/departments', { name: 'New department' }],
    ['DELETE', '/departments/1'],
    ['GET', '/reimbursement-access'],
    ['PUT', '/reimbursement-access/1', { approval_level: 1 }],
    ['GET', '/settings'],
    ['PUT', '/settings', { office_radius_m: 100 }]
  ];

  for (const [method, route, body] of adminRoutes) {
    const response = await request(route, { method, body, cookie: employeeCookie });
    assert.equal(response.status, 403, `${method} ${route} should be forbidden`);
  }
});

test('admin password reset and user deactivation delete persistent sessions', async () => {
  const originalUser = { ...user };
  const originalOtherUser = { ...otherUser };
  deletedSessionUsers.length = 0;
  try {
    user.role = 'admin';
    const adminCookie = await login('replacement-password-456');
    const reset = await request('/users/2/reset-password', {
      method: 'PUT',
      cookie: adminCookie,
      body: { password: 'reset-password-12345' }
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(deletedSessionUsers, [otherUser.id]);

    deletedSessionUsers.length = 0;
    const deactivate = await request('/users/2', {
      method: 'PUT',
      cookie: adminCookie,
      body: { active: false }
    });
    assert.equal(deactivate.status, 200);
    assert.deepEqual(deletedSessionUsers, [otherUser.id]);
  } finally {
    Object.assign(user, originalUser);
    Object.assign(otherUser, originalOtherUser);
    deletedSessionUsers.length = 0;
  }
});