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
const { logActivity } = require('../audit');
const { uploadToTelegram } = require('../telegram-storage');

const router = express.Router();
router.use(requireAuth);

function formatStorageUsage(totalBytes, usedBytes, source = 'turso') {
  const total = Number(totalBytes) || 0;
  const used = Math.min(total, Math.max(0, Number(usedBytes) || 0));
  const free = Math.max(0, total - used);
  const percentUsed = total ? (used / total) * 100 : 0;
  const toGB = (bytes) => Number((bytes / (1024 ** 3)).toFixed(2));

  return {
    total_bytes: total,
    used_bytes: used,
    free_bytes: free,
    total_gb: toGB(total),
    used_gb: toGB(used),
    free_gb: toGB(free),
    percent_used: Number(percentUsed.toFixed(1)),
    available: total > 0,
    source
  };
}

function parseStorageLimit(value) {
  if (typeof value === 'number') return value;
  const match = String(value || '').trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return 0;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Number(match[1]) * (units[String(match[2] || 'b').toLowerCase()] || 1);
}

async function getDatabaseStorageBytes() {
  const pageCount = await db.prepare('PRAGMA page_count').get();
  const pageSize = await db.prepare('PRAGMA page_size').get();
  const pages = Number(pageCount?.page_count ?? pageCount?.PAGE_COUNT ?? 0);
  const size = Number(pageSize?.page_size ?? pageSize?.PAGE_SIZE ?? 0);
  return pages * size;
}

function getLocalStorageUsage() {
  const { bavail, bsize, blocks } = fs.statfsSync(__dirname);
  const totalBytes = Number(blocks) * Number(bsize);
  const freeBytes = Number(bavail) * Number(bsize);
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return formatStorageUsage(totalBytes, usedBytes, 'local');
}

