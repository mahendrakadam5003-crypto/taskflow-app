const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { gunzipSync } = require('zlib');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { requireAuth, requireAdmin } = require('./auth');
const { logActivity, notifyActivityRecipients, notifyAdmins } = require('../audit');
const { logRequestEvent, sendInternalError, wrapAsyncRoutes } = require('../http-errors');
const storageProvider = require('../storage-provider');
const { parseMoneyAmount, parsePaymentAmounts } = require('../lib/money');
const { businessDate } = require('../lib/business-date');
const { getPlanUsage, reserveUpload, releaseUpload, requireFeature, StorageLimitError } = require('../limits');
const uploadRateLimit = require('../upload-rate-limit');
const { csvValue } = require('../csv');

const router = express.Router();
wrapAsyncRoutes(router);
router.use(requireAuth);
router.use('/projects/:id', async (req, res, next) => {
  if (req.path === '/unlock') return next();
  if (req.session?.role === 'admin') return next();
  const projectId = Number(req.params.id);
  if (!Number.isSafeInteger(projectId) || projectId < 1) return next();
  const project = await db.prepare('SELECT pin_hash FROM projects WHERE id=?').get(projectId);
  if (!project || !project.pin_hash) return next();
  if (hasUnlockedProject(req, projectId)) return next();
  return res.status(403).json({ error: 'This project is locked. Unlock it with the project PIN first.' });
});
router.use('/tasks/:id', async (req, res, next) => {
  if (req.session?.role === 'admin') return next();
  const taskId = Number(req.params.id);
  if (!Number.isSafeInteger(taskId) || taskId < 1) return next();
  const task = await db.prepare(`SELECT t.project_id, p.pin_hash
    FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(taskId);
  if (!task || !task.pin_hash) return next();
  if (hasUnlockedProject(req, task.project_id)) return next();
  return res.status(403).json({ error: 'This project is locked. Unlock it with the project PIN first.' });
});
router.use('/subtasks/:id', async (req, res, next) => {
  if (req.session?.role === 'admin') return next();
  const subtaskId = Number(req.params.id);
  if (!Number.isSafeInteger(subtaskId) || subtaskId < 1) return next();
  const subtask = await db.prepare(`SELECT t.project_id, p.pin_hash
    FROM subtasks s JOIN tasks t ON t.id=s.task_id JOIN projects p ON p.id=t.project_id WHERE s.id=?`).get(subtaskId);
  if (!subtask || !subtask.pin_hash) return next();
  if (hasUnlockedProject(req, subtask.project_id)) return next();
  return res.status(403).json({ error: 'This project is locked. Unlock it with the project PIN first.' });
});
router.use('/comments/:id', async (req, res, next) => {
  if (req.session?.role === 'admin') return next();
  const commentId = Number(req.params.id);
  if (!Number.isSafeInteger(commentId) || commentId < 1) return next();
  const comment = await db.prepare(`SELECT t.project_id, p.pin_hash
    FROM comments c JOIN tasks t ON t.id=c.task_id JOIN projects p ON p.id=t.project_id WHERE c.id=?`).get(commentId);
  if (!comment || !comment.pin_hash) return next();
  if (hasUnlockedProject(req, comment.project_id)) return next();
  return res.status(403).json({ error: 'This project is locked. Unlock it with the project PIN first.' });
});
const asanaImportProgress = new Map();

// ---- File storage config ----
// Attachments are relayed through a Telegram bot/channel as free file storage.
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in the environment to enable
// uploads/downloads; without them, those two endpoints return a clear error
// instead of silently failing.
const commentUploadTypes = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf']
]);
// Multipart parsing can finish outside the company's request context; re-enter it before the database is used.
function reenterTenant(req, next) {
  return req.companyTenantId === undefined ? next() : db.runWithTenant(req.companyTenantId, () => next());
}

const commentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (commentUploadTypes.get(extension) !== file.mimetype) {
      const error = new Error('Comment attachments must be JPEG, PNG, GIF, WebP, or PDF files.');
      error.status = 415;
      error.code = 'UNSUPPORTED_FILE_TYPE';
      return callback(error);
    }
    callback(null, true);
  }
});
const handleCommentUploadError = (req, res, next) => {
  commentUpload.single('attachment')(req, res, error => {
    if (!error) return reenterTenant(req, next);
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Comment attachments cannot exceed 10 MB.' });
    if (error.status === 415) return res.status(415).json({ error: error.message });
    return res.status(400).json({ error: 'Unable to receive the comment attachment. Check the file and try again.' });
  });
};
const asanaImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 }
});
const asanaAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5, fieldSize: 8 * 1024 * 1024 }
});
const handleAsanaUploadError = (uploadMiddleware, label) => (req, res, next) => {
  uploadMiddleware(req, res, error => {
    if (!error) return reenterTenant(req, next);
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    const status = tooLarge ? 413 : 400;
    if (!tooLarge) logRequestEvent(req, 'upload_request_rejected', 'warn');
    const message = tooLarge
      ? (label === 'Asana project JSON'
        ? 'Asana project JSON exceeds the 20 MB upload limit after compression. Split the export into smaller projects or reduce its history.'
        : 'An Asana attachment exceeds the 20 MB per-file upload limit. Remove it from the selected folder or reduce its size.')
      : `Unable to receive ${label.toLowerCase()}. Check the selected file and try again.`;
    res.status(status).json({ error: message });
  });
};
const withTenantDatabaseContext = (req, res, next) => {
  const tenantId = req.companyTenantId ?? req.session?.companyId;
  if (tenantId == null) return next(new Error('The company tenant context is missing.'));
  try {
    return db.runWithTenant(tenantId, next);
  } catch (error) {
    return next(error);
  }
};

async function canAccessProject(projectId, userId, admin = false) {
  if (admin) return true;
  return !!(await db.prepare(`SELECT 1 FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=? WHERE p.id=? AND (p.created_by=? OR pm.user_id=?)`).get(userId, projectId, userId, userId));
}
function getUnlockedProjectMap(req) {
  const existing = req.session?.unlocked_projects;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    req.session.unlocked_projects = {};
    return req.session.unlocked_projects;
  }
  const now = Date.now();
  for (const [projectId, expiresAt] of Object.entries(existing)) {
    if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= now) delete existing[projectId];
  }
  req.session.unlocked_projects = existing;
  return existing;
}
function hasUnlockedProject(req, projectId) {
  if (req.session?.role === 'admin') return true;
  const projectIdKey = String(projectId);
  const expiresAt = Number(getUnlockedProjectMap(req)[projectIdKey]);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
async function ensureProjectUnlocked(req, res, projectId) {
  if (req.session?.role === 'admin') return true;
  const project = await db.prepare('SELECT pin_hash FROM projects WHERE id=?').get(projectId);
  if (!project || !project.pin_hash) return true;
  if (hasUnlockedProject(req, projectId)) return true;
  res.status(403).json({ error: 'This project is locked. Unlock it with the project PIN first.' });
  return false;
}
async function canViewPaymentHistory(req) {
  if (req.session.role === 'admin') return true;
  return !!(await db.prepare('SELECT 1 FROM payment_history_access WHERE user_id=?').get(req.session.userId));
}
const PROJECT_ACTIONS = ['create_project', 'edit_project', 'delete_project', 'create_task', 'edit_task', 'delete_task', 'complete_task'];
const PROJECT_ACTION_DEFAULTS = {
  create_project: true,
  edit_project: true,
  delete_project: false,
  create_task: true,
  edit_task: true,
  delete_task: false,
  complete_task: true
};
const INVOICE_TYPES = ['cash', 'gst'];
const projectPinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: req => `${ipKeyGenerator(req.ip)}:project:${req.params.id}`,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many PIN attempts. Please try again later.' }
});
async function canProjectAction(req, action) {
  if (req.session.role === 'admin') return true;
  if (!PROJECT_ACTIONS.includes(action)) return false;
  const row = await db.prepare(`SELECT ${action} AS allowed FROM project_action_access WHERE user_id=?`).get(req.session.userId);
  return row ? Number(row.allowed) === 1 : PROJECT_ACTION_DEFAULTS[action];
}
async function getTaskCheckinStatus(taskId, userId, admin = false) {
  if (admin) return { required: false, checkedIn: true, hasCheckedIn: true };
  const task = await db.prepare('SELECT work_mode FROM tasks WHERE id=?').get(taskId);
  if (!task || task.work_mode !== 'on_field') return { required: false, checkedIn: true, hasCheckedIn: true };
  const required = await db.prepare('SELECT user_id FROM task_checkin_access WHERE user_id=?').get(userId);
  if (!required) return { required: false, checkedIn: true, hasCheckedIn: true };
  const checkin = await db.prepare(`SELECT check_in_at, check_out_at FROM task_checkins
    WHERE task_id=? AND user_id=? ORDER BY id DESC LIMIT 1`).get(taskId, userId);
  return {
    required: true,
    checkedIn: !!checkin?.check_in_at && !checkin.check_out_at,
    hasCheckedIn: !!checkin?.check_in_at
  };
}
async function notifyTaskRelatedPeople(req, taskId, action, details = null) {
  try {
    const task = await db.prepare('SELECT id, title, project_id, created_by, assignee_id FROM tasks WHERE id=?').get(taskId);
    if (!task) return;
    const members = await db.prepare(`SELECT pm.user_id FROM project_members pm
      JOIN users u ON u.id=pm.user_id AND u.active=1 WHERE pm.project_id=?`).all(task.project_id);
    const recipients = [...new Set([
      task.created_by,
      task.assignee_id,
      ...(members || []).map(member => member.user_id)
    ].map(Number).filter(userId => Number.isSafeInteger(userId) && userId > 0
      && userId !== Number(req.session.userId)))];
    const activityId = await logActivity(req, action, 'task', task.id, details || task.title, req.session.userId);
    await notifyActivityRecipients(activityId, recipients);
    await notifyAdmins(req, activityId);
  } catch (error) {
    logRequestEvent(req, 'task_activity_notification_failed', 'warn');
  }
}

function commentSnippet(body) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// @Name mentions of active project members notify those members, even if they are not otherwise recipients.
async function notifyMentionedMembers(req, taskId, body) {
  try {
    if (!body || !String(body).includes('@')) return;
    const task = await db.prepare('SELECT title, project_id FROM tasks WHERE id=?').get(taskId);
    if (!task) return;
    const members = await db.prepare(`SELECT u.id, u.name FROM project_members pm
      JOIN users u ON u.id=pm.user_id AND u.active=1 WHERE pm.project_id=?`).all(task.project_id);
    const lowerBody = String(body).toLowerCase();
    const mentioned = [...new Set((members || [])
      .filter(member => Number(member.id) !== Number(req.session.userId) && member.name
        && lowerBody.includes(`@${String(member.name).toLowerCase()}`))
      .map(member => Number(member.id)))];
    if (!mentioned.length) return;
    const activityId = await logActivity(req, 'Mentioned you in a comment', 'task', taskId, `${task.title}: ${commentSnippet(body)}`);
    await notifyActivityRecipients(activityId, mentioned);
  } catch (error) {
    logRequestEvent(req, 'task_mention_notification_failed', 'warn');
  }
}

async function canChangeTaskWorkMode(req) {
  if (req.session.role === 'admin') return true;
  return !!(await db.prepare('SELECT user_id FROM task_work_mode_access WHERE user_id=?').get(req.session.userId));
}
async function canAccessTask(taskId, userId, admin = false) {
  if (admin) return true;
  const row = await db.prepare('SELECT project_id, assignee_id FROM tasks WHERE id=?').get(taskId);
  if (row && Number(row.assignee_id) === Number(userId)) return true;
  return row && (await canAccessProject(row.project_id, userId, false));
}
async function canAssignTaskToProject(projectId, userId) {
  const normalizedUserId = Number(userId);
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId < 1) return false;
  const activeUser = await db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(normalizedUserId);
  return !!activeUser && canAccessProject(projectId, normalizedUserId, false);
}
async function requireProjectAccess(req, res, next) {
  try {
    await db.ready;
    const id = Number(req.params.id);
    if (!(await canAccessProject(id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You are not a member of this project' });
    if (!(await ensureProjectUnlocked(req, res, id))) return;
    next();
  } catch (err) {
    sendInternalError(res, err, 'Project access check failed');
  }
}
async function requireProjectTaskAccess(req, res, next) {
  try {
    await db.ready;
    const projectId = Number(req.params.id);
    const canViewAllTasks = await canAccessProject(projectId, req.session.userId, req.session.role === 'admin');
    if (!canViewAllTasks) {
      const hasAssignedTask = await db.prepare('SELECT 1 FROM tasks WHERE project_id=? AND assignee_id=? LIMIT 1')
        .get(projectId, req.session.userId);
      if (!hasAssignedTask) return res.status(403).json({ error: 'You do not have access to this project.' });
    }
    if (!(await ensureProjectUnlocked(req, res, projectId))) return;
    req.canViewAllProjectTasks = canViewAllTasks;
    next();
  } catch (err) {
    sendInternalError(res, err, 'Project task access check failed');
  }
}

// ---- ATTACHMENT DOWNLOAD ----
router.get('/download/:fileId', async (req, res) => {
  try {
    if (!storageProvider.isConfigured()) {
      return res.status(503).json({ error: 'File storage is not configured.' });
    }
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid attachment ID.' });
    }
    const attachments = await db.prepare(`SELECT original_name, mime_type, task_id
      FROM telegram_attachments WHERE file_id = ? AND deleted_at IS NULL AND task_id IS NOT NULL ORDER BY id DESC`).all(fileId);
    if (!attachments.length) return res.status(404).json({ error: 'Attachment not found.' });
    let attachment = null;
    let taskExists = false;
    for (const candidate of attachments) {
      const task = await db.prepare('SELECT id FROM tasks WHERE id = ?').get(candidate.task_id);
      if (!task) continue;
      taskExists = true;
      if (await canAccessTask(candidate.task_id, req.session.userId, req.session.role === 'admin')) {
        attachment = candidate;
        break;
      }
    }
    if (!taskExists) return res.status(404).json({ error: 'Attachment not found.' });
    if (!attachment) return res.status(403).json({ error: 'You do not have access to this attachment.' });

    await storageProvider.stream(fileId, res, {
      originalName: attachment.original_name,
      mimeType: attachment.mime_type,
      disposition: 'attachment'
    });
  } catch (error) {
    logRequestEvent(req, 'attachment_download_failed');
    sendInternalError(res, error, 'File download failed');
  }
});

// ---- Projects / collaboration ----
router.get('/projects', async (req, res) => {
  try {
    const admin = req.session.role === 'admin';
    const rows = admin
      ? await db.prepare('SELECT id,name,created_at,(pin_hash IS NOT NULL) AS locked,show_billing,show_work_location,show_description,allow_comments,show_activity,allow_checkin FROM projects ORDER BY created_at').all()
      : await db.prepare(`SELECT DISTINCT p.id,p.name,p.created_at,(p.pin_hash IS NOT NULL) AS locked,p.show_billing,p.show_work_location,p.show_description,p.allow_comments,p.show_activity,p.allow_checkin FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id WHERE p.created_by=? OR pm.user_id=? ORDER BY p.created_at`).all(req.session.userId, req.session.userId);
    res.json(rows);
  } catch (err) { sendInternalError(res, err, 'Project list failed'); }
});

router.get('/dashboard/summary', requireAuth, async (req, res) => {
  try {
    const projectRows = await db.prepare(`SELECT DISTINCT p.id, p.name
      FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
      WHERE ? = 'admin' OR p.created_by = ? OR pm.user_id = ?
        OR EXISTS (SELECT 1 FROM tasks assigned WHERE assigned.project_id = p.id AND assigned.assignee_id = ?)
      ORDER BY p.name`).all(req.session.role, req.session.userId, req.session.userId, req.session.userId);
    const taskRows = await db.prepare(`SELECT t.project_id, t.due_date
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE COALESCE(t.status, 'open') <> 'done'
        AND (? = 'admin' OR p.created_by = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) OR t.assignee_id = ?)`)
      .all(req.session.role, req.session.userId, req.session.userId, req.session.userId);
    const projectTaskCounts = await db.prepare(`SELECT t.project_id, COUNT(*) AS total_tasks,
        SUM(CASE WHEN COALESCE(t.status, 'open') = 'done' THEN 1 ELSE 0 END) AS completed_tasks
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE ? = 'admin' OR p.created_by = ?
        OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?)
        OR t.assignee_id = ?
      GROUP BY t.project_id`)
      .all(req.session.role, req.session.userId, req.session.userId, req.session.userId);
    const projectTaskCountsById = new Map(projectTaskCounts.map(project => [Number(project.project_id), project]));
    const today = businessDate();
    const projects = projectRows.map(project => {
      const projectTasks = taskRows.filter(task => Number(task.project_id) === Number(project.id));
      const counts = projectTaskCountsById.get(Number(project.id)) || { total_tasks: 0, completed_tasks: 0 };
      return {
        ...project,
        open_tasks: projectTasks.length,
        overdue_tasks: projectTasks.filter(task => task.due_date && task.due_date < today).length,
        total_tasks: Number(counts.total_tasks) || 0,
        completed_tasks: Number(counts.completed_tasks) || 0
      };
    });
    const reimbursementWhere = req.session.role === 'admin' ? '' : ' AND user_id = ?';
    const reimbursementParams = reimbursementWhere ? [req.session.userId] : [];
    const reimbursement = await db.prepare(`SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(amount), 0), 2) AS amount
      FROM reimbursements WHERE status IN ('submitted', 'approved_level_1')${reimbursementWhere}`).get(...reimbursementParams);
    const checkinVisibility = req.session.role === 'admin' ? '' : `AND c.user_id = ?
      AND (p.created_by = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) OR t.assignee_id = ?)`;
    const checkinParams = [today, today];
    if (req.session.role !== 'admin') checkinParams.push(req.session.userId, req.session.userId, req.session.userId, req.session.userId);
    const checkinTasks = await db.prepare(`SELECT DISTINCT t.id, t.project_id, t.title
      FROM task_checkins c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id
      WHERE (date(c.check_in_at, '+5 hours', '+30 minutes') = ? OR date(c.check_out_at, '+5 hours', '+30 minutes') = ?)
        ${checkinVisibility}
      ORDER BY t.title COLLATE NOCASE, t.id`).all(...checkinParams);
    const activeTask = await db.prepare(`SELECT t.id, t.project_id, t.title, t.customer_name, p.name AS project_name
      FROM task_checkins c JOIN tasks t ON t.id=c.task_id JOIN projects p ON p.id=t.project_id
      WHERE c.user_id=? AND c.check_in_at IS NOT NULL AND c.check_out_at IS NULL
      ORDER BY c.check_in_at DESC LIMIT 1`).get(req.session.userId);
    const paymentAccess = await canViewPaymentHistory(req);
    const paymentAlerts = paymentAccess ? await db.prepare(`SELECT t.id, t.invoice_number, t.invoice_date, t.customer_name, t.total_amount, t.amount_received, p.name AS project_name
      FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE COALESCE(t.no_billing_required, 0)=0
        AND t.invoice_number IS NOT NULL AND trim(t.invoice_number) <> ''
        AND t.invoice_date IS NOT NULL AND trim(t.invoice_date) <> ''
        AND COALESCE(t.payment_status, 'not_received') <> 'received'
        AND t.invoice_date IS NOT NULL AND date(t.invoice_date, '+30 days') < ?
      ORDER BY t.invoice_date ASC`).all(today) : [];
    const planUsage = req.session.role === 'admin' ? await getPlanUsage(req) : null;
    const storageUsage = planUsage?.usage;
    const storageLimit = planUsage?.plan?.storageLimitBytes ?? null;
    res.json({
      projects,
      open_tasks: taskRows.length,
      overdue_tasks: taskRows.filter(task => task.due_date && task.due_date < today).length,
      pending_reimbursements: Number(reimbursement?.count || 0),
      pending_reimbursement_amount: Number(reimbursement?.amount || 0),
      checkin_task_count: checkinTasks.length,
      checkin_tasks: checkinTasks,
      active_task: activeTask || null,
      payment_alert_count: paymentAlerts.length,
      payment_alerts: paymentAlerts.map(row => ({ ...row, pending_amount: Math.round(Math.max(0, Number(row.total_amount || 0) - Number(row.amount_received || 0)) * 100) / 100 })),
      storage: req.session.role === 'admin' && storageUsage ? {
        total_bytes: storageLimit ?? 0,
        used_bytes: storageUsage.storageBytes,
        free_bytes: storageLimit === null ? null : Math.max(0, storageLimit - storageUsage.storageBytes),
        total_gb: storageLimit === null ? null : Number((storageLimit / (1024 ** 3)).toFixed(2)),
        used_gb: Number((storageUsage.storageBytes / (1024 ** 3)).toFixed(2)),
        free_gb: storageLimit === null ? null : Number((Math.max(0, storageLimit - storageUsage.storageBytes) / (1024 ** 3)).toFixed(2)),
        percent_used: storageUsage.percentUsed,
        available: storageLimit !== null,
        unlimited: storageLimit === null,
        source: 'company'
      } : null
    });
  } catch (err) { sendInternalError(res, err, 'Dashboard summary failed'); }
});

router.get('/payment-history/access/me', async (req, res) => {
  try {
    res.json({ allowed: await canViewPaymentHistory(req) });
  } catch (error) {
    sendInternalError(res, error, 'Payment-history access lookup failed');
  }
});

router.get('/payment-history/access', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT u.id AS user_id, u.name, u.username,
      CASE WHEN pha.user_id IS NULL THEN 0 ELSE 1 END AS allowed
      FROM users u LEFT JOIN payment_history_access pha ON pha.user_id=u.id
      WHERE u.active=1 ORDER BY u.name`).all();
    res.json(rows);
  } catch (error) {
    sendInternalError(res, error, 'Payment-history access list failed');
  }
});

