'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const express = require('express');
const { after, before, test } = require('node:test');
const { COOKIE_NAME, createSuperAdminRouter } = require('../routes/superadmin');
const { createPublicRouter } = require('../routes/public');

const password = 'Pricing-Admin-Password-2026!';
const token = crypto.randomBytes(32).toString('base64url');
let passwordHash;
const versions = [{
  id: 1, monthly_price_paise: 19900, yearly_discount_pct: 10, yearly_price_paise: 214920,
  tax_pct: 18, currency: 'INR', effective_from: '2026-10-01T00:00:00.000Z', is_current: 1
}];
const versionTiers = new Map([[1, [{
  tier_key: 'standard', name: 'Standard', tagline: '', highlights: '[]', min_seats: 1,
  max_seats: null, monthly_price_paise: 19900, yearly_price_paise: 214920, sort_order: 0
}]]]);
const settings = {
  id: 1, currency: 'INR', currency_symbol: 'Rs.', tax_pct: 18, tax_inclusive: 0,
  trial_days: 7, trial_max_users: 3, trial_storage_limit_mb: 1024, grace_period_days: 3,
  read_only_period_days: 7, min_seats: 1, max_seats: null, default_storage_per_seat_mb: null,
  prorate_seats: 1, seat_addition_billing: 'immediate', price_change_scope: 'new_customers',
  trial_approval_mode: 'manual'
};
const audits = [];
const demoRequestRows = [];
const controlDb = {
  async execute(statement) {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    const args = typeof statement === 'string' ? [] : statement.args || [];
    if (sql.startsWith('INSERT INTO demo_requests')) {
      const row = {
        id: demoRequestRows.length + 1, name: args[0], email: args[1], phone: args[2],
        company_name: args[3], team_size: args[4], message: args[5], status: 'new', consented_at: args[6]
      };
      demoRequestRows.push(row);
      return { lastInsertRowid: row.id };
    }
    if (sql.includes('FROM super_admin_sessions s')) {
      return { rows: [{ id: 9, name: 'Pricing Admin', username: 'pricing-admin', admin_token_version: 0, session_token_version: 0, expires_at: Date.now() + 60000 }] };
    }
    if (sql.includes('FROM super_admins WHERE id =')) return { rows: [{ password_hash: passwordHash }] };
    if (sql.includes('SELECT * FROM pricing_settings')) return { rows: [{ ...settings }] };
    if (sql.includes('SELECT * FROM pricing_versions')) {
      const effective = versions.filter(version => version.effective_from <= args[0]).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
      return { rows: effective.slice(0, 1).map(version => ({ ...version })) };
    }
    if (sql.includes('FROM pricing_tiers')) return { rows: (versionTiers.get(Number(args[0])) || []).map(tier => ({ ...tier })) };
    if (sql.includes('COUNT(*) AS count FROM subscriptions')) return { rows: [{ count: 0 }] };
    throw new Error(`Unexpected control database query: ${sql}`);
  },
  async transaction() {
    return {
      async execute(statement) {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        const args = typeof statement === 'string' ? [] : statement.args || [];
        if (sql.startsWith('UPDATE pricing_versions SET is_current = 0')) {
          versions.forEach(version => { version.is_current = 0; });
        } else if (sql.startsWith('INSERT INTO pricing_versions')) {
          const [monthly, discount, yearly, tax, currency, effective, createdBy, note, current] = args;
          const version = { id: versions.length + 1, monthly_price_paise: monthly, yearly_discount_pct: discount, yearly_price_paise: yearly, tax_pct: tax, currency, effective_from: effective, created_by: createdBy, note, is_current: current };
          versions.push(version);
          versionTiers.set(version.id, []);
          return { lastInsertRowid: version.id };
        } else if (sql.startsWith('INSERT INTO pricing_tiers')) {
          const [versionId, tierKey, name, tagline, highlights, minSeats, maxSeats, monthlyPrice, yearlyPrice, sortOrder] = args;
          versionTiers.get(Number(versionId)).push({
            tier_key: tierKey, name, tagline, highlights, min_seats: minSeats, max_seats: maxSeats,
            monthly_price_paise: monthlyPrice, yearly_price_paise: yearlyPrice, sort_order: sortOrder
          });
        } else if (sql.startsWith('UPDATE pricing_settings')) {
          const [currency, symbol, tax, inclusive, trialDays, trialUsers, trialStorage, grace, readOnly, minSeats, maxSeats, storagePerSeat, prorate, seatBilling, priceScope, approval] = args;
          Object.assign(settings, { currency, currency_symbol: symbol, tax_pct: tax, tax_inclusive: inclusive, trial_days: trialDays, trial_max_users: trialUsers, trial_storage_limit_mb: trialStorage, grace_period_days: grace, read_only_period_days: readOnly, min_seats: minSeats, max_seats: maxSeats, default_storage_per_seat_mb: storagePerSeat, prorate_seats: prorate, seat_addition_billing: seatBilling, price_change_scope: priceScope, trial_approval_mode: approval });
        } else if (sql.startsWith('INSERT INTO super_admin_audit')) {
          audits.push(args);
        } else {
          throw new Error(`Unexpected pricing transaction statement: ${sql}`);
        }
        return { rowsAffected: 1 };
      },
      async commit() {},
      async rollback() {}
    };
  }
};
let server;
let baseUrl;

