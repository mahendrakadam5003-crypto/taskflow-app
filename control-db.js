'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

const CURRENT_SCHEMA_VERSION = 12;

const CONTROL_MIGRATIONS = [{
  version: 1,
  statements: [
    `CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      max_users INTEGER,
      storage_limit_mb INTEGER,
      features_json TEXT NOT NULL,
      price_note TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
    )`,
    `CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE CHECK (
        length(code) BETWEEN 1 AND 63
        AND code = lower(code)
        AND code NOT GLOB '*[^a-z0-9-]*'
        AND substr(code, 1, 1) GLOB '[a-z0-9]'
        AND substr(code, -1, 1) GLOB '[a-z0-9]'
      ),
      name TEXT NOT NULL,
      owner_name TEXT,
      owner_email TEXT,
      owner_phone TEXT,
      status TEXT NOT NULL DEFAULT 'trial'
        CHECK (status IN ('trial', 'active', 'suspended', 'cancelled', 'deleted')),
      plan_id INTEGER REFERENCES plans(id) ON DELETE RESTRICT,
      trial_ends_at TEXT,
      tenant_db_url TEXT NOT NULL,
      tenant_db_token_encrypted TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS super_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      taken_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_count INTEGER NOT NULL DEFAULT 0,
      db_bytes INTEGER NOT NULL DEFAULT 0,
      files_bytes INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      location TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS billing_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      amount_text TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      marked_paid_at TEXT,
      marked_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS super_admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      super_admin_id INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
      company_id INTEGER,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS usage_snapshots_company_taken_idx ON usage_snapshots(company_id, taken_at)',
    'CREATE INDEX IF NOT EXISTS backups_company_created_idx ON backups(company_id, created_at)',
    'CREATE INDEX IF NOT EXISTS billing_notes_company_idx ON billing_notes(company_id)',
    'CREATE INDEX IF NOT EXISTS super_admin_audit_company_created_idx ON super_admin_audit(company_id, created_at)',
    {
      sql: 'INSERT OR IGNORE INTO plans (id, name, max_users, storage_limit_mb, features_json, price_note) VALUES (?, ?, ?, ?, ?, ?)',
      args: [1, 'Solo', 1, 1024, JSON.stringify({ attendance: true, reimbursements: true, export: true }), 'Free three-month test']
    },
    {
      sql: 'INSERT OR IGNORE INTO plans (id, name, max_users, storage_limit_mb, features_json, price_note) VALUES (?, ?, ?, ?, ?, ?)',
      args: [2, 'Team', 10, 10240, JSON.stringify({ attendance: true, reimbursements: true, export: true }), 'Free three-month test']
    },
    {
      sql: 'INSERT OR IGNORE INTO plans (id, name, max_users, storage_limit_mb, features_json, price_note) VALUES (?, ?, ?, ?, ?, ?)',
      args: [3, 'Business', 50, null, JSON.stringify({ attendance: true, reimbursements: true, export: true }), 'Free three-month test']
    },
    {
      sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)',
      args: [1]
    }
  ]
}, {
  version: 2,
  statements: [
    `CREATE TABLE IF NOT EXISTS super_admin_sessions (
      sid_hash TEXT PRIMARY KEY,
      super_admin_id INTEGER NOT NULL REFERENCES super_admins(id) ON DELETE CASCADE,
      token_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS super_admin_sessions_expires_at_idx ON super_admin_sessions(expires_at)',
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [2] }
  ]
}, {
  version: 3,
  statements: [
    'ALTER TABLE super_admins RENAME COLUMN email TO username',
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [3] }
  ]
}, {
  version: 4,
  statements: [
    `CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      user_id INTEGER,
      company_id TEXT,
      expires_at INTEGER NOT NULL
    )`,
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [4] }
  ]
}, {
  version: 5,
  statements: [
    {
      sql: `INSERT INTO plans (name, max_users, storage_limit_mb, features_json, price_note, is_active)
        VALUES (?, NULL, NULL, ?, ?, 1)
        ON CONFLICT(name) DO UPDATE SET max_users = NULL, storage_limit_mb = NULL,
          features_json = excluded.features_json, price_note = excluded.price_note, is_active = 1`,
      args: [
        'Internal / Unlimited',
        JSON.stringify({ attendance: true, reimbursements: true, export: true }),
        'Existing company unlimited plan'
      ]
    },
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [5] }
  ]
}, {
  version: 6,
  statements: [
    'ALTER TABLE companies ADD COLUMN max_users_override INTEGER',
    'ALTER TABLE companies ADD COLUMN storage_limit_mb_override INTEGER',
    'ALTER TABLE companies ADD COLUMN last_login_at TEXT',
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [6] }
  ]
}, {
  version: 7,
  statements: [
    'ALTER TABLE companies ADD COLUMN tenant_db_name TEXT',
    'ALTER TABLE companies ADD COLUMN delete_after TEXT',
    'ALTER TABLE backups ADD COLUMN backup_key TEXT',
    "ALTER TABLE backups ADD COLUMN backup_kind TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE backups ADD COLUMN row_counts_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE backups ADD COLUMN telegram_message_ids_json TEXT NOT NULL DEFAULT '[]'",
    'ALTER TABLE backups ADD COLUMN telegram_channel_id TEXT',
    'ALTER TABLE backups ADD COLUMN checksum TEXT',
    "ALTER TABLE backups ADD COLUMN file_references_json TEXT NOT NULL DEFAULT '[]'",
    `CREATE TABLE IF NOT EXISTS company_restore_staging (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      backup_id INTEGER NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
      tenant_db_name TEXT,
      tenant_db_url TEXT NOT NULL,
      tenant_db_token_encrypted TEXT NOT NULL,
      row_counts_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'activated', 'reverted', 'discarded', 'failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      activated_at TEXT,
      reverted_at TEXT,
      previous_tenant_db_name TEXT,
      previous_tenant_db_url TEXT,
      previous_tenant_db_token_encrypted TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS backup_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      backup_id INTEGER NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
      test_month TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
      expected_row_counts_json TEXT NOT NULL,
      actual_row_counts_json TEXT NOT NULL DEFAULT '{}',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, test_month)
    )`,
    'CREATE INDEX IF NOT EXISTS backups_company_key_idx ON backups(company_id, backup_key, backup_kind)',
    'CREATE INDEX IF NOT EXISTS companies_delete_after_idx ON companies(status, delete_after)',
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [7] }
  ]
  }, {
    version: 8,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_error_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        company_code TEXT,
        actor_user_id INTEGER,
        request_id TEXT NOT NULL,
        event TEXT NOT NULL,
        method TEXT NOT NULL,
        route TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolved_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL
      )`,
      'CREATE INDEX IF NOT EXISTS user_error_reports_status_created_idx ON user_error_reports(resolved_at, created_at)',
      'CREATE INDEX IF NOT EXISTS user_error_reports_company_created_idx ON user_error_reports(company_id, created_at)',
      { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [8] }
    ]
}, {
  version: 9,
  statements: [
    `CREATE TABLE IF NOT EXISTS pricing_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      currency TEXT NOT NULL DEFAULT 'INR',
      currency_symbol TEXT NOT NULL DEFAULT 'Rs.',
      tax_pct REAL NOT NULL DEFAULT 18 CHECK (tax_pct BETWEEN 0 AND 100),
      tax_inclusive INTEGER NOT NULL DEFAULT 0 CHECK (tax_inclusive IN (0, 1)),
      trial_days INTEGER NOT NULL DEFAULT 7 CHECK (trial_days BETWEEN 1 AND 60),
      trial_max_users INTEGER NOT NULL DEFAULT 3 CHECK (trial_max_users >= 1),
      trial_storage_limit_mb INTEGER NOT NULL DEFAULT 1024 CHECK (trial_storage_limit_mb >= 0),
      grace_period_days INTEGER NOT NULL DEFAULT 3 CHECK (grace_period_days >= 0),
      read_only_period_days INTEGER NOT NULL DEFAULT 7 CHECK (read_only_period_days >= 0),
      min_seats INTEGER NOT NULL DEFAULT 1 CHECK (min_seats >= 1),
      max_seats INTEGER CHECK (max_seats IS NULL OR max_seats >= min_seats),
      default_storage_per_seat_mb INTEGER CHECK (default_storage_per_seat_mb IS NULL OR default_storage_per_seat_mb >= 0),
      prorate_seats INTEGER NOT NULL DEFAULT 1 CHECK (prorate_seats IN (0, 1)),
      seat_addition_billing TEXT NOT NULL DEFAULT 'immediate' CHECK (seat_addition_billing IN ('immediate', 'next_invoice')),
      price_change_scope TEXT NOT NULL DEFAULT 'new_customers' CHECK (price_change_scope IN ('new_customers', 'existing_next_renewal')),
      trial_approval_mode TEXT NOT NULL DEFAULT 'manual' CHECK (trial_approval_mode IN ('manual', 'auto')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS pricing_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monthly_price_paise INTEGER NOT NULL CHECK (monthly_price_paise >= 0),
      yearly_discount_pct REAL NOT NULL CHECK (yearly_discount_pct BETWEEN 0 AND 100),
      yearly_price_paise INTEGER NOT NULL CHECK (yearly_price_paise >= 0),
      tax_pct REAL NOT NULL CHECK (tax_pct BETWEEN 0 AND 100),
      currency TEXT NOT NULL DEFAULT 'INR',
      effective_from TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
      note TEXT NOT NULL DEFAULT '',
      is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS pricing_versions_one_current_idx ON pricing_versions(is_current) WHERE is_current = 1',
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
      seats INTEGER NOT NULL CHECK (seats >= 1),
      unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
      discount_pct REAL NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
      pricing_version_id INTEGER REFERENCES pricing_versions(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
      provider TEXT NOT NULL DEFAULT 'manual',
      provider_subscription_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS subscriptions_company_status_idx ON subscriptions(company_id, status)',
    `CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
      number TEXT NOT NULL UNIQUE,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      seats INTEGER NOT NULL CHECK (seats >= 1),
      unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
      subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise >= 0),
      discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
      tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
      total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      tax_pct REAL NOT NULL DEFAULT 18 CHECK (tax_pct BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void')),
      paid_at TEXT,
      provider_payment_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS invoices_company_created_idx ON invoices(company_id, created_at)',
    `CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
      method TEXT NOT NULL,
      provider_ref TEXT,
      provider_event_id TEXT UNIQUE,
      raw_payload_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
      actor_super_admin_id INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS subscription_events_company_created_idx ON subscription_events(company_id, created_at)',
    `CREATE TABLE IF NOT EXISTS provider_webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_event_id)
    )`,
    `CREATE TABLE IF NOT EXISTS demo_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      company_name TEXT NOT NULL,
      team_size INTEGER NOT NULL DEFAULT 1 CHECK (team_size >= 1),
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'rejected', 'converted')),
      consented_at TEXT NOT NULL,
      approved_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS demo_requests_status_created_idx ON demo_requests(status, created_at)',
    `CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed_paise')),
      discount_value INTEGER NOT NULL CHECK (discount_value >= 0),
      expires_at TEXT,
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 0),
      uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS company_price_overrides (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      created_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    { sql: `INSERT OR IGNORE INTO pricing_settings (id) VALUES (1)`, args: [] },
    {
      sql: `INSERT OR IGNORE INTO pricing_versions (
        monthly_price_paise, yearly_discount_pct, yearly_price_paise, tax_pct, currency, note, is_current
      ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
      args: [19900, 10, 214920, 18, 'INR', 'Initial default pricing']
    },
    {
      sql: `INSERT OR IGNORE INTO plans (name, max_users, storage_limit_mb, features_json, price_note, is_active)
        VALUES (?, ?, ?, ?, ?, 1)`,
      args: ['Trial', 3, 1024, JSON.stringify({ attendance: true, reimbursements: true, export: true }), 'Seven-day trial']
    },
    { sql: `UPDATE plans SET price_note = 'Existing plan; subscription billing not configured' WHERE price_note = 'Free three-month test'`, args: [] },
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [9] }
  ]
}, {
  version: 10,
  statements: [
    'ALTER TABLE companies ADD COLUMN trial_policy_version INTEGER',
    `CREATE TABLE IF NOT EXISTS entitlement_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      notification_type TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at TEXT,
      sent_at TEXT,
      UNIQUE(company_id, event_key)
    )`,
    'CREATE INDEX IF NOT EXISTS entitlement_notifications_status_idx ON entitlement_notifications(status, created_at)',
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [10] }
  ]
}, {
  version: 11,
  statements: [
    `CREATE TABLE IF NOT EXISTS invoice_sequences (
      year INTEGER PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0)
    )`,
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [11] }
  ]
}, {
  version: 12,
  statements: [
    `CREATE TABLE IF NOT EXISTS subscription_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      requested_by_user_id INTEGER,
      requested_seats INTEGER NOT NULL CHECK (requested_seats >= 1),
      requested_billing_cycle TEXT NOT NULL CHECK (requested_billing_cycle IN ('monthly', 'yearly')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'rejected')),
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      previous_subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
      reviewed_by INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    'CREATE INDEX IF NOT EXISTS subscription_change_requests_company_idx ON subscription_change_requests(company_id, created_at)',
    'CREATE UNIQUE INDEX IF NOT EXISTS subscription_change_requests_one_pending_idx ON subscription_change_requests(company_id) WHERE status = \'pending\'',
    { sql: 'INSERT OR IGNORE INTO control_schema_migrations (version) VALUES (?)', args: [12] }
  ]
}];

