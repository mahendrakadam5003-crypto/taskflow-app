'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const session = require('express-session');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { COOKIE_NAME, SUPPORT_MODE_DURATION_MS, createSuperAdminPageHandler, createSuperAdminRouter } = require('../routes/superadmin');
const { migrateControlDatabase } = require('../control-db');
const { bootstrapConfiguredSuperAdmin, createInitialSuperAdmin } = require('../scripts/create-superadmin');

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
    createInitialSuperAdmin({ ...bootstrapEnvironment, SUPERADMIN_PASSWORD: '123456789012345' }, async () => {
      opened = true;
      throw new Error('Database should not be opened');
    }),
    /at least 16 characters and no more than 72 UTF-8 bytes/
  );
  assert.equal(opened, false);
});

test('super-admin plans and pricing page explains the entitlement and price split', async () => {
  const page = await fs.readFile(path.join(__dirname, '..', 'public', 'superadmin.html'), 'utf8');
  assert.match(page, /Plans = what a company can use \(limits \+ features\)/);
  assert.match(page, /Plan assignments control company limits and feature access; they do not set the subscription price\./);
  assert.match(page, /Pricing = what a company pays/);
  assert.match(page, /Per-seat rates, billing cycle, tax, and trial settings determine what a company is charged\./);
  assert.match(page, /Landing-page highlights are edited in these pricing tiers and must match the feature checkboxes on the plan you assign: Attendance, Reimbursements, and Data export\./);
});

