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

// Global interface driver alignment abstraction layers
const dbDriverInterface = {
  exec: async (sql) => {
    try { return await db.execute(sql); } catch(e) { console.error("Driver EXEC error:", e.message); throw e; }
  },
  prepare: (sql) => {
    return {
      get: async (...params) => {
        try {
          const res = await db.execute({ sql, args: params });
          // FIXED: Now safely pulls out the exact first object row item [0] so auth.js receives the user profile correctly!
          return res.rows && res.rows.length > 0 ? res.rows[0] : null;
        } catch(err) { console.error("Driver GET error:", err.message); return null; }
      },
      all: async (...params) => {
        try {
          const res = await db.execute({ sql, args: params });
          return res.rows || [];
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

// Initialize each schema matrix separately to solve the multi-statement constraints error loop
(async function initializeDatabaseScripts() {
  try {
    console.log("⚙️ Building cloud database tables...");
    
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      department TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin_hash TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, user_id)
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      assignee_id INTEGER REFERENCES users(id),
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      body TEXT NOT NULL DEFAULT '',
      image_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      punch_in TEXT,
      punch_out TEXT,
      in_lat REAL, in_lng REAL,
      out_lat REAL, out_lng REAL,
      in_location_text TEXT,
      out_location_text TEXT,
      location_status TEXT,
      notes TEXT
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS reimbursements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      expense_date TEXT NOT NULL,
      receipt_path TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS reimbursement_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      approval_level INTEGER NOT NULL DEFAULT 0,
      can_pay INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    console.log("✅ Cloud tables initialized. Running migrations and seeds...");

    const rawUserPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(users)").all();
    const userColumns = (rawUserPragmaRows || []).map(row => row.name || row.NAME);
    if (!userColumns.includes('department')) {
      await dbDriverInterface.exec("ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT ''");
      console.log('Migrated: added users.department column');
    }
    await dbDriverInterface.exec("INSERT OR IGNORE INTO departments (name) SELECT DISTINCT trim(department) FROM users WHERE trim(department) <> ''");

    const rawAttendancePragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(attendance)").all();
    const attendanceColumns = (rawAttendancePragmaRows || []).map(row => row.name || row.NAME);
    if (!attendanceColumns.includes('in_location_text')) {
      await dbDriverInterface.exec("ALTER TABLE attendance ADD COLUMN in_location_text TEXT");
    }
    if (!attendanceColumns.includes('out_location_text')) {
      await dbDriverInterface.exec("ALTER TABLE attendance ADD COLUMN out_location_text TEXT");
    }

    const rawTaskPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(tasks)").all();
    const taskColumns = (rawTaskPragmaRows || []).map(row => row.name || row.NAME);
    if (!taskColumns.includes('created_by')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id)");
    if (!taskColumns.includes('updated_at')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT");
    await dbDriverInterface.exec("UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL");
    if (!taskColumns.includes('completed_at')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");

    // 1. Column Migration Checks
    const rawPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(comments)").all();
    const commentCols = [];
    if (Array.isArray(rawPragmaRows)) {
      rawPragmaRows.forEach(row => {
        if (row) {
          const columnName = row.name || row.Name;
          if (columnName) commentCols.push(columnName);
        }
      });
    }

    if (!commentCols.includes('image_path')) {
      try {
        await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN image_path TEXT');
        console.log('Migrated: added comments.image_path column');
      } catch (colErr) {
        // pass
      }
    }

    // 2. Project Creator Membership Seeding
    const projectsToSeed = await dbDriverInterface.prepare('SELECT id, created_by FROM projects WHERE created_by IS NOT NULL').all();
    const seedMember = dbDriverInterface.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const p of projectsToSeed) {
      if (p && p.id && p.created_by) {
        await seedMember.run(p.id, p.created_by);
      }
    }

    // 3. Base Administrative User Account Seeding
    const usersCountObj = await dbDriverInterface.prepare('SELECT COUNT(*) as c FROM users').get();
    const totalUsers = usersCountObj ? (usersCountObj.c || usersCountObj['COUNT(*)']) : 0;
    
    if (!totalUsers || totalUsers === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await dbDriverInterface.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, 'admin')`)
        .run('Admin', 'admin', hash);
      console.log('✅ Base Admin Seeded Successfully -> User: admin | Pass: admin123');
    }

    // 4. Default Settings Parameter Sync Check
    const defaults = { office_lat: '', office_lng: '', office_radius_m: '150' };
    const getSetting = dbDriverInterface.prepare('SELECT value FROM settings WHERE key = ?');
    const setSetting = dbDriverInterface.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(defaults)) {
      const check = await getSetting.get(k);
      if (!check) {
        await setSetting.run(k, v);
      }
    }
    console.log("🏁 Permanent Turso database architecture fully synchronized!");
  } catch (err) {
    console.error("Database initialization fault loop warning:", err.message);
  }
})();

module.exports = dbDriverInterface;
