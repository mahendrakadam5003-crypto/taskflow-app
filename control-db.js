'use strict';

const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

const CURRENT_SCHEMA_VERSION = 3;

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
    await client.batch(migration.statements, 'write');
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
