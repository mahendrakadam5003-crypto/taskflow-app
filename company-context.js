'use strict';

const crypto = require('node:crypto');
const { getControlDatabase } = require('./control-db');
const { hasControlDatabaseConfiguration, LEGACY_TENANT_ID } = require('./tenant-manager');

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
  legacyCompanyCode = process.env.LEGACY_COMPANY_CODE || 'existing-company',
  environment = process.env
}) {
  if (typeof runWithTenant !== 'function') throw new TypeError('A tenant context runner is required.');
  if (typeof legacyCompanyCode !== 'string' || !COMPANY_CODE_PATTERN.test(legacyCompanyCode.trim().toLowerCase())) {
    throw new TypeError('A valid legacy company code is required.');
  }
  const defaultCompanyCode = legacyCompanyCode.trim().toLowerCase();

  async function resolveCompany(companyCode) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: 'SELECT id, code, name, status FROM companies WHERE code = ? LIMIT 1',
      args: [companyCode]
    });
    return normalizeCompany(result.rows?.[0]);
  }

  async function resolveCompanyById(companyId) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: 'SELECT id, code, name, status FROM companies WHERE id = ? LIMIT 1',
      args: [companyId]
    });
    return normalizeCompany(result.rows?.[0]);
  }

  function normalizeCompany(company) {
    return company ? {
      id: Number(company.id),
      code: company.code,
      name: company.name,
      status: company.status
    } : null;
  }

  function destroySession(req) {
    if (!req.session || typeof req.session.destroy !== 'function') return Promise.resolve();
    return new Promise((resolve, reject) => {
      req.session.destroy(error => error ? reject(error) : resolve());
    });
  }

  function runCompanyContext(company, next, req) {
    req.companyTenantId = company.id;
    req.companyCode = company.code;
    req.companyName = company.name;
    req.companyStatus = company.status;
    return runWithTenant(company.id, next);
  }

  function runLegacyContext(req, next, companyStatus = null) {
    req.companyTenantId = LEGACY_TENANT_ID;
    req.companyCode = null;
    req.companyName = null;
    req.companyStatus = companyStatus;
    return runWithTenant(LEGACY_TENANT_ID, next);
  }

  return (req, res, next) => {
    if (req.path === '/api/superadmin' || req.path.startsWith('/api/superadmin/')) {
      return runLegacyContext(req, next);
    }

    const isLogin = req.method === 'POST' && req.path === '/api/auth/login';
    const hasExplicitLoginCode = isLogin && Object.prototype.hasOwnProperty.call(req.body || {}, 'company_code');
    const explicitCompanyCode = hasExplicitLoginCode
      ? (typeof req.body.company_code === 'string' ? req.body.company_code.trim().toLowerCase() : null)
      : null;
    const isDefaultCompanyLogin = isLogin && (!hasExplicitLoginCode || explicitCompanyCode === '');

    if (!isLogin && req.session?.companyId != null) {
      if (String(req.session.companyId) === LEGACY_TENANT_ID) return runLegacyContext(req, next);
      const companyId = Number(req.session.companyId);
      if (!Number.isSafeInteger(companyId) || companyId < 1) {
        return destroySession(req).then(() => {
          res.clearCookie('taskflow.sid.v2', { path: '/' });
          return res.status(401).json({ error: 'Your session is no longer valid. Please sign in again.' });
        }).catch(next);
      }
      return resolveCompanyById(companyId).then(company => {
        if (!company || ['cancelled', 'deleted'].includes(company.status)) {
          return destroySession(req).then(() => {
            res.clearCookie('taskflow.sid.v2', { path: '/' });
            return res.status(403).json({ error: 'This company workspace is no longer available.' });
          });
        }
        return runCompanyContext(company, next, req);
      }).catch(next);
    }

    if (isDefaultCompanyLogin) {
      if (!hasControlDatabaseConfiguration(environment)) return runLegacyContext(req, next);
      return resolveCompany(defaultCompanyCode).then(company => {
        if (!company) return runLegacyContext(req, next);
        if (!['trial', 'active', 'suspended'].includes(company.status)) {
          return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
        }
        return runCompanyContext(company, next, req);
      }).catch(next);
    }

    if (hasExplicitLoginCode && explicitCompanyCode === null) {
      return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
    }

    if (!isLogin || !explicitCompanyCode) {
      return runLegacyContext(req, next);
    }

    if (!COMPANY_CODE_PATTERN.test(explicitCompanyCode)) {
      return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
    }

    return resolveCompany(explicitCompanyCode).then(company => {
      if (!company || !['trial', 'active', 'suspended'].includes(company.status)) {
        return res.status(401).json({ error: 'Company code or login credentials are incorrect.' });
      }
      return runCompanyContext(company, next, req);
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
