'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { after, before, test } = require('node:test');

const dbPath = require.resolve('../db');
const originalDbModule = require.cache[dbPath];
const auditPath = require.resolve('../audit');
const originalAuditModule = require.cache[auditPath];
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: { logActivity: async () => {} }
};

const users = new Map([
  [1, {
    id: 1, name: 'Email User', username: 'email.user', email: 'member@example.test',
    email_verified: 0, google_sub: null, role: 'employee', active: 1,
    password_hash: '', must_change_password: 0, token_version: 0, web_access_enabled: 1
  }]
]);
const tokens = new Map();
const otps = new Map();
const sentMessages = [];
const deletedSessions = [];
let nextOtpId = 1;
let now = Date.now();
let profile = { sub: 'google-sub-1', email: 'member@example.test', email_verified: true };

const database = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM email_login_otps t JOIN users u')) {
          const [email, purpose, timestamp] = args;
          const otp = [...otps.values()].reverse().find(row => row.email === email && row.purpose === purpose
            && row.consumed_at === null && row.expires_at > Number(timestamp) && row.attempts < 5);
          const user = otp && users.get(otp.user_id);
          if (!otp || !user) return null;
          return {
            id: otp.id,
            user_id: otp.user_id,
            email: otp.email,
            code_hash: otp.code_hash,
            expires_at: otp.expires_at,
            attempts: otp.attempts,
            account_id: user.id,
            name: user.name,
            username: user.username,
            role: user.role,
            active: user.active,
            current_email: user.email,
            email_verified: user.email_verified,
            must_change_password: user.must_change_password,
            token_version: user.token_version,
            web_access_enabled: user.web_access_enabled
          };
        }
        if (sql.includes('FROM email_auth_tokens t JOIN users u')) {
          const [hash, purpose] = args;
          const token = tokens.get(hash);
          const user = token && users.get(token.user_id);
          if (!token || token.purpose !== purpose || token.consumed_at !== null || !user) return null;
          return {
            token_hash: token.token_hash,
            user_id: token.user_id,
            email: token.email,
            expires_at: token.expires_at,
            active: user.active,
            current_email: user.email,
            email_verified: user.email_verified
          };
        }
        if (sql.includes('FROM users WHERE google_sub = ?')) {
          const user = [...users.values()].find(row => row.google_sub === args[0]);
          return user ? { ...user } : null;
        }
        if (sql.includes('FROM users') && sql.includes('id = ?') && sql.includes('active = 1')
          && sql.includes('email_verified = 0') && sql.includes('lower(trim(email)) = ?')) {
          const user = users.get(Number(args[0]));
          return user && Number(user.active) === 1 && Number(user.email_verified) === 0
            && user.email?.trim().toLowerCase() === args[1]
            ? { id: user.id, email: user.email }
            : null;
        }
        if (sql.includes('FROM users WHERE id = ? AND active = 1')) {
          const user = users.get(Number(args[0]));
          return user && Number(user.active) === 1 ? { id: user.id, email: user.email, email_verified: user.email_verified } : null;
        }
        if (sql.includes('FROM users WHERE lower(trim(email)) = ? AND id <> ?')) {
          const user = [...users.values()].find(row => Number(row.id) !== Number(args[1])
            && row.email?.trim().toLowerCase() === args[0]);
          return user ? { id: user.id } : null;
        }
        if (sql.includes('FROM users WHERE id = ?')) {
          const user = users.get(Number(args[0]));
          return user ? { ...user } : null;
        }
        if (sql.includes('FROM users') && sql.includes('email_verified = 1')) {
          const user = [...users.values()].find(row => row.email?.trim().toLowerCase() === args[0]
            && Number(row.email_verified) === 1 && Number(row.active) === 1);
          return user ? { ...user } : null;
        }
        return null;
      },
      run: async (...args) => {
        if (sql.startsWith('DELETE FROM email_login_otps WHERE user_id = ? AND purpose = ?')) {
          for (const [id, otp] of otps) {
            if (otp.user_id === Number(args[0]) && otp.purpose === args[1]) otps.delete(id);
          }
          return { changes: 1 };
        }
        if (sql.startsWith('INSERT INTO email_login_otps')) {
          const [userId, email, purpose, codeHash, expiresAt] = args;
          const id = nextOtpId++;
          otps.set(id, {
            id, user_id: Number(userId), email, purpose, code_hash: codeHash,
            expires_at: Number(expiresAt), attempts: 0, consumed_at: null
          });
          return { changes: 1, lastInsertRowid: id };
        }
        if (sql.includes('SET attempts = attempts + 1')) {
          const otp = otps.get(Number(args[0]));
          if (otp) otp.attempts += 1;
          return { changes: otp ? 1 : 0 };
        }
        if (sql.includes('UPDATE email_login_otps SET consumed_at')) {
          const [consumedAt, id, expiresAt] = args;
          const otp = otps.get(Number(id));
          if (!otp || otp.consumed_at !== null || otp.expires_at <= Number(expiresAt) || otp.attempts >= 5) return { changes: 0 };
          otp.consumed_at = Number(consumedAt);
          return { changes: 1 };
        }
        if (sql.startsWith('DELETE FROM email_auth_tokens WHERE user_id = ? AND purpose = ?')) {
          for (const [hash, token] of tokens) {
            if (token.user_id === Number(args[0]) && token.purpose === args[1]) tokens.delete(hash);
          }
          return { changes: 1 };
        }
        if (sql.startsWith('DELETE FROM email_auth_tokens WHERE token_hash = ?')) {
          return { changes: tokens.delete(args[0]) ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO email_auth_tokens')) {
          const [hash, userId, purpose, email, expiresAt] = args;
          tokens.set(hash, {
            token_hash: hash, user_id: Number(userId), purpose, email, expires_at: Number(expiresAt), consumed_at: null
          });
          return { changes: 1 };
        }
        if (sql.includes('UPDATE email_auth_tokens SET consumed_at')) {
          const [consumedAt, hash, expiresAt] = args;
          const token = tokens.get(hash);
          if (!token || token.consumed_at !== null || token.expires_at <= Number(expiresAt)) return { changes: 0 };
          token.consumed_at = Number(consumedAt);
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET email = ?, email_verified = 0')) {
          const [email, userId] = args;
          const user = users.get(Number(userId));
          if (!user || Number(user.active) !== 1) return { changes: 0 };
          user.email = email;
          user.email_verified = 0;
          user.google_sub = null;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET email_verified = 1, token_version = token_version + 1')) {
          const [userId, email] = args;
          const user = users.get(Number(userId));
          if (!user || Number(user.active) !== 1 || Number(user.email_verified) !== 0 || user.email !== email) return { changes: 0 };
          user.email_verified = 1;
          user.token_version += 1;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET email_verified = 1')) {
          const [userId, email] = args;
          const user = users.get(Number(userId));
          if (!user || Number(user.active) !== 1 || user.email.toLowerCase() !== email) return { changes: 0 };
          user.email_verified = 1;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET password_hash = ?')) {
          const [passwordHash, userId, email] = args;
          const user = users.get(Number(userId));
          if (!user || Number(user.active) !== 1 || Number(user.email_verified) !== 1
            || user.email.toLowerCase() !== email) return { changes: 0 };
          user.password_hash = passwordHash;
          user.must_change_password = 0;
          user.token_version += 1;
          return { changes: 1 };
        }
        if (sql.includes('UPDATE users SET google_sub = ?')) {
          const [googleSub, userId, email] = args;
          const user = users.get(Number(userId));
          if (!user || user.google_sub || Number(user.email_verified) !== 1 || user.email.toLowerCase() !== email) {
            return { changes: 0 };
          }
          user.google_sub = googleSub;
          return { changes: 1 };
        }
        if (sql.includes('DELETE FROM web_sessions WHERE user_id = ?')) {
          deletedSessions.push(Number(args[0]));
          return { changes: 1 };
        }
        return { changes: 0 };
      }
    };
  }
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: database
};
const { createIdentityAuthRouter } = require('../routes/identity-auth');
const routerFactory = createIdentityAuthRouter({
  database,
  mailer: {
    isConfigured: () => true,
    async send(message) { sentMessages.push(message); return { accepted: true, previewed: false }; }
  },
  environment: {
    APP_BASE_URL: 'https://taskflow.example.test',
    SESSION_SECRET: 'identity-auth-test-session-secret-with-more-than-32-characters',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_REDIRECT_URI: 'https://taskflow.example.test/api/auth/google/callback'
  },
  fetcher: async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('code_verifier')?.length, 43);
      return { ok: true, async json() { return { access_token: 'google-access-token' }; } };
    }
    assert.equal(options.headers.Authorization, 'Bearer google-access-token');
    return { ok: true, async json() { return { ...profile }; } };
  },
  now: () => now
});

