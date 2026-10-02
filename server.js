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
const FormData = require('form-data');

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

// Import our central database client abstraction instance layer cleanly 
const db = require('./db');

class TursoSessionStore extends session.Store {
  get(sid, callback) {
    db.prepare('SELECT data, expires_at FROM web_sessions WHERE sid = ?').getStrict(sid)
      .then(row => {
        if (!row || Number(row.expires_at) <= Date.now()) {
          if (row) db.prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid).catch(() => {});
          return callback(null, null);
        }
        callback(null, JSON.parse(row.data));
      })
      .catch(callback);
  }

  set(sid, sessionData, callback) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + Number(sessionData.cookie?.maxAge || 86400000);
    db.prepare(`INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
      .run(sid, JSON.stringify(sessionData), expiresAt)
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

// ========================================================
// CORE MIDDLEWARE & INTEGRATION ROUTES
// ========================================================
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const { router: authRouter } = require('./routes/auth');
const tasksRouter = require('./routes/tasks');
const attendanceRouter = require('./routes/attendance');
const reimbursementsRouter = require('./routes/reimbursements');
const uploadsRouter = require('./routes/uploads');

const imageRetentionMs = 1000 * 60 * 60 * 24 * 92;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || null;
const telegramChannelId = process.env.TELEGRAM_CHANNEL_ID || null;
async function cleanupExpiredUploads() {
  const cutoff = Date.now() - imageRetentionMs;
  let removed = 0;
  const expiredLocationPoints = await db.prepare("DELETE FROM attendance_locations WHERE recorded_at < datetime('now', '-60 days')").run();
  if (expiredLocationPoints.changes) console.log(`Removed ${expiredLocationPoints.changes} attendance location point(s) older than 60 days from Turso.`);
  const comments = await db.prepare('SELECT image_path, created_at FROM comments WHERE image_path IS NOT NULL').all();
  for (const comment of comments) {
    if (new Date(comment.created_at).getTime() >= cutoff) continue;
    const filePath = path.join(__dirname, comment.image_path.replace(/^\/uploads\//, 'uploads/'));
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); removed++; }
  }
  const reimbursements = await db.prepare('SELECT receipt_path, expense_date FROM reimbursements WHERE receipt_path IS NOT NULL').all();
  for (const claim of reimbursements) {
    if (new Date(`${claim.expense_date}T00:00:00Z`).getTime() >= cutoff) continue;
    const filePath = path.join(uploadsDir, 'receipts', claim.receipt_path);
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); removed++; }
  }
  if (telegramToken && telegramChannelId) {
    const telegramFiles = await db.prepare("SELECT id, message_id FROM telegram_attachments WHERE deleted_at IS NULL AND created_at < datetime('now', '-92 days')").all();
    for (const file of telegramFiles) {
      try {
        await axios.post(`https://api.telegram.org/bot${telegramToken}/deleteMessage`, { chat_id: telegramChannelId, message_id: file.message_id });
        await db.prepare("UPDATE telegram_attachments SET deleted_at = datetime('now') WHERE id = ?").run(file.id);
        removed++;
      } catch (error) {
        console.error(`Could not delete Telegram attachment ${file.id}:`, error.response?.data?.description || error.message);
      }
    }
  }
  if (removed) console.log(`Removed ${removed} attachment(s) older than three months; text records were kept.`);
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

app.use('/api/auth', authRouter);
app.use('/api', tasksRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/reimbursements', reimbursementsRouter);

app.use('/uploads', uploadsRouter);
app.use(express.static(path.join(__dirname, 'public')));

// ========================================================
// INSTANT PORT BINDING
// ========================================================
app.listen(PORT, bindAddress, () => {
  console.log(`TaskFlow operational server running on ${bindAddress}:${PORT}`);
  setTimeout(() => cleanupExpiredUploads().catch(err => console.error('Upload cleanup failed:', err.message)), 10000);
  setInterval(() => cleanupExpiredUploads().catch(err => console.error('Upload cleanup failed:', err.message)), 24 * 60 * 60 * 1000);
});
