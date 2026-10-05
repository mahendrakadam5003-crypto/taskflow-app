const sessionSecret = String(process.env.SESSION_SECRET || '').trim();
if (sessionSecret.length < 32) {
  console.error('SESSION_SECRET must be set to a random value of at least 32 characters before startup.');
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { LEGACY_TENANT_ID } = require('./tenant-manager');

const app = express();
const PORT = process.env.PORT || 3000;
const isRender = process.env.RENDER === 'true';
const isTailscaleServe = process.env.TAILSCALE_SERVE === 'true';
const bindAddress = isRender ? '0.0.0.0' : '127.0.0.1';
const sessionMaxAgeMs = 14 * 24 * 60 * 60 * 1000;
if (isRender || isTailscaleServe) app.set('trust proxy', 1);

const nativeAppOrigins = new Set(['capacitor://localhost', 'http://localhost', 'https://localhost', 'ionic://localhost']);
function verifyUnsafeRequestOrigin(req, res, next) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('Origin');
  if (!origin) return next();
  if (nativeAppOrigins.has(origin)) return next();

  try {
    const parsedOrigin = new URL(origin).origin;
    const requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
    if (parsedOrigin === origin && parsedOrigin === requestOrigin) return next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
  return res.status(403).json({ error: 'Invalid request origin.' });
}

const db = require('./db');

class TursoSessionStore extends session.Store {
  get(sid, callback) {
    db.prepare('SELECT data, expires_at FROM web_sessions WHERE sid = ?').get(sid)
      .then(row => {
        if (!row || Number(row.expires_at) <= Date.now()) {
          if (row) db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid).catch(() => {});
          return callback(null, null);
        }
        callback(null, JSON.parse(row.data));
      }, callback);
  }

  set(sid, sessionData, callback) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + Number(sessionData.cookie?.maxAge || 86400000);
    db.prepare(`INSERT INTO web_sessions (sid, data, user_id, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, user_id = excluded.user_id, expires_at = excluded.expires_at`)
      .run(sid, JSON.stringify(sessionData), sessionData.userId || null, expiresAt)
      .then(() => callback?.(null))
      .catch(callback);
  }

  destroy(sid, callback) {
    db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid)
      .then(() => callback?.(null))
      .catch(callback);
  }

  touch(sid, sessionData, callback) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + Number(sessionData.cookie?.maxAge || 86400000);
    db.prepare('UPDATE web_sessions SET expires_at = ? WHERE sid = ?').run(expiresAt, sid)
      .then(() => callback?.(null))
      .catch(callback);
  }
}

async function cleanupExpiredSessions() {
  await db.ready;
  await db.runForEachTenant(() => db.deleteExpiredSessions(Date.now()));
}

// ========================================================
// CORE MIDDLEWARE & INTEGRATION ROUTES
// ========================================================
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const { router: authRouter } = require('./routes/auth');
const { createSuperAdminRouter } = require('./routes/superadmin');
const { bootstrapConfiguredSuperAdmin } = require('./scripts/create-superadmin');
const tasksRouter = require('./routes/tasks');
const attendanceRouter = require('./routes/attendance');
const reimbursementsRouter = require('./routes/reimbursements');
const uploadsRouter = require('./routes/uploads');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN || null;
const telegramChannelId = process.env.TELEGRAM_CHANNEL_ID || null;

function retentionDays(value, fallback) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const days = Number(normalized);
  return Number.isSafeInteger(days) && days <= 36500 ? days : fallback;
}

function retentionExpired(value, days) {
  const timestamp = new Date(value).getTime();
  return days > 0 && Number.isFinite(timestamp) && timestamp < Date.now() - days * 24 * 60 * 60 * 1000;
}

function resolveUploadPath(root, relativePath) {
  const resolvedPath = path.resolve(root, relativePath);
  const relative = path.relative(root, resolvedPath);
  return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? null : resolvedPath;
}

function parseJsonArray(value) {
  try {
    const result = value ? JSON.parse(value) : [];
    return Array.isArray(result) ? result : [];
  } catch (error) {
    return [];
  }
}

