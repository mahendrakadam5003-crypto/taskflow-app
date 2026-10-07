const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const dbPath = require.resolve('../db');
const auditPath = require.resolve('../audit');
const limitsPath = require.resolve('../limits');
const originalDbModule = require.cache[dbPath];
const originalAuditModule = require.cache[auditPath];
const originalLimitsModule = require.cache[limitsPath];

const user = {
  id: 1,
  name: 'Test Employee',
  username: 'employee',
  email: 'employee@example.test',
  email_verified: 1,
  google_sub: null,
  auth_provider: 'password',
  department: 'Testing',
  role: 'employee',
  active: 1,
  must_change_password: 0,
  token_version: 0,
  web_access_enabled: 1,
  password_hash: ''
};
const otherUser = {
  id: 2,
  name: 'Second Employee',
  username: 'second',
  email: 'second@example.test',
  email_verified: 1,
  google_sub: null,
  auth_provider: 'password',
  department: 'Testing',
  role: 'employee',
  active: 1,
  must_change_password: 0,
  token_version: 0,
  web_access_enabled: 1,
  password_hash: ''
};
const users = new Map([[user.id, user], [otherUser.id, otherUser]]);
const deletedSessionUsers = [];
const appLoginDevices = new Map();

const mockDb = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM app_login_devices WHERE user_id')) {
          return appLoginDevices.get(Number(args[0])) || null;
        }
        if (sql.includes('FROM users WHERE username = ?')) {
          const found = [...users.values()].find(row => row.username === args[0]);
          return found ? { ...found } : null;
        }
        if (sql.includes('lower(trim(email)) = ?')) {
          const found = [...users.values()].find(row => row.email_verified === 1 && row.email?.trim().toLowerCase() === args[0]);
          return found ? { ...found } : null;
        }
        if (sql.includes('FROM users WHERE id')) {
          const found = users.get(Number(args.at(-1)));
          if (!found) return null;
          const selectedColumns = sql.match(/SELECT\s+([\s\S]+?)\s+FROM users WHERE id\s*=/i)?.[1]
            .split(',')
            .map(column => column.trim());
          return selectedColumns
            ? Object.fromEntries(selectedColumns.filter(column => column in found).map(column => [column, found[column]]))
            : { ...found };
        }
        return null;
      },
      all: async () => [],
      run: async (...args) => {
        if (sql.includes('INSERT OR IGNORE INTO app_login_devices')) {
          const [userId, deviceIdHash, deviceModel] = args;
          if (!appLoginDevices.has(Number(userId))) {
            appLoginDevices.set(Number(userId), { device_id_hash: deviceIdHash, device_model: deviceModel });
          }
          return { changes: 1 };
        }
        if (sql.includes('DELETE FROM app_login_devices')) {
          return { changes: appLoginDevices.delete(Number(args[0])) ? 1 : 0 };
        }
        if (sql.includes('UPDATE users SET web_access_enabled')) {
          const [enabled, userId] = args;
          const target = users.get(Number(userId));
          target.web_access_enabled = enabled;
          target.token_version += 1;
          return { changes: 1 };
        }
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
        if (sql.includes('UPDATE users SET active = 1')) {
          const [id, limit] = args;
          const target = users.get(Number(id));
          const activeCount = [...users.values()].filter(row => Number(row.active) === 1).length;
          if (!target || Number(target.active) !== 0 || (limit !== null && activeCount >= Number(limit))) {
            return { changes: 0 };
          }
          target.active = 1;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET active')) {
          const target = users.get(Number(args.at(-1)));
          target.active = sql.includes('active = 0') ? 0 : Number(args[0]);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET role')) {
          const target = users.get(Number(args.at(-1)));
          target.role = args[0];
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET email = ?')) {
          const target = users.get(Number(args.at(-1)));
          target.email = args[0];
          target.email_verified = 0;
          target.google_sub = null;
          return { changes: 1 };
        }
        return { changes: 0 };
      }
    };
  },
  async batch(statements) {
    const statement = statements[0];
    const [name, username, passwordHash, department, role, email, dateOfBirth, phone, limit] = statement.args;
    const activeCount = [...users.values()].filter(row => Number(row.active) === 1).length;
    if (limit !== null && activeCount >= Number(limit)) return [{ rowsAffected: 0 }, { rows: [] }];
    const id = Math.max(...users.keys()) + 1;
    users.set(id, {
      id, name, username, password_hash: passwordHash, department, role, active: 1,
      email, date_of_birth: dateOfBirth, phone, email_verified: 0, google_sub: null, auth_provider: 'password',
      must_change_password: 1, token_version: 0, web_access_enabled: 0
    });
    return [{ rowsAffected: 1 }, { rows: [{ id }] }];
  }
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { logActivity: async () => {} }
};
require.cache[limitsPath] = {
  id: limitsPath,
  filename: limitsPath,
  loaded: true,
  exports: {
    getPlan: async () => ({ maxUsers: 2 }),
    getPlanUsage: async () => ({
      plan: null,
      features: { attendance: true, reimbursements: true, export: true },
      usage: { activeUsers: 2, databaseBytes: 0, fileBytes: 0, storageBytes: 0, percentUsed: null, warningThreshold: null }
    })
  }
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
app.post('/test-session', (req, res) => {
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  req.session.tokenVersion = user.token_version;
  req.session.companyId = 'legacy';
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.post('/test-app-session', (req, res) => {
  const deviceIdHash = 'test-app-device-hash';
  appLoginDevices.set(otherUser.id, { device_id_hash: deviceIdHash, device_model: 'Google Test Device' });
  req.session.userId = otherUser.id;
  req.session.role = otherUser.role;
  req.session.name = otherUser.name;
  req.session.tokenVersion = otherUser.token_version;
  req.session.companyId = 'legacy';
  req.session.loginClient = 'app';
  req.session.loginDeviceHash = deviceIdHash;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.get('/api/project-action-access/me', requireAuth, (req, res) => res.json({ userId: req.authenticatedUser.id }));
app.get('/api/company-status-probe', (req, res, next) => {
  req.companyStatus = 'suspended';
  next();
}, requireAuth, (req, res) => res.json({ ok: true }));
app.get('/api/suspended-read-only-probe', (req, res, next) => {
  req.companyStatus = 'suspended';
  next();
}, requireAuth, (req, res) => res.json({ readOnly: true }));
app.post('/api/suspended-read-only-probe', (req, res, next) => {
  req.companyStatus = 'suspended';
  next();
}, requireAuth, (req, res) => res.json({ changed: true }));
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
  if (originalLimitsModule) require.cache[limitsPath] = originalLimitsModule;
  else delete require.cache[limitsPath];
  delete require.cache[require.resolve('../routes/auth')];
});

function nextIp() {
  requestNumber += 1;
  return `198.51.100.${requestNumber}`;
}

async function request(route, { method = 'GET', body, cookie, userAgent, timeoutMs = 3000 } = {}) {
  const headers = { 'X-Forwarded-For': nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (userAgent) headers['User-Agent'] = userAgent;
  return fetch(`${baseUrl}/api/auth${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function login(password = 'initial-password-123') {
  const response = await fetch(`${baseUrl}/test-session`, {
    method: 'POST',
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

test('failed login attempts are rate-limited per company despite rotating IPs and usernames', async () => {
  const responses = [];
  for (let index = 0; index < 11; index++) {
    responses.push(await request('/login', {
      method: 'POST',
      body: {
        username: `rate-user-${index}`,
        password: 'incorrect-password',
        company_code: 'company-limit-test'
      }
    }));
  }
  assert.ok(responses.slice(0, 10).every(response => response.status === 401));
  assert.equal(responses[10].status, 429);
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
  assert.equal((await firstBrowserResponse.json()).features.attendance, true);
  assert.equal(oldFirstBrowserResponse.status, 401);
  assert.equal(secondBrowserResponse.status, 401);

  const replacementLogin = await request('/login', {
    method: 'POST',
    body: { username: 'employee', password: 'replacement-password-456' }
  });
  assert.equal(replacementLogin.status, 200);
  assert.equal((await replacementLogin.json()).username, 'employee');
});

test('native app sessions validate their device using the loaded user ID', async () => {
  const response = await fetch(`${baseUrl}/test-app-session`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': nextIp() }
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];

  const currentUser = await request('/me', { cookie, userAgent: 'Mozilla/5.0 TaskFlowNative/1' });
  const body = await currentUser.json();
  assert.equal(currentUser.status, 200, JSON.stringify(body));
  assert.equal(body.id, otherUser.id);

  const projectAccess = await fetch(`${baseUrl}/api/project-action-access/me`, {
    headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0 TaskFlowNative/1', 'X-Forwarded-For': nextIp() }
  });
  assert.equal(projectAccess.status, 200);
  assert.deepEqual(await projectAccess.json(), { userId: otherUser.id });
});

test('inactive company status blocks authenticated requests', async () => {
  const cookie = await login('replacement-password-456');
  const response = await fetch(`${baseUrl}/api/company-status-probe`, {
    headers: { Cookie: cookie, 'X-Forwarded-For': nextIp() }
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Account suspended, contact support.',
    suspended: true,
    read_only: true
  });
});

test('suspended company admins can read but cannot change workspace data', async () => {
  const originalRole = user.role;
  user.role = 'admin';
  try {
    const cookie = await login('replacement-password-456');
    const read = await fetch(`${baseUrl}/api/suspended-read-only-probe`, {
      headers: { Cookie: cookie, 'X-Forwarded-For': nextIp() }
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { readOnly: true });

    const write = await fetch(`${baseUrl}/api/suspended-read-only-probe`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-Forwarded-For': nextIp() }
    });
    assert.equal(write.status, 403);
    assert.deepEqual(await write.json(), {
      error: 'Account suspended, contact support.',
      suspended: true,
      read_only: true
    });
  } finally {
    user.role = originalRole;
  }
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

test('user seats are enforced for creation and reactivation, and deactivation frees a seat', async () => {
  const originalUsers = new Map([...users].map(([id, row]) => [id, { ...row }]));
  try {
    user.role = 'admin';
    otherUser.active = 1;
    const adminCookie = await login('replacement-password-456');
    const denied = await request('/users', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        username: 'over-limit',
        password: 'temporary-password-123',
        name: 'Over limit', date_of_birth: '1990-01-01', phone: '+1 555 010 2030',
        email: 'over-limit@example.test', department: 'Testing'
      }
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'User limit reached - add seats.' });

    const deactivate = await request('/users/2', { method: 'PUT', cookie: adminCookie, body: { active: false } });
    assert.equal(deactivate.status, 200);
    const created = await request('/users', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        username: 'new-seat',
        password: 'temporary-password-123',
        name: 'New seat', date_of_birth: '1990-01-01', phone: '+1 555 010 2031',
        email: 'new-seat@example.test', department: 'Testing'
      }
    });
    assert.equal(created.status, 201);
    const createdUser = await created.json();
    const { id: newUserId } = createdUser;
    assert.equal(createdUser.invitationSent, false);
    assert.equal(createdUser.username, 'new-seat');
    assert.equal(users.get(newUserId).email, 'new-seat@example.test');
    assert.equal(users.get(newUserId).date_of_birth, '1990-01-01');
    assert.equal(users.get(newUserId).phone, '+1 555 010 2031');
    assert.equal(users.get(newUserId).auth_provider, 'password');
    assert.equal(users.get(newUserId).must_change_password, 1);

    const newMemberLogin = await request('/login', {
      method: 'POST',
      body: { username: 'new-seat', password: 'temporary-password-123' }
    });
    assert.equal(newMemberLogin.status, 403);
    assert.equal((await newMemberLogin.json()).code, 'WEB_LOGIN_NOT_ALLOWED');
    const enableNewMemberWeb = await request(`/users/${newUserId}/web-access`, {
      method: 'PUT',
      cookie: adminCookie,
      body: { enabled: true }
    });
    assert.equal(enableNewMemberWeb.status, 200);
    const newMemberWebLogin = await request('/login', {
      method: 'POST',
      body: { username: 'new-seat', password: 'temporary-password-123' }
    });
    assert.equal(newMemberWebLogin.status, 200);
    assert.equal((await newMemberWebLogin.json()).must_change_password, true);

    const deniedReactivation = await request('/users/2', { method: 'PUT', cookie: adminCookie, body: { active: true } });
    assert.equal(deniedReactivation.status, 403);
    assert.deepEqual(await deniedReactivation.json(), { error: 'User limit reached - add seats.' });
    const freeSeat = await request(`/users/${newUserId}`, { method: 'PUT', cookie: adminCookie, body: { active: false } });
    assert.equal(freeSeat.status, 200);
    const reactivated = await request('/users/2', { method: 'PUT', cookie: adminCookie, body: { active: true } });
    assert.equal(reactivated.status, 200);
  } finally {
    users.clear();
    Object.assign(user, originalUsers.get(user.id));
    Object.assign(otherUser, originalUsers.get(otherUser.id));
    users.set(user.id, user);
    users.set(otherUser.id, otherUser);
  }
});

test('username and password sign-in remains available regardless of email verification status', async () => {
  const originalPasswordHash = user.password_hash;
  const originalEmail = user.email;
  const originalVerified = user.email_verified;
  user.password_hash = await bcrypt.hash('email-login-password-123', 4);
  user.email = 'employee@example.test';
  user.email_verified = 0;
  try {
    const unverified = await request('/login', {
      method: 'POST',
      body: { username: user.email, password: 'email-login-password-123' }
    });
    assert.equal(unverified.status, 401);

    user.email_verified = 1;
    const verified = await request('/login', {
      method: 'POST',
      body: { username: user.email, password: 'email-login-password-123' }
    });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).username, user.username);
  } finally {
    user.password_hash = originalPasswordHash;
    user.email = originalEmail;
    user.email_verified = originalVerified;
  }
});

test('existing accounts without a verified email can use all workspace features after password sign-in', async () => {
  const snapshot = { ...user };
  try {
    user.email = null;
    user.email_verified = 0;
    user.password_hash = await bcrypt.hash('legacy-account-password', 4);
    const loginResponse = await request('/login', {
      method: 'POST',
      body: { username: user.username, password: 'legacy-account-password' }
    });
    assert.equal(loginResponse.status, 200);
    assert.equal((await loginResponse.json()).requires_email_enrollment, undefined);
    const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];

    const profile = await request('/me', { cookie });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).requires_email_enrollment, undefined);

    const activity = await request('/activity', { cookie });
    assert.equal(activity.status, 200);
  } finally {
    Object.assign(user, snapshot);
  }
});

test('admin email changes require reverification and remove the previous Google link', async () => {
  const snapshot = { ...user };
  try {
    user.role = 'admin';
    user.email = 'old@example.test';
    user.email_verified = 1;
    user.google_sub = 'old-google-sub';
    user.password_hash = await bcrypt.hash('admin-email-test-password', 4);
    const adminCookie = await login('admin-email-test-password');
    const response = await request('/users/1', {
      method: 'PUT',
      cookie: adminCookie,
      body: { email: ' New.Address@example.test ' }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.emailVerificationSent, false);
    assert.match(result.emailVerificationError, /Email delivery is not configured/);
    assert.equal(user.email, 'new.address@example.test');
    assert.equal(user.email_verified, 0);
    assert.equal(user.google_sub, null);
  } finally {
    Object.assign(user, snapshot);
  }
});

test('native app accounts bind one model while admins control browser access and device reset', async () => {
  const originalAdmin = { ...user };
  const originalEmployee = { ...otherUser };
  appLoginDevices.delete(otherUser.id);
  try {
    user.role = 'admin';
    otherUser.web_access_enabled = 0;
    otherUser.password_hash = await bcrypt.hash('registered-device-password', 4);
    const adminCookie = await login('replacement-password-456');
    const appRequest = (deviceId, model) => request('/login', {
      method: 'POST',
      userAgent: 'Mozilla/5.0 TaskFlowNative/1',
      body: {
        username: otherUser.username,
        password: 'registered-device-password',
        device_id: deviceId,
        manufacturer: 'Google',
        model
      }
    });

    const firstAppLogin = await appRequest('android-id-pixel-9-12345', 'Pixel 9');
    assert.equal(firstAppLogin.status, 200);
    assert.equal(appLoginDevices.get(otherUser.id).device_model, 'Google Pixel 9');

    const secondAppLogin = await appRequest('android-id-galaxy-s25-1234', 'Galaxy S25');
    assert.equal(secondAppLogin.status, 403);
    assert.equal((await secondAppLogin.json()).code, 'APP_DEVICE_MISMATCH');

    const deniedBrowserLogin = await request('/login', {
      method: 'POST',
      body: { username: otherUser.username, password: 'registered-device-password' }
    });
    assert.equal(deniedBrowserLogin.status, 403);
    assert.equal((await deniedBrowserLogin.json()).code, 'WEB_LOGIN_NOT_ALLOWED');

    const previousMobileBrowserSetting = process.env.ALLOW_MOBILE_BROWSER_LOGIN;
    let mobileBrowserSession;
    try {
      process.env.ALLOW_MOBILE_BROWSER_LOGIN = 'true';
      const mobileBrowserLogin = await request('/login', {
        method: 'POST',
        userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131.0 Mobile Safari/537.36',
        body: { username: otherUser.username, password: 'registered-device-password' }
      });
      assert.equal(mobileBrowserLogin.status, 200);
      mobileBrowserSession = mobileBrowserLogin.headers.get('set-cookie').split(';', 1)[0];
      assert.equal((await request('/me', { cookie: mobileBrowserSession })).status, 200);

      process.env.ALLOW_MOBILE_BROWSER_LOGIN = 'false';
      assert.equal((await request('/me', { cookie: mobileBrowserSession })).status, 401);
    } finally {
      if (previousMobileBrowserSetting === undefined) delete process.env.ALLOW_MOBILE_BROWSER_LOGIN;
      else process.env.ALLOW_MOBILE_BROWSER_LOGIN = previousMobileBrowserSetting;
    }

    const enabled = await request(`/users/${otherUser.id}/web-access`, {
      method: 'PUT', cookie: adminCookie, body: { enabled: true }
    });
    assert.equal(enabled.status, 200);
    const browserLogin = await request('/login', {
      method: 'POST',
      body: { username: otherUser.username, password: 'registered-device-password' }
    });
    assert.equal(browserLogin.status, 200);

    const disabled = await request(`/users/${otherUser.id}/web-access`, {
      method: 'PUT', cookie: adminCookie, body: { enabled: false }
    });
    assert.equal(disabled.status, 200);
    const browserSession = browserLogin.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await request('/me', { cookie: browserSession })).status, 401);

    const reset = await request(`/users/${otherUser.id}/app-device`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(reset.status, 200);
    assert.equal(appLoginDevices.has(otherUser.id), false);
    assert.equal((await appRequest('android-id-galaxy-s25-1234', 'Galaxy S25')).status, 200);
  } finally {
    Object.assign(user, originalAdmin);
    Object.assign(otherUser, originalEmployee);
    appLoginDevices.delete(otherUser.id);
  }
});