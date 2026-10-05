const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { logActivity } = require('../audit');
const { csvValue } = require('../csv');
const { requireAuth, requireAdmin } = require('./auth');
const { logRequestEvent, sendInternalError, wrapAsyncRoutes } = require('../http-errors');
const { uploadToTelegram, streamFromTelegram, deleteTelegramMessage } = require('../telegram-storage');
const { parseMoneyAmount } = require('../lib/money');
const { businessDate } = require('../lib/business-date');
const { requireFeature, reserveUpload, releaseUpload, StorageLimitError } = require('../limits');
const uploadRateLimit = require('../upload-rate-limit');

const router = express.Router();

wrapAsyncRoutes(router);
router.use(requireAuth);
router.use(requireFeature('reimbursements'));

const receiptsDir = path.join(__dirname, '..', 'uploads', 'receipts');
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
const maxReceiptRequestBytes = 20 * 1024 * 1024;
const receiptMemoryStorage = {
  _handleFile(req, file, callback) {
    const chunks = [];
    let fileSize = 0;
    let settled = false;
    let aggregateError = null;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      callback(error, info);
    };
    file.stream.on('data', chunk => {
      fileSize += chunk.length;
      req.receiptUploadBytes = (req.receiptUploadBytes || 0) + chunk.length;
      if (req.receiptUploadBytes > maxReceiptRequestBytes) {
        aggregateError ||= Object.assign(new Error('Receipt uploads cannot exceed 20 MB total per request.'), { code: 'LIMIT_RECEIPT_TOTAL_SIZE' });
        chunks.length = 0;
        return;
      }
      if (!aggregateError) chunks.push(chunk);
    });
    file.stream.on('error', error => finish(error));
    file.stream.on('end', () => finish(aggregateError, aggregateError ? undefined : { buffer: Buffer.concat(chunks), size: fileSize }));
  },
  _removeFile(req, file, callback) {
    delete file.buffer;
    callback(null);
  }
};
const upload = multer({
  storage: receiptMemoryStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'].includes(file.mimetype)) {
      const error = new Error('Receipts must be JPEG, PNG, GIF, WebP, or PDF files.');
      error.status = 415;
      return cb(error);
    }
    cb(null, true);
  }
});
const fileTypeFromBufferPromise = import('file-type').then(module => module.fileTypeFromBuffer);

async function verifyReceiptFiles(req, res, next) {
  try {
    const fileTypeFromBuffer = await fileTypeFromBufferPromise;
    for (const file of req.files || []) {
      const detected = await fileTypeFromBuffer(file.buffer);
      if (!detected || detected.mime !== file.mimetype) {
        return res.status(415).json({ error: 'Receipt content does not match its declared file type.' });
      }
    }
    next();
  } catch (error) {
    sendInternalError(res, error, 'Receipt type validation failed');
  }
}

async function uploadReceiptFiles(files, req) {
  const uploaded = [];
  try {
    for (const [index, file] of files.entries()) {
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 350));
      const attachment = await uploadToTelegram(file);
      uploaded.push({ attachment, file });
    }
    return uploaded;
  } catch (error) {
    await cleanupUploadedReceipts(uploaded, null, req);
    throw error;
  }
}

async function cleanupUploadedReceipts(uploaded, reimbursementId = null, req = null) {
  const fileIds = uploaded.map(item => item.attachment.fileId).filter(Boolean);
  if (reimbursementId && fileIds.length) {
    try {
      const placeholders = fileIds.map(() => '?').join(',');
      await db.prepare(`DELETE FROM telegram_attachments WHERE reimbursement_id=? AND file_id IN (${placeholders})`)
        .run(reimbursementId, ...fileIds);
    } catch (error) {
      logRequestEvent(req, 'receipt_metadata_cleanup_failed');
    }
  }
  for (const { attachment } of uploaded) {
    try {
      await deleteTelegramMessage(attachment.messageId);
    } catch (error) {
      logRequestEvent(req, 'receipt_file_cleanup_failed');
    }
  }
}

