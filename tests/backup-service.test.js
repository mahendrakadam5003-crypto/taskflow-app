'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const {
  createTelegramBackupClient,
  createTenantArchive,
  parseTenantArchive,
  restoreArchiveToDatabase,
  splitBuffer
} = require('../backup-service');

function createSnapshotDatabase() {
  const tables = {
    users: [{ id: 1, name: 'Admin', password_hash: 'hash' }],
    comments: [{ id: 4, image_path: '/uploads/receipts/photo.png', attachment_name: 'photo.png' }],
    telegram_attachments: [{ id: 7, file_id: 'file-id', message_id: 42, original_name: 'invoice.pdf', mime_type: 'application/pdf', file_size: 900 }],
    reimbursements: [{ id: 12, receipt_path: 'telegram:receipt-id', receipt_paths: '["local.pdf","telegram:receipt-id"]' }],
    attendance_locations: [{ id: 20, telegram_message_id: 53 }]
  };
  return {
    tables,
    runWithTenant(id, callback) { assert.equal(id, 5); return callback(); },
    prepare(sql) {
      return {
        async all() {
          if (sql.includes('sqlite_master')) return Object.keys(tables).map(name => ({ name }));
          const name = sql.match(/FROM "([A-Za-z0-9_]+)"/)?.[1];
          return tables[name] || [];
        }
      };
    }
  };
}

test('company archives include every tenant table and a separate file-reference manifest', async () => {
  const database = createSnapshotDatabase();
  const { archive, buffer, checksum } = await createTenantArchive({
    tenantDatabase: database, companyId: 5, companyCode: 'example', now: () => new Date('2026-10-05T00:00:00Z')
  });
  assert.equal(archive.format, 'taskflow-company-backup');
  assert.equal(archive.version, 2);
  assert.equal(archive.rowCounts.users, 1);
  assert.equal(archive.tables.users[0].password_hash, 'hash');
  assert.equal(archive.fileReferences.length, 5);
  assert.match(checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseTenantArchive(buffer).rowCounts, archive.rowCounts);
});

test('archive restore reconstructs rows in a fresh database and checks row counts', async () => {
  const database = createSnapshotDatabase();
  const { buffer } = await createTenantArchive({ tenantDatabase: database, companyId: 5, companyCode: 'example' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-restore-test-'));
  const client = createClient({ url: `file:${path.join(directory, 'restore.db').replace(/\\/g, '/')}` });
  try {
    const result = await restoreArchiveToDatabase(buffer, client, {
      initializeSchema: async target => {
        await target.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, password_hash TEXT)');
        await target.execute('CREATE TABLE comments (id INTEGER PRIMARY KEY, image_path TEXT, attachment_name TEXT)');
        await target.execute('CREATE TABLE telegram_attachments (id INTEGER PRIMARY KEY, file_id TEXT, message_id INTEGER, original_name TEXT, mime_type TEXT, file_size INTEGER)');
        await target.execute('CREATE TABLE reimbursements (id INTEGER PRIMARY KEY, receipt_path TEXT, receipt_paths TEXT)');
        await target.execute('CREATE TABLE attendance_locations (id INTEGER PRIMARY KEY, telegram_message_id INTEGER)');
      }
    });
    assert.deepEqual(result.expectedRowCounts, result.actualRowCounts);
    assert.equal(Number((await client.execute('SELECT id FROM users')).rows[0].id), 1);
    assert.equal((await client.execute('SELECT file_id FROM telegram_attachments')).rows[0].file_id, 'file-id');
  } finally {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true }).catch(error => {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
    });
  }
});

test('archive parser rejects invalid table names and splitBuffer preserves all bytes', () => {
  assert.throws(() => parseTenantArchive({
    format: 'taskflow-company-backup', version: 2, tables: { 'users; DROP TABLE users': [] }
  }), /invalid table name/);
  const content = Buffer.from('0123456789');
  const parts = splitBuffer(content, 4);
  assert.deepEqual(parts, [Buffer.from('0123'), Buffer.from('4567'), Buffer.from('89')]);
  assert.throws(() => splitBuffer(content, 19 * 1024 * 1024 + 1), /between 1 byte and 19 MiB/);
});

