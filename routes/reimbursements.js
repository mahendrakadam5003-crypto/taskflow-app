const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const receiptsDir = path.join(__dirname, '..', 'uploads', 'receipts');
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: receiptsDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image\/|application\/pdf$)/i.test(file.mimetype))
});

function mapRow(row) {
  return {
    ...row,
    receipt_url: row.receipt_path && fs.existsSync(path.join(receiptsDir, row.receipt_path)) ? `/uploads/receipts/${row.receipt_path}` : null,
    receipt_expired: !!(row.receipt_path && !fs.existsSync(path.join(receiptsDir, row.receipt_path)))
  };
}

async function getAccess(req) {
  if (req.session.role === 'admin') return { approval_level: 2, can_pay: 1 };
  return await db.prepare('SELECT approval_level, can_pay FROM reimbursement_access WHERE user_id = ?').get(req.session.userId) || { approval_level: 0, can_pay: 0 };
}

router.get('/', async (req, res) => {
  try {
    const { status, from, to, user_id } = req.query;
    let sql = `SELECT r.*, u.name AS user_name, u.department FROM reimbursements r JOIN users u ON u.id = r.user_id WHERE 1=1`;
    const params = [];
    const access = await getAccess(req);
    if (req.session.role !== 'admin' && !access.approval_level) { sql += ' AND r.user_id = ?'; params.push(req.session.userId); }
    if (status) { sql += ' AND r.status = ?'; params.push(status); }
    if (from) { sql += ' AND r.expense_date >= ?'; params.push(from); }
    if (to) { sql += ' AND r.expense_date <= ?'; params.push(to); }
    if (user_id && req.session.role === 'admin') { sql += ' AND r.user_id = ?'; params.push(user_id); }
    sql += ' ORDER BY r.expense_date DESC, r.created_at DESC';
    const rows = await db.prepare(sql).all(...params);
    res.json(rows.map(mapRow));
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
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Amount, category, and expense date are required.' });
    }
    const info = await db.prepare(`INSERT INTO reimbursements (user_id, amount, currency, category, description, expense_date, receipt_path) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.session.userId, amount, String(req.body.currency || 'INR').trim().toUpperCase(), category, description, expenseDate, req.file ? path.basename(req.file.path) : null);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/status', async (req, res) => {
  const status = String(req.body.status || '').trim().toLowerCase();
  if (!['approved', 'rejected', 'paid'].includes(status)) return res.status(400).json({ error: 'Invalid reimbursement status.' });
  try {
    const access = await getAccess(req);
    if (!access.approval_level) return res.status(403).json({ error: 'You do not have reimbursement approval access.' });
    const claim = await db.prepare('SELECT status FROM reimbursements WHERE id = ?').get(req.params.id);
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
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