function handleReceiptUpload(req, res, next) {
  req.receiptUploadBytes = 0;
  upload.array('receipt', 10)(req, res, error => {
    if (!error) return verifyReceiptFiles(req, res, next);
    if (error.code === 'LIMIT_RECEIPT_TOTAL_SIZE') return res.status(413).json({ error: error.message });
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Receipt files cannot exceed 10 MB each.' });
    if (error.status === 415) return res.status(415).json({ error: error.message });
    return res.status(400).json({ error: 'Unable to receive receipt files. Check the files and try again.' });
  });
}

function getReceiptPaths(row) {
  let receiptPaths = [];
  try { receiptPaths = row.receipt_paths ? JSON.parse(row.receipt_paths) : []; } catch (error) { receiptPaths = []; }
  if (!Array.isArray(receiptPaths)) receiptPaths = [];
  if (row.receipt_path && !receiptPaths.includes(row.receipt_path)) receiptPaths.unshift(row.receipt_path);
  return receiptPaths;
}

function mapRow(row, telegramAttachments) {
  let receiptMeta = [];
  try { receiptMeta = row.receipt_meta ? JSON.parse(row.receipt_meta) : []; } catch (error) { receiptMeta = []; }
  if (!Array.isArray(receiptMeta)) receiptMeta = [];
  const receipts = getReceiptPaths(row).map((receiptPath, index) => {
    const telegramReceipt = receiptPath.startsWith('telegram:');
    const fileId = telegramReceipt ? receiptPath.slice('telegram:'.length) : null;
    const telegramAttachment = fileId ? telegramAttachments.get(fileId) : null;
    const expired = telegramReceipt
      ? !telegramAttachment || !!telegramAttachment.deleted_at
      : !fs.existsSync(path.join(receiptsDir, receiptPath));
    return {
      path: receiptPath,
      url: telegramReceipt && !expired
        ? `/api/reimbursements/receipts/${encodeURIComponent(fileId)}`
        : (fs.existsSync(path.join(receiptsDir, receiptPath)) ? `/uploads/receipts/${receiptPath}` : null),
      mime_type: receiptMeta[index]?.mime_type || telegramAttachment?.mime_type || '',
      original_name: receiptMeta[index]?.original_name || telegramAttachment?.original_name || '',
      storage: telegramReceipt ? 'Telegram storage' : 'App storage',
      expired
    };
  });
  return {
    ...row,
    receipt_urls: receipts.filter(receipt => receipt.url).map(receipt => receipt.url),
    receipt_items: receipts,
    receipt_url: receipts.find(receipt => receipt.url)?.url || null,
    receipt_expired: receipts.some(receipt => receipt.expired)
  };
}

async function mapRows(rows) {
  const fileIds = [...new Set((rows || []).flatMap(getReceiptPaths)
    .filter(receiptPath => typeof receiptPath === 'string' && receiptPath.startsWith('telegram:'))
    .map(receiptPath => receiptPath.slice('telegram:'.length)))];
  const attachmentsByFileId = new Map();
  if (fileIds.length) {
    const placeholders = fileIds.map(() => '?').join(',');
    const attachments = await db.prepare(`SELECT file_id, original_name, mime_type, deleted_at
      FROM telegram_attachments WHERE reimbursement_id IS NOT NULL AND file_id IN (${placeholders}) ORDER BY id DESC`).all(...fileIds);
    for (const attachment of attachments || []) {
      if (!attachmentsByFileId.has(String(attachment.file_id))) attachmentsByFileId.set(String(attachment.file_id), attachment);
    }
  }
  return (rows || []).map(row => mapRow(row, attachmentsByFileId));
}

async function getAccess(req) {
  if (req.session.role === 'admin') return { approval_level: 2, can_pay: 1 };
  return await db.prepare(`SELECT ra.approval_level, ra.can_pay, u.department
    FROM reimbursement_access ra JOIN users u ON u.id=ra.user_id WHERE ra.user_id=?`).get(req.session.userId)
    || { approval_level: 0, can_pay: 0, department: '' };
}

