'use strict';

const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { createCompanyProvisioner, ProvisioningError } = require('../company-provisioning');
const { createTursoProvisioner } = require('../turso-provisioner');

async function removeTestDirectory(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

async function createControlDatabase({ failAudit = false } = {}) {
  const companies = [];
  const audit = [];
  let nextCompanyId = 1;
  let rollbacks = 0;
  return {
    companies,
    audit,
    get rollbacks() { return rollbacks; },
    async execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      const args = typeof statement === 'string' ? [] : statement.args || [];
      if (sql.includes('FROM companies WHERE code')) {
        return { rows: companies.filter(company => company.code === args[0]).map(company => ({ id: company.id })) };
      }
      if (sql.includes('FROM plans WHERE id')) {
        return { rows: [1, 2, 3, 4, 5].includes(Number(args[0])) ? [{ id: Number(args[0]) }] : [] };
      }
      throw new Error(`Unexpected control database query: ${sql}`);
    },
    async transaction() {
      const pendingCompanies = [];
      const pendingAudit = [];
      return {
        async execute(statement) {
          if (statement.sql.startsWith('INSERT INTO companies')) {
            const row = {
              id: nextCompanyId++,
              code: statement.args[0],
              name: statement.args[1],
              ownerName: statement.args[2],
              ownerEmail: statement.args[3],
              status: 'trial',
              planId: statement.args[4],
              trialEndsAt: statement.args[5]
            };
            pendingCompanies.push(row);
            return { lastInsertRowid: row.id };
          }
          if (statement.sql.startsWith('INSERT INTO super_admin_audit')) {
            if (failAudit) throw new Error('Audit insert failed.');
            pendingAudit.push({
              superAdminId: statement.args[0],
              companyId: statement.args[1],
              action: statement.args[2],
              details: statement.args[3]
            });
            return { rowsAffected: 1 };
          }
          throw new Error(`Unexpected control transaction query: ${statement.sql}`);
        },
        async commit() {
          companies.push(...pendingCompanies);
          audit.push(...pendingAudit);
        },
        async rollback() {
          rollbacks += 1;
        }
      };
    },
    async close() {}
  };
}

test('company provisioning creates isolated local tenant databases with one-time admin accounts', async () => {
  const controlDb = await createControlDatabase();
  const localTenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-provision-test-'));
  const tenantDatabases = new Map();
  const provision = createCompanyProvisioner({
    environment: { USE_LOCAL_DB: '1' },
    getDatabase: async () => controlDb,
    localTenantRoot,
    createTenantClient: ({ url }) => {
      const tenantDb = createClient({ url: 'file::memory:' });
      tenantDatabases.set(url, tenantDb);
      return {
        execute: (...args) => tenantDb.execute(...args),
        batch: (...args) => tenantDb.batch(...args),
        close: async () => {}
      };
    },
    encryptToken: token => `encrypted:${token}`,
    now: () => new Date('2026-10-05T00:00:00.000Z')
  });

  try {
    const first = await provision({
      name: 'Solo Test',
      code: 'solo-test',
      adminName: 'Solo Admin',
      adminUsername: 'admin',
      planId: 1
    }, { id: 1 });
    const second = await provision({
      name: 'Small Test',
      code: 'small-test',
      adminName: 'Small Admin',
      adminUsername: 'owner',
      ownerEmail: 'owner@example.test',
      planId: 2
    }, { id: 1 });
    const third = await provision({
      name: 'Business Test',
      code: 'business-test',
      adminName: 'Business Admin',
      adminUsername: 'thirdadmin',
      planId: 3
    }, { id: 1 });

    assert.equal(first.company.status, 'trial');
    assert.equal(first.company.trialEndsAt, '2026-10-12');
    assert.equal(first.admin.username, 'admin');
    assert.ok(first.admin.oneTimePassword.length >= 30);
    assert.equal(second.admin.username, 'owner');
    assert.equal(third.admin.username, 'thirdadmin');
    assert.notEqual(first.admin.oneTimePassword, second.admin.oneTimePassword);

    assert.deepEqual(controlDb.companies.map(company => [
      company.code,
      company.status,
      Number(company.planId),
      company.trialEndsAt
    ]), [
      ['solo-test', 'trial', 1, '2026-10-12'],
      ['small-test', 'trial', 2, '2026-10-12'],
      ['business-test', 'trial', 3, '2026-10-12']
    ]);
    assert.deepEqual(controlDb.audit.map(entry => [entry.action, Number(entry.superAdminId)]), [
      ['Company provisioned', 1],
      ['Company provisioned', 1],
      ['Company provisioned', 1]
    ]);

    const firstDb = tenantDatabases.get(`file:${path.join(localTenantRoot, 'solo-test.db').replace(/\\/g, '/')}`);
    const secondDb = tenantDatabases.get(`file:${path.join(localTenantRoot, 'small-test.db').replace(/\\/g, '/')}`);
    const thirdDb = tenantDatabases.get(`file:${path.join(localTenantRoot, 'business-test.db').replace(/\\/g, '/')}`);
    try {
      const firstUsers = await firstDb.execute('SELECT name, username, role, active, must_change_password, password_hash FROM users');
      const secondUsers = await secondDb.execute('SELECT name, username, role, active, must_change_password, password_hash FROM users');
      const thirdUsers = await thirdDb.execute('SELECT name, username, role, active, must_change_password, password_hash FROM users');
      assert.equal(firstUsers.rows.length, 1);
      assert.equal(secondUsers.rows.length, 1);
      assert.equal(thirdUsers.rows.length, 1);
      assert.equal(firstUsers.rows[0].username, 'admin');
      assert.equal(secondUsers.rows[0].username, 'owner');
      assert.equal(thirdUsers.rows[0].username, 'thirdadmin');
      assert.equal(firstUsers.rows[0].role, 'admin');
      assert.equal(Number(firstUsers.rows[0].active), 1);
      assert.equal(Number(firstUsers.rows[0].must_change_password), 1);
      assert.equal(await bcrypt.compare(first.admin.oneTimePassword, firstUsers.rows[0].password_hash), true);
      assert.notEqual(firstUsers.rows[0].password_hash, secondUsers.rows[0].password_hash);
      assert.ok(Number((await firstDb.execute('SELECT COUNT(*) AS count FROM settings')).rows[0].count) >= 6);
    } finally {
      await Promise.all([firstDb.close(), secondDb.close(), thirdDb.close()]);
    }

    await assert.rejects(
      provision({
        name: 'Duplicate Test',
        code: 'solo-test',
        adminName: 'Duplicate Admin',
        adminUsername: 'admin',
        planId: 1
      }, { id: 1 }),
      error => error instanceof ProvisioningError && error.statusCode === 409
    );
  } finally {
    await controlDb.close();
    await removeTestDirectory(localTenantRoot);
  }
});

