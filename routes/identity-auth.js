'use strict';

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { getControlDatabase } = require('../control-db');
const { hasControlDatabaseConfiguration, LEGACY_TENANT_ID } = require('../tenant-manager');
const { logActivity } = require('../audit');
const { logRequestEvent } = require('../http-errors');
const { createMailer } = require('../mailer');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordMinimumBytes = 10;
const passwordMaximumBytes = 72;

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(value) {
  return value.length <= 254 && emailPattern.test(value);
}

function createIdentityAuthRouter({
  database = db,
  mailer = createMailer(),
  environment = process.env,
  fetcher = global.fetch,
  now = () => Date.now()
} = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('An HTTP fetch implementation is required.');
  const router = express.Router();
  const publicMailer = mailer;
  const emailRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many email requests. Try again later.' }
  });
  const tokenUseLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again later.' }
  });
  const googleLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many sign-in attempts. Please try again later.'
  });

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  function publicBaseUrl() {
    const value = String(environment.APP_BASE_URL || '').trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!['https:', ...(isLoopback ? ['http:'] : [])].includes(url.protocol)
        || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
      return url.origin;
    } catch (error) {
      return null;
    }
  }

  function emailDeliveryConfigured() {
    return Boolean(publicBaseUrl() && publicMailer.isConfigured?.());
  }

  function companyCode(req) {
    return String(req.companyCode || environment.LEGACY_COMPANY_CODE || 'existing-company').trim().toLowerCase();
  }

  function createToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
  }

  function createTokenLink(page, token, code) {
    const url = new URL(page, publicBaseUrl());
    url.hash = new URLSearchParams({ token, company_code: code }).toString();
    return url.toString();
  }

  async function issueEmailToken(user, purpose, lifetimeMs) {
    const email = normalizeEmail(user.email);
    const { token, hash } = createToken();
    const expiresAt = now() + lifetimeMs;
    await database.prepare('DELETE FROM email_auth_tokens WHERE user_id = ? AND purpose = ?').run(user.id, purpose);
    await database.prepare(`INSERT INTO email_auth_tokens (token_hash, user_id, purpose, email, expires_at)
      VALUES (?, ?, ?, ?, ?)`).run(hash, user.id, purpose, email, expiresAt);
    return { token, hash, expiresAt };
  }

  async function deliverLink(req, user, purpose) {
    if (!emailDeliveryConfigured()) {
      return { sent: false, error: 'Email delivery is not configured. Set APP_BASE_URL and SMTP settings, then try again.' };
    }
    const email = normalizeEmail(user.email);
    if (!validEmail(email)) return { sent: false, error: 'A valid email address is required.' };
    const isVerification = purpose === 'verify_email';
    const lifetimeMs = isVerification ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    const tokenRecord = await issueEmailToken(user, purpose, lifetimeMs);
    const link = createTokenLink(isVerification ? '/verify-email.html' : '/password-reset.html', tokenRecord.token, companyCode(req));
    const subject = isVerification ? 'Verify your TaskFlow email address' : 'Reset your TaskFlow password';
    const action = isVerification ? 'verify your email address' : 'reset your password';
    const text = `Use this link to ${action} for your TaskFlow workspace:\n\n${link}\n\nThis link expires in ${isVerification ? '24 hours' : '1 hour'} and can only be used once. If you did not request this, you can ignore this message.`;
    const htmlLink = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const html = `<p>Use the link below to ${action} for your TaskFlow workspace.</p><p><a href="${htmlLink}">${isVerification ? 'Verify email address' : 'Reset password'}</a></p><p>This link expires in ${isVerification ? '24 hours' : '1 hour'} and can only be used once. If you did not request this, you can ignore this message.</p>`;
    try {
      await publicMailer.send({ to: email, subject, text, html });
      return { sent: true };
    } catch (error) {
      await database.prepare('DELETE FROM email_auth_tokens WHERE token_hash = ?').run(tokenRecord.hash);
      logRequestEvent(req, isVerification ? 'email_verification_delivery_failed' : 'password_reset_delivery_failed', 'warn');
      return { sent: false, error: 'The email could not be sent. Check SMTP settings and try again.' };
    }
  }

  async function deleteUserSessions(userId, companyId) {
    if (hasControlDatabaseConfiguration(environment)) {
      const controlDatabase = await getControlDatabase();
      await controlDatabase.execute({
        sql: 'DELETE FROM web_sessions WHERE user_id = ? AND company_id = ?',
        args: [userId, String(companyId ?? LEGACY_TENANT_ID)]
      });
      return;
    }
    await database.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
  }

  function invalidToken(res) {
    return res.status(400).json({ error: 'This link is invalid, expired, or already used. Request a new link.' });
  }

  async function readToken(token, purpose) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await database.prepare(`SELECT t.token_hash, t.user_id, t.email, t.expires_at,
        u.active, u.email AS current_email, u.email_verified
      FROM email_auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.purpose = ? AND t.consumed_at IS NULL`)
      .get(hash, purpose);
    if (!row || Number(row.active) !== 1 || Number(row.expires_at) <= now()
      || normalizeEmail(row.email) !== normalizeEmail(row.current_email)) return null;
    return row;
  }

  async function consumeToken(row) {
    const result = await database.prepare(`UPDATE email_auth_tokens SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
      .run(now(), row.token_hash, now());
    return Number(result?.changes ?? result?.rowsAffected ?? 0) === 1;
  }

  router.post('/email/verify', tokenUseLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return invalidToken(res);
    try {
      const row = await readToken(token, 'verify_email');
      if (!row || !await consumeToken(row)) return invalidToken(res);
      const updated = await database.prepare(`UPDATE users SET email_verified = 1
        WHERE id = ? AND active = 1 AND lower(trim(email)) = ?`)
        .run(row.user_id, normalizeEmail(row.email));
      if (Number(updated?.changes ?? updated?.rowsAffected ?? 0) !== 1) return invalidToken(res);
      return res.json({ verified: true });
    } catch (error) {
      logRequestEvent(req, 'email_verification_failed');
      return res.status(500).json({ error: 'Email verification could not be completed. Try again later.' });
    }
  });

  router.post('/password-reset/request', emailRequestLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!emailDeliveryConfigured()) {
      return res.status(503).json({ error: 'Email password reset is not configured. Contact your workspace administrator.' });
    }
    try {
      const user = await database.prepare(`SELECT id, email FROM users
        WHERE lower(trim(email)) = ? AND email_verified = 1 AND active = 1 LIMIT 1`).get(email);
      if (user) await deliverLink(req, user, 'password_reset');
      return res.status(202).json({
        message: 'If a verified account matches that address and email delivery is available, a reset link will be sent. If it does not arrive, contact your workspace administrator.'
      });
    } catch (error) {
      logRequestEvent(req, 'password_reset_request_failed');
      return res.status(500).json({ error: 'The reset request could not be processed. Try again later.' });
    }
  });

  router.post('/password-reset/complete', tokenUseLimiter, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (passwordBytes < passwordMinimumBytes || passwordBytes > passwordMaximumBytes) {
      return res.status(400).json({ error: 'Password must contain 10 to 72 UTF-8 bytes.' });
    }
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return invalidToken(res);
    try {
      const row = await readToken(token, 'password_reset');
      if (!row || Number(row.email_verified) !== 1 || !await consumeToken(row)) return invalidToken(res);
      const passwordHash = await bcrypt.hash(password, 10);
      const updated = await database.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0,
        token_version = token_version + 1
        WHERE id = ? AND active = 1 AND email_verified = 1 AND lower(trim(email)) = ?`)
        .run(passwordHash, row.user_id, normalizeEmail(row.email));
      if (Number(updated?.changes ?? updated?.rowsAffected ?? 0) !== 1) return invalidToken(res);
      await deleteUserSessions(row.user_id, req.companyTenantId);
      await logActivity(req, 'Password reset by email', 'user', row.user_id, 'Password reset using verified email.', row.user_id);
      return res.json({ reset: true });
    } catch (error) {
      logRequestEvent(req, 'password_reset_completion_failed');
      return res.status(500).json({ error: 'Password could not be reset. Try again later.' });
    }
  });

  function googleConfiguration() {
    const clientId = String(environment.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = String(environment.GOOGLE_CLIENT_SECRET || '').trim();
    const redirectUri = String(environment.GOOGLE_REDIRECT_URI || '').trim();
    if (!clientId || !clientSecret || !redirectUri) return null;
    try {
      const url = new URL(redirectUri);
      const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!['https:', ...(isLoopback ? ['http:'] : [])].includes(url.protocol)
        || url.username || url.password || url.hash) return null;
    } catch (error) {
      return null;
    }
    return { clientId, clientSecret, redirectUri };
  }

  function redirectToLogin(res, reason) {
    return res.redirect(303, `/app#auth=${encodeURIComponent(reason)}`);
  }

  router.get('/google/start', googleLoginLimiter, async (req, res) => {
    const config = googleConfiguration();
    if (!config) return redirectToLogin(res, 'google_unavailable');
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    req.session.googleOAuth = {
      state,
      verifier,
      companyId: req.companyTenantId ?? LEGACY_TENANT_ID,
      expiresAt: now() + 10 * 60 * 1000
    };
    try {
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    } catch (error) {
      logRequestEvent(req, 'google_login_state_save_failed');
      return redirectToLogin(res, 'google_unavailable');
    }
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString();
    return res.redirect(302, authorization.toString());
  });

  async function googleProfile(code, verifier, config) {
    const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!tokenResponse.ok) throw new Error('Google authorization-code exchange failed.');
    const tokenBody = await tokenResponse.json();
    if (typeof tokenBody.access_token !== 'string' || !tokenBody.access_token) throw new Error('Google did not return an access token.');
    const profileResponse = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!profileResponse.ok) throw new Error('Google profile could not be verified.');
    const profile = await profileResponse.json();
    const email = normalizeEmail(profile.email);
    if (typeof profile.sub !== 'string' || !profile.sub || !validEmail(email) || profile.email_verified !== true) {
      throw new Error('Google did not provide a verified email address.');
    }
    return { googleSub: profile.sub, email };
  }

  async function authenticateGoogleUser(req, user) {
    if (req.companyStatus === 'suspended' && user.role !== 'admin') return 'google_suspended';
    if (req.companyAccessState?.state === 'locked' && user.role !== 'admin') return 'google_billing_required';
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = Number(user.id);
    req.session.role = user.role;
    req.session.name = user.name;
    req.session.tokenVersion = Number(user.token_version);
    req.session.companyId = req.companyTenantId ?? LEGACY_TENANT_ID;
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    if (req.companyTenantId != null && String(req.companyTenantId) !== LEGACY_TENANT_ID) {
      try {
        const controlDb = await getControlDatabase();
        await controlDb.execute({
          sql: 'UPDATE companies SET last_login_at = datetime(\'now\') WHERE id = ?',
          args: [Number(req.companyTenantId)]
        });
      } catch (error) {
        logRequestEvent(req, 'company_last_login_update_failed', 'warn');
      }
    }
    return null;
  }

  router.get('/google/callback', googleLoginLimiter, async (req, res) => {
    const pending = req.session?.googleOAuth;
    if (req.session) delete req.session.googleOAuth;
    const config = googleConfiguration();
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const statesMatch = pending && typeof pending.state === 'string' && state.length === pending.state.length
      && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state));
    if (config && statesMatch && req.query.error === 'access_denied'
      && Number(pending.expiresAt) > now()
      && String(pending.companyId) === String(req.companyTenantId ?? LEGACY_TENANT_ID)) {
      return redirectToLogin(res, 'google_cancelled');
    }
    if (!config || !statesMatch || !code || code.length > 4096 || Number(pending.expiresAt) <= now()
      || String(pending.companyId) !== String(req.companyTenantId ?? LEGACY_TENANT_ID)) {
      return redirectToLogin(res, 'google_failed');
    }
    try {
      const profile = await googleProfile(code, pending.verifier, config);
      let user = await database.prepare(`SELECT * FROM users WHERE google_sub = ? LIMIT 1`).get(profile.googleSub);
      if (user && (normalizeEmail(user.email) !== profile.email || Number(user.email_verified) !== 1)) user = null;
      if (!user) {
        const emailUser = await database.prepare(`SELECT * FROM users
          WHERE lower(trim(email)) = ? AND email_verified = 1 LIMIT 1`).get(profile.email);
        if (emailUser) {
          const linked = await database.prepare(`UPDATE users SET google_sub = ?
            WHERE id = ? AND google_sub IS NULL AND email_verified = 1 AND lower(trim(email)) = ?`)
            .run(profile.googleSub, emailUser.id, profile.email);
          if (Number(linked?.changes ?? linked?.rowsAffected ?? 0) === 1) user = { ...emailUser, google_sub: profile.googleSub };
        }
      }
      if (!user || Number(user.active) !== 1) return redirectToLogin(res, 'google_account_unavailable');
      const reason = await authenticateGoogleUser(req, user);
      if (reason) return redirectToLogin(res, reason);
      return res.redirect(303, '/app');
    } catch (error) {
      logRequestEvent(req, 'google_login_failed');
      return redirectToLogin(res, 'google_failed');
    }
  });

  return { router, sendVerificationEmail: (req, user) => deliverLink(req, user, 'verify_email') };
}

module.exports = { createIdentityAuthRouter, normalizeEmail, validEmail };
