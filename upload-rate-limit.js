'use strict';

const { rateLimit } = require('express-rate-limit');

module.exports = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Please try again later.' }
});