before(async () => {
  passwordHash = await bcrypt.hash(password, 4);

  const publicPricing = createPublicRouter({ getDatabase: async () => controlDb, isConfigured: () => true });
  const app = express();
  app.use(express.json());
  app.use('/api/public', publicPricing.router);
  app.use('/api/superadmin', createSuperAdminRouter({
    getDatabase: async () => controlDb,
    secureCookies: false,
    invalidatePublicPricing: publicPricing.invalidateCache
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('public pricing is anonymous and pricing edits require super-admin password reconfirmation', async () => {
  const publicResponse = await fetch(`${baseUrl}/api/public/pricing`);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('cache-control'), 'public, max-age=60');
  const initialPublicPricing = await publicResponse.json();
  assert.equal(initialPublicPricing.monthlyPricePaise, 19900);
  assert.equal(initialPublicPricing.yearlyPricePaise, 214920);
  assert.equal(initialPublicPricing.monthlyPreviews.length, 3);

  const unauthenticated = await fetch(`${baseUrl}/api/superadmin/pricing`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password })
  });

  test('demo requests are anonymous, validated, consented, and remain pending manual approval', async () => {
    const invalid = await fetch(`${baseUrl}/api/public/demo-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', email: 'sam@example.test', companyName: 'Example', teamSize: 2 })
    });
    assert.equal(invalid.status, 400);

    const trapped = await fetch(`${baseUrl}/api/public/demo-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ website: 'bot.example' })
    });
    assert.equal(trapped.status, 202);
    assert.equal(demoRequestRows.length, 0);

    const response = await fetch(`${baseUrl}/api/public/demo-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Sam Owner', email: 'SAM@EXAMPLE.TEST', phone: '555-0100',
        companyName: 'Example Co', teamSize: 4, message: 'Please contact me.',
        consent: true
      })
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { id: 1, status: 'pending_review' });
    assert.equal(demoRequestRows[0].email, 'sam@example.test');
    assert.equal(demoRequestRows[0].status, 'new');
    assert.equal(demoRequestRows[0].team_size, 4);
    assert.ok(demoRequestRows[0].consented_at);
  });
  assert.equal(unauthenticated.status, 401);

  const headers = { Cookie: `${COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' };
  const wrongPassword = await fetch(`${baseUrl}/api/superadmin/pricing`, {
    method: 'POST', headers, body: JSON.stringify({ ...pricingUpdate(), currentPassword: 'wrong-password' })
  });
  assert.equal(wrongPassword.status, 401);

  const saved = await fetch(`${baseUrl}/api/superadmin/pricing`, {
    method: 'POST', headers, body: JSON.stringify({ ...pricingUpdate(), currentPassword: password })
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.pricing.monthlyPricePaise, 24900);
  assert.equal(body.pricing.yearlyPricePaise, 261450);
  assert.equal(body.pricing.existingPricePolicy, true);

  const afterSave = await fetch(`${baseUrl}/api/public/pricing`);
  assert.equal(afterSave.status, 200);
  const refreshedPricing = await afterSave.json();
  assert.equal(refreshedPricing.monthlyPricePaise, 24900);
  assert.equal(refreshedPricing.yearlyPricePaise, 261450);
  assert.equal(versions.length, 2);
  assert.equal(audits.length, 1);
});

function pricingUpdate() {
  return {
    monthlyPrice: '249.00',
    yearlyDiscountPct: '12.5',
    taxPct: '18',
    trialDays: '7',
    trialMaxUsers: '3',
    trialStorageLimitMb: '1024',
    gracePeriodDays: '3',
    readOnlyPeriodDays: '7',
    minSeats: '1',
    maxSeats: '',
    defaultStoragePerSeatMb: '',
    currency: 'INR',
    currencySymbol: 'Rs.',
    taxInclusive: false,
    prorateSeats: true,
    seatAdditionBilling: 'immediate',
    priceChangeScope: 'existing_next_renewal',
    existingPricePolicy: true,
    trialApprovalMode: 'manual',
    note: 'Manual pricing test'
  };
}