router.put('/payment-history/access/:userId', requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user.' });
    const target = await db.prepare('SELECT id, active FROM users WHERE id = ?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (req.body.allowed && Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot grant payment-history access to an inactive user.' });
    if (req.body.allowed) {
      await db.prepare('INSERT OR REPLACE INTO payment_history_access (user_id, granted_by) VALUES (?, ?)').run(userId, req.session.userId);
    } else {
      await db.prepare('DELETE FROM payment_history_access WHERE user_id=?').run(userId);
    }
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Payment-history access update failed');
  }
});

router.get('/payment-history', async (req, res) => {
  if (!(await canViewPaymentHistory(req))) return res.status(403).json({ error: 'You do not have payment-history access.' });
  const params = [];
  const invoiceCondition = `t.invoice_number IS NOT NULL AND trim(t.invoice_number) <> ''
    AND t.invoice_date IS NOT NULL AND trim(t.invoice_date) <> ''
    AND COALESCE(t.no_billing_required, 0)=0`;
  const invoiceType = String(req.query.invoice_type || '').trim().toLowerCase();
  if (invoiceType && !INVOICE_TYPES.includes(invoiceType)) return res.status(400).json({ error: 'Invalid invoice type.' });
  let sql = `SELECT t.id, t.project_id, t.title, t.invoice_type, t.invoice_number, t.invoice_date, t.customer_name,
    t.total_amount, t.payment_status, t.payment_received_date, t.amount_received, t.assignee_id, t.asana_assignee_name,
    COALESCE(t.payment_member_id, t.assignee_id) AS payment_member_id,
    p.name AS project_name, member.name AS payment_member_name
    FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN users member ON member.id=COALESCE(t.payment_member_id, t.assignee_id)
    WHERE ${invoiceCondition}`;
  if (req.query.from) { sql += ' AND (t.invoice_date IS NULL OR t.invoice_date >= ?)'; params.push(req.query.from); }
  if (req.query.to) { sql += ' AND (t.invoice_date IS NULL OR t.invoice_date <= ?)'; params.push(req.query.to); }
  if (req.query.status) { sql += ' AND t.payment_status = ?'; params.push(req.query.status); }
  if (req.query.assignee_id) { sql += ' AND COALESCE(t.payment_member_id, t.assignee_id) = ?'; params.push(Number(req.query.assignee_id)); }
  if (invoiceType) { sql += ' AND t.invoice_type = ?'; params.push(invoiceType); }
  sql += " ORDER BY COALESCE(t.invoice_date, '9999-12-31') DESC, t.id DESC";
  if (!req.query.from && !req.query.to) sql += ' LIMIT 25';
  const rows = await db.prepare(sql).all(...params);
  res.json(rows.map(row => ({ ...row, pending_amount: Math.round(Math.max(0, Number(row.total_amount || 0) - Number(row.amount_received || 0)) * 100) / 100 })));
});

router.get('/payment-history/summary', async (req, res) => {
  if (!(await canViewPaymentHistory(req))) return res.status(403).json({ error: 'You do not have payment-history access.' });
  const conditions = [`t.invoice_number IS NOT NULL AND trim(t.invoice_number) <> ''
    AND t.invoice_date IS NOT NULL AND trim(t.invoice_date) <> ''
    AND COALESCE(t.no_billing_required, 0)=0`];
  const params = [];
  const invoiceType = String(req.query.invoice_type || '').trim().toLowerCase();
  if (invoiceType && !INVOICE_TYPES.includes(invoiceType)) return res.status(400).json({ error: 'Invalid invoice type.' });
  if (req.query.from) { conditions.push('(t.invoice_date IS NULL OR t.invoice_date >= ?)'); params.push(req.query.from); }
  if (req.query.to) { conditions.push('(t.invoice_date IS NULL OR t.invoice_date <= ?)'); params.push(req.query.to); }
  if (req.query.assignee_id) { conditions.push('COALESCE(t.payment_member_id, t.assignee_id) = ?'); params.push(Number(req.query.assignee_id)); }
  if (invoiceType) { conditions.push('t.invoice_type = ?'); params.push(invoiceType); }
  if (req.query.status) { conditions.push('t.payment_status = ?'); params.push(req.query.status); }
  const row = await db.prepare(`SELECT COUNT(*) AS invoice_count,
      ROUND(COALESCE(SUM(t.total_amount), 0), 2) AS total_revenue,
      ROUND(COALESCE(SUM(t.amount_received), 0), 2) AS payment_received,
      ROUND(COALESCE(SUM(CASE WHEN t.total_amount > t.amount_received THEN t.total_amount - t.amount_received ELSE 0 END), 0), 2) AS payment_pending,
      ROUND(COALESCE(SUM(CASE WHEN lower(COALESCE(t.invoice_type, 'gst'))='cash' THEN t.total_amount ELSE 0 END), 0), 2) AS cash_revenue,
      ROUND(COALESCE(SUM(CASE WHEN lower(COALESCE(t.invoice_type, 'gst'))='cash' THEN t.amount_received ELSE 0 END), 0), 2) AS cash_received,
      ROUND(COALESCE(SUM(CASE WHEN lower(COALESCE(t.invoice_type, 'gst'))='cash' AND t.total_amount > t.amount_received THEN t.total_amount - t.amount_received ELSE 0 END), 0), 2) AS cash_pending,
      ROUND(COALESCE(SUM(CASE WHEN lower(COALESCE(t.invoice_type, 'gst'))='gst' THEN t.total_amount ELSE 0 END), 0), 2) AS gst_revenue,
      ROUND(COALESCE(SUM(CASE WHEN lower(COALESCE(t.invoice_type, 'gst'))='gst' THEN t.amount_received ELSE 0 END), 0), 2) AS gst_received,
      ROUND(COALESCE(SUM(CASE WHEN lower(COALESCE(t.invoice_type, 'gst'))='gst' AND t.total_amount > t.amount_received THEN t.total_amount - t.amount_received ELSE 0 END), 0), 2) AS gst_pending
    FROM tasks t WHERE ${conditions.join(' AND ')}`).get(...params);
  const amount = key => Number(row?.[key] || 0);
  res.json({
    invoice_count: amount('invoice_count'),
    total_revenue: amount('total_revenue'), payment_received: amount('payment_received'), payment_pending: amount('payment_pending'),
    cash_revenue: amount('cash_revenue'), cash_received: amount('cash_received'), cash_pending: amount('cash_pending'),
    gst_revenue: amount('gst_revenue'), gst_received: amount('gst_received'), gst_pending: amount('gst_pending'),
    from: req.query.from || null, to: req.query.to || null, assignee_id: req.query.assignee_id || null, invoice_type: invoiceType || null, status: req.query.status || null
  });
});

