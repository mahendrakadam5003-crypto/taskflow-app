'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { createBackupManager } = require('../backup-manager');
const { migrateControlDatabase } = require('../control-db');

function createTenantFixture({ failSnapshot = false } = {}) {
  const tables = {
    users: [{ id: 1, username: 'owner', role: 'admin', password_hash: 'hash' }],
    projects: [{ id: 1, name: 'Project A' }],
    comments: [{ id: 1, image_path: '/uploads/comment.png', attachment_name: 'comment.png' }],
    telegram_attachments: [{ id: 1, file_id: 'file-one', message_id: 77, original_name: 'receipt.pdf', mime_type: 'application/pdf', file_size: 99, deleted_at: null }],
    reimbursements: [{ id: 1, receipt_path: 'telegram:file-one', receipt_paths: '["telegram:file-one","receipt-local.pdf"]' }],
    attendance_locations: [{ id: 1, telegram_message_id: 88 }]
  };
  return {
    tables,
    closeCount: 0,
    async runWithTenant(companyId, callback) {
      assert.equal(Number(companyId), 1);
      if (failSnapshot) throw new Error('simulated tenant query failure');
      return callback();
    },
    prepare(sql) {
      return {
        async all() {
          if (sql.includes('sqlite_master')) return Object.keys(tables).map(name => ({ name }));
          if (sql.includes('SELECT DISTINCT message_id FROM telegram_attachments')) return [{ message_id: 77 }];
          if (sql.includes('SELECT DISTINCT telegram_message_id')) return [{ message_id: 88 }];
          if (sql.includes('FROM comments')) return tables.comments;
          if (sql.includes('FROM reimbursements')) return tables.reimbursements;
          const name = sql.match(/FROM "([A-Za-z0-9_]+)"/)?.[1];
          return tables[name] || [];
        }
      };
    },
    async closeTenant() { this.closeCount += 1; }
  };
}

async function makeFixture({ status = 'active', failSnapshot = false, trialPolicyVersion = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-backup-manager-'));
  const backupDirectory = path.join(directory, 'backups');
  const tenantRoot = path.join(directory, 'tenants');
  const uploadsDirectory = path.join(directory, 'uploads');
  await fs.mkdir(tenantRoot, { recursive: true });
  await fs.mkdir(path.join(uploadsDirectory, 'receipts'), { recursive: true });
  const controlDb = createClient({ url: 'file::memory:' });
  await migrateControlDatabase(controlDb);
  await controlDb.execute({
    sql: 'INSERT INTO super_admins (id, name, username, password_hash) VALUES (1, ?, ?, ?)',
    args: ['Test Super Admin', 'test-super-admin', 'test-hash']
  });
  const company = await controlDb.execute({
    sql: `INSERT INTO companies (code, name, status, plan_id, tenant_db_name, tenant_db_url, tenant_db_token_encrypted, trial_policy_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ['example', 'Example Company', status, 2, 'example', `file:${path.join(tenantRoot, 'example.db').replace(/\\/g, '/')}`, 'encrypted-live-token', trialPolicyVersion]
  });
  const companyId = Number(company.lastInsertRowid);
  const tenantDatabase = createTenantFixture({ failSnapshot });
  const telegram = {
    configured: true,
    sent: [],
    deleted: [],
    alerts: [],
    async uploadArchive(buffer, options) {
      const part = { messageId: this.sent.length + 1, fileId: `archive-${this.sent.length + 1}`, channelId: 'private-backup-channel' };
      this.sent.push({ buffer, options, part });
      return [part];
    },
    async downloadArchiveParts(parts) { return Buffer.concat(parts.map(part => this.sent.find(item => item.part.fileId === part.fileId).buffer)); },
    async deleteMessage(messageId, channelId) { this.deleted.push({ messageId, channelId }); },
    async sendFailureAlert(message) { this.alerts.push(message); }
  };
  const temporaryRestoreClients = [];
  const temporaryRestoreFiles = [];
  const manager = createBackupManager({
    getDatabase: async () => controlDb,
    tenantDatabase,
    telegram,
    environment: { USE_LOCAL_DB: '1', CONTROL_DATABASE_URL: 'libsql://control.example', CONTROL_AUTH_TOKEN: 'test-control-token', TELEGRAM_CHANNEL_ID: '-100-attachments' },
    backupDirectory,
    localTenantRoot: tenantRoot,
    uploadsDirectory,
    createDatabaseClient: config => {
      const client = createClient(config);
      if (config.url === 'file::memory:' || String(config.url).includes('restore-check')) {
        temporaryRestoreClients.push(client);
        if (String(config.url).includes('restore-check')) temporaryRestoreFiles.push(String(config.url).slice('file:'.length));
      }
      return client;
    },
    initializeRestoredDatabase: async client => {
      await client.execute('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, password_hash TEXT)');
      await client.execute('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT)');
      await client.execute('CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, image_path TEXT, attachment_name TEXT)');
      await client.execute('CREATE TABLE IF NOT EXISTS telegram_attachments (id INTEGER PRIMARY KEY, file_id TEXT, message_id INTEGER, original_name TEXT, mime_type TEXT, file_size INTEGER, deleted_at TEXT)');
      await client.execute('CREATE TABLE IF NOT EXISTS reimbursements (id INTEGER PRIMARY KEY, receipt_path TEXT, receipt_paths TEXT)');
      await client.execute('CREATE TABLE IF NOT EXISTS attendance_locations (id INTEGER PRIMARY KEY, telegram_message_id INTEGER)');
    },
    encryptToken: token => `encrypted:${token}`,
    closeTenant: companyDatabaseId => tenantDatabase.closeTenant(companyDatabaseId)
  });
  return { directory, backupDirectory, tenantRoot, uploadsDirectory, controlDb, companyId, tenantDatabase, telegram, manager, temporaryRestoreClients, temporaryRestoreFiles };
}

async function cleanupFixture(fixture) {
  await fixture.controlDb.close();
  await fs.rm(fixture.directory, { recursive: true, force: true }).catch(error => {
    if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
  });
}

test('manual backup persists one downloadable archive with row counts, references, and checksum', async () => {
  const fixture = await makeFixture();
  try {
    const backup = await fixture.manager.createCompanyBackup(fixture.companyId, { kind: 'manual', adminId: 1 });
    assert.equal(backup.status, 'complete');
    assert.equal(backup.type, 'tenant-json-v2');
    assert.ok(backup.fileReferences.some(reference => reference.messageId === 77));
    const file = await fs.readFile(path.join(fixture.backupDirectory, backup.location));
    assert.match(backup.checksum, /^[a-f0-9]{64}$/);
    const records = await fixture.controlDb.execute('SELECT backup_kind, row_counts_json, file_references_json FROM backups');
    assert.equal(records.rows[0].backup_kind, 'manual');
    assert.equal(JSON.parse(records.rows[0].row_counts_json).users, 1);
    assert.equal(JSON.parse(records.rows[0].file_references_json).length, 5);
    assert.ok(file.length > 0);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('daily backups retain at most seven daily archives and delete older Telegram messages', async () => {
  const fixture = await makeFixture();
  try {
    for (let day = 1; day <= 8; day += 1) {
      await fixture.manager.runDailyBackups({ date: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`) });
    }
    const backups = await fixture.controlDb.execute("SELECT backup_key FROM backups WHERE backup_kind = 'daily' AND status = 'complete'");
    assert.equal(backups.rows.length, 7);
    assert.ok(fixture.telegram.deleted.length >= 1);
    assert.ok(fixture.telegram.sent.every(item => item.options.companyCode === 'example'));
  } finally {
    await cleanupFixture(fixture);
  }
});

