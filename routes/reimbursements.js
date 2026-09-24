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

function mapRow(row) {
  const telegramReceipt = row.receipt_path && row.receipt_path.startsWith('telegram:');
  return {
    ...row,
    receipt_url: telegramReceipt
      ? `/api/reimbursements/receipts/${encodeURIComponent(row.receipt_path.slice('telegram:'.length))}`
      : (row.receipt_path && fs.existsSync(path.join(receiptsDir, row.receipt_path)) ? `/uploads/receipts/${row.receipt_path}` : null),
    receipt_expired: !!(row.receipt_path && !telegramReceipt && !fs.existsSync(path.join(receiptsDir, row.receipt_path)))
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
    res.json(rows.map(mapRow));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipts/:fileId', async (req, res) => {
  try {
    const claim = await db.prepare('SELECT user_id FROM reimbursements WHERE receipt_path = ?').get(`telegram:${req.params.fileId}`);
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

router.post('/', upload.single('receipt'), async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const category = String(req.body.category || '').trim();
    const expenseDate = String(req.body.expense_date || '').trim();
    const description = String(req.body.description || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !category || !expenseDate) {
      return res.status(400).json({ error: 'Amount, category, and expense date are required.' });
    }
    let receiptPath = null;
    if (req.file) {
      const attachment = await uploadToTelegram(req.file);
      await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type) VALUES (?, ?, ?, ?)').run(attachment.fileId, attachment.messageId, req.file.originalname, req.file.mimetype);
      receiptPath = `telegram:${attachment.fileId}`;
    }
    const info = await db.prepare(`INSERT INTO reimbursements (user_id, amount, currency, category, description, expense_date, receipt_path) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.session.userId, amount, String(req.body.currency || 'INR').trim().toUpperCase(), category, description, expenseDate, receiptPath);
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
