const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client'); 

let db = null;

const syncUrl = "libsql://taskflow-db-mahendrakadam5003-crypto.aws-ap-south-1.turso.io";
const authToken = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTAwNzQxMTYsImlkIjoiMDFhMGM4YmEtNTkwMS03MmQwLTg2MTYtZTEyZmNlZjA5NzI5Iiwia2lkIjoieVF3Z3NwV1lKSl9fRXFSZXVZS295aFFqWUZGOXhtLTJsWWpMTHVQZC0ybyIsInJpZCI6IjVkZjgxOTBkLWUzZWMtNDI0ZS05OGY1LTg4MTFjNjdhNmMzNCJ9.g8jDHdtdJEbMJZWvzJX8fm2aE1qf3wTxDTxFAQu7X-jX87dB0WeBoEmchh7SSedU4QHZGKHKfWm91TTE1LpuAw";

try {
  db = createClient({
    url: syncUrl,
    authToken: authToken
  });
  console.log("☁️ Successfully connected to permanent Turso Cloud Data Vault Infrastructure Layer.");
} catch (initErr) {
  console.error("Critical Cloud connection mapping failure:", initErr.message);
  db = createClient({ url: "file:" + path.join(__dirname, "taskflow.db") });
}

// Custom row cleaning flattener to clear away Turso getter-proxy structures cleanly
function cleanRow(row) {
  if (!row) return null;
  const copy = {};
  Object.keys(row).forEach(k => { copy[k] = row[k]; });
  return Object.keys(copy).length ? copy : row;
}

const dbDriverInterface = {
  exec: async (sql) => {
    try { return await db.execute(sql); } catch(e) { console.error("Driver EXEC error:", e.message); throw e; }
  },
  prepare: (sql) => {
    return {
      get: async (...params) => {
        try {
          const res = await db.execute({ sql, args: params });
          return res.rows && res.rows.length > 0 ? cleanRow(res.rows[0]) : null;
        } catch(err) { console.error("Driver GET error:", err.message); return null; }
      },
      all: async (...params) => {
        try {
          const res = await db.execute({ sql, args: params });
          return res.rows ? res.rows.map(r => cleanRow(r)) : [];
        } catch(err) { console.error("Driver ALL error:", err.message); return []; }
      },
      run: async (...params) => {
        try {
          const res = await db.execute({ sql, args: params });
          return { lastInsertRowid: res.lastInsertRowid ? Number(res.lastInsertRowid) : null, changes: res.rowsAffected || 0 };
        } catch(err) { console.error("Driver RUN error:", err.message); throw err; }
      }
    };
  }
};

// Seeding and migrations pipeline
(async function initializeDatabaseScripts() {
  try {
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'employee', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, pin_hash TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS project_members (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, added_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (project_id, user_id));`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT DEFAULT '', assignee_id INTEGER REFERENCES users(id), due_date TEXT, status TEXT NOT NULL DEFAULT 'open', position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS subtasks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0);`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), body TEXT NOT NULL DEFAULT '', image_path TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL, punch_in TEXT, punch_out TEXT, in_lat REAL, in_lng REAL, out_lat REAL, out_lng REAL, location_status TEXT, notes TEXT);`);

    const usersCountObj = await dbDriverInterface.prepare('SELECT COUNT(*) as c FROM users').get();
    const totalUsers = usersCountObj ? (usersCountObj.c || usersCountObj['COUNT(*)']) : 0;
    if (!totalUsers || totalUsers === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await dbDriverInterface.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, 'admin')`).run('Admin', 'admin', hash);
    }
    console.log("🏁 Permanent Turso database architecture fully synchronized!");
  } catch (err) {
    console.error("Database initialization warning:", err.message);
  }
})();

module.exports = dbDriverInterface;