async function getStorageUsage() {
  const platformToken = process.env.TURSO_PLATFORM_TOKEN;
  if (!platformToken) return getLocalStorageUsage();

  try {
    const headers = { Authorization: `Bearer ${platformToken}` };
    let organization = process.env.TURSO_ORG;
    let organizationRecord = null;
    if (!organization || /^\d+$/.test(organization)) {
      const organizationsResponse = await axios.get('https://api.turso.tech/v1/organizations', { headers });
      const organizations = Array.isArray(organizationsResponse.data) ? organizationsResponse.data : [];
      organizationRecord = organizations.find(item => item.type === 'team') || organizations[0];
      organization = organizationRecord?.slug;
    }
    if (!organization) throw new Error('No Turso organization slug was found for this token');

    const databasesResponse = await axios.get(`https://api.turso.tech/v1/organizations/${encodeURIComponent(organization)}/databases`, { headers });
    const databases = Array.isArray(databasesResponse.data?.databases) ? databasesResponse.data.databases : [];
    const requestedDatabase = process.env.TURSO_DATABASE || 'taskflow-db-mahendrakadam5003-crypto';
    const database = databases.find(item => [item.Name, item.name, item.Hostname, item.hostname].includes(requestedDatabase))
      || databases.find(item => String(item.Hostname || item.hostname || '').startsWith(`${requestedDatabase}.`))
      || (databases.length === 1 ? databases[0] : null);
    const databaseName = database?.Name || database?.name;
    if (!databaseName) throw new Error(`No matching Turso database found for ${requestedDatabase}`);

    const [databaseResponse, organizationResponse, configurationResponse, plansResponse] = await Promise.all([
      axios.get(`https://api.turso.tech/v1/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(databaseName)}/usage`, { headers }),
      axios.get(`https://api.turso.tech/v1/organizations/${encodeURIComponent(organization)}/usage`, { headers }),
      axios.get(`https://api.turso.tech/v1/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(databaseName)}/configuration`, { headers }),
      axios.get(`https://api.turso.tech/v1/organizations/${encodeURIComponent(organization)}/plans`, { headers })
    ]);
    const databaseUsage = databaseResponse.data?.database || {};
    const organizationUsage = organizationResponse.data?.organization || {};
    const databaseTotal = databaseUsage.total || databaseUsage.usage || {};
    const matchingOrganizationDatabase = (organizationUsage.databases || []).find(item => item.name === databaseName || item.Name === databaseName);
    const organizationDatabaseTotal = matchingOrganizationDatabase?.total || matchingOrganizationDatabase?.usage || {};
    const usedBytes = databaseTotal.storage_bytes ?? databaseTotal.storageBytes ?? organizationDatabaseTotal.storage_bytes ?? organizationDatabaseTotal.storageBytes;
    const organizationLimit = organizationUsage.usage?.storage_bytes ?? organizationUsage.usage?.storageBytes ?? organizationUsage.usage?.storage;
    const databaseLimit = configurationResponse.data?.size_limit ?? configurationResponse.data?.sizeLimit;
    const plans = Array.isArray(plansResponse.data?.plans) ? plansResponse.data.plans : [];
    const planId = String(organizationRecord?.plan_id || '').toLowerCase();
    const plan = plans.find(item => String(item.name || item.id || '').toLowerCase() === planId);
    const planLimit = plan?.quotas?.storage ?? plan?.quotas?.storage_bytes ?? plan?.quotas?.storageBytes;
    const documentedPlanLimits = {
      free: 5 * (1024 ** 3),
      starter: 5 * (1024 ** 3),
      developer: 9 * (1024 ** 3),
      scaler: 24 * (1024 ** 3),
      pro: 50 * (1024 ** 3)
    };
    const actualDatabaseBytes = await getDatabaseStorageBytes();
    const planFallback = documentedPlanLimits[planId]
      || (/free|starter/i.test(planId) ? documentedPlanLimits.starter : 0);
    const quotaCandidates = [organizationLimit, databaseLimit, planLimit]
      .map(value => typeof value === 'number' ? value : parseStorageLimit(value))
      .filter(value => value >= 1024 ** 2 && value >= actualDatabaseBytes);
    const totalBytes = quotaCandidates[0] || planFallback;
    if (Number.isFinite(Number(usedBytes)) && Number.isFinite(Number(totalBytes))) {
      return formatStorageUsage(totalBytes, Math.max(Number(usedBytes) || 0, actualDatabaseBytes));
    }
    throw new Error('Turso usage response did not include storage values');
  } catch (error) {
    console.error('Turso storage usage unavailable:', error.response?.data?.error || error.message);
    return getLocalStorageUsage();
  }
}

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
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
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
    const messageId = telegramRes.data.result.message_id;
    await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type) VALUES (?, ?, ?, ?)').run(fileId, messageId, req.file.originalname, req.file.mimetype);

    res.status(200).json({ 
      success: true, 
      fileId: fileId, 
      messageId: messageId,
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
    const attachment = await db.prepare('SELECT original_name, mime_type FROM telegram_attachments WHERE file_id = ? ORDER BY id DESC LIMIT 1').get(fileId);
    const filename = attachment?.original_name || path.basename(filePath) || 'attachment';
    const contentType = attachment?.mime_type || response.headers['content-type'];
    res.setHeader('Content-Disposition', `attachment; filename="${String(filename).replace(/["\r\n]/g, '_')}"`);
    if (contentType) res.setHeader('Content-Type', contentType);
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

router.get('/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const projectRows = await db.prepare(`SELECT DISTINCT p.id, p.name
      FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
      WHERE ? = 'admin' OR p.created_by = ? OR pm.user_id = ? ORDER BY p.name`).all(req.session.role, req.session.userId, req.session.userId);
    const taskRows = await db.prepare(`SELECT t.project_id, t.due_date
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'open' AND (? = 'admin' OR p.created_by = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))`)
      .all(req.session.role, req.session.userId, req.session.userId);
    const today = new Date().toISOString().slice(0, 10);
    const projects = projectRows.map(project => {
      const projectTasks = taskRows.filter(task => Number(task.project_id) === Number(project.id));
      return { ...project, open_tasks: projectTasks.length, overdue_tasks: projectTasks.filter(task => task.due_date && task.due_date < today).length };
    });
    const reimbursementWhere = req.session.role === 'admin' ? '' : ' AND user_id = ?';
    const reimbursementParams = reimbursementWhere ? [req.session.userId] : [];
    const reimbursement = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
      FROM reimbursements WHERE status IN ('submitted', 'approved_level_1')${reimbursementWhere}`).get(...reimbursementParams);
    res.json({
      projects,
      open_tasks: taskRows.length,
      overdue_tasks: taskRows.filter(task => task.due_date && task.due_date < today).length,
      pending_reimbursements: Number(reimbursement?.count || 0),
      pending_reimbursement_amount: Number(reimbursement?.amount || 0),
      storage: req.session.role === 'admin' ? await getStorageUsage() : null
    });
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
    const historyInsert = db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)');
    await historyInsert.run(info.lastInsertRowid, req.session.userId, 'Task created', '', title.trim());
    if (assignee_id) {
      const assignee = await db.prepare('SELECT name FROM users WHERE id=?').get(assignee_id);
      await historyInsert.run(info.lastInsertRowid, req.session.userId, 'Assignee', 'Unassigned', assignee ? assignee.name : String(assignee_id));
    }
    if (due_date) await historyInsert.run(info.lastInsertRowid, req.session.userId, 'Due date', '', due_date);
    await logActivity(req, 'Task added', 'task', info.lastInsertRowid, title.trim(), assignee_id || req.session.userId);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/tasks/:id', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const taskBefore = await db.prepare('SELECT title, description, status, assignee_id, due_date FROM tasks WHERE id=?').get(req.params.id);
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
    const historyRows = [];
    const trackChange = (field, oldValue, newValue) => {
      const oldText = oldValue == null ? '' : String(oldValue);
      const newText = newValue == null ? '' : String(newValue);
      if (oldText !== newText) historyRows.push([req.params.id, req.session.userId, field, oldText, newText]);
    };
    if (req.body.title !== undefined) trackChange('Title', taskBefore.title, String(req.body.title).trim());
    if (req.body.description !== undefined && String(taskBefore.description || '').trim()) {
      trackChange('Description', taskBefore.description, String(req.body.description));
    }
    if (req.body.due_date !== undefined) trackChange('Due date', taskBefore.due_date, req.body.due_date || null);
    if (req.body.status !== undefined) trackChange('Status', taskBefore.status, req.body.status === 'done' ? 'done' : 'open');
    if (req.body.assignee_id !== undefined) {
      const oldAssignee = taskBefore.assignee_id ? await db.prepare('SELECT name FROM users WHERE id=?').get(taskBefore.assignee_id) : null;
      const newAssignee = req.body.assignee_id ? await db.prepare('SELECT name FROM users WHERE id=?').get(req.body.assignee_id) : null;
      trackChange('Assignee', oldAssignee ? oldAssignee.name : 'Unassigned', newAssignee ? newAssignee.name : 'Unassigned');
    }
    const historyInsert = db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)');
    for (const row of historyRows) await historyInsert.run(...row);
    if (taskBefore && req.body.status !== undefined && taskBefore.status !== (req.body.status === 'done' ? 'done' : 'open')) {
      await logActivity(req, req.body.status === 'done' ? 'Task completed' : 'Task reopened', 'task', req.params.id, taskBefore.title, taskBefore.assignee_id || req.session.userId);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tasks/:id/history', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const rows = await db.prepare(`SELECT h.*, u.name AS actor_name
      FROM task_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE h.task_id = ? ORDER BY h.created_at ASC, h.id ASC`).all(req.params.id);
    res.json(rows || []);
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
      attachment_available: !!(comment.image_path && (comment.image_path.startsWith('/api/download/') || fs.existsSync(path.join(__dirname, '..', comment.image_path.replace(/^\/uploads\//, 'uploads/')))))
    }));
    task.history = await db.prepare(`SELECT h.*, u.name AS actor_name
      FROM task_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE h.task_id = ? ORDER BY h.created_at ASC, h.id ASC`).all(task.id);
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
      return res.status(403).json({ error: 'You do not have access to this task' });
    }
    const body = String(req.body.body || '').trim();
    if (!body && !req.file) return res.status(400).json({ error: 'Write a comment or attach an image.' });
    let imagePath = null;
    if (req.file) {
      const attachment = await uploadToTelegram(req.file);
      await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type) VALUES (?, ?, ?, ?)').run(attachment.fileId, attachment.messageId, req.file.originalname, req.file.mimetype);
      imagePath = `/api/download/${encodeURIComponent(attachment.fileId)}`;
    }
    const info = await db.prepare('INSERT INTO comments (task_id, user_id, body, image_path, attachment_name, attachment_type) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.params.id, req.session.userId, body, imagePath, req.file?.originalname || null, req.file?.mimetype || null);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
