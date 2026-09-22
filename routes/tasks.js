const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const db = require('../db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// ---- File storage config ----
// Attachments are relayed through a Telegram bot/channel as free file storage.
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in the environment to enable
// uploads/downloads; without them, those two endpoints return a clear error
// instead of silently failing.
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || null;

// Hold incoming streams in memory RAM temporarily instead of writing to Local Disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // Fully supports mixed documents up to 50MB
});
const commentsDir = path.join(__dirname, '..', 'uploads', 'comments');
if (!fs.existsSync(commentsDir)) fs.mkdirSync(commentsDir, { recursive: true });
const commentUpload = multer({
  storage: multer.diskStorage({
    destination: commentsDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//i.test(file.mimetype))
});

async function canAccessProject(projectId, userId, admin = false) {
  if (admin) return true;
  return !!(await db.prepare(`SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE p.id=? AND (p.created_by=? OR pm.user_id=?)`).get(userId, projectId, userId, userId));
}
async function canAccessTask(taskId, userId, admin = false) {
  if (admin) return true;
  const row = await db.prepare('SELECT project_id, assignee_id FROM tasks WHERE id=?').get(taskId);
  if (row && Number(row.assignee_id) === Number(userId)) return true;
  return row && (await canAccessProject(row.project_id, userId, false));
}
async function requireProjectAccess(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!(await canAccessProject(id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You are not a member of this project' });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---- AUTOMATED UNLIMITED ATTACHMENT MANAGER ----

// 1. Production Upload Controller Route
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!TELEGRAM_TOKEN || !CHANNEL_ID) {
      return res.status(503).json({ error: 'File storage is not configured (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID).' });
    }
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const form = new FormData();
    form.append('chat_id', CHANNEL_ID);
    form.append('document', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    const telegramRes = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`,
      form,
      { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
    );

    const fileId = telegramRes.data.result.document.file_id;

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
    if (!TELEGRAM_TOKEN) {
      return res.status(503).json({ error: 'File storage is not configured (missing TELEGRAM_BOT_TOKEN).' });
    }
    const { fileId } = req.params;

    const fileInfoRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = fileInfoRes.data.result.file_path;

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const response = await axios({ method: 'get', url: fileUrl, responseType: 'stream' });

    res.setHeader('Content-Disposition', `attachment; filename="file"`);
    response.data.pipe(res);
  } catch (error) {
    console.error("Storage streaming link extraction failed:", error.message);
    res.status(500).json({ error: "File download stream pipeline failed" });
  }
});

// ---- Projects / collaboration ----
router.get('/projects', async (req, res) => {
  try {
    const admin = req.session.role === 'admin';
    const rows = admin
      ? await db.prepare('SELECT id,name,created_at,(pin_hash IS NOT NULL) AS locked FROM projects ORDER BY created_at').all()
      : await db.prepare(`SELECT DISTINCT p.id,p.name,p.created_at,(p.pin_hash IS NOT NULL) AS locked FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id WHERE p.created_by=? OR pm.user_id=? ORDER BY p.created_at`).all(req.session.userId, req.session.userId);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects', async (req, res) => {
  try {
    const { name, pin, member_ids = [] } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const pinHash = pin ? bcrypt.hashSync(String(pin), 10) : null;
    const info = await db.prepare('INSERT INTO projects (name,pin_hash,created_by) VALUES (?,?,?)').run(name.trim(), pinHash, req.session.userId);
    await db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(info.lastInsertRowid, req.session.userId);
    const ids = Array.isArray(member_ids) ? member_ids : [];
    const add = db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)');
    for (const id of ids) if (Number(id) !== req.session.userId) await add.run(info.lastInsertRowid, Number(id));
    res.json({ id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/members', requireProjectAccess, async (req, res) => {
  try {
    res.json(await db.prepare(`SELECT u.id,u.name,u.username,u.role FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? ORDER BY u.name`).all(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/projects/:id/members', async (req, res) => {
  try {
    const projectAccess = await db.prepare('SELECT created_by FROM projects WHERE id=?').get(req.params.id);
    if (!projectAccess || (req.session.role !== 'admin' && Number(projectAccess.created_by) !== req.session.userId)) return res.status(403).json({ error: 'Only the project creator or admin can manage members' });
    const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number).filter(Boolean) : [];
    ids.push(Number(projectAccess.created_by));
    await db.prepare('DELETE FROM project_members WHERE project_id=?').run(req.params.id);
    const add = db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)');
    for (const id of ids) await add.run(req.params.id, id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/unlock', requireProjectAccess, async (req, res) => {
  try {
    const project = await db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!project.pin_hash || bcrypt.compareSync(String(req.body.pin || ''), project.pin_hash)) return res.json({ ok: true });
    res.status(401).json({ error: 'Wrong PIN' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/:id', requireAdmin, async (req, res) => {
  try {
    await db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Tasks ----
router.get('/projects/:id/tasks', requireProjectAccess, async (req, res) => {
  try {
    const assignee = String(req.query.assignee_id || '').trim();
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || 'open').trim();
    let sql = `SELECT t.*,u.name AS assignee_name,creator.name AS creator_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN users creator ON creator.id=t.created_by WHERE t.project_id=?`;
    const params = [req.params.id];
    if (status !== 'all') { sql += ' AND t.status=?'; params.push(status === 'done' ? 'done' : 'open'); }
    if (assignee && assignee !== 'all') { sql += ' AND t.assignee_id=?'; params.push(Number(assignee)); }
    if (search) {
      const words = search.split(/\s+/).filter(Boolean);
      words.forEach(word => {
        const like = `%${word}%`;
        sql += ' AND (t.title LIKE ? OR t.description LIKE ? OR u.name LIKE ? OR creator.name LIKE ?)';
        params.push(like, like, like, like);
      });
    }
    if (req.query.due_date) { sql += ' AND t.due_date=?'; params.push(req.query.due_date); }
    if (req.query.created_by && req.query.created_by !== 'all') { sql += ' AND t.created_by=?'; params.push(Number(req.query.created_by)); }
    if (req.query.created_on) { sql += ' AND date(t.created_at)=?'; params.push(req.query.created_on); }
    if (req.query.modified_on) { sql += ' AND date(t.updated_at)=?'; params.push(req.query.modified_on); }
    if (req.query.completed_on) { sql += ' AND date(t.completed_at)=?'; params.push(req.query.completed_on); }
    if (search) {
      const exact = `%${search}%`;
      sql += ' ORDER BY CASE WHEN t.title LIKE ? THEN 0 WHEN t.description LIKE ? THEN 1 ELSE 2 END, t.position, t.created_at';
      params.push(exact, exact);
    } else {
      sql += ' ORDER BY t.position,t.created_at';
    }
    res.json(await db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/my-tasks', async (req, res) => {
  try {
    const userId = req.session.userId;
    const sql = `SELECT t.id,t.project_id,t.title,t.description,t.assignee_id,t.due_date,t.status,t.position,t.created_at,
        p.name AS project_name,u.name AS assignee_name
      FROM tasks t JOIN projects p ON p.id=t.project_id
      LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.assignee_id=? AND t.status='open'
      ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.created_at`;
    res.json(await db.prepare(sql).all(userId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tasks/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const words = q.split(/\s+/).filter(Boolean);
    const admin = req.session.role === 'admin';
    const sql = `SELECT t.id,t.project_id,t.title,t.status,t.due_date,p.name AS project_name,u.name AS assignee_name
      FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id
      LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
      WHERE (p.created_by=? OR pm.user_id=? OR ?=1)
      ${words.map(() => 'AND (t.title LIKE ? OR t.description LIKE ? OR u.name LIKE ? OR p.name LIKE ?)').join(' ')}
      ORDER BY CASE WHEN t.title LIKE ? THEN 0 WHEN t.description LIKE ? THEN 1 ELSE 2 END,
        CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 50`;
    const params = [req.session.userId, req.session.userId, req.session.userId, admin ? 1 : 0];
    words.forEach(word => { const like = `%${word}%`; params.push(like, like, like, like); });
    params.push(`%${q}%`, `%${q}%`);
    res.json(await db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects/:id/tasks', requireProjectAccess, async (req, res) => {
  try {
    const { title, description, assignee_id, due_date } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
    if (assignee_id && !(await canAccessProject(req.params.id, Number(assignee_id), false))) return res.status(400).json({ error: 'Assignee must be a project member' });
    const info = await db.prepare('INSERT INTO tasks(project_id,title,description,created_by,assignee_id,due_date) VALUES(?,?,?,?,?,?)').run(req.params.id, title.trim(), String(description || '').trim(), req.session.userId, assignee_id || null, due_date || null);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/tasks/:id', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const updates = [];
    const values = [];
    if (req.body.status !== undefined) { updates.push('status=?'); values.push(req.body.status === 'done' ? 'done' : 'open'); updates.push('completed_at=?'); values.push(req.body.status === 'done' ? new Date().toISOString() : null); }
    if (req.body.title !== undefined) { updates.push('title=?'); values.push(String(req.body.title).trim()); }
    if (req.body.description !== undefined) { updates.push('description=?'); values.push(String(req.body.description)); }
    if (req.body.due_date !== undefined) { updates.push('due_date=?'); values.push(req.body.due_date || null); }
    if (req.body.assignee_id !== undefined) {
      if (req.body.assignee_id && !(await canAccessProject((await db.prepare('SELECT project_id FROM tasks WHERE id=?').get(req.params.id)).project_id, Number(req.body.assignee_id), false))) return res.status(400).json({ error: 'Assignee must be a project member' });
      updates.push('assignee_id=?'); values.push(req.body.assignee_id || null);
    }
    if (!updates.length) return res.json({ ok: true });
    updates.push("updated_at=datetime('now')");
    values.push(req.params.id);
    await db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run(...values);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tasks/:id', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    task.subtasks = await db.prepare('SELECT * FROM subtasks WHERE task_id=? ORDER BY position').all(task.id);
    task.comments = await db.prepare('SELECT c.*,u.name AS user_name FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE task_id=? ORDER BY c.created_at').all(task.id);
    task.comments = task.comments.map(comment => ({
      ...comment,
      attachment_available: !!(comment.image_path && fs.existsSync(path.join(__dirname, '..', comment.image_path.replace(/^\/uploads\//, 'uploads/'))))
    }));
    res.json(task);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tasks/:id', requireAdmin, async (req, res) => {
  try {
    await db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tasks/:id/subtasks', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Subtask title is required.' });
    const info = await db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM subtasks WHERE task_id = ?), 0))')
      .run(req.params.id, title, req.params.id);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/subtasks/:id', async (req, res) => {
  try {
    const subtask = await db.prepare('SELECT task_id FROM subtasks WHERE id=?').get(req.params.id);
    if (!subtask || !(await canAccessTask(subtask.task_id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this subtask' });
    const updates = [];
    const values = [];
    if (req.body.title !== undefined) { updates.push('title=?'); values.push(String(req.body.title).trim()); }
    if (req.body.done !== undefined) { updates.push('done=?'); values.push(req.body.done ? 1 : 0); }
    if (!updates.length) return res.json({ ok: true });
    values.push(req.params.id);
    await db.prepare(`UPDATE subtasks SET ${updates.join(',')} WHERE id=?`).run(...values);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/subtasks/:id', async (req, res) => {
  try {
    const subtask = await db.prepare('SELECT task_id FROM subtasks WHERE id=?').get(req.params.id);
    if (!subtask || !(await canAccessTask(subtask.task_id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this subtask' });
    await db.prepare('DELETE FROM subtasks WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tasks/:id/comments', commentUpload.single('attachment'), async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'You do not have access to this task' });
    }
    const body = String(req.body.body || '').trim();
    if (!body && !req.file) return res.status(400).json({ error: 'Write a comment or attach an image.' });
    const imagePath = req.file ? `/uploads/comments/${path.basename(req.file.path)}` : null;
    const info = await db.prepare('INSERT INTO comments (task_id, user_id, body, image_path) VALUES (?, ?, ?, ?)')
      .run(req.params.id, req.session.userId, body, imagePath);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