async function canAccessClaim(req, claim) {
  if (!claim) return false;
  if (req.session.role === 'admin' || Number(claim.user_id) === Number(req.session.userId)) return true;
  const access = await getAccess(req);
  if (Number(access.approval_level) <= 0) return false;
  const department = claim.department ?? (await db.prepare('SELECT department FROM users WHERE id=?').get(claim.user_id))?.department;
  return String(department || '') === String(access.department || '');
}

function getApprovalTransition(access, claim, approverId) {
  const level = Number(access.approval_level || 0);
  if (claim.status === 'submitted') {
    if (level < 1) return { error: 'You do not have level 1 approval access.', status: 403 };
    return { status: 'approved_level_1', actorColumn: 'approved_level_1_by' };
  }
  if (claim.status === 'approved_level_1') {
    if (level < 2) return { error: 'This claim requires level 2 approval.', status: 403 };
    if (Number(claim.approved_level_1_by) === Number(approverId)) {
      return { error: 'Level 1 and level 2 approvals must be completed by different people.', status: 403 };
    }
    return { status: 'approved', actorColumn: 'approved_by' };
  }
  return { error: `A claim in ${claim.status} cannot be approved.`, status: 409 };
}

async function getReimbursementRows(req, { paginate = false } = {}) {
  const { status, from, to, user_id } = req.query;
  let sql = `SELECT r.*, u.name AS user_name, u.department FROM reimbursements r JOIN users u ON u.id = r.user_id WHERE 1=1`;
  const params = [];
  const access = await getAccess(req);
  if (req.session.role !== 'admin' && !access.approval_level) { sql += ' AND r.user_id = ?'; params.push(req.session.userId); }
  else if (req.session.role !== 'admin') { sql += ' AND u.department = ?'; params.push(access.department || ''); }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (from) { sql += ' AND r.expense_date >= ?'; params.push(from); }
  if (to) { sql += ' AND r.expense_date <= ?'; params.push(to); }
  if (user_id && access.approval_level) { sql += ' AND r.user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY r.expense_date DESC, r.created_at DESC';
  if (!paginate) return db.prepare(sql).all(...params);
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 50;
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const rows = await db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, has_more: hasMore, next_offset: offset + items.length, limit };
}

router.get('/summary', async (req, res) => {
  try {
    const access = await getAccess(req);
    let sql = `SELECT r.currency, COUNT(*) AS claim_count,
      ROUND(COALESCE(SUM(r.amount), 0), 2) AS total_amount,
      ROUND(COALESCE(SUM(CASE WHEN r.status IN ('submitted', 'approved_level_1') THEN r.amount ELSE 0 END), 0), 2) AS pending_amount,
      ROUND(COALESCE(SUM(CASE WHEN r.status IN ('approved', 'paid') THEN r.amount ELSE 0 END), 0), 2) AS approved_amount
      FROM reimbursements r JOIN users u ON u.id = r.user_id
      WHERE r.expense_date <= ?`;
    const params = [businessDate()];
    if (req.session.role !== 'admin' && !access.approval_level) {
      sql += ' AND r.user_id = ?';
      params.push(req.session.userId);
    } else if (req.session.role !== 'admin') {
      sql += ' AND u.department = ?';
      params.push(access.department || '');
    }
    sql += ' GROUP BY r.currency ORDER BY r.currency';
    const currencyTotals = await db.prepare(sql).all(...params);
    res.json({
      claim_count: (currencyTotals || []).reduce((total, row) => total + Number(row.claim_count || 0), 0),
      currency_totals: currencyTotals || []
    });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement summary failed');
  }
});

router.get('/', async (req, res) => {
  try {
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    if (Number.isSafeInteger(requestedOffset) && requestedOffset > 1_000_000) {
      return res.status(400).json({ error: 'Reimbursement page offset is too large.' });
    }
    const page = await getReimbursementRows(req, { paginate: true });
    res.json({ ...page, items: await mapRows(page.items) });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement list failed');
  }
});

