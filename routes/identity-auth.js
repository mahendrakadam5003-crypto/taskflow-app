'use strict';

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { getControlDatabase } = require('../control-db');
const { hasControlDatabaseConfiguration, LEGACY_TENANT_ID } = require('../tenant-manager');
const { createMailer } = require('../mailer');
const { authorizeLogin, getLoginDevice, isLoginSessionAllowed, isMobileBrowserLoginEnabled } = require('../lib/login-device');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const passwordMinimumBytes = 10;
const passwordMaximumBytes = 72;

function logActivity(...args) {
  return require('../audit').logActivity(...args);
}

function logRequestEvent(...args) {
  return require('../http-errors').logRequestEvent(...args);
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(value) {
  return value.length <= 254 && emailPattern.test(value);
}

function createIdentityAuthRouter(options = {}) {
  const database = options.database || require('../db');
  const mailer = options.mailer || createMailer();
  const environment = options.environment || process.env;
  const fetcher = options.fetcher || global.fetch;
  const now = options.now || (() => Date.now());
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
  const otpRequestLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sign-in code requests. Try again later.' }
  });
  const otpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many code attempts. Try again later.' }
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

  async function deliverLink(req, user, purpose, { invitation = false } = {}) {
    if (!emailDeliveryConfigured()) {
      return { sent: false, error: 'Email delivery is not configured. Set APP_BASE_URL and email delivery settings, then try again.' };
    }
    const email = normalizeEmail(user.email);
    if (!validEmail(email)) return { sent: false, error: 'A valid email address is required.' };
    const isVerification = purpose === 'verify_email';
    const lifetimeMs = isVerification ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    const tokenRecord = await issueEmailToken(user, purpose, lifetimeMs);
    const link = createTokenLink(isVerification ? '/verify-email.html' : '/password-reset.html', tokenRecord.token, companyCode(req));
    const subject = invitation
      ? 'You are invited to join TaskFlow'
      : isVerification ? 'Verify your TaskFlow email address' : 'Reset your TaskFlow password';
    const action = invitation ? 'accept your invitation and verify your email address'
      : isVerification ? 'verify your email address' : 'reset your password';
    const text = `Use this link to ${action} for your TaskFlow workspace:\n\n${link}\n\nThis link expires in ${isVerification ? '24 hours' : '1 hour'} and can only be used once. After verifying, sign in with an email code or Google. If you did not request this, you can ignore this message.`;
    const htmlLink = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const html = `<p>Use the link below to ${action} for your TaskFlow workspace.</p><p><a href="${htmlLink}">${invitation ? 'Accept invitation and verify email' : isVerification ? 'Verify email address' : 'Reset your password'}</a></p><p>This link expires in ${isVerification ? '24 hours' : '1 hour'} and can only be used once. After verifying, sign in with an email code or Google. If you did not request this, you can ignore this message.</p>`;
    try {
      await publicMailer.send({ to: email, subject, text, html });
      return { sent: true };
    } catch (error) {
      await database.prepare('DELETE FROM email_auth_tokens WHERE token_hash = ?').run(tokenRecord.hash);
      logRequestEvent(req, isVerification ? 'email_verification_delivery_failed' : 'password_reset_delivery_failed', 'warn');
      return { sent: false, error: 'The email could not be sent. Check email delivery settings and try again.' };
    }
  }

  function otpDigest(code) {
    const secret = String(environment.SESSION_SECRET || '');
    if (secret.length < 32) throw new Error('Email sign-in requires a configured session secret.');
    return crypto.createHmac('sha256', secret).update(code).digest('hex');
  }

  async function sendEmailCode(req, user, purpose) {
    if (!publicMailer.isConfigured?.()) {
      return { sent: false, error: 'Email sign-in is not configured. Set email delivery settings, then try again.' };
    }
    const email = normalizeEmail(user.email);
    if (!validEmail(email)) return { sent: false, error: 'A valid email address is required.' };
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = otpDigest(code);
    const expiresAt = now() + 10 * 60 * 1000;
    await database.prepare('DELETE FROM email_login_otps WHERE user_id = ? AND purpose = ?')
      .run(user.id, purpose);
    const inserted = await database.prepare(`INSERT INTO email_login_otps
      (user_id, email, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, email, purpose, codeHash, expiresAt);
    const subject = purpose === 'enrollment' ? 'Verify your TaskFlow email address' : 'Your TaskFlow sign-in code';
    const text = purpose === 'enrollment'
      ? `Your TaskFlow email verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`
      : `Your TaskFlow sign-in code is ${code}. It expires in 10 minutes and can only be used once. Never share this code.`;
    const html = `<p>${purpose === 'enrollment' ? 'Verify your email address to finish setting up your TaskFlow account.' : 'Use this one-time code to sign in to TaskFlow.'}</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes and can only be used once. Never share it.</p>`;
    try {
      await publicMailer.send({ to: email, subject, text, html });
      return { sent: true, id: Number(inserted?.lastInsertRowid ?? inserted?.lastID ?? 0) };
    } catch (error) {
      await database.prepare('DELETE FROM email_login_otps WHERE user_id = ? AND purpose = ?')
        .run(user.id, purpose);
      logRequestEvent(req, purpose === 'enrollment' ? 'email_enrollment_code_delivery_failed' : 'email_login_code_delivery_failed', 'warn');
      return { sent: false, error: 'The email could not be sent. Check email delivery settings and try again.' };
    }
  }

  async function sendGenericLoginResponse(req, res, email) {
    if (!publicMailer.isConfigured?.()) {
      return res.status(503).json({ error: 'Email sign-in is not configured. Contact your workspace administrator.' });
    }
    const user = await database.prepare(`SELECT id, email FROM users
      WHERE lower(trim(email)) = ? AND email_verified = 1 AND active = 1 LIMIT 1`).get(email);
    if (user) {
      await sendEmailCode(req, user, 'login');
    }
    return res.status(202).json({
      message: 'If an active account has that verified email, a sign-in code has been sent.'
    });
  }

  async function verifyEmailCode(email, code, purpose) {
    const row = await database.prepare(`SELECT t.id, t.user_id, t.email, t.code_hash, t.expires_at,
        t.attempts, u.id AS account_id, u.name, u.username, u.role, u.active,
        u.email AS current_email, u.email_verified, u.must_change_password, u.token_version, u.web_access_enabled
      FROM email_login_otps t JOIN users u ON u.id = t.user_id
      WHERE lower(trim(t.email)) = ? AND t.purpose = ? AND t.consumed_at IS NULL
        AND t.expires_at > ? AND t.attempts < 5
      ORDER BY t.id DESC LIMIT 1`).get(email, purpose, now());
    if (!row || Number(row.active) !== 1 || Number(row.email_verified) !== (purpose === 'login' ? 1 : 0)
      || normalizeEmail(row.email) !== email || normalizeEmail(row.current_email) !== email) return null;
    const expected = otpDigest(code);
    const actualBuffer = Buffer.from(String(row.code_hash), 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      await database.prepare(`UPDATE email_login_otps SET attempts = attempts + 1
        WHERE id = ? AND consumed_at IS NULL AND attempts < 5`).run(row.id);
      return null;
    }
    const consumed = await database.prepare(`UPDATE email_login_otps SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < 5`)
      .run(now(), row.id, now());
    if (Number(consumed?.changes ?? consumed?.rowsAffected ?? 0) !== 1) return null;
    return { ...row, id: Number(row.account_id) };
  }

  router.post('/email/login/request', otpRequestLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    try {
      return await sendGenericLoginResponse(req, res, email);
    } catch (error) {
      logRequestEvent(req, 'email_login_code_request_failed');
      return res.status(500).json({ error: 'The sign-in request could not be processed. Try again later.' });
    }
  });

  router.post('/email/login/verify', otpVerifyLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!validEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the email address and six-digit sign-in code.' });
    }
    try {
      const user = await verifyEmailCode(email, code, 'login');
      if (!user) return res.status(400).json({ error: 'The sign-in code is invalid, expired, or already used. Request a new code.' });
      const reason = await authenticateUser(req, user, getLoginDevice(req, req.body));
      if (reason) {
        const messages = {
          google_suspended: ['Account suspended, contact support.', 'ACCOUNT_SUSPENDED'],
          google_billing_required: ['This workspace is locked. Contact your administrator.', 'BILLING_REQUIRED'],
          web_login_not_allowed: ['This account is limited to its registered TaskFlow mobile app. Ask your company admin to enable web access.', 'WEB_LOGIN_NOT_ALLOWED'],
          app_device_mismatch: ['This account is registered to another mobile device. Ask your company admin to reset the registered app device before signing in here.', 'APP_DEVICE_MISMATCH'],
          app_device_id_required: ['TaskFlow could not identify this app installation. Update the app and try again.', 'APP_DEVICE_ID_REQUIRED']
        };
        const [error, responseCode] = messages[reason] || ['Sign-in could not be completed.', 'LOGIN_FAILED'];
        const status = ['google_suspended', 'google_billing_required', 'web_login_not_allowed', 'app_device_mismatch', 'app_device_id_required'].includes(reason) ? 403 : 401;
        return res.status(status).json({ error, code: responseCode });
      }
      return res.json({
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        must_change_password: false,
        company_status: req.companyStatus
      });
    } catch (error) {
      logRequestEvent(req, 'email_login_code_verification_failed');
      return res.status(500).json({ error: 'Sign-in could not be completed. Try again later.' });
    }
  });

  router.post('/email/enroll', otpRequestLimiter, async (req, res) => {
    const userId = Number(req.session?.userId);
    const email = normalizeEmail(req.body?.email);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(401).json({ error: 'Sign in with your existing account to set up email access.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    try {
      const user = await database.prepare('SELECT id, email, email_verified FROM users WHERE id = ? AND active = 1').get(userId);
      if (!user) return res.status(401).json({ error: 'Your account is unavailable. Contact your administrator.' });
      if (Number(user.email_verified) === 1 && normalizeEmail(user.email) === email) {
        return res.status(409).json({ error: 'Your verified email is already set. Sign in with email code or Google.' });
      }
      const duplicate = await database.prepare('SELECT id FROM users WHERE lower(trim(email)) = ? AND id <> ?').get(email, userId);
      if (duplicate) return res.status(409).json({ error: 'That email address is already attached to another account.' });
      await database.prepare(`UPDATE users SET email = ?, email_verified = 0, google_sub = NULL,
        auth_provider = 'email' WHERE id = ? AND active = 1`).run(email, userId);
      await database.prepare('DELETE FROM email_auth_tokens WHERE user_id = ?').run(userId);
      const result = await sendEmailCode(req, { id: userId, email }, 'enrollment');
      if (!result.sent) return res.status(503).json({ error: result.error });
      return res.json({ sent: true, message: 'A verification code was sent to your email.' });
    } catch (error) {
      logRequestEvent(req, 'email_enrollment_code_request_failed');
      return res.status(500).json({ error: 'Email setup could not be completed. Try again later.' });
    }
  });

  router.post('/email/enroll/verify', otpVerifyLimiter, async (req, res) => {
    const userId = Number(req.session?.userId);
    const email = normalizeEmail(req.body?.email);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(401).json({ error: 'Sign in with your existing account to finish email setup.' });
    if (!validEmail(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the email address and six-digit verification code.' });
    try {
      const pending = await database.prepare(`SELECT id, email FROM users
        WHERE id = ? AND active = 1 AND email_verified = 0 AND lower(trim(email)) = ?`)
        .get(userId, email);
      const codeUser = pending ? await verifyEmailCode(email, code, 'enrollment') : null;
      if (!codeUser || codeUser.id !== userId) {
        return res.status(400).json({ error: 'The verification code is invalid, expired, or already used. Request a new code.' });
      }
      const updated = await database.prepare(`UPDATE users SET email_verified = 1, token_version = token_version + 1
        WHERE id = ? AND active = 1 AND email_verified = 0 AND lower(trim(email)) = ?`)
        .run(userId, email);
      if (Number(updated?.changes ?? updated?.rowsAffected ?? 0) !== 1) {
        return res.status(400).json({ error: 'Email setup could not be completed. Request a new code.' });
      }
      await database.prepare('DELETE FROM email_login_otps WHERE user_id = ? AND purpose = ?')
        .run(userId, 'enrollment');
      const user = await database.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      const reason = await authenticateUser(req, user);
      if (reason) return res.status(403).json({ error: 'Your account cannot sign in to this workspace right now.' });
      return res.json({ verified: true });
    } catch (error) {
      logRequestEvent(req, 'email_enrollment_code_verification_failed');
      return res.status(500).json({ error: 'Email setup could not be completed. Try again later.' });
    }
  });
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

  router.post('/google/device-context', googleLoginLimiter, async (req, res) => {
    req.session.pendingLoginDevice = getLoginDevice(req, req.body);
    req.session.pendingLoginDeviceAt = now();
    try {
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
      return res.json({ ok: true });
    } catch (error) {
      logRequestEvent(req, 'google_login_device_context_save_failed');
      return res.status(500).json({ error: 'Google sign-in could not be started. Try again.' });
    }
  });

  router.get('/google/start', googleLoginLimiter, async (req, res) => {
    const config = googleConfiguration();
    if (!config) return redirectToLogin(res, 'google_unavailable');
    const loginDevice = Number(req.session?.pendingLoginDeviceAt) > now() - 5 * 60 * 1000
      ? req.session.pendingLoginDevice
      : getLoginDevice(req);
    if (req.session) {
      delete req.session.pendingLoginDevice;
      delete req.session.pendingLoginDeviceAt;
    }
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    req.session.googleOAuth = {
      state,
      verifier,
      companyId: req.companyTenantId ?? LEGACY_TENANT_ID,
      loginDevice,
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

  async function authenticateUser(req, user, loginDevice = getLoginDevice(req, req.body)) {
    if (req.companyStatus === 'suspended' && user.role !== 'admin') return 'google_suspended';
    if (req.companyAccessState?.state === 'locked' && user.role !== 'admin') return 'google_billing_required';
    let loginAccess;
    if (Number(req.session?.userId) === Number(user.id)) {
      if (!await isLoginSessionAllowed(database, user, req.session, {
        allowMobileBrowserLogin: isMobileBrowserLoginEnabled(environment)
      })) return 'login_access_revoked';
      loginAccess = {
        loginClient: req.session.loginClient || 'web',
        loginDeviceHash: req.session.loginDeviceHash || null
      };
    } else {
      const authorization = await authorizeLogin(database, user, loginDevice, {
        allowMobileBrowserLogin: isMobileBrowserLoginEnabled(environment)
      });
      if (!authorization.ok) {
        return {
          WEB_LOGIN_NOT_ALLOWED: 'web_login_not_allowed',
          APP_DEVICE_MISMATCH: 'app_device_mismatch',
          APP_DEVICE_ID_REQUIRED: 'app_device_id_required'
        }[authorization.code] || 'google_account_unavailable';
      }
      loginAccess = authorization;
    }
    if (Number(user.must_change_password) === 1) {
      await database.prepare(`UPDATE users SET must_change_password = 0, token_version = token_version + 1
        WHERE id = ? AND active = 1`).run(user.id);
      user = await database.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user.id);
      if (!user) return 'google_account_unavailable';
    }
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.userId = Number(user.id);
    req.session.role = user.role;
    req.session.name = user.name;
    req.session.tokenVersion = Number(user.token_version);
    req.session.companyId = req.companyTenantId ?? LEGACY_TENANT_ID;
    req.session.loginClient = loginAccess.loginClient;
    if (loginAccess.loginDeviceHash) req.session.loginDeviceHash = loginAccess.loginDeviceHash;
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
      const reason = await authenticateUser(req, user, pending.loginDevice || getLoginDevice(req));
      if (reason) return redirectToLogin(res, reason);
      return res.redirect(303, '/app');
    } catch (error) {
      logRequestEvent(req, 'google_login_failed');
      return redirectToLogin(res, 'google_failed');
    }
  });

  return {
    router,
    sendVerificationEmail: (req, user) => deliverLink(req, user, 'verify_email'),
    sendInvitationEmail: (req, user) => deliverLink(req, user, 'verify_email', { invitation: true })
  };
}

module.exports = { createIdentityAuthRouter, normalizeEmail, validEmail };
