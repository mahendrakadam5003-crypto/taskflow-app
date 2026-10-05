'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getControlDatabase } = require('../control-db');

const COOKIE_NAME = 'taskflow.superadmin.sid';
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
const COMPANY_STATUSES = new Set(['trial', 'active', 'suspended', 'cancelled']);

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

function createSuperAdminRouter({ getDatabase = getControlDatabase, secureCookies = process.env.RENDER === 'true' } = {}) {
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

  router.get('/overview', handle(async (req, res) => {
    const admin = await getAuthenticatedAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Sign in to the super-admin panel.' });
    const controlDb = await getDatabase();
    const [statusResult, companiesResult, plansResult] = await Promise.all([
      controlDb.execute(`SELECT status, COUNT(*) AS company_count
        FROM companies GROUP BY status`),
      controlDb.execute(`SELECT c.id, c.code, c.name, c.owner_name, c.owner_email, c.status, c.plan_id,
          c.trial_ends_at, c.created_at, p.name AS plan_name, p.max_users, p.storage_limit_mb,
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
      maxUsers: row.max_users == null ? null : Number(row.max_users),
      storageLimitMb: row.storage_limit_mb == null ? null : Number(row.storage_limit_mb),
      userCount: row.user_count == null ? null : Number(row.user_count),
      dbBytes: row.db_bytes == null ? null : Number(row.db_bytes),
      filesBytes: row.files_bytes == null ? null : Number(row.files_bytes),
      planId: row.plan_id == null ? null : Number(row.plan_id),
      usageTakenAt: row.usage_taken_at,
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
      sql: `SELECT c.status, c.plan_id, p.name AS plan_name
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

    const changes = [];
    if (company.status !== body.status) changes.push(`status ${company.status} -> ${body.status}`);
    const currentPlanId = company.plan_id == null ? null : Number(company.plan_id);
    if (currentPlanId !== planId) changes.push(`plan ${company.plan_name || 'none'} -> ${planName || 'none'}`);
    if (!changes.length) return res.json({ companyId, status: body.status, planId });

    const results = await controlDb.batch([
      {
        sql: `UPDATE companies SET status = ?, plan_id = ?
          WHERE id = ? AND status <> 'deleted'
            AND (status <> ? OR plan_id IS NOT ?)
            AND (? IS NULL OR EXISTS (SELECT 1 FROM plans WHERE id = ? AND is_active = 1))`,
        args: [body.status, planId, companyId, body.status, planId, planId, planId]
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
    return res.json({ companyId, status: body.status, planId });
  }));

  return router;
}

module.exports = { COOKIE_NAME, SESSION_DURATION_MS, createSuperAdminRouter, digestSessionToken, readSessionToken };