router.put('/payment-history/:id', async (req, res) => {
  if (!(await canViewPaymentHistory(req))) return res.status(403).json({ error: 'You do not have payment-history access.' });
  const status = ['received', 'not_received', 'pending'].includes(req.body.payment_status) ? req.body.payment_status : null;
  if (!status) return res.status(400).json({ error: 'Invalid payment status.' });
  const task = await db.prepare(`SELECT id, project_id, assignee_id, payment_member_id,
      payment_status, payment_received_date, total_amount, amount_received FROM tasks
    WHERE id=? AND COALESCE(no_billing_required, 0)=0
      AND invoice_number IS NOT NULL AND trim(invoice_number) <> ''
      AND invoice_date IS NOT NULL AND trim(invoice_date) <> ''`).get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Invoice task not found.' });
  if (!(await canAccessTask(task.id, req.session.userId, req.session.role === 'admin'))) {
    return res.status(403).json({ error: 'You do not have access to this task.' });
  }
  const paymentAmounts = parsePaymentAmounts(task.total_amount, req.body.amount_received);
  if (!paymentAmounts) return res.status(400).json({ error: 'Received amount must be valid to two decimals and cannot exceed the invoice total.' });
  const memberId = req.body.payment_member_id ? Number(req.body.payment_member_id) : null;
  if (memberId && !(await db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(memberId))) return res.status(400).json({ error: 'Selected member was not found.' });
  const updatedAt = new Date().toISOString();
  await db.prepare('UPDATE tasks SET payment_member_id=?, payment_status=?, payment_received_date=?, amount_received=?, updated_at=? WHERE id=?')
    .run(memberId, status, req.body.payment_received_date || null, paymentAmounts.receivedAmount, updatedAt, req.params.id);
  await logActivity(req, 'Invoice payment updated', 'task', task.id,
    `Status: ${task.payment_status} -> ${status}; received: ${Number(task.amount_received || 0).toFixed(2)} -> ${paymentAmounts.receivedAmount.toFixed(2)}; member: ${task.payment_member_id ?? 'unassigned'} -> ${memberId ?? 'unassigned'}`,
    task.assignee_id || req.session.userId);
  res.json({ ok: true });
});

router.post('/projects', async (req, res) => {
  try {
    if (!(await canProjectAction(req, 'create_project'))) return res.status(403).json({ error: 'You do not have permission to create projects.' });
    const { name, pin, member_ids = [] } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (pin !== undefined && pin !== null && pin !== '' && (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin))) {
      return res.status(400).json({ error: 'Project PIN must contain 4 to 12 digits.' });
    }
    if (!Array.isArray(member_ids)) return res.status(400).json({ error: 'Project member IDs must be an array.' });
    const requestedIds = member_ids.map(Number);
    if (requestedIds.some(id => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ error: 'Every project member must be a valid user ID.' });
    const memberIds = [...new Set([Number(req.session.userId), ...requestedIds])];
    const placeholders = memberIds.map(() => '?').join(',');
    const activeUsers = await db.prepare(`SELECT id FROM users WHERE active=1 AND id IN (${placeholders})`).all(...memberIds);
    if (activeUsers.length !== memberIds.length) return res.status(400).json({ error: 'Project members must be active users.' });
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
    const info = await db.prepare('INSERT INTO projects (name,pin_hash,created_by) VALUES (?,?,?)').run(name.trim(), pinHash, req.session.userId);
    await db.batch(memberIds.map(userId => ({
      sql: 'INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)',
      args: [info.lastInsertRowid, userId]
    })));
    res.json({ id: info.lastInsertRowid });
  } catch (err) { sendInternalError(res, err, 'Project creation failed'); }
});

router.get('/projects/:id/members', requireProjectAccess, async (req, res) => {
  try {
    res.json(await db.prepare(`SELECT u.id, u.name FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? ORDER BY u.name`).all(req.params.id));
  } catch (err) { sendInternalError(res, err, 'Project member list failed'); }
});

router.get('/projects/:id/member-candidates', async (req, res) => {
  const project = await db.prepare('SELECT created_by FROM projects WHERE id=?').get(req.params.id);
  if (!project || (req.session.role !== 'admin' && Number(project.created_by) !== Number(req.session.userId))) {
    return res.status(403).json({ error: 'Only the project creator or an administrator can view member candidates.' });
  }
  const candidates = await db.prepare('SELECT id, name FROM users WHERE active=1 ORDER BY name').all();
  res.json(candidates);
});

router.put('/projects/:id/members', async (req, res) => {
  try {
    const projectAccess = await db.prepare('SELECT created_by FROM projects WHERE id=?').get(req.params.id);
    if (!projectAccess || (req.session.role !== 'admin' && Number(projectAccess.created_by) !== req.session.userId)) return res.status(403).json({ error: 'Only the project creator or admin can manage members' });
    const requestedIds = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number) : [];
    if (requestedIds.some(id => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ error: 'Every project member must be a valid user ID.' });
    const ids = [...new Set([...requestedIds, Number(projectAccess.created_by)])];
    const placeholders = ids.map(() => '?').join(',');
    const activeUsers = await db.prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${placeholders})`).all(...ids);
    if (activeUsers.length !== ids.length) return res.status(400).json({ error: 'Project members must be active users.' });
    const statements = [
      { sql: 'DELETE FROM project_members WHERE project_id = ?', args: [req.params.id] },
      ...ids.map(userId => ({
        sql: 'INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)',
        args: [req.params.id, userId]
      }))
    ];
    await db.batch(statements);
    res.json({ ok: true });
  } catch (err) { sendInternalError(res, err, 'Project member update failed'); }
});

router.get('/project-action-access', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT u.id AS user_id, u.name, u.username, u.role,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.create_project, 1) END AS create_project,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.edit_project, 1) END AS edit_project,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.delete_project, 0) END AS delete_project,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.create_task, 1) END AS create_task,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.edit_task, 1) END AS edit_task,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.delete_task, 0) END AS delete_task,
      CASE WHEN u.role='admin' THEN 1 ELSE COALESCE(paa.complete_task, 1) END AS complete_task
      FROM users u LEFT JOIN project_action_access paa ON paa.user_id=u.id
      WHERE u.active=1 ORDER BY u.name`).all();
    res.json(rows);
  } catch (error) {
    sendInternalError(res, error, 'Project action access list failed');
  }
});

router.get('/project-action-access/me', async (req, res) => {
  try {
    if (req.session.role === 'admin') return res.json(Object.fromEntries(PROJECT_ACTIONS.map(action => [action, true])));
    const row = await db.prepare(`SELECT ${PROJECT_ACTIONS.join(', ')} FROM project_action_access WHERE user_id=?`).get(req.session.userId);
    res.json(Object.fromEntries(PROJECT_ACTIONS.map(action => [action, row ? Number(row[action]) === 1 : PROJECT_ACTION_DEFAULTS[action]])));
  } catch (error) {
    sendInternalError(res, error, 'Current project action access lookup failed');
  }
});

router.get('/admin/data-export', requireFeature('export'), requireAdmin, async (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(format)) return res.status(400).json({ error: 'Choose JSON or CSV export format.' });
    const projects = await db.prepare('SELECT id, name, created_by, asana_gid, created_at FROM projects ORDER BY name, id').all();
    const exportedProjects = [];
    for (const project of projects || []) {
      const [members, taskRows] = await Promise.all([
        db.prepare(`SELECT u.id, u.name, u.username, u.role FROM project_members pm
          JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name`).all(project.id),
        db.prepare(`SELECT t.*, assignee.name AS assignee_name, creator.name AS creator_name
          FROM tasks t LEFT JOIN users assignee ON assignee.id = t.assignee_id
          LEFT JOIN users creator ON creator.id = t.created_by
          WHERE t.project_id = ? ORDER BY t.position, t.id`).all(project.id)
      ]);
      const taskIds = (taskRows || []).map(task => Number(task.id));
      let subtasks = [], comments = [], history = [], checkins = [], attachments = [];
      if (taskIds.length) {
        const placeholders = taskIds.map(() => '?').join(',');
        [subtasks, comments, history, checkins, attachments] = await Promise.all([
          db.prepare(`SELECT * FROM subtasks WHERE task_id IN (${placeholders}) ORDER BY task_id, position, id`).all(...taskIds),
          db.prepare(`SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id IN (${placeholders}) ORDER BY c.created_at, c.id`).all(...taskIds),
          db.prepare(`SELECT h.*, u.name AS actor_name FROM task_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.task_id IN (${placeholders}) ORDER BY h.created_at, h.id`).all(...taskIds),
          db.prepare(`SELECT * FROM task_checkins WHERE task_id IN (${placeholders}) ORDER BY task_id, id`).all(...taskIds),
          db.prepare(`SELECT id, file_id, message_id, original_name, mime_type, uploaded_by, task_id, created_at, deleted_at
            FROM telegram_attachments WHERE task_id IN (${placeholders}) ORDER BY task_id, id`).all(...taskIds)
        ]);
      }
      exportedProjects.push({
        project,
        members: members || [],
        tasks: (taskRows || []).map(task => ({
          task,
          subtasks: (subtasks || []).filter(item => Number(item.task_id) === Number(task.id)),
          comments: (comments || []).filter(item => Number(item.task_id) === Number(task.id)),
          history: (history || []).filter(item => Number(item.task_id) === Number(task.id)),
          checkins: (checkins || []).filter(item => Number(item.task_id) === Number(task.id)),
          attachments: (attachments || []).filter(item => Number(item.task_id) === Number(task.id))
        }))
      });
    }
    const backup = {
      format: 'taskflow-project-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      projects: exportedProjects
    };
    if (format === 'csv') {
      const columns = [
        'project', 'task_id', 'title', 'description', 'status', 'assignee', 'due_date',
        'created_at', 'completed_at', 'invoice_type', 'invoice_number', 'invoice_date',
        'customer_name', 'total_amount', 'amount_received', 'attachment_references'
      ];
      const rows = [columns.map(csvValue).join(',')];
      for (const item of exportedProjects) {
        for (const taskEntry of item.tasks) {
          const task = taskEntry.task;
          rows.push([
            item.project.name, task.id, task.title, task.description, task.status,
            task.assignee_name, task.due_date, task.created_at, task.completed_at,
            task.invoice_type, task.invoice_number, task.invoice_date, task.customer_name,
            task.total_amount, task.amount_received,
            taskEntry.attachments.map(attachment => attachment.original_name || attachment.file_id).join('; ')
          ].map(csvValue).join(','));
        }
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="taskflow-projects-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(rows.join('\r\n'));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="taskflow-projects-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(backup);
  } catch (error) {
    logRequestEvent(req, 'taskflow_data_export_failed');
    sendInternalError(res, error, 'TaskFlow data export failed');
  }
});

router.get('/admin/asana-import/progress/:id', requireAdmin, (req, res) => {
  const now = Date.now();
  for (const [id, progress] of asanaImportProgress) {
    if (now - progress.updated_at > 30 * 60 * 1000) asanaImportProgress.delete(id);
  }
  const progress = asanaImportProgress.get(String(req.params.id || ''));
  if (!progress) return res.status(404).json({ error: 'Import progress not found.' });
  res.json(progress);
});

