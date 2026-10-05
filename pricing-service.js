'use strict';

const { calculateYearlyPricePaise, parsePercentageTenths } = require('./lib/pricing');

function parseRupeesToPaise(value, { allowBlank = false } = {}) {
  if (allowBlank && (value === null || value === undefined || value === '')) return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value ?? '').trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(amount);
}

function parseInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, allowBlank = false } = {}) {
  if (allowBlank && (value === null || value === undefined || value === '')) return null;
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseEffectiveDate(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return now.toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  if (date.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) return null;
  return date.toISOString();
}

function validatePricingInput(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const monthlyPricePaise = parseRupeesToPaise(body.monthlyPrice);
  const yearlyPriceOverridePaise = parseRupeesToPaise(body.yearlyPriceOverride, { allowBlank: true });
  const yearlyDiscountTenths = parsePercentageTenths(body.yearlyDiscountPct);
  const taxTenths = parsePercentageTenths(body.taxPct);
  const trialDays = parseInteger(body.trialDays, { min: 1, max: 60 });
  const trialMaxUsers = parseInteger(body.trialMaxUsers, { min: 1, max: 10000 });
  const trialStorageLimitMb = parseInteger(body.trialStorageLimitMb, { min: 0 });
  const gracePeriodDays = parseInteger(body.gracePeriodDays, { min: 0, max: 365 });
  const readOnlyPeriodDays = parseInteger(body.readOnlyPeriodDays, { min: 0, max: 365 });
  const minSeats = parseInteger(body.minSeats, { min: 1, max: 10000 });
  const maxSeats = parseInteger(body.maxSeats, { min: 1, max: 100000, allowBlank: true });
  const defaultStoragePerSeatMb = parseInteger(body.defaultStoragePerSeatMb, { min: 0, allowBlank: true });
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  const currencySymbol = typeof body.currencySymbol === 'string' ? body.currencySymbol.trim() : '';
  const seatAdditionBilling = body.seatAdditionBilling;
  const priceChangeScope = body.priceChangeScope;
  const trialApprovalMode = body.trialApprovalMode;
  const effectiveFrom = parseEffectiveDate(body.effectiveFrom, now);

  if (monthlyPricePaise === null || yearlyDiscountTenths === null || taxTenths === null
    || trialDays === null || trialMaxUsers === null || trialStorageLimitMb === null
    || gracePeriodDays === null || readOnlyPeriodDays === null || minSeats === null
    || (body.maxSeats !== '' && body.maxSeats !== null && body.maxSeats !== undefined && maxSeats === null)
    || (body.defaultStoragePerSeatMb !== '' && body.defaultStoragePerSeatMb !== null
      && body.defaultStoragePerSeatMb !== undefined && defaultStoragePerSeatMb === null)
    || (maxSeats !== null && maxSeats < minSeats)
    || !/^[A-Z]{3}$/.test(currency) || !currencySymbol || currencySymbol.length > 8
    || !['immediate', 'next_invoice'].includes(seatAdditionBilling)
    || !['new_customers', 'existing_next_renewal'].includes(priceChangeScope)
    || trialApprovalMode !== 'manual' || !effectiveFrom) return null;

  const yearlyPricePaise = yearlyPriceOverridePaise ?? calculateYearlyPricePaise(monthlyPricePaise, yearlyDiscountTenths);
  return {
    monthlyPricePaise,
    yearlyPricePaise,
    yearlyDiscountTenths,
    taxTenths,
    trialDays,
    trialMaxUsers,
    trialStorageLimitMb,
    gracePeriodDays,
    readOnlyPeriodDays,
    minSeats,
    maxSeats,
    defaultStoragePerSeatMb,
    taxInclusive: body.taxInclusive === true ? 1 : 0,
    prorateSeats: body.prorateSeats === false ? 0 : 1,
    seatAdditionBilling,
    priceChangeScope,
    trialApprovalMode,
    currency,
    currencySymbol,
    effectiveFrom,
    note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '',
    existingPricePolicy: body.existingPricePolicy === true
  };
}

async function getPricing(controlDb, now = new Date()) {
  const [settingsResult, versionResult] = await Promise.all([
    controlDb.execute('SELECT * FROM pricing_settings WHERE id = 1'),
    controlDb.execute({
      sql: `SELECT * FROM pricing_versions WHERE effective_from <= ?
        ORDER BY effective_from DESC, id DESC LIMIT 1`,
      args: [now.toISOString()]
    })
  ]);
  const settings = settingsResult.rows?.[0];
  const version = versionResult.rows?.[0];
  if (!settings || !version) throw new Error('Pricing settings are not initialized. Run the control database migration.');
  return {
    versionId: Number(version.id),
    monthlyPricePaise: Number(version.monthly_price_paise),
    yearlyDiscountPct: Number(version.yearly_discount_pct),
    yearlyPricePaise: Number(version.yearly_price_paise),
    taxPct: Number(version.tax_pct),
    currency: version.currency,
    currencySymbol: settings.currency_symbol,
    taxInclusive: Number(settings.tax_inclusive) === 1,
    trialDays: Number(settings.trial_days),
    trialMaxUsers: Number(settings.trial_max_users),
    trialStorageLimitMb: Number(settings.trial_storage_limit_mb),
    gracePeriodDays: Number(settings.grace_period_days),
    readOnlyPeriodDays: Number(settings.read_only_period_days),
    minSeats: Number(settings.min_seats),
    maxSeats: settings.max_seats == null ? null : Number(settings.max_seats),
    defaultStoragePerSeatMb: settings.default_storage_per_seat_mb == null ? null : Number(settings.default_storage_per_seat_mb),
    prorateSeats: Number(settings.prorate_seats) === 1,
    seatAdditionBilling: settings.seat_addition_billing,
    priceChangeScope: settings.price_change_scope,
    trialApprovalMode: settings.trial_approval_mode,
    effectiveFrom: version.effective_from
  };
}

async function savePricing(controlDb, admin, input, now = new Date()) {
  const existing = await getPricing(controlDb, now);
  const transaction = await controlDb.transaction('write');
  try {
    const isEffective = new Date(input.effectiveFrom).getTime() <= now.getTime();
    if (isEffective) await transaction.execute('UPDATE pricing_versions SET is_current = 0 WHERE is_current = 1');
    const inserted = await transaction.execute({
      sql: `INSERT INTO pricing_versions (
        monthly_price_paise, yearly_discount_pct, yearly_price_paise, tax_pct,
        currency, effective_from, created_by, note, is_current
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [input.monthlyPricePaise, input.yearlyDiscountTenths / 10, input.yearlyPricePaise,
        input.taxTenths / 10, input.currency, input.effectiveFrom, admin.id, input.note, isEffective ? 1 : 0]
    });
    await transaction.execute({
      sql: `UPDATE pricing_settings SET currency = ?, currency_symbol = ?, tax_pct = ?, tax_inclusive = ?,
        trial_days = ?, trial_max_users = ?, trial_storage_limit_mb = ?, grace_period_days = ?,
        read_only_period_days = ?, min_seats = ?, max_seats = ?, default_storage_per_seat_mb = ?,
        prorate_seats = ?, seat_addition_billing = ?, price_change_scope = ?, trial_approval_mode = ?,
        updated_at = datetime('now') WHERE id = 1`,
      args: [input.currency, input.currencySymbol, input.taxTenths / 10, input.taxInclusive,
        input.trialDays, input.trialMaxUsers, input.trialStorageLimitMb, input.gracePeriodDays,
        input.readOnlyPeriodDays, input.minSeats, input.maxSeats, input.defaultStoragePerSeatMb,
        input.prorateSeats, input.seatAdditionBilling, input.priceChangeScope, input.trialApprovalMode]
    });
    const auditDetails = JSON.stringify({
      old: { monthlyPricePaise: existing.monthlyPricePaise, yearlyPricePaise: existing.yearlyPricePaise, taxPct: existing.taxPct },
      new: { monthlyPricePaise: input.monthlyPricePaise, yearlyPricePaise: input.yearlyPricePaise, taxPct: input.taxTenths / 10 },
      appliesTo: input.priceChangeScope,
      effectiveFrom: input.effectiveFrom
    });
    await transaction.execute({
      sql: 'INSERT INTO super_admin_audit (super_admin_id, action, details) VALUES (?, ?, ?)',
      args: [admin.id, 'Pricing version created', auditDetails]
    });
    await transaction.commit();
    return { versionId: Number(inserted.lastInsertRowid), ...input };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = { getPricing, parseRupeesToPaise, savePricing, validatePricingInput };