async function deleteTelegramMessage(messageId, label) {
  if (!messageId || !telegramToken || !telegramChannelId) {
    return { success: false, permanent: false, error: 'Telegram deletion is not configured.' };
  }
  try {
    const response = await axios.post(`https://api.telegram.org/bot${telegramToken}/deleteMessage`, {
      chat_id: telegramChannelId,
      message_id: messageId
    }, { validateStatus: () => true });
    if (response.data?.ok) return { success: true, permanent: false, error: null };
    const description = response.data?.description || 'unknown Telegram API response';
    if (/message to delete not found|message not found/i.test(description)) return { success: true, permanent: false, error: null };
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    console.error(`Telegram did not confirm deletion of ${label}:`, description);
    return { success: false, permanent, error: description };
  } catch (error) {
    const description = error.response?.data?.description || error.message;
    if (/message to delete not found|message not found/i.test(description)) return { success: true, permanent: false, error: null };
    console.error(`Could not delete ${label} from Telegram:`, description);
    const status = Number(error.response?.status);
    return {
      success: false,
      permanent: status >= 400 && status < 500 && status !== 429,
      error: description
    };
  }
}

async function removeReceiptReference(claimId, receiptPath) {
  const claim = await db.prepare('SELECT receipt_path, receipt_paths, receipt_meta FROM reimbursements WHERE id = ?').get(claimId);
  if (!claim) return;
  const receiptPaths = parseJsonArray(claim.receipt_paths);
  const receiptMeta = parseJsonArray(claim.receipt_meta);
  if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
  const index = receiptPaths.indexOf(receiptPath);
  if (index < 0) return;
  receiptPaths.splice(index, 1);
  if (index < receiptMeta.length) receiptMeta.splice(index, 1);
  await db.prepare(`UPDATE reimbursements SET receipt_path = ?, receipt_paths = ?, receipt_meta = ? WHERE id = ?`)
    .run(receiptPaths[0] || null, receiptPaths.length ? JSON.stringify(receiptPaths) : null,
      receiptMeta.length ? JSON.stringify(receiptMeta) : null, claimId);
}

async function clearTelegramReferences(fileId) {
  const imagePath = `/api/download/${encodeURIComponent(fileId)}`;
  await db.prepare(`UPDATE comments SET image_path = NULL, attachment_name = NULL, attachment_type = NULL WHERE image_path = ?`).run(imagePath);
  const claims = await db.prepare('SELECT id, receipt_path, receipt_paths FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL').all();
  const receiptPath = `telegram:${fileId}`;
  for (const claim of claims || []) {
    if (claim.receipt_path === receiptPath || parseJsonArray(claim.receipt_paths).includes(receiptPath)) {
      await removeReceiptReference(claim.id, receiptPath);
    }
  }
}