const app = express();
app.use(express.json());
app.use(session({
  name: 'taskflow.identity-test',
  secret: 'identity-test-session-secret-32-characters',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));
app.post('/test-session', (req, res) => {
  req.session.userId = 1;
  req.session.role = 'employee';
  req.session.tokenVersion = users.get(1).token_version;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api/auth', routerFactory.router);
let server;
let baseUrl;

before(async () => {
  users.get(1).password_hash = await bcrypt.hash('initial-password-123', 4);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (originalDbModule) require.cache[dbPath] = originalDbModule;
  else delete require.cache[dbPath];
  if (originalAuditModule) require.cache[auditPath] = originalAuditModule;
  else delete require.cache[auditPath];
  delete require.cache[require.resolve('../routes/identity-auth')];
});

async function request(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}/api/auth${path}`, {
    method,
    headers,
    redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function tokenFrom(message) {
  const urlText = message.text.split('\n').find(line => line.startsWith('https://'));
  assert.ok(urlText);
  return new URLSearchParams(new URL(urlText).hash.slice(1)).get('token');
}

test('email verification uses a single-use hashed token and enables email login', async () => {
  const result = await routerFactory.sendVerificationEmail({ companyCode: 'acme' }, users.get(1));
  assert.equal(result.sent, true);
  assert.match(sentMessages.at(-1).text, /verify-email\.html#token=/);
  assert.match(sentMessages.at(-1).text, /company_code=acme/);

  const token = tokenFrom(sentMessages.at(-1));
  const verified = await request('/email/verify', { method: 'POST', body: { token } });
  assert.equal(verified.status, 200, await verified.clone().text());
  assert.deepEqual(await verified.json(), { verified: true });
  assert.equal(users.get(1).email_verified, 1);
  assert.equal(verified.headers.get('cache-control'), 'no-store');
  assert.equal(verified.headers.get('referrer-policy'), 'no-referrer');

  const replay = await request('/email/verify', { method: 'POST', body: { token } });
  assert.equal(replay.status, 400);
});

test('email OTP sign-in sends a generic response and consumes each code once', async () => {
  const requested = await request('/email/login/request', {
    method: 'POST',
    body: { email: 'MEMBER@example.test' }
  });
  assert.equal(requested.status, 202);
  const genericMessage = await requested.json();
  assert.match(sentMessages.at(-1).text, /sign-in code is \d{6}/);
  const code = sentMessages.at(-1).text.match(/sign-in code is (\d{6})/)[1];

  const unknown = await request('/email/login/request', {
    method: 'POST',
    body: { email: 'unknown@example.test' }
  });
  assert.equal(unknown.status, 202);
  assert.deepEqual(await unknown.json(), genericMessage);

  const verified = await request('/email/login/verify', {
    method: 'POST',
    body: { email: 'member@example.test', code }
  });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).id, 1);
  assert.ok(verified.headers.get('set-cookie'));

  const replay = await request('/email/login/verify', {
    method: 'POST',
    body: { email: 'member@example.test', code }
  });
  assert.equal(replay.status, 400);
});

test('password reset responses avoid account enumeration and reset only with a valid single-use token', async () => {
  const requested = await request('/password-reset/request', {
    method: 'POST',
    body: { email: 'MEMBER@example.test' }
  });
  assert.equal(requested.status, 202);
  const genericMessage = await requested.json();
  assert.match(genericMessage.message, /If a verified account matches/);
  assert.match(sentMessages.at(-1).text, /password-reset\.html#token=/);

  const unknown = await request('/password-reset/request', {
    method: 'POST',
    body: { email: 'unknown@example.test' }
  });
  assert.equal(unknown.status, 202);
  assert.deepEqual(await unknown.json(), genericMessage);

  const token = tokenFrom(sentMessages.at(-1));
  const reset = await request('/password-reset/complete', {
    method: 'POST',
    body: { token, password: 'replacement-password-456' }
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { reset: true });
  assert.equal(await bcrypt.compare('replacement-password-456', users.get(1).password_hash), true);
  assert.equal(users.get(1).token_version, 1);
  assert.deepEqual(deletedSessions, [1]);

  const replay = await request('/password-reset/complete', {
    method: 'POST',
    body: { token, password: 'another-password-12345' }
  });
  assert.equal(replay.status, 400);
});

test('password reset token expires and invalid credentials cannot change the account', async () => {
  await request('/password-reset/request', {
    method: 'POST',
    body: { email: 'member@example.test' }
  });
  const token = tokenFrom(sentMessages.at(-1));
  now += 60 * 60 * 1000 + 1;
  const expired = await request('/password-reset/complete', {
    method: 'POST',
    body: { token, password: 'expired-link-password' }
  });
  assert.equal(expired.status, 400);
  assert.equal(await bcrypt.compare('replacement-password-456', users.get(1).password_hash), true);
});

test('Google OAuth uses PKCE and links only an existing verified email account', async () => {
  now += 1;
  const start = await request('/google/start');
  assert.equal(start.status, 302);
  const authorizationUrl = new URL(start.headers.get('location'));
  assert.equal(authorizationUrl.origin, 'https://accounts.google.com');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  const cookie = start.headers.get('set-cookie').split(';', 1)[0];
  const state = authorizationUrl.searchParams.get('state');
  const callback = await request(`/google/callback?code=oauth-code&state=${encodeURIComponent(state)}`, { cookie });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/app');
  assert.equal(users.get(1).google_sub, 'google-sub-1');

  profile = { sub: 'unmatched-sub', email: 'unmatched@example.test', email_verified: true };
  const secondStart = await request('/google/start');
  const secondUrl = new URL(secondStart.headers.get('location'));
  const secondCookie = secondStart.headers.get('set-cookie').split(';', 1)[0];
  const unavailable = await request(`/google/callback?code=oauth-code&state=${encodeURIComponent(secondUrl.searchParams.get('state'))}`, {
    cookie: secondCookie
  });
  assert.equal(unavailable.status, 303);
  assert.match(unavailable.headers.get('location'), /google_account_unavailable/);
});

test('existing users can enroll and verify a new email with a one-time code', async () => {
  const snapshot = { ...users.get(1) };
  try {
    Object.assign(users.get(1), { email: null, email_verified: 0, google_sub: null, token_version: 0 });
    const sessionResponse = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
    const cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
    const requested = await request('/email/enroll', {
      method: 'POST',
      cookie,
      body: { email: 'new.address@example.test' }
    });
    assert.equal(requested.status, 200, await requested.clone().text());
    assert.equal(users.get(1).email, 'new.address@example.test');
    assert.equal(users.get(1).email_verified, 0);
    assert.match(sentMessages.at(-1).text, /verification code is \d{6}/);
    const code = sentMessages.at(-1).text.match(/verification code is (\d{6})/)[1];
    assert.equal([...otps.values()].find(otp => otp.purpose === 'enrollment').code_hash,
      crypto.createHmac('sha256', 'identity-auth-test-session-secret-with-more-than-32-characters').update(code).digest('hex'));

    const verified = await request('/email/enroll/verify', {
      method: 'POST',
      cookie,
      body: { email: 'new.address@example.test', code }
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.deepEqual(await verified.json(), { verified: true });
    assert.equal(users.get(1).email, 'new.address@example.test');
    assert.equal(users.get(1).email_verified, 1);
    assert.ok(verified.headers.get('set-cookie'));
  } finally {
    Object.assign(users.get(1), snapshot);
    otps.clear();
  }
});
