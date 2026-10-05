'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { decryptTenantDatabaseToken, encryptTenantDatabaseToken, getControlDatabase, getControlDatabaseConfig } = require('./control-db');
const { createTursoProvisioner } = require('./turso-provisioner');
const { createTelegramBackupClient, createTenantArchive, parseTenantArchive, persistArchive, restoreArchiveToDatabase } = require('./backup-service');

function parseJson(value, fallback = []) {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    return parsed ?? fallback;
  } catch (error) {
    return fallback;
  }
}

function isWithinDirectory(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function rowCountsEqual(expected, actual) {
  return Object.entries(expected || {}).every(([name, count]) => Number(actual?.[name]) === Number(count));
}

function archivePathsForTenant(root, candidate) {
  const resolved = path.resolve(root, candidate);
  return isWithinDirectory(path.resolve(root), resolved) ? resolved : null;
}

async function externalReferencesFromDatabase(client, uploadsDirectory) {
  const [attachments, locations, comments, reimbursements] = await Promise.all([
    client.execute('SELECT DISTINCT message_id FROM telegram_attachments WHERE message_id IS NOT NULL'),
    client.execute('SELECT DISTINCT telegram_message_id AS message_id FROM attendance_locations WHERE telegram_message_id IS NOT NULL'),
    client.execute("SELECT image_path FROM comments WHERE image_path LIKE '/uploads/%'"),
    client.execute('SELECT receipt_path, receipt_paths FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL')
  ]);
  const messageIds = [...(attachments.rows || []), ...(locations.rows || [])]
    .map(row => Number(row.message_id)).filter(id => Number.isSafeInteger(id) && id > 0);
  const localFiles = new Set();
  for (const row of comments.rows || []) {
    const imagePath = String(row.image_path || '');
    if (!imagePath.startsWith('/uploads/')) continue;
    const filePath = archivePathsForTenant(uploadsDirectory, imagePath.slice('/uploads/'.length));
    if (filePath) localFiles.add(filePath);
  }
  for (const row of reimbursements.rows || []) {
    const receiptPaths = parseJson(row.receipt_paths);
    if (row.receipt_path && !receiptPaths.includes(row.receipt_path)) receiptPaths.unshift(row.receipt_path);
    for (const receipt of receiptPaths) {
      if (typeof receipt !== 'string' || receipt.startsWith('telegram:')) continue;
      const directory = receipt.startsWith('/uploads/') ? uploadsDirectory : path.join(uploadsDirectory, 'receipts');
      const relative = receipt.startsWith('/uploads/') ? receipt.slice('/uploads/'.length) : receipt;
      const filePath = archivePathsForTenant(directory, relative);
      if (filePath) localFiles.add(filePath);
    }
  }
  return { messageIds: [...new Set(messageIds)], localFiles: [...localFiles] };
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError || new Error('Temporary restore database cleanup failed.');
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function createBackupManager({
  getDatabase = getControlDatabase,
  tenantDatabase,
  createDatabaseClient = createClient,
  createTursoClient = createTursoProvisioner,
  decryptToken = decryptTenantDatabaseToken,
  encryptToken = encryptTenantDatabaseToken,
  telegram,
  environment = process.env,
  backupDirectory = path.join(__dirname, 'backups'),
  localTenantRoot = path.join(__dirname, 'tenants'),
  uploadsDirectory = path.join(__dirname, 'uploads'),
  openTenantDatabase,
  now = () => new Date(),
  initializeRestoredDatabase,
  closeTenant
} = {}) {
  const getTenantDb = () => tenantDatabase || require('./db');
  const getTelegram = () => telegram || createTelegramBackupClient({ environment });

  async function openCompanyPointer(pointer) {
    if (openTenantDatabase) return openTenantDatabase(pointer);
    if (environment.USE_LOCAL_DB === '1') {
      let databaseUrl = String(pointer.tenant_db_url || '');
      if (databaseUrl.startsWith('file:')) {
        const candidate = path.resolve(databaseUrl.slice('file:'.length));
        if (!isWithinDirectory(path.resolve(localTenantRoot), candidate)) throw new Error('Local tenant database path is outside the tenant directory.');
        databaseUrl = `file:${candidate.replace(/\\/g, '/')}`;
      } else {
        const name = String(pointer.tenant_db_name || '');
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error('Local tenant database name is invalid.');
        databaseUrl = `file:${path.join(localTenantRoot, `${name}.db`).replace(/\\/g, '/')}`;
      }
      return createDatabaseClient({ url: databaseUrl });
    }
    const databaseUrl = String(pointer.tenant_db_url || '').trim();
    if (!/^libsql:\/\//i.test(databaseUrl) && !/^https:\/\//i.test(databaseUrl)) throw new Error('Tenant database URL is invalid.');
    const authToken = decryptToken(pointer.tenant_db_token_encrypted);
    if (!authToken) throw new Error('Tenant database token is unavailable.');
    return createDatabaseClient({ url: databaseUrl, authToken });
  }

  async function removeLocalTenantDatabase(filePath) {
    const resolved = path.resolve(filePath);
    if (!isWithinDirectory(path.resolve(localTenantRoot), resolved)) throw new Error('Local tenant database path is outside the tenant directory.');
    await Promise.all([
      fs.rm(resolved, { force: true }),
      fs.rm(`${resolved}-wal`, { force: true }),
      fs.rm(`${resolved}-shm`, { force: true })
    ]);
  }

  async function companyRecord(companyId) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: `SELECT id, code, name, status, tenant_db_name, tenant_db_url, tenant_db_token_encrypted
        FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1`,
      args: [Number(companyId)]
    });
    return result.rows?.[0] || null;
  }

  async function audit(companyId, action, details, adminId = null) {
    const controlDb = await getDatabase();
    await controlDb.execute({
      sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
      args: [adminId, companyId, action, String(details || '').slice(0, 2000)]
    });
  }

  async function alertFailure(context, error) {
    console.error(`Backup operation failed (${context}):`, error.message);
    try {
      await getTelegram().sendFailureAlert(`TaskFlow backup failure\n${context}\n${String(error.message || error).slice(0, 2500)}`);
    } catch (alertError) {
      console.error('Could not send Telegram backup failure alert:', alertError.message);
    }
  }

  async function createCompanyBackup(companyId, {
    kind = 'manual', backupKey = crypto.randomUUID(), adminId = null, requireTelegram = false
  } = {}) {
    const company = await companyRecord(companyId);
    if (!company) throw new Error('Company not found.');
    const controlDb = await getDatabase();
    const key = String(backupKey).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    const filename = `${company.code}-${kind}-${key}.json`;
    let destination;
    let uploadedParts = [];
    let archive;
    let backupId;
    let status = 'complete';
    let failure;
    try {
      archive = await createTenantArchive({
        tenantDatabase: getTenantDb(), companyId: Number(companyId), companyCode: company.code, now
      });
      destination = await persistArchive(archive.buffer, { directory: backupDirectory, filename });
      const telegramClient = getTelegram();
      if (requireTelegram || (telegramClient.configured && ['daily', 'final', 'pre-restore'].includes(kind))) {
        uploadedParts = await telegramClient.uploadArchive(archive.buffer, { companyCode: company.code, backupKey: key });
      }
    } catch (error) {
      failure = error;
      status = 'failed';
    }

    const location = destination ? path.relative(backupDirectory, destination) : filename;
    let insert;
    try {
      insert = await controlDb.execute({
        sql: `INSERT INTO backups (
        company_id, type, location, size_bytes, status, backup_key, backup_kind, row_counts_json,
        telegram_message_ids_json, telegram_channel_id, checksum, file_references_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          Number(companyId), 'tenant-json-v2', location, archive?.buffer.length || 0, status, key, kind,
          JSON.stringify(archive?.archive.rowCounts || {}),
          JSON.stringify(uploadedParts), uploadedParts[0]?.channelId || null,
          archive?.checksum || null, JSON.stringify(archive?.archive.fileReferences || [])
        ]
      });
      backupId = Number(insert.lastInsertRowid);
      await audit(companyId, status === 'complete' ? 'Company backup created' : 'Company backup failed',
        `Backup ${backupId} (${kind}) ${status}${failure ? `: ${failure.message}` : ''}.`, adminId);
    } catch (error) {
      await alertFailure(`${company.code} (${kind}) control record`, error);
      error.backupAlerted = true;
      throw error;
    }
    if (failure) {
      await alertFailure(`${company.code} (${kind})`, failure);
      failure.backupAlerted = true;
      throw failure;
    }
    return {
      id: backupId, companyId: Number(companyId), type: 'tenant-json-v2', kind, key, location,
      sizeBytes: archive?.buffer.length || 0, checksum: archive?.checksum || null,
      fileReferences: archive?.archive.fileReferences || [], telegramParts: uploadedParts, status
    };
  }

  async function archiveForBackup(companyId, backup) {
    const resolved = path.resolve(backupDirectory, backup.location);
    if (isWithinDirectory(path.resolve(backupDirectory), resolved)) {
      try { return await fs.readFile(resolved); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const parts = parseJson(backup.telegram_message_ids_json);
    if (!parts.length) throw new Error('Backup archive file is unavailable and no Telegram parts are recorded.');
    return getTelegram().downloadArchiveParts(parts);
  }

  async function getBackupArchive(companyId, backupId) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: 'SELECT * FROM backups WHERE id = ? AND company_id = ?',
      args: [Number(backupId), Number(companyId)]
    });
    const backup = result.rows?.[0];
    if (!backup || backup.status !== 'complete') throw new Error('Completed company backup not found.');
    const buffer = await archiveForBackup(companyId, backup);
    if (backup.checksum && crypto.createHash('sha256').update(buffer).digest('hex') !== backup.checksum) {
      throw new Error('Backup checksum verification failed.');
    }
    parseTenantArchive(buffer);
    return { backup, buffer };
  }

  async function deleteBackupRecord(companyId, backup) {
    const controlDb = await getDatabase();
    const parts = parseJson(backup.telegram_message_ids_json);
    for (const part of parts) await getTelegram().deleteMessage(part.messageId, part.channelId);
    const filename = path.resolve(backupDirectory, backup.location);
    if (isWithinDirectory(path.resolve(backupDirectory), filename)) await fs.rm(filename, { force: true });
    await controlDb.execute({ sql: 'DELETE FROM backups WHERE id = ? AND company_id = ?', args: [Number(backup.id), Number(companyId)] });
  }

  async function pruneDailyBackups(companyId, keep = 7) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: "SELECT * FROM backups WHERE company_id = ? AND backup_kind = 'daily' AND status = 'complete' ORDER BY created_at DESC, id DESC",
      args: [Number(companyId)]
    });
    const retainedKeys = new Set();
    const obsolete = [];
    for (const backup of result.rows || []) {
      if (retainedKeys.has(backup.backup_key)) obsolete.push(backup);
      else if (retainedKeys.size < keep) retainedKeys.add(backup.backup_key);
      else obsolete.push(backup);
    }
    for (const backup of obsolete) {
      await deleteBackupRecord(companyId, backup);
      await audit(companyId, 'Old daily backup deleted', `Deleted backup ${backup.id} (${backup.backup_key}) beyond the ${keep}-day retention window.`);
    }
    return obsolete.length;
  }

  async function runDailyBackups({ date = now() } = {}) {
    const controlDb = await getDatabase();
    const companies = await controlDb.execute("SELECT id, code FROM companies WHERE status = 'active' ORDER BY id");
    const key = dayKey(date);
    const telegramClient = getTelegram();
    if (!telegramClient.configured) throw new Error('Daily backups require TELEGRAM_BACKUP_CHANNEL_ID and TELEGRAM_BOT_TOKEN.');
    const results = [];
    for (const company of companies.rows || []) {
      const existing = await controlDb.execute({
        sql: "SELECT id FROM backups WHERE company_id = ? AND backup_key = ? AND backup_kind = 'daily' AND status = 'complete' LIMIT 1",
        args: [Number(company.id), key]
      });
      if (existing.rows?.length) { results.push({ companyId: Number(company.id), skipped: true }); continue; }
      try {
        const backup = await createCompanyBackup(company.id, { kind: 'daily', backupKey: key, requireTelegram: true });
        await pruneDailyBackups(company.id, 7);
        results.push({ companyId: Number(company.id), backupId: backup.id });
      } catch (error) {
        if (!error.backupAlerted) await alertFailure(`${company.code} (${key})`, error);
        results.push({ companyId: Number(company.id), error: error.message });
      }
    }
    return results;
  }

  async function restoreTestForCompany(company, backup, testMonth) {
    let tempDirectory;
    let client;
    try {
      const { buffer } = await getBackupArchive(company.id, backup.id);
      const useInMemoryDatabase = process.platform === 'win32';
      if (!useInMemoryDatabase) tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-restore-check-'));
      const url = useInMemoryDatabase ? 'file::memory:'
        : `file:${path.join(tempDirectory, 'restore-test.db').replace(/\\/g, '/')}`;
      client = createDatabaseClient({ url });
      const restored = await restoreArchiveToDatabase(buffer, client, initializeRestoredDatabase ? { initializeSchema: initializeRestoredDatabase } : {});
      const controlDb = await getDatabase();
      const row = await controlDb.execute({ sql: 'SELECT id FROM backups WHERE id = ?', args: [Number(backup.id)] });
      if (!row.rows?.[0]) throw new Error('Source backup metadata disappeared during restore verification.');
      await (await getDatabase()).execute({
        sql: `INSERT INTO backup_tests (company_id, backup_id, test_month, status, expected_row_counts_json, actual_row_counts_json, details)
          VALUES (?, ?, ?, 'passed', ?, ?, ?)`,
        args: [company.id, backup.id, testMonth, JSON.stringify(restored.expectedRowCounts), JSON.stringify(restored.actualRowCounts), 'Temporary restore completed and row counts matched.']
      });
      await audit(company.id, 'Monthly backup restore test passed', `Backup ${backup.id} verified in a temporary database for ${testMonth}.`);
      return { companyId: company.id, backupId: Number(backup.id), status: 'passed' };
    } catch (error) {
      await (await getDatabase()).execute({
        sql: `INSERT INTO backup_tests (company_id, backup_id, test_month, status, expected_row_counts_json, actual_row_counts_json, details)
          VALUES (?, ?, ?, 'failed', ?, '{}', ?) ON CONFLICT(company_id, test_month) DO UPDATE SET
            backup_id = excluded.backup_id, status = excluded.status,
            expected_row_counts_json = excluded.expected_row_counts_json,
            actual_row_counts_json = '{}', details = excluded.details, created_at = datetime('now')`,
        args: [company.id, backup.id, testMonth, backup.row_counts_json || '{}', String(error.message || error).slice(0, 1000)]
      });
      await audit(company.id, 'Monthly backup restore test failed', `Backup ${backup.id} verification failed for ${testMonth}: ${error.message}`);
      await alertFailure(`${company.code} monthly restore test`, error);
      return { companyId: company.id, backupId: Number(backup.id), status: 'failed', error: error.message };
    } finally {
      if (client) {
        try { await client.close?.(); } catch (error) { console.error('Could not close temporary restore-test database:', error.message); }
      }
      if (tempDirectory) await removeTemporaryDirectory(tempDirectory).catch(error => {
        console.error('Could not remove temporary restore-test database:', error.message);
      });
    }
  }

  async function runMonthlyRestoreTests({ date = now() } = {}) {
    const controlDb = await getDatabase();
    const testMonth = monthKey(date);
    const companies = await controlDb.execute("SELECT id, code FROM companies WHERE status = 'active' ORDER BY id");
    const results = [];
    for (const idRow of companies.rows || []) {
      const prior = await controlDb.execute({
        sql: 'SELECT id FROM backup_tests WHERE company_id = ? AND test_month = ? LIMIT 1',
        args: [Number(idRow.id), testMonth]
      });
      if (prior.rows?.length) { results.push({ companyId: Number(idRow.id), skipped: true }); continue; }
      const backupResult = await controlDb.execute({
        sql: "SELECT * FROM backups WHERE company_id = ? AND status = 'complete' ORDER BY CASE WHEN backup_kind = 'daily' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1",
        args: [Number(idRow.id)]
      });
      let backup = backupResult.rows?.[0];
      if (!backup) {
        try {
          const created = await createCompanyBackup(idRow.id, { kind: 'monthly-test', backupKey: testMonth, requireTelegram: false });
          const createdRow = await controlDb.execute({ sql: 'SELECT * FROM backups WHERE id = ?', args: [created.id] });
          backup = createdRow.rows?.[0];
        } catch (error) {
          if (!error.backupAlerted) await alertFailure(`${idRow.code} monthly restore test backup`, error);
          results.push({ companyId: Number(idRow.id), status: 'failed', error: error.message });
          continue;
        }
      }
      results.push(await restoreTestForCompany({ id: Number(idRow.id), code: idRow.code }, backup, testMonth));
    }
    return results;
  }

  async function createRestoreStage(companyId, backupId, adminId = null) {
    const company = await companyRecord(companyId);
    if (!company) throw new Error('Company not found.');
    await createCompanyBackup(companyId, { kind: 'pre-restore', adminId, requireTelegram: Boolean(getTelegram().configured) });
    const { buffer } = await getBackupArchive(companyId, backupId);
    const archive = parseTenantArchive(buffer);
    const restoreSuffix = crypto.randomBytes(5).toString('hex');
    const local = environment.USE_LOCAL_DB === '1';
    const databaseName = local ? `restore-${restoreSuffix}` : `tf-restore-${company.id}-${restoreSuffix}`;
    let databaseUrl;
    let databaseToken;
    let databaseCreated = false;
    let client;
    let turso;
    try {
      if (local) {
        await fs.mkdir(localTenantRoot, { recursive: true });
        databaseUrl = `file:${path.join(localTenantRoot, `${databaseName}.db`).replace(/\\/g, '/')}`;
        databaseToken = 'local-tenant-database';
        client = createDatabaseClient({ url: databaseUrl });
        databaseCreated = true;
      } else {
        turso = createTursoClient({ environment });
        const created = await turso.createDatabase(databaseName);
        databaseCreated = true;
        databaseUrl = created.databaseUrl;
        databaseToken = await turso.createDatabaseToken(databaseName);
        client = createDatabaseClient({ url: databaseUrl, authToken: databaseToken });
      }
      const restored = await restoreArchiveToDatabase(buffer, client, initializeRestoredDatabase ? { initializeSchema: initializeRestoredDatabase } : {});
      await client.close?.();
      client = null;
      const controlDb = await getDatabase();
      const inserted = await controlDb.execute({
        sql: `INSERT INTO company_restore_staging (
          source_company_id, backup_id, tenant_db_name, tenant_db_url, tenant_db_token_encrypted, row_counts_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready')`,
        args: [company.id, Number(backupId), databaseName, databaseUrl, encryptToken(databaseToken), JSON.stringify(restored.actualRowCounts)]
      });
      const id = Number(inserted.lastInsertRowid);
      await audit(company.id, 'Company restore staged', `Backup ${backupId} restored to new database ${databaseName}; verified ${Object.keys(restored.actualRowCounts).length} tables.`, adminId);
      return { id, companyId: company.id, backupId: Number(backupId), databaseName, status: 'ready', rowCounts: restored.actualRowCounts, companyCode: archive.companyCode };
    } catch (error) {
      if (client) await client.close?.().catch(() => {});
      if (databaseCreated) {
        if (local) await removeLocalTenantDatabase(databaseUrl.slice('file:'.length)).catch(() => {});
        else if (turso) await turso.deleteDatabase(databaseName).catch(() => {});
      }
      await audit(company.id, 'Company restore staging failed', `Backup ${backupId}: ${error.message}`, adminId);
      await alertFailure(`${company.code} restore staging`, error);
      throw error;
    }
  }

  async function activateRestore(companyId, stagingId, adminId = null) {
    const controlDb = await getDatabase();
    const stageResult = await controlDb.execute({
      sql: "SELECT * FROM company_restore_staging WHERE id = ? AND source_company_id = ? AND status = 'ready'",
      args: [Number(stagingId), Number(companyId)]
    });
    const staging = stageResult.rows?.[0];
    if (!staging) throw new Error('Ready restore staging record not found.');
    const company = await companyRecord(companyId);
    if (!company) throw new Error('Company not found.');
    await createCompanyBackup(companyId, { kind: 'pre-restore-switch', adminId, requireTelegram: Boolean(getTelegram().configured) });
    const oldDatabaseName = company.tenant_db_name || `tf-${company.code}`;
    await controlDb.batch([
      {
        sql: `UPDATE company_restore_staging SET previous_tenant_db_name = ?, previous_tenant_db_url = ?,
            previous_tenant_db_token_encrypted = ?, status = 'activated', activated_at = datetime('now')
          WHERE id = ? AND status = 'ready'`,
        args: [company.tenant_db_name, company.tenant_db_url, company.tenant_db_token_encrypted, Number(stagingId)]
      },
      {
        sql: `UPDATE companies SET tenant_db_name = ?, tenant_db_url = ?, tenant_db_token_encrypted = ?
          WHERE id = ? AND status <> 'deleted'`,
        args: [staging.tenant_db_name, staging.tenant_db_url, staging.tenant_db_token_encrypted, Number(companyId)]
      },
      {
        sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
        args: [adminId, Number(companyId), 'Company restore activated', `Switched from ${oldDatabaseName} to ${staging.tenant_db_name}; old database retained for rollback.`]
      }
    ], 'write');
    const tenantDb = getTenantDb();
    if (closeTenant) await closeTenant(Number(companyId));
    else if (typeof tenantDb.closeTenant === 'function') await tenantDb.closeTenant(Number(companyId));
    return { companyId: Number(companyId), stagingId: Number(stagingId), databaseName: staging.tenant_db_name, oldDatabaseName };
  }

  async function revertRestore(companyId, stagingId, adminId = null) {
    const controlDb = await getDatabase();
    const stageResult = await controlDb.execute({
      sql: "SELECT * FROM company_restore_staging WHERE id = ? AND source_company_id = ? AND status = 'activated'",
      args: [Number(stagingId), Number(companyId)]
    });
    const staging = stageResult.rows?.[0];
    if (!staging?.previous_tenant_db_url || !staging.previous_tenant_db_token_encrypted) {
      throw new Error('No previous company database is available for rollback.');
    }
    const company = await companyRecord(companyId);
    if (!company) throw new Error('Company not found.');
    await createCompanyBackup(companyId, { kind: 'pre-restore-switch', adminId, requireTelegram: Boolean(getTelegram().configured) });
    await controlDb.batch([
      {
        sql: `UPDATE companies SET tenant_db_name = ?, tenant_db_url = ?, tenant_db_token_encrypted = ?
          WHERE id = ? AND status <> 'deleted'`,
        args: [staging.previous_tenant_db_name, staging.previous_tenant_db_url,
          staging.previous_tenant_db_token_encrypted, Number(companyId)]
      },
      {
        sql: "UPDATE company_restore_staging SET status = 'reverted', reverted_at = datetime('now') WHERE id = ? AND status = 'activated'",
        args: [Number(stagingId)]
      },
      {
        sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
        args: [adminId, Number(companyId), 'Company restore reverted', `Switched back from ${company.tenant_db_name} to ${staging.previous_tenant_db_name}.`]
      }
    ], 'write');
    const tenantDb = getTenantDb();
    if (closeTenant) await closeTenant(Number(companyId));
    else if (typeof tenantDb.closeTenant === 'function') await tenantDb.closeTenant(Number(companyId));
    return { companyId: Number(companyId), stagingId: Number(stagingId), databaseName: staging.previous_tenant_db_name };
  }

  async function discardRestore(companyId, stagingId, adminId = null) {
    const controlDb = await getDatabase();
    const result = await controlDb.execute({
      sql: "SELECT * FROM company_restore_staging WHERE id = ? AND source_company_id = ? AND status = 'ready'",
      args: [Number(stagingId), Number(companyId)]
    });
    const staging = result.rows?.[0];
    if (!staging) throw new Error('Ready restore staging record not found.');
    const company = await companyRecord(companyId);
    if (environment.USE_LOCAL_DB === '1') {
      const databasePath = String(staging.tenant_db_url || '').startsWith('file:')
        ? String(staging.tenant_db_url).slice('file:'.length)
        : path.join(localTenantRoot, `${staging.tenant_db_name}.db`);
      await removeLocalTenantDatabase(databasePath);
    } else {
      await createTursoClient({ environment }).deleteDatabase(staging.tenant_db_name);
    }
    await controlDb.execute({ sql: "UPDATE company_restore_staging SET status = 'discarded' WHERE id = ?", args: [Number(stagingId)] });
    await audit(companyId, 'Company restore staging discarded', `Discarded new database ${staging.tenant_db_name}.`, adminId);
    return { stagingId: Number(stagingId), companyCode: company?.code };
  }

  async function closeTenantDatabase(companyId) {
    if (closeTenant) return closeTenant(companyId);
    const tenantDb = getTenantDb();
    if (typeof tenantDb.closeTenant === 'function') return tenantDb.closeTenant(companyId);
  }

  async function processDueCompanyDeletions({ date = now() } = {}) {
    const controlDb = await getDatabase();
    const due = await controlDb.execute({
      sql: "SELECT id, code, name, tenant_db_name, tenant_db_url, tenant_db_token_encrypted FROM companies WHERE status = 'cancelled' AND delete_after <= ? ORDER BY id",
      args: [date.toISOString()]
    });
    const results = [];
    for (const company of due.rows || []) {
      try {
        const finalBackup = await createCompanyBackup(company.id, {
          kind: 'final', backupKey: dayKey(date), requireTelegram: Boolean(getTelegram().configured)
        });
        const tenantDb = getTenantDb();
        const restoreRows = await controlDb.execute({
          sql: `SELECT tenant_db_name, tenant_db_url, tenant_db_token_encrypted,
              previous_tenant_db_name, previous_tenant_db_url, previous_tenant_db_token_encrypted
            FROM company_restore_staging WHERE source_company_id = ?`,
          args: [Number(company.id)]
        });
        const pointers = [{
          tenant_db_name: company.tenant_db_name || (environment.USE_LOCAL_DB === '1' ? company.code : `tf-${company.code}`),
          tenant_db_url: company.tenant_db_url,
          tenant_db_token_encrypted: company.tenant_db_token_encrypted
        }];
        for (const row of restoreRows.rows || []) {
          pointers.push({ tenant_db_name: row.tenant_db_name, tenant_db_url: row.tenant_db_url, tenant_db_token_encrypted: row.tenant_db_token_encrypted });
          if (row.previous_tenant_db_url) pointers.push({
            tenant_db_name: row.previous_tenant_db_name,
            tenant_db_url: row.previous_tenant_db_url,
            tenant_db_token_encrypted: row.previous_tenant_db_token_encrypted
          });
        }
        const uniquePointers = Array.from(new Map(pointers.filter(pointer => pointer.tenant_db_url)
          .map(pointer => [`${pointer.tenant_db_url}|${pointer.tenant_db_name || ''}`, pointer])).values());
        const seenMessages = new Set();
        const localFiles = new Set();
        const attachmentChannel = String(environment.TELEGRAM_CHANNEL_ID || '').trim();
        const controlUrl = getControlDatabaseConfig(environment).url.replace(/\/+$/, '').toLowerCase();
        if (uniquePointers.some(pointer => String(pointer.tenant_db_url).replace(/\/+$/, '').toLowerCase() === controlUrl)) {
          throw new Error('A company database pointer is also the shared control database. Configure separate control and tenant databases before permanent deletion.');
        }
        for (const pointer of uniquePointers) {
          let client;
          let closeClient = false;
          try {
            const sameAsCurrent = pointer.tenant_db_url === company.tenant_db_url;
            if (sameAsCurrent) {
              client = {
                execute: async sql => ({
                  rows: await tenantDb.runWithTenant(Number(company.id), () => tenantDb.prepare(sql).all())
                })
              };
            } else {
              client = await openCompanyPointer(pointer);
              closeClient = true;
            }
            const references = await externalReferencesFromDatabase(client, uploadsDirectory);
            references.messageIds.forEach(messageId => seenMessages.add(messageId));
            references.localFiles.forEach(filePath => localFiles.add(filePath));
          } finally {
            if (closeClient) await client?.close?.();
          }
        }
        if (seenMessages.size && !attachmentChannel) throw new Error('TELEGRAM_CHANNEL_ID is required to remove this company\'s Telegram files.');
        for (const messageId of seenMessages) await getTelegram().deleteMessage(messageId, attachmentChannel);
        for (const filePath of localFiles) await fs.rm(filePath, { force: true });
        await closeTenantDatabase(Number(company.id));
        if (environment.USE_LOCAL_DB === '1') {
          for (const pointer of uniquePointers) {
            let databasePath;
            if (String(pointer.tenant_db_url).startsWith('file:')) {
              databasePath = String(pointer.tenant_db_url).slice('file:'.length);
            } else {
              databasePath = path.join(localTenantRoot, `${pointer.tenant_db_name}.db`);
            }
            await removeLocalTenantDatabase(databasePath);
          }
        } else {
          const turso = createTursoClient({ environment });
          const controlDatabaseName = String(environment.TURSO_DATABASE || '').trim();
          const databaseNames = new Set(uniquePointers.map(pointer => pointer.tenant_db_name).filter(Boolean));
          for (const databaseName of databaseNames) {
            if (databaseName === controlDatabaseName) throw new Error('Refusing to delete the shared control database.');
            await turso.deleteDatabase(databaseName);
          }
        }
        await controlDb.execute({
          sql: `UPDATE companies SET status = 'deleted', name = 'Deleted company', owner_name = NULL,
            owner_email = NULL, owner_phone = NULL, tenant_db_url = '', tenant_db_token_encrypted = '',
            tenant_db_name = NULL, max_users_override = NULL, storage_limit_mb_override = NULL,
            notes = '', delete_after = NULL WHERE id = ? AND status = 'cancelled'`,
          args: [Number(company.id)]
        });
        await controlDb.execute({ sql: 'DELETE FROM web_sessions WHERE company_id = ?', args: [String(company.id)] });
        await audit(company.id, 'Company permanently deleted',
          `Final backup ${finalBackup.id} completed; deleted ${uniquePointers.length} tenant database(s), ${seenMessages.size} Telegram file/location messages, and ${localFiles.size} local files.`);
        results.push({ companyId: Number(company.id), status: 'deleted', backupId: finalBackup.id });
      } catch (error) {
        await audit(company.id, 'Company permanent deletion failed', error.message);
        if (!error.backupAlerted) await alertFailure(`${company.code} permanent deletion`, error);
        results.push({ companyId: Number(company.id), status: 'failed', error: error.message });
      }
    }
    return results;
  }

  async function readBackupFile(companyId, backupId) {
    return getBackupArchive(companyId, backupId);
  }

  return {
    activateRestore,
    createCompanyBackup,
    createRestoreStage,
    discardRestore,
    getBackupArchive,
    pruneDailyBackups,
    processDueCompanyDeletions,
    readBackupFile,
    revertRestore,
    runDailyBackups,
    runMonthlyRestoreTests
  };
}

module.exports = { createBackupManager, dayKey, isWithinDirectory, monthKey, rowCountsEqual };
