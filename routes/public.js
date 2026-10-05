'use strict';

const express = require('express');
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

  return {
    router,
    invalidateCache() { cached = null; cachedAt = 0; }
  };
}

module.exports = { createPublicRouter };