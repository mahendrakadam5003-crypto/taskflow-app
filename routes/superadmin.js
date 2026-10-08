'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getControlDatabase } = require('../control-db');
const { provisionCompany: defaultProvisionCompany, ProvisioningError } = require('../company-provisioning');
const { createBackupManager } = require('../backup-manager');
const { getPricing, savePricing, validatePricingInput } = require('../pricing-service');
const { calculateTierQuote } = require('../lib/pricing');
const {
  createManualSubscriptionChangeInvoice,
  createManualSubscriptionInvoice,
  markManualInvoicePaid
} = require('../billing-service');

const COOKIE_NAME = 'taskflow.superadmin.sid';
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
const SUPPORT_MODE_DURATION_MS = 30 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const COMPANY_STATUSES = new Set(['trial', 'active', 'suspended', 'cancelled']);
const PLAN_FEATURES = ['attendance', 'reimbursements', 'export'];

function buildPricingPreview(pricing) {
  const tiers = pricing.tiers?.length ? pricing.tiers : [{
    key: 'standard',
    name: 'Standard',
    minSeats: 1,
    maxSeats: null,
    monthlyPricePaise: pricing.monthlyPricePaise,
    yearlyPricePaise: pricing.yearlyPricePaise
  }];
  const taxPctTenths = pricing.taxTenths ?? Math.round(pricing.taxPct * 10);
  const taxInclusive = pricing.taxInclusive === true || pricing.taxInclusive === 1;
  const quote = (seats, cycle) => {
    const result = calculateTierQuote({ tiers, seats, cycle, taxPctTenths, taxInclusive });
    return {
      tierName: result.tier.name,
      unitPricePaise: result.unitPricePaise,
      subtotalPaise: result.subtotalPaise,
      taxPaise: result.taxPaise,
      totalPaise: result.totalPaise,
      monthlyEquivalentPaise: result.monthlyEquivalentPaise,
      yearlySavingsPaise: result.yearlySavingsPaise
    };
  };
  const preview = [1, 5, 10, 11, 25, 50, 100].map(seats => ({
    seats,
    monthly: quote(seats, 'monthly'),
    yearly: quote(seats, 'yearly')
  }));
  const warnings = [];
  for (let index = 1; index < preview.length; index += 1) {
    const previous = preview[index - 1];
    const current = preview[index];
    for (const cycle of ['monthly', 'yearly']) {
      if (current[cycle].totalPaise < previous[cycle].totalPaise) {
        warnings.push({
          cycle,
          lowerSeats: previous.seats,
          higherSeats: current.seats,
          lowerTotalPaise: previous[cycle].totalPaise,
          higherTotalPaise: current[cycle].totalPaise
        });
      }
    }
  }
  return { preview, warnings, taxInclusive };
}

function validatePlan(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const maxUsers = body.maxUsers === null || body.maxUsers === '' ? null : Number(body.maxUsers);
  const storageLimitMb = body.storageLimitMb === null || body.storageLimitMb === '' ? null : Number(body.storageLimitMb);
  const priceNote = typeof body.priceNote === 'string' ? body.priceNote.trim() : '';
  if (!name || name.length > 80
    || (maxUsers !== null && (!Number.isSafeInteger(maxUsers) || maxUsers < 0))
    || (storageLimitMb !== null && (!Number.isSafeInteger(storageLimitMb) || storageLimitMb < 0))
    || priceNote.length > 500) return null;
  const features = Object.fromEntries(PLAN_FEATURES.map(feature => [feature, body.features?.[feature] === true]));
  if (body.features && (typeof body.features !== 'object' || Array.isArray(body.features)
    || Object.keys(body.features).some(feature => !PLAN_FEATURES.includes(feature))
    || Object.values(body.features).some(value => typeof value !== 'boolean'))) return null;
  return { name, maxUsers, storageLimitMb, priceNote, features, isActive: body.isActive === false ? 0 : 1 };
}

function sessionAction(req, action) {
  return new Promise((resolve, reject) => req.session[action](error => error ? reject(error) : resolve()));
}

function sessionSave(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

async function writeAudit(controlDb, admin, companyId, action, details) {
  await controlDb.execute({
    sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
    args: [admin?.id ?? null, companyId ?? null, action, String(details || '').slice(0, 2000)]
  });
}

function safeLimitOverride(value) {
  if (value === null || value === '') return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : undefined;
}

async function measureTenantUsage(database, companyId) {
  if (typeof database.runWithTenant !== 'function') {
    const error = new Error('Live tenant usage is unavailable.');
    error.code = 'TENANT_USAGE_UNAVAILABLE';
    throw error;
  }
  return database.runWithTenant(companyId, async () => {
    const [activeUsers, pageCount, pageSize, fileUsage] = await Promise.all([
      database.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get(),
      database.prepare('PRAGMA page_count').get(),
      database.prepare('PRAGMA page_size').get(),
      database.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM file_usage').get()
    ]);
    const userCount = Number(activeUsers?.count ?? activeUsers?.COUNT);
    const pages = Number(pageCount?.page_count ?? pageCount?.PAGE_COUNT);
    const bytesPerPage = Number(pageSize?.page_size ?? pageSize?.PAGE_SIZE);
    const fileBytes = Number(fileUsage?.bytes ?? fileUsage?.BYTES);
    if (!Number.isSafeInteger(userCount) || userCount < 0
      || !Number.isSafeInteger(pages) || pages < 0
      || !Number.isSafeInteger(bytesPerPage) || bytesPerPage < 1
      || !Number.isSafeInteger(fileBytes) || fileBytes < 0) {
      throw new Error('Tenant usage query returned invalid storage values.');
    }
    const databaseBytes = pages * bytesPerPage;
    const storageBytes = databaseBytes + fileBytes;
    if (!Number.isSafeInteger(databaseBytes) || !Number.isSafeInteger(storageBytes)) {
      throw new Error('Tenant usage exceeds the supported byte range.');
    }
    return { userCount, databaseBytes, fileBytes, storageBytes };
  });
}

function createSuperAdminPageHandler(htmlPath) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(htmlPath);
  };
}

function digestSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readSessionToken(cookieHeader = '', cookieName = COOKIE_NAME) {
  for (const entry of String(cookieHeader).split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== cookieName) continue;
    const value = entry.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

function setSessionCookie(res, token, { secureCookies, maxAge = SESSION_DURATION_MS }) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'strict',
    path: '/api/superadmin',
    maxAge
  });
}

function clearSessionCookie(res, { secureCookies }) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'strict',
    path: '/api/superadmin'
  });
}

