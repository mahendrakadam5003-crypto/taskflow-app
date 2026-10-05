'use strict';

const crypto = require('node:crypto');
const { getControlDatabase } = require('./control-db');
const { LEGACY_TENANT_ID } = require('./tenant-manager');

const COMPANY_CONTEXT_COOKIE = 'taskflow.company.v1';
const COMPANY_CONTEXT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const COMPANY_CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function signCompanyCode(companyCode, secret = process.env.SESSION_SECRET) {
  if (!COMPANY_CODE_PATTERN.test(companyCode)) throw new TypeError('A valid company code is required.');
  const signingKey = String(secret || '');
  if (signingKey.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const signature = crypto.createHmac('sha256', signingKey).update(companyCode).digest('base64url');
  return `${companyCode}.${signature}`;
}

function verifyCompanyCode(value, secret = process.env.SESSION_SECRET) {
  if (typeof value !== 'string') return null;
  const separator = value.lastIndexOf('.');
  if (separator < 1) return null;
  const companyCode = value.slice(0, separator);
  if (!COMPANY_CODE_PATTERN.test(companyCode)) return null;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(value.slice(separator + 1), 'base64url'),
      Buffer.from(signCompanyCode(companyCode, secret).slice(separator + 1), 'base64url')
    ) ? companyCode : null;
  } catch (error) {
    return null;
  }
}

function readCookie(cookieHeader, cookieName) {
  for (const entry of String(cookieHeader || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator >= 0 && entry.slice(0, separator).trim() === cookieName) {
      return entry.slice(separator + 1).trim();
    }
  }
  return null;
}

function setCompanyContextCookie(res, companyCode, { secure = false, secret } = {}) {
  res.cookie(COMPANY_CONTEXT_COOKIE, signCompanyCode(companyCode, secret), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: COMPANY_CONTEXT_MAX_AGE_MS
  });
}

function clearCompanyContextCookie(res, { secure = false } = {}) {
  res.clearCookie(COMPANY_CONTEXT_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/'
  });
}

function createCompanyContextMiddleware({
  runWithTenant,
  getDatabase = getControlDatabase,
  secret = process.env.SESSION_SECRET,
  cookieName = COMPANY_CONTEXT_COOKIE
}) {
  if (typeof runWithTenant !== 'function') throw new TypeError('A tenant context runner is required.');

  async function resolveCompany(companyCode) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `SELECT id, code, name FROM companies
        WHERE code = ? AND status IN ('trial', 'active') LIMIT 1`,
      args: [companyCode]
    });
    const company = result.rows?.[0];
    return company ? {
      id: Number(company.id),
      code: company.code,
      name: company.name
    } : null;
  }

  return (req, res, next) => {
    const isLogin = req.method === 'POST' && req.path === '/api/auth/login';
    const hasExplicitLoginCode = isLogin && Object.prototype.hasOwnProperty.call(req.body || {}, 'company_code');
    const explicitCompanyCode = hasExplicitLoginCode
      ? (typeof req.body.company_code === 'string' ? req.body.company_code.trim().toLowerCase() : null)
      : null;
    const cookieValue = readCookie(req.get('Cookie'), cookieName);
    const cookieCompanyCode = verifyCompanyCode(cookieValue, secret);
    const companyCode = hasExplicitLoginCode ? explicitCompanyCode : cookieCompanyCode;

    if (!companyCode) {
      if (cookieValue && !cookieCompanyCode) clearCompanyContextCookie(res, { secure: req.secure });
      if (hasExplicitLoginCode && explicitCompanyCode === '' && cookieCompanyCode) {
        req.clearCompanyContextCookie = true;
      }
      if (hasExplicitLoginCode && explicitCompanyCode !== '') {
        return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
      }
      req.companyTenantId = LEGACY_TENANT_ID;
      req.companyCode = null;
      return runWithTenant(LEGACY_TENANT_ID, next);
    }

    if (!COMPANY_CODE_PATTERN.test(companyCode)) {
      return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
    }

    resolveCompany(companyCode).then(company => {
      if (!company) {
        if (isLogin) return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
        clearCompanyContextCookie(res, { secure: req.secure });
        req.companyTenantId = LEGACY_TENANT_ID;
        req.companyCode = null;
        return runWithTenant(LEGACY_TENANT_ID, next);
      }
      req.companyTenantId = company.id;
      req.companyCode = company.code;
      req.companyName = company.name;
      return runWithTenant(company.id, next);
    }).catch(next);
  };
}

module.exports = {
  COMPANY_CONTEXT_COOKIE,
  COMPANY_CONTEXT_MAX_AGE_MS,
  clearCompanyContextCookie,
  createCompanyContextMiddleware,
  setCompanyContextCookie,
  signCompanyCode,
  verifyCompanyCode
};
