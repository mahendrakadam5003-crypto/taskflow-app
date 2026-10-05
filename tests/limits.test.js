'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const dbPath = require.resolve('../db');
const originalDbModule = require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { createPlanLimits, StorageLimitError } = require('../limits');
if (originalDbModule) require.cache[dbPath] = originalDbModule;
else delete require.cache[dbPath];

function createFixture({
  storageLimitMb = 1,
  maxUsersOverride = null,
  storageLimitMbOverride = null,
  features = { attendance: true, reimbursements: false, export: true }
} = {}) {
  const fileUsage = new Map();
  const controlDb = {
    async execute() {
      return {
        rows: [{
          company_id: 1,
          code: 'limit-test',
          trial_ends_at: '2027-01-03',
          plan_id: 1,
          plan_name: 'Test Plan',
          max_users: 2,
          storage_limit_mb: storageLimitMb,
          max_users_override: maxUsersOverride,
          storage_limit_mb_override: storageLimitMbOverride,
          features_json: JSON.stringify(features)
        }]
      };
    }
  };
  const tenantDb = {
    prepare(sql) {
      return {
        async get() {
          if (sql.includes('PRAGMA page_count')) return { page_count: 128 };
          if (sql.includes('PRAGMA page_size')) return { page_size: 4096 };
          if (sql.includes('COUNT(*) AS count FROM users')) return { count: 2 };
          if (sql.includes('SUM(bytes)')) {
            return { bytes: [...fileUsage.values()].reduce((sum, bytes) => sum + bytes, 0) };
          }
          throw new Error(`Unexpected tenant usage query: ${sql}`);
        },
        async run(...args) {
          if (sql.includes('DELETE FROM file_usage')) fileUsage.delete(args[0]);
          return { changes: 1 };
        }
      };
    },
    async batch(statements) {
      const reservationArgs = statements[1].args;
      const [reference, bytes, limit, databaseBytes, uploadBytes] = reservationArgs;
      const usedFilesBytes = [...fileUsage.values()].reduce((sum, amount) => sum + amount, 0);
      const allowed = limit === null || databaseBytes + usedFilesBytes + uploadBytes <= limit;
      if (allowed) fileUsage.set(reference, bytes);
      return [{ rowsAffected: 0 }, { rowsAffected: allowed ? 1 : 0 }];
    }
  };
  const limits = createPlanLimits({
    getControlDatabase: async () => controlDb,
    controlDatabaseConfigured: () => true,
    tenantDatabase: tenantDb,
    environment: {}
  });
  const req = { companyTenantId: 1, session: { companyId: 1 } };
  return { fileUsage, limits, req };
}

test('company plan usage is per-tenant database plus tracked uploaded bytes', async () => {
  const { fileUsage, limits, req } = createFixture();
  fileUsage.set('telegram:123', 500_000);
  const result = await limits.getPlanUsage(req);

  assert.deepEqual(result.plan, {
    id: 1,
    name: 'Test Plan',
    maxUsers: 2,
    storageLimitBytes: 1024 * 1024
  });
  assert.deepEqual(result.features, { attendance: true, reimbursements: false, export: true });
  assert.equal(result.usage.activeUsers, 2);
  assert.equal(result.usage.databaseBytes, 128 * 4096);
  assert.equal(result.usage.fileBytes, 500_000);
  assert.equal(result.usage.storageBytes, 1_024_288);
  assert.equal(result.usage.warningThreshold, 95);
});

test('company-specific limit overrides take precedence over plan defaults', async () => {
  const { limits, req } = createFixture({ maxUsersOverride: 1, storageLimitMbOverride: 2 });
  const plan = await limits.getPlan(req);
  assert.equal(plan.maxUsers, 1);
  assert.equal(plan.storageLimitBytes, 2 * 1024 * 1024);
  const usage = await limits.getPlanUsage(req);
  assert.equal(usage.plan.maxUsers, 1);
  assert.equal(usage.plan.storageLimitBytes, 2 * 1024 * 1024);
});

test('company storage usage activates the 80 percent warning before the 95 percent warning', async () => {
  const { fileUsage, limits, req } = createFixture();
  fileUsage.set('telegram:123', 400_000);
  const result = await limits.getPlanUsage(req);
  assert.equal(result.usage.warningThreshold, 80);
  assert.ok(result.usage.percentUsed >= 80 && result.usage.percentUsed < 95);
});

test('upload reservations reject an over-quota file and can be released', async () => {
  const { fileUsage, limits, req } = createFixture();
  const first = await limits.reserveUpload(req, 100_000);
  assert.equal(fileUsage.get(first), 100_000);
  await assert.rejects(limits.reserveUpload(req, 450_000), error => error instanceof StorageLimitError);
  await limits.releaseUpload(first);
  assert.equal(fileUsage.has(first), false);
});

test('feature middleware blocks disabled capabilities and passes enabled ones', async () => {
  const { limits, req } = createFixture();
  const middleware = limits.requireFeature('reimbursements');
  let response;
  let passed = false;
  middleware(req, {
    status(statusCode) {
      response = { statusCode };
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    }
  }, () => { passed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(passed, false);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.feature, 'reimbursements');

  const enabled = limits.requireFeature('attendance');
  enabled(req, {}, () => { passed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(passed, true);
});
