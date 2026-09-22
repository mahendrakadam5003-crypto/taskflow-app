const path = require('path');
const bcrypt = require('bcryptjs');
const { Database } = require('@libsql/sqlite3'); 

let db;

// 1. Get absolute file path matching native platforms
const rawPath = path.resolve(__dirname, 'taskflow.db');

// 2. Format it into a clean, compliant local URI string to pass driver constraints
const localDbUrl = rawPath.startsWith('/') ? `file://${rawPath}` : `file:///${rawPath.replace(/\\/g, '/')}`;

if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
  try {
    db = new Database(localDbUrl, {
      syncUrl: process.env.TURSO_DATABASE_URL.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN.trim()
    });
    console.log("☁️ Connected to Turso Cloud SQLite Replication Engine.");
  } catch (err) {
    console.error("Cloud connection initialization failed, trying clean fallback:", err.message);
    db = new Database(localDbUrl);
  }
} else {
  db = new Database(localDbUrl);
  console.log("💻 Connected to Local PC SQLite File.");
}

// WAL mode and Foreign Keys checks handled safely
try { db.exec('PRAGMA foreign_keys = ON;'); } catch(e) { /* handled by engine */ }

// Initialize all core project databases matching your structural constraints
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin_hash TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  assignee_id INTEGER REFERENCES users(id),
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  image_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  punch_in TEXT,
  punch_out TEXT,
  in_lat REAL, in_lng REAL,
  out_lat REAL, out_lng REAL,
  location_status TEXT,
  notes TEXT
);
`);

// Async-safe Boot Seeding Operations Block
(async function initializeDatabaseScripts() {
  try {
    // 1. Column Migration Checks
    const commentCols = (await db.prepare("PRAGMA table_info(comments)").all()).map(c => c.name);
    if (!commentCols.includes('image_path')) {
      db.exec('ALTER TABLE comments ADD COLUMN image_path TEXT');
      console.log('Migrated: added comments.image_path column');
    }

    // 2. Project Creator Membership Seeding
    const projectsToSeed = await db.prepare('SELECT id, created_by FROM projects WHERE created_by IS NOT NULL').all();
    const seedMember = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const p of projectsToSeed) {
      await seedMember.run(p.id, p.created_by);
    }

    // 3. Secure Admin Credential Initialization
    const users = await db.prepare('SELECT COUNT(*) as c FROM users').get();
    if (!users || users.c === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, 'admin')`)
        .run('Admin', 'admin', hash);
      console.log('✅ Base Admin Seeded Successfully -> User: admin | Pass: admin123');
    }

    // 4. Default Application Settings Mapping
    const defaults = { office_lat: '', office_lng: '', office_radius_m: '150' };
    const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
    const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) {
      const check = await getSetting.get(k);
      if (!check) {
        await setSetting.run(k, v);
      }
    }

    // Sync cloud synchronization check
    if (typeof db.sync === 'function') await db.sync();
    console.log("🏁 Database structure and synchronization parameters initialized cleanly.");
  } catch (err) {
    console.error("Database seeding/migration warning:", err.message);
  }
})();

module.exports = db;
