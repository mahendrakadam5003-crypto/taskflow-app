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
const { calculateInvoiceAmounts } = require('../lib/pricing');
const { createManualSubscriptionInvoice, markManualInvoicePaid } = require('../billing-service');

const COOKIE_NAME = 'taskflow.superadmin.sid';
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
const SUPPORT_MODE_DURATION_MS = 30 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const COMPANY_STATUSES = new Set(['trial', 'active', 'suspended', 'cancelled']);
const PLAN_FEATURES = ['attendance', 'reimbursements', 'export'];

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

function createSuperAdminPageHandler(htmlPath) {
  return (req, res) => {
    if (req.session?.userId) return res.status(403).send('Super-admin access is separate from company accounts.');
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
    const preview = [1, 10, 50].map(seats => ({
      seats,
      monthly: calculateInvoiceAmounts({
        unitPricePaise: pricing.monthlyPricePaise,
        seats,
        taxPctTenths: Math.round(pricing.taxPct * 10),
        taxInclusive: pricing.taxInclusive
      }),
      yearly: calculateInvoiceAmounts({
        unitPricePaise: pricing.yearlyPricePaise,
        seats,
        taxPctTenths: Math.round(pricing.taxPct * 10),
        taxInclusive: pricing.taxInclusive
      })
    }));
    res.set('Cache-Control', 'no-store');
    return res.json({ pricing, preview, affectedExistingSubscriptions: Number(subscriptions.rows?.[0]?.count || 0) });
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
    const preview = [1, 10, 50].map(seats => ({
      seats,
      monthly: calculateInvoiceAmounts({
        unitPricePaise: pricing.monthlyPricePaise,
        seats,
        taxPctTenths: pricing.taxTenths,
        taxInclusive: pricing.taxInclusive === 1
      }),
      yearly: calculateInvoiceAmounts({
        unitPricePaise: pricing.yearlyPricePaise,
        seats,
        taxPctTenths: pricing.taxTenths,
        taxInclusive: pricing.taxInclusive === 1
      })
    }));
    return res.json({ preview, affectedExistingSubscriptions: Number(subscriptions.rows?.[0]?.count || 0) });
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
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const status = req.query.status === 'all' ? 'all' : 'open';
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50;
    const [errorsResult, pendingResult] = await Promise.all([
      controlDb.execute({
        sql: `SELECT e.id, e.company_id, e.company_code, e.actor_user_id, e.request_id,
          e.event, e.method, e.route, e.status_code, e.created_at, e.resolved_at,
          c.name AS company_name, c.code AS registered_company_code
          FROM user_error_reports e LEFT JOIN companies c ON c.id = e.company_id
          WHERE ? = 'all' OR e.resolved_at IS NULL
          ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
        args: [status, limit]
      }),
      controlDb.execute('SELECT COUNT(*) AS count FROM user_error_reports WHERE resolved_at IS NULL')
    ]);
    res.set('Cache-Control', 'no-store');
    return res.json({
      pendingCount: Number(pendingResult.rows?.[0]?.count || 0),
      errors: (errorsResult.rows || []).map(row => ({
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
        createdAt: row.created_at,
        resolvedAt: row.resolved_at
      }))
    });
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
    const [statusResult, companiesResult, plansResult] = await Promise.all([
      controlDb.execute(`SELECT status, COUNT(*) AS company_count
        FROM companies WHERE status <> 'deleted' GROUP BY status`),
        controlDb.execute(`SELECT c.id, c.code, c.name, c.owner_name, c.owner_email, c.status, c.plan_id,
          c.trial_ends_at, c.created_at, c.last_login_at, c.delete_after, c.max_users_override, c.storage_limit_mb_override,
          p.name AS plan_name, p.max_users, p.storage_limit_mb,
          u.user_count, u.db_bytes, u.files_bytes, u.taken_at AS usage_taken_at
        FROM companies c
        LEFT JOIN plans p ON p.id = c.plan_id
        LEFT JOIN usage_snapshots u ON u.id = (
          SELECT latest.id FROM usage_snapshots latest
          WHERE latest.company_id = c.id ORDER BY latest.taken_at DESC, latest.id DESC LIMIT 1
        )
        WHERE c.status <> 'deleted'
        ORDER BY c.created_at DESC, c.id DESC`),
      controlDb.execute(`SELECT id, name, max_users, storage_limit_mb
        FROM plans WHERE is_active = 1 ORDER BY id`)
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
      createdAt: row.created_at
    }));
    const statusCounts = Object.fromEntries(statusResult.rows.map(row => [row.status, Number(row.company_count)]));
    const latestUsage = companies.filter(company => company.userCount !== null);
    res.set('Cache-Control', 'no-store');
    return res.json({
      admin: { name: admin.name, username: admin.username },
      summary: {
        companyCount: companies.length,
        trialCount: statusCounts.trial || 0,
        activeCount: statusCounts.active || 0,
        suspendedCount: statusCounts.suspended || 0,
        cancelledCount: statusCounts.cancelled || 0,
        totalUsers: latestUsage.reduce((total, company) => total + company.userCount, 0),
        totalStorageBytes: latestUsage.reduce((total, company) => total + company.dbBytes + company.filesBytes, 0)
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

  router.post('/companies', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });

    try {
      const result = await provisionCompany(req.body, admin);
      res.set('Cache-Control', 'no-store');
      return res.status(201).json(result);
    } catch (error) {
      if (error instanceof ProvisioningError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      throw error;
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
          c.notes, c.delete_after, p.name AS plan_name
        FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = ? AND c.status <> 'deleted'`,
      args: [companyId]
    });
    const company = companyResult.rows?.[0];
    if (!company) return res.status(404).json({ error: 'Company not found.' });

    let planName = null;
    if (planId !== null) {
      const planResult = await controlDb.execute({
        sql: 'SELECT name FROM plans WHERE id = ? AND is_active = 1',
        args: [planId]
      });
      if (!planResult.rows?.[0]) return res.status(400).json({ error: 'Choose an active plan.' });
      planName = planResult.rows[0].name;
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
    const deleteAfter = body.status === 'cancelled'
      ? company.delete_after || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const changes = [];
    if (company.status !== body.status) changes.push(`status ${company.status} -> ${body.status}`);
    const currentPlanId = company.plan_id == null ? null : Number(company.plan_id);
    if (currentPlanId !== planId) changes.push(`plan ${company.plan_name || 'none'} -> ${planName || 'none'}`);
    const currentMaxUsersOverride = company.max_users_override == null ? null : Number(company.max_users_override);
    const currentStorageOverride = company.storage_limit_mb_override == null ? null : Number(company.storage_limit_mb_override);
    if (currentMaxUsersOverride !== maxUsersOverride) changes.push('user limit override updated');
    if (currentStorageOverride !== storageLimitMbOverride) changes.push('storage limit override updated');
    if (notes !== company.notes) changes.push('company notes updated');
    if (deleteAfter !== company.delete_after) changes.push(body.status === 'cancelled'
      ? 'permanent deletion scheduled after 30 days' : 'permanent deletion schedule cleared');
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
    const [companyResult, usageResult, backupsResult, billingResult, restoreResult, restoreTestsResult] = await Promise.all([
      controlDb.execute({
        sql: `SELECT c.id, c.code, c.name, c.owner_name, c.owner_email, c.owner_phone, c.status,
            c.plan_id, c.trial_ends_at, c.last_login_at, c.delete_after, c.max_users_override, c.storage_limit_mb_override,
            c.notes, c.created_at, p.name AS plan_name, p.max_users, p.storage_limit_mb
          FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
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
      })
    ]);
    const row = companyResult.rows?.[0];
    if (!row) return res.status(404).json({ error: 'Company not found.' });
    res.set('Cache-Control', 'no-store');
    return res.json({
      company: {
        id: Number(row.id), code: row.code, name: row.name, ownerName: row.owner_name,
        ownerEmail: row.owner_email, ownerPhone: row.owner_phone, status: row.status,
        planId: row.plan_id == null ? null : Number(row.plan_id), planName: row.plan_name,
        maxUsers: row.max_users == null ? null : Number(row.max_users),
        storageLimitMb: row.storage_limit_mb == null ? null : Number(row.storage_limit_mb),
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
      }))
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
    const backup = await getBackupManager().createCompanyBackup(companyId, { kind: 'manual', adminId: admin.id });
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