async function cleanupExpiredUploadsForCurrentTenant() {
  await db.ready;
  const settings = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('attachment_retention_days', 'attendance_location_retention_days')`).all();
  const settingValues = Object.fromEntries((settings || []).map(row => [row.key || row.KEY, row.value ?? row.VALUE]));
  const attachmentDays = retentionDays(settingValues.attachment_retention_days, 0);
  const locationDays = retentionDays(settingValues.attendance_location_retention_days, 60);
  let removed = 0;

  if (locationDays > 0) {
    const modifier = `-${locationDays} days`;
    const oldLocations = await db.prepare(`SELECT id, telegram_message_id FROM attendance_locations
      WHERE datetime(recorded_at) < datetime('now', ?)`).all(modifier);
    for (const location of oldLocations || []) {
      const deletion = location.telegram_message_id
        ? await deleteTelegramMessage(location.telegram_message_id, `attendance location ${location.id}`)
        : { success: true };
      if (!deletion.success) {
        await db.prepare(`UPDATE attendance_locations SET latitude = NULL, longitude = NULL,
          distance_meters = 0, place_changed = 0,
          telegram_message_id = CASE WHEN ? THEN NULL ELSE telegram_message_id END WHERE id = ?`)
          .run(deletion.permanent ? 1 : 0, location.id);
        continue;
      }
      await db.prepare('DELETE FROM attendance_locations WHERE id = ?').run(location.id);
      removed++;
    }
    await db.prepare(`UPDATE attendance SET in_lat = NULL, in_lng = NULL, out_lat = NULL, out_lng = NULL,
      in_location_text = NULL, out_location_text = NULL, location_status = NULL,
      in_device_type = NULL, in_device_info = NULL, out_device_type = NULL, out_device_info = NULL
      WHERE date < date('now', ?)`).run(modifier);
    await db.prepare(`UPDATE task_checkins SET check_in_lat = NULL, check_in_lng = NULL,
      check_out_lat = NULL, check_out_lng = NULL WHERE datetime(check_in_at) < datetime('now', ?)`).run(modifier);
    await db.prepare(`UPDATE attendance_registered_devices
      SET device_name = 'Registered device', device_info = ''
      WHERE registered_at < datetime('now', ?)
        AND (device_name <> 'Registered device' OR device_info <> '')`).run(modifier);
    await db.prepare(`UPDATE activity_log SET details = 'Location details expired'
      WHERE entity_type = 'attendance' AND action IN ('Punched in', 'Punched out')
        AND created_at < datetime('now', ?)`).run(modifier);
    await db.prepare(`UPDATE activity_log SET details = 'Registered device details expired'
      WHERE entity_type = 'user' AND action IN ('Attendance device registered', 'Attendance device renamed')
        AND created_at < datetime('now', ?)`).run(modifier);
  }

  if (attachmentDays > 0) {
    const modifier = `-${attachmentDays} days`;
    const oldComments = await db.prepare(`SELECT id, image_path FROM comments
      WHERE image_path LIKE '/uploads/%' AND created_at < datetime('now', ?)`).all(modifier);
    for (const comment of oldComments || []) {
      const filePath = resolveUploadPath(uploadsDir, String(comment.image_path).replace(/^\/uploads\//, ''));
      if (!filePath) continue;
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await db.prepare('UPDATE comments SET image_path = NULL, attachment_name = NULL, attachment_type = NULL WHERE id = ?').run(comment.id);
      } catch (error) {
        console.error(`Could not expire local comment attachment ${comment.id}:`, error.message);
        continue;
      }
      removed++;
    }

    const claims = await db.prepare(`SELECT id, expense_date, receipt_path, receipt_paths, receipt_meta
      FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL`).all();
    for (const claim of claims || []) {
      if (!retentionExpired(`${claim.expense_date}T00:00:00Z`, attachmentDays)) continue;
      const receiptPaths = parseJsonArray(claim.receipt_paths);
      const receiptMeta = parseJsonArray(claim.receipt_meta);
      if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
      for (const receiptPath of [...receiptPaths]) {
        if (typeof receiptPath !== 'string' || receiptPath.startsWith('telegram:')) continue;
        const filePath = resolveUploadPath(path.join(uploadsDir, 'receipts'), receiptPath);
        if (!filePath) continue;
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          await removeReceiptReference(claim.id, receiptPath);
          removed++;
        } catch (error) {
          console.error(`Could not expire local reimbursement receipt ${claim.id}:`, error.message);
        }
      }
    }

    const commentsWithTelegramFiles = await db.prepare(`SELECT image_path, created_at FROM comments
      WHERE image_path LIKE '/api/download/%'`).all();
    const claimRows = await db.prepare(`SELECT id, expense_date, receipt_path, receipt_paths
      FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL`).all();
    const references = new Map();
    const addReference = (fileId, expired) => {
      if (!references.has(fileId)) references.set(fileId, []);
      references.get(fileId).push(expired);
    };
    for (const comment of commentsWithTelegramFiles || []) {
      const match = String(comment.image_path || '').match(/^\/api\/download\/([^/?#]+)/);
      if (!match) continue;
      try { addReference(decodeURIComponent(match[1]), retentionExpired(comment.created_at, attachmentDays)); } catch (error) { }
    }
    for (const claim of claimRows || []) {
      const paths = parseJsonArray(claim.receipt_paths);
      if (claim.receipt_path && !paths.includes(claim.receipt_path)) paths.unshift(claim.receipt_path);
      for (const receiptPath of paths) {
        if (typeof receiptPath === 'string' && receiptPath.startsWith('telegram:')) {
          addReference(receiptPath.slice('telegram:'.length), retentionExpired(`${claim.expense_date}T00:00:00Z`, attachmentDays));
        }
      }
    }

    const telegramFiles = await db.prepare(`SELECT file_id, message_id, created_at, delete_attempts
      FROM telegram_attachments WHERE deleted_at IS NULL AND failed_at IS NULL`).all();
    const fileIds = Array.from(new Set((telegramFiles || []).map(file => file.file_id)));
    const maxDeleteAttempts = 5;
    for (const fileId of fileIds) {
      const fileRows = telegramFiles.filter(file => file.file_id === fileId);
      const refs = references.get(fileId) || [];
      const isExpired = refs.length ? refs.every(Boolean) : fileRows.every(file => retentionExpired(file.created_at, attachmentDays));
      if (!isExpired) continue;
      let retryableFailure = false;
      const deletedMessageIds = [];
      for (const messageId of new Set(fileRows.map(file => file.message_id))) {
        const messageRows = fileRows.filter(file => Number(file.message_id) === Number(messageId));
        const oldestMessage = Math.min(...messageRows.map(file => new Date(file.created_at).getTime()).filter(Number.isFinite));
        const deletion = oldestMessage <= Date.now() - 48 * 60 * 60 * 1000
          ? { success: false, permanent: true, error: 'Telegram messages can only be deleted within 48 hours.' }
          : await deleteTelegramMessage(messageId, `attachment ${fileId}`);
        if (!deletion.success) {
          const attempts = Math.max(...messageRows.map(file => Number(file.delete_attempts) || 0)) + 1;
          const terminal = deletion.permanent || attempts >= maxDeleteAttempts;
          await db.prepare(`UPDATE telegram_attachments
            SET delete_attempts = ?, last_error = ?, failed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END
            WHERE file_id = ? AND message_id = ? AND deleted_at IS NULL AND failed_at IS NULL`)
            .run(attempts, String(deletion.error || 'Telegram deletion failed').slice(0, 1000), terminal ? 1 : 0, fileId, messageId);
          if (!terminal) retryableFailure = true;
          continue;
        }
        deletedMessageIds.push(messageId);
        removed++;
      }
      if (!retryableFailure) {
        await clearTelegramReferences(fileId);
      }
      for (const messageId of deletedMessageIds) {
        await db.prepare("UPDATE telegram_attachments SET deleted_at = datetime('now') WHERE file_id = ? AND message_id = ? AND deleted_at IS NULL").run(fileId, messageId);
      }
    }
  }

  if (removed) console.log(`Expired ${removed} attachment or location record(s) under configured retention settings.`);
}

async function cleanupExpiredUploads() {
  await db.ready;
  await db.runForEachTenant(() => cleanupExpiredUploadsForCurrentTenant());
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': isRender ? [] : null
    }
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(verifyUnsafeRequestOrigin);
app.use((req, res, next) => db.runWithTenant(LEGACY_TENANT_ID, next));
app.use((req, res, next) => {
  res.set('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version');
  next();
});
const sessionOptions = {
  name: 'taskflow.sid.v2',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: false,
  cookie: {
    maxAge: sessionMaxAgeMs,
    httpOnly: true,
    secure: isRender || isTailscaleServe,
    sameSite: 'lax'
  }
};
if (!isRender) {
  sessionOptions.store = new FileStore({ path: path.join(__dirname, 'sessions'), retries: 5, retryDelay: 100, ttl: sessionMaxAgeMs / 1000 });
} else {
  sessionOptions.store = new TursoSessionStore();
}
app.use(session(sessionOptions));

app.get('/superadmin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'superadmin.html'));
});
app.use('/api/superadmin', createSuperAdminRouter({ secureCookies: isRender || isTailscaleServe }));

app.use('/api/auth', authRouter);
app.use('/api', tasksRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/reimbursements', reimbursementsRouter);

app.use('/uploads', uploadsRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode || error.status);
  const clientError = status >= 400 && status < 500;
  console.error(`Unhandled request error: ${req.method} ${req.originalUrl}`, error);
  res.status(clientError ? status : 500).json({
    error: clientError ? 'Invalid request.' : 'Internal server error.'
  });
});

let server;
const startupPromise = (async () => {
  await db.ready;
  try {
    const superAdminBootstrap = await bootstrapConfiguredSuperAdmin();
    if (superAdminBootstrap === 'created') console.log('Initial super-admin account created. Remove SUPERADMIN_PASSWORD from the environment.');
    else if (superAdminBootstrap === 'updated') console.log('Super-admin credentials updated. Remove SUPERADMIN_PASSWORD from the environment.');
    else if (superAdminBootstrap === 'unchanged') console.log('Configured super-admin account is ready. Remove SUPERADMIN_PASSWORD from the environment.');
    else console.log('Super-admin bootstrap skipped; SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD are not configured.');
  } catch (error) {
    console.error(`Super-admin bootstrap failed; the company workspace will continue without it: ${error.message}`);
  }
  await cleanupExpiredSessions();
  server = app.listen(PORT, bindAddress, () => {
    console.log(`TaskFlow operational server running on ${bindAddress}:${PORT}`);
    cleanupExpiredUploads().catch(err => console.error('Startup cleanup failed:', err));
    setInterval(() => cleanupExpiredUploads().catch(err => console.error('Upload cleanup failed:', err.message)), 24 * 60 * 60 * 1000);
    setInterval(() => cleanupExpiredSessions().catch(err => console.error('Session cleanup failed:', err.message)), 24 * 60 * 60 * 1000);
  });
})().catch(error => {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection; shutting down:', reason);
  if (server) {
    server.close(() => process.exit(1));
    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(1);
  }
});
