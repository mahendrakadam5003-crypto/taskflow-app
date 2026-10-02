const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { logActivity } = require('../audit');
const { csvValue } = require('../csv');
const { requireAuth, requireAdmin } = require('./auth');
const { sendInternalError, wrapAsyncRoutes } = require('../http-errors');
const { uploadToTelegram, streamFromTelegram } = require('../telegram-storage');

const router = express.Router();
wrapAsyncRoutes(router);
router.use(requireAuth);

const receiptsDir = path.join(__dirname, '..', 'uploads', 'receipts');
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image\/|application\/pdf$)/i.test(file.mimetype))
});

async function mapRow(row) {
  let receiptPaths = [];
  let receiptMeta = [];
  try { receiptPaths = row.receipt_paths ? JSON.parse(row.receipt_paths) : []; } catch (error) { receiptPaths = []; }
  try { receiptMeta = row.receipt_meta ? JSON.parse(row.receipt_meta) : []; } catch (error) { receiptMeta = []; }
  if (!Array.isArray(receiptPaths)) receiptPaths = [];
  if (row.receipt_path && !receiptPaths.includes(row.receipt_path)) receiptPaths.unshift(row.receipt_path);
  const receipts = await Promise.all(receiptPaths.map(async (receiptPath, index) => {
    const telegramReceipt = receiptPath.startsWith('telegram:');
    const telegramAttachment = telegramReceipt && !receiptMeta[index]
      ? await db.prepare('SELECT original_name, mime_type FROM telegram_attachments WHERE file_id = ? ORDER BY id DESC LIMIT 1').get(receiptPath.slice('telegram:'.length))
      : null;
    return {
      path: receiptPath,
      url: telegramReceipt
        ? `/api/reimbursements/receipts/${encodeURIComponent(receiptPath.slice('telegram:'.length))}`
        : (fs.existsSync(path.join(receiptsDir, receiptPath)) ? `/uploads/receipts/${receiptPath}` : null),
      mime_type: receiptMeta[index]?.mime_type || telegramAttachment?.mime_type || '',
      original_name: receiptMeta[index]?.original_name || telegramAttachment?.original_name || '',
      storage: telegramReceipt ? 'Telegram storage' : 'App storage',
      expired: !telegramReceipt && !fs.existsSync(path.join(receiptsDir, receiptPath))
    };
  }));
  return {
    ...row,
    receipt_urls: receipts.filter(receipt => receipt.url).map(receipt => receipt.url),
    receipt_items: receipts,
    receipt_url: receipts.find(receipt => receipt.url)?.url || null,
    receipt_expired: receipts.some(receipt => receipt.expired)
  };
}

async function getAccess(req) {
  if (req.session.role === 'admin') return { approval_level: 2, can_pay: 1 };
  return await db.prepare('SELECT approval_level, can_pay FROM reimbursement_access WHERE user_id = ?').get(req.session.userId) || { approval_level: 0, can_pay: 0 };
}

async function canAccessClaim(req, claim) {
  if (!claim) return false;
  if (req.session.role === 'admin' || Number(claim.user_id) === Number(req.session.userId)) return true;
  const access = await getAccess(req);
  return Number(access.approval_level) > 0;
}

