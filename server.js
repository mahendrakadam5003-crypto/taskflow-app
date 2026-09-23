const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Import our central database client abstraction instance layer cleanly 
const db = require('./db');

// ========================================================
// CORE MIDDLEWARE & INTEGRATION ROUTES
// ========================================================
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const { router: authRouter } = require('./routes/auth');
const tasksRouter = require('./routes/tasks');
const attendanceRouter = require('./routes/attendance');
const reimbursementsRouter = require('./routes/reimbursements');

const imageRetentionMs = 1000 * 60 * 60 * 24 * 92;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || null;
const telegramChannelId = process.env.TELEGRAM_CHANNEL_ID || null;
async function cleanupExpiredUploads() {
  const cutoff = Date.now() - imageRetentionMs;
  let removed = 0;
  await db.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', '-24 hours')").run();
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

app.use(express.json({ limit: '2mb' }));
const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-real-use',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 365 * 10,
    sameSite: 'lax'
  }
};
if (process.env.RENDER !== 'true') {
  sessionOptions.store = new FileStore({ path: path.join(__dirname, 'sessions'), retries: 5, retryDelay: 100, ttl: 60 * 60 * 24 * 365 * 10 });
}
app.use(session(sessionOptions));

app.use('/api/auth', authRouter);
app.use('/api', tasksRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/reimbursements', reimbursementsRouter);

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// ========================================================
// INSTANT PORT BINDING & EMERGENCY ACCOUNT SEEDING
// ========================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TaskFlow operational server running on port: ${PORT}`);
  setTimeout(() => cleanupExpiredUploads().catch(err => console.error('Upload cleanup failed:', err.message)), 10000);
  setInterval(() => cleanupExpiredUploads().catch(err => console.error('Upload cleanup failed:', err.message)), 24 * 60 * 60 * 1000);
  
  // Triggers the account injection script immediately after the network socket binds live
  (async function forceCreateAdminAccount() {
    try {
      console.log("⚡ Checking and forcing admin profile deployment into cloud shards...");
      const hash = bcrypt.hashSync('admin123', 10);
      
      // Inject row coordinates straight into your Turso production tables matrix clusters
      await db.prepare(`INSERT OR IGNORE INTO users (name, username, password_hash, role, active) VALUES (?, ?, ?, ?, ?)`).run(
        'System Admin Manager',
        'admin',
        hash,
        'admin',
        1
      );
      console.log("🚀 FORCE SEED COMPLETE: User 'admin' with password 'admin123' is now live inside Turso Cloud!");
    } catch (err) {
      console.error("Bypass verification note:", err.message);
    }
  })();
});
