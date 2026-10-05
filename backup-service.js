'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');
const FormData = require('form-data');
const { initTenantSchema } = require('./tenant-schema');

const ARCHIVE_FORMAT = 'taskflow-company-backup';
const ARCHIVE_VERSION = 2;
const DEFAULT_PART_BYTES = 45 * 1024 * 1024;
const MAX_PART_BYTES = 19 * 1024 * 1024;

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  return value;
}

function tableName(value) {
  const name = String(value || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('sqlite_')) throw new Error('Backup contains an invalid table name.');
  return name;
}

function columnName(value) {
  const name = String(value || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Backup contains an invalid column name.');
  return name;
}

function referencedFiles(tables) {
  const references = [];
  for (const row of tables.telegram_attachments || []) {
    references.push({
      storage: 'telegram', fileId: row.file_id || null, messageId: row.message_id || null,
      name: row.original_name || null, mimeType: row.mime_type || null, sizeBytes: row.file_size ?? null,
      deleted: Boolean(row.deleted_at)
    });
  }
  for (const row of tables.comments || []) {
    const value = String(row.image_path || '');
    if (value.startsWith('/uploads/')) references.push({ storage: 'local-upload', path: value, name: row.attachment_name || null });
    else if (value.startsWith('/api/download/')) references.push({ storage: 'telegram-reference', path: value, name: row.attachment_name || null });
  }
  for (const row of tables.reimbursements || []) {
    let paths = [];
    try { paths = row.receipt_paths ? JSON.parse(row.receipt_paths) : []; } catch (error) { paths = []; }
    if (!Array.isArray(paths)) paths = [];
    if (row.receipt_path && !paths.includes(row.receipt_path)) paths.unshift(row.receipt_path);
    for (const receiptPath of paths) {
      if (typeof receiptPath !== 'string') continue;
      references.push({
        storage: receiptPath.startsWith('telegram:') ? 'telegram-reference' : 'local-receipt',
        path: receiptPath,
        name: null
      });
    }
  }
  for (const row of tables.attendance_locations || []) {
    if (row.telegram_message_id != null) references.push({ storage: 'telegram-location', messageId: row.telegram_message_id });
  }
  return references;
}

async function createTenantArchive({ tenantDatabase, companyId, companyCode, now = () => new Date() }) {
  if (!tenantDatabase || typeof tenantDatabase.runWithTenant !== 'function' || typeof tenantDatabase.prepare !== 'function') {
    throw new TypeError('A tenant-aware database is required to create a company archive.');
  }
  const tables = {};
  await tenantDatabase.runWithTenant(companyId, async () => {
    const tableRows = await tenantDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const table of tableRows) {
      const name = tableName(table.name);
      tables[name] = jsonSafe(await tenantDatabase.prepare(`SELECT * FROM "${name}"`).all());
    }
  });
  const rowCounts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  const archive = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: now().toISOString(),
    companyCode: String(companyCode),
    tables,
    rowCounts,
    fileReferences: referencedFiles(tables)
  };
  const buffer = Buffer.from(JSON.stringify(archive));
  return { archive, buffer, checksum: crypto.createHash('sha256').update(buffer).digest('hex') };
}

function parseTenantArchive(input) {
  let archive;
  try { archive = Buffer.isBuffer(input) ? JSON.parse(input.toString('utf8')) : input; }
  catch (error) { throw new Error('Backup archive is not valid JSON.'); }
  const legacyFormat = archive?.format === 'taskflow-tenant-json-v1';
  if (!archive || (!legacyFormat && archive.format !== ARCHIVE_FORMAT)
    || (!legacyFormat && ![1, ARCHIVE_VERSION].includes(Number(archive.version)))
    || !archive.tables || typeof archive.tables !== 'object' || Array.isArray(archive.tables)) {
    throw new Error('Backup archive format is not supported.');
  }
  for (const [name, rows] of Object.entries(archive.tables)) {
    tableName(name);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error(`Backup archive has invalid rows for ${name}.`);
    }
  }
  if (!legacyFormat) return archive;
  return {
    ...archive,
    format: ARCHIVE_FORMAT,
    version: 1,
    rowCounts: archive.rowCounts || Object.fromEntries(Object.entries(archive.tables).map(([name, rows]) => [name, rows.length])),
    fileReferences: archive.fileReferences || referencedFiles(archive.tables)
  };
}

function countArchiveRows(archive) {
  return Object.fromEntries(Object.entries(archive.tables).map(([name, rows]) => [name, rows.length]));
}

async function getRestoredRowCounts(client, names) {
  const counts = {};
  for (const rawName of names) {
    const name = tableName(rawName);
    const result = await client.execute(`SELECT COUNT(*) AS count FROM "${name}"`);
    counts[name] = Number(result.rows?.[0]?.count ?? result.rows?.[0]?.COUNT ?? 0);
  }
  return counts;
}

