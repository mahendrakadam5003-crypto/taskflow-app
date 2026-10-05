'use strict';

const { getPricing } = require('./pricing-service');
const { calculateInvoiceAmounts, resolveTierForSeats } = require('./lib/pricing');

function periodEnd(start, billingCycle) {
  const nextMonth = new Date(start.getTime());
  if (billingCycle === 'yearly') {
    const originalDay = nextMonth.getUTCDate();
    nextMonth.setUTCDate(1);
    nextMonth.setUTCFullYear(nextMonth.getUTCFullYear() + 1);
    const lastDay = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).getUTCDate();
    nextMonth.setUTCDate(Math.min(originalDay, lastDay));
    return nextMonth;
  }
  if (billingCycle !== 'monthly') throw new TypeError('Billing cycle must be monthly or yearly.');
  const originalDay = nextMonth.getUTCDate();
  nextMonth.setUTCDate(1);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).getUTCDate();
  nextMonth.setUTCDate(Math.min(originalDay, lastDay));
  return nextMonth;
}

async function nextInvoiceNumber(transaction, year) {
  const result = await transaction.execute({
    sql: 'SELECT last_number FROM invoice_sequences WHERE year = ? LIMIT 1',
    args: [year]
  });
  const previous = Number(result.rows?.[0]?.last_number || 0);
  const next = previous + 1;
  if (!Number.isSafeInteger(next) || next > 99999999) throw new Error('Invoice sequence is exhausted for this year.');
  if (previous === 0) {
    await transaction.execute({ sql: 'INSERT INTO invoice_sequences (year, last_number) VALUES (?, ?)', args: [year, next] });
  } else {
    await transaction.execute({ sql: 'UPDATE invoice_sequences SET last_number = ? WHERE year = ?', args: [next, year] });
  }
  return `INV-${year}-${String(next).padStart(4, '0')}`;
}

async function markBillingRequestInvoiced(transaction, admin, requestId, invoiceId, previousSubscriptionId = null) {
  if (requestId == null) return;
  const result = await transaction.execute({
    sql: `UPDATE subscription_change_requests SET status = 'invoiced', invoice_id = ?,
      previous_subscription_id = ?, reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ? AND status = 'pending'`,
    args: [invoiceId, previousSubscriptionId, admin.id, requestId]
  });
  if (Number(result.rowsAffected || 0) !== 1) throw new Error('Billing request is no longer pending.');
}

