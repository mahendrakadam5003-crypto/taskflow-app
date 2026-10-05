'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createManualSubscriptionInvoice, markManualInvoicePaid, periodEnd } = require('../billing-service');

function createBillingFixture() {
  const companies = new Map([[1, { id: 1, status: 'trial', trial_policy_version: 1 }], [2, { id: 2, status: 'active', trial_policy_version: null }]]);
  const settings = { min_seats: 1, max_seats: null, tax_inclusive: 0 };
  const pricing = { id: 1, monthly_price_paise: 19900, yearly_discount_pct: 10, yearly_price_paise: 214920, tax_pct: 18, currency: 'INR', effective_from: '2026-10-01T00:00:00.000Z' };
  const sequences = new Map();
  const subscriptions = [];
  const invoices = [];
  const payments = [];
  const events = [];
  const audits = [];
  const controlDb = {
    async execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      const args = typeof statement === 'string' ? [] : statement.args || [];
      if (sql.includes('FROM companies WHERE id =')) return { rows: companies.has(Number(args[0])) ? [{ ...companies.get(Number(args[0])) }] : [] };
      if (sql.includes('SELECT min_seats')) return { rows: [{ ...settings }] };
      if (sql.includes('SELECT id FROM subscriptions WHERE company_id')) {
        return { rows: subscriptions.filter(row => row.company_id === Number(args[0]) && ['active', 'past_due'].includes(row.status)).slice(0, 1) };
      }
      if (sql.includes('SELECT * FROM pricing_settings')) return { rows: [{
        currency: 'INR', currency_symbol: 'Rs.', tax_pct: 18, tax_inclusive: 0,
        trial_days: 7, trial_max_users: 3, trial_storage_limit_mb: 1024, grace_period_days: 3,
        read_only_period_days: 7, min_seats: 1, max_seats: null, default_storage_per_seat_mb: null,
        prorate_seats: 1, seat_addition_billing: 'immediate', price_change_scope: 'new_customers', trial_approval_mode: 'manual'
      }] };
      if (sql.includes('SELECT * FROM pricing_versions')) return { rows: [{ ...pricing }] };
      throw new Error(`Unexpected billing query: ${sql}`);
    },
    async transaction() {
      return {
        async execute(statement) {
          const sql = typeof statement === 'string' ? statement : statement.sql;
          const args = typeof statement === 'string' ? [] : statement.args || [];
          if (sql.startsWith('SELECT last_number FROM invoice_sequences')) {
            const value = sequences.get(Number(args[0]));
            return { rows: value ? [{ last_number: value }] : [] };
          }
          if (sql.startsWith('INSERT INTO invoice_sequences')) {
            sequences.set(Number(args[0]), Number(args[1]));
            return { rowsAffected: 1 };
          }
          if (sql.startsWith('UPDATE invoice_sequences')) {
            sequences.set(Number(args[1]), Number(args[0]));
            return { rowsAffected: 1 };
          }
          if (sql.startsWith('INSERT INTO subscriptions')) {
            const row = {
              id: subscriptions.length + 1,
              company_id: Number(args[0]),
              billing_cycle: args[1],
              seats: Number(args[2]),
              unit_price_paise: Number(args[3]),
              discount_pct: Number(args[4]),
              pricing_version_id: Number(args[5]),
              status: 'past_due',
              current_period_start: args[6],
              current_period_end: args[7]
            };
            subscriptions.push(row);
            return { lastInsertRowid: row.id };
          }
          if (sql.startsWith('INSERT INTO invoices')) {
            const row = {
              id: invoices.length + 1,
              company_id: Number(args[0]),
              subscription_id: Number(args[1]),
              number: args[2],
              period_start: args[3],
              period_end: args[4],
              seats: Number(args[5]),
              unit_price_paise: Number(args[6]),
              subtotal_paise: Number(args[7]),
              discount_paise: Number(args[8]),
              tax_paise: Number(args[9]),
              total_paise: Number(args[10]),
              currency: args[11],
              tax_pct: Number(args[12]),
              status: 'open'
            };
            invoices.push(row);
            return { lastInsertRowid: row.id };
          }
          if (sql.startsWith('UPDATE companies SET status')) {
            const company = companies.get(Number(args[0]));
            if (company?.trial_policy_version === 1) company.status = 'active';
            return { rowsAffected: 1 };
          }
          if (sql.startsWith('INSERT INTO subscription_events')) { events.push(args); return { rowsAffected: 1 }; }
          if (sql.startsWith('INSERT INTO super_admin_audit')) { audits.push(args); return { rowsAffected: 1 }; }
          if (sql.startsWith('SELECT id, subscription_id, number, total_paise')) {
            const invoice = invoices.find(row => row.id === Number(args[0]) && row.company_id === Number(args[1]) && row.status === 'open');
            return { rows: invoice ? [{ ...invoice }] : [] };
          }
          if (sql.startsWith("UPDATE invoices SET status = 'paid'")) {
            const invoice = invoices.find(row => row.id === Number(args[1]) && row.status === 'open');
            if (invoice) { invoice.status = 'paid'; invoice.paid_at = args[0]; }
            return { rowsAffected: invoice ? 1 : 0 };
          }
          if (sql.startsWith('UPDATE subscriptions SET status')) {
            const subscription = subscriptions.find(row => row.id === Number(args[2]) && row.company_id === Number(args[3]));
            if (subscription) Object.assign(subscription, { status: 'active', current_period_start: args[0], current_period_end: args[1] });
            return { rowsAffected: subscription ? 1 : 0 };
          }
          if (sql.startsWith("UPDATE companies SET status = \'active\'")) {
            const company = companies.get(Number(args[0]));
            if (company) Object.assign(company, { status: 'active', delete_after: null });
            return { rowsAffected: company ? 1 : 0 };
          }
          if (sql.startsWith('INSERT INTO payments')) { payments.push(args); return { rowsAffected: 1 }; }
          throw new Error(`Unexpected billing transaction: ${sql}`);
        },
        async commit() {},
        async rollback() {}
      };
    }
  };
  return { audits, companies, controlDb, events, invoices, payments, sequences, subscriptions };
}

