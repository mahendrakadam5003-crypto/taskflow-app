const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'taskflow.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee', -- 'admin' | 'employee'
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
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done'
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
  date TEXT NOT NULL, -- YYYY-MM-DD, local server date
  punch_in TEXT,
  punch_out TEXT,
  in_lat REAL, in_lng REAL,
  out_lat REAL, out_lng REAL,
  location_status TEXT, -- 'on-site' | 'remote' | 'unknown'
  notes TEXT
);
`);

// migrate: add image_path to comments if this db was created before attachments existed
const commentCols = db.prepare("PRAGMA table_info(comments)").all().map(c => c.name);
if (!commentCols.includes('image_path')) {
  db.exec('ALTER TABLE comments ADD COLUMN image_path TEXT');
  console.log('Migrated: added comments.image_path column');
}

// migrate collaboration table for existing installations
db.exec(`CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
)`);
// Project creators/admins retain access; existing projects are seeded for their creator.
const projectsToSeed = db.prepare('SELECT id, created_by FROM projects WHERE created_by IS NOT NULL').all();
const seedMember = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
for (const p of projectsToSeed) seedMember.run(p.id, p.created_by);

// seed default admin if no users exist
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, 'admin')`)
    .run('Admin', 'admin', hash);
  console.log('Seeded default admin user -> username: admin | password: admin123 (change this immediately in Admin > Users)');
}

// seed default settings
const defaults = { office_lat: '', office_lng: '', office_radius_m: '150' };
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) {
  if (!getSetting.get(k)) setSetting.run(k, v);
}

module.exports = db;
