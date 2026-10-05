'use strict';

const express = require('express');
const { getControlDatabase } = require('../control-db');
const { getPricing } = require('../pricing-service');
const { LEGACY_TENANT_ID } = require('../tenant-manager');

function createBillingRouter({
  getDatabase = getControlDatabase,
  getUsage,
  requireAdminMiddleware,
  environment = process.env
} = {}) {
  const router = express.Router();
  const adminMiddleware = requireAdminMiddleware || require('./auth').requireAdmin;

  router.get('/me', adminMiddleware, (req, res, next) => {
    Promise.resolve().then(async () => {
      const legacy = String(req.companyTenantId) === LEGACY_TENANT_ID;
      const companyId = legacy ? null : Number(req.companyTenantId);
      if (!legacy && (!Number.isSafeInteger(companyId) || companyId < 1)) {
        return res.status(400).json({ error: 'A valid company workspace is required.' });
      }

      const controlDb = await getDatabase();
      const companyResult = await controlDb.execute({
        sql: legacy
          ? 'SELECT id, code, name, status, plan_id, trial_ends_at FROM companies WHERE code = ? LIMIT 1'
          : 'SELECT id, code, name, status, plan_id, trial_ends_at FROM companies WHERE id = ? LIMIT 1',
        args: [legacy ? String(environment.LEGACY_COMPANY_CODE || 'existing-company').trim().toLowerCase() : companyId]
      });
      const company = companyResult.rows?.[0] || null;
      const id = company ? Number(company.id) : null;
      const getTenantUsage = getUsage || require('../limits').getPlanUsage;
      const [usage, pricing, subscriptionResult, invoiceResult] = await Promise.all([
        getTenantUsage(req),
        getPricing(controlDb),
        id == null
          ? Promise.resolve({ rows: [] })
          : controlDb.execute({
            sql: 'SELECT id, billing_cycle, seats, unit_price_paise, discount_pct, status, current_period_start, current_period_end, cancel_at_period_end FROM subscriptions WHERE company_id = ? ORDER BY id DESC LIMIT 1',
            args: [id]
          }),
        id == null
          ? Promise.resolve({ rows: [] })
          : controlDb.execute({
            sql: 'SELECT id, number, period_start, period_end, seats, unit_price_paise, subtotal_paise, discount_paise, tax_paise, total_paise, currency, tax_pct, status, paid_at, created_at FROM invoices WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
            args: [id]
          })
      ]);

      res.set('Cache-Control', 'no-store');
      return res.json({
        company: company ? {
          id: Number(company.id),
          code: company.code,
          name: company.name,
          status: company.status,
          trialEndsAt: company.trial_ends_at
        } : {
          id: null,
          code: String(environment.LEGACY_COMPANY_CODE || 'existing-company').trim().toLowerCase(),
          name: req.companyName || 'Existing company',
          status: req.companyStatus || 'active',
          trialEndsAt: null
        },
        subscription: subscriptionResult.rows?.[0] || null,
        invoices: invoiceResult.rows || [],
        usage,
        pricing: {
          currency: pricing.currency,
          currencySymbol: pricing.currencySymbol,
          monthlyPricePaise: pricing.monthlyPricePaise,
          yearlyPricePaise: pricing.yearlyPricePaise,
          yearlyDiscountPct: pricing.yearlyDiscountPct,
          taxPct: pricing.taxPct,
          taxInclusive: pricing.taxInclusive
        }
      });
    }).catch(next);
  });

  return router;
}

module.exports = { createBillingRouter };