router.post('/admin/asana-import', requireAdmin, uploadRateLimit, handleAsanaUploadError(asanaImportUpload.array('projects', 20), 'Asana project JSON'), withTenantDatabaseContext, async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Choose one or more Asana project JSON files.' });
  const progressId = String(req.body?.progress_id || '').slice(0, 100);
  let currentProgress = null;
  const updateProgress = (completed, total, message, status = 'processing') => {
    if (!progressId || !currentProgress) return;
    const elapsedSeconds = Math.max(0.1, (Date.now() - currentProgress.started_at) / 1000);
    const completedUnits = Math.max(0, Math.min(total, completed));
    const percent = total ? Math.min(99, Math.floor((completedUnits / total) * 100)) : 0;
    const unitsPerSecond = completedUnits / elapsedSeconds;
    asanaImportProgress.set(progressId, {
      status,
      percent: status === 'complete' ? 100 : percent,
      message,
      eta_seconds: status === 'complete' ? 0 : (unitsPerSecond > 0 ? Math.ceil((total - completedUnits) / unitsPerSecond) : null),
      updated_at: Date.now()
    });
  };

  const users = await db.prepare('SELECT id, name FROM users WHERE active = 1').all();
  const usersByName = new Map();
  for (const user of users || []) {
    const key = String(user.name || '').trim().toLocaleLowerCase();
    if (!key) continue;
    const matches = usersByName.get(key) || [];
    matches.push(Number(user.id));
    usersByName.set(key, matches);
  }
  let unmatchedNames = new Set();
  let sourcePeopleByGid = new Map();
  const getPersonName = person => {
    if (typeof person === 'string') {
      const value = person.trim();
      return sourcePeopleByGid.get(value) || value;
    }
    const name = String(person?.name || person?.full_name || person?.display_name || '').trim();
    return name || sourcePeopleByGid.get(String(person?.gid || '').trim()) || '';
  };
  const mapPerson = person => {
    const name = getPersonName(person);
    if (!name) return null;
    const matchingUserIds = usersByName.get(String(name).trim().toLocaleLowerCase()) || [];
    const userId = matchingUserIds.length === 1 ? matchingUserIds[0] : null;
    if (!userId) unmatchedNames.add(String(name).trim());
    return userId;
  };
  const stripHtml = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const flattenRecords = records => Array.isArray(records) ? records.flat(Infinity) : [];
  const results = [];

  for (const file of files) {
    let projectId = null;
    let projectGid = null;
    let createdProject = false;
    unmatchedNames = new Set();
    try {
      const isCompressed = /\.gz$/i.test(file.originalname) || file.mimetype === 'application/gzip';
      const sourceBuffer = isCompressed
        ? gunzipSync(file.buffer, { maxOutputLength: 64 * 1024 * 1024 })
        : file.buffer;
      const source = JSON.parse(sourceBuffer.toString('utf8').replace(/^\uFEFF/, ''));
      const sourceProject = source.project;
      projectGid = String(sourceProject?.gid || '');
      if (!Array.isArray(source.tasks)) {
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const monthRank = label => {
          const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2})$/i.exec(label);
          return match ? (2000 + Number(match[2])) * 12 + monthNames.indexOf(match[1].toLowerCase()) : Number.NEGATIVE_INFINITY;
        };
        const monthGroups = Object.entries(source)
          .filter(([label, items]) => Array.isArray(items) && Number.isFinite(monthRank(label)))
          .sort(([left], [right]) => monthRank(right) - monthRank(left));
        if (monthGroups.length) source.tasks = monthGroups.flatMap(([, items]) => items);
      }
      if (!projectGid || !sourceProject?.name || !Array.isArray(source.tasks)) {
        throw new Error('Expected an Asana project JSON with project metadata and a tasks array.');
      }
      const countImportUnits = bundle => 1
        + flattenRecords(bundle?.stories).length
        + flattenRecords(bundle?.subtasks).reduce((count, child) => count + countImportUnits(child), 0);
      const totalImportUnits = source.tasks.reduce((count, bundle) => count + countImportUnits(bundle), 0);
      currentProgress = { started_at: Date.now() };
      updateProgress(0, totalImportUnits, `Preparing ${sourceProject.name}...`);
      let completedImportUnits = 0;
      sourcePeopleByGid = new Map();
      const indexPerson = person => {
        if (!person || typeof person !== 'object' || Array.isArray(person)) return;
        const gid = String(person.gid || '').trim();
        const name = String(person.name || person.full_name || person.display_name || '').trim();
        if (gid && name) sourcePeopleByGid.set(gid, name);
      };
      const sourcePersonRecords = records => Array.isArray(records)
        ? records
        : (records && typeof records === 'object' ? Object.values(records) : []);
      [...sourcePersonRecords(source.users), ...sourcePersonRecords(source.people), ...sourcePersonRecords(sourceProject.members)].forEach(indexPerson);
      const indexTaskPeople = bundle => {
        const task = bundle?.task || {};
        [task.created_by, task.assignee, task.owner].forEach(indexPerson);
        flattenRecords(bundle?.stories).forEach(story => indexPerson(story?.created_by));
        flattenRecords(bundle?.subtasks).forEach(indexTaskPeople);
      };
      source.tasks.forEach(indexTaskPeople);
      const duplicate = await db.prepare('SELECT id, name FROM projects WHERE asana_gid = ?').get(projectGid);
      if (duplicate) {
        projectId = Number(duplicate.id);
      } else {
        const projectInfo = await db.prepare('INSERT INTO projects (name, created_by, asana_gid, created_at) VALUES (?, ?, ?, ?)')
          .run(String(sourceProject.name).trim(), req.session.userId, projectGid, sourceProject.created_at || new Date().toISOString());
        projectId = Number(projectInfo.lastInsertRowid);
        createdProject = true;
      }

      await db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(projectId, req.session.userId);
      const memberInsert = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
      for (const member of sourceProject.members || []) {
        const memberId = mapPerson(member);
        if (memberId) await memberInsert.run(projectId, memberId);
      }

      const taskInsert = db.prepare(`INSERT INTO tasks
        (project_id, title, description, no_billing_required, created_by, assignee_id, asana_assignee_name, due_date, status, position, asana_gid, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const subtaskInsert = db.prepare(`INSERT INTO subtasks (task_id, title, done, position)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM subtasks
          WHERE task_id=? AND title=? AND done=? AND position=?)`);
      const commentInsert = db.prepare(`INSERT INTO comments (task_id, user_id, author_name, body, created_at)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM comments
          WHERE task_id=? AND body=? AND created_at=? AND (user_id IS ? OR user_id IS NULL))`);
      const commentBackfill = db.prepare(`UPDATE comments SET user_id=COALESCE(user_id, ?), author_name=COALESCE(author_name, ?)
        WHERE id=(SELECT id FROM comments WHERE task_id=? AND body=? AND created_at=? AND (user_id IS ? OR user_id IS NULL) ORDER BY id LIMIT 1)`);
      const commentCanonicalize = db.prepare(`UPDATE comments SET body=?, user_id=COALESCE(user_id, ?), author_name=COALESCE(author_name, ?)
        WHERE id=(SELECT id FROM comments WHERE task_id=? AND body=? AND created_at=? AND (user_id IS ? OR user_id IS NULL) ORDER BY id LIMIT 1)`);
      const historyInsert = db.prepare(`INSERT INTO task_history (task_id, actor_id, author_name, field_name, old_value, new_value, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM task_history
          WHERE task_id=? AND field_name=? AND old_value=? AND new_value=? AND created_at=? AND (actor_id IS ? OR actor_id IS NULL))`);
      const historyBackfill = db.prepare(`UPDATE task_history SET actor_id=COALESCE(actor_id, ?), author_name=COALESCE(author_name, ?)
        WHERE id=(SELECT id FROM task_history WHERE task_id=? AND field_name=? AND old_value=? AND new_value=? AND created_at=? AND (actor_id IS ? OR actor_id IS NULL) ORDER BY id LIMIT 1)`);
      let importedTaskCount = 0;
      let importedSubtaskCount = 0;
      let importedCommentCount = 0;
      let importedStoryCount = 0;
      let position = 0;

      const importTaskActivity = async (bundle, rootTaskId, pathNames = []) => {
        const taskData = bundle?.task || {};
        const currentPath = [...pathNames, String(taskData.name || 'Untitled task')];
        if (!pathNames.length && taskData.created_by) {
          const actorId = mapPerson(taskData.created_by);
          const actorName = getPersonName(taskData.created_by) || null;
          const title = String(taskData.name || 'Untitled task');
          const createdAt = taskData.created_at || new Date().toISOString();
          await historyBackfill.run(actorId, actorName, rootTaskId, 'Task created', '', title, createdAt, actorId);
          await historyInsert.run(rootTaskId, actorId, actorName, 'Task created', '', title, createdAt,
            rootTaskId, 'Task created', '', title, createdAt, actorId);
        }
        const stories = flattenRecords(bundle?.stories);
        for (const story of stories) {
          const actorId = mapPerson(story.created_by);
          const actorName = getPersonName(story.created_by) || null;
          const rawText = String(story.text || stripHtml(story.html_text));
          const renderedHtmlText = story.html_text
            ? stripHtml(String(story.html_text).replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1'))
            : '';
          const text = renderedHtmlText || rawText;
          if (story.resource_subtype === 'comment_added' && text.trim()) {
            const commentBody = pathNames.length ? `[Asana subtask: ${currentPath.slice(1).join(' / ')}] ${text}` : text;
            const legacyCommentBody = pathNames.length ? `[Asana subtask: ${currentPath.slice(1).join(' / ')}] ${rawText}` : rawText;
            const createdAt = story.created_at || new Date().toISOString();
            await commentCanonicalize.run(commentBody, actorId, actorName, rootTaskId, legacyCommentBody, createdAt, actorId);
            await commentBackfill.run(actorId, actorName, rootTaskId, commentBody, createdAt, actorId);
            await commentInsert.run(rootTaskId, actorId, actorName, commentBody, createdAt, rootTaskId, commentBody, createdAt, actorId);
            importedCommentCount++;
          } else if (story.resource_subtype && text.trim()) {
            const fieldName = `Asana: ${story.resource_subtype}`;
            const createdAt = story.created_at || new Date().toISOString();
            await historyBackfill.run(actorId, actorName, rootTaskId, fieldName, '', text, createdAt, actorId);
            await historyInsert.run(rootTaskId, actorId, actorName, fieldName, '', text, createdAt, rootTaskId, fieldName, '', text, createdAt, actorId);
            importedStoryCount++;
          }
          completedImportUnits++;
          updateProgress(completedImportUnits, totalImportUnits, `Importing activity for ${currentPath[currentPath.length - 1]}...`);
        }
        for (const childBundle of flattenRecords(bundle?.subtasks)) {
          const child = childBundle.task || {};
          const childPath = [...currentPath, String(child.name || 'Untitled subtask')];
          const subtaskTitle = pathNames.length ? childPath.slice(1).join(' / ') : String(child.name || 'Untitled subtask');
          const subtaskDone = child.completed ? 1 : 0;
          const subtaskPosition = importedSubtaskCount++;
          await subtaskInsert.run(rootTaskId, subtaskTitle, subtaskDone, subtaskPosition, rootTaskId, subtaskTitle, subtaskDone, subtaskPosition);
          await importTaskActivity(childBundle, rootTaskId, currentPath);
        }
        completedImportUnits++;
        updateProgress(completedImportUnits, totalImportUnits, `Imported ${currentPath[currentPath.length - 1]}`);
      };

      for (const bundle of source.tasks) {
        const task = bundle?.task || {};
        const sectionMembership = (task.memberships || []).find(item => String(item.project?.gid || '') === projectGid) || (task.memberships || [])[0];
        const sectionName = sectionMembership?.section?.name;
        const customFieldLines = (task.custom_fields || []).filter(field => field?.name && field?.display_value)
          .map(field => `${field.name}: ${field.display_value}`);
        const descriptionParts = [];
        if (sectionName) descriptionParts.push(`[Asana section: ${sectionName}]`);
        if (task.notes) descriptionParts.push(String(task.notes));
        else if (task.html_notes) descriptionParts.push(stripHtml(task.html_notes));
        if (customFieldLines.length) descriptionParts.push(`Asana custom fields:\n${customFieldLines.join('\n')}`);
        const taskCreatorId = mapPerson(task.created_by) || req.session.userId;
        const taskAssigneeId = mapPerson(task.assignee);
        const taskAssigneeName = getPersonName(task.assignee) || null;
        const taskGid = String(task.gid || '');
        const taskTitle = String(task.name || 'Untitled task');
        const existingTask = taskGid
          ? await db.prepare('SELECT id FROM tasks WHERE project_id = ? AND asana_gid = ?').get(projectId, taskGid)
          : await db.prepare('SELECT id FROM tasks WHERE project_id = ? AND title = ? ORDER BY id LIMIT 1').get(projectId, taskTitle);
        let taskInfo;
        if (existingTask) {
          await db.prepare(`UPDATE tasks SET title=?, description=?, assignee_id=?, asana_assignee_name=?, due_date=?, status=?, asana_gid=?, updated_at=?, completed_at=? WHERE id=?`)
            .run(taskTitle, descriptionParts.join('\n\n'), taskAssigneeId, taskAssigneeName, task.due_on || null, task.completed ? 'done' : 'open', taskGid, task.modified_at || task.created_at || new Date().toISOString(), task.completed_at || null, existingTask.id);
          taskInfo = { lastInsertRowid: existingTask.id };
        } else {
          taskInfo = await taskInsert.run(
            projectId,
            taskTitle,
            descriptionParts.join('\n\n'),
            taskCreatorId,
            taskAssigneeId,
            taskAssigneeName,
            task.due_on || null,
            task.completed ? 'done' : 'open',
            position++,
            taskGid,
            task.created_at || new Date().toISOString(),
            task.modified_at || task.created_at || new Date().toISOString(),
            task.completed_at || null
          );
        }
        importedTaskCount++;
        updateProgress(completedImportUnits, totalImportUnits, `Importing task ${importedTaskCount} of ${source.tasks.length}: ${taskTitle}...`);
        await importTaskActivity(bundle, Number(taskInfo.lastInsertRowid));
      }
      await logActivity(req, 'Asana project imported', 'project', projectId, `${sourceProject.name}: ${importedTaskCount} tasks`, req.session.userId);
      updateProgress(totalImportUnits, totalImportUnits, `Imported ${sourceProject.name}.`, 'complete');
      results.push({ file: file.originalname, status: 'imported', project_id: projectId, project_name: sourceProject.name, tasks: importedTaskCount, subtasks: importedSubtaskCount, comments: importedCommentCount, activity_items: importedStoryCount, unmatched_users: Array.from(unmatchedNames) });
    } catch (error) {
      logRequestEvent(req, 'asana_project_import_failed');
      if (progressId) {
        asanaImportProgress.set(progressId, { status: 'failed', percent: currentProgress ? Math.min(99, asanaImportProgress.get(progressId)?.percent || 0) : 0, message: 'Import failed. Please check the server logs.', eta_seconds: null, updated_at: Date.now() });
      }
      let rollbackFailed = false;
      if (projectId && createdProject) {
        try {
          await db.batch([
            { sql: 'DELETE FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', args: [projectId] },
            { sql: 'DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', args: [projectId] },
            { sql: 'DELETE FROM task_history WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', args: [projectId] },
            { sql: 'DELETE FROM task_checkins WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', args: [projectId] },
            { sql: 'DELETE FROM telegram_attachments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', args: [projectId] },
            { sql: 'DELETE FROM project_members WHERE project_id = ?', args: [projectId] },
            { sql: 'DELETE FROM tasks WHERE project_id = ?', args: [projectId] },
            { sql: 'DELETE FROM projects WHERE id = ?', args: [projectId] }
          ]);
        } catch (rollbackError) {
          rollbackFailed = true;
          logRequestEvent(req, 'asana_project_import_rollback_failed');
        }
      }
      results.push({ file: file.originalname, status: 'failed', project_gid: projectGid, error: rollbackFailed ? 'Import failed and cleanup was incomplete; administrator review is required.' : 'Import failed.' });
    }
  }
  res.json({ ok: results.every(result => result.status === 'imported'), results });
});

router.post('/admin/asana-import/:projectId/attachments', requireAdmin, uploadRateLimit, handleAsanaUploadError(asanaAttachmentUpload.array('attachments', 5), 'Asana attachment'), withTenantDatabaseContext, async (req, res) => {
  const projectId = Number(req.params.projectId);
  const project = await db.prepare('SELECT id, asana_gid FROM projects WHERE id = ? AND asana_gid IS NOT NULL').get(projectId);
  if (!project) return res.status(404).json({ error: 'Imported Asana project not found.' });

  let mappings;
  try { mappings = JSON.parse(String(req.body.mappings || '[]')); }
  catch (error) { return res.status(400).json({ error: 'Attachment mappings are invalid JSON.' }); }
  const files = req.files || [];
  if (!Array.isArray(mappings) || mappings.length !== files.length) {
    return res.status(400).json({ error: 'Each uploaded file must have one task and attachment mapping.' });
  }

  const results = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const mapping = mappings[index] || {};
    let reservation = null;
    let stored;
    try {
      let task = await db.prepare(`SELECT id, title FROM tasks
        WHERE project_id = ? AND (asana_gid = ? OR (? <> '' AND title = ?))
        ORDER BY CASE WHEN asana_gid = ? THEN 0 ELSE 1 END LIMIT 1`)
        .get(projectId, String(mapping.task_gid || ''), String(mapping.task_title || ''), String(mapping.task_title || ''), String(mapping.task_gid || ''));
      const positionalMatch = String(mapping.task_gid || '').match(/^Task\s+(\d+)$/i);
      if (!task && positionalMatch) {
        task = await db.prepare(`SELECT id, title FROM tasks
          WHERE project_id = ? ORDER BY position, created_at, id LIMIT 1 OFFSET ?`)
          .get(projectId, Math.max(0, Number(positionalMatch[1]) - 1));
      }
      if (!task) throw new Error(`Task ${mapping.task_gid || '(unknown)'} was not found in the imported project.`);
      const attachmentGid = String(mapping.attachment_gid || '');
      const filename = String(mapping.name || file.originalname || 'Asana attachment');
      const context = mapping.context ? ` [Asana subtask: ${String(mapping.context)}]` : '';
      const body = `[Asana attachment ${attachmentGid}]${context} ${filename}`;
      const existing = await db.prepare('SELECT id FROM comments WHERE task_id = ? AND body = ? AND image_path IS NOT NULL')
        .get(task.id, body);
      if (existing) {
        results.push({ filename, status: 'already imported' });
        continue;
      }
      reservation = await reserveUpload(req, file.size);
      stored = await storageProvider.upload(file, { companyId: req.companyTenantId });
      await db.batch([
        {
          sql: 'INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type, uploaded_by, task_id, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [stored.fileId, stored.messageId, filename, file.mimetype || 'application/octet-stream', req.session.userId, task.id, file.size]
        },
        {
          sql: 'INSERT INTO comments (task_id, user_id, body, image_path, attachment_name, attachment_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          args: [task.id, req.session.userId, body, `/api/download/${encodeURIComponent(stored.fileId)}`, filename, file.mimetype || 'application/octet-stream', mapping.created_at || new Date().toISOString()]
        },
        { sql: 'DELETE FROM file_usage WHERE file_reference = ?', args: [reservation] }
      ]);
      results.push({ filename, status: 'imported', task: task.title });
    } catch (error) {
      if (stored?.messageId) {
        try { await storageProvider.delete({ fileId: stored.fileId, messageId: stored.messageId }); }
        catch (cleanupError) { logRequestEvent(req, 'asana_attachment_cleanup_failed'); }
      }
      if (reservation) {
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'asana_upload_reservation_release_failed'); }
      }
      logRequestEvent(req, 'asana_attachment_import_failed');
      results.push({
        filename: file.originalname,
        status: 'failed',
        error: error instanceof StorageLimitError ? error.message : 'Attachment import failed.'
      });
    }
  }
  res.json({ ok: results.every(result => result.status !== 'failed'), results });
});

router.get('/task-checkin-access', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT u.id, u.name, u.username,
      CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS checkin_required
      FROM users u LEFT JOIN task_checkin_access a ON a.user_id=u.id
      WHERE u.active=1 ORDER BY u.name`).all();
    res.json(rows || []);
  } catch (error) {
    sendInternalError(res, error, 'Task check-in access list failed');
  }
});

