'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { after, before, test } = require('node:test');
const { createBillingRouter } = require('../routes/billing');

const queryArgs = [];
const controlDb = {
  async execute(statement) {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    const args = typeof statement === 'string' ? [] : statement.args || [];
    queryArgs.push({ sql, args });
    if (sql.includes('FROM companies WHERE id =')) {
      return { rows: args[0] === 42 ? [{ id: 42, code: 'billing-co', name: 'Billing Co', status: 'active', trial_ends_at: null }] : [] };
    }
    if (sql.includes('FROM subscriptions WHERE company_id =')) {
      return { rows: args[0] === 42 ? [{ id: 3, billing_cycle: 'monthly', seats: 5, status: 'active', current_period_end: '2026-11-06T00:00:00.000Z' }] : [] };
    }
    if (sql.includes('FROM invoices WHERE company_id =')) {
      return { rows: args[0] === 42 ? [{ id: 9, number: 'INV-2026-0001', total_paise: 10000, currency: 'INR', status: 'paid' }] : [] };
    }
    if (sql.includes('FROM pricing_settings')) {
      return { rows: [{
        id: 1, currency: 'INR', currency_symbol: 'Rs.', tax_pct: 18, tax_inclusive: 0,
        trial_days: 7, trial_max_users: 3, trial_storage_limit_mb: 1024, grace_period_days: 3,
        read_only_period_days: 7, min_seats: 1, max_seats: null, default_storage_per_seat_mb: null,
        prorate_seats: 1, seat_addition_billing: 'immediate', price_change_scope: 'new_customers',
        trial_approval_mode: 'manual'
      }] };
    }
    if (sql.includes('FROM pricing_versions')) {
      return { rows: [{
        id: 1, monthly_price_paise: 19900, yearly_discount_pct: 10, yearly_price_paise: 214920,
        tax_pct: 18, currency: 'INR', effective_from: '2026-10-01T00:00:00.000Z'
      }] };
    }
    throw new Error(`Unexpected billing query: ${sql}`);
  }
};

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use((req, res, next) => {
    req.companyTenantId = 42;
    req.companyName = 'Billing Co';
    req.companyStatus = 'active';
    next();
  });
  app.use('/api/billing', createBillingRouter({
    getDatabase: async () => controlDb,
    getUsage: async () => ({
      plan: { name: 'Paid', maxUsers: 5, storageLimitBytes: 1024 },
      usage: { activeUsers: 2, databaseBytes: 100, fileBytes: 50, storageBytes: 150 }
    }),
    requireAdminMiddleware(req, res, next) {
      if (req.get('x-company-admin') !== 'yes') return res.status(403).json({ error: 'Admin only' });
      next();
    }
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

test('company billing is admin-only and scopes invoices to the authenticated tenant', async () => {
  const denied = await fetch(`${baseUrl}/api/billing/me?companyId=999`);
  assert.equal(denied.status, 403);

  queryArgs.length = 0;
  const response = await fetch(`${baseUrl}/api/billing/me?companyId=999`, {
    headers: { 'x-company-admin': 'yes' }
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.company.id, 42);
  assert.equal(data.subscription.seats, 5);
  assert.deepEqual(data.invoices.map(invoice => invoice.number), ['INV-2026-0001']);
  assert.ok(queryArgs.filter(query => /company_id = \?/.test(query.sql)).every(query => query.args[0] === 42));
});