async function createManualSubscriptionInvoice(controlDb, admin, { companyId, billingCycle, seats, now = new Date(), requestId = null }) {
  const normalizedCompanyId = Number(companyId);
  if (!Number.isSafeInteger(normalizedCompanyId) || normalizedCompanyId < 1) throw new TypeError('A valid company is required.');
  if (!['monthly', 'yearly'].includes(billingCycle)) throw new TypeError('Billing cycle must be monthly or yearly.');
  if (!Number.isSafeInteger(seats) || seats < 1) throw new TypeError('Seats must be a positive integer.');

  const [companyResult, settingsResult, existingResult] = await Promise.all([
    controlDb.execute({ sql: "SELECT id, status FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1", args: [normalizedCompanyId] }),
    controlDb.execute('SELECT min_seats, max_seats, tax_inclusive FROM pricing_settings WHERE id = 1'),
    controlDb.execute({
      sql: "SELECT id FROM subscriptions WHERE company_id = ? AND status IN ('active', 'past_due') LIMIT 1",
      args: [normalizedCompanyId]
    })
  ]);
  if (!companyResult.rows?.[0]) throw new Error('Company not found.');
  if (existingResult.rows?.[0]) throw new Error('This company already has a paid subscription.');
  const settings = settingsResult.rows?.[0] || {};
  const minSeats = Number(settings.min_seats ?? 1);
  const maxSeats = settings.max_seats == null ? null : Number(settings.max_seats);
  if (seats < minSeats || (maxSeats !== null && seats > maxSeats)) {
    throw new RangeError(`Seats must be between ${minSeats} and ${maxSeats ?? 'unlimited'}.`);
  }

  const pricing = await getPricing(controlDb, now);
  const tier = pricing.tiers.length ? resolveTierForSeats(pricing.tiers, seats) : null;
  const unitPricePaise = tier
    ? (billingCycle === 'yearly' ? tier.yearlyPricePaise : tier.monthlyPricePaise)
    : (billingCycle === 'yearly' ? pricing.yearlyPricePaise : pricing.monthlyPricePaise);
  const discountPctTenths = billingCycle === 'yearly' ? Math.round(pricing.yearlyDiscountPct * 10) : 0;
  const amounts = calculateInvoiceAmounts({
    unitPricePaise,
    seats,
    discountPctTenths: 0,
    taxPctTenths: Math.round(pricing.taxPct * 10),
    taxInclusive: Number(settings.tax_inclusive) === 1
  });
  const periodStart = new Date(now);
  const invoicePeriodEnd = periodEnd(periodStart, billingCycle);
  const periodStartText = periodStart.toISOString();
  const invoicePeriodEndText = invoicePeriodEnd.toISOString();
  const transaction = await controlDb.transaction('write');
  try {
    const number = await nextInvoiceNumber(transaction, periodStart.getUTCFullYear());
    const subscription = await transaction.execute({
      sql: `INSERT INTO subscriptions (
        company_id, billing_cycle, seats, unit_price_paise, discount_pct, pricing_version_id,
        status, current_period_start, current_period_end, provider
      ) VALUES (?, ?, ?, ?, ?, ?, 'past_due', ?, ?, 'manual')`,
      args: [normalizedCompanyId, billingCycle, seats, unitPricePaise, discountPctTenths / 10,
        pricing.versionId, periodStartText, invoicePeriodEndText]
    });
    const subscriptionId = Number(subscription.lastInsertRowid);
    const invoice = await transaction.execute({
      sql: `INSERT INTO invoices (
        company_id, subscription_id, number, period_start, period_end, seats, unit_price_paise,
        subtotal_paise, discount_paise, tax_paise, total_paise, currency, tax_pct, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      args: [normalizedCompanyId, subscriptionId, number, periodStartText, invoicePeriodEndText,
        seats, unitPricePaise, amounts.subtotalPaise, amounts.discountPaise, amounts.taxPaise,
        amounts.totalPaise, pricing.currency, pricing.taxPct]
    });
    await markBillingRequestInvoiced(transaction, admin, requestId, Number(invoice.lastInsertRowid));
    await transaction.execute({
      sql: 'INSERT INTO subscription_events (company_id, subscription_id, actor_super_admin_id, event, details) VALUES (?, ?, ?, ?, ?)',
      args: [normalizedCompanyId, subscriptionId, admin.id, 'manual_subscription_created',
        `Created ${billingCycle} subscription for ${seats} seats at ${unitPricePaise} paise per seat${tier ? ` on the ${tier.name} tier` : ''}.`]
    });
    await transaction.execute({
      sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
      args: [admin.id, normalizedCompanyId, 'Manual subscription invoice created', `${number}: ${billingCycle}, ${seats} seats, ${amounts.totalPaise} paise total.`]
    });
    await transaction.commit();
    return {
      subscriptionId,
      invoiceId: Number(invoice.lastInsertRowid),
      number,
      billingCycle,
      seats,
      unitPricePaise,
      ...amounts,
      currency: pricing.currency,
      periodStart: periodStartText,
      periodEnd: invoicePeriodEndText,
      status: 'open'
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function createManualSubscriptionChangeInvoice(controlDb, admin, { companyId, requestId, now = new Date() }) {
  const normalizedCompanyId = Number(companyId);
  const normalizedRequestId = Number(requestId);
  if (!Number.isSafeInteger(normalizedCompanyId) || normalizedCompanyId < 1
    || !Number.isSafeInteger(normalizedRequestId) || normalizedRequestId < 1) {
    throw new TypeError('A valid company and billing request are required.');
  }
  const transaction = await controlDb.transaction('write');
  try {
    const requestResult = await transaction.execute({
      sql: `SELECT id, requested_billing_cycle, requested_seats FROM subscription_change_requests
        WHERE id = ? AND company_id = ? AND status = 'pending' LIMIT 1`,
      args: [normalizedRequestId, normalizedCompanyId]
    });
    const request = requestResult.rows?.[0];
    if (!request) throw new Error('Pending billing request not found.');

    const subscriptionResult = await transaction.execute({
      sql: `SELECT id, billing_cycle, unit_price_paise, pricing_version_id, current_period_end
        FROM subscriptions WHERE company_id = ? AND status IN ('active', 'past_due', 'cancelled', 'expired')
        ORDER BY id DESC LIMIT 1`,
      args: [normalizedCompanyId]
    });
    const current = subscriptionResult.rows?.[0];
    if (!current) throw new Error('Paid subscription not found.');

    const requestedCycle = request.requested_billing_cycle;
    const seats = Number(request.requested_seats);
    const settingsResult = await transaction.execute('SELECT min_seats, max_seats, tax_inclusive FROM pricing_settings WHERE id = 1');
    const settings = settingsResult.rows?.[0] || {};
    const minSeats = Number(settings.min_seats ?? 1);
    const maxSeats = settings.max_seats == null ? null : Number(settings.max_seats);
    if (seats < minSeats || (maxSeats !== null && seats > maxSeats)) {
      throw new RangeError(`Seats must be between ${minSeats} and ${maxSeats ?? 'unlimited'}.`);
    }

    let unitPricePaise;
    let discountPct = 0;
    let taxPct = 18;
    let currency = 'INR';
    let tier = null;
    if (current.pricing_version_id != null) {
      const versionResult = await transaction.execute({
        sql: 'SELECT monthly_price_paise, yearly_price_paise, yearly_discount_pct, tax_pct, currency FROM pricing_versions WHERE id = ? LIMIT 1',
        args: [Number(current.pricing_version_id)]
      });
      const version = versionResult.rows?.[0];
      if (!version) throw new Error('Locked subscription pricing version was not found.');
      const tierResult = await transaction.execute({
        sql: `SELECT tier_key, name, tagline, highlights, min_seats, max_seats,
          monthly_price_paise, yearly_price_paise, sort_order
          FROM pricing_tiers WHERE pricing_version_id = ? ORDER BY sort_order, id`,
        args: [Number(current.pricing_version_id)]
      });
      const tiers = (tierResult.rows || []).map(row => ({
        key: row.tier_key,
        name: row.name,
        tagline: row.tagline,
        highlights: JSON.parse(row.highlights),
        minSeats: Number(row.min_seats),
        maxSeats: row.max_seats == null ? null : Number(row.max_seats),
        monthlyPricePaise: Number(row.monthly_price_paise),
        yearlyPricePaise: Number(row.yearly_price_paise),
        sortOrder: Number(row.sort_order)
      }));
      tier = tiers.length ? resolveTierForSeats(tiers, seats) : null;
      unitPricePaise = tier
        ? (requestedCycle === 'yearly' ? tier.yearlyPricePaise : tier.monthlyPricePaise)
        : Number(requestedCycle === 'yearly' ? version.yearly_price_paise : version.monthly_price_paise);
      discountPct = requestedCycle === 'yearly' ? Number(version.yearly_discount_pct) : 0;
      taxPct = Number(version.tax_pct);
      currency = version.currency;
    } else if (requestedCycle === current.billing_cycle) {
      unitPricePaise = Number(current.unit_price_paise);
    } else {
      throw new Error('This subscription has no saved pricing version for the requested billing cycle.');
    }

    const nowDate = new Date(now);
    const savedPeriodEnd = new Date(current.current_period_end);
    const periodStart = Number.isNaN(savedPeriodEnd.getTime()) || savedPeriodEnd <= nowDate
      ? nowDate : savedPeriodEnd;
    const invoicePeriodEnd = periodEnd(periodStart, requestedCycle);
    const periodStartText = periodStart.toISOString();
    const invoicePeriodEndText = invoicePeriodEnd.toISOString();
    const amounts = calculateInvoiceAmounts({
      unitPricePaise,
      seats,
      discountPctTenths: 0,
      taxPctTenths: Math.round(taxPct * 10),
      taxInclusive: Number(settings.tax_inclusive) === 1
    });
    const number = await nextInvoiceNumber(transaction, periodStart.getUTCFullYear());
    const subscription = await transaction.execute({
      sql: `INSERT INTO subscriptions (
        company_id, billing_cycle, seats, unit_price_paise, discount_pct, pricing_version_id,
        status, current_period_start, current_period_end, provider
      ) VALUES (?, ?, ?, ?, ?, ?, 'past_due', ?, ?, 'manual')`,
      args: [normalizedCompanyId, requestedCycle, seats, unitPricePaise, discountPct,
        current.pricing_version_id, periodStartText, invoicePeriodEndText]
    });
    const subscriptionId = Number(subscription.lastInsertRowid);
    const invoice = await transaction.execute({
      sql: `INSERT INTO invoices (
        company_id, subscription_id, number, period_start, period_end, seats, unit_price_paise,
        subtotal_paise, discount_paise, tax_paise, total_paise, currency, tax_pct, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      args: [normalizedCompanyId, subscriptionId, number, periodStartText, invoicePeriodEndText,
        seats, unitPricePaise, amounts.subtotalPaise, amounts.discountPaise, amounts.taxPaise,
        amounts.totalPaise, currency, taxPct]
    });
    const invoiceId = Number(invoice.lastInsertRowid);
    await markBillingRequestInvoiced(transaction, admin, normalizedRequestId, invoiceId, Number(current.id));
    await transaction.execute({
      sql: 'INSERT INTO subscription_events (company_id, subscription_id, actor_super_admin_id, event, details) VALUES (?, ?, ?, ?, ?)',
      args: [normalizedCompanyId, subscriptionId, admin.id, 'manual_subscription_change_invoiced',
        `Issued ${requestedCycle} invoice ${number} for ${seats} seats at the subscription's locked price${tier ? ` on the ${tier.name} tier` : ''}.`]
    });
    await transaction.execute({
      sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
      args: [admin.id, normalizedCompanyId, 'Subscription change invoice created',
        `${number}: ${requestedCycle}, ${seats} seats, ${amounts.totalPaise} paise total.`]
    });
    await transaction.commit();
    return {
      subscriptionId, invoiceId, number, billingCycle: requestedCycle, seats,
      unitPricePaise, ...amounts, currency, periodStart: periodStartText,
      periodEnd: invoicePeriodEndText, status: 'open'
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function markManualInvoicePaid(controlDb, admin, { companyId, invoiceId, providerRef = '', now = new Date() }) {
  const normalizedCompanyId = Number(companyId);
  const normalizedInvoiceId = Number(invoiceId);
  if (!Number.isSafeInteger(normalizedCompanyId) || normalizedCompanyId < 1
    || !Number.isSafeInteger(normalizedInvoiceId) || normalizedInvoiceId < 1) {
    throw new TypeError('A valid company and invoice are required.');
  }
  const transaction = await controlDb.transaction('write');
  try {
    const invoiceResult = await transaction.execute({
      sql: `SELECT id, subscription_id, number, total_paise, period_start, period_end
        FROM invoices WHERE id = ? AND company_id = ? AND status = 'open' LIMIT 1`,
      args: [normalizedInvoiceId, normalizedCompanyId]
    });
    const invoice = invoiceResult.rows?.[0];
    if (!invoice) throw new Error('Open invoice not found.');
    const paidAt = now.toISOString();
    const invoiceUpdate = await transaction.execute({
      sql: "UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'open'",
      args: [paidAt, normalizedInvoiceId]
    });
    if (Number(invoiceUpdate.rowsAffected || 0) !== 1) throw new Error('Invoice was already paid or changed.');
    await transaction.execute({
      sql: `UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?,
        cancel_at_period_end = 0 WHERE id = ? AND company_id = ?`,
      args: [invoice.period_start, invoice.period_end, Number(invoice.subscription_id), normalizedCompanyId]
    });
    const changeResult = await transaction.execute({
      sql: 'SELECT id, previous_subscription_id FROM subscription_change_requests WHERE invoice_id = ? AND company_id = ? AND status = \'invoiced\' LIMIT 1',
      args: [normalizedInvoiceId, normalizedCompanyId]
    });
    const previousSubscriptionId = changeResult.rows?.[0]?.previous_subscription_id;
    if (previousSubscriptionId != null) {
      await transaction.execute({
        sql: "UPDATE subscriptions SET status = 'cancelled' WHERE id = ? AND company_id = ? AND id <> ?",
        args: [Number(previousSubscriptionId), normalizedCompanyId, Number(invoice.subscription_id)]
      });
      await transaction.execute({
        sql: 'INSERT INTO subscription_events (company_id, subscription_id, actor_super_admin_id, event, details) VALUES (?, ?, ?, ?, ?)',
        args: [normalizedCompanyId, Number(previousSubscriptionId), admin.id, 'subscription_replaced',
          `Replaced by paid invoice ${invoice.number}.`]
      });
    }
    await transaction.execute({
      sql: 'UPDATE companies SET status = \'active\', delete_after = NULL WHERE id = ?',
      args: [normalizedCompanyId]
    });
    await transaction.execute({
      sql: 'INSERT INTO payments (invoice_id, amount_paise, method, provider_ref) VALUES (?, ?, \'manual\', ?)',
      args: [normalizedInvoiceId, Number(invoice.total_paise), String(providerRef).trim().slice(0, 200) || null]
    });
    await transaction.execute({
      sql: 'INSERT INTO subscription_events (company_id, subscription_id, actor_super_admin_id, event, details) VALUES (?, ?, ?, ?, ?)',
      args: [normalizedCompanyId, Number(invoice.subscription_id), admin.id, 'manual_invoice_paid', `Invoice ${invoice.number} was marked paid.`]
    });
    await transaction.execute({
      sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
      args: [admin.id, normalizedCompanyId, 'Manual invoice marked paid', `Invoice ${invoice.number} paid for ${Number(invoice.total_paise)} paise.`]
    });
    await transaction.commit();
    return { invoiceId: normalizedInvoiceId, number: invoice.number, amountPaise: Number(invoice.total_paise), paidAt };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

module.exports = {
  createManualSubscriptionChangeInvoice,
  createManualSubscriptionInvoice,
  markManualInvoicePaid,
  periodEnd
};