router.put('/task-checkin-access/:userId', requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Valid user is required.' });
    const target = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (req.body.enabled && Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot require check-in for an inactive user.' });
    if (req.body.enabled) {
      await db.prepare('INSERT OR REPLACE INTO task_checkin_access (user_id, enabled_by) VALUES (?, ?)').run(userId, req.session.userId);
    } else {
      await db.prepare('DELETE FROM task_checkin_access WHERE user_id=?').run(userId);
    }
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Task check-in access update failed');
  }
});

router.get('/task-work-mode-access/me', async (req, res) => {
  try {
    res.json({ allowed: await canChangeTaskWorkMode(req) });
  } catch (error) {
    sendInternalError(res, error, 'Task work-mode access lookup failed');
  }
});

router.get('/task-work-mode-access', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare(`SELECT u.id, u.name, u.username,
      CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS can_change_work_mode
      FROM users u LEFT JOIN task_work_mode_access a ON a.user_id=u.id
      WHERE u.active=1 ORDER BY u.name`).all();
    res.json(rows || []);
  } catch (error) {
    sendInternalError(res, error, 'Task work-mode access list failed');
  }
});

router.put('/task-work-mode-access/:userId', requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Valid user is required.' });
    const target = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (req.body.enabled && Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot grant work-mode access to an inactive user.' });
    if (req.body.enabled) {
      await db.prepare('INSERT OR REPLACE INTO task_work_mode_access (user_id, enabled_by) VALUES (?, ?)').run(userId, req.session.userId);
    } else {
      await db.prepare('DELETE FROM task_work_mode_access WHERE user_id=?').run(userId);
    }
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Task work-mode access update failed');
  }
});

router.put('/project-action-access/:userId', requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Valid user is required.' });
    const target = await db.prepare('SELECT role FROM users WHERE id=? AND active=1').get(userId);
    if (!target) return res.status(404).json({ error: 'Active user not found.' });
    const values = PROJECT_ACTIONS.map(action => target.role === 'admin' ? 1 : (req.body[action] ? 1 : 0));
    await db.prepare(`INSERT INTO project_action_access (user_id, ${PROJECT_ACTIONS.join(', ')}, updated_by)
      VALUES (?, ${PROJECT_ACTIONS.map(() => '?').join(', ')}, ?)
      ON CONFLICT(user_id) DO UPDATE SET ${PROJECT_ACTIONS.map(action => `${action}=excluded.${action}`).join(', ')}, updated_by=excluded.updated_by, updated_at=datetime('now')`)
      .run(userId, ...values, req.session.userId);
    res.json({ ok: true });
  } catch (error) {
    logRequestEvent(req, 'project_task_permissions_save_failed');
    sendInternalError(res, error, 'Project and task permission save failed');
  }
});

router.put('/projects/:id/feature-settings', requireAdmin, async (req, res) => {
  try {
    const updates = [];
    const values = [];
    for (const key of PROJECT_FEATURE_KEYS) {
      if (req.body?.[key] === undefined) continue;
      if (typeof req.body[key] !== 'boolean') return res.status(400).json({ error: `${key} must be true or false.` });
      updates.push(`${key}=?`);
      values.push(req.body[key] ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: 'No project settings were provided.' });
    const project = await db.prepare('SELECT id, name FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    await db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id=?`).run(...values, req.params.id);
    const saved = await db.prepare(`SELECT ${PROJECT_FEATURE_KEYS.join(', ')} FROM projects WHERE id=?`).get(req.params.id);
    await logActivity(req, 'Project settings changed', 'project', project.id,
      `${project.name}: ${PROJECT_FEATURE_KEYS.map(key => `${key} ${Number(saved[key]) ? 'on' : 'off'}`).join(', ')}`, req.session.userId);
    res.json({ ok: true, ...Object.fromEntries(PROJECT_FEATURE_KEYS.map(key => [key, Number(saved[key])])) });
  } catch (error) {
    sendInternalError(res, error, 'Project settings could not be saved');
  }
});

router.put('/projects/:id', async (req, res) => {
  try {
    if (!(await canAccessProject(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You are not a member of this project.' });
    if (!(await canProjectAction(req, 'edit_project'))) return res.status(403).json({ error: 'You do not have permission to edit projects.' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Project name is required.' });
    const hasPinUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, 'pin');
    const pin = req.body.pin;
    if (hasPinUpdate && pin !== null && pin !== '' && (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin))) {
      return res.status(400).json({ error: 'Project PIN must contain 4 to 12 digits, or be empty to remove it.' });
    }
    const project = await db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (hasPinUpdate) {
      const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
      await db.prepare('UPDATE projects SET name=?, pin_hash=? WHERE id=?').run(name, pinHash, req.params.id);
    } else {
      await db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, req.params.id);
    }
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Project update failed');
  }
});

router.post('/projects/:id/unlock', projectPinLimiter, async (req, res) => {
  try {
    const project = await db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!project.pin_hash) return res.json({ ok: true });
    if (await bcrypt.compare(String(req.body.pin || ''), project.pin_hash)) {
      const unlockedProjects = getUnlockedProjectMap(req);
      unlockedProjects[String(req.params.id)] = Date.now() + 30 * 60 * 1000;
      req.session.unlocked_projects = unlockedProjects;
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Wrong PIN' });
  } catch (err) { sendInternalError(res, err, 'Project unlock failed'); }
});

router.delete('/projects/:id', async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isSafeInteger(projectId) || projectId < 1) return res.status(400).json({ error: 'Invalid project ID.' });
    const project = await db.prepare('SELECT id, name, created_by FROM projects WHERE id=?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!(await canAccessProject(projectId, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You are not a member of this project.' });
    if (!(await canProjectAction(req, 'delete_project'))) return res.status(403).json({ error: 'You do not have permission to delete projects.' });

    const taskRows = await db.prepare('SELECT id FROM tasks WHERE project_id=?').all(projectId);
    const taskIds = (taskRows || []).map(row => Number(row.id)).filter(Number.isSafeInteger);
    const statements = [];
    if (taskIds.length) {
      const placeholders = taskIds.map(() => '?').join(',');
      statements.push({ sql: `DELETE FROM subtasks WHERE task_id IN (${placeholders})`, args: taskIds });
      statements.push({ sql: `DELETE FROM comments WHERE task_id IN (${placeholders})`, args: taskIds });
      statements.push({ sql: `DELETE FROM task_history WHERE task_id IN (${placeholders})`, args: taskIds });
      statements.push({ sql: `DELETE FROM task_checkins WHERE task_id IN (${placeholders})`, args: taskIds });
      statements.push({ sql: `DELETE FROM telegram_attachments WHERE task_id IN (${placeholders})`, args: taskIds });
    }
    statements.push({ sql: 'DELETE FROM project_members WHERE project_id = ?', args: [projectId] });
    statements.push({ sql: 'DELETE FROM tasks WHERE project_id = ?', args: [projectId] });
    statements.push({ sql: 'DELETE FROM projects WHERE id = ?', args: [projectId] });
    await db.batch(statements);
    await logActivity(req, 'Project deleted', 'project', project.id, project.name, project.created_by || req.session.userId);
    res.json({ ok: true });
  } catch (err) { sendInternalError(res, err, 'Project deletion failed'); }
});

