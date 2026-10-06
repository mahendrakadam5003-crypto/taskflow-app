'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getControlDatabase } = require('../control-db');
const { hasControlDatabaseConfiguration } = require('../tenant-manager');
const { getPricing } = require('../pricing-service');
const { calculateInvoiceAmounts, calculateTierQuote } = require('../lib/pricing');

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
        const quoteTiers = pricing.tiers.length ? pricing.tiers : [{
          key: 'standard',
          name: 'Standard',
          tagline: '',
          highlights: [],
          minSeats: 1,
          maxSeats: null,
          monthlyPricePaise: pricing.monthlyPricePaise,
          yearlyPricePaise: pricing.yearlyPricePaise
        }];
        const tiers = quoteTiers.map(tier => {
          const yearlyQuote = calculateTierQuote({
            tiers: quoteTiers,
            seats: tier.minSeats,
            cycle: 'yearly',
            taxPctTenths: Math.round(pricing.taxPct * 10),
            taxInclusive: pricing.taxInclusive
          });
          return {
            key: tier.key,
            name: tier.name,
            tagline: tier.tagline,
            highlights: tier.highlights,
            minSeats: tier.minSeats,
            maxSeats: tier.maxSeats,
            monthlyPricePaise: tier.monthlyPricePaise,
            yearlyPricePaise: tier.yearlyPricePaise,
            yearlyMonthlyEquivalentPaise: yearlyQuote.monthlyEquivalentPaise
          };
        });
        const quote = (seats, cycle) => {
          const result = calculateTierQuote({
            tiers: quoteTiers,
            seats,
            cycle,
            taxPctTenths: Math.round(pricing.taxPct * 10),
            taxInclusive: pricing.taxInclusive
          });
          return {
            seats,
            tier: { key: result.tier.key, name: result.tier.name },
            unitPricePaise: result.unitPricePaise,
            subtotalPaise: result.subtotalPaise,
            discountPaise: result.discountPaise,
            taxPaise: result.taxPaise,
            totalPaise: result.totalPaise,
            monthlyEquivalentPaise: result.monthlyEquivalentPaise,
            yearlySavingsPaise: result.yearlySavingsPaise
          };
        };
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
        cached = {
          monthlyPricePaise: pricing.monthlyPricePaise,
          yearlyDiscountPct: pricing.yearlyDiscountPct,
          yearlyPricePaise: pricing.yearlyPricePaise,
          taxPct: pricing.taxPct,
          currency: pricing.currency,
          currencySymbol: pricing.currencySymbol,
          taxInclusive: pricing.taxInclusive,
          minSeats: pricing.minSeats,
          maxSeats: pricing.maxSeats,
          tiers,
          quotes: {
            monthly: [1, 5, 10, 11, 25, 100].map(seats => quote(seats, 'monthly')),
            yearly: [5, 10, 11, 25].map(seats => quote(seats, 'yearly'))
          },
          monthlyPreviews,
          yearlyPreviews
        };
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