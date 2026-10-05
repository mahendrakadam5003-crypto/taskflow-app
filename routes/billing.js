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
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

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
      const [usage, pricing, subscriptionResult, invoiceResult, requestResult] = await Promise.all([
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
          }),
        id == null
          ? Promise.resolve({ rows: [] })
          : controlDb.execute({
            sql: `SELECT id, requested_seats, requested_billing_cycle, status, invoice_id, created_at
              FROM subscription_change_requests WHERE company_id = ? ORDER BY id DESC LIMIT 20`,
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
        billingRequests: requestResult.rows || [],
        usage,
        pricing: {
          currency: pricing.currency,
          currencySymbol: pricing.currencySymbol,
          monthlyPricePaise: pricing.monthlyPricePaise,
          yearlyPricePaise: pricing.yearlyPricePaise,
          yearlyDiscountPct: pricing.yearlyDiscountPct,
          taxPct: pricing.taxPct,
          taxInclusive: pricing.taxInclusive
        },
        billingRules: { minSeats: pricing.minSeats, maxSeats: pricing.maxSeats }
      });
    }).catch(next);
  });

  router.post('/requests', adminMiddleware, (req, res, next) => {
    Promise.resolve().then(async () => {
      const legacy = String(req.companyTenantId) === LEGACY_TENANT_ID;
      const companyId = legacy ? null : Number(req.companyTenantId);
      if (!Number.isSafeInteger(companyId) || companyId < 1) {
        return res.status(400).json({ error: 'Billing requests are not available for this workspace.' });
      }
      const seats = Number(req.body?.seats);
      const billingCycle = req.body?.billingCycle;
      if (!Number.isSafeInteger(seats) || !['monthly', 'yearly'].includes(billingCycle)) {
        return res.status(400).json({ error: 'Choose a valid billing cycle and whole-number seat count.' });
      }
      const controlDb = await getDatabase();
      const [companyResult, usage, pricing, subscriptionResult, openInvoiceResult, pendingResult] = await Promise.all([
        controlDb.execute({
          sql: "SELECT id FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1",
          args: [companyId]
        }),
        (getUsage || require('../limits').getPlanUsage)(req),
        getPricing(controlDb),
        controlDb.execute({
          sql: `SELECT id, seats, billing_cycle FROM subscriptions
            WHERE company_id = ? AND status IN ('active', 'past_due') ORDER BY id DESC LIMIT 1`,
          args: [companyId]
        }),
        controlDb.execute({
          sql: `SELECT i.id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
            WHERE i.company_id = ? AND i.status = 'open' AND s.status = 'past_due' LIMIT 1`,
          args: [companyId]
        }),
        controlDb.execute({
          sql: "SELECT id FROM subscription_change_requests WHERE company_id = ? AND status = 'pending' LIMIT 1",
          args: [companyId]
        })
      ]);
      if (!companyResult.rows?.[0]) return res.status(404).json({ error: 'Company not found.' });
      if (openInvoiceResult.rows?.[0]) return res.status(409).json({ error: 'Resolve the existing open invoice before requesting another billing change.' });
      if (pendingResult.rows?.[0]) return res.status(409).json({ error: 'A billing request is already awaiting review.' });
      const activeUsers = Number(usage?.usage?.activeUsers);
      if (usage?.usage?.activeUsers == null || !Number.isSafeInteger(activeUsers) || activeUsers < 0) {
        throw new Error('Unable to verify the workspace’s active user count.');
      }
      if (seats < Math.max(pricing.minSeats, activeUsers)
        || (pricing.maxSeats !== null && seats > pricing.maxSeats)) {
        return res.status(400).json({
          error: `Seats must be at least ${Math.max(pricing.minSeats, activeUsers)} and no more than ${pricing.maxSeats ?? 'unlimited'}.`
        });
      }
      const currentSubscription = subscriptionResult.rows?.[0];
      if (currentSubscription && Number(currentSubscription.seats) === seats
        && currentSubscription.billing_cycle === billingCycle) {
        return res.status(400).json({ error: 'The requested seats and billing cycle match the current subscription.' });
      }
      const result = await controlDb.execute({
        sql: `INSERT INTO subscription_change_requests
          (company_id, requested_by_user_id, requested_seats, requested_billing_cycle)
          VALUES (?, ?, ?, ?)`,
        args: [companyId, Number(req.authenticatedUser?.id) || null, seats, billingCycle]
      });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({
        id: Number(result.lastInsertRowid), seats, billingCycle, status: 'pending'
      });
    }).catch(error => {
      if (/UNIQUE constraint failed: subscription_change_requests\.company_id/i.test(String(error.message))) {
        return res.status(409).json({ error: 'A billing request is already awaiting review.' });
      }
      return next(error);
    });
  });

  router.get('/invoices/:invoiceId/receipt', adminMiddleware, (req, res, next) => {
    Promise.resolve().then(async () => {
      const legacy = String(req.companyTenantId) === LEGACY_TENANT_ID;
      const companyId = legacy ? null : Number(req.companyTenantId);
      const invoiceId = Number(req.params.invoiceId);
      if (!Number.isSafeInteger(companyId) || companyId < 1
        || !Number.isSafeInteger(invoiceId) || invoiceId < 1) {
        return res.status(400).json({ error: 'A valid company invoice is required.' });
      }
      const controlDb = await getDatabase();
      const result = await controlDb.execute({
        sql: `SELECT i.number, i.period_start, i.period_end, i.total_paise, i.currency, i.paid_at,
            c.name AS company_name, c.code AS company_code, p.method, p.provider_ref
          FROM invoices i JOIN companies c ON c.id = i.company_id
          LEFT JOIN payments p ON p.invoice_id = i.id
          WHERE i.id = ? AND i.company_id = ? AND i.status = 'paid'
          ORDER BY p.id DESC LIMIT 1`,
        args: [invoiceId, companyId]
      });
      const receipt = result.rows?.[0];
      if (!receipt) return res.status(404).json({ error: 'Paid receipt not found.' });
      const number = String(receipt.number).replace(/[^A-Za-z0-9_-]/g, '');
      const paymentReference = receipt.provider_ref || 'Not recorded';
      const amount = `${receipt.currency} ${(Number(receipt.total_paise) / 100).toFixed(2)}`;
      res.set('Cache-Control', 'no-store');
      res.set('Content-Disposition', `attachment; filename="receipt-${number}.html"`);
      res.type('html');
      return res.send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Receipt ${escapeHtml(number)}</title><body><main><h1>Payment receipt</h1><p><strong>Company:</strong> ${escapeHtml(receipt.company_name)} (${escapeHtml(receipt.company_code)})</p><p><strong>Invoice:</strong> ${escapeHtml(receipt.number)}</p><p><strong>Billing period:</strong> ${escapeHtml(receipt.period_start)} – ${escapeHtml(receipt.period_end)}</p><p><strong>Paid:</strong> ${escapeHtml(receipt.paid_at)}</p><p><strong>Amount:</strong> ${escapeHtml(amount)}</p><p><strong>Method:</strong> ${escapeHtml(receipt.method || 'Manual')}</p><p><strong>Reference:</strong> ${escapeHtml(paymentReference)}</p></main></body></html>`);
    }).catch(next);
  });

  return router;
}

module.exports = { createBillingRouter };