test('company provisioning validates reserved codes before opening control storage and inactive plans before creating databases', async () => {
  let controlDatabaseOpened = false;
  let platformCalled = false;
  const provision = createCompanyProvisioner({
    environment: {},
    getDatabase: async () => {
      controlDatabaseOpened = true;
      throw new Error('Control database should not be opened.');
    },
    createTursoClient: () => {
      platformCalled = true;
      throw new Error('Turso should not be called.');
    }
  });

  await assert.rejects(
    provision({
      name: 'Reserved',
      code: 'admin',
      adminName: 'Admin',
      adminUsername: 'admin',
      planId: 1
    }, { id: 1 }),
    /reserved/
  );
  assert.equal(controlDatabaseOpened, false);
  assert.equal(platformCalled, false);

  const inactivePlanProvisioner = createCompanyProvisioner({
    environment: {},
    getDatabase: async () => ({
      async execute(statement) {
        if (statement.sql.includes('FROM companies')) return { rows: [] };
        return { rows: [] };
      }
    }),
    createTursoClient: () => {
      platformCalled = true;
      throw new Error('Turso should not be called for an inactive plan.');
    }
  });
  await assert.rejects(
    inactivePlanProvisioner({
      name: 'Inactive Plan',
      code: 'inactive-plan',
      adminName: 'Admin',
      adminUsername: 'admin',
      planId: 1
    }, { id: 1 }),
    error => error instanceof ProvisioningError && error.statusCode === 400
  );
  assert.equal(platformCalled, false);
});

test('company codes fit the Turso database-name limit', async () => {
  const { validateProvisioningInput } = require('../company-provisioning');
  const valid = validateProvisioningInput({
    name: 'Length Test',
    code: 'a'.repeat(61),
    adminName: 'Admin',
    adminUsername: 'admin',
    planId: 1
  });
  assert.equal(`tf-${valid.code}`.length, 64);
  assert.throws(() => validateProvisioningInput({
    name: 'Length Test',
    code: 'a'.repeat(62),
    adminName: 'Admin',
    adminUsername: 'admin',
    planId: 1
  }), /1 to 61/);
});

test('failed tenant initialization rolls back the newly created Turso database and company record', async () => {
  const controlDb = await createControlDatabase();
  let deletedDatabase = null;
  let closed = false;
  const provision = createCompanyProvisioner({
    environment: {
      TURSO_PLATFORM_TOKEN: 'test-platform-token',
      TURSO_ORG: 'test-org'
    },
    getDatabase: async () => controlDb,
    createTursoClient: () => ({
      async createDatabase() {
        return { databaseUrl: 'libsql://new-tenant.turso.io' };
      },
      async createDatabaseToken() {
        return 'new-tenant-token';
      },
      async deleteDatabase(name) {
        deletedDatabase = name;
      }
    }),
    createTenantClient: () => ({
      async execute() {
        throw new Error('Tenant schema initialization failed');
      },
      async close() {
        closed = true;
      }
    }),
    initializeTenantSchema: async () => {
      throw new Error('Tenant schema initialization failed');
    },
    encryptToken: token => `encrypted:${token}`
  });

  try {
    await assert.rejects(
      provision({
        name: 'Rollback Test',
        code: 'rollback-test',
        adminName: 'Rollback Admin',
        adminUsername: 'admin',
        planId: 1
        }, { id: 1 }),
      error => error instanceof ProvisioningError && error.statusCode === 502
    );
    assert.equal(deletedDatabase, 'tf-rollback-test');
    assert.equal(closed, true);
    assert.equal(controlDb.companies.length, 0);
    assert.equal(controlDb.audit.length, 0);
  } finally {
    await controlDb.close();
  }
});

