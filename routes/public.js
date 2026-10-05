'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getControlDatabase } = require('../control-db');
const { hasControlDatabaseConfiguration } = require('../tenant-manager');
const { getPricing } = require('../pricing-service');
const { calculateInvoiceAmounts } = require('../lib/pricing');

function createPublicRouter({
  getDatabase = getControlDatabase,
  isConfigured = hasControlDatabaseConfiguration,
  now = () => new Date(),
  cacheDurationMs = 60_000
} = {}) {
  const router = express.Router();
  const demoRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many demo requests. Try again later.' }
  });
  let cached = null;
  let cachedAt = 0;

  router.get('/pricing', async (req, res) => {
    if (!isConfigured()) return res.status(503).json({ error: 'Pricing is temporarily unavailable.' });
    const currentTime = now();
    if (!cached || currentTime.getTime() - cachedAt >= cacheDurationMs) {
      try {
        const controlDb = await getDatabase();
        const pricing = await getPricing(controlDb, currentTime);
        const monthlyPreviews = [1, 10, 50].map(seats => ({
          seats,
          ...calculateInvoiceAmounts({
            unitPricePaise: pricing.monthlyPricePaise,
            seats,
            taxPctTenths: Math.round(pricing.taxPct * 10),
            taxInclusive: pricing.taxInclusive
          })
        }));
        const yearlyPreviews = [1, 10, 50].map(seats => ({
          seats,
          ...calculateInvoiceAmounts({
            unitPricePaise: pricing.yearlyPricePaise,
            seats,
            taxPctTenths: Math.round(pricing.taxPct * 10),
            taxInclusive: pricing.taxInclusive
          })
        }));
        cached = { ...pricing, monthlyPreviews, yearlyPreviews };
        cachedAt = currentTime.getTime();
      } catch (error) {
        return res.status(503).json({ error: 'Pricing is temporarily unavailable.' });
      }
    }
    res.set('Cache-Control', 'public, max-age=60');
    return res.json(cached);
  });

  router.post('/demo-requests', demoRequestLimiter, (req, res, next) => {
    Promise.resolve().then(async () => {
      if (!isConfigured()) return res.status(503).json({ error: 'Demo requests are temporarily unavailable.' });
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Enter your contact and company details.' });
      }
      if (typeof body.website === 'string' && body.website.trim()) {
        res.set('Cache-Control', 'no-store');
        return res.status(202).json({ received: true });
      }

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
      const teamSize = Number(body.teamSize);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
        || phone.length > 40 || !companyName || companyName.length > 160
        || !Number.isSafeInteger(teamSize) || teamSize < 1 || teamSize > 100000
        || message.length > 2000 || body.consent !== true) {
        return res.status(400).json({ error: 'Check the required fields, team size, and consent before submitting.' });
      }

      const controlDb = await getDatabase();
      const created = await controlDb.execute({
        sql: `INSERT INTO demo_requests
          (name, email, phone, company_name, team_size, message, status, consented_at)
          VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
        args: [name, email, phone, companyName, teamSize, message, now().toISOString()]
      });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({ id: Number(created.lastInsertRowid), status: 'pending_review' });
    }).catch(next);
  });

  return {
    router,
    invalidateCache() { cached = null; cachedAt = 0; }
  };
}

module.exports = { createPublicRouter };