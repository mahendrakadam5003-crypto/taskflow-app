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

const sixMonthsMs = 1000 * 60 * 60 * 24 * 183;
async function cleanupExpiredUploads() {
  const cutoff = Date.now() - sixMonthsMs;
  let removed = 0;
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
  if (removed) console.log(`Removed ${removed} upload(s) older than six months.`);
}

app.use(express.json({ limit: '2mb' }));
app.use(session({
  store: new FileStore({ path: path.join(__dirname, 'sessions'), retries: 1, ttl: 60 * 60 * 24 * 365 * 10 }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-real-use',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 365 * 10,
    sameSite: 'lax'
  }
}));

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