test('control-database transaction failure removes the newly created local tenant database', async () => {
  const controlDb = await createControlDatabase({ failAudit: true });
  const localTenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-provision-rollback-test-'));
  let tenantClosed = false;
  const provision = createCompanyProvisioner({
    environment: { USE_LOCAL_DB: '1' },
    getDatabase: async () => controlDb,
    localTenantRoot,
    createTenantClient: () => {
      const tenantDb = createClient({ url: 'file::memory:' });
      return {
        execute: (...args) => tenantDb.execute(...args),
        batch: (...args) => tenantDb.batch(...args),
        close: async () => {
          tenantClosed = true;
        }
      };
    },
    encryptToken: token => `encrypted:${token}`
  });
  const tenantPath = path.join(localTenantRoot, 'transaction-failure.db');

  try {
    await assert.rejects(
      provision({
        name: 'Transaction Failure',
        code: 'transaction-failure',
        adminName: 'Admin',
        adminUsername: 'admin',
        planId: 1
      }, { id: 1 }),
      error => error instanceof ProvisioningError && error.statusCode === 502
    );
    assert.equal(tenantClosed, true);
    assert.equal(controlDb.rollbacks, 1);
    assert.equal(controlDb.companies.length, 0);
    await assert.rejects(fs.access(tenantPath), { code: 'ENOENT' });
  } finally {
    await controlDb.close();
    await removeTestDirectory(localTenantRoot);
  }
});

test('Turso provisioning uses the configured organization and returns only the tenant URL and token', async () => {
  const calls = [];
  const http = {
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, headers: options.headers });
      if (url.endsWith('/databases')) return { data: { database: { Hostname: 'tenant-123.turso.io' } } };
      return { data: { jwt: 'private-tenant-jwt' } };
    },
    async delete(url, options) {
      calls.push({ method: 'DELETE', url, headers: options.headers });
      return { data: {} };
    }
  };
  const provisioner = createTursoProvisioner({
    environment: {
      TURSO_PLATFORM_TOKEN: 'test-platform-token',
      TURSO_ORG: 'test-org',
      TURSO_GROUP: 'default'
    },
    http
  });

  assert.deepEqual(await provisioner.createDatabase('tf-solo-test'), {
    databaseUrl: 'libsql://tenant-123.turso.io'
  });
  assert.equal(await provisioner.createDatabaseToken('tf-solo-test'), 'private-tenant-jwt');
  await provisioner.deleteDatabase('tf-solo-test');
  assert.equal(calls[0].url, 'https://api.turso.tech/v1/organizations/test-org/databases');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-platform-token');
  assert.deepEqual(calls[0].body, { name: 'tf-solo-test', group: 'default' });
  assert.equal(calls[1].url, 'https://api.turso.tech/v1/organizations/test-org/databases/tf-solo-test/auth/tokens?expiration=never&authorization=full-access');
  assert.match(calls[2].url, /\/databases\/tf-solo-test$/);
});

  test('Turso database creation reports successful resource creation when its response is malformed', async () => {
    const { TursoDatabaseCreatedError, createTursoProvisioner } = require('../turso-provisioner');
    const provisioner = createTursoProvisioner({
      environment: { TURSO_PLATFORM_TOKEN: 'test-token', TURSO_ORG: 'test-org' },
      http: {
        async post() {
          return { data: { database: {} } };
        }
      }
    });

    await assert.rejects(
      provisioner.createDatabase('tf-malformed'),
      error => error instanceof TursoDatabaseCreatedError && error.databaseCreated === true
    );
  });

  test('company provisioning deletes a Turso database when its create response is malformed', async () => {
    const controlDb = await createControlDatabase();
    const deleted = [];
    const turso = createTursoProvisioner({
      environment: { TURSO_PLATFORM_TOKEN: 'test-token', TURSO_ORG: 'test-org' },
      http: {
        async post() {
          return { data: { database: {} } };
        },
        async delete(url) {
          deleted.push(url);
          return { data: {} };
        }
      }
    });
    const provision = createCompanyProvisioner({
      environment: {
        TURSO_PLATFORM_TOKEN: 'test-token',
        TURSO_ORG: 'test-org'
      },
      getDatabase: async () => controlDb,
      createTursoClient: () => turso,
      encryptToken: token => `encrypted:${token}`
    });

    try {
      await assert.rejects(
        provision({
          name: 'Malformed API response',
          code: 'malformed-api',
          adminName: 'Admin',
          adminUsername: 'admin',
          planId: 1
        }, { id: 1 }),
        error => error instanceof ProvisioningError && error.statusCode === 502
      );
      assert.equal(deleted.length, 1);
      assert.match(deleted[0], /\/databases\/tf-malformed-api$/);
    } finally {
      await controlDb.close();
    }
  });