test('archive parser upgrades Phase 7 local backup files for safe restore', () => {
  const legacy = parseTenantArchive({
    format: 'taskflow-tenant-json-v1', createdAt: '2026-01-01T00:00:00Z', companyCode: 'legacy-company',
    tables: { users: [{ id: 1 }], comments: [] }
  });
  assert.equal(legacy.format, 'taskflow-company-backup');
  assert.equal(legacy.version, 1);
  assert.deepEqual(legacy.rowCounts, { users: 1, comments: 0 });
});

test('restore defers foreign keys while restoring child tables before parents', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-restore-fk-test-'));
  const client = createClient({ url: `file:${path.join(directory, 'restore.db').replace(/\\/g, '/')}` });
  try {
    const archive = {
      format: 'taskflow-company-backup', version: 2,
      tables: {
        comments: [{ id: 1, project_id: 7, body: 'Restored comment' }],
        projects: [{ id: 7, name: 'Restored project' }]
      }
    };
    const result = await restoreArchiveToDatabase(archive, client, {
      initializeSchema: async target => {
        await target.execute('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)');
        await target.execute('CREATE TABLE comments (id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id), body TEXT)');
      }
    });
    assert.deepEqual(result.expectedRowCounts, result.actualRowCounts);
  } finally {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true }).catch(error => {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
    });
  }
});

test('private Telegram backup client sends ordered parts, reconstructs them, and alerts privately', async () => {
  let nextMessageId = 1;
  const sent = [];
  const uploadedParts = [];
  const deleted = [];
  const alerts = [];
  const fakeHttp = {
    async post(url, form) {
      if (url.endsWith('/sendDocument')) {
        const record = Object.fromEntries(form.fields.map(([key, value]) => [key, value]));
        record.filename = form.filename;
        const uploaded = { filename: form.filename, buffer: record.document, fileId: `file-${nextMessageId}` };
        uploadedParts.push(uploaded);
        sent.push(record);
        return { status: 200, data: { ok: true, result: { message_id: nextMessageId, document: { file_id: `file-${nextMessageId++}` } } } };
      }
      if (url.endsWith('/deleteMessage')) { deleted.push(form); return { data: { ok: true } }; }
      if (url.endsWith('/sendMessage')) { alerts.push(form); return { data: { ok: true } }; }
      throw new Error(`Unexpected URL ${url}`);
    },
    async get(url, options) {
      if (url.endsWith('/getFile')) return { data: { result: { file_path: uploadedParts.find(part => part.fileId === options.params.file_id)?.filename } } };
      return { data: uploadedParts.find(part => part.filename === url.split('/').pop())?.buffer || Buffer.from('not found') };
    }
  };
  const createForm = () => ({ fields: [], append(key, value, options) { this.fields.push([key, value]); if (options?.filename) this.filename = options.filename; }, getHeaders() { return {}; } });
  const telegram = createTelegramBackupClient({
    environment: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_BACKUP_CHANNEL_ID: '-100-private', TELEGRAM_BACKUP_ALERT_CHAT_ID: '12345' },
    http: fakeHttp,
    formDataFactory: createForm
  });
  const original = Buffer.from('abcdefghij');
  const parts = await telegram.uploadArchive(original, { companyCode: 'example', backupKey: '2026-10-05', partBytes: 4 });
  assert.deepEqual(parts.map(part => part.messageId), [1, 2, 3]);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].chat_id, '-100-private');
  assert.match(sent[0].filename, /part-001-of-003/);
  assert.deepEqual(await telegram.downloadArchiveParts(parts), original);
  await telegram.deleteMessage(2, '-100-private');
  assert.equal(deleted[0].message_id, 2);
  await telegram.sendFailureAlert('Backup failed for example.');
  assert.equal(alerts[0].chat_id, '12345');
});