test('manual invoice locks current price, numbers invoices, and activates the period only when paid', async () => {
  const fixture = createBillingFixture();
  const now = new Date('2026-10-06T12:00:00.000Z');
  const first = await createManualSubscriptionInvoice(fixture.controlDb, { id: 7 }, {
    companyId: 1, billingCycle: 'monthly', seats: 12, now
  });
  assert.equal(first.number, 'INV-2026-0001');
  assert.equal(first.unitPricePaise, 19900);
  assert.equal(first.totalPaise, 281784);
  assert.equal(first.status, 'open');
  assert.equal(fixture.subscriptions[0].status, 'past_due');
  assert.equal(fixture.companies.get(1).status, 'trial');
  assert.equal(fixture.subscriptions[0].current_period_end, first.periodEnd);

  const paid = await markManualInvoicePaid(fixture.controlDb, { id: 7 }, {
    companyId: 1, invoiceId: first.invoiceId, providerRef: 'bank-transfer-1', now
  });
  assert.equal(paid.amountPaise, 281784);
  assert.equal(fixture.invoices[0].status, 'paid');
  assert.equal(fixture.subscriptions[0].status, 'active');
  assert.equal(fixture.subscriptions[0].current_period_end, first.periodEnd);
  assert.equal(fixture.payments.length, 1);
  assert.equal(fixture.events.length, 2);
  assert.equal(fixture.audits.length, 2);
  await assert.rejects(markManualInvoicePaid(fixture.controlDb, { id: 7 }, { companyId: 1, invoiceId: first.invoiceId, now }), /Open invoice not found/);

  const second = await createManualSubscriptionInvoice(fixture.controlDb, { id: 7 }, {
    companyId: 2, billingCycle: 'yearly', seats: 1, now
  });
  assert.equal(second.number, 'INV-2026-0002');
  assert.equal(second.unitPricePaise, 214920);
  assert.equal(second.discountPaise, 0);
  assert.equal(second.totalPaise, 253606);
});

test('billing period end clamps month-end dates instead of overflowing into the next month', () => {
  assert.equal(periodEnd(new Date('2026-01-31T12:00:00.000Z'), 'monthly').toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(periodEnd(new Date('2024-02-29T12:00:00.000Z'), 'yearly').toISOString(), '2025-02-28T12:00:00.000Z');
});