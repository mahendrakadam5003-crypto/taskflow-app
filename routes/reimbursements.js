const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { logActivity } = require('../audit');
const { requireAuth, requireAdmin } = require('./auth');
const { uploadToTelegram, streamFromTelegram } = require('../telegram-storage');

const router = express.Router();
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

function csvValue(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
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

router.get('/', async (req, res) => {
  try {
    const rows = await getReimbursementRows(req);
    res.json(await Promise.all(rows.map(mapRow)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipts/:fileId', async (req, res) => {
  try {
    const claim = await db.prepare('SELECT user_id FROM reimbursements WHERE receipt_path = ? OR receipt_paths LIKE ?').get(`telegram:${req.params.fileId}`, `%telegram:${req.params.fileId}%`);
    if (!claim) return res.status(404).json({ error: 'Receipt not found.' });
    const access = await getAccess(req);
    if (req.session.role !== 'admin' && Number(claim.user_id) !== Number(req.session.userId) && !access.approval_level) {
      return res.status(403).json({ error: 'You do not have access to this receipt.' });
    }
    const attachment = await db.prepare('SELECT original_name, mime_type FROM telegram_attachments WHERE file_id = ? ORDER BY id DESC LIMIT 1').get(req.params.fileId);
    await streamFromTelegram(req.params.fileId, res, { originalName: attachment?.original_name });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    for (const file of req.files || []) {
      try {
        const attachment = await uploadToTelegram(file);
        await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type) VALUES (?, ?, ?, ?)').run(attachment.fileId, attachment.messageId, file.originalname, file.mimetype);
        receiptPaths.push(`telegram:${attachment.fileId}`);
      } catch (telegramError) {
        const extension = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
        const localName = `${crypto.randomUUID()}${extension}`;
        fs.writeFileSync(path.join(receiptsDir, localName), file.buffer);
        receiptPaths.push(localName);
        console.warn(`Telegram receipt upload failed; stored ${localName} locally:`, telegramError.message);
      }
      receiptMeta.push({ original_name: file.originalname, mime_type: file.mimetype });
    }
    const info = await db.prepare(`INSERT INTO reimbursements (user_id, amount, currency, category, description, expense_date, receipt_path, receipt_paths, receipt_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.session.userId, amount, String(req.body.currency || 'INR').trim().toUpperCase(), category, description, expenseDate, receiptPaths[0] || null, receiptPaths.length ? JSON.stringify(receiptPaths) : null, receiptMeta.length ? JSON.stringify(receiptMeta) : null);
    await logActivity(req, 'Reimbursement added', 'reimbursement', info.lastInsertRowid, `${amount} ${String(req.body.currency || 'INR').trim().toUpperCase()} - ${category}`, req.session.userId);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
