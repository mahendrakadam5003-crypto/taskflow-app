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
    await client.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)');
    await client.execute("INSERT INTO users (id, username) VALUES (1, 'existing-company-user')");
    assert.equal(await migrateControlDatabase(client), CURRENT_SCHEMA_VERSION);
    await client.execute("UPDATE plans SET price_note = 'custom test note' WHERE id = 1");
    assert.equal(await migrateControlDatabase(client), CURRENT_SCHEMA_VERSION);

    const plansResult = await client.execute('SELECT id, name, max_users, storage_limit_mb, features_json, price_note FROM plans ORDER BY id');
    assert.equal(plansResult.rows.length, 5);
    assert.deepEqual(plansResult.rows.map(plan => [
      plan.name,
      plan.max_users == null ? null : Number(plan.max_users),
      plan.storage_limit_mb == null ? null : Number(plan.storage_limit_mb)
    ]), [
      ['Solo', 1, 1024],
      ['Team', 10, 10240],
      ['Business', 50, null],
      ['Internal / Unlimited', null, null],
      ['Trial', 3, 1024]
    ]);
    assert.deepEqual(JSON.parse(plansResult.rows[0].features_json), {
      attendance: true,
      reimbursements: true,
      export: true
    });
    assert.deepEqual(JSON.parse(plansResult.rows[3].features_json), {
      attendance: true,
      reimbursements: true,
      export: true
    });
    assert.equal(plansResult.rows[3].price_note, 'Existing company unlimited plan');
    assert.equal(plansResult.rows[4].price_note, 'Seven-day trial');
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
    const existingUser = await client.execute('SELECT username FROM users WHERE id = 1');
    assert.equal(existingUser.rows[0].username, 'existing-company-user');
    await assert.rejects(
      client.execute("INSERT INTO companies (code, name, tenant_db_url, tenant_db_token_encrypted) VALUES ('Bad_Code', 'Invalid', 'libsql://invalid.example', 'ciphertext')"),
      /CHECK constraint failed/
    );

    const tablesResult = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = new Set(tablesResult.rows.map(row => row.name));
    const expectedColumns = {
      web_sessions: ['sid', 'data', 'user_id', 'company_id', 'expires_at'],
      companies: ['id', 'code', 'name', 'owner_name', 'owner_email', 'owner_phone', 'status', 'plan_id', 'trial_ends_at', 'tenant_db_url', 'tenant_db_token_encrypted', 'notes', 'created_at', 'max_users_override', 'storage_limit_mb_override', 'last_login_at', 'tenant_db_name', 'delete_after', 'trial_policy_version'],
      plans: ['id', 'name', 'max_users', 'storage_limit_mb', 'features_json', 'price_note', 'is_active'],
      super_admins: ['id', 'name', 'username', 'password_hash', 'token_version', 'created_at'],
      super_admin_sessions: ['sid_hash', 'super_admin_id', 'token_version', 'expires_at', 'created_at'],
      usage_snapshots: ['id', 'company_id', 'taken_at', 'user_count', 'db_bytes', 'files_bytes'],
      backups: ['id', 'company_id', 'type', 'location', 'size_bytes', 'created_at', 'status', 'backup_key', 'backup_kind', 'row_counts_json', 'telegram_message_ids_json', 'telegram_channel_id', 'checksum', 'file_references_json'],
      company_restore_staging: ['id', 'source_company_id', 'backup_id', 'tenant_db_name', 'tenant_db_url', 'tenant_db_token_encrypted', 'row_counts_json', 'status', 'created_at', 'activated_at', 'reverted_at', 'previous_tenant_db_name', 'previous_tenant_db_url', 'previous_tenant_db_token_encrypted'],
      backup_tests: ['id', 'company_id', 'backup_id', 'test_month', 'status', 'expected_row_counts_json', 'actual_row_counts_json', 'details', 'created_at'],
      billing_notes: ['id', 'company_id', 'amount_text', 'note', 'marked_paid_at', 'marked_by'],
      super_admin_audit: ['id', 'super_admin_id', 'company_id', 'action', 'details', 'created_at'],
      user_error_reports: ['id', 'company_id', 'company_code', 'actor_user_id', 'request_id', 'event', 'method', 'route', 'status_code', 'created_at', 'resolved_at', 'resolved_by'],
      pricing_settings: ['id', 'currency', 'currency_symbol', 'tax_pct', 'tax_inclusive', 'trial_days', 'trial_max_users', 'trial_storage_limit_mb', 'grace_period_days', 'read_only_period_days', 'min_seats', 'max_seats', 'default_storage_per_seat_mb', 'prorate_seats', 'seat_addition_billing', 'price_change_scope', 'trial_approval_mode', 'updated_at'],
      pricing_versions: ['id', 'monthly_price_paise', 'yearly_discount_pct', 'yearly_price_paise', 'tax_pct', 'currency', 'effective_from', 'created_by', 'note', 'is_current', 'created_at'],
      pricing_tiers: ['id', 'pricing_version_id', 'tier_key', 'name', 'tagline', 'highlights', 'min_seats', 'max_seats', 'monthly_price_paise', 'yearly_price_paise', 'sort_order'],
      subscriptions: ['id', 'company_id', 'billing_cycle', 'seats', 'unit_price_paise', 'discount_pct', 'pricing_version_id', 'status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'provider', 'provider_subscription_id', 'created_at'],
      invoices: ['id', 'company_id', 'subscription_id', 'number', 'period_start', 'period_end', 'seats', 'unit_price_paise', 'subtotal_paise', 'discount_paise', 'tax_paise', 'total_paise', 'currency', 'tax_pct', 'status', 'paid_at', 'provider_payment_id', 'created_at'],
      payments: ['id', 'invoice_id', 'amount_paise', 'method', 'provider_ref', 'provider_event_id', 'raw_payload_hash', 'created_at'],
      subscription_events: ['id', 'company_id', 'subscription_id', 'actor_super_admin_id', 'event', 'details', 'created_at'],
      provider_webhook_events: ['id', 'provider', 'provider_event_id', 'payload_hash', 'processed_at'],
      demo_requests: ['id', 'name', 'email', 'phone', 'company_name', 'team_size', 'message', 'status', 'consented_at', 'approved_by', 'company_id', 'created_at', 'updated_at'],
      coupons: ['id', 'code', 'discount_type', 'discount_value', 'expires_at', 'max_uses', 'uses', 'is_active', 'created_at'],
      company_price_overrides: ['company_id', 'unit_price_paise', 'currency', 'created_by', 'note', 'updated_at'],
      entitlement_notifications: ['id', 'company_id', 'event_key', 'notification_type', 'recipient_email', 'status', 'attempts', 'created_at', 'last_attempt_at', 'sent_at'],
      invoice_sequences: ['year', 'last_number'],
      subscription_change_requests: ['id', 'company_id', 'requested_by_user_id', 'requested_seats', 'requested_billing_cycle', 'status', 'invoice_id', 'previous_subscription_id', 'reviewed_by', 'reviewed_at', 'created_at'],
      control_schema_migrations: ['version', 'applied_at']
    };
    for (const [table, columns] of Object.entries(expectedColumns)) {
      assert.ok(tables.has(table), `expected control table ${table}`);
      const columnResult = await client.execute(`PRAGMA table_info(${table})`);
      assert.deepEqual(columnResult.rows.map(column => column.name), columns, `expected columns on ${table}`);
    }
    const migrations = await client.execute('SELECT version FROM control_schema_migrations');
    assert.deepEqual(migrations.rows.map(row => Number(row.version)), [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, CURRENT_SCHEMA_VERSION
    ]);
    const pricing = await client.execute('SELECT monthly_price_paise, yearly_discount_pct, yearly_price_paise, tax_pct, currency, is_current FROM pricing_versions');
    assert.deepEqual(pricing.rows.map(row => [Number(row.monthly_price_paise), Number(row.yearly_discount_pct), Number(row.yearly_price_paise), Number(row.tax_pct), row.currency, Number(row.is_current)]), [[19900, 10, 214920, 18, 'INR', 1]]);
    const pricingTiers = await client.execute('SELECT tier_key, name, min_seats, max_seats, monthly_price_paise, yearly_price_paise FROM pricing_tiers ORDER BY pricing_version_id, sort_order');
    assert.deepEqual(pricingTiers.rows.map(row => [
      row.tier_key, row.name, Number(row.min_seats), row.max_seats,
      Number(row.monthly_price_paise), Number(row.yearly_price_paise)
    ]), [['standard', 'Standard', 1, null, 19900, 214920]]);
    const pricingSettings = await client.execute('SELECT trial_days, trial_max_users, trial_storage_limit_mb, grace_period_days, read_only_period_days, trial_approval_mode, seat_addition_billing FROM pricing_settings WHERE id = 1');
    assert.deepEqual(pricingSettings.rows.map(row => [Number(row.trial_days), Number(row.trial_max_users), Number(row.trial_storage_limit_mb), Number(row.grace_period_days), Number(row.read_only_period_days), row.trial_approval_mode, row.seat_addition_billing]), [[7, 3, 1024, 3, 7, 'manual', 'immediate']]);
  } finally {
    await client.close();
  }
});

