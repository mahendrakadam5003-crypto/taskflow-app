'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { getControlDatabase } = require('../control-db');

const COOKIE_NAME = 'taskflow.superadmin.sid';
const SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

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
      sql:       `SELECT a.id, a.name, a.email, a.token_version AS admin_token_version,
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
    return { id: Number(sessionRow.id), name: sessionRow.name, email: sessionRow.email };
  }

  router.post('/login', loginLimiter, handle(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password || password.length > 1024) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: 'SELECT id, name, email, password_hash, token_version FROM super_admins WHERE lower(email) = ? LIMIT 1',
      args: [email]
    });
    const admin = result.rows?.[0];
    const validPassword = await bcrypt.compare(password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!admin || !validPassword) return res.status(401).json({ error: 'Email or password is incorrect.' });

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
    return res.json({ authenticated: true, admin: { name: admin.name, email: admin.email } });
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
    const [statusResult, companiesResult] = await Promise.all([
      controlDb.execute(`SELECT status, COUNT(*) AS company_count
        FROM companies GROUP BY status`),
      controlDb.execute(`SELECT c.id, c.code, c.name, c.owner_name, c.owner_email, c.status,
          c.trial_ends_at, c.created_at, p.name AS plan_name, p.max_users, p.storage_limit_mb,
          u.user_count, u.db_bytes, u.files_bytes, u.taken_at AS usage_taken_at
        FROM companies c
        LEFT JOIN plans p ON p.id = c.plan_id
        LEFT JOIN usage_snapshots u ON u.id = (
          SELECT latest.id FROM usage_snapshots latest
          WHERE latest.company_id = c.id ORDER BY latest.taken_at DESC, latest.id DESC LIMIT 1
        )
        WHERE c.status <> 'deleted'
        ORDER BY c.created_at DESC, c.id DESC`)
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
      usageTakenAt: row.usage_taken_at,
      trialEndsAt: row.trial_ends_at,
      createdAt: row.created_at
    }));
    const statusCounts = Object.fromEntries(statusResult.rows.map(row => [row.status, Number(row.company_count)]));
    const latestUsage = companies.filter(company => company.userCount !== null);
    res.set('Cache-Control', 'no-store');
    return res.json({
      admin: { name: admin.name, email: admin.email },
      summary: {
        companyCount: companies.length,
        trialCount: statusCounts.trial || 0,
        activeCount: statusCounts.active || 0,
        suspendedCount: statusCounts.suspended || 0,
        totalUsers: latestUsage.reduce((total, company) => total + company.userCount, 0),
        totalStorageBytes: latestUsage.reduce((total, company) => total + company.dbBytes + company.filesBytes, 0)
      },
      companies,
      registeredCompaniesOnly: true
    });
  }));

  return router;
}

module.exports = { COOKIE_NAME, SESSION_DURATION_MS, createSuperAdminRouter, digestSessionToken, readSessionToken };