router.get('/receipts/:fileId', async (req, res) => {
  try {
    const attachments = await db.prepare(`SELECT reimbursement_id, original_name, mime_type
      FROM telegram_attachments WHERE file_id = ? AND deleted_at IS NULL AND reimbursement_id IS NOT NULL
      ORDER BY id DESC`).all(req.params.fileId);
    if (!attachments.length) return res.status(404).json({ error: 'Receipt not found.' });
    let attachment = null;
    let linkedClaim = false;
    for (const candidate of attachments) {
      const claim = await db.prepare(`SELECT r.id, r.user_id, r.receipt_path, r.receipt_paths, u.department
        FROM reimbursements r JOIN users u ON u.id=r.user_id WHERE r.id=?`).get(candidate.reimbursement_id);
      if (!claim) continue;
      let receiptPaths = [];
      try { receiptPaths = claim.receipt_paths ? JSON.parse(claim.receipt_paths) : []; } catch (error) { receiptPaths = []; }
      if (!Array.isArray(receiptPaths)) receiptPaths = [];
      if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
      if (!receiptPaths.includes(`telegram:${req.params.fileId}`)) continue;
      linkedClaim = true;
      if (await canAccessClaim(req, claim)) {
        attachment = candidate;
        break;
      }
    }
    if (!linkedClaim) return res.status(404).json({ error: 'Receipt not found.' });
    if (!attachment) return res.status(403).json({ error: 'You do not have access to this receipt.' });
    await streamFromTelegram(req.params.fileId, res, { originalName: attachment?.original_name });
  } catch (error) {
    sendInternalError(res, error, 'Receipt download failed');
  }
});

