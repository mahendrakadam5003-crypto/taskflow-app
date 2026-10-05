'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const {
  decryptTenantDatabaseToken,
  encryptTenantDatabaseToken,
  migrateControlDatabase
} = require('../control-db');
const { getLegacyDatabaseConfig, registerLegacyCompany } = require('../scripts/register-legacy-company');

const encryptionKey = '51'.repeat(32);
const environment = {
  TURSO_DATABASE_URL: 'libsql://current-company.turso.io',
  TURSO_AUTH_TOKEN: 'Bearer existing-company-token',
  APP_ENCRYPTION_KEY: encryptionKey
};

async function createTestDatabase() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-phase4-'));
  const databasePath = path.join(directory, 'company.db').replace(/\\/g, '/');
  const client = createClient({ url: `file:${databasePath}` });
  return {
    client,
    async close() {
      await client.close();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

test('existing company registration is idempotent and preserves company login and data', async () => {
  const { client, close } = await createTestDatabase();
  await client.execute(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL
  )`);
  await client.execute({
    sql: 'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
    args: [1, 'admin', 'existing-company-password-hash', 'admin']
  });
  await migrateControlDatabase(client);

  try {
    const register = () => registerLegacyCompany({
      environment,
      getDatabase: async () => client,
      encryptToken: token => encryptTenantDatabaseToken(token, encryptionKey)
    });
    const first = await register();
    assert.deepEqual(first, {
      status: 'registered',
      companyId: 1,
      code: 'existing-company',
      name: 'Existing Company'
    });

    const second = await register();
    assert.deepEqual(second, {
      status: 'already-registered',
      companyId: 1,
      code: 'existing-company',
      name: 'Existing Company'
    });

    const company = await client.execute({
      sql: `SELECT c.code, c.name, c.status, c.plan_id, p.name AS plan_name,
          c.tenant_db_url, c.tenant_db_token_encrypted
        FROM companies c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = ?`,
      args: [first.companyId]
    });
    assert.equal(company.rows.length, 1);
    assert.equal(company.rows[0].status, 'active');
    assert.equal(company.rows[0].plan_name, 'Internal / Unlimited');
    assert.equal(company.rows[0].plan_id != null, true);
    assert.equal(company.rows[0].tenant_db_url, environment.TURSO_DATABASE_URL);
    assert.equal(
      decryptTenantDatabaseToken(company.rows[0].tenant_db_token_encrypted, encryptionKey),
      'existing-company-token'
    );
    assert.equal(
      (await client.execute('SELECT COUNT(*) AS count FROM companies')).rows[0].count,
      1
    );

    const existingUsers = await client.execute('SELECT id, username, password_hash, role FROM users');
    assert.deepEqual(existingUsers.rows, [{
      id: 1,
      username: 'admin',
      password_hash: 'existing-company-password-hash',
      role: 'admin'
    }]);
    const audit = await client.execute({
      sql: 'SELECT action FROM super_admin_audit WHERE company_id = ?',
      args: [first.companyId]
    });
    assert.deepEqual(audit.rows.map(row => row.action), ['Existing company linked']);

    const soloPlan = await client.execute("SELECT id FROM plans WHERE name = 'Solo'");
    await client.execute({
      sql: "UPDATE companies SET status = 'suspended', plan_id = ? WHERE id = ?",
      args: [Number(soloPlan.rows[0].id), first.companyId]
    });
    const repeatedRegistration = await register();
    assert.equal(repeatedRegistration.status, 'already-registered');
    const preservedStatus = await client.execute({
      sql: `SELECT c.status, p.name AS plan_name FROM companies c
        LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = ?`,
      args: [first.companyId]
    });
    assert.equal(preservedStatus.rows[0].status, 'suspended', 'registration must not undo a manual status change');
    assert.equal(preservedStatus.rows[0].plan_name, 'Internal / Unlimited');
    const auditAfterRepair = await client.execute({
      sql: 'SELECT action FROM super_admin_audit WHERE company_id = ? ORDER BY id',
      args: [first.companyId]
    });
    assert.deepEqual(auditAfterRepair.rows.map(row => row.action), [
      'Existing company linked',
      'Internal plan assigned'
    ]);

    const unchangedUsers = await client.execute('SELECT id, username, password_hash, role FROM users');
    assert.deepEqual(unchangedUsers.rows, existingUsers.rows);
  } finally {
    await close();
  }
});

test('existing company registration refuses code collisions and missing encryption keys', async () => {
  assert.deepEqual(getLegacyDatabaseConfig({ USE_LOCAL_DB: '1' }), null);
  assert.throws(
    () => getLegacyDatabaseConfig({ TURSO_AUTH_TOKEN: 'token' }),
    /TURSO_DATABASE_URL and TURSO_AUTH_TOKEN/
  );

  let databaseOpened = false;
  await assert.rejects(
    registerLegacyCompany({
      environment: {
        TURSO_DATABASE_URL: 'libsql://current-company.turso.io',
        TURSO_AUTH_TOKEN: 'existing-company-token'
      },
      getDatabase: async () => {
        databaseOpened = true;
        throw new Error('Database should not open without encryption key');
      }
    }),
    /APP_ENCRYPTION_KEY must be a 32-byte key/
  );
  assert.equal(databaseOpened, false);

  const { client, close } = await createTestDatabase();
  await migrateControlDatabase(client);
  await client.execute({
    sql: `INSERT INTO companies (code, name, tenant_db_url, tenant_db_token_encrypted)
      VALUES (?, ?, ?, ?)`,
    args: ['existing-company', 'Another Company', 'libsql://another-company.turso.io', 'existing-encrypted-token']
  });
  try {
    await assert.rejects(
      registerLegacyCompany({
        environment,
        getDatabase: async () => client,
        encryptToken: token => encryptTenantDatabaseToken(token, encryptionKey)
      }),
      /already linked to a different database/
    );
    assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM companies')).rows[0].count), 1);
    const original = await client.execute('SELECT name, tenant_db_url, tenant_db_token_encrypted FROM companies');
    assert.deepEqual(original.rows[0], {
      name: 'Another Company',
      tenant_db_url: 'libsql://another-company.turso.io',
      tenant_db_token_encrypted: 'existing-encrypted-token'
    });
  } finally {
    await close();
  }
});

test('company code and display name overrides are validated before database access', async () => {
  let opened = false;
  const getDatabase = async () => {
    opened = true;
    throw new Error('Database should not open for invalid company metadata');
  };
  await assert.rejects(
    registerLegacyCompany({
      environment: { ...environment, LEGACY_COMPANY_CODE: 'Existing_Company' },
      getDatabase,
      encryptToken: () => 'encrypted-token'
    }),
    /LEGACY_COMPANY_CODE must be a valid lowercase company code/
  );
  await assert.rejects(
    registerLegacyCompany({
      environment: { ...environment, LEGACY_COMPANY_NAME: ' ' },
      getDatabase,
      encryptToken: () => 'encrypted-token'
    }),
    /LEGACY_COMPANY_NAME must contain 1 to 160 characters/
  );
  assert.equal(opened, false);
});
