'use strict';

const { getControlDatabase } = require('./control-db');
const { hasControlDatabaseConfiguration, LEGACY_TENANT_ID } = require('./tenant-manager');

const DEFAULT_SETTINGS = Object.freeze({ grace_period_days: 3, read_only_period_days: 7 });

function parseAccessDate(value, { endOfDay = false } = {}) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : null;
}

function accessResult(state, reason, message) {
  return { state, reasons: [reason], message };
}

function getCompanyAccessState(company, {
  subscription = null,
  settings = DEFAULT_SETTINGS,
  now = new Date()
} = {}) {
  if (!company) return accessResult('locked', 'company_unavailable', 'This workspace is no longer available.');
  if (company.id === LEGACY_TENANT_ID || company.code === 'existing-company') {
    return accessResult('full', 'legacy_compatibility', '');
  }
  if (company.status === 'suspended') {
    return accessResult('locked', 'company_suspended', 'This workspace is suspended. Contact support.');
  }
  if (company.status === 'deleted') {
    return accessResult('locked', 'company_deleted', 'This workspace is no longer available.');
  }

  const nowTime = now instanceof Date ? now.getTime() : Number(now);
  const periodEnd = parseAccessDate(subscription?.current_period_end);
  const graceDays = Math.max(0, Number(settings.grace_period_days ?? DEFAULT_SETTINGS.grace_period_days));
  const readOnlyDays = Math.max(0, Number(settings.read_only_period_days ?? DEFAULT_SETTINGS.read_only_period_days));
  const graceEnd = periodEnd == null ? null : periodEnd + graceDays * 86400000;
  const readOnlyEnd = graceEnd == null ? null : graceEnd + readOnlyDays * 86400000;

  const pastDuePeriodEnded = subscription?.status === 'past_due'
    && (periodEnd == null || nowTime > periodEnd);
  if (pastDuePeriodEnded
    || (subscription?.status === 'active' && periodEnd != null && nowTime > periodEnd)) {
    if (graceEnd == null) {
      return accessResult('locked', 'payment_overdue', 'This workspace is locked because its payment period could not be confirmed.');
    }
    if (nowTime <= graceEnd) {
      return accessResult('grace', 'payment_due', 'Payment is due. Full workspace access continues during the grace period.');
    }
    if (readOnlyEnd != null && nowTime <= readOnlyEnd) {
      return accessResult('read_only', 'payment_overdue', 'Payment is overdue. This workspace is read-only until payment is updated.');
    }
    return accessResult('locked', 'payment_overdue', 'This workspace is locked because its payment is overdue.');
  }

  if (subscription?.status === 'cancelled' || subscription?.status === 'expired'
    || company.status === 'cancelled') {
    if (periodEnd != null && nowTime <= periodEnd) {
      return accessResult('read_only', 'subscription_cancelled', 'This subscription is cancelled. Workspace access is read-only until the current period ends.');
    }
    return accessResult('locked', 'subscription_ended', 'This subscription has ended. Contact your administrator to restore access.');
  }

  if (company.status === 'trial' && Number(company.trial_policy_version) !== 1 && subscription?.status !== 'trialing') {
    return accessResult('full', 'legacy_trial_grandfathered', '');
  }

  if (company.status === 'trial' || subscription?.status === 'trialing') {
    const trialEnd = parseAccessDate(company.trial_ends_at, { endOfDay: true })
      ?? parseAccessDate(subscription?.current_period_end, { endOfDay: true });
    if (trialEnd == null || nowTime > trialEnd) {
      return accessResult('locked', 'trial_ended', 'The trial has ended. Contact your administrator to continue.');
    }
    return accessResult('full', 'trial_active', 'Trial access may be limited after expiry. Automatic workspace deletion is disabled.');
  }

  return accessResult('full', 'subscription_active', '');
}

function createEntitlementService({
  getDatabase = getControlDatabase,
  isConfigured = hasControlDatabaseConfiguration,
  now = () => new Date()
} = {}) {
  async function loadCompanyAccessState(companyId) {
    if (companyId === LEGACY_TENANT_ID || !isConfigured()) {
      return getCompanyAccessState({ id: LEGACY_TENANT_ID });
    }
    const normalizedId = Number(companyId);
    if (!Number.isSafeInteger(normalizedId) || normalizedId < 1) {
      return getCompanyAccessState({ id: LEGACY_TENANT_ID });
    }
    const controlDb = await getDatabase();
    const [companyResult, subscriptionResult, settingsResult] = await Promise.all([
      controlDb.execute({
        sql: 'SELECT id, code, status, trial_ends_at FROM companies WHERE id = ? LIMIT 1',
        args: [normalizedId]
      }),
      controlDb.execute({
        sql: 'SELECT status, current_period_end FROM subscriptions WHERE company_id = ? ORDER BY id DESC LIMIT 1',
        args: [normalizedId]
      }),
      controlDb.execute('SELECT grace_period_days, read_only_period_days FROM pricing_settings WHERE id = 1')
    ]);
    return getCompanyAccessState(companyResult.rows?.[0], {
      subscription: subscriptionResult.rows?.[0] || null,
      settings: settingsResult.rows?.[0] || DEFAULT_SETTINGS,
      now: now()
    });
  }

  return { getCompanyAccessState: loadCompanyAccessState };
}

function createEntitlementMiddleware({ getCompanyAccessState }) {
  if (typeof getCompanyAccessState !== 'function') throw new TypeError('An entitlement state resolver is required.');
  const accountRecoveryPaths = new Set([
    'GET /api/auth/google/start',
    'GET /api/auth/google/callback',
    'POST /api/auth/email/verify',
    'POST /api/auth/password-reset/request',
    'POST /api/auth/password-reset/complete'
  ]);
  return (req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/public/')
      || req.path === '/api/superadmin' || req.path.startsWith('/api/superadmin/')) return next();
    Promise.resolve(getCompanyAccessState(req.companyTenantId)).then(access => {
      req.companyAccessState = access;
      res.setHeader('X-Company-Access-State', access.state);
      res.setHeader('X-Company-Access-Message', access.message || '');
      res.setHeader('X-Company-Access-Reasons', JSON.stringify(access.reasons || []));
      res.locals.companyAccessState = access;
      if (access.state === 'full' || access.state === 'grace') return next();

      const logoutOrPassword = req.method === 'POST'
        && ['/api/auth/logout', '/api/auth/change-password', '/auth/logout', '/auth/change-password'].includes(req.path);
      if (logoutOrPassword) return next();
      if (accountRecoveryPaths.has(`${req.method} ${req.path}`)) return next();
      if (req.method === 'POST' && req.path === '/api/auth/login') return next();

      const adminBillingPath = req.session?.role === 'admin'
        && (req.path === '/api/auth/me' || req.path === '/api/auth/access-state'
          || req.path.startsWith('/api/auth/billing') || req.path.startsWith('/api/billing'));
      if (access.state === 'locked') {
        if (adminBillingPath) return next();
        return res.status(402).json({
          error: access.message,
          access_state: access.state,
          reasons: access.reasons,
          billing_required: true
        });
      }

      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      return res.status(403).json({
        error: access.message,
        access_state: access.state,
        reasons: access.reasons,
        read_only: true
      });
    }).catch(next);
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  createEntitlementMiddleware,
  createEntitlementService,
  getCompanyAccessState,
  parseAccessDate
};