async function getReimbursementRows(req) {
  const { status, from, to, user_id } = req.query;
  let sql = `SELECT r.*, u.name AS user_name, u.department FROM reimbursements r JOIN users u ON u.id = r.user_id WHERE 1=1`;
  const params = [];
  const access = await getAccess(req);
  if (req.session.role !== 'admin' && !access.approval_level) { sql += ' AND r.user_id = ?'; params.push(req.session.userId); }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (from) { sql += ' AND r.expense_date >= ?'; params.push(from); }
  if (to) { sql += ' AND r.expense_date <= ?'; params.push(to); }
  if (user_id && access.approval_level) { sql += ' AND r.user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY r.expense_date DESC, r.created_at DESC';
  return db.prepare(sql).all(...params);
}

router.get('/summary', async (req, res) => {
  try {
    const access = await getAccess(req);
    let sql = `SELECT COUNT(*) AS claim_count,
      COALESCE(SUM(r.amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN r.status IN ('submitted', 'approved_level_1') THEN r.amount ELSE 0 END), 0) AS pending_amount,
      COALESCE(SUM(CASE WHEN r.status IN ('approved', 'paid') THEN r.amount ELSE 0 END), 0) AS approved_amount
      FROM reimbursements r JOIN users u ON u.id = r.user_id
      WHERE r.expense_date <= date('now', 'localtime')`;
    const params = [];
    if (req.session.role !== 'admin' && !access.approval_level) {
      sql += ' AND r.user_id = ?';
      params.push(req.session.userId);
    }
    res.json(await db.prepare(sql).get(...params));
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement summary failed');
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = await getReimbursementRows(req);
    res.json(await Promise.all(rows.map(mapRow)));
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
      const claim = await db.prepare('SELECT id, user_id, receipt_path, receipt_paths FROM reimbursements WHERE id = ?').get(candidate.reimbursement_id);
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

router.get('/export.csv', async (req, res) => {
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

router.post('/', upload.array('receipt', 10), async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const category = String(req.body.category || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !category || !expenseDate) {
      return res.status(400).json({ error: 'Amount, category, and expense date are required.' });
    }
    const receiptPaths = [];
    const receiptMeta = [];
    const uploadedAttachments = [];
    for (const [index, file] of (req.files || []).entries()) {
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 350));
      const attachment = await uploadToTelegram(file);
      receiptPaths.push(`telegram:${attachment.fileId}`);
      receiptMeta.push({ original_name: file.originalname, mime_type: file.mimetype });
      uploadedAttachments.push({ attachment, file });
    }
    const info = await db.prepare(`INSERT INTO reimbursements (user_id, amount, currency, category, description, expense_date, receipt_path, receipt_paths, receipt_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.session.userId, amount, String(req.body.currency || 'INR').trim().toUpperCase(), category, description, expenseDate, receiptPaths[0] || null, receiptPaths.length ? JSON.stringify(receiptPaths) : null, receiptMeta.length ? JSON.stringify(receiptMeta) : null);
    for (const { attachment, file } of uploadedAttachments) {
      await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type, uploaded_by, reimbursement_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(attachment.fileId, attachment.messageId, file.originalname, file.mimetype, req.session.userId, info.lastInsertRowid);
    }
    await logActivity(req, 'Reimbursement added', 'reimbursement', info.lastInsertRowid, `${amount} ${String(req.body.currency || 'INR').trim().toUpperCase()} - ${category}`, req.session.userId);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement creation failed');
  }
});

router.put('/:id(\\d+)', upload.array('receipt', 10), async (req, res) => {
  try {
    const claim = await db.prepare('SELECT * FROM reimbursements WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Expense not found.' });
    if (Number(claim.user_id) !== Number(req.session.userId)) return res.status(403).json({ error: 'You can only edit your own expenses.' });
    if (claim.status !== 'submitted') return res.status(409).json({ error: 'Expenses can only be edited before the first approval.' });

    const amount = Number(req.body.amount);
    const currency = String(req.body.currency || claim.currency || 'INR').trim().toUpperCase();
    const category = String(req.body.category || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !currency || !category || !expenseDate || !description) {
      return res.status(400).json({ error: 'Amount, currency, category, date, and description are required.' });
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
    for (const [index, file] of (req.files || []).entries()) {
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 350));
      const attachment = await uploadToTelegram(file);
      await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type, uploaded_by, reimbursement_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(attachment.fileId, attachment.messageId, file.originalname, file.mimetype, req.session.userId, claim.id);
      receiptPaths.push(`telegram:${attachment.fileId}`);
      receiptMeta.push({ original_name: file.originalname, mime_type: file.mimetype });
    }

    const updated = await db.prepare(`UPDATE reimbursements
      SET amount = ?, currency = ?, category = ?, description = ?, expense_date = ?,
          receipt_path = ?, receipt_paths = ?, receipt_meta = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status = 'submitted'`)
      .run(amount, currency, category, description, expenseDate, receiptPaths[0] || null,
        receiptPaths.length ? JSON.stringify(receiptPaths) : null,
        receiptMeta.length ? JSON.stringify(receiptMeta) : null,
        req.params.id, req.session.userId);
    if (!updated.changes) return res.status(409).json({ error: 'This expense is no longer editable.' });
    await logActivity(req, 'Reimbursement updated', 'reimbursement', req.params.id, `${amount} ${currency} - ${category}`, req.session.userId);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement update failed');
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const claim = await db.prepare('SELECT user_id, amount, currency, category FROM reimbursements WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Expense not found.' });
    await logActivity(req, 'Reimbursement deleted', 'reimbursement', req.params.id, `${claim.amount} ${claim.currency} - ${claim.category}`, claim.user_id);
    await db.prepare('DELETE FROM reimbursements WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement deletion failed');
  }
});

router.put('/bulk-status', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one reimbursement.' });
  try {
    const access = await getAccess(req);
    if (!access.approval_level) return res.status(403).json({ error: 'You do not have reimbursement approval access.' });
    const updated = [];
    for (const id of ids) {
      const claim = await db.prepare('SELECT user_id, status, amount, currency, category FROM reimbursements WHERE id = ?').get(id);
      if (!claim) continue;
      if (req.session.role !== 'admin' && ((access.approval_level === 1 && claim.status !== 'submitted') || (access.approval_level >= 2 && claim.status !== 'approved_level_1'))) {
        return res.status(400).json({ error: `Reimbursement ${id} is not waiting for your approval stage.` });
      }
      const nextStatus = access.approval_level === 1 && req.session.role !== 'admin' ? 'approved_level_1' : 'approved';
      await db.prepare(`UPDATE reimbursements SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(nextStatus, id);
      const activityStatus = nextStatus === 'approved_level_1' ? 'approved (level 1)' : 'approved';
      await logActivity(req, `Reimbursement ${activityStatus}`, 'reimbursement', id, `${claim.amount} ${claim.currency} - ${claim.category}`, claim.user_id);
      updated.push(id);
    }
    res.json({ ok: true, updated: updated.length });
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
    const claim = await db.prepare('SELECT user_id, status, amount, currency, category FROM reimbursements WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });
    if (status === 'rejected') {
      if (claim.status === 'paid') return res.status(400).json({ error: 'A paid claim cannot be rejected.' });
    } else if (status === 'approved' && req.session.role !== 'admin') {
      if (access.approval_level === 1 && claim.status !== 'submitted') return res.status(400).json({ error: 'This claim is not waiting for level 1 approval.' });
      if (access.approval_level >= 2 && claim.status !== 'approved_level_1') return res.status(400).json({ error: 'This claim must be approved by level 1 first.' });
    } else if (status === 'paid') {
      if (!access.can_pay || claim.status !== 'approved') return res.status(403).json({ error: 'Only the final payer can mark an approved claim as paid.' });
    }
    const nextStatus = status === 'approved' && access.approval_level === 1 && req.session.role !== 'admin' ? 'approved_level_1' : status;
    await db.prepare(`UPDATE reimbursements SET status = ?, admin_note = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(nextStatus, String(req.body.admin_note || '').trim(), req.params.id);
    const activityStatus = nextStatus === 'approved_level_1' ? 'approved (level 1)' : nextStatus;
    await logActivity(req, `Reimbursement ${activityStatus}`, 'reimbursement', req.params.id, `${claim.amount} ${claim.currency} - ${claim.category}`, claim.user_id);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Reimbursement status update failed');
  }
});

router.canAccessClaim = canAccessClaim;
module.exports = router;