test('super-admin sections use accessible hash-addressable tabs and keep requests and activity separate', async () => {
  const page = await fs.readFile(path.join(__dirname, '..', 'public', 'superadmin.html'), 'utf8');
  assert.match(page, /<nav class="control-nav" role="tablist"/);
  for (const name of ['overview', 'companies', 'requests', 'plans', 'billing', 'activity']) {
    assert.match(page, new RegExp(`id="admin-tab-${name}"[^>]*role="tab"`));
    assert.match(page, new RegExp(`id="${name === 'overview' ? 'control-overview-page' : `${name}-page`}"[^>]*role="tabpanel"`));
  }
  assert.match(page, /data-admin-page="overview">Overview</);
  assert.match(page, /data-admin-page="companies">Companies</);
  assert.match(page, /data-admin-page="requests">Requests/);
  assert.match(page, /data-admin-page="plans">Plans &amp; Pricing</);
  assert.match(page, /data-admin-page="billing">Billing</);
  assert.match(page, /data-admin-page="activity">Activity/);
  assert.match(page, /id="requests-page"[\s\S]*?id="demo-request-inbox"/);
  assert.match(page, /id="activity-page"[\s\S]*?id="user-error-inbox"/);
  const script = await fs.readFile(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  assert.match(script, /window\.history\.pushState\(null, '', `#\$\{page\}`\)/);
  assert.match(script, /event\.key === 'ArrowRight'/);
  assert.match(script, /window\.addEventListener\('hashchange'/);
});

test('super-admin billing tab exposes cross-company invoices and pending billing actions', async () => {
  const page = await fs.readFile(path.join(__dirname, '..', 'public', 'superadmin.html'), 'utf8');
  assert.match(page, /id="invoice-status-filter"/);
  assert.match(page, /<option value="overdue">Overdue<\/option>/);
  assert.match(page, /id="invoice-rows"/);
  assert.match(page, /id="invoice-prev"/);
  assert.match(page, /id="invoice-next"/);
  assert.match(page, /id="cross-company-billing-requests"/);
  const script = await fs.readFile(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  assert.match(script, /request\(`invoices\?\$\{query\}`\)/);
  assert.match(script, /request\('billing-requests'\)/);
  assert.match(script, /companies\/\$\{encodeURIComponent\(button\.dataset\.companyId\)\}\/invoices\/\$\{encodeURIComponent\(button\.dataset\.crossInvoicePaid\)\}\/paid/);
  assert.match(script, /companies\/\$\{encodeURIComponent\(companyId\)\}\/billing-requests\/\$\{encodeURIComponent\(requestId\)\}\/\$\{action\}/);
});

test('super-admin overview displays the requested company, revenue, invoice, and demo KPIs', async () => {
  const script = await fs.readFile(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  assert.match(script, /label: 'Active companies'/);
  assert.match(script, /label: 'Trials'/);
  assert.match(script, /label: 'Suspended'/);
  assert.match(script, /label: 'Estimated MRR'.*tax excluded/s);
  assert.match(script, /label: 'Trials ending soon'.*next 7 days/s);
  assert.match(script, /label: 'Open invoices'/);
  assert.match(script, /label: 'Overdue invoices'/);
  assert.match(script, /label: 'New demo requests'/);
  assert.match(script, /formatCurrencyAmounts/);
});

test('super-admin companies table supports attention filters, seat limits, billing details, and sorting', async () => {
  const page = await fs.readFile(path.join(__dirname, '..', 'public', 'superadmin.html'), 'utf8');
  assert.match(page, /data-company-quick-filter="attention"/);
  assert.match(page, /<option value="past_due">Past due<\/option>/);
  assert.match(page, /data-company-sort="name"/);
  assert.match(page, /data-company-sort="status"/);
  assert.match(page, /data-company-sort="seats"/);
  assert.match(page, /data-company-sort="trialEnd"/);
  assert.match(page, /data-company-sort="lastLogin"/);
  assert.match(page, /<th scope="col">Billing cycle<\/th><th scope="col">Renews on<\/th>/);
  const script = await fs.readFile(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  assert.match(script, /company\.userCount >= company\.maxUsers/);
  assert.match(script, /usedBytes > limitBytes \* 0\.9/);
  assert.match(script, /percentage >= 100 \? 'danger' : percentage >= 90 \? 'warning'/);
  assert.match(script, /function compareCompanyValues/);
});

test('super-admin demo requests use live pricing tiers and keep pricing separate from trial entitlements', async () => {
  const page = await fs.readFile(path.join(__dirname, '..', 'public', 'superadmin.html'), 'utf8');
  assert.match(page, /id="company-pricing-suggestion"/);
  const script = await fs.readFile(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  assert.match(script, /teamSize <= 10 \? 'team' : 'enterprise'/);
  assert.match(script, /livePricing\.tiers\.find/);
  assert.match(script, /Estimated monthly total at/);
  assert.match(script, /The Trial entitlement remains selected; pricing and feature access are separate\./);
  assert.match(script, /Live pricing estimate unavailable/);
});

test('startup bootstrap creates and can privately reset only the configured super-admin', async () => {
  let storedAdmin = null;
  const auditEntries = [];
  const controlDb = {
    async transaction() {
      return {
        async execute(statement) {
          if (statement === 'SELECT COUNT(*) AS count FROM super_admins') {
            return { rows: [{ count: storedAdmin ? 1 : 0 }] };
          }
          if (statement.sql.startsWith('SELECT id, password_hash')) {
            return { rows: storedAdmin && storedAdmin.username === statement.args[0] ? [{
              id: storedAdmin.id,
              password_hash: storedAdmin.password_hash
            }] : [] };
          }
          if (statement.sql.startsWith('INSERT INTO super_admins')) {
            storedAdmin = {
              id: 1,
              name: statement.args[0],
              username: statement.args[1],
              password_hash: statement.args[2],
              token_version: 0
            };
          } else if (statement.sql.startsWith('UPDATE super_admins')) {
            storedAdmin.name = statement.args[0];
            storedAdmin.password_hash = statement.args[1];
            storedAdmin.token_version += 1;
          } else if (statement.sql.startsWith('INSERT INTO super_admin_audit')) {
            auditEntries.push(statement.args);
          } else {
            assert.fail(`Unexpected SQL in bootstrap test: ${statement.sql}`);
          }
          return { rows: [] };
        },
        async commit() {},
        async rollback() {}
      };
    }
  };
  let databaseOpenCount = 0;
  const getDatabase = async () => {
    databaseOpenCount += 1;
    return controlDb;
  };

  assert.equal(await bootstrapConfiguredSuperAdmin(bootstrapEnvironment, getDatabase), 'created');
  const initialHash = storedAdmin.password_hash;
  assert.equal(storedAdmin.username, 'first owner');
  assert.equal(await bcrypt.compare(bootstrapEnvironment.SUPERADMIN_PASSWORD, initialHash), true);
  assert.equal(await bootstrapConfiguredSuperAdmin(bootstrapEnvironment, getDatabase), 'unchanged');
  assert.equal(storedAdmin.password_hash, initialHash);

  const updatedEnvironment = {
    ...bootstrapEnvironment,
    SUPERADMIN_PASSWORD: 'A-New-Private-Password-2026!'
  };
  assert.equal(await bootstrapConfiguredSuperAdmin(updatedEnvironment, getDatabase), 'updated');
  assert.notEqual(storedAdmin.password_hash, initialHash);
  assert.equal(await bcrypt.compare(updatedEnvironment.SUPERADMIN_PASSWORD, storedAdmin.password_hash), true);
  assert.equal(await bcrypt.compare(bootstrapEnvironment.SUPERADMIN_PASSWORD, storedAdmin.password_hash), false);
  assert.equal(storedAdmin.token_version, 1);
  assert.equal(auditEntries.length, 2);
  assert.equal(databaseOpenCount, 3);
});

test('startup bootstrap does not require control database unless credentials are configured', async () => {
  let opened = false;
  assert.equal(await bootstrapConfiguredSuperAdmin({}, async () => {
    opened = true;
    throw new Error('Database should not be opened');
  }), false);
  await assert.rejects(
    bootstrapConfiguredSuperAdmin({ SUPERADMIN_USERNAME: 'super admin' }, async () => {
      opened = true;
      throw new Error('Database should not be opened');
    }),
    /Both SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD/
  );
  assert.equal(opened, false);
});

test('startup bootstrap refuses to overwrite a different super-admin username', async () => {
  let insertAttempted = false;
  let rolledBack = false;
  const controlDb = {
    async transaction() {
      return {
        async execute(statement) {
          if (statement.sql?.startsWith('SELECT id, password_hash')) return { rows: [] };
          if (statement === 'SELECT COUNT(*) AS count FROM super_admins') return { rows: [{ count: 1 }] };
          if (statement.sql?.startsWith('INSERT INTO super_admins')) insertAttempted = true;
          return { rows: [] };
        },
        async commit() {},
        async rollback() { rolledBack = true; }
      };
    }
  };
  await assert.rejects(
    bootstrapConfiguredSuperAdmin(bootstrapEnvironment, async () => controlDb),
    /different super-admin username already exists/
  );
  assert.equal(insertAttempted, false);
  assert.equal(rolledBack, true);
});

async function createApp({ provisionCompany, tenantDatabase, backupDirectory, backupManager } = {}) {
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
  app.use(session({
    name: 'taskflow.sid.v2',
    secret: 'superadmin-test-session-secret-at-least-32-chars',
    resave: false,
    saveUninitialized: false
  }));
  app.use('/api/superadmin', createSuperAdminRouter({
    getDatabase: async () => controlDb,
    secureCookies: false,
    provisionCompany,
    tenantDatabase,
    backupDirectory,
    backupManager
  }));
  app.get(['/superadmin', '/superadmin.html'], createSuperAdminPageHandler(path.join(__dirname, '..', 'public', 'superadmin.html')));
  app.get('/support-state', (req, res) => res.json({
    userId: req.session.userId,
    role: req.session.role,
    companyId: req.session.companyId,
    expiresAt: req.session.supportModeExpiresAt,
    maxAge: req.session.cookie.maxAge
  }));
  app.get('/create-company-session', (req, res) => {
    req.session.userId = 88;
    req.session.role = 'admin';
    req.session.save(error => error ? res.sendStatus(500) : res.json({ ok: true }));
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    controlDb,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/superadmin`,
    origin: `http://127.0.0.1:${server.address().port}`
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

    await controlDb.execute({
      sql: `INSERT INTO subscriptions (
        company_id, billing_cycle, seats, unit_price_paise, status, current_period_start, current_period_end
      ) VALUES (1, 'monthly', 3, 19900, 'active', '2026-10-01', '2026-11-01')`,
      args: []
    });
    await controlDb.execute({
      sql: `INSERT INTO subscriptions (
        company_id, billing_cycle, seats, unit_price_paise, status, current_period_start, current_period_end
      ) VALUES (1, 'yearly', 2, 12000, 'active', '2026-10-01', '2027-10-01')`,
      args: []
    });
    const trialEndsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await controlDb.execute({
      sql: `INSERT INTO companies (code, name, status, plan_id, trial_ends_at, tenant_db_url, tenant_db_token_encrypted, created_at)
        VALUES (?, ?, 'trial', 2, ?, ?, ?, '2000-01-01')`,
      args: ['trial-company', 'Trial Company', trialEndsAt, 'libsql://trial.example', 'encrypted-token']
    });
    await controlDb.execute({
      sql: `INSERT INTO invoices (
        company_id, number, period_start, period_end, seats, unit_price_paise, subtotal_paise,
        discount_paise, tax_paise, total_paise, currency, tax_pct, status, due_at
      ) VALUES (1, ?, '2026-10-01', '2026-11-01', 1, 10000, 10000, 0, 1800, 11800, 'INR', 18, 'open', ?)`,
      args: ['INV-OVERDUE-1', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
    });
    await controlDb.execute({
      sql: `INSERT INTO invoices (
        company_id, number, period_start, period_end, seats, unit_price_paise, subtotal_paise,
        discount_paise, tax_paise, total_paise, currency, tax_pct, status, due_at
      ) VALUES (1, ?, '2026-10-01', '2026-11-01', 1, 5000, 5000, 0, 0, 5000, 'USD', 0, 'open', ?)`,
      args: ['INV-OPEN-1', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()]
    });
    await controlDb.execute({
      sql: `INSERT INTO demo_requests (name, email, company_name, status, consented_at)
        VALUES ('Request Owner', 'request@example.test', 'Request Co', 'new', datetime('now'))`
    });
    const overview = await fetch(`${baseUrl}/overview`, { headers: { Cookie: cookieHeader.split(';')[0] } });
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.deepEqual(data.summary, {
      companyCount: 2,
      trialCount: 1,
      activeCount: 1,
      activePaidCount: 1,
      trialEndingSoonCount: 0,
      trialsEndingIn7DaysCount: 1,
      suspendedCount: 0,
      cancelledCount: 0,
      paidSeats: 5,
      monthlyRecurringRevenuePaise: 61700,
      annualRecurringRevenuePaise: 740400,
      openInvoiceCount: 1,
      openInvoiceAmountsPaise: { USD: 5000 },
      overdueInvoiceCount: 1,
      overdueInvoiceAmountsPaise: { INR: 11800 },
      newDemoRequestCount: 1,
      totalUsers: 7,
      totalStorageBytes: 6144,
      allocatedStorageBytes: 21474836480
    });
    assert.equal(data.companies[0].name, 'Test Company');
    assert.equal(data.companies[0].planName, 'Team');
    assert.equal(data.companies[0].userCount, 7);
    assert.equal(data.companies[0].planId, 2);
    assert.equal(data.companies[0].billingCycle, 'yearly');
    assert.equal(data.companies[0].subscriptionStatus, 'active');
    assert.equal(data.companies[0].renewsAt, '2027-10-01');
    assert.deepEqual(data.plans.map(plan => plan.name), ['Solo', 'Team', 'Business', 'Internal / Unlimited', 'Trial']);

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

test('super-admin cross-company billing APIs authenticate, paginate, filter overdue invoices, and list pending requests', async () => {
  const { controlDb, server, baseUrl } = await createApp();
  try {
    assert.equal((await fetch(`${baseUrl}/invoices`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/billing-requests`)).status, 401);
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0] };
    const insertInvoice = async ({ number, status, dueAt, paidAt = null }) => controlDb.execute({
      sql: `INSERT INTO invoices (
        company_id, number, period_start, period_end, seats, unit_price_paise, subtotal_paise,
        discount_paise, tax_paise, total_paise, currency, tax_pct, status, due_at, paid_at
      ) VALUES (1, ?, '2026-10-01', '2026-11-01', 1, 10000, 10000, 0, 1800, 11800, 'INR', 18, ?, ?, ?)`,
      args: [number, status, dueAt, paidAt]
    });
    await insertInvoice({
      number: 'INV-OVERDUE',
      status: 'open',
      dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    });
    await insertInvoice({
      number: 'INV-OPEN',
      status: 'open',
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    await insertInvoice({
      number: 'INV-PAID',
      status: 'paid',
      dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      paidAt: new Date().toISOString()
    });

    const firstPageResponse = await fetch(`${baseUrl}/invoices?status=all&page=1&pageSize=2`, { headers });
    assert.equal(firstPageResponse.status, 200, await firstPageResponse.clone().text());
    assert.equal(firstPageResponse.headers.get('cache-control'), 'no-store');
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPage.totalCount, 3);
    assert.equal(firstPage.pageCount, 2);
    assert.equal(firstPage.invoices.length, 2);
    assert.deepEqual(firstPage.invoices.map(invoice => invoice.number), ['INV-PAID', 'INV-OPEN']);
    assert.deepEqual(Object.keys(firstPage.invoices[0]).sort(), [
      'companyCode', 'companyId', 'companyName', 'createdAt', 'currency', 'discountPaise',
      'dueAt', 'id', 'number', 'paidAt', 'periodEnd', 'periodStart', 'seats', 'status',
      'subtotalPaise', 'taxPaise', 'taxPct', 'totalPaise', 'unitPricePaise'
    ]);
    const secondPage = await (await fetch(`${baseUrl}/invoices?status=all&page=2&pageSize=2`, { headers })).json();
    assert.equal(secondPage.page, 2);
    assert.deepEqual(secondPage.invoices.map(invoice => invoice.number), ['INV-OVERDUE']);

    const overdueResponse = await fetch(`${baseUrl}/invoices?status=overdue`, { headers });
    assert.equal(overdueResponse.status, 200);
    const overdue = await overdueResponse.json();
    assert.equal(overdue.totalCount, 1);
    assert.equal(overdue.invoices[0].number, 'INV-OVERDUE');
    assert.equal(overdue.invoices[0].status, 'overdue');
    const open = await (await fetch(`${baseUrl}/invoices?status=open`, { headers })).json();
    assert.deepEqual(open.invoices.map(invoice => invoice.number), ['INV-OPEN']);
    const paid = await (await fetch(`${baseUrl}/invoices?status=paid`, { headers })).json();
    assert.deepEqual(paid.invoices.map(invoice => invoice.number), ['INV-PAID']);
    assert.equal((await fetch(`${baseUrl}/invoices?status=unknown`, { headers })).status, 400);
    assert.equal((await fetch(`${baseUrl}/invoices?status=open&status=paid`, { headers })).status, 400);
    assert.equal((await fetch(`${baseUrl}/invoices?page=1&pageSize=101`, { headers })).status, 400);

    await controlDb.execute({
      sql: `INSERT INTO subscription_change_requests
        (company_id, requested_by_user_id, requested_seats, requested_billing_cycle)
        VALUES (1, 7, 12, 'yearly')`
    });
    await controlDb.execute({
      sql: `INSERT INTO subscription_change_requests
        (company_id, requested_by_user_id, requested_seats, requested_billing_cycle, status)
        VALUES (1, 7, 8, 'monthly', 'rejected')`
    });
    const pendingResponse = await fetch(`${baseUrl}/billing-requests`, { headers });
    assert.equal(pendingResponse.status, 200, await pendingResponse.clone().text());
    const pending = await pendingResponse.json();
    assert.equal(pending.requests.length, 1);
    assert.deepEqual(pending.requests[0], {
      id: Number(pending.requests[0].id),
      companyId: 1,
      companyName: 'Test Company',
      companyCode: 'test-company',
      seats: 12,
      billingCycle: 'yearly',
      createdAt: pending.requests[0].createdAt
    });
    const unchangedRequest = await controlDb.execute({
      sql: 'SELECT status FROM subscription_change_requests WHERE id = ?',
      args: [pending.requests[0].id]
    });
    assert.equal(unchangedRequest.rows[0].status, 'pending');

    const markPaid = await fetch(`${baseUrl}/companies/1/invoices/${overdue.invoices[0].id}/paid`, {
      method: 'POST', headers
    });
    assert.equal(markPaid.status, 200, await markPaid.clone().text());
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('super-admin can update company status and plan without changing tenant credentials', async () => {
  const tenantDatabase = {
    runWithTenant(companyId, callback) {
      assert.equal(companyId, 1);
      return callback();
    },
    prepare(sql) {
      return {
        async get() {
          if (sql.includes('COUNT(*) AS count FROM users WHERE active = 1')) return { count: 7 };
          if (sql.includes('PRAGMA page_count')) return { page_count: 1 };
          if (sql.includes('PRAGMA page_size')) return { page_size: 4096 };
          if (sql.includes('SUM(bytes)')) return { bytes: 2048 };
          return null;
        }
      };
    }
  };
  const { controlDb, server, baseUrl } = await createApp({ tenantDatabase });
  try {
    const unauthorized = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', planId: 3 })
    });
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const invalidStatus = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'deleted', planId: 1 })
    });
    assert.equal(invalidStatus.status, 400);

    const invalidPlan = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', planId: 999 })
    });
    assert.equal(invalidPlan.status, 400);

    const deletedCompany = await controlDb.execute({
      sql: `INSERT INTO companies (code, name, status, plan_id, tenant_db_url, tenant_db_token_encrypted)
        VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['deleted-company', 'Deleted Company', 'deleted', 2, 'libsql://deleted.example', 'unchanged-token']
    });
    const deletedCompanyId = Number(deletedCompany.lastInsertRowid);
    const deletedUpdate = await fetch(`${baseUrl}/companies/${deletedCompanyId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', planId: 1 })
    });
    assert.equal(deletedUpdate.status, 404);

    const belowPlanSeats = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', planId: 1 })
    });
    assert.equal(belowPlanSeats.status, 409);
    assert.match((await belowPlanSeats.json()).error, /1-user limit is below the 7 active users/);

    const belowUsers = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', planId: 2, maxUsersOverride: 6 })
    });
    assert.equal(belowUsers.status, 409);
    assert.match((await belowUsers.json()).error, /7 active users/);

    const belowStorage = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', planId: 2, storageLimitMbOverride: 0 })
    });
    assert.equal(belowStorage.status, 409);
    assert.match((await belowStorage.json()).error, /bytes currently used/);

    const update = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', planId: 3, maxUsersOverride: 8, storageLimitMbOverride: 20 })
    });
    assert.equal(update.status, 200, await update.clone().text());
    assert.deepEqual(await update.json(), {
      companyId: 1,
      status: 'suspended',
      planId: 3,
      maxUsersOverride: 8,
      storageLimitMbOverride: 20,
      notes: ''
    });

    const company = await controlDb.execute({
      sql: 'SELECT status, plan_id, tenant_db_url, tenant_db_token_encrypted FROM companies WHERE id = ?',
      args: [1]
    });
    assert.deepEqual(company.rows[0], {
      status: 'suspended',
      plan_id: 3,
      tenant_db_url: 'libsql://tenant.example',
      tenant_db_token_encrypted: 'encrypted-token'
    });
    const audit = await controlDb.execute({
      sql: 'SELECT action, details FROM super_admin_audit WHERE company_id = ?',
      args: [1]
    });
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'Company configuration updated');
    assert.match(audit.rows[0].details, /status active -> suspended/);
    assert.match(audit.rows[0].details, /user limit override plan default -> 8/);
    assert.match(audit.rows[0].details, /storage limit override plan default MB -> 20/);
    assert.match(audit.rows[0].details, /plan Team -> Business/);

    const noOpUpdate = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', planId: 3 })
    });
    assert.equal(noOpUpdate.status, 200);
    const auditAfterNoOp = await controlDb.execute({
      sql: 'SELECT COUNT(*) AS count FROM super_admin_audit WHERE company_id = ?',
      args: [1]
    });
    assert.equal(Number(auditAfterNoOp.rows[0].count), 1);

    const overview = await fetch(`${baseUrl}/overview`, { headers: { Cookie: cookie } });
    const overviewData = await overview.json();
    assert.equal(overviewData.summary.suspendedCount, 1);
    assert.equal(overviewData.companies[0].status, 'suspended');
    assert.equal(overviewData.companies[0].planName, 'Business');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('cancelling a company retains its data and does not schedule automatic deletion', async () => {
  const { controlDb, server, baseUrl } = await createApp();
  try {
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0], 'Content-Type': 'application/json' };
    const cancel = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT', headers, body: JSON.stringify({ status: 'cancelled', planId: 2 })
    });
    assert.equal(cancel.status, 200, await cancel.clone().text());
    const cancelledCompany = await controlDb.execute({ sql: 'SELECT status, delete_after FROM companies WHERE id = ?', args: [1] });
    assert.equal(cancelledCompany.rows[0].status, 'cancelled');
    assert.equal(cancelledCompany.rows[0].delete_after, null);

    const reactivate = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT', headers, body: JSON.stringify({ status: 'active', planId: 2 })
    });
    assert.equal(reactivate.status, 200, await reactivate.clone().text());
    const activeCompany = await controlDb.execute({ sql: 'SELECT status, delete_after FROM companies WHERE id = ?', args: [1] });
    assert.equal(activeCompany.rows[0].status, 'active');
    assert.equal(activeCompany.rows[0].delete_after, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('live storage refresh measures tenant bytes, records a fresh snapshot, and audits the action', async () => {
  let scopedCompanyId = null;
  const tenantDatabase = {
    async runWithTenant(companyId, callback) {
      scopedCompanyId = companyId;
      return callback();
    },
    prepare(sql) {
      return {
        async get() {
          if (sql.includes('COUNT(*) AS count FROM users')) return { count: 5 };
          if (sql.includes('PRAGMA page_count')) return { page_count: 10 };
          if (sql.includes('PRAGMA page_size')) return { page_size: 4096 };
          if (sql.includes('FROM file_usage')) return { bytes: 1_000_000 };
          assert.fail(`Unexpected tenant usage query: ${sql}`);
        }
      };
    }
  };
  const { controlDb, server, baseUrl } = await createApp({ tenantDatabase });
  try {
    await controlDb.execute({
      sql: 'UPDATE companies SET storage_limit_mb_override = 1 WHERE id = 1',
      args: []
    });
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0] };
    const refreshed = await fetch(`${baseUrl}/companies/1/storage/refresh`, { method: 'POST', headers });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const result = await refreshed.json();
    assert.equal(scopedCompanyId, 1);
    assert.equal(result.allocatedBytes, 1_048_576);
    assert.equal(result.databaseBytes, 40_960);
    assert.equal(result.fileBytes, 1_000_000);
    assert.equal(result.usedBytes, 1_040_960);
    assert.equal(result.remainingBytes, 7_616);
    assert.equal(result.percentUsed, 99.3);
    assert.ok(result.updatedAt);

    const snapshot = await controlDb.execute({
      sql: 'SELECT user_count, db_bytes, files_bytes FROM usage_snapshots WHERE company_id = 1 ORDER BY id DESC LIMIT 1',
      args: []
    });
    assert.deepEqual(snapshot.rows[0], { user_count: 5, db_bytes: 40_960, files_bytes: 1_000_000 });
    const audit = await controlDb.execute({
      sql: "SELECT action FROM super_admin_audit WHERE company_id = 1 AND action = 'Live storage refreshed'",
      args: []
    });
    assert.equal(audit.rows.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('super-admin backup download and restore staging actions require authentication', async () => {
  const calls = [];
  const backupManager = {
    async getBackupArchive(companyId, backupId) {
      calls.push(['download', companyId, backupId]);
      return { buffer: Buffer.from(JSON.stringify({ format: 'taskflow-company-backup' })) };
    },
    async createRestoreStage(companyId, backupId, adminId) {
      calls.push(['stage', companyId, backupId, adminId]);
      return { id: 12, status: 'ready', rowCounts: { users: 1 } };
    },
    async activateRestore(companyId, restoreId, adminId) {
      calls.push(['activate', companyId, restoreId, adminId]);
      return { companyId, stagingId: restoreId, databaseName: 'restore-one' };
    },
    async revertRestore(companyId, restoreId, adminId) {
      calls.push(['revert', companyId, restoreId, adminId]);
      return { companyId, stagingId: restoreId, databaseName: 'example' };
    },
    async discardRestore(companyId, restoreId, adminId) {
      calls.push(['discard', companyId, restoreId, adminId]);
      return { companyId, stagingId: restoreId };
    }
  };
  const { controlDb, server, baseUrl } = await createApp({ backupManager });
  try {
    for (const request of [
      fetch(`${baseUrl}/companies/1/backups/2/download`),
      fetch(`${baseUrl}/companies/1/backups/2/restore`, { method: 'POST' }),
      fetch(`${baseUrl}/companies/1/restores/12/activate`, { method: 'POST' }),
      fetch(`${baseUrl}/companies/1/restores/12/revert`, { method: 'POST' }),
      fetch(`${baseUrl}/companies/1/restores/12`, { method: 'DELETE' })
    ]) assert.equal((await request).status, 401);

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0], 'Content-Type': 'application/json' };
    const download = await fetch(`${baseUrl}/companies/1/backups/2/download`, { headers });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal((await download.json()).format, 'taskflow-company-backup');
    assert.equal((await fetch(`${baseUrl}/companies/1/backups/2/restore`, { method: 'POST', headers })).status, 201);
    assert.equal((await fetch(`${baseUrl}/companies/1/restores/12/activate`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${baseUrl}/companies/1/restores/12/revert`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${baseUrl}/companies/1/restores/12`, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual(calls.map(call => call[0]), ['download', 'stage', 'activate', 'revert', 'discard']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('super-admin detail, plans, billing, reset, backup, support mode, and company route guard work together', async () => {
  const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-backups-'));
  const tenantAdmin = { id: 9, name: 'Tenant Admin', username: 'tenant-admin', token_version: 4 };
  let tenantPasswordHash = 'old-password-hash';
  let mustChangePassword = 0;
  const tenantDatabase = {
    runWithTenant(companyId, callback) {
      assert.equal(companyId, 1);
      return callback();
    },
    prepare(sql) {
      return {
        async get() {
          if (sql.includes('COUNT(*) AS count FROM users WHERE active = 1')) return { count: 7 };
          if (sql.includes('PRAGMA page_count')) return { page_count: 1 };
          if (sql.includes('PRAGMA page_size')) return { page_size: 4096 };
          if (sql.includes('SUM(bytes)')) return { bytes: 2048 };
          if (sql.includes("WHERE role = 'admin'")) return { ...tenantAdmin };
          if (sql.includes('SELECT username FROM users')) return { username: tenantAdmin.username };
          return null;
        },
        async all() {
          if (sql.includes('sqlite_master')) return [{ name: 'users' }];
          if (sql.includes('SELECT * FROM "users"')) return [{ ...tenantAdmin, password_hash: tenantPasswordHash }];
          return [];
        },
        async run(...args) {
          if (sql.includes('UPDATE users SET password_hash')) {
            tenantPasswordHash = args[0];
            mustChangePassword = 1;
            tenantAdmin.token_version += 1;
            return { changes: 1 };
          }
          return { changes: 1 };
        }
      };
    }
  };
  const { controlDb, server, baseUrl, origin } = await createApp({ tenantDatabase, backupDirectory });
  try {
    const unauthorizedDetail = await fetch(`${baseUrl}/companies/1`);
    assert.equal(unauthorizedDetail.status, 401);
    const unauthorizedPlan = await fetch(`${baseUrl}/plans`);
    assert.equal(unauthorizedPlan.status, 401);

    const companySessionResponse = await fetch(`${origin}/create-company-session`);
    const companyCookie = companySessionResponse.headers.get('set-cookie').split(';', 1)[0];
    const superAdminPage = await fetch(`${origin}/superadmin`, { headers: { Cookie: companyCookie } });
    assert.equal(superAdminPage.status, 200);
    assert.match(await superAdminPage.text(), /id="login-form"/);
    const superAdminHtml = await fetch(`${origin}/superadmin.html`, { headers: { Cookie: companyCookie } });
    assert.equal(superAdminHtml.status, 200);
    assert.match(await superAdminHtml.text(), /id="login-form"/);
    const blockedApi = await fetch(`${baseUrl}/overview`, { headers: { Cookie: companyCookie } });
    assert.equal(blockedApi.status, 401);

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const detailResponse = await fetch(`${baseUrl}/companies/1`, { headers });
    assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
    const initialDetail = await detailResponse.json();
    assert.equal(initialDetail.company.name, 'Test Company');
    assert.equal(initialDetail.usageHistory.length, 1);
    assert.equal(initialDetail.usageHistory[0].userCount, 7);

    const update = await fetch(`${baseUrl}/companies/1`, {
      method: 'PUT', headers,
      body: JSON.stringify({ status: 'active', planId: 2, maxUsersOverride: 8, storageLimitMbOverride: 20, notes: 'Follow up next month.' })
    });
    assert.equal(update.status, 200);
    const updatedDetail = await (await fetch(`${baseUrl}/companies/1`, { headers })).json();
    assert.equal(updatedDetail.company.maxUsersOverride, 8);
    assert.equal(updatedDetail.company.storageLimitMbOverride, 20);
    assert.equal(updatedDetail.company.notes, 'Follow up next month.');

    const planPayload = {
      name: 'Launch', maxUsers: 12, storageLimitMb: 4096,
      features: { attendance: true, reimbursements: false, export: true },
      priceNote: 'INR 1,200 monthly', isActive: true
    };
    const createdPlan = await fetch(`${baseUrl}/plans`, { method: 'POST', headers, body: JSON.stringify(planPayload) });
    assert.equal(createdPlan.status, 201);
    const planId = (await createdPlan.json()).id;
    const editedPlan = await fetch(`${baseUrl}/plans/${planId}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ ...planPayload, priceNote: 'INR 1,500 monthly' })
    });
    assert.equal(editedPlan.status, 200);
    const plans = await (await fetch(`${baseUrl}/plans`, { headers })).json();
    assert.equal(plans.plans.find(plan => plan.id === planId).priceNote, 'INR 1,500 monthly');

    const billing = await fetch(`${baseUrl}/companies/1/billing`, {
      method: 'POST', headers,
      body: JSON.stringify({ amountText: 'INR 1,500', note: 'October subscription' })
    });
    assert.equal(billing.status, 201);
    const billingId = (await billing.json()).id;
    const paid = await fetch(`${baseUrl}/companies/1/billing/${billingId}/paid`, { method: 'POST', headers });
    assert.equal(paid.status, 200);
    const billingDetail = await (await fetch(`${baseUrl}/companies/1`, { headers })).json();
    assert.ok(billingDetail.billingNotes[0].markedPaidAt);

    const reset = await fetch(`${baseUrl}/companies/1/reset-admin-password`, { method: 'POST', headers });
    assert.equal(reset.status, 200);
    const resetDetails = await reset.json();
    assert.equal(resetDetails.username, 'tenant-admin');
    assert.equal(await bcrypt.compare(resetDetails.oneTimePassword, tenantPasswordHash), true);
    assert.equal(mustChangePassword, 1);

    const backup = await fetch(`${baseUrl}/companies/1/backups`, { method: 'POST', headers });
    assert.equal(backup.status, 201, await backup.clone().text());
    const backupDetails = await backup.json();
    assert.equal(backupDetails.status, 'complete');
    assert.equal(backupDetails.type, 'tenant-json-v2');
    const downloadedBackup = await fetch(`${baseUrl}/companies/1/backups/${backupDetails.id}/download`, { headers: { Cookie: cookie } });
    assert.equal(downloadedBackup.status, 200);
    assert.equal((await downloadedBackup.json()).format, 'taskflow-company-backup');
    const backupFiles = await fs.readdir(backupDirectory);
    assert.equal(backupFiles.length, 1);
    const backupPayload = JSON.parse(await fs.readFile(path.join(backupDirectory, backupFiles[0]), 'utf8'));
    assert.equal(backupPayload.tables.users[0].username, 'tenant-admin');

    const support = await fetch(`${baseUrl}/companies/1/support-mode`, { method: 'POST', headers });
    assert.equal(support.status, 200, await support.clone().text());
    const supportData = await support.json();
    const supportExpiresAt = new Date(supportData.expiresAt).getTime();
    assert.ok(supportExpiresAt - Date.now() <= SUPPORT_MODE_DURATION_MS);
    assert.ok(supportExpiresAt - Date.now() > SUPPORT_MODE_DURATION_MS - 5000);
    const supportCookie = support.headers.get('set-cookie').split(';', 1)[0];
    const supportState = await (await fetch(`${origin}/support-state`, { headers: { Cookie: supportCookie } })).json();
    assert.equal(supportState.role, 'admin');
    assert.equal(supportState.companyId, 1);
    assert.equal(supportState.expiresAt, supportExpiresAt);
    assert.ok(supportState.maxAge <= SUPPORT_MODE_DURATION_MS);

    const audit = await controlDb.execute('SELECT action FROM super_admin_audit');
    const actions = audit.rows.map(row => row.action);
    for (const action of ['Company configuration updated', 'Plan created', 'Plan updated', 'Billing note added', 'Billing note marked paid', 'Company admin password reset', 'Company backup created', 'Support mode started']) {
      assert.ok(actions.includes(action), `expected audit record for ${action}`);
    }

    const requestRecord = await controlDb.execute({
      sql: `INSERT INTO subscription_change_requests
        (company_id, requested_by_user_id, requested_seats, requested_billing_cycle)
        VALUES (?, ?, ?, ?)`,
      args: [1, 9, 7, 'monthly']
    });
    const requestInvoice = await fetch(`${baseUrl}/companies/1/billing-requests/${requestRecord.lastInsertRowid}/invoice`, {
      method: 'POST', headers
    });
    assert.equal(requestInvoice.status, 201, await requestInvoice.clone().text());
    assert.equal((await requestInvoice.json()).status, 'open');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
    await fs.rm(backupDirectory, { recursive: true, force: true });
  }
});

test('super-admin company provisioning is authenticated and returns one-time details without caching', async () => {
  let provisionedBody;
  const { controlDb, server, baseUrl } = await createApp({
    provisionCompany: async (body, admin) => {
      provisionedBody = { body, admin };
      return {
        company: { id: 2, code: 'new-company', name: 'New Company', status: 'trial', trialEndsAt: '2027-01-03', planId: 1 },
        admin: { name: 'New Admin', username: 'new-admin', oneTimePassword: 'one-time-secret' }
      };
    }
  });
  try {
    const unauthorized = await fetch(`${baseUrl}/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'new-company' })
    });
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const created = await fetch(`${baseUrl}/companies`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'new-company',
        name: 'New Company',
        planId: 1
      })
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await created.json(), {
      company: { id: 2, code: 'new-company', name: 'New Company', status: 'trial', trialEndsAt: '2027-01-03', planId: 1 },
      admin: { name: 'New Admin', username: 'new-admin', oneTimePassword: 'one-time-secret' }
    });
    assert.equal(provisionedBody.admin.id, 1);
    assert.equal(provisionedBody.body.code, 'new-company');

    await controlDb.execute({
      sql: `INSERT INTO companies (id, code, name, status, plan_id, tenant_db_url, tenant_db_token_encrypted)
        VALUES (2, 'new-company', 'New Company', 'trial', 1, 'libsql://new.example', 'encrypted-token')`,
      args: []
    });
    const demoRequest = await controlDb.execute({
      sql: `INSERT INTO demo_requests
        (name, email, company_name, team_size, consented_at, status)
        VALUES (?, ?, ?, ?, ?, 'approved')`,
      args: ['New Admin', 'admin@example.test', 'New Company', 4, new Date().toISOString()]
    });
    const converted = await fetch(`${baseUrl}/companies`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'new-company',
        name: 'New Company',
        planId: 1,
        demoRequestId: Number(demoRequest.lastInsertRowid)
      })
    });
    assert.equal(converted.status, 201, await converted.clone().text());
    const conversionState = await controlDb.execute({
      sql: 'SELECT status, company_id FROM demo_requests WHERE id = ?',
      args: [Number(demoRequest.lastInsertRowid)]
    });
    assert.equal(conversionState.rows[0].status, 'converted');
    assert.equal(Number(conversionState.rows[0].company_id), 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await controlDb.close();
  }
});

test('super-admin can approve and reject queued demo requests for manual trial setup', async () => {
  const { controlDb, server, baseUrl } = await createApp();
  try {
    const first = await controlDb.execute({
      sql: `INSERT INTO demo_requests (name, email, company_name, team_size, consented_at)
        VALUES (?, ?, ?, ?, ?)`,
      args: ['Ari Owner', 'ari@example.test', 'Ari Co', 5, new Date().toISOString()]
    });
    const second = await controlDb.execute({
      sql: `INSERT INTO demo_requests (name, email, company_name, team_size, consented_at)
        VALUES (?, ?, ?, ?, ?)`,
      args: ['Bea Owner', 'bea@example.test', 'Bea Co', 2, new Date().toISOString()]
    });
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test owner', password: 'Superadmin-Test-Password-2026!' })
    });
    const headers = { Cookie: login.headers.get('set-cookie').split(';', 1)[0] };
    const inbox = await fetch(`${baseUrl}/demo-requests`, { headers });
    assert.equal(inbox.status, 200);
    const inboxData = await inbox.json();
    assert.equal(inboxData.requests.length, 2);
    assert.deepEqual(inboxData.requests.map(item => item.teamSize).sort(), [2, 5]);

    const approved = await fetch(`${baseUrl}/demo-requests/${first.lastInsertRowid}/approve`, {
      method: 'POST', headers
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).status, 'approved');
    const companyCount = await controlDb.execute('SELECT COUNT(*) AS count FROM companies');
    assert.equal(Number(companyCount.rows[0].count), 1, 'approval must not create a company automatically');
    const rejected = await fetch(`${baseUrl}/demo-requests/${second.lastInsertRowid}/reject`, {
      method: 'POST', headers
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).status, 'rejected');
    const remaining = await (await fetch(`${baseUrl}/demo-requests`, { headers })).json();
    assert.deepEqual(remaining.requests.map(item => item.status), ['approved']);
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
