'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getPricing, parseRupeesToPaise, savePricing, validatePricingInput } = require('../pricing-service');

const validInput = {
  monthlyPrice: '199.00',
  yearlyDiscountPct: '10',
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
  priceChangeScope: 'new_customers',
  trialApprovalMode: 'manual',
  effectiveFrom: '2026-10-06',
  note: 'Test version'
};

test('pricing input validates editable settings and rejects fractional paise or invalid ranges', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const parsed = validatePricingInput(validInput, now);
  assert.equal(parsed.monthlyPricePaise, 19900);
  assert.equal(parsed.yearlyPricePaise, 214920);
  assert.equal(parsed.trialStorageLimitMb, 1024);
  assert.equal(parseRupeesToPaise('2149.20'), 214920);
  assert.equal(parseRupeesToPaise('199.001'), null);
  assert.equal(validatePricingInput({ ...validInput, trialDays: '61' }, now), null);
  assert.equal(validatePricingInput({ ...validInput, taxPct: '100.1' }, now), null);
  assert.equal(validatePricingInput({ ...validInput, monthlyPrice: '-1' }, now), null);
  assert.equal(validatePricingInput({ ...validInput, effectiveFrom: '2026-10-05' }, now), null);
});

test('pricing versions are immutable and scheduled prices become current on their effective date', async () => {
  const settings = {
    id: 1, currency: 'INR', currency_symbol: 'Rs.', tax_pct: 18, tax_inclusive: 0,
    trial_days: 7, trial_max_users: 3, trial_storage_limit_mb: 1024, grace_period_days: 3,
    read_only_period_days: 7, min_seats: 1, max_seats: null, default_storage_per_seat_mb: null,
    prorate_seats: 1, seat_addition_billing: 'immediate', price_change_scope: 'new_customers',
    trial_approval_mode: 'manual'
  };
  const versions = [{
    id: 1, monthly_price_paise: 19900, yearly_discount_pct: 10, yearly_price_paise: 214920,
    tax_pct: 18, currency: 'INR', effective_from: '2026-10-01T00:00:00.000Z', is_current: 1
  }];
  const audit = [];
  const controlDb = {
    async execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      const args = typeof statement === 'string' ? [] : statement.args || [];
      if (sql.includes('FROM pricing_settings')) return { rows: [{ ...settings }] };
      if (sql.includes('FROM pricing_versions')) {
        const effective = versions.filter(version => version.effective_from <= args[0]).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
        return { rows: effective.slice(0, 1).map(version => ({ ...version })) };
      }
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
            return { lastInsertRowid: version.id };
          } else if (sql.startsWith('UPDATE pricing_settings')) {
            const [currency, symbol, tax, inclusive, trialDays, trialUsers, trialStorage, grace, readOnly, minSeats, maxSeats, storagePerSeat, prorate, seatBilling, priceScope, approval] = args;
            Object.assign(settings, { currency, currency_symbol: symbol, tax_pct: tax, tax_inclusive: inclusive, trial_days: trialDays, trial_max_users: trialUsers, trial_storage_limit_mb: trialStorage, grace_period_days: grace, read_only_period_days: readOnly, min_seats: minSeats, max_seats: maxSeats, default_storage_per_seat_mb: storagePerSeat, prorate_seats: prorate, seat_addition_billing: seatBilling, price_change_scope: priceScope, trial_approval_mode: approval });
          } else if (sql.startsWith('INSERT INTO super_admin_audit')) {
            audit.push(args);
          } else {
            throw new Error(`Unexpected control transaction statement: ${sql}`);
          }
          return { rowsAffected: 1 };
        },
        async commit() {},
        async rollback() {}
      };
    }
  };

  const now = new Date('2026-10-06T12:00:00Z');
  const input = validatePricingInput({ ...validInput, monthlyPrice: '249.00', yearlyDiscountPct: '12.5' }, now);
  const saved = await savePricing(controlDb, { id: 7 }, input, now);
  assert.equal(saved.monthlyPricePaise, 24900);
  assert.equal(saved.yearlyPricePaise, 261450);
  const current = await getPricing(controlDb, now);
  assert.equal(current.monthlyPricePaise, 24900);
  assert.equal(current.trialDays, 7);
  assert.equal(audit.length, 1);

  const scheduledInput = validatePricingInput({ ...validInput, monthlyPrice: '250.00', effectiveFrom: '2026-11-01' }, now);
  await savePricing(controlDb, { id: 7 }, scheduledInput, now);
  assert.equal((await getPricing(controlDb, new Date('2026-10-31T23:59:59Z'))).monthlyPricePaise, 24900);
  assert.equal((await getPricing(controlDb, new Date('2026-11-01T00:00:00Z'))).monthlyPricePaise, 25000);
  assert.deepEqual(versions.map(version => [version.monthly_price_paise, version.is_current]), [
    [19900, 0],
    [24900, 1],
    [25000, 0]
  ]);
});