test('control migration enforces manually approved trials without touching tenant records', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await migrateControlDatabase(client);
    await client.execute("UPDATE pricing_settings SET trial_approval_mode = 'auto' WHERE id = 1");
    await client.execute('DELETE FROM control_schema_migrations WHERE version IN (13, 14)');
    assert.equal(await migrateControlDatabase(client), CURRENT_SCHEMA_VERSION);
    const result = await client.execute('SELECT trial_approval_mode FROM pricing_settings WHERE id = 1');
    assert.equal(result.rows[0].trial_approval_mode, 'manual');
    const migration = await client.execute('SELECT version FROM control_schema_migrations WHERE version = 13');
    assert.equal(migration.rows.length, 1);
  } finally {
    await client.close();
  }
});

test('pricing tier migration backfills every version without overwriting custom prices or duplicating rows', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await migrateControlDatabase(client);
    await client.execute('UPDATE pricing_versions SET monthly_price_paise = 30100, yearly_price_paise = 325080');
    await client.execute('DELETE FROM pricing_tiers');
    await client.execute('DELETE FROM control_schema_migrations WHERE version = 14');
    await migrateControlDatabase(client);
    await migrateControlDatabase(client);

    const backfilled = await client.execute(`SELECT tier_key, name, min_seats, max_seats,
      monthly_price_paise, yearly_price_paise FROM pricing_tiers`);
    assert.deepEqual(backfilled.rows.map(row => [
      row.tier_key, row.name, Number(row.min_seats), row.max_seats,
      Number(row.monthly_price_paise), Number(row.yearly_price_paise)
    ]), [['standard', 'Standard', 1, null, 30100, 325080]]);
    const count = await client.execute('SELECT COUNT(*) AS count FROM pricing_tiers');
    assert.equal(Number(count.rows[0].count), 1);
  } finally {
    await client.close();
  }
});