test('restore staging creates a different database and switches only after explicit activation', async () => {
  const fixture = await makeFixture();
  try {
    const backup = await fixture.manager.createCompanyBackup(fixture.companyId, { kind: 'manual' });
    const staged = await fixture.manager.createRestoreStage(fixture.companyId, backup.id, 1);
    assert.equal(staged.status, 'ready');
    assert.equal(staged.rowCounts.users, 1);
    const before = await fixture.controlDb.execute({ sql: 'SELECT tenant_db_url FROM companies WHERE id = ?', args: [fixture.companyId] });
    assert.match(before.rows[0].tenant_db_url, /example\.db/);
    const stageRow = await fixture.controlDb.execute({ sql: 'SELECT tenant_db_url FROM company_restore_staging WHERE id = ?', args: [staged.id] });
    assert.notEqual(stageRow.rows[0].tenant_db_url, before.rows[0].tenant_db_url);

    const activated = await fixture.manager.activateRestore(fixture.companyId, staged.id, 1);
    const after = await fixture.controlDb.execute({ sql: 'SELECT tenant_db_name, tenant_db_url FROM companies WHERE id = ?', args: [fixture.companyId] });
    assert.equal(after.rows[0].tenant_db_name, staged.databaseName);
    assert.equal(after.rows[0].tenant_db_url, stageRow.rows[0].tenant_db_url);
    assert.equal(activated.oldDatabaseName, 'example');
    assert.equal(fixture.tenantDatabase.closeCount, 1);
    const reverted = await fixture.manager.revertRestore(fixture.companyId, staged.id, 1);
    const afterRevert = await fixture.controlDb.execute({ sql: 'SELECT tenant_db_name, tenant_db_url FROM companies WHERE id = ?', args: [fixture.companyId] });
    assert.equal(reverted.databaseName, 'example');
    assert.equal(afterRevert.rows[0].tenant_db_name, 'example');
    assert.match(afterRevert.rows[0].tenant_db_url, /example\.db/);
    assert.equal(fixture.tenantDatabase.closeCount, 2);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('monthly restore test records a successful isolated round trip only once per month', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.manager.createCompanyBackup(fixture.companyId, { kind: 'daily', backupKey: '2026-10-05' });
    const date = new Date('2026-10-05T00:00:00Z');
    const first = await fixture.manager.runMonthlyRestoreTests({ date });
    const second = await fixture.manager.runMonthlyRestoreTests({ date });
    assert.equal(first[0].status, 'passed');
    assert.equal(second[0].skipped, true);
    const tests = await fixture.controlDb.execute('SELECT status, test_month FROM backup_tests');
    assert.deepEqual(tests.rows, [{ status: 'passed', test_month: '2026-10' }]);
    assert.equal(fixture.temporaryRestoreClients.length, 1);
    assert.equal(fixture.temporaryRestoreClients[0].closed, true);
    if (fixture.temporaryRestoreFiles.length) await assert.rejects(fs.access(fixture.temporaryRestoreFiles[0]));
  } finally {
    await cleanupFixture(fixture);
  }
});

test('due company deletion creates a final backup, removes file messages/database, and anonymizes the control row', async () => {
  const fixture = await makeFixture({ status: 'cancelled' });
  try {
    await fs.writeFile(path.join(fixture.tenantRoot, 'example.db'), 'tenant database');
    await fs.writeFile(path.join(fixture.uploadsDirectory, 'comment.png'), 'comment');
    await fs.writeFile(path.join(fixture.uploadsDirectory, 'receipts', 'receipt-local.pdf'), 'receipt');
    await fixture.controlDb.execute({ sql: "UPDATE companies SET delete_after = '2026-10-01T00:00:00.000Z' WHERE id = ?", args: [fixture.companyId] });
    const result = await fixture.manager.processDueCompanyDeletions({ date: new Date('2026-10-05T00:00:00Z') });
    assert.equal(result[0].status, 'deleted', result[0].error);
    assert.ok(fixture.telegram.sent.some(item => item.options.backupKey === '2026-10-05'));
    assert.deepEqual(fixture.telegram.deleted.map(item => item.messageId), [77, 88]);
    await assert.rejects(fs.access(path.join(fixture.tenantRoot, 'example.db')));
    await assert.rejects(fs.access(path.join(fixture.uploadsDirectory, 'comment.png')));
    await assert.rejects(fs.access(path.join(fixture.uploadsDirectory, 'receipts', 'receipt-local.pdf')));
    const company = await fixture.controlDb.execute({ sql: 'SELECT status, name, tenant_db_url, tenant_db_token_encrypted FROM companies WHERE id = ?', args: [fixture.companyId] });
    assert.deepEqual(company.rows[0], { status: 'deleted', name: 'Deleted company', tenant_db_url: '', tenant_db_token_encrypted: '' });
    const audit = await fixture.controlDb.execute({ sql: "SELECT action FROM super_admin_audit WHERE company_id = ? AND action = 'Company permanently deleted'", args: [fixture.companyId] });
    assert.equal(audit.rows.length, 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('new-policy trials are deleted after grace without creating any backup', async () => {
  const fixture = await makeFixture({ status: 'trial', trialPolicyVersion: 1 });
  try {
    await fs.writeFile(path.join(fixture.tenantRoot, 'example.db'), 'tenant database');
    await fs.writeFile(path.join(fixture.uploadsDirectory, 'comment.png'), 'comment');
    await fixture.controlDb.execute({ sql: "UPDATE companies SET delete_after = '2026-10-01T00:00:00.000Z' WHERE id = ?", args: [fixture.companyId] });

    const result = await fixture.manager.processDueCompanyDeletions({ date: new Date('2026-10-05T00:00:00Z') });

    assert.equal(result[0].status, 'deleted', result[0].error);
    assert.equal(result[0].backupId, null);
    assert.equal(fixture.telegram.sent.length, 0);
    assert.deepEqual(fixture.telegram.deleted.map(item => item.messageId), [77, 88]);
    await assert.rejects(fs.access(path.join(fixture.tenantRoot, 'example.db')));
    await assert.rejects(fs.access(path.join(fixture.uploadsDirectory, 'comment.png')));
  } finally {
    await cleanupFixture(fixture);
  }
});

test('manual backup is not available for a new-policy trial company', async () => {
  for (const status of ['trial', 'cancelled']) {
    const fixture = await makeFixture({ status, trialPolicyVersion: 1 });
    try {
      await assert.rejects(
        fixture.manager.createCompanyBackup(fixture.companyId, { kind: 'manual' }),
        /Backups are not included during the trial period/
      );
      const rows = await fixture.controlDb.execute('SELECT id FROM backups');
      assert.equal(rows.rows.length, 0);
    } finally {
      await cleanupFixture(fixture);
    }
  }
});

test('backup failure creates a failure row and sends a private Telegram alert', async () => {
  const fixture = await makeFixture({ failSnapshot: true });
  try {
    await assert.rejects(fixture.manager.createCompanyBackup(fixture.companyId, { kind: 'manual' }), /simulated tenant query failure/);
    assert.equal(fixture.telegram.alerts.length, 1);
    const row = await fixture.controlDb.execute('SELECT status FROM backups');
    assert.equal(row.rows[0].status, 'failed');
  } finally {
    await cleanupFixture(fixture);
  }
});
