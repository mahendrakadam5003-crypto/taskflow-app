'use strict';

const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const {
  CURRENT_SCHEMA_VERSION,
  createControlDatabaseClient,
  decryptTenantDatabaseToken,
  encryptTenantDatabaseToken,
  getControlDatabaseConfig,
  migrateControlDatabase
} = require('../control-db');

test('control database migration is versioned, repeatable, and seeds sample plans once', async () => {
  const client = createClient({ url: 'file::memory:' });

  try {
    assert.equal(await migrateControlDatabase(client), CURRENT_SCHEMA_VERSION);
    await client.execute("UPDATE plans SET price_note = 'custom test note' WHERE id = 1");
    assert.equal(await migrateControlDatabase(client), CURRENT_SCHEMA_VERSION);

    const plansResult = await client.execute('SELECT id, name, max_users, storage_limit_mb, features_json, price_note FROM plans ORDER BY id');
    assert.equal(plansResult.rows.length, 3);
    assert.deepEqual(plansResult.rows.map(plan => [plan.name, Number(plan.max_users), plan.storage_limit_mb == null ? null : Number(plan.storage_limit_mb)]), [
      ['Solo', 1, 1024],
      ['Team', 10, 10240],
      ['Business', 50, null]
    ]);
    assert.deepEqual(JSON.parse(plansResult.rows[0].features_json), {
      attendance: true,
      reimbursements: true,
      export: true
    });
    assert.equal(plansResult.rows[0].price_note, 'custom test note', 'rerunning migration preserves edited plan data');

    const tokenCiphertext = encryptTenantDatabaseToken('tenant-token-for-schema-test', '42'.repeat(32));
    await client.execute({
      sql: `INSERT INTO companies (code, name, owner_name, owner_email, owner_phone, status, plan_id, trial_ends_at,
        tenant_db_url, tenant_db_token_encrypted, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['solo-test', 'Solo Test', 'Test Owner', 'owner@example.test', '555-0100', 'trial', 1, '2027-01-01', 'libsql://solo.example', tokenCiphertext, 'test company']
    });
    const companyResult = await client.execute("SELECT code, status, tenant_db_token_encrypted FROM companies WHERE code = 'solo-test'");
    assert.equal(companyResult.rows.length, 1);
    assert.equal(companyResult.rows[0].tenant_db_token_encrypted, tokenCiphertext);
    await assert.rejects(
      client.execute("INSERT INTO companies (code, name, tenant_db_url, tenant_db_token_encrypted) VALUES ('Bad_Code', 'Invalid', 'libsql://invalid.example', 'ciphertext')"),
      /CHECK constraint failed/
    );

    const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = new Set(tablesResult.rows.map(row => row.name));
    const expectedColumns = {
      companies: ['id', 'code', 'name', 'owner_name', 'owner_email', 'owner_phone', 'status', 'plan_id', 'trial_ends_at', 'tenant_db_url', 'tenant_db_token_encrypted', 'notes', 'created_at'],
      plans: ['id', 'name', 'max_users', 'storage_limit_mb', 'features_json', 'price_note', 'is_active'],
      super_admins: ['id', 'name', 'username', 'password_hash', 'token_version', 'created_at'],
      super_admin_sessions: ['sid_hash', 'super_admin_id', 'token_version', 'expires_at', 'created_at'],
      usage_snapshots: ['id', 'company_id', 'taken_at', 'user_count', 'db_bytes', 'files_bytes'],
      backups: ['id', 'company_id', 'type', 'location', 'size_bytes', 'created_at', 'status'],
      billing_notes: ['id', 'company_id', 'amount_text', 'note', 'marked_paid_at', 'marked_by'],
      super_admin_audit: ['id', 'super_admin_id', 'company_id', 'action', 'details', 'created_at'],
      control_schema_migrations: ['version', 'applied_at']
    };
    for (const [table, columns] of Object.entries(expectedColumns)) {
      assert.ok(tables.has(table), `expected control table ${table}`);
      const columnResult = await client.execute(`PRAGMA table_info(${table})`);
      assert.deepEqual(columnResult.rows.map(column => column.name), columns, `expected columns on ${table}`);
    }
    const migrations = await client.execute('SELECT version FROM control_schema_migrations');
    assert.deepEqual(migrations.rows.map(row => Number(row.version)), [1, 2, CURRENT_SCHEMA_VERSION]);
  } finally {
    await client.close();
  }
});

test('control database client requires its own remote Turso configuration', async () => {
  assert.throws(
    () => getControlDatabaseConfig({}),
    /CONTROL_DATABASE_URL and CONTROL_AUTH_TOKEN are required/
  );
  assert.throws(
    () => getControlDatabaseConfig({ CONTROL_DATABASE_URL: 'file:control.db', CONTROL_AUTH_TOKEN: 'test-token' }),
    /must be a remote libsql:\/\/ or https:\/\//
  );

  assert.deepEqual(getControlDatabaseConfig({
    CONTROL_DATABASE_URL: 'libsql://control.example',
    CONTROL_AUTH_TOKEN: 'Bearer test-control-token'
  }), {
    url: 'libsql://control.example',
    authToken: 'test-control-token'
  });

  const client = createControlDatabaseClient({
    CONTROL_DATABASE_URL: 'https://control.example',
    CONTROL_AUTH_TOKEN: 'test-control-token'
  });
  assert.equal(typeof client.execute, 'function');
  await client.close();
});

test('control schema migration preserves existing super-admin login identifiers', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE control_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await client.execute(`CREATE TABLE super_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await client.execute("INSERT INTO control_schema_migrations (version) VALUES (1), (2)");
    await client.execute({
      sql: 'INSERT INTO super_admins (name, email, password_hash) VALUES (?, ?, ?)',
      args: ['Existing Owner', 'owner@example.test', 'existing-hash']
    });

    assert.equal(await migrateControlDatabase(client), CURRENT_SCHEMA_VERSION);
    const admins = await client.execute('SELECT name, username, password_hash FROM super_admins');
    assert.deepEqual(admins.rows.map(admin => [admin.name, admin.username, admin.password_hash]), [
      ['Existing Owner', 'owner@example.test', 'existing-hash']
    ]);
    const columns = await client.execute('PRAGMA table_info(super_admins)');
    assert.ok(columns.rows.some(column => column.name === 'username'));
    assert.ok(!columns.rows.some(column => column.name === 'email'));
  } finally {
    await client.close();
  }
});

test('tenant database tokens are encrypted with authenticated encryption', () => {
  const hexKey = '42'.repeat(32);
  const originalToken = 'tenant-db-secret-token';
  const firstEncrypted = encryptTenantDatabaseToken(originalToken, hexKey);
  const secondEncrypted = encryptTenantDatabaseToken(originalToken, hexKey);

  assert.match(firstEncrypted, /^v1\./);
  assert.notEqual(firstEncrypted, secondEncrypted, 'encryption uses a fresh random IV');
  assert.doesNotMatch(firstEncrypted, new RegExp(originalToken));
  assert.equal(decryptTenantDatabaseToken(firstEncrypted, hexKey), originalToken);
  const base64Key = Buffer.alloc(32, 7).toString('base64');
  assert.equal(decryptTenantDatabaseToken(encryptTenantDatabaseToken(originalToken, base64Key), base64Key), originalToken);
  assert.throws(() => encryptTenantDatabaseToken(originalToken, 'not-a-key'), /32-byte key/);
  assert.throws(() => encryptTenantDatabaseToken('', hexKey), /non-empty tenant database token/);
  assert.throws(() => decryptTenantDatabaseToken(firstEncrypted, '43'.repeat(32)), /Unable to decrypt tenant database token/);
  assert.throws(() => decryptTenantDatabaseToken('v2.invalid.invalid.invalid', hexKey), /unsupported or invalid format/);
});
