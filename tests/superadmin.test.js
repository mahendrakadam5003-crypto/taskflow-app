'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { COOKIE_NAME, createSuperAdminRouter } = require('../routes/superadmin');
const { migrateControlDatabase } = require('../control-db');
const { createInitialSuperAdmin } = require('../scripts/create-superadmin');

const bootstrapEnvironment = {
  SUPERADMIN_NAME: 'First Owner',
  SUPERADMIN_USERNAME: ' FIRST OWNER ',
  SUPERADMIN_PASSWORD: 'First-Superadmin-Password-2026!'
};

test('super-admin bootstrap creates one bcrypt-protected initial account and refuses a second', async () => {
  let storedAdmin = null;
  let rolledBack = false;
  const controlDb = {
    async transaction() {
      return {
        async execute(statement) {
          if (typeof statement === 'string' && statement.startsWith('SELECT COUNT')) {
            return { rows: [{ count: storedAdmin ? 1 : 0 }] };
          }
          assert.equal(statement.sql, 'INSERT INTO super_admins (name, username, password_hash) VALUES (?, ?, ?)');
          storedAdmin = { name: statement.args[0], username: statement.args[1], password_hash: statement.args[2] };
          return { rows: [] };
        },
        async commit() {},
        async rollback() { rolledBack = true; }
      };
    }
  };
  await createInitialSuperAdmin(bootstrapEnvironment, async () => controlDb);
  assert.equal(storedAdmin.name, 'First Owner');
  assert.equal(storedAdmin.username, 'first owner');
  assert.notEqual(storedAdmin.password_hash, bootstrapEnvironment.SUPERADMIN_PASSWORD);
  assert.equal(await bcrypt.compare(bootstrapEnvironment.SUPERADMIN_PASSWORD, storedAdmin.password_hash), true);
  await assert.rejects(
    createInitialSuperAdmin(bootstrapEnvironment, async () => controlDb),
    /already exists/
  );
  assert.equal(rolledBack, true);
});

test('super-admin bootstrap rejects weak or missing password before database access', async () => {
  let opened = false;
  await assert.rejects(
    createInitialSuperAdmin({ ...bootstrapEnvironment, SUPERADMIN_PASSWORD: 'short' }, async () => {
      opened = true;
      throw new Error('Database should not be opened');
    }),
    /between 10 and 72 UTF-8 bytes/
  );
  assert.equal(opened, false);
});

async function createApp() {
  const controlDb = createClient({ url: 'file::memory:' });
  await migrateControlDatabase(controlDb);
  const passwordHash = await bcrypt.hash('Superadmin-Test-Password-2026!', 4);
  await controlDb.execute({
    sql: 'INSERT INTO super_admins (name, username, password_hash) VALUES (?, ?, ?)',
    args: ['Test Owner', 'test owner', passwordHash]
  });
  const company = await controlDb.execute({
    sql: `INSERT INTO companies (code, name, status, plan_id, tenant_db_url, tenant_db_token_encrypted)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['test-company', 'Test Company', 'active', 2, 'libsql://tenant.example', 'encrypted-token']
  });
  await controlDb.execute({
    sql: 'INSERT INTO usage_snapshots (company_id, user_count, db_bytes, files_bytes) VALUES (?, ?, ?, ?)',
    args: [Number(company.lastInsertRowid), 7, 4096, 2048]
  });

  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', createSuperAdminRouter({
    getDatabase: async () => controlDb,
    secureCookies: false
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Unexpected test error.' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    controlDb,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/superadmin`
  };
}

test('super-admin login uses an isolated hashed session and protects the read-only overview', async () => {
  const { controlDb, server, baseUrl } = await createApp();
  try {
    const unauthorized = await fetch(`${baseUrl}/overview`);
    assert.equal(unauthorized.status, 401);

    const invalidLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'wrong-password' })
    });
    assert.equal(invalidLogin.status, 401);
    assert.deepEqual(await invalidLogin.json(), { error: 'Username or password is incorrect.' });

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'TEST OWNER', password: 'Superadmin-Test-Password-2026!' })
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), {
      authenticated: true,
      admin: { name: 'Test Owner', username: 'test owner' }
    });
    const cookieHeader = login.headers.get('set-cookie');
    assert.match(cookieHeader, new RegExp(`${COOKIE_NAME}=([A-Za-z0-9_-]{43})`));
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /SameSite=Strict/i);
    assert.ok(cookieHeader.includes('Path=/api/superadmin'));
    const token = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([A-Za-z0-9_-]{43})`))[1];
    assert.doesNotMatch(JSON.stringify((await controlDb.execute('SELECT sid_hash FROM super_admin_sessions')).rows), new RegExp(token));

    const session = await fetch(`${baseUrl}/session`, { headers: { Cookie: cookieHeader.split(';')[0] } });
    assert.equal(session.status, 200);
    assert.deepEqual((await session.json()).admin, { id: 1, name: 'Test Owner', username: 'test owner' });

    const overview = await fetch(`${baseUrl}/overview`, { headers: { Cookie: cookieHeader.split(';')[0] } });
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.deepEqual(data.summary, {
      companyCount: 1,
      trialCount: 0,
      activeCount: 1,
      suspendedCount: 0,
      totalUsers: 7,
      totalStorageBytes: 6144
    });
    assert.equal(data.companies[0].name, 'Test Company');
    assert.equal(data.companies[0].planName, 'Team');
    assert.equal(data.companies[0].userCount, 7);

    await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { Cookie: cookieHeader.split(';')[0] }
    });
    const afterLogout = await fetch(`${baseUrl}/overview`, { headers: { Cookie: cookieHeader.split(';')[0] } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('super-admin login rejects missing fields without establishing a session', async () => {
  const { controlDb, server, baseUrl } = await createApp();
  try {
    const response = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '', password: '' })
    });
    assert.equal(response.status, 400);
    assert.equal(Number((await controlDb.execute('SELECT COUNT(*) AS count FROM super_admin_sessions')).rows[0].count), 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});