router.get('/export.csv', requireFeature('export'), async (req, res) => {
  try {
    const rows = await getReimbursementRows(req);
    const headers = ['Employee', 'Department', 'Submitted on', 'Expense date', 'Category', 'Description', 'Amount', 'Currency', 'Status', 'Admin note'];
    const lines = [headers.map(csvValue).join(',')];
    rows.forEach(row => lines.push([
      row.user_name, row.department, row.created_at, row.expense_date, row.category,
      row.description, row.amount, row.currency, row.status, row.admin_note
    ].map(csvValue).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="reimbursements.csv"');
    res.send(`\ufeff${lines.join('\n')}`);
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement export failed');
  }
});

router.post('/', uploadRateLimit, handleReceiptUpload, async (req, res) => {
  try {
    const amount = parseMoneyAmount(req.body.amount, { allowZero: false });
    const category = String(req.body.category || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    const currency = String(req.body.currency || 'INR').trim().toUpperCase();
    const parsedExpenseDate = new Date(`${expenseDate}T00:00:00Z`);
    const validExpenseDate = /^\d{4}-\d{2}-\d{2}$/.test(expenseDate)
      && Number.isFinite(parsedExpenseDate.getTime())
      && parsedExpenseDate.toISOString().slice(0, 10) === expenseDate
      && expenseDate >= '2000-01-01' && expenseDate <= businessDate();
    if (amount === null || !category || category.length > 100 || !validExpenseDate
      || !/^[A-Z]{3}$/.test(currency) || description.length > 2000) {
      return res.status(400).json({ error: 'Enter a valid amount, a category up to 100 characters, a currency code, a non-future expense date since 2000, and a description up to 2000 characters.' });
    }
    const submissionKey = String(req.body.submission_key || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionKey)) {
      return res.status(400).json({ error: 'A valid submission key is required. Refresh the form and try again.' });
    }
    const existingSubmission = await db.prepare(`SELECT id, user_id, amount, currency, category, description, expense_date
      FROM reimbursements WHERE submission_key=?`).get(submissionKey);
    if (existingSubmission) {
      const matches = Number(existingSubmission.user_id) === Number(req.session.userId)
        && Number(existingSubmission.amount) === amount
        && existingSubmission.currency === currency
        && existingSubmission.category === category
        && existingSubmission.description === description
        && existingSubmission.expense_date === expenseDate;
      if (!matches) return res.status(409).json({ error: 'This submission key was already used for different claim data.' });
      return res.json({ ok: true, id: existingSubmission.id, duplicate: true });
    }
    const receiptPaths = [];
    const receiptMeta = [];
    const receiptBytes = Number(req.receiptUploadBytes || 0);
    let reservation = null;
    if (receiptBytes > 0) reservation = await reserveUpload(req, receiptBytes);
    let uploadedAttachments;
    try {
      uploadedAttachments = await uploadReceiptFiles(req.files || [], req);
    } catch (error) {
      if (reservation) {
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'receipt_upload_reservation_release_failed'); }
      }
      throw error;
    }
    for (const { attachment, file } of uploadedAttachments) {
      receiptPaths.push(`telegram:${attachment.fileId}`);
      receiptMeta.push({ original_name: file.originalname, mime_type: file.mimetype });
    }
    let info;
    try {
      info = await db.prepare(`INSERT INTO reimbursements (user_id, amount, currency, category, description, expense_date, receipt_path, receipt_paths, receipt_meta, submission_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.session.userId, amount, currency, category, description, expenseDate, receiptPaths[0] || null,
          receiptPaths.length ? JSON.stringify(receiptPaths) : null, receiptMeta.length ? JSON.stringify(receiptMeta) : null, submissionKey);
      if (uploadedAttachments.length) {
        const statements = uploadedAttachments.map(({ attachment, file }) => ({
          sql: 'INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type, uploaded_by, reimbursement_id, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [attachment.fileId, attachment.messageId, file.originalname, file.mimetype, req.session.userId, info.lastInsertRowid, file.size]
        }));
        statements.push({ sql: 'DELETE FROM file_usage WHERE file_reference = ?', args: [reservation] });
        await db.batch(statements);
      }
    } catch (error) {
      await cleanupUploadedReceipts(uploadedAttachments, info?.lastInsertRowid || null, req);
      if (reservation) {
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'receipt_upload_reservation_release_failed'); }
      }
      if (/reimbursements\.submission_key/i.test(String(error.message))) {
        const duplicate = await db.prepare(`SELECT id, user_id, amount, currency, category, description, expense_date
          FROM reimbursements WHERE submission_key=?`).get(submissionKey);
        if (duplicate && Number(duplicate.user_id) === Number(req.session.userId)
          && Number(duplicate.amount) === amount && duplicate.currency === currency
          && duplicate.category === category && duplicate.description === description
          && duplicate.expense_date === expenseDate) {
          return res.json({ ok: true, id: duplicate.id, duplicate: true });
        }
        return res.status(409).json({ error: 'This claim was submitted concurrently. Reload your expense list.' });
      }
      if (info?.lastInsertRowid) {
        try { await db.prepare('DELETE FROM reimbursements WHERE id=?').run(info.lastInsertRowid); }
        catch (cleanupError) { logRequestEvent(req, 'reimbursement_cleanup_failed'); }
      }
      throw error;
    }
    await logActivity(req, 'Reimbursement added', 'reimbursement', info.lastInsertRowid, `${amount} ${currency} - ${category}`, req.session.userId);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (error) {
    if (error instanceof StorageLimitError) return res.status(error.statusCode).json({ error: error.message });
    sendInternalError(res, error, 'Reimbursement creation failed');
  }
});

router.put('/:id(\\d+)', handleReceiptUpload, async (req, res) => {
  try {
    const claim = await db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Expense not found.' });
    if (Number(claim.user_id) !== Number(req.session.userId)) return res.status(403).json({ error: 'You can only edit your own expenses.' });
    if (claim.status !== 'submitted') return res.status(409).json({ error: 'Expenses can only be edited before the first approval.' });

    const amount = parseMoneyAmount(req.body.amount, { allowZero: false });
    const currency = String(req.body.currency || claim.currency || 'INR').trim().toUpperCase();
    const category = String(req.body.category || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    const parsedExpenseDate = new Date(`${expenseDate}T00:00:00Z`);
    const validExpenseDate = /^\d{4}-\d{2}-\d{2}$/.test(expenseDate)
      && Number.isFinite(parsedExpenseDate.getTime())
      && parsedExpenseDate.toISOString().slice(0, 10) === expenseDate
      && expenseDate >= '2000-01-01' && expenseDate <= businessDate();
    if (amount === null || !/^[A-Z]{3}$/.test(currency) || !category || category.length > 100
      || !validExpenseDate || description.length > 2000) {
      return res.status(400).json({ error: 'Enter a valid amount, currency code, category up to 100 characters, non-future expense date since 2000, and description up to 2000 characters.' });
    }

    let receiptPaths = [];
    let receiptMeta = [];
    try { receiptPaths = claim.receipt_paths ? JSON.parse(claim.receipt_paths) : []; } catch (error) { receiptPaths = []; }
    try { receiptMeta = claim.receipt_meta ? JSON.parse(claim.receipt_meta) : []; } catch (error) { receiptMeta = []; }
    if (!Array.isArray(receiptPaths)) receiptPaths = [];
    if (!Array.isArray(receiptMeta)) receiptMeta = [];
    if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
    if (receiptPaths.length + (req.files || []).length > 10) {
      return res.status(400).json({ error: 'An expense can have up to 10 receipts.' });
    }
    while (receiptMeta.length < receiptPaths.length) receiptMeta.push({});
    const receiptBytes = Number(req.receiptUploadBytes || 0);
    let reservation = null;
    if (receiptBytes > 0) reservation = await reserveUpload(req, receiptBytes);
    let uploadedAttachments;
    try {
      uploadedAttachments = await uploadReceiptFiles(req.files || []);
    } catch (error) {
      if (reservation) {
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'receipt_edit_reservation_release_failed'); }
      }
      throw error;
    }
    for (const { attachment, file } of uploadedAttachments) {
      receiptPaths.push(`telegram:${attachment.fileId}`);
      receiptMeta.push({ original_name: file.originalname, mime_type: file.mimetype });
    }

    const statements = uploadedAttachments.map(({ attachment, file }) => ({
      sql: 'INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type, uploaded_by, reimbursement_id, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [attachment.fileId, attachment.messageId, file.originalname, file.mimetype, req.session.userId, claim.id, file.size]
    }));
    if (reservation) statements.push({ sql: 'DELETE FROM file_usage WHERE file_reference = ?', args: [reservation] });
    statements.push({
      sql: `UPDATE reimbursements
        SET amount = ?, currency = ?, category = ?, description = ?, expense_date = ?,
            receipt_path = ?, receipt_paths = ?, receipt_meta = ?, edited_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND status = 'submitted'`,
      args: [amount, currency, category, description, expenseDate, receiptPaths[0] || null,
        receiptPaths.length ? JSON.stringify(receiptPaths) : null,
        receiptMeta.length ? JSON.stringify(receiptMeta) : null,
        req.params.id, req.session.userId]
    });
    let results;
    try {
      results = await db.batch(statements);
    } catch (error) {
      await cleanupUploadedReceipts(uploadedAttachments, claim.id);
      if (reservation) {
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'receipt_edit_reservation_release_failed'); }
      }
      throw error;
    }
    const updated = results?.at(-1);
    if (Number(updated?.rowsAffected ?? updated?.changes ?? 0) !== 1) {
      await cleanupUploadedReceipts(uploadedAttachments, claim.id);
      if (reservation) {
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'receipt_edit_reservation_release_failed'); }
      }
      return res.status(409).json({ error: 'This expense is no longer editable.' });
    }
    await logActivity(req, 'Reimbursement updated', 'reimbursement', req.params.id,
      `Amount: ${Number(claim.amount).toFixed(2)} ${claim.currency} -> ${amount.toFixed(2)} ${currency}; category: ${claim.category} -> ${category}`,
      req.session.userId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof StorageLimitError) return res.status(error.statusCode).json({ error: error.message });
    sendInternalError(res, error, 'Reimbursement update failed');
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const claim = await db.prepare(`SELECT id, user_id, amount, currency, category, status, receipt_path, receipt_paths
      FROM reimbursements WHERE id=?`).get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Expense not found.' });
    if (claim.status === 'paid') return res.status(409).json({ error: 'Paid reimbursements cannot be deleted.' });
    let receiptPaths = [];
    try { receiptPaths = claim.receipt_paths ? JSON.parse(claim.receipt_paths) : []; } catch (error) { receiptPaths = []; }
    if (!Array.isArray(receiptPaths)) receiptPaths = [];
    if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
    const attachments = await db.prepare('SELECT file_id, message_id FROM telegram_attachments WHERE reimbursement_id=?').all(claim.id);
    const messagesByFileId = new Map((attachments || []).map(row => [String(row.file_id), row.message_id]));
    const telegramFileIds = [...new Set(receiptPaths
      .filter(receiptPath => typeof receiptPath === 'string' && receiptPath.startsWith('telegram:'))
      .map(receiptPath => receiptPath.slice('telegram:'.length)))];
    await logActivity(req, 'Reimbursement deleted', 'reimbursement', req.params.id, `${claim.amount} ${claim.currency} - ${claim.category}`, claim.user_id);
    const deletionResults = await db.batch([
      { sql: `DELETE FROM telegram_attachments WHERE reimbursement_id=?
        AND EXISTS (SELECT 1 FROM reimbursements WHERE id=? AND status<>'paid')`, args: [claim.id, claim.id] },
      { sql: "DELETE FROM reimbursements WHERE id=? AND status<>'paid'", args: [req.params.id] }
    ]);
    if (Number(deletionResults?.[1]?.rowsAffected ?? deletionResults?.[1]?.changes ?? 0) !== 1) {
      return res.status(409).json({ error: 'This reimbursement was paid or changed and cannot be deleted.' });
    }
    for (const fileId of telegramFileIds) {
      const messageId = messagesByFileId.get(fileId);
      if (!messageId) continue;
      try { await deleteTelegramMessage(messageId); }
      catch (error) { logRequestEvent(req, 'receipt_delete_failed'); }
    }
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement deletion failed');
  }
});

router.put('/bulk-status', async (req, res) => {
  const submittedIds = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  if (submittedIds.some(id => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ error: 'Every reimbursement ID must be a positive integer.' });
  const ids = [...new Set(submittedIds)];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one reimbursement.' });
  try {
    const access = await getAccess(req);
    if (!access.approval_level) return res.status(403).json({ error: 'You do not have reimbursement approval access.' });
    const claims = await Promise.all(ids.map(id => db.prepare(`SELECT r.id, r.user_id, r.status, r.amount, r.currency, r.category,
      r.approved_level_1_by, u.department FROM reimbursements r JOIN users u ON u.id=r.user_id WHERE r.id=?`).get(id)));
    if (claims.some(claim => !claim)) return res.status(404).json({ error: 'One or more reimbursements were not found.' });
    for (const claim of claims) {
      if (!(await canAccessClaim(req, claim))) return res.status(403).json({ error: 'You do not have access to every selected reimbursement.' });
    }
    if (claims.some(claim => claim && Number(claim.user_id) === Number(req.session.userId))) {
      return res.status(403).json({ error: 'You cannot approve or pay your own reimbursement.' });
    }
    const transitions = claims.map(claim => getApprovalTransition(access, claim, req.session.userId));
    const invalidTransition = transitions.find(transition => transition.error);
    if (invalidTransition) return res.status(invalidTransition.status).json({ error: invalidTransition.error });
    const statements = claims.map((claim, index) => ({
      sql: `UPDATE reimbursements SET status=?, ${transitions[index].actorColumn}=?, updated_at=datetime('now') WHERE id=? AND status=?`,
      args: [transitions[index].status, req.session.userId, claim.id, claim.status]
    }));
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length
      || results.some(result => Number(result.rowsAffected ?? result.changes ?? 0) !== 1)) {
      return res.status(409).json({ error: 'One or more reimbursement statuses changed. Reload and try again.' });
    }
    for (const [index, claim] of claims.entries()) {
      const activityStatus = transitions[index].status === 'approved_level_1' ? 'approved (level 1)' : 'approved';
      await logActivity(req, `Reimbursement ${activityStatus}`, 'reimbursement', claim.id, `${claim.amount} ${claim.currency} - ${claim.category}`, claim.user_id);
    }
    res.json({ ok: true, updated: claims.length });
  } catch (error) {
    sendInternalError(res, error, 'Bulk reimbursement update failed');
  }
});

router.put('/:id/status', async (req, res) => {
  const status = String(req.body.status || '').trim().toLowerCase();
  if (!['approved', 'rejected', 'paid'].includes(status)) return res.status(400).json({ error: 'Invalid reimbursement status.' });
  try {
    const access = await getAccess(req);
    if (!access.approval_level) return res.status(403).json({ error: 'You do not have reimbursement approval access.' });
    const claim = await db.prepare(`SELECT r.user_id, r.status, r.amount, r.currency, r.category,
      r.approved_level_1_by, r.admin_note, u.department
      FROM reimbursements r JOIN users u ON u.id=r.user_id WHERE r.id=?`).get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });
    if (Number(claim.user_id) === Number(req.session.userId)) return res.status(403).json({ error: 'You cannot approve or pay your own reimbursement.' });
    if (!(await canAccessClaim(req, claim))) return res.status(403).json({ error: 'You do not have access to this reimbursement.' });
    let nextStatus = status;
    if (status === 'approved') {
      const transition = getApprovalTransition(access, claim, req.session.userId);
      if (transition.error) return res.status(transition.status).json({ error: transition.error });
      nextStatus = transition.status;
    } else if (status === 'rejected') {
      if (!['submitted', 'approved_level_1', 'approved'].includes(claim.status)) {
        return res.status(409).json({ error: `A claim in ${claim.status} cannot be rejected.` });
      }
      if (claim.status === 'approved' && Number(access.approval_level) < 2) {
        return res.status(403).json({ error: 'Level 2 approval is required to reject this claim.' });
      }
    } else if (!access.can_pay || claim.status !== 'approved') {
      return res.status(403).json({ error: 'Only the final payer can mark an approved claim as paid.' });
    }

    const previousStatus = claim.status;
    const hasAdminNote = Object.prototype.hasOwnProperty.call(req.body || {}, 'admin_note');
    if (hasAdminNote && (typeof req.body.admin_note !== 'string' || req.body.admin_note.length > 2000)) {
      return res.status(400).json({ error: 'Approval notes must be strings of at most 2000 characters.' });
    }
    const note = hasAdminNote ? req.body.admin_note.trim() : '';
    if (status === 'rejected' && !note) return res.status(400).json({ error: 'A rejection reason is required.' });
    const noteToPersist = note ? (claim.admin_note ? `${claim.admin_note}\n${note}` : note) : null;
    const updates = ['status=?'];
    const values = [nextStatus];
    if (nextStatus === 'approved_level_1') {
      updates.push('approved_level_1_by=?');
      values.push(req.session.userId);
    } else if (nextStatus === 'approved') {
      updates.push('approved_by=?');
      values.push(req.session.userId);
    } else if (nextStatus === 'paid') {
      updates.push('paid_by=?', 'paid_at=?');
      values.push(req.session.userId, new Date().toISOString());
    }
    if (noteToPersist !== null) {
      updates.push('admin_note=?');
      values.push(noteToPersist);
    }
    updates.push("updated_at=datetime('now')");
    values.push(req.params.id, previousStatus);
    const updated = await db.prepare(`UPDATE reimbursements SET ${updates.join(', ')} WHERE id=? AND status=?`).run(...values);
    if (!updated.changes) return res.status(409).json({ error: 'This claim status changed. Reload and try again.' });
    const activityStatus = nextStatus === 'approved_level_1' ? 'approved (level 1)' : nextStatus;
    await logActivity(req, `Reimbursement ${activityStatus}`, 'reimbursement', req.params.id, `${claim.amount} ${claim.currency} - ${claim.category}`, claim.user_id);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement status update failed');
  }
});

router.canAccessClaim = canAccessClaim;
module.exports = router;