function getControlDatabaseConfig(environment = process.env) {
  const hasExplicitControlConfig = Boolean(environment.CONTROL_DATABASE_URL || environment.CONTROL_AUTH_TOKEN);
  const url = String(hasExplicitControlConfig ? environment.CONTROL_DATABASE_URL || '' : environment.TURSO_DATABASE_URL || '').trim();
  const token = hasExplicitControlConfig ? environment.CONTROL_AUTH_TOKEN : environment.TURSO_AUTH_TOKEN;
  const authToken = String(token || '').trim().replace(/^Bearer\s+/i, '').trim();

  if (!url || !authToken) {
    throw new Error('Set both CONTROL_DATABASE_URL and CONTROL_AUTH_TOKEN, or configure TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to share the company database.');
  }
  if (!/^libsql:\/\//i.test(url) && !/^https:\/\//i.test(url)) {
    throw new Error('The control database URL must be a remote libsql:// or https:// URL.');
  }

  return { url, authToken };
}

function createControlDatabaseClient(environment = process.env) {
  return createClient(getControlDatabaseConfig(environment));
}

async function migrateControlDatabase(client) {
  if (!client || typeof client.execute !== 'function' || typeof client.batch !== 'function') {
    throw new TypeError('A compatible libsql client is required to migrate the control database.');
  }

  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(`CREATE TABLE IF NOT EXISTS control_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const versionRow = await client.execute('SELECT MAX(version) AS version FROM control_schema_migrations');
  let version = Number(versionRow.rows?.[0]?.version || 0);
  for (const migration of CONTROL_MIGRATIONS) {
    if (version >= migration.version) continue;
    if (migration.version === 4) {
      await client.execute(migration.statements[0]);
      const columns = await client.execute('PRAGMA table_info(web_sessions)');
      if (!columns.rows.some(column => column.name === 'company_id')) {
        await client.execute('ALTER TABLE web_sessions ADD COLUMN company_id TEXT');
      }
      await client.execute('CREATE INDEX IF NOT EXISTS web_sessions_company_user_idx ON web_sessions(company_id, user_id)');
      await client.execute('CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx ON web_sessions(expires_at)');
      await client.execute(migration.statements[1]);
    } else if (migration.version === 6) {
      const companiesTable = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companies'");
      if (companiesTable.rows?.length) {
        const columns = await client.execute('PRAGMA table_info(companies)');
        const existingColumns = new Set(columns.rows.map(column => column.name));
        for (const statement of migration.statements.slice(0, 3)) {
          const columnName = statement.match(/ADD COLUMN (\w+)/)?.[1];
          if (columnName && !existingColumns.has(columnName)) await client.execute(statement);
        }
      }
      await client.execute(migration.statements[3]);
    } else if (migration.version === 7) {
      for (const statement of migration.statements) {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        const alterMatch = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
        if (alterMatch) {
          const table = alterMatch[1];
          const column = alterMatch[2];
          const tableResult = await client.execute({
            sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            args: [table]
          });
          if (!tableResult.rows?.length) continue;
          const columns = await client.execute(`PRAGMA table_info(${table})`);
          if (!columns.rows.some(row => row.name === column)) await client.execute(statement);
          continue;
        }
        const indexMatch = sql.match(/^CREATE INDEX IF NOT EXISTS \w+ ON (\w+)/i);
        if (indexMatch) {
          const tableResult = await client.execute({
            sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            args: [indexMatch[1]]
          });
          if (!tableResult.rows?.length) continue;
        }
        await client.execute(statement);
      }
    } else if (migration.version === 10) {
      const companiesTable = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companies'");
      if (companiesTable.rows?.length) {
        const columns = await client.execute('PRAGMA table_info(companies)');
        if (!columns.rows.some(row => row.name === 'trial_policy_version')) {
          await client.execute(migration.statements[0]);
        }
      }
      for (const statement of migration.statements.slice(1)) await client.execute(statement);
    } else {
      await client.batch(migration.statements, 'write');
    }
    version = migration.version;
  }

  if (version < CURRENT_SCHEMA_VERSION) {
    throw new Error(`Control database schema is at version ${version}; expected version ${CURRENT_SCHEMA_VERSION}.`);
  }
  return version;
}

let controlClient;
let initializationPromise;

function getControlDatabase() {
  if (!initializationPromise) {
    controlClient = createControlDatabaseClient();
    initializationPromise = migrateControlDatabase(controlClient).then(() => controlClient).catch(error => {
      controlClient?.close?.();
      controlClient = undefined;
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

async function closeControlDatabase() {
  const client = controlClient;
  controlClient = undefined;
  initializationPromise = undefined;
  await client?.close?.();
}

function getEncryptionKey(configuredKey = process.env.APP_ENCRYPTION_KEY) {
  const value = String(configuredKey || '').trim();
  if (/^[a-f\d]{64}$/i.test(value)) return Buffer.from(value, 'hex');

  const base64Value = value.replace(/-/g, '+').replace(/_/g, '/');
  const key = Buffer.from(base64Value, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== base64Value.replace(/=+$/, '')) {
    throw new Error('APP_ENCRYPTION_KEY must be a 32-byte key encoded as 64 hexadecimal characters or Base64.');
  }
  return key;
}

function encryptTenantDatabaseToken(token, configuredKey = process.env.APP_ENCRYPTION_KEY) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('A non-empty tenant database token is required.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(configuredKey), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptTenantDatabaseToken(encryptedToken, configuredKey = process.env.APP_ENCRYPTION_KEY) {
  if (typeof encryptedToken !== 'string') {
    throw new TypeError('An encrypted tenant database token is required.');
  }
  const [version, ivValue, tagValue, tokenValue, ...extra] = encryptedToken.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !tokenValue || extra.length) {
    throw new Error('Encrypted tenant database token has an unsupported or invalid format.');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(configuredKey), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(tokenValue, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    throw new Error('Unable to decrypt tenant database token; verify APP_ENCRYPTION_KEY.', { cause: error });
  }
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  closeControlDatabase,
  createControlDatabaseClient,
  decryptTenantDatabaseToken,
  encryptTenantDatabaseToken,
  getControlDatabase,
  getControlDatabaseConfig,
  migrateControlDatabase
};