async function restoreArchiveToDatabase(input, client, { initializeSchema = initTenantSchema } = {}) {
  if (!client || typeof client.execute !== 'function') throw new TypeError('A database client is required to restore an archive.');
  const archive = parseTenantArchive(input);
  await initializeSchema(client, { seedInitialAdmin: false });
  const statements = [{ sql: 'PRAGMA defer_foreign_keys = ON', args: [] }];
  const tables = Object.keys(archive.tables).map(tableName);
  for (const name of [...tables].reverse()) statements.push({ sql: `DELETE FROM "${name}"`, args: [] });
  for (const name of tables) {
    const rows = archive.tables[name];
    for (const row of rows) {
      const columns = Object.keys(row).map(columnName);
      if (!columns.length) continue;
      const sql = `INSERT INTO "${name}" (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      const args = columns.map(column => row[column] ?? null);
      statements.push({ sql, args });
    }
  }
  await client.batch(statements, 'write');
  const actualRowCounts = await getRestoredRowCounts(client, Object.keys(archive.tables));
  const expectedRowCounts = countArchiveRows(archive);
  if (Object.entries(expectedRowCounts).some(([name, count]) => actualRowCounts[name] !== count)) {
    throw new Error('Restored row counts do not match the backup archive.');
  }
  return { archive, expectedRowCounts, actualRowCounts };
}

function splitBuffer(buffer, partBytes = DEFAULT_PART_BYTES) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('A buffer is required to split a backup archive.');
  const size = Number(partBytes);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PART_BYTES) throw new RangeError('Backup part size must be between 1 byte and 19 MiB.');
  const parts = [];
  for (let offset = 0; offset < buffer.length; offset += size) parts.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  return parts.length ? parts : [Buffer.alloc(0)];
}

function createTelegramBackupClient({ environment = process.env, http = axios, formDataFactory = () => new FormData() } = {}) {
  const token = String(environment.TELEGRAM_BOT_TOKEN || '').trim();
  const backupChannelId = String(environment.TELEGRAM_BACKUP_CHANNEL_ID || '').trim();
  const alertChatId = String(environment.TELEGRAM_BACKUP_ALERT_CHAT_ID || '').trim();
  const partBytesValue = Number(environment.BACKUP_PART_BYTES || DEFAULT_PART_BYTES);
  const partBytes = Number.isSafeInteger(partBytesValue) && partBytesValue > 0 && partBytesValue <= MAX_PART_BYTES ? partBytesValue : DEFAULT_PART_BYTES;

  async function requestDocument(buffer, filename, caption) {
    if (!token || !backupChannelId) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_BACKUP_CHANNEL_ID to use private Telegram backups.');
    const form = formDataFactory();
    form.append('chat_id', backupChannelId);
    form.append('caption', caption.slice(0, 900));
    form.append('document', buffer, { filename, contentType: 'application/json' });
    const response = await http.post(`https://api.telegram.org/bot${token}/sendDocument`, form, {
      headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity, validateStatus: () => true
    });
    if (!response.data?.ok) throw new Error(`Telegram backup upload failed: ${response.data?.description || `HTTP ${response.status}`}`);
    const result = response.data.result;
    if (!result?.message_id || !result.document?.file_id) throw new Error('Telegram backup upload response did not include file and message IDs.');
    return { messageId: Number(result.message_id), fileId: result.document.file_id, channelId: backupChannelId };
  }

  return {
    configured: Boolean(token && backupChannelId),
    alertConfigured: Boolean(token && alertChatId),
    async uploadArchive(buffer, { companyCode, backupKey, partBytes: requestedPartBytes = partBytes } = {}) {
      const parts = splitBuffer(buffer, requestedPartBytes);
      const uploaded = [];
      try {
        for (let index = 0; index < parts.length; index += 1) {
          const suffix = parts.length > 1 ? `.part-${String(index + 1).padStart(3, '0')}-of-${String(parts.length).padStart(3, '0')}` : '';
          const filename = `${companyCode}-${backupKey}${suffix}.json`;
          uploaded.push(await requestDocument(parts[index], filename, `TaskFlow backup ${companyCode} ${backupKey} (${index + 1}/${parts.length})`));
        }
        return uploaded;
      } catch (error) {
        for (const part of uploaded) await this.deleteMessage(part.messageId, part.channelId).catch(() => {});
        throw error;
      }
    },
    async downloadArchiveParts(parts) {
      if (!token) throw new Error('Telegram backups are not configured.');
      const buffers = [];
      for (const part of parts) {
        const fileInfo = await http.get(`https://api.telegram.org/bot${token}/getFile`, { params: { file_id: part.fileId } });
        const filePath = fileInfo.data?.result?.file_path;
        if (!filePath) throw new Error('Telegram did not return a backup file path.');
        const fileResponse = await http.get(`https://api.telegram.org/file/bot${token}/${filePath}`, { responseType: 'arraybuffer' });
        buffers.push(Buffer.from(fileResponse.data));
      }
      return Buffer.concat(buffers);
    },
    async deleteMessage(messageId, channelId = backupChannelId) {
      if (!token || !channelId) throw new Error('Telegram backup channel is not configured.');
      const response = await http.post(`https://api.telegram.org/bot${token}/deleteMessage`, {
        chat_id: channelId, message_id: Number(messageId)
      }, { validateStatus: () => true });
      if (!response.data?.ok && !/message to delete not found|message not found/i.test(String(response.data?.description || ''))) {
        throw new Error(`Telegram backup cleanup failed: ${response.data?.description || `HTTP ${response.status}`}`);
      }
      return true;
    },
    async sendFailureAlert(message) {
      if (!token || !alertChatId) throw new Error('Set TELEGRAM_BACKUP_ALERT_CHAT_ID to receive backup failure alerts.');
      const response = await http.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: alertChatId, text: String(message).slice(0, 4000), disable_web_page_preview: true
      }, { validateStatus: () => true });
      if (!response.data?.ok) throw new Error(`Telegram backup alert failed: ${response.data?.description || `HTTP ${response.status}`}`);
      return true;
    }
  };
}

async function persistArchive(buffer, { directory, filename }) {
  await fs.mkdir(directory, { recursive: true });
  const safeFilename = path.basename(filename);
  const destination = path.join(directory, safeFilename);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, destination);
  return destination;
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  DEFAULT_PART_BYTES,
  MAX_PART_BYTES,
  countArchiveRows,
  createTelegramBackupClient,
  createTenantArchive,
  parseTenantArchive,
  persistArchive,
  referencedFiles,
  restoreArchiveToDatabase,
  splitBuffer
};