// ---- Tasks ----
router.get('/projects/:id/tasks', requireProjectTaskAccess, async (req, res) => {
  try {
    const assignee = String(req.query.assignee_id || '').trim();
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || 'open').trim();
    const afterId = Math.max(0, Number(req.query.after_id) || 0);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 200;
    let sql = `SELECT t.id,t.title,t.status,t.position,t.created_at,t.due_date,COALESCE(u.name,t.asana_assignee_name) AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.project_id=? AND t.id>?`;
    const params = [req.params.id, afterId];
    if (!req.canViewAllProjectTasks) {
      sql += ' AND t.assignee_id=?';
      params.push(req.session.userId);
    }
    if (status !== 'all') {
      sql += status === 'done' ? " AND t.status='done'" : " AND COALESCE(t.status, 'open') <> 'done'";
    }
    if (assignee && assignee !== 'all') { sql += ' AND t.assignee_id=?'; params.push(Number(assignee)); }
    if (search) {
      const words = search.split(/\s+/).filter(Boolean);
      words.forEach(word => {
        const like = `%${word}%`;
        sql += ' AND (t.title LIKE ? OR t.description LIKE ?)';
        params.push(like, like);
      });
    }
    if (req.query.due_date) { sql += ' AND t.due_date=?'; params.push(req.query.due_date); }
    if (req.query.created_by && req.query.created_by !== 'all') { sql += ' AND t.created_by=?'; params.push(Number(req.query.created_by)); }
    if (req.query.created_on) { sql += ' AND date(t.created_at)=?'; params.push(req.query.created_on); }
    if (req.query.modified_on) { sql += ' AND date(t.updated_at)=?'; params.push(req.query.modified_on); }
    if (req.query.completed_on) { sql += ' AND date(t.completed_at)=?'; params.push(req.query.completed_on); }
    if (search) {
      const exact = `%${search}%`;
      sql += ' ORDER BY CASE WHEN t.title LIKE ? THEN 0 WHEN t.description LIKE ? THEN 1 ELSE 2 END, t.position, t.created_at LIMIT ?';
      params.push(exact, exact);
      params.push(limit);
    } else {
      sql += ' ORDER BY t.id LIMIT ?';
      params.push(limit);
    }
    res.json(await db.prepare(sql).all(...params));
  } catch (err) { sendInternalError(res, err, 'Project task list failed'); }
});

router.get('/my-tasks', async (req, res) => {
  try {
    const userId = req.session.userId;
    const sql = `SELECT t.id,t.project_id,t.title,t.description,t.assignee_id,t.due_date,t.status,t.position,t.created_at,
      p.name AS project_name,COALESCE(u.name,t.asana_assignee_name) AS assignee_name
      FROM tasks t JOIN projects p ON p.id=t.project_id
      LEFT JOIN users u ON u.id=t.assignee_id
      WHERE t.assignee_id=? AND COALESCE(t.status, 'open') <> 'done'
      ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.created_at`;
    res.json(await db.prepare(sql).all(userId));
  } catch (err) { sendInternalError(res, err, 'My task list failed'); }
});

router.get('/tasks/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const words = q.split(/\s+/).filter(Boolean);
    const admin = req.session.role === 'admin';
    const sql = `SELECT t.id,t.project_id,t.title,t.status,t.due_date,t.assignee_id,t.asana_assignee_name,p.name AS project_name,COALESCE(u.name,t.asana_assignee_name) AS assignee_name
      FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id
      LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
      WHERE (p.created_by=? OR pm.user_id=? OR ?=1 OR t.assignee_id=?)
      ${words.map(() => 'AND (t.title LIKE ? OR t.description LIKE ? OR u.name LIKE ? OR t.asana_assignee_name LIKE ? OR p.name LIKE ?)').join(' ')}
      ORDER BY CASE WHEN t.title LIKE ? THEN 0 WHEN t.description LIKE ? THEN 1 ELSE 2 END,
        CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.created_at DESC LIMIT 50`;
    const params = [req.session.userId, req.session.userId, req.session.userId, admin ? 1 : 0, req.session.userId];
    words.forEach(word => { const like = `%${word}%`; params.push(like, like, like, like, like); });
    params.push(`%${q}%`, `%${q}%`);
    res.json(await db.prepare(sql).all(...params));
  } catch (err) { sendInternalError(res, err, 'Task search failed'); }
});

