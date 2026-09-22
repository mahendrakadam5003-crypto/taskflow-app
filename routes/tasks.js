const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const stream = require('stream');
const db = require('../db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// ---- UNLIMITED STORAGE PLATFORM CONFIGURATION (VERIFIED) ----
const TELEGRAM_TOKEN = "8892731667:AAESv4N-8E5mSwQKZ-OvDyCDpTFyAAIY4MU"; 
const CHANNEL_ID = "-1003299962777"; 

// Hold incoming streams in memory RAM temporarily instead of writing to Local Disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // Fully supports mixed documents up to 50MB
});

function canAccessProject(projectId, userId, admin = false) {
  if (admin) return true;
  return !!db.prepare(`SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE p.id=? AND (p.created_by=? OR pm.user_id=?)`).get(userId, projectId, userId, userId);
}
function canAccessTask(taskId, userId, admin = false) {
  if (admin) return true;
  const row = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId);
  return row && canAccessProject(row.project_id, userId, false);
}
function requireProjectAccess(req, res, next) {
  const id = Number(req.params.id);
  if (!canAccessProject(id, req.session.userId, req.session.role === 'admin')) return res.status(403).json({ error: 'You are not a member of this project' });
  next();
}

// ---- AUTOMATED UNLIMITED ATTACHMENT MANAGER ----

// 1. Production Upload Controller Route
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    // Stream package assembly for Telegram bot pipeline execution
    const form = new FormData();
    form.append('chat_id', CHANNEL_ID);
    form.append('document', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    // Fire camera snaps, PDFs, or Excel structures to cloud ledger cleanly
    const telegramRes = await axios.post(
      `https://telegram.org{TELEGRAM_TOKEN}/sendDocument`,
      form,
      { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
    );

    const fileId = telegramRes.data.result.document.file_id;

    // Returns tracking fileId pointer directly back to the frontend elements
    res.status(200).json({ 
      success: true, 
      fileId: fileId, 
      name: req.file.originalname 
    });
  } catch (error) {
    console.error("Storage automated interface encountered an error:", error.message);
    res.status(500).json({ error: "Automated cloud distribution upload failed" });
  }
});

// 2. Production Download/Fetch Controller Route
router.get('/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    // Lookup structural path allocation string mapping parameter tags
    const fileInfoRes = await axios.get(`https://telegram.org{TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileInfoRes.data.result.file_path;

    // Secure payload proxy download request execution stream
    const fileUrl = `https://telegram.org{TELEGRAM_TOKEN}/${filePath}`;
    const response = await axios({ method: 'get', url: fileUrl, responseType: 'stream' });

    // Force clean file attachment naming parameter headers back to user browser download prompts
    res.setHeader('Content-Disposition', `attachment; filename="file"`);
    
    // Stream download elements instantly back to worker desktop interface views
    response.data.pipe(res);
  } catch (error) {
    console.error("Storage streaming link extraction failed:", error.message);
    res.status(500).json({ error: "File download stream pipeline failed" });
  }
});


// ---- Projects / collaboration ----
router.get('/projects', (req, res) => {
  const admin = req.session.role === 'admin';
  const rows = admin
    ? db.prepare('SELECT id,name,created_at,(pin_hash IS NOT NULL) AS locked FROM projects ORDER BY created_at').all()
    : db.prepare(`SELECT DISTINCT p.id,p.name,p.created_at,(p.pin_hash IS NOT NULL) AS locked FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id WHERE p.created_by=? OR pm.user_id=? ORDER BY p.created_at`).all(req.session.userId, req.session.userId);
  res.json(rows);
});

