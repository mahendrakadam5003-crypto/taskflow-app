const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client'); 

let db = null;

const syncUrl = process.env.TURSO_DATABASE_URL || "libsql://taskflow-db-mahendrakadam5003-crypto.aws-ap-south-1.turso.io";
const normalizeToken = (value) => typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '').trim() : value;
const authToken = normalizeToken(process.env.TURSO_AUTH_TOKEN || null);

try {
  if (!authToken) throw new Error('TURSO_AUTH_TOKEN is not configured');
  db = createClient({ url: syncUrl, authToken: authToken });
  console.log("☁️ Successfully connected to permanent Turso Cloud Data Vault Infrastructure Layer.");
} catch (initErr) {
  console.error("Critical Cloud connection mapping failure:", initErr.message);
  db = createClient({ url: "file:" + path.join(__dirname, "taskflow.db") });
}

// Global interface driver alignment abstraction layers
const dbDriverInterface = {
  exec: async (sql) => {
    try { return await db.execute(sql); } catch(e) {
      const operation = String(sql).replace(/\s+/g, ' ').trim().slice(0, 120);
      console.error("Driver EXEC error:", e.message, "Operation:", operation);
      console.error("Driver EXEC details:", JSON.stringify({ code: e.code, status: e.status, cause: e.cause?.message }));
      throw e;
    }
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
const initializationPromise = (async function initializeDatabaseScripts() {
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

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
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

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS project_action_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      create_project INTEGER NOT NULL DEFAULT 1,
      edit_project INTEGER NOT NULL DEFAULT 1,
      delete_project INTEGER NOT NULL DEFAULT 0,
      create_task INTEGER NOT NULL DEFAULT 1,
      edit_task INTEGER NOT NULL DEFAULT 1,
      delete_task INTEGER NOT NULL DEFAULT 0,
      complete_task INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      assignee_id INTEGER REFERENCES users(id),
      due_date TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      customer_name TEXT DEFAULT '',
      total_amount REAL NOT NULL DEFAULT 0,
      payment_member_id INTEGER REFERENCES users(id),
      payment_status TEXT NOT NULL DEFAULT 'not_received',
      payment_received_date TEXT,
      amount_received REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );`);
    const taskSchemaColumns = await dbDriverInterface.prepare('PRAGMA table_info(tasks)').all();
    const taskSchemaColumnNames = (taskSchemaColumns || []).map(row => row.name || row.NAME);
    if (!taskSchemaColumnNames.includes('invoice_number')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN invoice_number TEXT');
    if (!taskSchemaColumnNames.includes('invoice_date')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN invoice_date TEXT');
    if (!taskSchemaColumnNames.includes('customer_name')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''");
    if (!taskSchemaColumnNames.includes('total_amount')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN total_amount REAL NOT NULL DEFAULT 0');
    if (!taskSchemaColumnNames.includes('payment_member_id')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN payment_member_id INTEGER REFERENCES users(id)');
    if (!taskSchemaColumnNames.includes('payment_status')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'not_received'");
    if (!taskSchemaColumnNames.includes('payment_received_date')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN payment_received_date TEXT');
    if (!taskSchemaColumnNames.includes('amount_received')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN amount_received REAL NOT NULL DEFAULT 0');

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
      attachment_name TEXT,
      attachment_type TEXT,
      edited_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const commentColumns = await dbDriverInterface.prepare('PRAGMA table_info(comments)').all();
    if (!(commentColumns || []).some(row => (row.name || row.NAME) === 'edited_at')) {
      await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN edited_at TEXT');
    }

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

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      telegram_message_id INTEGER,
      distance_meters REAL NOT NULL DEFAULT 0,
      place_changed INTEGER NOT NULL DEFAULT 0
    );`);
    const locationColumns = await dbDriverInterface.prepare('PRAGMA table_info(attendance_locations)').all();
    const locationColumnNames = (locationColumns || []).map(row => row.name || row.NAME);
    if (!locationColumnNames.includes('distance_meters')) await dbDriverInterface.exec('ALTER TABLE attendance_locations ADD COLUMN distance_meters REAL NOT NULL DEFAULT 0');
    if (!locationColumnNames.includes('place_changed')) await dbDriverInterface.exec('ALTER TABLE attendance_locations ADD COLUMN place_changed INTEGER NOT NULL DEFAULT 0');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS tracking_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id),
      granted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_verification_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled_by INTEGER REFERENCES users(id),
      enabled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_device_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      allow_phone INTEGER NOT NULL DEFAULT 1,
      allow_laptop INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      receipt_paths TEXT,
      receipt_meta TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const reimbursementColumns = await dbDriverInterface.prepare('PRAGMA table_info(reimbursements)').all();
    const reimbursementColumnNames = (reimbursementColumns || []).map(row => row.name || row.NAME);
    if (!reimbursementColumnNames.includes('receipt_paths')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN receipt_paths TEXT');
    if (!reimbursementColumnNames.includes('receipt_meta')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN receipt_meta TEXT');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS reimbursement_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      approval_level INTEGER NOT NULL DEFAULT 0,
      can_pay INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS payment_history_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      granted_by INTEGER REFERENCES users(id),
      granted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id),
      subject_user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    try {
      const activityColumns = await dbDriverInterface.prepare('PRAGMA table_info(activity_log)').all();
      if (!(activityColumns || []).some(row => (row.name || row.NAME) === 'subject_user_id')) {
        await dbDriverInterface.exec('ALTER TABLE activity_log ADD COLUMN subject_user_id INTEGER REFERENCES users(id)');
      }
    } catch (migrationError) {
      console.error('Activity log migration warning:', migrationError.message);
    }

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS telegram_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );`);
    const attachmentColumns = await dbDriverInterface.prepare('PRAGMA table_info(telegram_attachments)').all();
    const attachmentColumnNames = (attachmentColumns || []).map(row => row.name || row.NAME);
    if (!attachmentColumnNames.includes('original_name')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN original_name TEXT');
    if (!attachmentColumnNames.includes('mime_type')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN mime_type TEXT');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id),
      field_name TEXT NOT NULL,
      old_value TEXT NOT NULL DEFAULT '',
      new_value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    console.log("✅ Cloud tables initialized. Running migrations and seeds...");

    const rawUserPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(users)").all();
    const userColumns = (rawUserPragmaRows || []).map(row => row.name || row.NAME);
    if (!userColumns.includes('department')) {
      await dbDriverInterface.exec("ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT ''");
      console.log('Migrated: added users.department column');
    }
    if (!userColumns.includes('active')) {
      await dbDriverInterface.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
      console.log('Migrated: added users.active column');
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
    if (!commentCols.includes('attachment_name')) {
      try {
        await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN attachment_name TEXT');
        console.log('Migrated: added comments.attachment_name column');
      } catch (colErr) {
        // pass
      }
    }
    if (!commentCols.includes('attachment_type')) {
      try {
        await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN attachment_type TEXT');
        console.log('Migrated: added comments.attachment_type column');
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
    const defaults = { office_lat: '', office_lng: '', office_radius_m: '150', attendance_verification_enabled: 'false' };
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

dbDriverInterface.ready = initializationPromise;

module.exports = dbDriverInterface;