function createSuperAdminRouter({
  getDatabase = getControlDatabase,
  secureCookies = process.env.RENDER === 'true',
  provisionCompany = defaultProvisionCompany,
  tenantDatabase,
  backupDirectory = path.join(__dirname, '..', 'backups'),
  backupManager,
  invalidatePublicPricing = () => {}
} = {}) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again later.' }
  });
  const demoRequestsInProvisioning = new Set();

  const handle = callback => (req, res, next) => {
    Promise.resolve(callback(req, res, next)).catch(next);
  };
  const getTenantDatabase = () => tenantDatabase || require('../db');
  const getBackupManager = () => backupManager || createBackupManager({ getDatabase, tenantDatabase, backupDirectory });

  async function getAuthenticatedAdmin(req) {
    const token = readSessionToken(req.get('Cookie'));
    if (!token) return null;
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql:             `SELECT a.id, a.name, a.username, a.token_version AS admin_token_version,
          s.token_version AS session_token_version, s.expires_at
        FROM super_admin_sessions s
        JOIN super_admins a ON a.id = s.super_admin_id
        WHERE s.sid_hash = ?`,
      args: [digestSessionToken(token)]
    });
    const sessionRow = result.rows?.[0];
    if (!sessionRow || Number(sessionRow.expires_at) <= Date.now()
      || Number(sessionRow.session_token_version) !== Number(sessionRow.admin_token_version)) {
      if (sessionRow) {
        await controlDb.execute({ sql: 'DELETE FROM super_admin_sessions WHERE sid_hash = ?', args: [digestSessionToken(token)] });
      }
      return null;
    }
    return { id: Number(sessionRow.id), name: sessionRow.name, username: sessionRow.username };
  }

  router.post('/login', loginLimiter, handle(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 80) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || /[\u0000-\u001f\u007f]/.test(username) || !password || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Enter your username and password.' });
    }
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: 'SELECT id, name, username, password_hash, token_version FROM super_admins WHERE lower(username) = ? LIMIT 1',
      args: [username]
    });
    const admin = result.rows?.[0];
    const validPassword = await bcrypt.compare(password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!admin || !validPassword) return res.status(401).json({ error: 'Username or password is incorrect.' });

    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const sidHash = digestSessionToken(token);
    await controlDb.batch([
      {
        sql: 'INSERT INTO super_admin_sessions (sid_hash, super_admin_id, token_version, expires_at) VALUES (?, ?, ?, ?)',
        args: [sidHash, Number(admin.id), Number(admin.token_version), now + SESSION_DURATION_MS]
      },
      {
        sql: 'INSERT INTO super_admin_audit (super_admin_id, action, details) VALUES (?, ?, ?)',
        args: [Number(admin.id), 'Super-admin signed in', 'Super-admin control panel login']
      },
      {
        sql: 'DELETE FROM super_admin_sessions WHERE expires_at <= ?',
        args: [now]
      }
    ], 'write');
    setSessionCookie(res, token, { secureCookies });
    res.set('Cache-Control', 'no-store');
    return res.json({ authenticated: true, admin: { name: admin.name, username: admin.username } });
  }));

  router.post('/companies/:companyId/billing-requests/:requestId/invoice', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const requestId = Number(req.params.requestId);
    if (!Number.isSafeInteger(companyId) || companyId < 1
      || !Number.isSafeInteger(requestId) || requestId < 1) {
      return res.status(400).json({ error: 'Choose a valid company and billing request.' });
    }
    const controlDb = await getDatabase();
    const [requestResult, subscriptionResult] = await Promise.all([
      controlDb.execute({
        sql: `SELECT requested_seats, requested_billing_cycle FROM subscription_change_requests
          WHERE id = ? AND company_id = ? AND status = 'pending' LIMIT 1`,
        args: [requestId, companyId]
      }),
      controlDb.execute({
        sql: `SELECT id FROM subscriptions WHERE company_id = ?
          ORDER BY id DESC LIMIT 1`,
        args: [companyId]
      })
    ]);
    const billingRequest = requestResult.rows?.[0];
    if (!billingRequest) return res.status(409).json({ error: 'Pending billing request not found.' });
    const tenantDb = getTenantDatabase();
    const activeUsers = await tenantDb.runWithTenant(companyId, async () => {
      const result = await tenantDb.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get();
      return Number(result?.count);
    });
    if (!Number.isSafeInteger(activeUsers) || activeUsers < 0) {
      throw new Error('Unable to verify the company’s active user count before invoicing.');
    }
    if (Number(billingRequest.requested_seats) < activeUsers) {
      return res.status(409).json({ error: `The company now has ${activeUsers} active users. Update the request to at least that seat count.` });
    }
    try {
      const invoice = subscriptionResult.rows?.[0]
        ? await createManualSubscriptionChangeInvoice(controlDb, admin, { companyId, requestId })
        : await createManualSubscriptionInvoice(controlDb, admin, {
          companyId, requestId,
          billingCycle: billingRequest.requested_billing_cycle,
          seats: Number(billingRequest.requested_seats)
        });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json(invoice);
    } catch (error) {
      if (/Company not found/.test(String(error.message))) return res.status(404).json({ error: error.message });
      if (/Pending billing request not found|Paid subscription not found|already has a paid subscription/.test(String(error.message))) {
        return res.status(409).json({ error: error.message });
      }
      if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }));

  router.post('/companies/:companyId/billing-requests/:requestId/reject', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const requestId = Number(req.params.requestId);
    if (!Number.isSafeInteger(companyId) || companyId < 1
      || !Number.isSafeInteger(requestId) || requestId < 1) {
      return res.status(400).json({ error: 'Choose a valid company and billing request.' });
    }
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `UPDATE subscription_change_requests
        SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now')
        WHERE id = ? AND company_id = ? AND status = 'pending'`,
      args: [admin.id, requestId, companyId]
    });
    if (Number(result.rowsAffected || 0) !== 1) return res.status(404).json({ error: 'Pending billing request not found.' });
    await writeAudit(controlDb, admin, companyId, 'Billing request rejected', `Billing request ${requestId} was rejected.`);
    res.set('Cache-Control', 'no-store');
    return res.json({ id: requestId, status: 'rejected' });
  }));

  router.get('/session', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    res.set('Cache-Control', 'no-store');
    if (!admin) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, admin });
  }));

  router.post('/logout', handle(async (req, res) => {
    const token = readSessionToken(req.get('Cookie'));
    if (token) {
      const controlDb = await getDatabase();
      const sidHash = digestSessionToken(token);
      const sessionResult = await controlDb.execute({
        sql: 'SELECT super_admin_id FROM super_admin_sessions WHERE sid_hash = ?',
        args: [sidHash]
      });
      if (sessionResult.rows?.[0]) {
        await controlDb.batch([
          { sql: 'DELETE FROM super_admin_sessions WHERE sid_hash = ?', args: [sidHash] },
          {
            sql: 'INSERT INTO super_admin_audit (super_admin_id, action, details) VALUES (?, ?, ?)',
            args: [Number(sessionResult.rows[0].super_admin_id), 'Super-admin signed out', 'Super-admin control panel logout']
          }
        ], 'write');
      }
    }
    clearSessionCookie(res, { secureCookies });
    res.set('Cache-Control', 'no-store');
    return res.json({ authenticated: false });
  }));

  router.get('/pricing', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const pricing = await getPricing(controlDb);
    const subscriptions = await controlDb.execute("SELECT COUNT(*) AS count FROM subscriptions WHERE status IN ('active', 'past_due')");
    const { preview, warnings, taxInclusive } = buildPricingPreview(pricing);
    res.set('Cache-Control', 'no-store');
    return res.json({
      pricing, preview, warnings, taxInclusive,
      affectedExistingSubscriptions: Number(subscriptions.rows?.[0]?.count || 0)
    });
  }));

  router.post('/pricing', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 72) {
      return res.status(400).json({ error: 'Re-enter your super-admin password to confirm pricing changes.' });
    }
    const controlDb = await getDatabase();
    const passwordResult = await controlDb.execute({
      sql: 'SELECT password_hash FROM super_admins WHERE id = ? LIMIT 1',
      args: [admin.id]
    });
    if (!passwordResult.rows?.[0] || !await bcrypt.compare(currentPassword, passwordResult.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Super-admin password confirmation failed.' });
    }
    const parsed = validatePricingInput(req.body);
    if (!parsed) return res.status(400).json({ error: 'Check prices, percentages, trial settings, limits, currency, and effective date.' });
    const saved = await savePricing(controlDb, admin, parsed);
    invalidatePublicPricing();
    res.set('Cache-Control', 'no-store');
    return res.json({ saved: true, pricing: saved });
  }));

  router.post('/pricing/preview', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const pricing = validatePricingInput(req.body);
    if (!pricing) return res.status(400).json({ error: 'Check prices, percentages, trial settings, limits, currency, and effective date.' });
    const controlDb = await getDatabase();
    const subscriptions = await controlDb.execute("SELECT COUNT(*) AS count FROM subscriptions WHERE status IN ('active', 'past_due')");
    const { preview, warnings, taxInclusive } = buildPricingPreview(pricing);
    return res.json({
      preview, warnings, taxInclusive,
      affectedExistingSubscriptions: Number(subscriptions.rows?.[0]?.count || 0)
    });
  }));

  router.post('/companies/:companyId/subscriptions', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const seats = Number(req.body?.seats);
    const billingCycle = req.body?.billingCycle;
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(seats) || !['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'Choose a valid company, billing cycle, and whole-number seat count.' });
    }
    const controlDb = await getDatabase();
    try {
      const invoice = await createManualSubscriptionInvoice(controlDb, admin, { companyId, billingCycle, seats });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json(invoice);
    } catch (error) {
      if (/Company not found/.test(String(error.message))) return res.status(404).json({ error: error.message });
      if (/already has a paid subscription/.test(String(error.message))) return res.status(409).json({ error: error.message });
      if (error instanceof TypeError || error instanceof RangeError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }));

  router.get('/companies/:companyId/invoices', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    if (!Number.isSafeInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a valid company.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `SELECT id, subscription_id, number, period_start, period_end, seats, unit_price_paise,
        subtotal_paise, discount_paise, tax_paise, total_paise, currency, tax_pct, status, paid_at, created_at
        FROM invoices WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      args: [companyId]
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ invoices: result.rows || [] });
  }));

  router.get('/invoices', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    if (req.query.status !== undefined && typeof req.query.status !== 'string') {
      return res.status(400).json({ error: 'Choose a valid invoice status filter.' });
    }
    const status = req.query.status === undefined ? 'all' : req.query.status;
    const filters = {
      all: "i.status IN ('open', 'paid')",
      open: "i.status = 'open' AND (i.due_at IS NULL OR julianday(i.due_at) >= julianday('now'))",
      overdue: "i.status = 'open' AND julianday(i.due_at) < julianday('now')",
      paid: "i.status = 'paid'"
    };
    if (!Object.hasOwn(filters, status)) return res.status(400).json({ error: 'Choose a valid invoice status filter.' });
    const requestedPage = req.query.page === undefined ? 1
      : typeof req.query.page === 'string' ? Number(req.query.page) : Number.NaN;
    const pageSize = req.query.pageSize === undefined ? 25
      : typeof req.query.pageSize === 'string' ? Number(req.query.pageSize) : Number.NaN;
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return res.status(400).json({ error: 'Choose a valid invoice page and page size (1–100).' });
    }
    const controlDb = await getDatabase();
    const countResult = await controlDb.execute(`SELECT COUNT(*) AS total_count FROM invoices i WHERE ${filters[status]}`);
    const totalCount = Number(countResult.rows?.[0]?.total_count || 0);
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error('The invoice count is invalid.');
    const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const result = await controlDb.execute({
      sql: `SELECT i.id, i.company_id, c.name AS company_name, c.code AS company_code,
          i.number, i.period_start, i.period_end, i.seats, i.unit_price_paise, i.subtotal_paise,
          i.discount_paise, i.tax_paise, i.total_paise, i.currency, i.tax_pct, i.due_at,
          i.paid_at, i.created_at,
          CASE WHEN i.status = 'open' AND julianday(i.due_at) < julianday('now')
            THEN 'overdue' ELSE i.status END AS status
        FROM invoices i JOIN companies c ON c.id = i.company_id
        WHERE ${filters[status]}
        ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`,
      args: [pageSize, (page - 1) * pageSize]
    });
    res.set('Cache-Control', 'no-store');
    return res.json({
      invoices: (result.rows || []).map(row => ({
        id: Number(row.id),
        companyId: Number(row.company_id),
        companyName: row.company_name,
        companyCode: row.company_code,
        number: row.number,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        seats: Number(row.seats),
        unitPricePaise: Number(row.unit_price_paise),
        subtotalPaise: Number(row.subtotal_paise),
        discountPaise: Number(row.discount_paise),
        taxPaise: Number(row.tax_paise),
        totalPaise: Number(row.total_paise),
        currency: row.currency,
        taxPct: Number(row.tax_pct),
        dueAt: row.due_at,
        paidAt: row.paid_at,
        createdAt: row.created_at,
        status: row.status
      })),
      page,
      pageSize,
      pageCount,
      totalCount
    });
  }));

  router.get('/billing-requests', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute(`SELECT r.id, r.company_id, c.name AS company_name,
        c.code AS company_code, r.requested_seats, r.requested_billing_cycle, r.created_at
      FROM subscription_change_requests r
      JOIN companies c ON c.id = r.company_id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC, r.id ASC`);
    res.set('Cache-Control', 'no-store');
    return res.json({
      requests: (result.rows || []).map(row => ({
        id: Number(row.id),
        companyId: Number(row.company_id),
        companyName: row.company_name,
        companyCode: row.company_code,
        seats: Number(row.requested_seats),
        billingCycle: row.requested_billing_cycle,
        createdAt: row.created_at
      }))
    });
  }));

  router.post('/companies/:companyId/invoices/:invoiceId/paid', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const invoiceId = Number(req.params.invoiceId);
    const providerRef = typeof req.body?.providerRef === 'string' ? req.body.providerRef.trim().slice(0, 200) : '';
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(invoiceId) || invoiceId < 1) {
      return res.status(400).json({ error: 'Choose a valid company and invoice.' });
    }
    const controlDb = await getDatabase();
    try {
      const payment = await markManualInvoicePaid(controlDb, admin, { companyId, invoiceId, providerRef });
      res.set('Cache-Control', 'no-store');
      return res.json(payment);
    } catch (error) {
      if (/Open invoice not found/.test(String(error.message))) return res.status(404).json({ error: error.message });
      if (/already paid or changed/.test(String(error.message))) return res.status(409).json({ error: error.message });
      if (error instanceof TypeError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }));

  router.get('/user-errors', handle(async (req, res) => {
    let phase = 'admin_authentication';
    let controlDb;
    let reportQueryStartedAt = null;
    const slowRequestTimer = setTimeout(async () => {
      let select1Ms = null;
      if (controlDb) {
        const select1StartedAt = Date.now();
        try {
          await controlDb.execute('SELECT 1');
          select1Ms = Date.now() - select1StartedAt;
        } catch (error) {
          select1Ms = Date.now() - select1StartedAt;
        }
      }
      console.warn(JSON.stringify({
        event: 'superadmin_user_errors_slow',
        phase,
        request_id: req.requestId || null,
        select1_ms: select1Ms,
        query_ms: reportQueryStartedAt == null ? null : Date.now() - reportQueryStartedAt
      }));
    }, 5000);
    try {
      const admin = await getAuthenticatedAdmin(req);
      if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
      phase = 'control_database_connection';
      controlDb = await getDatabase();
      const status = req.query.status === 'all' ? 'all' : 'open';
      const limit = 50;
      const requestedOffset = Number(req.query.offset || 0);
      if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 5_000) {
        return res.status(400).json({ error: 'Choose a valid error report page.' });
      }
      const errorQuery = status === 'all'
        ? {
          sql: `SELECT e.id, e.company_id, e.company_code, e.actor_user_id, e.request_id,
            e.event, e.method, e.route, e.status_code, e.created_at, e.resolved_at,
            c.name AS company_name, c.code AS registered_company_code
            FROM user_error_reports e LEFT JOIN companies c ON c.id = e.company_id
            ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
          args: [limit + 1, requestedOffset]
        }
        : {
          sql: `SELECT e.id, e.company_id, e.company_code, e.actor_user_id, e.request_id,
            e.event, e.method, e.route, e.status_code, e.created_at, e.resolved_at,
            c.name AS company_name, c.code AS registered_company_code
            FROM user_error_reports e LEFT JOIN companies c ON c.id = e.company_id
            WHERE e.resolved_at IS NULL
            ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
          args: [limit + 1, requestedOffset]
        };
      phase = 'report_list_query';
      reportQueryStartedAt = Date.now();
      const errorsResult = await controlDb.execute(errorQuery);
      const queryMs = Date.now() - reportQueryStartedAt;
      const errorRows = errorsResult.rows || [];
      console.info(JSON.stringify({
        event: 'superadmin_user_errors_query_complete',
        request_id: req.requestId || null,
        query_ms: queryMs,
        rows_returned: errorRows.length
      }));
      const hasMore = errorRows.length > limit;
      const reportRows = errorRows.slice(0, limit);
      const diagnosticsById = new Map();
      if (reportRows.length) {
        phase = 'report_diagnostics_query';
        const diagnosticsStartedAt = Date.now();
        const diagnosticsResult = await controlDb.execute({
          sql: `SELECT id, diagnostics FROM user_error_reports WHERE id IN (${reportRows.map(() => '?').join(', ')})`,
          args: reportRows.map(row => row.id)
        });
        for (const row of diagnosticsResult.rows || []) diagnosticsById.set(Number(row.id), row.diagnostics || null);
        console.info(JSON.stringify({
          event: 'superadmin_user_errors_diagnostics_complete',
          request_id: req.requestId || null,
          query_ms: Date.now() - diagnosticsStartedAt,
          rows_returned: diagnosticsResult.rows?.length || 0
        }));
      }
      res.set('Cache-Control', 'no-store');
      return res.json({
        pendingCount: status === 'open'
          ? requestedOffset + Math.min(errorRows.length, limit) + (hasMore ? 1 : 0)
          : null,
        pendingCountHasMore: status === 'open' && hasMore,
        hasMore,
        errors: reportRows.map(row => ({
          id: Number(row.id),
          companyId: row.company_id == null ? null : Number(row.company_id),
          companyCode: row.registered_company_code || row.company_code || null,
          companyName: row.company_name || null,
          actorUserId: row.actor_user_id == null ? null : Number(row.actor_user_id),
          requestId: row.request_id,
          event: row.event,
          method: row.method,
          route: row.route,
          statusCode: Number(row.status_code),
          diagnostics: (() => {
            try {
              const parsed = JSON.parse(diagnosticsById.get(Number(row.id)) || '[]');
              return Array.isArray(parsed) ? parsed.slice(0, 4) : [];
            } catch (error) {
              return [];
            }
          })(),
          createdAt: row.created_at,
          resolvedAt: row.resolved_at
        }))
      });
    } finally {
      clearTimeout(slowRequestTimer);
    }
  }));

  router.post('/user-errors/:errorId/resolve', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const errorId = Number(req.params.errorId);
    if (!Number.isSafeInteger(errorId) || errorId < 1) return res.status(400).json({ error: 'Choose a valid error report.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `UPDATE user_error_reports SET resolved_at = datetime('now'), resolved_by = ?
        WHERE id = ? AND resolved_at IS NULL`,
      args: [admin.id, errorId]
    });
    if (Number(result.rowsAffected || 0) !== 1) return res.status(404).json({ error: 'Open error report not found.' });
    await writeAudit(controlDb, admin, null, 'User error report resolved', `Error report ${errorId} was reviewed and resolved.`);
    res.set('Cache-Control', 'no-store');
    return res.json({ id: errorId, resolved: true });
  }));

  router.get('/overview', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const [statusResult, companiesResult, plansResult, subscriptionsResult, invoicesResult, demoRequestsResult] = await Promise.all([
      controlDb.execute(`SELECT status, COUNT(*) AS company_count
        FROM companies WHERE status <> 'deleted' GROUP BY status`),
      controlDb.execute(`SELECT c.id, c.code, c.name, c.owner_name, c.owner_email, c.status, c.plan_id,
          c.trial_ends_at, c.created_at, c.last_login_at, c.delete_after, c.max_users_override, c.storage_limit_mb_override,
          p.name AS plan_name, p.max_users, p.storage_limit_mb,
          u.user_count, u.db_bytes, u.files_bytes, u.taken_at AS usage_taken_at,
          s.billing_cycle, s.status AS subscription_status, s.current_period_end AS renews_at,
          s.cancel_at_period_end
        FROM companies c
        LEFT JOIN plans p ON p.id = c.plan_id
        LEFT JOIN subscriptions s ON s.id = (
          SELECT latest.id FROM subscriptions latest
          WHERE latest.company_id = c.id ORDER BY latest.id DESC LIMIT 1
        )
        LEFT JOIN usage_snapshots u ON u.id = (
          SELECT latest.id FROM usage_snapshots latest
          WHERE latest.company_id = c.id ORDER BY latest.taken_at DESC, latest.id DESC LIMIT 1
        )
        WHERE c.status <> 'deleted'
        ORDER BY c.created_at DESC, c.id DESC`),
      controlDb.execute(`SELECT id, name, max_users, storage_limit_mb
        FROM plans WHERE is_active = 1 ORDER BY id`),
      controlDb.execute(`SELECT company_id, billing_cycle, seats, unit_price_paise
        FROM subscriptions WHERE status = 'active'`),
      controlDb.execute(`SELECT total_paise, currency, due_at
        FROM invoices WHERE status = 'open'`),
      controlDb.execute(`SELECT COUNT(*) AS new_request_count
        FROM demo_requests WHERE status = 'new' AND company_id IS NULL`)
    ]);
    const companies = companiesResult.rows.map(row => ({
      id: Number(row.id),
      code: row.code,
      name: row.name,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      status: row.status,
      planName: row.plan_name,
      maxUsers: row.max_users_override == null
        ? (row.max_users == null ? null : Number(row.max_users)) : Number(row.max_users_override),
      storageLimitMb: row.storage_limit_mb_override == null
        ? (row.storage_limit_mb == null ? null : Number(row.storage_limit_mb)) : Number(row.storage_limit_mb_override),
      userCount: row.user_count == null ? null : Number(row.user_count),
      dbBytes: row.db_bytes == null ? null : Number(row.db_bytes),
      filesBytes: row.files_bytes == null ? null : Number(row.files_bytes),
      planId: row.plan_id == null ? null : Number(row.plan_id),
      usageTakenAt: row.usage_taken_at,
      lastLoginAt: row.last_login_at,
      deleteAfter: row.delete_after,
      trialEndsAt: row.trial_ends_at,
      billingCycle: row.billing_cycle,
      subscriptionStatus: row.subscription_status,
      renewsAt: row.renews_at,
      cancelAtPeriodEnd: Number(row.cancel_at_period_end) === 1,
      createdAt: row.created_at
    }));
    const statusCounts = Object.fromEntries(statusResult.rows.map(row => [row.status, Number(row.company_count)]));
    const latestUsage = companies.filter(company => company.userCount !== null);
    let monthlyRecurringRevenuePaise = 0n;
    let paidSeats = 0;
    const paidCompanyIds = new Set();
    for (const subscription of subscriptionsResult.rows || []) {
      const seats = Number(subscription.seats);
      const unitPricePaise = Number(subscription.unit_price_paise);
      if (!Number.isSafeInteger(seats) || seats < 1
        || !Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) {
        throw new Error('An active subscription has invalid seat or price data.');
      }
      const periodRevenue = BigInt(unitPricePaise) * BigInt(seats);
      monthlyRecurringRevenuePaise += subscription.billing_cycle === 'yearly'
        ? (periodRevenue * 2n + 12n) / 24n
        : periodRevenue;
      paidSeats += seats;
      paidCompanyIds.add(Number(subscription.company_id));
    }
    const annualRecurringRevenuePaise = monthlyRecurringRevenuePaise * 12n;
    if (monthlyRecurringRevenuePaise > BigInt(Number.MAX_SAFE_INTEGER)
      || annualRecurringRevenuePaise > BigInt(Number.MAX_SAFE_INTEGER)
      || !Number.isSafeInteger(paidSeats)) {
      throw new Error('Active subscription totals exceed the supported range.');
    }
    const now = Date.now();
    const twoDaysFromNow = now + 2 * 24 * 60 * 60 * 1000;
    const sevenDaysFromNow = now + 7 * 24 * 60 * 60 * 1000;
    const trialEndingSoonCount = companies.filter(company => {
      if (company.status !== 'trial' || !company.trialEndsAt) return false;
      const end = new Date(/^\d{4}-\d{2}-\d{2}$/.test(company.trialEndsAt)
        ? `${company.trialEndsAt}T23:59:59.999Z` : company.trialEndsAt).getTime();
      return Number.isFinite(end) && end >= now && end <= twoDaysFromNow;
    }).length;
    const trialsEndingIn7DaysCount = companies.filter(company => {
      if (company.status !== 'trial' || !company.trialEndsAt) return false;
      const end = new Date(/^\d{4}-\d{2}-\d{2}$/.test(company.trialEndsAt)
        ? `${company.trialEndsAt}T23:59:59.999Z` : company.trialEndsAt).getTime();
      return Number.isFinite(end) && end >= now && end <= sevenDaysFromNow;
    }).length;
    const invoiceTotals = {
      open: { count: 0, amounts: new Map() },
      overdue: { count: 0, amounts: new Map() }
    };
    for (const invoice of invoicesResult.rows || []) {
      const amountPaise = Number(invoice.total_paise);
      const currency = String(invoice.currency || 'INR').trim().toUpperCase();
      if (!Number.isSafeInteger(amountPaise) || amountPaise < 0 || !/^[A-Z]{3}$/.test(currency)) {
        throw new Error('An open invoice has invalid amount or currency data.');
      }
      const dueAt = invoice.due_at ? new Date(invoice.due_at).getTime() : NaN;
      if (!Number.isFinite(dueAt)) throw new Error('An open invoice has an invalid due date.');
      const bucket = dueAt < now ? invoiceTotals.overdue : invoiceTotals.open;
      const total = (bucket.amounts.get(currency) || 0n) + BigInt(amountPaise);
      if (total > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(bucket.count + 1)) {
        throw new Error('Open invoice totals exceed the supported range.');
      }
      bucket.amounts.set(currency, total);
      bucket.count += 1;
    }
    const invoiceSummary = Object.fromEntries(Object.entries(invoiceTotals).map(([status, totals]) => [
      status,
      {
        count: totals.count,
        amountsPaise: Object.fromEntries([...totals.amounts].map(([currency, amount]) => [currency, Number(amount)]))
      }
    ]));
    const newDemoRequestCount = Number(demoRequestsResult.rows?.[0]?.new_request_count || 0);
    if (!Number.isSafeInteger(newDemoRequestCount) || newDemoRequestCount < 0) {
      throw new Error('The new demo request count is invalid.');
    }
    const storageAllocationUnlimited = companies.some(company => company.storageLimitMb === null);
    const allocatedStorageBytes = storageAllocationUnlimited ? null
      : companies.reduce((total, company) => total + company.storageLimitMb * 1024 * 1024, 0);
    res.set('Cache-Control', 'no-store');
    return res.json({
      admin: { name: admin.name, username: admin.username },
      summary: {
        companyCount: companies.length,
        trialCount: statusCounts.trial || 0,
        activeCount: statusCounts.active || 0,
        activePaidCount: paidCompanyIds.size,
        trialEndingSoonCount,
        trialsEndingIn7DaysCount,
        suspendedCount: statusCounts.suspended || 0,
        cancelledCount: statusCounts.cancelled || 0,
        paidSeats,
        monthlyRecurringRevenuePaise: Number(monthlyRecurringRevenuePaise),
        annualRecurringRevenuePaise: Number(annualRecurringRevenuePaise),
        openInvoiceCount: invoiceSummary.open.count,
        openInvoiceAmountsPaise: invoiceSummary.open.amountsPaise,
        overdueInvoiceCount: invoiceSummary.overdue.count,
        overdueInvoiceAmountsPaise: invoiceSummary.overdue.amountsPaise,
        newDemoRequestCount,
        totalUsers: latestUsage.reduce((total, company) => total + company.userCount, 0),
        totalStorageBytes: latestUsage.reduce((total, company) => total + company.dbBytes + company.filesBytes, 0),
        allocatedStorageBytes
      },
      companies,
      plans: plansResult.rows.map(row => ({
        id: Number(row.id),
        name: row.name,
        maxUsers: row.max_users == null ? null : Number(row.max_users),
        storageLimitMb: row.storage_limit_mb == null ? null : Number(row.storage_limit_mb)
      })),
      registeredCompaniesOnly: true
    });
  }));

  router.get('/demo-requests', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute(`SELECT id, name, email, phone, company_name, team_size,
        message, status, created_at FROM demo_requests
      WHERE status IN ('new', 'approved') AND company_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 100`);
    res.set('Cache-Control', 'no-store');
    return res.json({ requests: (result.rows || []).map(row => ({
      id: Number(row.id), name: row.name, email: row.email, phone: row.phone,
      companyName: row.company_name, teamSize: Number(row.team_size), message: row.message,
      status: row.status, createdAt: row.created_at
    })) });
  }));

  router.post('/demo-requests/:requestId/approve', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const requestId = Number(req.params.requestId);
    if (!Number.isSafeInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Choose a valid demo request.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `UPDATE demo_requests SET status = 'approved', approved_by = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'new' AND company_id IS NULL`,
      args: [admin.id, requestId]
    });
    if (Number(result.rowsAffected || 0) !== 1) return res.status(409).json({ error: 'New demo request not found.' });
    await writeAudit(controlDb, admin, null, 'Demo request approved', `Demo request ${requestId} approved for manual trial provisioning.`);
    res.set('Cache-Control', 'no-store');
    return res.json({ id: requestId, status: 'approved' });
  }));

  router.post('/demo-requests/:requestId/reject', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const requestId = Number(req.params.requestId);
    if (!Number.isSafeInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Choose a valid demo request.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `UPDATE demo_requests SET status = 'rejected', approved_by = ?, updated_at = datetime('now')
        WHERE id = ? AND status IN ('new', 'approved') AND company_id IS NULL`,
      args: [admin.id, requestId]
    });
    if (Number(result.rowsAffected || 0) !== 1) return res.status(409).json({ error: 'Unconverted demo request not found.' });
    await writeAudit(controlDb, admin, null, 'Demo request rejected', `Demo request ${requestId} rejected.`);
    res.set('Cache-Control', 'no-store');
    return res.json({ id: requestId, status: 'rejected' });
  }));

  router.post('/companies', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });

    const demoRequestId = req.body?.demoRequestId == null ? null : Number(req.body.demoRequestId);
    if (demoRequestId !== null && (!Number.isSafeInteger(demoRequestId) || demoRequestId < 1)) {
      return res.status(400).json({ error: 'Choose a valid approved demo request.' });
    }
    if (demoRequestId !== null && demoRequestsInProvisioning.has(demoRequestId)) {
      return res.status(409).json({ error: 'This demo request is already being converted to a trial.' });
    }

    try {
      const controlDb = demoRequestId === null ? null : await getDatabase();
      if (demoRequestId !== null) {
        const requestResult = await controlDb.execute({
          sql: "SELECT id FROM demo_requests WHERE id = ? AND status = 'approved' AND company_id IS NULL LIMIT 1",
          args: [demoRequestId]
        });
        if (!requestResult.rows?.[0]) return res.status(409).json({ error: 'Only an approved, unconverted request can create a trial.' });
        demoRequestsInProvisioning.add(demoRequestId);
      }
      const result = await provisionCompany(req.body, admin);
      if (demoRequestId !== null) {
        const updated = await controlDb.execute({
          sql: `UPDATE demo_requests SET status = 'converted', company_id = ?, updated_at = datetime('now')
            WHERE id = ? AND status = 'approved' AND company_id IS NULL`,
          args: [Number(result.company.id), demoRequestId]
        });
        if (Number(updated.rowsAffected || 0) !== 1) {
          throw new Error('The company was provisioned, but its demo request could not be linked. Contact support before retrying.');
        }
        await writeAudit(controlDb, admin, Number(result.company.id), 'Demo request converted',
          `Approved demo request ${demoRequestId} converted to a trial company.`);
      }
      res.set('Cache-Control', 'no-store');
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof ProvisioningError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      throw error;
    } finally {
      if (demoRequestId !== null) demoRequestsInProvisioning.delete(demoRequestId);
    }
  }));

  router.put('/companies/:companyId', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });

    const companyId = Number(req.params.companyId);
    const body = req.body;
    if (!Number.isSafeInteger(companyId) || companyId < 1
      || !body || typeof body !== 'object' || Array.isArray(body)
      || !Object.prototype.hasOwnProperty.call(body, 'status')
      || !Object.prototype.hasOwnProperty.call(body, 'planId')) {
      return res.status(400).json({ error: 'A valid company ID, status, and plan are required.' });
    }
    if (typeof body.status !== 'string' || !COMPANY_STATUSES.has(body.status)) {
      return res.status(400).json({ error: 'Choose a valid company status.' });
    }
    const planId = body.planId === null ? null : Number(body.planId);
    if (body.planId !== null && (!Number.isSafeInteger(planId) || planId < 1)) {
      return res.status(400).json({ error: 'Choose a valid plan.' });
    }

    const controlDb = await getDatabase();
    const companyResult = await controlDb.execute({
        sql: `SELECT c.status, c.plan_id, c.max_users_override, c.storage_limit_mb_override,
          c.notes, c.delete_after, c.trial_policy_version, p.name AS plan_name,
          p.max_users AS plan_max_users, p.storage_limit_mb AS plan_storage_limit_mb,
          ps.trial_max_users, ps.trial_storage_limit_mb
        FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
        LEFT JOIN pricing_settings ps ON ps.id = 1
        WHERE c.id = ? AND c.status <> 'deleted'`,
      args: [companyId]
    });
    const company = companyResult.rows?.[0];
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    let planName = null;
    let planMaxUsers = null;
    let planStorageLimitMb = null;
    if (planId !== null) {
      const planResult = await controlDb.execute({
        sql: 'SELECT name, max_users, storage_limit_mb FROM plans WHERE id = ? AND is_active = 1',
        args: [planId]
      });
      if (!planResult.rows?.[0]) return res.status(400).json({ error: 'Choose an active plan.' });
      planName = planResult.rows[0].name;
      planMaxUsers = planResult.rows[0].max_users == null ? null : Number(planResult.rows[0].max_users);
      planStorageLimitMb = planResult.rows[0].storage_limit_mb == null ? null : Number(planResult.rows[0].storage_limit_mb);
    }
    const hasMaxUsersOverride = Object.prototype.hasOwnProperty.call(body, 'maxUsersOverride');
    const hasStorageOverride = Object.prototype.hasOwnProperty.call(body, 'storageLimitMbOverride');
    const hasNotes = Object.prototype.hasOwnProperty.call(body, 'notes');
    const maxUsersOverride = hasMaxUsersOverride ? safeLimitOverride(body.maxUsersOverride)
      : company.max_users_override == null ? null : Number(company.max_users_override);
    const storageLimitMbOverride = hasStorageOverride ? safeLimitOverride(body.storageLimitMbOverride)
      : company.storage_limit_mb_override == null ? null : Number(company.storage_limit_mb_override);
    const notes = hasNotes ? body.notes : company.notes;
    if ((hasMaxUsersOverride && maxUsersOverride === undefined)
      || (hasStorageOverride && storageLimitMbOverride === undefined)
      || (hasNotes && (typeof notes !== 'string' || notes.length > 4000))) {
      return res.status(400).json({ error: 'Enter valid non-negative limit overrides and notes.' });
    }
    const trialLimitApplies = Number(company.trial_policy_version) === 1;
    const resolvedLimit = (override, planLimit, trialLimit, status) => {
      let limit = override == null ? planLimit : override;
      if (trialLimitApplies && status === 'trial') {
        limit = limit == null ? trialLimit : Math.min(limit, trialLimit);
      }
      return limit == null ? null : Number(limit);
    };
    const currentMaxUsers = resolvedLimit(
      company.max_users_override == null ? null : Number(company.max_users_override),
      company.plan_max_users == null ? null : Number(company.plan_max_users),
      Number(company.trial_max_users ?? 3),
      company.status
    );
    const currentStorageMb = resolvedLimit(
      company.storage_limit_mb_override == null ? null : Number(company.storage_limit_mb_override),
      company.plan_storage_limit_mb == null ? null : Number(company.plan_storage_limit_mb),
      Number(company.trial_storage_limit_mb ?? 1024),
      company.status
    );
    const targetMaxUsers = resolvedLimit(
      maxUsersOverride, planMaxUsers, Number(company.trial_max_users ?? 3), body.status
    );
    const targetStorageMb = resolvedLimit(
      storageLimitMbOverride, planStorageLimitMb, Number(company.trial_storage_limit_mb ?? 1024), body.status
    );
    const maxUsersLimitChanged = targetMaxUsers !== currentMaxUsers;
    const storageLimitChanged = targetStorageMb !== currentStorageMb;
    let liveUsage = null;
    if ((maxUsersLimitChanged && targetMaxUsers !== null)
      || (storageLimitChanged && targetStorageMb !== null)) {
      try {
        liveUsage = await measureTenantUsage(getTenantDatabase(), companyId);
      } catch (error) {
        if (error.code === 'TENANT_USAGE_UNAVAILABLE') return res.status(503).json({ error: error.message });
        throw error;
      }
      if (maxUsersLimitChanged && targetMaxUsers !== null && targetMaxUsers < liveUsage.userCount) {
        return res.status(409).json({
          error: `The ${targetMaxUsers}-user limit is below the ${liveUsage.userCount} active users in this workspace.`
        });
      }
      const targetStorageBytes = targetStorageMb * 1024 * 1024;
      if (!Number.isSafeInteger(targetStorageBytes)) throw new Error('The requested storage limit exceeds the supported byte range.');
      if (storageLimitChanged && targetStorageMb !== null && targetStorageBytes < liveUsage.storageBytes) {
        return res.status(409).json({
          error: `The ${targetStorageMb} MB limit is below the ${liveUsage.storageBytes} bytes currently used.`
        });
      }
    }
    const deleteAfter = body.status === 'cancelled' ? company.delete_after : null;

    const changes = [];
    if (company.status !== body.status) changes.push(`status ${company.status} -> ${body.status}`);
    const currentPlanId = company.plan_id == null ? null : Number(company.plan_id);
    if (currentPlanId !== planId) changes.push(`plan ${company.plan_name || 'none'} -> ${planName || 'none'}`);
    const currentMaxUsersOverride = company.max_users_override == null ? null : Number(company.max_users_override);
    const currentStorageOverride = company.storage_limit_mb_override == null ? null : Number(company.storage_limit_mb_override);
    if (currentMaxUsersOverride !== maxUsersOverride) {
      changes.push(`user limit override ${currentMaxUsersOverride ?? 'plan default'} -> ${maxUsersOverride ?? 'plan default'}`);
    }
    if (currentStorageOverride !== storageLimitMbOverride) {
      changes.push(`storage limit override ${currentStorageOverride ?? 'plan default'} MB -> ${storageLimitMbOverride ?? 'plan default'}`);
    }
    if (notes !== company.notes) changes.push('company notes updated');
    if (deleteAfter !== company.delete_after) changes.push('permanent deletion schedule cleared');
    if (!changes.length) return res.json({ companyId, status: body.status, planId });

    const results = await controlDb.batch([
      {
        sql: `UPDATE companies SET status = ?, plan_id = ?, max_users_override = ?,
            storage_limit_mb_override = ?, notes = ?, delete_after = ?
          WHERE id = ? AND status <> 'deleted'
            AND (status <> ? OR plan_id IS NOT ? OR max_users_override IS NOT ?
              OR storage_limit_mb_override IS NOT ? OR notes <> ? OR delete_after IS NOT ?)
            AND (? IS NULL OR EXISTS (SELECT 1 FROM plans WHERE id = ? AND is_active = 1))`,
        args: [body.status, planId, maxUsersOverride, storageLimitMbOverride, notes, deleteAfter,
          companyId, body.status, planId, maxUsersOverride, storageLimitMbOverride, notes, deleteAfter, planId, planId]
      },
      {
        sql: `INSERT INTO super_admin_audit (super_admin_id, company_id, action, details)
          SELECT ?, ?, ?, ? WHERE changes() = 1`,
        args: [admin.id, companyId, 'Company configuration updated', changes.join('; ')]
      }
    ], 'write');
    if (Number(results[0]?.rowsAffected) !== 1) {
      const currentCompany = await controlDb.execute({
        sql: "SELECT id FROM companies WHERE id = ? AND status <> 'deleted'",
        args: [companyId]
      });
      if (!currentCompany.rows?.[0]) return res.status(404).json({ error: 'Company not found.' });
      if (planId !== null) {
        const currentPlan = await controlDb.execute({
          sql: 'SELECT id FROM plans WHERE id = ? AND is_active = 1',
          args: [planId]
        });
        if (!currentPlan.rows?.[0]) return res.status(400).json({ error: 'Choose an active plan.' });
      }
      return res.status(409).json({ error: 'Company settings changed while saving. Refresh and try again.' });
    }
    return res.json({ companyId, status: body.status, planId, maxUsersOverride, storageLimitMbOverride, notes });
  }));

  router.get('/companies/:companyId', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    if (!Number.isSafeInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a valid company.' });
    const controlDb = await getDatabase();
    const [companyResult, usageResult, backupsResult, billingResult, restoreResult, restoreTestsResult, billingRequestsResult] = await Promise.all([
      controlDb.execute({
        sql: `SELECT c.id, c.code, c.name, c.owner_name, c.owner_email, c.owner_phone, c.status,
            c.plan_id, c.trial_ends_at, c.last_login_at, c.delete_after, c.max_users_override, c.storage_limit_mb_override,
            c.trial_policy_version, ps.trial_storage_limit_mb,
            c.notes, c.created_at, p.name AS plan_name, p.max_users, p.storage_limit_mb
          FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
          LEFT JOIN pricing_settings ps ON ps.id = 1
          WHERE c.id = ? AND c.status <> 'deleted'`,
        args: [companyId]
      }),
      controlDb.execute({
        sql: `SELECT taken_at, user_count, db_bytes, files_bytes FROM usage_snapshots
          WHERE company_id = ? ORDER BY taken_at DESC, id DESC LIMIT 90`,
        args: [companyId]
      }),
      controlDb.execute({
        sql: `SELECT id, type, location, size_bytes, created_at, status, backup_key, backup_kind,
            row_counts_json, telegram_message_ids_json FROM backups
          WHERE company_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
        args: [companyId]
      }),
      controlDb.execute({
        sql: `SELECT b.id, b.amount_text, b.note, b.marked_paid_at, b.marked_by,
            a.name AS marked_by_name FROM billing_notes b
          LEFT JOIN super_admins a ON a.id = b.marked_by
          WHERE b.company_id = ? ORDER BY b.id DESC LIMIT 100`,
        args: [companyId]
      }),
      controlDb.execute({
        sql: `SELECT id, backup_id, tenant_db_name, previous_tenant_db_name, row_counts_json,
          status, created_at, activated_at, reverted_at
          FROM company_restore_staging WHERE source_company_id = ? ORDER BY id DESC LIMIT 20`,
        args: [companyId]
      }),
      controlDb.execute({
        sql: `SELECT id, backup_id, test_month, status, details, created_at
          FROM backup_tests WHERE company_id = ? ORDER BY test_month DESC LIMIT 12`,
        args: [companyId]
      }),
      controlDb.execute({
        sql: `SELECT id, requested_by_user_id, requested_seats, requested_billing_cycle,
            status, invoice_id, created_at, reviewed_at
          FROM subscription_change_requests WHERE company_id = ? ORDER BY id DESC LIMIT 20`,
        args: [companyId]
      })
    ]);
    const row = companyResult.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Company not found.' });
    let effectiveStorageLimitMb = row.storage_limit_mb_override == null
      ? (row.storage_limit_mb == null ? null : Number(row.storage_limit_mb))
      : Number(row.storage_limit_mb_override);
    if (row.status === 'trial' && Number(row.trial_policy_version) === 1) {
      const trialLimit = Number(row.trial_storage_limit_mb ?? 1024);
      effectiveStorageLimitMb = effectiveStorageLimitMb == null ? trialLimit : Math.min(effectiveStorageLimitMb, trialLimit);
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      company: {
        id: Number(row.id), code: row.code, name: row.name, ownerName: row.owner_name,
        ownerEmail: row.owner_email, ownerPhone: row.owner_phone, status: row.status,
        planId: row.plan_id == null ? null : Number(row.plan_id), planName: row.plan_name,
        maxUsers: row.max_users == null ? null : Number(row.max_users),
        storageLimitMb: row.storage_limit_mb == null ? null : Number(row.storage_limit_mb),
        effectiveStorageLimitMb,
        maxUsersOverride: row.max_users_override == null ? null : Number(row.max_users_override),
        storageLimitMbOverride: row.storage_limit_mb_override == null ? null : Number(row.storage_limit_mb_override),
        trialEndsAt: row.trial_ends_at, lastLoginAt: row.last_login_at, deleteAfter: row.delete_after,
        notes: row.notes, createdAt: row.created_at
      },
      usageHistory: usageResult.rows.map(snapshot => ({
        takenAt: snapshot.taken_at, userCount: Number(snapshot.user_count),
        dbBytes: Number(snapshot.db_bytes), filesBytes: Number(snapshot.files_bytes)
      })).reverse(),
      backups: backupsResult.rows.map(backup => ({
        id: Number(backup.id), type: backup.type, location: backup.location,
        sizeBytes: Number(backup.size_bytes), createdAt: backup.created_at, status: backup.status,
        key: backup.backup_key, kind: backup.backup_kind,
        rowCounts: (() => { try { return JSON.parse(backup.row_counts_json || '{}'); } catch (error) { return {}; } })(),
        telegramPartCount: (() => { try { return JSON.parse(backup.telegram_message_ids_json || '[]').length; } catch (error) { return 0; } })()
      })),
      restoreCandidates: restoreResult.rows.map(restore => ({
        id: Number(restore.id), backupId: Number(restore.backup_id), databaseName: restore.tenant_db_name,
        previousDatabaseName: restore.previous_tenant_db_name,
        rowCounts: (() => { try { return JSON.parse(restore.row_counts_json || '{}'); } catch (error) { return {}; } })(),
        status: restore.status, createdAt: restore.created_at, activatedAt: restore.activated_at, revertedAt: restore.reverted_at
      })),
      restoreTests: restoreTestsResult.rows.map(result => ({
        id: Number(result.id), backupId: Number(result.backup_id), month: result.test_month,
        status: result.status, details: result.details, createdAt: result.created_at
      })),
      billingNotes: billingResult.rows.map(note => ({
        id: Number(note.id), amountText: note.amount_text, note: note.note,
        markedPaidAt: note.marked_paid_at, markedByName: note.marked_by_name, createdAt: null
      })),
      billingRequests: billingRequestsResult.rows.map(request => ({
        id: Number(request.id),
        requestedByUserId: request.requested_by_user_id == null ? null : Number(request.requested_by_user_id),
        seats: Number(request.requested_seats),
        billingCycle: request.requested_billing_cycle,
        status: request.status,
        invoiceId: request.invoice_id == null ? null : Number(request.invoice_id),
        createdAt: request.created_at,
        reviewedAt: request.reviewed_at
      }))
    });
  }));

  router.post('/companies/:companyId/storage/refresh', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    if (!Number.isSafeInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a valid company.' });
    const controlDb = await getDatabase();
    const companyResult = await controlDb.execute({
      sql: `SELECT c.id, c.status, c.trial_policy_version, c.storage_limit_mb_override,
          p.storage_limit_mb, ps.trial_storage_limit_mb
        FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
        LEFT JOIN pricing_settings ps ON ps.id = 1
        WHERE c.id = ? AND c.status <> 'deleted' LIMIT 1`,
      args: [companyId]
    });
    const company = companyResult.rows?.[0];
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    const database = getTenantDatabase();
    if (typeof database.runWithTenant !== 'function') {
      return res.status(503).json({ error: 'Live tenant usage is unavailable.' });
    }
    const usage = await measureTenantUsage(database, companyId);

    let storageLimitMb = company.storage_limit_mb_override == null
      ? (company.storage_limit_mb == null ? null : Number(company.storage_limit_mb))
      : Number(company.storage_limit_mb_override);
    if (company.status === 'trial' && Number(company.trial_policy_version) === 1) {
      const trialLimit = Number(company.trial_storage_limit_mb ?? 1024);
      storageLimitMb = storageLimitMb == null ? trialLimit : Math.min(storageLimitMb, trialLimit);
    }
    if (storageLimitMb !== null && (!Number.isSafeInteger(storageLimitMb) || storageLimitMb < 0)) {
      throw new Error('The assigned company plan has an invalid storage limit.');
    }
    const allocatedBytes = storageLimitMb === null ? null : storageLimitMb * 1024 * 1024;
    if (allocatedBytes !== null && !Number.isSafeInteger(allocatedBytes)) {
      throw new Error('The assigned company plan storage limit exceeds the supported byte range.');
    }
    const percentUsed = allocatedBytes === null ? null
      : allocatedBytes === 0 ? (usage.storageBytes === 0 ? 0 : 100)
        : Number(((usage.storageBytes / allocatedBytes) * 100).toFixed(1));
    const remainingBytes = allocatedBytes === null ? null : Math.max(0, allocatedBytes - usage.storageBytes);
    const updatedAt = new Date().toISOString();
    await controlDb.execute({
      sql: 'INSERT INTO usage_snapshots (company_id, user_count, db_bytes, files_bytes, taken_at) VALUES (?, ?, ?, ?, ?)',
      args: [companyId, usage.userCount, usage.databaseBytes, usage.fileBytes, updatedAt]
    });
    await writeAudit(controlDb, admin, companyId, 'Live storage refreshed',
      `Measured ${usage.storageBytes} bytes used against ${allocatedBytes == null ? 'an unlimited allocation' : `${allocatedBytes} allocated bytes`}.`);
    res.set('Cache-Control', 'no-store');
    return res.json({
      companyId,
      allocatedBytes,
      databaseBytes: usage.databaseBytes,
      fileBytes: usage.fileBytes,
      usedBytes: usage.storageBytes,
      remainingBytes,
      percentUsed,
      updatedAt
    });
  }));

  router.get('/plans', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const result = await controlDb.execute('SELECT id, name, max_users, storage_limit_mb, features_json, price_note, is_active FROM plans ORDER BY id');
    return res.json({ plans: result.rows.map(row => ({
      id: Number(row.id), name: row.name,
      maxUsers: row.max_users == null ? null : Number(row.max_users),
      storageLimitMb: row.storage_limit_mb == null ? null : Number(row.storage_limit_mb),
      features: JSON.parse(row.features_json), priceNote: row.price_note, isActive: Number(row.is_active) === 1
    })) });
  }));

  router.post('/plans', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const plan = validatePlan(req.body);
    if (!plan) return res.status(400).json({ error: 'Enter a plan name, valid limits, features, and price note.' });
    const controlDb = await getDatabase();
    try {
      const result = await controlDb.execute({
        sql: 'INSERT INTO plans (name, max_users, storage_limit_mb, features_json, price_note, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        args: [plan.name, plan.maxUsers, plan.storageLimitMb, JSON.stringify(plan.features), plan.priceNote, plan.isActive]
      });
      const id = Number(result.lastInsertRowid);
      await writeAudit(controlDb, admin, null, 'Plan created', `Created plan ${plan.name}.`);
      return res.status(201).json({ id, ...plan });
    } catch (error) {
      if (/unique constraint/i.test(String(error.message))) return res.status(409).json({ error: 'A plan with that name already exists.' });
      throw error;
    }
  }));

  router.put('/plans/:planId', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const planId = Number(req.params.planId);
    const plan = validatePlan(req.body);
    if (!Number.isSafeInteger(planId) || planId < 1 || !plan) {
      return res.status(400).json({ error: 'Enter a valid plan and plan ID.' });
    }
    const controlDb = await getDatabase();
    const currentResult = await controlDb.execute({ sql: 'SELECT name FROM plans WHERE id = ?', args: [planId] });
    if (!currentResult.rows?.[0]) return res.status(404).json({ error: 'Plan not found.' });
    try {
      await controlDb.execute({
        sql: 'UPDATE plans SET name = ?, max_users = ?, storage_limit_mb = ?, features_json = ?, price_note = ?, is_active = ? WHERE id = ?',
        args: [plan.name, plan.maxUsers, plan.storageLimitMb, JSON.stringify(plan.features), plan.priceNote, plan.isActive, planId]
      });
      await writeAudit(controlDb, admin, null, 'Plan updated', `Updated plan ${currentResult.rows[0].name} -> ${plan.name}.`);
      return res.json({ id: planId, ...plan });
    } catch (error) {
      if (/unique constraint/i.test(String(error.message))) return res.status(409).json({ error: 'A plan with that name already exists.' });
      throw error;
    }
  }));

  router.post('/companies/:companyId/billing', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const amountText = typeof req.body?.amountText === 'string' ? req.body.amountText.trim() : '';
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!Number.isSafeInteger(companyId) || companyId < 1 || amountText.length > 120 || !note || note.length > 2000) {
      return res.status(400).json({ error: 'Enter a valid amount description and billing note.' });
    }
    const controlDb = await getDatabase();
    const company = await controlDb.execute({ sql: "SELECT id FROM companies WHERE id = ? AND status <> 'deleted'", args: [companyId] });
    if (!company.rows?.[0]) return res.status(404).json({ error: 'Company not found.' });
    const result = await controlDb.execute({
      sql: 'INSERT INTO billing_notes (company_id, amount_text, note) VALUES (?, ?, ?)',
      args: [companyId, amountText, note]
    });
    await writeAudit(controlDb, admin, companyId, 'Billing note added', `${amountText || 'Amount not specified'}: ${note}`);
    return res.status(201).json({ id: Number(result.lastInsertRowid), amountText, note, markedPaidAt: null });
  }));

  router.post('/companies/:companyId/billing/:noteId/paid', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const noteId = Number(req.params.noteId);
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(noteId) || noteId < 1) {
      return res.status(400).json({ error: 'Choose a valid billing note.' });
    }
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: "UPDATE billing_notes SET marked_paid_at = datetime('now'), marked_by = ? WHERE id = ? AND company_id = ? AND marked_paid_at IS NULL",
      args: [admin.id, noteId, companyId]
    });
    if (Number(result.rowsAffected) !== 1) return res.status(404).json({ error: 'Unpaid billing note not found.' });
    await writeAudit(controlDb, admin, companyId, 'Billing note marked paid', `Billing note ${noteId} marked paid.`);
    return res.json({ id: noteId, markedPaid: true });
  }));

  router.post('/companies/:companyId/reset-admin-password', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    if (!Number.isSafeInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a valid company.' });
    const controlDb = await getDatabase();
    const companyResult = await controlDb.execute({
      sql: "SELECT id, code FROM companies WHERE id = ? AND status <> 'deleted'",
      args: [companyId]
    });
    const company = companyResult.rows?.[0];
    if (!company) return res.status(404).json({ error: 'Company not found.' });
    const tenantDb = getTenantDatabase();
    const oneTimePassword = crypto.randomBytes(24).toString('base64url');
    const passwordHash = await bcrypt.hash(oneTimePassword, 10);
    const tenantAdmin = await tenantDb.runWithTenant(companyId, async () => {
      const target = await tenantDb.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
      if (!target) return null;
      await tenantDb.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?')
        .run(passwordHash, target.id);
      return target;
    });
    if (!tenantAdmin) return res.status(404).json({ error: 'Active company administrator not found.' });
    await controlDb.execute({
      sql: 'DELETE FROM web_sessions WHERE company_id = ? AND user_id = ?',
      args: [String(companyId), Number(tenantAdmin.id)]
    });
    await writeAudit(controlDb, admin, companyId, 'Company admin password reset', 'Reset the company admin password and required a change at next sign-in.');
    res.set('Cache-Control', 'no-store');
    return res.json({ username: (await tenantDb.runWithTenant(companyId, () => tenantDb.prepare('SELECT username FROM users WHERE id = ?').get(tenantAdmin.id)))?.username, oneTimePassword });
  }));

  router.post('/companies/:companyId/backups', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    if (!Number.isSafeInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a valid company.' });
    const backup = await getBackupManager().createCompanyBackup(companyId, {
      kind: 'manual', adminId: admin.id, requireTelegram: true
    });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json(backup);
  }));

  router.get('/companies/:companyId/backups/:backupId/download', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const backupId = Number(req.params.backupId);
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(backupId) || backupId < 1) {
      return res.status(400).json({ error: 'Choose a valid company backup.' });
    }
    const result = await getBackupManager().getBackupArchive(companyId, backupId);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="taskflow-company-backup-${companyId}-${backupId}.json"`);
    return res.send(result.buffer);
  }));

  router.post('/companies/:companyId/backups/:backupId/restore', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const backupId = Number(req.params.backupId);
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(backupId) || backupId < 1) {
      return res.status(400).json({ error: 'Choose a valid company backup.' });
    }
    const staged = await getBackupManager().createRestoreStage(companyId, backupId, admin.id);
    res.set('Cache-Control', 'no-store');
    return res.status(201).json(staged);
  }));

  router.post('/companies/:companyId/restores/:restoreId/activate', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const restoreId = Number(req.params.restoreId);
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(restoreId) || restoreId < 1) {
      return res.status(400).json({ error: 'Choose a valid restore candidate.' });
    }
    const activated = await getBackupManager().activateRestore(companyId, restoreId, admin.id);
    return res.json(activated);
  }));

  router.post('/companies/:companyId/restores/:restoreId/revert', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const restoreId = Number(req.params.restoreId);
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(restoreId) || restoreId < 1) {
      return res.status(400).json({ error: 'Choose a valid restore candidate.' });
    }
    const reverted = await getBackupManager().revertRestore(companyId, restoreId, admin.id);
    return res.json(reverted);
  }));

  router.delete('/companies/:companyId/restores/:restoreId', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    const restoreId = Number(req.params.restoreId);
    if (!Number.isSafeInteger(companyId) || companyId < 1 || !Number.isSafeInteger(restoreId) || restoreId < 1) {
      return res.status(400).json({ error: 'Choose a valid restore candidate.' });
    }
    const discarded = await getBackupManager().discardRestore(companyId, restoreId, admin.id);
    return res.json(discarded);
  }));

  router.post('/companies/:companyId/support-mode', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const companyId = Number(req.params.companyId);
    if (!Number.isSafeInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a valid company.' });
    if (!req.session || typeof req.session.regenerate !== 'function') return res.status(500).json({ error: 'Company sessions are unavailable.' });
    const controlDb = await getDatabase();
    const companyResult = await controlDb.execute({
      sql: "SELECT id, code, name, status FROM companies WHERE id = ? AND status IN ('trial', 'active', 'suspended')",
      args: [companyId]
    });
    const company = companyResult.rows?.[0];
    if (!company) return res.status(404).json({ error: 'Company not found or unavailable.' });
    const tenantDb = getTenantDatabase();
    const companyAdmin = await tenantDb.runWithTenant(companyId, () => tenantDb.prepare(
      "SELECT id, name, username, token_version FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1"
    ).get());
    if (!companyAdmin) return res.status(404).json({ error: 'Active company administrator not found.' });
    const expiresAt = Date.now() + SUPPORT_MODE_DURATION_MS;
    await sessionAction(req, 'regenerate');
    Object.assign(req.session, {
      userId: Number(companyAdmin.id), role: 'admin', name: companyAdmin.name,
      tokenVersion: Number(companyAdmin.token_version), companyId,
      supportModeSuperAdminId: admin.id, supportModeExpiresAt: expiresAt,
      supportModeCompanyName: company.name
    });
    req.session.cookie.maxAge = SUPPORT_MODE_DURATION_MS;
    await sessionSave(req);
    try {
      await writeAudit(controlDb, admin, companyId, 'Support mode started', `Opened a company admin session for ${company.code}; expires at ${new Date(expiresAt).toISOString()}.`);
    } catch (error) {
      await sessionAction(req, 'destroy');
      throw error;
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ companyName: company.name, expiresAt: new Date(expiresAt).toISOString() });
  }));

  return router;
}

module.exports = { COOKIE_NAME, SESSION_DURATION_MS, SUPPORT_MODE_DURATION_MS, createSuperAdminPageHandler, createSuperAdminRouter, digestSessionToken, readSessionToken, validatePlan };