router.post('/projects', (req, res) => {
  const { name, pin, member_ids = [] } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const pinHash = pin ? bcrypt.hashSync(String(pin), 10) : null;
  const info = db.prepare('INSERT INTO projects (name,pin_hash,created_by) VALUES (?,?,?)').run(name.trim(), pinHash, req.session.userId);
  db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(info.lastInsertRowid, req.session.userId);
  const ids = Array.isArray(member_ids) ? member_ids : [];
  const add = db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)');
  for (const id of ids) if (Number(id) !== req.session.userId) add.run(info.lastInsertRowid, Number(id));
  res.json({ id: info.lastInsertRowid });
});

router.get('/projects/:id/members', requireProjectAccess, (req, res) => {
  res.json(db.prepare(`SELECT u.id,u.name,u.username,u.role FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? ORDER BY u.name`).all(req.params.id));
});

router.put('/projects/:id/members', (req, res) => {
  const projectAccess = db.prepare('SELECT created_by FROM projects WHERE id=?').get(req.params.id);
  if (!projectAccess || (req.session.role !== 'admin' && Number(projectAccess.created_by) !== req.session.userId)) return res.status(403).json({ error: 'Only the project creator or admin can manage members' });
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number).filter(Boolean) : [];
  const project = db.prepare('SELECT created_by FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  ids.push(Number(project.created_by));
  db.prepare('DELETE FROM project_members WHERE project_id=?').run(req.params.id);
  const add = db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)');
  for (const id of ids) add.run(req.params.id, id);
  res.json({ ok: true });
});

router.post('/projects/:id/unlock', requireProjectAccess, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (!project.pin_hash || bcrypt.compareSync(String(req.body.pin || ''), project.pin_hash)) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong PIN' });
});

router.delete('/projects/:id', requireAdmin, (req, res) => { db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Tasks ----
router.get('/projects/:id/tasks', requireProjectAccess, (req, res) => {
  const assignee = String(req.query.assignee_id || '').trim();
  let sql = `SELECT t.*,u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.project_id=? AND t.status='open'`;
  const params = [req.params.id];
  if (assignee && assignee !== 'all') { sql += ' AND t.assignee_id=?'; params.push(Number(assignee)); }
  sql += ' ORDER BY t.position,t.created_at';
  res.json(db.prepare(sql).all(...params));
});

router.get('/my-tasks', (req, res) => {
  const userId = req.session.userId;
  const sql = `SELECT t.id,t.project_id,t.title,t.description,t.assignee_id,t.due_date,t.status,t.position,t.created_at,
      p.name AS project_name,u.name AS assignee_name
    FROM tasks t JOIN projects p ON p.id=t.project_id
    LEFT JOIN users u ON u.id=t.assignee_id
    LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
    WHERE t.assignee_id=? AND t.status='open' AND (p.created_by=? OR pm.user_id=? OR ?=1)
    ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.created_at`;
  res.json(db.prepare(sql).all(userId, userId, userId, userId, req.session.role === 'admin' ? 1 : 0));
});

router.get('/tasks/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q}%`, admin = req.session.role === 'admin';
  const sql = `SELECT t.id,t.project_id,t.title,t.status,t.due_date,p.name AS project_name,u.name AS assignee_name\n    FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id\n    LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?\n    WHERE (t.title LIKE ? OR t.description LIKE ?) AND (p.created_by=? OR pm.user_id=? OR ?=1)\n    ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 20`;
  res.json(db.prepare(sql).all(req.session.userId, like, like, req.session.userId, req.session.userId, admin ? 1 : 0));
});

router.post('/projects/:id/tasks', requireProjectAccess, (req, res) => {
  const { title, assignee_id, due_date } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
  if (assignee_id && !canAccessProject(req.params.id, Number(assignee_id), false)) return res.status(400).json({ error: 'Assignee must be a project member' });
  const info = db.prepare('INSERT INTO tasks(project_id,title,assignee_id,due_date) VALUES(?,?,?,?)').run(req.params.id, title.trim(), assignee_id || null, due_date || null);
  res.json({ id: info.lastInsertRowid });
});

router.get('/tasks/:id', (req, res) => {
  if (!canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin')) return res.status(403).json({ error: 'You do not have access to this task' });
