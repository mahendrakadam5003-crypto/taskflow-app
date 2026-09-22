const express = require('express');
const session = require('express-session');
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

app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-real-use',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    sameSite: 'lax'
  }
}));

app.use('/api/auth', authRouter);
app.use('/api', tasksRouter);
app.use('/api/attendance', attendanceRouter);

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// ========================================================
// INSTANT PORT BINDING & EMERGENCY ACCOUNT SEEDING
// ========================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TaskFlow operational server running on port: ${PORT}`);
  
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
