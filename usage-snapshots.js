'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { getControlDatabase } = require('./control-db');
const { hasControlDatabaseConfiguration } = require('./tenant-manager');

function isWithinDirectory(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseReceiptPaths(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('Skipping malformed receipt paths while collecting usage.');
    return [];
  }
}

async function getLocalFilesBytes(db, uploadsDirectory) {
  const [comments, reimbursements] = await Promise.all([
    db.prepare("SELECT image_path FROM comments WHERE image_path LIKE '/uploads/%'").all(),
    db.prepare('SELECT receipt_path, receipt_paths FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL').all()
  ]);
  const root = path.resolve(uploadsDirectory);
  const candidates = new Set();

  for (const comment of comments) {
    const relativePath = String(comment.image_path || '').slice('/uploads/'.length);
    if (relativePath) candidates.add(path.resolve(root, relativePath));
  }
  for (const reimbursement of reimbursements) {
    const receiptPaths = parseReceiptPaths(reimbursement.receipt_paths);
    if (reimbursement.receipt_path && !receiptPaths.includes(reimbursement.receipt_path)) {
      receiptPaths.unshift(reimbursement.receipt_path);
    }
    for (const receiptPath of receiptPaths) {
      if (typeof receiptPath !== 'string' || !receiptPath || receiptPath.startsWith('telegram:')) continue;
      const relativePath = receiptPath.startsWith('/uploads/')
        ? receiptPath.slice('/uploads/'.length)
        : path.join('receipts', receiptPath);
      candidates.add(path.resolve(root, relativePath));
    }
  }

  let totalBytes = 0;
  for (const candidate of candidates) {
    if (!isWithinDirectory(root, candidate)) continue;
    let realPath;
    try {
      realPath = await fs.realpath(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!isWithinDirectory(root, realPath)) continue;
    const file = await fs.stat(realPath);
    if (file.isFile()) totalBytes += file.size;
  }
  return totalBytes;
}

async function getTenantUsage(db, uploadsDirectory) {
  const [users, pageCount, pageSize, filesBytes] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS user_count FROM users WHERE active = 1').get(),
    db.prepare('PRAGMA page_count').get(),
    db.prepare('PRAGMA page_size').get(),
    getLocalFilesBytes(db, uploadsDirectory)
  ]);
  const userCount = Number(users?.user_count ?? users?.USER_COUNT);
  const pages = Number(pageCount?.page_count ?? pageCount?.PAGE_COUNT);
  const bytesPerPage = Number(pageSize?.page_size ?? pageSize?.PAGE_SIZE);
  if (!Number.isSafeInteger(userCount) || userCount < 0
    || !Number.isSafeInteger(pages) || pages < 0
    || !Number.isSafeInteger(bytesPerPage) || bytesPerPage < 1) {
    throw new Error('Tenant usage query returned invalid user or database size values.');
  }
  return { userCount, dbBytes: pages * bytesPerPage, filesBytes };
}

function createUsageSnapshotCollector({
  db,
  getDatabase = getControlDatabase,
  uploadsDirectory = path.join(__dirname, 'uploads'),
  environment = process.env
}) {
  if (!db || typeof db.runWithTenant !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('A tenant-aware database is required to collect usage snapshots.');
  }

  return async function collectUsageSnapshots() {
    await db.ready;
    if (!hasControlDatabaseConfiguration(environment)) return 0;
    const controlDb = await getDatabase();
    const companyResult = await controlDb.execute({
      sql: "SELECT id FROM companies WHERE status IN ('trial', 'active', 'suspended') ORDER BY id",
      args: []
    });
    const snapshots = [];
    for (const row of companyResult.rows || []) {
      const companyId = Number(row.id);
      if (!Number.isSafeInteger(companyId) || companyId < 1) {
        throw new Error('Control database returned an invalid company ID for usage collection.');
      }
      const usage = await db.runWithTenant(companyId, () => getTenantUsage(db, uploadsDirectory));
      snapshots.push({
        sql: 'INSERT INTO usage_snapshots (company_id, user_count, db_bytes, files_bytes) VALUES (?, ?, ?, ?)',
        args: [companyId, usage.userCount, usage.dbBytes, usage.filesBytes]
      });
    }
    if (snapshots.length) {
      snapshots.push({
        sql: "DELETE FROM usage_snapshots WHERE taken_at < datetime('now', '-365 days')",
        args: []
      });
      await controlDb.batch(snapshots, 'write');
    }
    return snapshots.length ? snapshots.length - 1 : 0;
  };
}

function collectUsageSnapshots() {
  const db = require('./db');
  return createUsageSnapshotCollector({ db })();
}

module.exports = {
  collectUsageSnapshots,
  createUsageSnapshotCollector,
  getLocalFilesBytes,
  getTenantUsage
};
