'use strict';

const crypto = require('node:crypto');
const { getControlDatabase } = require('./control-db');
const { hasControlDatabaseConfiguration, LEGACY_TENANT_ID } = require('./tenant-manager');
const db = require('./db');
const { createEntitlementScheduler } = require('./entitlement-scheduler');

const entitlementScheduler = createEntitlementScheduler();

const FEATURE_NAMES = ['attendance', 'reimbursements', 'export'];
const ENABLED_FEATURES = Object.freeze(Object.fromEntries(FEATURE_NAMES.map(name => [name, true])));

class StorageLimitError extends Error {
  constructor() {
    super('Storage limit reached. Contact support to upgrade.');
    this.name = 'StorageLimitError';
    this.statusCode = 413;
  }
}

function parseFeatures(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('The assigned company plan has invalid feature settings.', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The assigned company plan has invalid feature settings.');
  }
  return Object.fromEntries(FEATURE_NAMES.map(name => [name, parsed[name] === true]));
}

function toBytes(value) {
  if (value == null) return null;
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes < 0) {
    throw new Error('The assigned company plan has an invalid storage limit.');
  }
  return megabytes * 1024 * 1024;
}

function createPlanLimits({
  getControlDatabase: getControlDb = getControlDatabase,
  controlDatabaseConfigured = hasControlDatabaseConfiguration,
  tenantDatabase = db,
  environment = process.env
} = {}) {
  async function getPlan(req) {
    if (!controlDatabaseConfigured(environment)) return null;
    const companyId = req.companyTenantId ?? req.session?.companyId;
    if (companyId == null) return null;

    const controlDb = await getControlDb();
    const isLegacy = String(companyId) === LEGACY_TENANT_ID;
    const companyCode = String(environment.LEGACY_COMPANY_CODE || 'existing-company').trim().toLowerCase();
    const result = await controlDb.execute({
        sql: `SELECT c.id AS company_id, c.code, c.status AS company_status, c.trial_policy_version,
            c.trial_ends_at, c.max_users_override,
          c.storage_limit_mb_override, p.id AS plan_id, p.name AS plan_name,
            p.max_users, p.storage_limit_mb, p.features_json,
            s.status AS subscription_status, s.seats AS subscription_seats,
            ps.trial_max_users, ps.trial_storage_limit_mb
          FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
          LEFT JOIN pricing_settings ps ON ps.id = 1
          LEFT JOIN subscriptions s ON s.id = (
            SELECT latest.id FROM subscriptions latest WHERE latest.company_id = c.id
            ORDER BY latest.id DESC LIMIT 1
          )
        WHERE ${isLegacy ? 'c.code = ?' : 'c.id = ?'} LIMIT 1`,
      args: [isLegacy ? companyCode : Number(companyId)]
    });
    const row = result.rows?.[0];
    if (!row) {
      if (isLegacy) return null;
      throw new Error(`No plan information is registered for company ID ${companyId}.`);
    }
    let maxUsers = row.max_users_override == null
      ? (row.max_users == null ? null : Number(row.max_users)) : Number(row.max_users_override);
    if (row.subscription_seats != null && ['active', 'past_due'].includes(row.subscription_status)) {
      maxUsers = Number(row.subscription_seats);
    }
    let storageLimitMb = row.storage_limit_mb_override == null
      ? row.storage_limit_mb : row.storage_limit_mb_override;
    if (row.company_status === 'trial' && Number(row.trial_policy_version) === 1) {
      const trialMaxUsers = Number(row.trial_max_users ?? 3);
      const trialStorageLimitMb = Number(row.trial_storage_limit_mb ?? 1024);
      maxUsers = maxUsers == null ? trialMaxUsers : Math.min(maxUsers, trialMaxUsers);
      storageLimitMb = storageLimitMb == null ? trialStorageLimitMb : Math.min(Number(storageLimitMb), trialStorageLimitMb);
    }
    if (maxUsers !== null && (!Number.isSafeInteger(maxUsers) || maxUsers < 0)) {
      throw new Error('The assigned company plan has an invalid user limit.');
    }
    if (row.plan_id == null) {
      return {
        companyId: Number(row.company_id),
        companyCode: row.code,
        name: null,
        trialEndsAt: row.trial_ends_at || null,
        maxUsers,
        storageLimitBytes: toBytes(storageLimitMb),
        features: ENABLED_FEATURES
      };
    }
    return {
      companyId: Number(row.company_id),
      companyCode: row.code,
      planId: Number(row.plan_id),
      name: row.plan_name,
      trialEndsAt: row.trial_ends_at || null,
      maxUsers,
      storageLimitBytes: toBytes(storageLimitMb),
      features: parseFeatures(row.features_json)
    };
  }

  async function getTenantDatabaseBytes() {
    const [pageCount, pageSize] = await Promise.all([
      tenantDatabase.prepare('PRAGMA page_count').get(),
      tenantDatabase.prepare('PRAGMA page_size').get()
    ]);
    const pages = Number(pageCount?.page_count ?? pageCount?.PAGE_COUNT);
    const bytesPerPage = Number(pageSize?.page_size ?? pageSize?.PAGE_SIZE);
    if (!Number.isSafeInteger(pages) || pages < 0 || !Number.isSafeInteger(bytesPerPage) || bytesPerPage < 1) {
      throw new Error('Tenant database returned invalid size information.');
    }
    return pages * bytesPerPage;
  }

  async function getPlanUsage(req) {
    const plan = await getPlan(req);
    const [activeUsers, databaseBytes, fileUsage] = await Promise.all([
      tenantDatabase.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get(),
      getTenantDatabaseBytes(),
      tenantDatabase.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM file_usage').get()
    ]);
    const userCount = Number(activeUsers?.count ?? activeUsers?.COUNT);
    const fileBytes = Number(fileUsage?.bytes ?? fileUsage?.BYTES);
    if (!Number.isSafeInteger(userCount) || userCount < 0 || !Number.isSafeInteger(fileBytes) || fileBytes < 0) {
      throw new Error('Tenant database returned invalid usage information.');
    }
    const storageBytes = databaseBytes + fileBytes;
    const percentUsed = plan?.storageLimitBytes != null
      ? Number(((storageBytes / plan.storageLimitBytes) * 100).toFixed(1))
      : null;
    const warningThreshold = percentUsed >= 95 ? 95 : percentUsed >= 80 ? 80 : null;
    if (plan?.companyId && warningThreshold) {
      void entitlementScheduler.notifyStorageWarning(plan.companyId, warningThreshold, storageBytes, plan.storageLimitBytes);
    }
    return {
      plan: plan ? {
        id: plan.planId ?? null,
        name: plan.name,
        maxUsers: plan.maxUsers,
        storageLimitBytes: plan.storageLimitBytes
      } : null,
      features: plan?.features || ENABLED_FEATURES,
      usage: {
        activeUsers: userCount,
        databaseBytes,
        fileBytes,
        storageBytes,
        percentUsed,
        warningThreshold,
        trialEndsAt: plan?.trialEndsAt || null
      }
    };
  }

  async function reserveUpload(req, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('A non-negative upload size is required.');
    const plan = await getPlan(req);
    const databaseBytes = await getTenantDatabaseBytes();
    const reservation = `pending:${crypto.randomUUID()}`;
    const results = await tenantDatabase.batch([
      {
        sql: "DELETE FROM file_usage WHERE file_reference LIKE 'pending:%' AND created_at < datetime('now', '-1 hour')",
        args: []
      },
      {
        sql: `INSERT INTO file_usage (file_reference, bytes)
          SELECT ?, ? WHERE ? IS NULL OR
            ? + COALESCE((SELECT SUM(bytes) FROM file_usage), 0) + ? <= ?`,
        args: [reservation, bytes, plan?.storageLimitBytes ?? null, databaseBytes, bytes, plan?.storageLimitBytes ?? null]
      }
    ]);
    if (Number(results?.[1]?.rowsAffected ?? results?.[1]?.changes ?? 0) !== 1) {
      throw new StorageLimitError();
    }
    return reservation;
  }

  async function releaseUpload(reservation) {
    if (typeof reservation !== 'string' || !reservation.startsWith('pending:')) {
      throw new TypeError('A valid upload reservation is required.');
    }
    await tenantDatabase.prepare('DELETE FROM file_usage WHERE file_reference = ?').run(reservation);
  }

  function requireFeature(featureName) {
    if (!FEATURE_NAMES.includes(featureName)) throw new TypeError(`Unknown plan feature: ${featureName}`);
    return (req, res, next) => {
      getPlan(req).then(plan => {
        if (plan && !plan.features[featureName]) {
          return res.status(403).json({
            error: `This feature is not included in your plan. Contact support to upgrade.`,
            feature: featureName
          });
        }
        return next();
      }).catch(next);
    };
  }

  return { getPlan, getPlanUsage, getTenantDatabaseBytes, releaseUpload, requireFeature, reserveUpload };
}

const planLimits = createPlanLimits();

module.exports = {
  ENABLED_FEATURES,
  FEATURE_NAMES,
  StorageLimitError,
  createPlanLimits,
  ...planLimits
};