router.post('/projects/:id/tasks', requireProjectAccess, async (req, res) => {
  try {
    if (!(await canProjectAction(req, 'create_task'))) return res.status(403).json({ error: 'You do not have permission to create tasks.' });
    // A double tap or a slow connection can send the same new task twice. Return the copy already saved.
    const titleForDuplicate = String(req.body.title || '').trim();
    if (titleForDuplicate) {
      const recent = await db.prepare(`SELECT id FROM tasks WHERE project_id = ? AND created_by = ? AND title = ?
        AND created_at >= datetime('now', '-15 seconds') ORDER BY id DESC LIMIT 1`).get(req.params.id, req.session.userId, titleForDuplicate);
      if (recent) return res.status(200).json({ id: recent.id, duplicate: true });
    }
    if (req.body.work_mode !== undefined && !(await canChangeTaskWorkMode(req))) return res.status(403).json({ error: 'You do not have permission to choose the task work location. Ask an administrator.' });
    const { title, description, assignee_id, due_date, invoice_number, invoice_date, invoice_type, customer_name, total_amount } = req.body;
    const features = await db.prepare('SELECT show_billing, show_work_location, show_description FROM projects WHERE id=?').get(req.params.id);
    if (features && Number(features.show_description ?? 1) !== 1) delete req.body.description;
    const billingEnabled = !features || Number(features.show_billing ?? 1) === 1;
    const workLocationEnabled = !features || Number(features.show_work_location ?? 1) === 1;
    const workMode = workLocationEnabled && req.body.work_mode === 'on_field' ? 'on_field' : 'office';
    const noBillingRequired = !billingEnabled || req.body.no_billing_required === true || Number(req.body.no_billing_required) === 1;
    const invoiceType = String(invoice_type || 'gst').trim().toLowerCase();
    if (!INVOICE_TYPES.includes(invoiceType)) return res.status(400).json({ error: 'Invoice type must be Cash or GST.' });
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title required' });
    if (assignee_id && !(await canAssignTaskToProject(req.params.id, assignee_id))) return res.status(400).json({ error: 'Assignee must be an active project member' });
    const normalizedInvoiceNumber = noBillingRequired ? null : String(invoice_number || '').trim() || null;
    const normalizedInvoiceDate = noBillingRequired ? null : (invoice_date || null);
    const normalizedCustomerName = noBillingRequired ? '' : String(customer_name || '').trim();
    const normalizedTotalAmount = noBillingRequired ? 0 : parseMoneyAmount(total_amount ?? 0);
    if (normalizedTotalAmount === null) return res.status(400).json({ error: 'Invoice total must be a non-negative amount with at most two decimal places.' });
    const info = await db.prepare(`INSERT INTO tasks(project_id,title,description,no_billing_required,created_by,assignee_id,due_date,invoice_type,invoice_number,invoice_date,customer_name,total_amount,work_mode)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.params.id, title.trim(), String(description || '').trim(), noBillingRequired ? 1 : 0, req.session.userId, assignee_id || null, due_date || null, invoiceType, normalizedInvoiceNumber, normalizedInvoiceDate, normalizedCustomerName, normalizedTotalAmount, workMode);
    if (!noBillingRequired && assignee_id && normalizedInvoiceNumber) {
      await db.prepare('UPDATE tasks SET payment_member_id = COALESCE(payment_member_id, ?) WHERE id = ?').run(Number(assignee_id), info.lastInsertRowid);
    }
    const historyInsert = db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)');
    await historyInsert.run(info.lastInsertRowid, req.session.userId, 'Task created', '', title.trim());
    if (assignee_id) {
      const assignee = await db.prepare('SELECT name FROM users WHERE id=?').get(assignee_id);
      await historyInsert.run(info.lastInsertRowid, req.session.userId, 'Assignee', 'Unassigned', assignee ? assignee.name : String(assignee_id));
    }
    if (due_date) await historyInsert.run(info.lastInsertRowid, req.session.userId, 'Due date', '', due_date);
    await logActivity(req, 'Task added', 'task', info.lastInsertRowid, title.trim(), assignee_id || req.session.userId);
    res.json({ id: info.lastInsertRowid });
  } catch (err) { sendInternalError(res, err, 'Task creation failed'); }
});

router.put('/tasks/:id', async (req, res) => {
  try {
    if (req.body.status !== undefined && !['open', 'done'].includes(req.body.status)) {
      return res.status(400).json({ error: 'Task status must be open or done.' });
    }
    if (req.body.title !== undefined && (typeof req.body.title !== 'string' || !req.body.title.trim())) {
      return res.status(400).json({ error: 'Task title is required.' });
    }
    if (req.body.work_mode !== undefined && !['office', 'on_field'].includes(req.body.work_mode)) {
      return res.status(400).json({ error: 'Task work mode must be office or on_field.' });
    }
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    if (req.body.status !== undefined && !(await canProjectAction(req, 'complete_task'))) return res.status(403).json({ error: 'You do not have permission to complete tasks.' });
    const workModeChangeRequested = req.body.work_mode !== undefined;
    if (workModeChangeRequested && !(await canChangeTaskWorkMode(req))) return res.status(403).json({ error: 'You do not have permission to change the task work location. Ask an administrator.' });
    if (Object.keys(req.body).some(key => !['status', 'work_mode'].includes(key)) && !(await canProjectAction(req, 'edit_task'))) return res.status(403).json({ error: 'You do not have permission to edit tasks.' });
    const taskBefore = await db.prepare('SELECT project_id, title, description, status, assignee_id, due_date, payment_member_id, invoice_number, invoice_date, customer_name, total_amount, amount_received, invoice_type, no_billing_required, work_mode FROM tasks WHERE id=?').get(req.params.id);
    if (!taskBefore) return res.status(404).json({ error: 'Task not found.' });
    const taskFeatures = await db.prepare('SELECT show_billing, show_work_location, show_description FROM projects WHERE id=?').get(taskBefore.project_id);
    if (taskFeatures && Number(taskFeatures.show_description ?? 1) !== 1) delete req.body.description;
    if (taskFeatures && Number(taskFeatures.show_work_location ?? 1) !== 1) delete req.body.work_mode;
    if (taskFeatures && Number(taskFeatures.show_billing ?? 1) !== 1) {
      for (const key of ['customer_name', 'invoice_number', 'invoice_date', 'invoice_type', 'total_amount', 'no_billing_required']) delete req.body[key];
    }
    const nextTotalAmount = req.body.total_amount === undefined
      ? Number(taskBefore.total_amount || 0)
      : parseMoneyAmount(req.body.total_amount);
    if (nextTotalAmount === null) return res.status(400).json({ error: 'Invoice total must be a non-negative amount with at most two decimal places.' });
    if (nextTotalAmount < Number(taskBefore.amount_received || 0)) return res.status(400).json({ error: 'Invoice total cannot be less than the amount already received.' });
    const noBillingRequired = req.body.no_billing_required === undefined
      ? Number(taskBefore.no_billing_required) === 1
      : req.body.no_billing_required === true || Number(req.body.no_billing_required) === 1;
    const billingChanges = [];
    const addBillingChange = (field, oldValue, newValue) => {
      const oldText = oldValue == null ? '' : String(oldValue);
      const newText = newValue == null ? '' : String(newValue);
      if (oldText !== newText) billingChanges.push([field, oldText, newText]);
    };
    if (req.body.no_billing_required !== undefined) {
      addBillingChange('No billing required', Number(taskBefore.no_billing_required) === 1 ? 'Yes' : 'No', noBillingRequired ? 'Yes' : 'No');
    }
    if (!noBillingRequired) {
      if (req.body.invoice_number !== undefined) addBillingChange('Invoice number', taskBefore.invoice_number, String(req.body.invoice_number || '').trim() || null);
      if (req.body.invoice_date !== undefined) addBillingChange('Invoice date', taskBefore.invoice_date, req.body.invoice_date || null);
      if (req.body.customer_name !== undefined) addBillingChange('Customer', taskBefore.customer_name, String(req.body.customer_name || '').trim());
      if (req.body.invoice_type !== undefined) addBillingChange('Invoice type', taskBefore.invoice_type, String(req.body.invoice_type || '').trim().toLowerCase());
      if (req.body.total_amount !== undefined) addBillingChange('Invoice total', taskBefore.total_amount, nextTotalAmount);
    }
    if (taskBefore.status === 'done' && billingChanges.length) {
      return res.status(409).json({ error: 'Billing details cannot be changed after task completion.' });
    }
    if (req.body.status === 'done' && !noBillingRequired) {
      const invoiceNumber = String(req.body.invoice_number ?? taskBefore.invoice_number ?? '').trim();
      const invoiceDate = String(req.body.invoice_date ?? taskBefore.invoice_date ?? '').trim();
      const customerName = String(req.body.customer_name ?? taskBefore.customer_name ?? '').trim();
      const totalAmount = nextTotalAmount;
      const invoiceType = String(req.body.invoice_type ?? taskBefore.invoice_type ?? '').trim().toLowerCase();
      if (!customerName || !invoiceNumber || !invoiceDate || !INVOICE_TYPES.includes(invoiceType) || !Number.isFinite(totalAmount) || totalAmount <= 0) {
        return res.status(400).json({ error: 'Complete the billing details (customer, invoice type, invoice number, invoice date, and total amount) or select No billing required before completing this task.' });
      }
    }
    const checkinStatus = await getTaskCheckinStatus(req.params.id, req.session.userId, req.session.role === 'admin');
    const onlyReassigning = Object.keys(req.body).length === 1 && req.body.assignee_id !== undefined;
    const onlyChangingStatusAfterCheckin = Object.keys(req.body).length === 1
      && req.body.status !== undefined && checkinStatus.hasCheckedIn;
    if (checkinStatus.required && !checkinStatus.checkedIn && !onlyReassigning && !onlyChangingStatusAfterCheckin) {
      return res.status(403).json({ error: 'Check in to this on-field task before editing, commenting, or updating it. You may reassign it before checking in.' });
    }
    const nextWorkMode = req.body.work_mode === 'on_field' ? 'on_field' : (req.body.work_mode === 'office' ? 'office' : taskBefore.work_mode || 'office');
    if (workModeChangeRequested && nextWorkMode === 'office' && taskBefore.work_mode === 'on_field') {
      const activeCheckin = await db.prepare(`SELECT t.title FROM task_checkins c
        JOIN tasks t ON t.id=c.task_id
        WHERE c.task_id=? AND c.check_in_at IS NOT NULL AND c.check_out_at IS NULL LIMIT 1`).get(req.params.id);
      if (activeCheckin) return res.status(400).json({ error: `Check out of "${activeCheckin.title}" before changing it to Office.` });
    }
    if (req.body.status === 'done' && taskBefore.work_mode === 'on_field') {
      const incomplete = await db.prepare(`SELECT CASE WHEN t.assignee_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM task_checkin_access a WHERE a.user_id=t.assignee_id)
        AND (c.check_in_at IS NULL OR c.check_out_at IS NULL) THEN 1 ELSE 0 END AS count
          FROM tasks t LEFT JOIN task_checkins c ON c.id=(SELECT latest.id FROM task_checkins latest
            WHERE latest.task_id=t.id AND latest.user_id=t.assignee_id ORDER BY latest.id DESC LIMIT 1)
          WHERE t.id=?`).get(req.params.id);
      if (Number(incomplete?.count || 0) > 0) return res.status(400).json({ error: 'Every required user must check in and check out before completing this on-field task.' });
    }
    const updates = [];
    const values = [];
    if (req.body.status !== undefined) { updates.push('status=?'); values.push(req.body.status === 'done' ? 'done' : 'open'); updates.push('completed_at=?'); values.push(req.body.status === 'done' ? new Date().toISOString() : null); }
    if (req.body.no_billing_required !== undefined) { updates.push('no_billing_required=?'); values.push(noBillingRequired ? 1 : 0); }
    if (req.body.title !== undefined) { updates.push('title=?'); values.push(String(req.body.title).trim()); }
    if (req.body.description !== undefined) { updates.push('description=?'); values.push(String(req.body.description)); }
    if (req.body.due_date !== undefined) { updates.push('due_date=?'); values.push(req.body.due_date || null); }
    if (!noBillingRequired && req.body.invoice_type !== undefined) {
      const invoiceType = String(req.body.invoice_type || '').trim().toLowerCase();
      if (!INVOICE_TYPES.includes(invoiceType)) return res.status(400).json({ error: 'Invoice type must be Cash or GST.' });
      updates.push('invoice_type=?'); values.push(invoiceType);
    }
    if (!noBillingRequired && req.body.invoice_number !== undefined) { updates.push('invoice_number=?'); values.push(String(req.body.invoice_number || '').trim() || null); }
    if (!noBillingRequired && req.body.invoice_date !== undefined) { updates.push('invoice_date=?'); values.push(req.body.invoice_date || null); }
    if (!noBillingRequired && req.body.customer_name !== undefined) { updates.push('customer_name=?'); values.push(String(req.body.customer_name || '').trim()); }
    if (!noBillingRequired && req.body.total_amount !== undefined) { updates.push('total_amount=?'); values.push(nextTotalAmount); }
    if (req.body.work_mode !== undefined) { updates.push('work_mode=?'); values.push(nextWorkMode); }
    if (req.body.assignee_id !== undefined) {
      if (req.body.assignee_id && !(await canAssignTaskToProject(taskBefore.project_id, req.body.assignee_id))) return res.status(400).json({ error: 'Assignee must be an active project member' });
      updates.push('assignee_id=?'); values.push(req.body.assignee_id || null);
      if (req.body.assignee_id) updates.push('asana_assignee_name=NULL');
    }
    if (!updates.length) return res.json({ ok: true });
    updates.push("updated_at=datetime('now')");
    values.push(req.params.id);
    await db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run(...values);
    const nextAssigneeId = req.body.assignee_id !== undefined ? (req.body.assignee_id ? Number(req.body.assignee_id) : null) : null;
    const shouldSyncPaymentMember = nextAssigneeId !== null && (!!taskBefore?.invoice_number || req.body.invoice_number !== undefined);
    if (shouldSyncPaymentMember && taskBefore && taskBefore.payment_member_id == null) {
      await db.prepare('UPDATE tasks SET payment_member_id = ? WHERE id = ?').run(nextAssigneeId, req.params.id);
    }
    const historyRows = [];
    const trackChange = (field, oldValue, newValue) => {
      const oldText = oldValue == null ? '' : String(oldValue);
      const newText = newValue == null ? '' : String(newValue);
      if (oldText !== newText) historyRows.push([req.params.id, req.session.userId, field, oldText, newText]);
    };
    for (const [field, oldValue, newValue] of billingChanges) trackChange(field, oldValue, newValue);
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
    const dueDateChange = historyRows.find(([, , fieldName]) => fieldName === 'Due date');
    if (dueDateChange) {
      await notifyTaskRelatedPeople(req, req.params.id, 'Task due date changed',
        `${dueDateChange[3] || 'No due date'} -> ${dueDateChange[4] || 'No due date'}`);
    }
    if (taskBefore && req.body.status !== undefined && taskBefore.status !== (req.body.status === 'done' ? 'done' : 'open')) {
      await logActivity(req, req.body.status === 'done' ? 'Task completed' : 'Task reopened', 'task', req.params.id, taskBefore.title, taskBefore.assignee_id || req.session.userId);
    }
    res.json({ ok: true });
  } catch (err) { sendInternalError(res, err, 'Task update failed'); }
});

router.get('/tasks/:id/history', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const rows = await db.prepare(`SELECT * FROM (
      SELECT h.*, u.name AS actor_name
      FROM task_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE h.task_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 100
    ) recent_history ORDER BY created_at ASC, id ASC`).all(req.params.id);
    res.json(rows || []);
  } catch (err) { sendInternalError(res, err, 'Task history request failed'); }
});

router.get('/tasks/:id/activity', async (req, res) => {
  if (!(await taskProjectFeatures(req.params.id)).on('show_activity')) {
    return res.json({ items: [], has_more: false, next_offset: 0, disabled: true });
  }
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 15;
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const rows = await db.prepare(`SELECT * FROM (
      SELECT 'comment' AS activity_type, c.id, c.user_id, c.author_name, c.body, c.edited_at, c.parent_id,
        c.image_path, c.attachment_name, c.attachment_type, c.created_at,
        u.name AS user_name, NULL AS actor_name, NULL AS field_name, NULL AS old_value, NULL AS new_value
      FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.task_id=?
      UNION ALL
      SELECT 'history' AS activity_type, h.id, h.actor_id AS user_id, h.author_name, NULL AS body, NULL AS edited_at, NULL AS parent_id,
        NULL AS image_path, NULL AS attachment_name, NULL AS attachment_type, h.created_at,
        NULL AS user_name, u.name AS actor_name, h.field_name, h.old_value, h.new_value
      FROM task_history h LEFT JOIN users u ON u.id=h.actor_id WHERE h.task_id=?
    ) activity
    ORDER BY created_at DESC, id DESC, activity_type DESC LIMIT ? OFFSET ?`)
      .all(req.params.id, req.params.id, limit + 1, offset);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const telegramFileIds = [...new Set(page.map(item => item.image_path?.match(/^\/api\/download\/([A-Za-z0-9_-]{1,256})$/)?.[1]).filter(Boolean))];
    const availableTelegramFileIds = new Set();
    if (telegramFileIds.length) {
      const placeholders = telegramFileIds.map(() => '?').join(',');
      const attachments = await db.prepare(`SELECT DISTINCT file_id FROM telegram_attachments
        WHERE task_id=? AND deleted_at IS NULL AND file_id IN (${placeholders})`).all(req.params.id, ...telegramFileIds);
      for (const attachment of attachments || []) availableTelegramFileIds.add(String(attachment.file_id));
    }
    const items = page.map(item => {
      const telegramFileId = item.image_path?.match(/^\/api\/download\/([A-Za-z0-9_-]{1,256})$/)?.[1];
      const localPath = item.image_path && !telegramFileId
        ? path.join(__dirname, '..', item.image_path.replace(/^\/uploads\//, 'uploads/'))
        : null;
      return {
        ...item,
        attachment_available: telegramFileId
          ? availableTelegramFileIds.has(telegramFileId)
          : !!localPath && fs.existsSync(localPath)
      };
    });
    const missingAttachments = items.filter(item => item.activity_type === 'comment' && item.image_path && !item.attachment_available).map(item => item.id);
    if (missingAttachments.length) {
      console.warn(JSON.stringify({ event: 'comment_attachment_unavailable', task_id: Number(req.params.id), comment_ids: missingAttachments.slice(0, 20) }));
    }
    res.json({ items, has_more: hasMore, next_offset: offset + items.length });
  } catch (err) { sendInternalError(res, err, 'Task activity request failed'); }
});

async function getTaskForCheckin(taskId, userId, admin) {
  const task = await db.prepare('SELECT id, project_id, title, assignee_id, work_mode FROM tasks WHERE id=?').get(taskId);
  if (!task || !(await canAccessTask(taskId, userId, admin))) return null;
  if (task.work_mode !== 'on_field') return { error: 'Check-in and check-out are only required for on-field tasks.' };
  const required = await db.prepare('SELECT user_id FROM task_checkin_access WHERE user_id=?').get(userId);
  if (!required) return { error: 'You are not required to check in and out for this task.' };
  return task;
}

// Same rule as attendance punches: if the employee has "Biometric Required" on, a check-in or check-out
// must carry the phone's fingerprint/screen-lock approval (from the TaskFlow app) or the account password.
async function requireBiometricForTaskCheckin(req, res) {
  const access = await db.prepare('SELECT user_id FROM attendance_verification_access WHERE user_id=?').get(req.session.userId);
  if (!access) return true;
  const userAgent = String(req.get('user-agent') || '').slice(0, 500);
  const isTaskFlowApp = req.session?.loginClient === 'app' && /TaskFlowNative\/1(?:\s|$)/.test(userAgent);
  if (req.body.verification_method === 'native-device-credential' && isTaskFlowApp) return true;
  const password = req.body.verification_password;
  if (typeof password === 'string' && password) {
    const user = await db.prepare('SELECT password_hash FROM users WHERE id=? AND active=1').get(req.session.userId);
    if (user?.password_hash && await bcrypt.compare(password, user.password_hash)) return true;
    res.status(401).json({ error: 'Password verification failed.' });
    return false;
  }
  res.status(403).json({ error: 'Verify with your fingerprint or phone screen lock in the TaskFlow app before checking in or out.' });
  return false;
}

router.post('/tasks/:id/check-in', async (req, res) => {
  if (!(await taskProjectFeatures(req.params.id)).on('allow_checkin')) {
    return res.status(403).json({ error: 'Check in and check out are turned off for this project.' });
  }
  try {
    const task = await getTaskForCheckin(req.params.id, req.session.userId, req.session.role === 'admin');
    if (!task) return res.status(403).json({ error: 'You do not have access to this task.' });
    if (task.error) return res.status(400).json({ error: task.error });
    if (!(await requireBiometricForTaskCheckin(req, res))) return;
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'A valid latitude and longitude are required to check in.' });
    }
    const activeVisit = await db.prepare(`SELECT id FROM task_checkins
      WHERE task_id=? AND user_id=? AND check_in_at IS NOT NULL AND check_out_at IS NULL
      ORDER BY id DESC LIMIT 1`).get(req.params.id, req.session.userId);
    if (activeVisit) return res.status(400).json({ error: 'You are already checked in for this task.' });
    const activeTask = await db.prepare(`SELECT t.title FROM task_checkins c
      JOIN tasks t ON t.id=c.task_id
      WHERE c.user_id=? AND c.task_id<>? AND c.check_in_at IS NOT NULL AND c.check_out_at IS NULL
      LIMIT 1`).get(req.session.userId, req.params.id);
    if (activeTask) return res.status(400).json({ error: `Check out of "${activeTask.title}" before checking into another task.` });
    const otherActiveUser = await db.prepare(`SELECT u.name FROM task_checkins c
      JOIN users u ON u.id=c.user_id
      WHERE c.task_id=? AND c.user_id<>? AND c.check_in_at IS NOT NULL AND c.check_out_at IS NULL
      LIMIT 1`).get(req.params.id, req.session.userId);
    if (otherActiveUser) return res.status(400).json({ error: `This task is already checked in by ${otherActiveUser.name}.` });
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO task_checkins (task_id,user_id,check_in_at,check_in_lat,check_in_lng) VALUES (?,?,?,?,?)').run(req.params.id, req.session.userId, now, lat, lng);
    await db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, req.session.userId, 'Task check-in', '', now);
    await notifyTaskRelatedPeople(req, req.params.id, 'Task check-in');
    res.json({ ok: true, check_in_at: now });
  } catch (err) {
    if (/unique constraint failed: task_checkins\.task_id,\s*task_checkins\.user_id/i.test(String(err.message))) {
      return res.status(400).json({ error: 'You are already checked in for this task.' });
    }
    sendInternalError(res, err, 'Task check-in failed');
  }
});

router.post('/tasks/:id/check-out', async (req, res) => {
  if (!(await taskProjectFeatures(req.params.id)).on('allow_checkin')) {
    return res.status(403).json({ error: 'Check in and check out are turned off for this project.' });
  }
  try {
    if (!(await requireBiometricForTaskCheckin(req, res))) return;
    const existing = await db.prepare(`SELECT * FROM task_checkins
      WHERE task_id=? AND user_id=? AND check_in_at IS NOT NULL AND check_out_at IS NULL
      ORDER BY id DESC LIMIT 1`).get(req.params.id, req.session.userId);
    if (!existing?.check_in_at) return res.status(400).json({ error: 'There is no open check-in to close for this task.' });
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'A valid latitude and longitude are required to check out.' });
    }
    const now = new Date().toISOString();
    await db.prepare('UPDATE task_checkins SET check_out_at=?, check_out_lat=?, check_out_lng=? WHERE id=?').run(now, lat, lng, existing.id);
    await db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, req.session.userId, 'Task check-out', existing.check_in_at, now);
    await notifyTaskRelatedPeople(req, req.params.id, 'Task check-out');
    res.json({ ok: true, check_out_at: now });
  } catch (err) { sendInternalError(res, err, 'Task check-out failed'); }
});

router.get('/tasks/:id', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const canViewPayments = await canViewPaymentHistory(req);
    const task = await db.prepare(`SELECT t.id, t.project_id, t.title, t.description, t.no_billing_required,
      t.created_by, t.assignee_id, t.asana_assignee_name, t.due_date, t.work_mode, t.status, t.position, t.asana_gid,
      t.created_at, t.updated_at, t.completed_at,
      CASE WHEN ?=1 THEN t.invoice_type END AS invoice_type,
      CASE WHEN ?=1 THEN t.invoice_number END AS invoice_number,
      CASE WHEN ?=1 THEN t.invoice_date END AS invoice_date,
      CASE WHEN ?=1 THEN t.customer_name END AS customer_name,
      CASE WHEN ?=1 THEN t.total_amount END AS total_amount,
      CASE WHEN ?=1 THEN t.payment_member_id END AS payment_member_id,
      CASE WHEN ?=1 THEN t.payment_status END AS payment_status,
      CASE WHEN ?=1 THEN t.payment_received_date END AS payment_received_date,
      CASE WHEN ?=1 THEN t.amount_received END AS amount_received,
      COALESCE(u.name, t.asana_assignee_name) AS assignee_name
      FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?`)
      .get(...Array(9).fill(canViewPayments ? 1 : 0), req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const uniqueRows = (rows, fields) => {
      const seen = new Set();
      return rows.filter(row => {
        const key = JSON.stringify(fields.map(field => row[field] ?? null));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const [canChangeWorkMode, subtasks, checkinUsers] = await Promise.all([
      canChangeTaskWorkMode(req),
      db.prepare('SELECT * FROM subtasks WHERE task_id=? ORDER BY position,id').all(task.id),
      db.prepare(`SELECT u.id, u.name, c.check_in_at, c.check_in_lat, c.check_in_lng, c.check_out_at, c.check_out_lat, c.check_out_lng
        FROM users u JOIN task_checkin_access r ON r.user_id=u.id
        LEFT JOIN task_checkins c ON c.id=(SELECT latest.id FROM task_checkins latest
          WHERE latest.task_id=? AND latest.user_id=u.id ORDER BY latest.id DESC LIMIT 1)
        WHERE u.id=?`).all(task.id, req.session.userId)
    ]);
    task.can_change_work_mode = canChangeWorkMode ? 1 : 0;
    task.subtasks = uniqueRows(subtasks, ['title', 'done', 'position']);
    task.checkin_users = checkinUsers;
    task.checkin_required = task.checkin_users.length ? 1 : 0;
    res.json(task);
  } catch (err) { sendInternalError(res, err, 'Task details request failed'); }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    const task = await db.prepare('SELECT id, title, assignee_id FROM tasks WHERE id=?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (!(await canAccessTask(task.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task.' });
    if (!(await canProjectAction(req, 'delete_task'))) return res.status(403).json({ error: 'You do not have permission to delete tasks.' });
    const deleted = await db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    if (!deleted.changes) return res.status(404).json({ error: 'Task not found.' });
    await logActivity(req, 'Task deleted', 'task', task.id, task.title, task.assignee_id || req.session.userId);
    res.json({ ok: true });
  } catch (err) { sendInternalError(res, err, 'Task deletion failed'); }
});

router.post('/tasks/:id/subtasks', async (req, res) => {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task' });
    const checkinStatus = await getTaskCheckinStatus(req.params.id, req.session.userId, req.session.role === 'admin');
    if (checkinStatus.required && !checkinStatus.checkedIn) return res.status(403).json({ error: 'Check in to this on-field task before managing subtasks.' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Subtask title is required.' });
    const info = await db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM subtasks WHERE task_id = ?), 0))')
      .run(req.params.id, title, req.params.id);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) { sendInternalError(res, err, 'Subtask creation failed'); }
});

router.put('/subtasks/:id', async (req, res) => {
  try {
    const subtask = await db.prepare('SELECT task_id FROM subtasks WHERE id=?').get(req.params.id);
    if (!subtask || !(await canAccessTask(subtask.task_id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this subtask' });
    const checkinStatus = await getTaskCheckinStatus(subtask.task_id, req.session.userId, req.session.role === 'admin');
    if (checkinStatus.required && !checkinStatus.checkedIn) return res.status(403).json({ error: 'Check in to this on-field task before managing subtasks.' });
    const updates = [];
    const values = [];
    if (req.body.title !== undefined) { updates.push('title=?'); values.push(String(req.body.title).trim()); }
    if (req.body.done !== undefined) { updates.push('done=?'); values.push(req.body.done ? 1 : 0); }
    if (!updates.length) return res.json({ ok: true });
    values.push(req.params.id);
    await db.prepare(`UPDATE subtasks SET ${updates.join(',')} WHERE id=?`).run(...values);
    res.json({ ok: true });
  } catch (err) { sendInternalError(res, err, 'Subtask update failed'); }
});

router.delete('/subtasks/:id', async (req, res) => {
  try {
    if (!(await canProjectAction(req, 'delete_task'))) return res.status(403).json({ error: 'You do not have permission to delete tasks.' });
    const subtask = await db.prepare('SELECT task_id FROM subtasks WHERE id=?').get(req.params.id);
    if (!subtask || !(await canAccessTask(subtask.task_id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this subtask' });
    const checkinStatus = await getTaskCheckinStatus(subtask.task_id, req.session.userId, req.session.role === 'admin');
    if (checkinStatus.required && !checkinStatus.checkedIn) return res.status(403).json({ error: 'Check in to this on-field task before managing subtasks.' });
    await db.prepare('DELETE FROM subtasks WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { sendInternalError(res, err, 'Subtask deletion failed'); }
});

async function requireTaskCheckinToComment(req, res, next) {
  try {
    if (!(await canAccessTask(req.params.id, req.session.userId, req.session.role === 'admin'))) {
      return res.status(403).json({ error: 'You do not have access to this task' });
    }
    const checkinStatus = await getTaskCheckinStatus(req.params.id, req.session.userId, req.session.role === 'admin');
    if (checkinStatus.required && !checkinStatus.checkedIn) return res.status(403).json({ error: 'Check in to this on-field task before commenting.' });
    next();
  } catch (err) {
    sendInternalError(res, err, 'Comment permission check failed');
  }
}

// Replies attach to a top-level comment on the same task (replies to replies are attached to the top comment).
const PROJECT_FEATURE_KEYS = ['show_billing', 'show_work_location', 'show_description', 'allow_comments', 'show_activity', 'allow_checkin'];
// Looks up which features are on for the project that owns a task. Missing values mean on.
async function taskProjectFeatures(taskId) {
  const row = await db.prepare(`SELECT p.show_billing, p.show_work_location, p.show_description, p.allow_comments, p.show_activity, p.allow_checkin
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`).get(taskId);
  return { row, on: key => !row || Number(row[key] ?? 1) === 1 };
}

async function resolveReplyParent(taskId, rawParentId) {
  if (rawParentId === undefined || rawParentId === null || rawParentId === '') return null;
  const parentId = Number(rawParentId);
  if (!Number.isSafeInteger(parentId) || parentId < 1) return { error: 'The comment you are replying to is invalid.' };
  const parent = await db.prepare('SELECT id, task_id, user_id, parent_id FROM comments WHERE id=?').get(parentId);
  if (!parent || Number(parent.task_id) !== Number(taskId)) return { error: 'The comment you are replying to no longer exists on this task.' };
  const top = parent.parent_id ? await db.prepare('SELECT id, user_id FROM comments WHERE id=?').get(parent.parent_id) : parent;
  return { id: Number(top?.id || parent.id), authorId: Number(parent.user_id) };
}

async function notifyReplyAuthor(req, taskId, reply, body) {
  try {
    if (!reply || !reply.authorId || reply.authorId === Number(req.session.userId)) return;
    await logActivity(req, 'Replied to your comment', 'task', taskId, commentSnippet(body), reply.authorId);
  } catch (error) {
    logRequestEvent(req, 'task_reply_notification_failed', 'warn');
  }
}

router.post('/tasks/:id/comments', requireTaskCheckinToComment, uploadRateLimit, handleCommentUploadError, async (req, res) => {
  try {
    const body = String(req.body.body || '').trim();
    if (!body && !req.file) return res.status(400).json({ error: 'Write a comment or attach an image.' });
    if (!(await taskProjectFeatures(req.params.id)).on('allow_comments')) {
      return res.status(403).json({ error: 'Commenting is turned off for this project.' });
    }
    const reply = await resolveReplyParent(req.params.id, req.body.parent_id);
    if (reply?.error) return res.status(400).json({ error: reply.error });
    const replyParentId = reply ? reply.id : null;
    if (req.file) {
      const reservation = await reserveUpload(req, req.file.size);
      let attachment;
      try {
        attachment = await storageProvider.upload(req.file, { companyId: req.companyTenantId });
        const results = await db.batch([
          {
            sql: 'INSERT INTO telegram_attachments (file_id, message_id, original_name, mime_type, uploaded_by, task_id, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [attachment.fileId, attachment.messageId, req.file.originalname, req.file.mimetype, req.session.userId, req.params.id, req.file.size]
          },
          {
            sql: 'INSERT INTO comments (task_id, user_id, body, image_path, attachment_name, attachment_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [req.params.id, req.session.userId, body, `/api/download/${encodeURIComponent(attachment.fileId)}`, req.file.originalname, req.file.mimetype, replyParentId]
          },
          { sql: 'DELETE FROM file_usage WHERE file_reference = ?', args: [reservation] }
        ]);
        await notifyTaskRelatedPeople(req, req.params.id, 'Task comment added', commentSnippet(body));
        await notifyMentionedMembers(req, req.params.id, body);
        await notifyReplyAuthor(req, req.params.id, reply, body);
        return res.json({ ok: true, id: results?.[1]?.lastInsertRowid });
      } catch (error) {
        if (attachment?.messageId) {
          try { await storageProvider.delete({ fileId: attachment.fileId, messageId: attachment.messageId }); }
          catch (cleanupError) { logRequestEvent(req, 'comment_attachment_cleanup_failed'); }
        }
        try { await releaseUpload(reservation); }
        catch (cleanupError) { logRequestEvent(req, 'comment_upload_reservation_release_failed'); }
        throw error;
      }
    }
    const info = await db.prepare('INSERT INTO comments (task_id, user_id, body, image_path, attachment_name, attachment_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.params.id, req.session.userId, body, null, null, null, replyParentId);
    await notifyTaskRelatedPeople(req, req.params.id, 'Task comment added', commentSnippet(body));
    await notifyMentionedMembers(req, req.params.id, body);
    await notifyReplyAuthor(req, req.params.id, reply, body);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    if (err instanceof StorageLimitError) return res.status(err.statusCode).json({ error: err.message });
    sendInternalError(res, err, 'Comment creation failed');
  }
});

router.put('/comments/:id', async (req, res) => {
  try {
    const comment = await db.prepare('SELECT id, task_id, user_id, body FROM comments WHERE id=?').get(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (Number(comment.user_id) !== Number(req.session.userId)) return res.status(403).json({ error: 'Only the comment author can edit this comment.' });
    if (!(await canAccessTask(comment.task_id, req.session.userId, req.session.role === 'admin'))) return res.status(403).json({ error: 'You do not have access to this task.' });
    const checkinStatus = await getTaskCheckinStatus(comment.task_id, req.session.userId, req.session.role === 'admin');
    if (checkinStatus.required && !checkinStatus.checkedIn) return res.status(403).json({ error: 'Check in to this on-field task before editing comments.' });
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
    const editedAt = new Date().toISOString();
    await db.batch([
      { sql: 'INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)', args: [comment.task_id, req.session.userId, 'Comment edited', comment.body, body, editedAt] },
      { sql: 'UPDATE comments SET body=?, edited_at=? WHERE id=?', args: [body, editedAt, req.params.id] }
    ]);
    res.json({ ok: true, edited_at: editedAt });
  } catch (err) {
    sendInternalError(res, err, 'Comment update failed');
  }
});

router.canAccessTask = canAccessTask;
module.exports = router;