test('control database accepts explicit remote configuration', async () => {
  assert.throws(
    () => getControlDatabaseConfig({}),
    /TURSO_DATABASE_URL and TURSO_AUTH_TOKEN/
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

test('control database migration adds company ownership to an existing tenant session table', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      user_id INTEGER,
      expires_at INTEGER NOT NULL
    )`);
    await client.execute({
      sql: 'INSERT INTO web_sessions (sid, data, user_id, expires_at) VALUES (?, ?, ?, ?)',
      args: ['preexisting-session', '{"userId":7}', 7, Date.now() + 60_000]
    });

    await migrateControlDatabase(client);
    const columns = await client.execute('PRAGMA table_info(web_sessions)');
    assert.ok(columns.rows.some(column => column.name === 'company_id'));
    const sessionRow = await client.execute({
      sql: 'SELECT sid, data, user_id FROM web_sessions WHERE sid = ?',
      args: ['preexisting-session']
    });
    assert.equal(sessionRow.rows[0].sid, 'preexisting-session');
    assert.equal(sessionRow.rows[0].data, '{"userId":7}');
    assert.equal(Number(sessionRow.rows[0].user_id), 7);
  } finally {
    await client.close();
  }
});

test('control database reuses company Turso credentials by default', async () => {
  assert.deepEqual(getControlDatabaseConfig({
    TURSO_DATABASE_URL: 'libsql://company.example',
    TURSO_AUTH_TOKEN: 'Bearer company-token'
  }), {
    url: 'libsql://company.example',
    authToken: 'company-token'
  });
  assert.deepEqual(getControlDatabaseConfig({
    TURSO_DATABASE_URL: 'libsql://company.example',
    TURSO_AUTH_TOKEN: 'company-token',
    CONTROL_DATABASE_URL: 'https://control.example',
    CONTROL_AUTH_TOKEN: 'control-token'
  }), {
    url: 'https://control.example',
    authToken: 'control-token'
  });
  assert.throws(
    () => getControlDatabaseConfig({
      TURSO_DATABASE_URL: 'libsql://company.example',
      TURSO_AUTH_TOKEN: 'company-token',
      CONTROL_DATABASE_URL: 'libsql://control.example'
    }),
    /Set both CONTROL_DATABASE_URL and CONTROL_AUTH_TOKEN/
  );

  const client = createControlDatabaseClient({
    TURSO_DATABASE_URL: 'https://company.example',
    TURSO_AUTH_TOKEN: 'company-token'
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
    await client.execute(`CREATE TABLE plans (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      max_users INTEGER,
      storage_limit_mb INTEGER,
      features_json TEXT NOT NULL,
      price_note TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1
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
