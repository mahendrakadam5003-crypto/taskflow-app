const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const TELEGRAM_TOKEN = "8892731667:AAESv4N-8E5mSwQKZ-OvDyCDpTFyAAIY4MU";
const CHANNEL_ID = "-1003299962777";
const DB_PATH = path.join(__dirname, 'taskflow.db');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================================
// REFACTORED STORAGE PERSISTENCE ENGINE (NON-BLOCKING)
// ========================================================
async function initializeCloudStorage() {
  try {
    console.log("Checking cloud vault for active database backup history...");
    
    // Added a short timeout constraint to prevent infinite loading loops
    const historyRes = await axios.get(`https://telegram.org{TELEGRAM_TOKEN}/getUpdates?limit=100`, { timeout: 5000 });
    let targetFileId = null;

    if (historyRes.data && historyRes.data.result) {
      const updates = historyRes.data.result.reverse();
      for (const update of updates) {
        const message = update.message || update.channel_post;
        if (message && message.document && message.document.file_name === 'AUTOMATED_BACKUP_taskflow.db') {
          targetFileId = message.document.file_id;
          break;
        }
      }
    }

    if (targetFileId) {
      console.log("Database backup state identified. Initiating data restoration pipeline...");
      const fileInfo = await axios.get(`https://telegram.org{TELEGRAM_TOKEN}/getFile?file_id=${targetFileId}`);
      const filePath = fileInfo.data.result.file_path;
      
      const fileUrl = `https://telegram.org{TELEGRAM_TOKEN}/${filePath}`;
      const downloadStream = await axios({ method: 'get', url: fileUrl, responseType: 'arraybuffer' });
      
      fs.writeFileSync(DB_PATH, downloadStream.data);
      console.log("Text logs restored to live app memory cleanly!");
    } else {
      console.log("No previous backup file detected. Running on active database engine configuration.");
    }
  } catch (err) {
    console.warn("Notice: Sync bootstrap bypassed or timed out. Initializing native database fallback instance.", err.message);
  }

  // Load backend models cleanly right after synchronization runs
  require('./db');
}

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
// INSTANT PORT BINDING (Fixes Render 30-min loading stalls)
// ========================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`TaskFlow operational server running on port: ${PORT}`);
  
  // Triggers the data extraction script safely AFTER the port goes live
  initializeCloudStorage();
});

// Automated background snapshot synchronization (Fires every 10 minutes)
setInterval(async () => {
  try {
    if (fs.existsSync(DB_PATH)) {
      const form = new FormData();
      form.append('chat_id', CHANNEL_ID);
      form.append('document', fs.createReadStream(DB_PATH), { filename: 'AUTOMATED_BACKUP_taskflow.db' });

      await axios.post(`https://telegram.org{TELEGRAM_TOKEN}/sendDocument`, form, {
        headers: form.getHeaders(),
      });
      console.log("Database backup synced to cloud repository successfully.");
    }
  } catch (error) {
    console.error("Automated database backup sync failed:", error.message);
  }
}, 10 * 60 * 1000);
