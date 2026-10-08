'use strict';

const bcrypt = require('bcryptjs');

function createDbDriverInterface(db, companyId) {
  return {
  exec: async (sql) => {
    try { return await db.execute(sql); } catch(e) {
      console.error(JSON.stringify({ event: 'tenant_schema_exec_failed', company_id: companyId ?? null }));
      throw e;
    }
  },
  batch: async statements => db.batch(statements, 'write'),
  prepare: (sql) => {
    return {
      get: async (...params) => {
        const res = await db.execute({ sql, args: params });
        return res.rows && res.rows.length > 0 ? res.rows[0] : null;
      },
      all: async (...params) => {
        const res = await db.execute({ sql, args: params });
        return res.rows || [];
      },
      run: async (...params) => {
        try {
          const res = await db.execute({ sql, args: params });
          return { lastInsertRowid: res.lastInsertRowid ? Number(res.lastInsertRowid) : null, changes: res.rowsAffected || 0 };
        } catch(err) {
          console.error(JSON.stringify({ event: 'tenant_schema_run_failed', company_id: companyId ?? null }));
          throw err;
        }
      }
    };
  }
  };
}

async function initTenantSchema(db, { seedInitialAdmin = true, companyId = null } = {}) {
  const dbDriverInterface = createDbDriverInterface(db, companyId);
  try {
    await db.execute('SELECT 1');
    await db.execute('PRAGMA foreign_keys = ON');
    
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      department TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      web_access_enabled INTEGER NOT NULL DEFAULT 0 CHECK (web_access_enabled IN (0, 1)),
      email TEXT,
      date_of_birth TEXT,
      phone TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
      google_sub TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'password' CHECK (auth_provider IN ('password', 'google', 'email')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const duplicateUsername = await dbDriverInterface.prepare(`SELECT lower(trim(username)) AS normalized_username, COUNT(*) AS duplicate_count
      FROM users GROUP BY lower(trim(username)) HAVING COUNT(*) > 1 LIMIT 1`).get();
    if (duplicateUsername) {
      throw new Error(`Cannot enforce unique usernames until duplicate account "${duplicateUsername.normalized_username}" is resolved.`);
    }
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users(lower(trim(username)))');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const schemaVersionRow = await dbDriverInterface.prepare('SELECT MAX(version) AS version FROM schema_version').get();
    let schemaVersion = Number(schemaVersionRow?.version || 0);
    const needsSchemaUpgrade = schemaVersion < 3;
    const markSchemaVersion = async version => {
      await dbDriverInterface.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
      schemaVersion = Math.max(schemaVersion, version);
    };

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      user_id INTEGER,
      expires_at INTEGER NOT NULL
    );`);
    if (needsSchemaUpgrade) {
      const sessionColumns = await dbDriverInterface.prepare('PRAGMA table_info(web_sessions)').all();
      if (!sessionColumns.some(row => row.name === 'user_id')) {
        await dbDriverInterface.exec('ALTER TABLE web_sessions ADD COLUMN user_id INTEGER');
      }
    }
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx ON web_sessions(expires_at)');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const duplicateDepartments = await dbDriverInterface.prepare(`SELECT lower(trim(name)) AS normalized_name, COUNT(*) AS duplicate_count
      FROM departments GROUP BY lower(trim(name)) HAVING COUNT(*) > 1 LIMIT 1`).get();
    if (duplicateDepartments) {
      throw new Error(`Cannot enforce case-insensitive department names until duplicate department "${duplicateDepartments.normalized_name}" is resolved.`);
    }
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS departments_name_lower_unique ON departments(lower(trim(name)))');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin_hash TEXT,
      created_by INTEGER REFERENCES users(id),
      asana_gid TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    if (needsSchemaUpgrade) {
      const projectColumns = await dbDriverInterface.prepare('PRAGMA table_info(projects)').all();
      if (!projectColumns.some(row => row.name === 'asana_gid')) {
        await dbDriverInterface.exec('ALTER TABLE projects ADD COLUMN asana_gid TEXT');
      }
    }
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS projects_asana_gid_unique ON projects(asana_gid) WHERE asana_gid IS NOT NULL');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, user_id)
    );`);
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS project_members_user_id_idx ON project_members(user_id)');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS project_action_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      create_project INTEGER NOT NULL DEFAULT 1,
      edit_project INTEGER NOT NULL DEFAULT 1,
      delete_project INTEGER NOT NULL DEFAULT 0,
      create_task INTEGER NOT NULL DEFAULT 1,
      edit_task INTEGER NOT NULL DEFAULT 1,
      delete_task INTEGER NOT NULL DEFAULT 0,
      complete_task INTEGER NOT NULL DEFAULT 1,
      manage_task_work_mode INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    if (needsSchemaUpgrade) {
      const actionAccessColumns = await dbDriverInterface.prepare('PRAGMA table_info(project_action_access)').all();
      if (!actionAccessColumns.some(row => row.name === 'manage_task_work_mode')) {
        await dbDriverInterface.exec('ALTER TABLE project_action_access ADD COLUMN manage_task_work_mode INTEGER NOT NULL DEFAULT 0');
      }
    }

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      no_billing_required INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      assignee_id INTEGER REFERENCES users(id),
      due_date TEXT,
      invoice_type TEXT NOT NULL DEFAULT 'gst',
      invoice_number TEXT,
      invoice_date TEXT,
      customer_name TEXT NOT NULL DEFAULT '',
      total_amount REAL NOT NULL DEFAULT 0,
      payment_member_id INTEGER REFERENCES users(id),
      payment_status TEXT NOT NULL DEFAULT 'not_received',
      payment_received_date TEXT,
      amount_received REAL NOT NULL DEFAULT 0,
      asana_assignee_name TEXT,
      work_mode TEXT NOT NULL DEFAULT 'office',
      status TEXT NOT NULL DEFAULT 'open',
      position INTEGER NOT NULL DEFAULT 0,
      asana_gid TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );`);
    if (needsSchemaUpgrade) {
    const taskSchemaColumns = await dbDriverInterface.prepare('PRAGMA table_info(tasks)').all();
    const taskSchemaColumnNames = (taskSchemaColumns || []).map(row => row.name);
    if (!taskSchemaColumnNames.includes('asana_gid')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN asana_gid TEXT');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS tasks_project_id_id_idx ON tasks(project_id, id)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS tasks_assignee_id_idx ON tasks(assignee_id)');
    if (!taskSchemaColumnNames.includes('asana_assignee_name')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN asana_assignee_name TEXT');
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_asana_gid_unique ON tasks(project_id, asana_gid) WHERE asana_gid IS NOT NULL');
    if (!taskSchemaColumnNames.includes('no_billing_required')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN no_billing_required INTEGER NOT NULL DEFAULT 0');
    if (!taskSchemaColumnNames.includes('invoice_type')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'gst'");
    if (!taskSchemaColumnNames.includes('invoice_number')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN invoice_number TEXT');
    if (!taskSchemaColumnNames.includes('invoice_date')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN invoice_date TEXT');
    if (!taskSchemaColumnNames.includes('customer_name')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''");
    if (!taskSchemaColumnNames.includes('total_amount')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN total_amount REAL NOT NULL DEFAULT 0');
    if (!taskSchemaColumnNames.includes('payment_member_id')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN payment_member_id INTEGER REFERENCES users(id)');
    if (!taskSchemaColumnNames.includes('payment_status')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'not_received'");
    if (!taskSchemaColumnNames.includes('payment_received_date')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN payment_received_date TEXT');
    if (!taskSchemaColumnNames.includes('amount_received')) await dbDriverInterface.exec('ALTER TABLE tasks ADD COLUMN amount_received REAL NOT NULL DEFAULT 0');
    if (!taskSchemaColumnNames.includes('work_mode')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN work_mode TEXT NOT NULL DEFAULT 'office'");
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project_position_created ON tasks(project_id, position, created_at)');
    }

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS task_checkin_users (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, user_id)
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS task_checkin_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled_by INTEGER REFERENCES users(id),
      enabled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS task_work_mode_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled_by INTEGER REFERENCES users(id),
      enabled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS task_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      check_in_at TEXT NOT NULL,
      check_in_lat REAL,
      check_in_lng REAL,
      check_out_at TEXT,
      check_out_lat REAL,
      check_out_lng REAL
    );`);
    if (needsSchemaUpgrade) {
    const taskCheckinIndexes = await dbDriverInterface.prepare('PRAGMA index_list(task_checkins)').all();
    const taskCheckinColumns = await dbDriverInterface.prepare('PRAGMA table_info(task_checkins)').all();
    const requiredLocationColumns = taskCheckinColumns.filter(column => ['check_in_lat', 'check_in_lng'].includes(column.name));
    let needsCheckinRebuild = requiredLocationColumns.some(column => Number(column.notnull) === 1);
    for (const index of taskCheckinIndexes.filter(row => Number(row.unique) === 1 && row.name !== 'task_checkins_one_open_per_user')) {
      const quotedIndexName = `"${String(index.name).replace(/"/g, '""')}"`;
      const indexedColumns = await dbDriverInterface.prepare(`PRAGMA index_info(${quotedIndexName})`).all();
      const names = indexedColumns.map(column => column.name).sort();
      if (names.length === 2 && names[0] === 'task_id' && names[1] === 'user_id') needsCheckinRebuild = true;
    }
    if (needsCheckinRebuild) {
      await dbDriverInterface.batch([
        { sql: `CREATE TABLE task_checkins_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        check_in_at TEXT NOT NULL,
        check_in_lat REAL,
        check_in_lng REAL,
        check_out_at TEXT,
        check_out_lat REAL,
        check_out_lng REAL
      );` },
        { sql: `INSERT INTO task_checkins_rebuilt
        (id, task_id, user_id, check_in_at, check_in_lat, check_in_lng, check_out_at, check_out_lat, check_out_lng)
        SELECT id, task_id, user_id, check_in_at, check_in_lat, check_in_lng, check_out_at, check_out_lat, check_out_lng
        FROM task_checkins` },
        { sql: 'DROP TABLE task_checkins' },
        { sql: 'ALTER TABLE task_checkins_rebuilt RENAME TO task_checkins' }
      ]);
    }
    }
    const duplicateOpenCheckin = await dbDriverInterface.prepare(`SELECT task_id, user_id, COUNT(*) AS duplicate_count
      FROM task_checkins WHERE check_out_at IS NULL GROUP BY task_id, user_id HAVING COUNT(*) > 1 LIMIT 1`).get();
    if (duplicateOpenCheckin) {
      throw new Error(`Close duplicate open task check-ins for task ${duplicateOpenCheckin.task_id}, user ${duplicateOpenCheckin.user_id} before startup.`);
    }
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS task_checkins_one_open_per_user ON task_checkins(task_id, user_id) WHERE check_out_at IS NULL');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS task_checkins_task_id_idx ON task_checkins(task_id)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS task_checkins_user_checkin_idx ON task_checkins(user_id, check_in_at)');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );`);
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS subtasks_task_position_idx ON subtasks(task_id, position)');

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      author_name TEXT,
      body TEXT NOT NULL DEFAULT '',
      image_path TEXT,
      attachment_name TEXT,
      attachment_type TEXT,
      edited_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    if (needsSchemaUpgrade) {
      const commentColumns = await dbDriverInterface.prepare('PRAGMA table_info(comments)').all();
      if (!commentColumns.some(row => row.name === 'edited_at')) {
        await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN edited_at TEXT');
      }
      if (!commentColumns.some(row => row.name === 'author_name')) {
        await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN author_name TEXT');
      }
    }
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS comments_task_activity_idx ON comments(task_id, created_at, id)');

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
      in_device_type TEXT,
      in_device_info TEXT,
      out_device_type TEXT,
      out_device_info TEXT,
      location_status TEXT,
      notes TEXT
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      latitude REAL,
      longitude REAL,
      telegram_message_id INTEGER,
      distance_meters REAL NOT NULL DEFAULT 0,
      place_changed INTEGER NOT NULL DEFAULT 0,
      activity_type TEXT NOT NULL DEFAULT 'unknown',
      activity_confidence INTEGER NOT NULL DEFAULT 0
    );`);
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_tracking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      state TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    );`);
    if (needsSchemaUpgrade) {
    const locationColumns = await dbDriverInterface.prepare('PRAGMA table_info(attendance_locations)').all();
    const locationColumnNames = (locationColumns || []).map(row => row.name);
    if (!locationColumnNames.includes('distance_meters')) await dbDriverInterface.exec('ALTER TABLE attendance_locations ADD COLUMN distance_meters REAL NOT NULL DEFAULT 0');
    if (!locationColumnNames.includes('place_changed')) await dbDriverInterface.exec('ALTER TABLE attendance_locations ADD COLUMN place_changed INTEGER NOT NULL DEFAULT 0');
    const attendanceLocationColumnsNeedingRebuild = (locationColumns || []).filter(column => ['latitude', 'longitude'].includes(column.name));
    if (attendanceLocationColumnsNeedingRebuild.some(column => Number(column.notnull ?? column.NOTNULL) === 1)) {
      await dbDriverInterface.exec(`CREATE TABLE attendance_locations_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        latitude REAL,
        longitude REAL,
        telegram_message_id INTEGER,
        distance_meters REAL NOT NULL DEFAULT 0,
        place_changed INTEGER NOT NULL DEFAULT 0,
        activity_type TEXT NOT NULL DEFAULT 'unknown',
        activity_confidence INTEGER NOT NULL DEFAULT 0
      );`);
      await dbDriverInterface.exec(`INSERT INTO attendance_locations_rebuilt
        (id, attendance_id, user_id, recorded_at, latitude, longitude, telegram_message_id, distance_meters, place_changed)
        SELECT id, attendance_id, user_id, recorded_at, latitude, longitude, telegram_message_id, distance_meters, place_changed
        FROM attendance_locations`);
      await dbDriverInterface.exec('DROP TABLE attendance_locations');
      await dbDriverInterface.exec('ALTER TABLE attendance_locations_rebuilt RENAME TO attendance_locations');
    }
    }
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_locations_attendance_id_idx ON attendance_locations(attendance_id)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_locations_recorded_at_idx ON attendance_locations(recorded_at)');

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
      allow_mobile_browser INTEGER NOT NULL DEFAULT 0,
      allow_laptop INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const attendanceDeviceAccessColumns = await dbDriverInterface.prepare('PRAGMA table_info(attendance_device_access)').all();
    if (!attendanceDeviceAccessColumns.some(column => column.name === 'allow_mobile_browser')) {
      await dbDriverInterface.exec('ALTER TABLE attendance_device_access ADD COLUMN allow_mobile_browser INTEGER NOT NULL DEFAULT 0');
    }

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_registered_devices (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      device_token_hash TEXT NOT NULL,
      device_name TEXT NOT NULL,
      device_info TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_device_rebind_pending (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      reset_by INTEGER REFERENCES users(id),
      reset_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS reimbursements_user_status_idx ON reimbursements(user_id, status)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS reimbursements_expense_date_idx ON reimbursements(expense_date)');
    const reimbursementColumns = await dbDriverInterface.prepare('PRAGMA table_info(reimbursements)').all();
    const reimbursementColumnNames = reimbursementColumns.map(row => row.name);
    if (!reimbursementColumnNames.includes('receipt_paths')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN receipt_paths TEXT');
    if (!reimbursementColumnNames.includes('receipt_meta')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN receipt_meta TEXT');
    if (!reimbursementColumnNames.includes('approved_level_1_by')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN approved_level_1_by INTEGER REFERENCES users(id)');
    if (!reimbursementColumnNames.includes('approved_by')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN approved_by INTEGER REFERENCES users(id)');
    if (!reimbursementColumnNames.includes('paid_by')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN paid_by INTEGER REFERENCES users(id)');
    if (!reimbursementColumnNames.includes('paid_at')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN paid_at TEXT');
    if (!reimbursementColumnNames.includes('submission_key')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN submission_key TEXT');
    if (!reimbursementColumnNames.includes('edited_at')) await dbDriverInterface.exec('ALTER TABLE reimbursements ADD COLUMN edited_at TEXT');
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS reimbursements_submission_key_unique ON reimbursements(submission_key) WHERE submission_key IS NOT NULL');

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
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_created_id ON activity_log(created_at DESC, id DESC)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_actor_id ON activity_log(actor_id, id DESC)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_subject_user_id ON activity_log(subject_user_id, id DESC)');
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS activity_notification_recipients (
      activity_id INTEGER NOT NULL REFERENCES activity_log(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (activity_id, user_id)
    );`);
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS activity_notification_recipients_user_idx ON activity_notification_recipients(user_id, activity_id DESC)');
    if (needsSchemaUpgrade) {
      const activityColumns = await dbDriverInterface.prepare('PRAGMA table_info(activity_log)').all();
      if (!activityColumns.some(row => row.name === 'subject_user_id')) {
        await dbDriverInterface.exec('ALTER TABLE activity_log ADD COLUMN subject_user_id INTEGER REFERENCES users(id)');
      }
    }

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS telegram_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      uploaded_by INTEGER,
      task_id INTEGER,
      reimbursement_id INTEGER,
      file_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      delete_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      failed_at TEXT
    );`);
    if (needsSchemaUpgrade) {
    const attachmentColumns = await dbDriverInterface.prepare('PRAGMA table_info(telegram_attachments)').all();
    const attachmentColumnNames = (attachmentColumns || []).map(row => row.name);
    if (!attachmentColumnNames.includes('original_name')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN original_name TEXT');
    if (!attachmentColumnNames.includes('mime_type')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN mime_type TEXT');
    if (!attachmentColumnNames.includes('uploaded_by')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN uploaded_by INTEGER');
    if (!attachmentColumnNames.includes('task_id')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN task_id INTEGER');
    if (!attachmentColumnNames.includes('reimbursement_id')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN reimbursement_id INTEGER');
    if (!attachmentColumnNames.includes('delete_attempts')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0');
    if (!attachmentColumnNames.includes('last_error')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN last_error TEXT');
    if (!attachmentColumnNames.includes('failed_at')) await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN failed_at TEXT');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS telegram_attachments_task_id_idx ON telegram_attachments(task_id)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS telegram_attachments_reimbursement_id_idx ON telegram_attachments(reimbursement_id)');
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS telegram_attachments_deleted_created_idx ON telegram_attachments(deleted_at, created_at)');

    const legacyCommentAttachments = await dbDriverInterface.prepare("SELECT task_id, user_id, image_path FROM comments WHERE image_path LIKE '/api/download/%'").all();
    for (const comment of legacyCommentAttachments || []) {
      const match = String(comment.image_path || '').match(/^\/api\/download\/([^/?#]+)/);
      if (!match) continue;
      let fileId;
      try { fileId = decodeURIComponent(match[1]); } catch (error) {
        console.warn('Skipping a legacy attachment with an invalid encoded file id.');
        continue;
      }
      await dbDriverInterface.prepare(`UPDATE telegram_attachments
        SET uploaded_by = COALESCE(uploaded_by, ?), task_id = COALESCE(task_id, ?)
        WHERE file_id = ? AND task_id IS NULL AND reimbursement_id IS NULL`)
        .run(comment.user_id || null, comment.task_id, fileId);
    }

    const legacyClaims = await dbDriverInterface.prepare('SELECT id, user_id, receipt_path, receipt_paths FROM reimbursements WHERE receipt_path IS NOT NULL OR receipt_paths IS NOT NULL').all();
    for (const claim of legacyClaims || []) {
      let receiptPaths = [];
      try { receiptPaths = claim.receipt_paths ? JSON.parse(claim.receipt_paths) : []; } catch (error) {
        console.warn(`Skipping malformed legacy receipt paths for reimbursement ${claim.id}.`);
        receiptPaths = [];
      }
      if (!Array.isArray(receiptPaths)) receiptPaths = [];
      if (claim.receipt_path && !receiptPaths.includes(claim.receipt_path)) receiptPaths.unshift(claim.receipt_path);
      for (const receiptPath of receiptPaths) {
        if (typeof receiptPath !== 'string' || !receiptPath.startsWith('telegram:')) continue;
        await dbDriverInterface.prepare(`UPDATE telegram_attachments
          SET uploaded_by = COALESCE(uploaded_by, ?), reimbursement_id = COALESCE(reimbursement_id, ?)
          WHERE file_id = ? AND task_id IS NULL AND reimbursement_id IS NULL`)
          .run(claim.user_id, claim.id, receiptPath.slice('telegram:'.length));
      }
    }
    }

    const currentAttachmentColumns = await dbDriverInterface.prepare('PRAGMA table_info(telegram_attachments)').all();
    if (!currentAttachmentColumns.some(row => row.name === 'file_size')) {
      await dbDriverInterface.exec('ALTER TABLE telegram_attachments ADD COLUMN file_size INTEGER');
    }
    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS file_usage (
      file_reference TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    await dbDriverInterface.exec(`CREATE TRIGGER IF NOT EXISTS telegram_file_usage_insert
      AFTER INSERT ON telegram_attachments
      WHEN NEW.deleted_at IS NULL AND NEW.file_size IS NOT NULL
      BEGIN
        INSERT OR REPLACE INTO file_usage (file_reference, bytes)
        VALUES ('telegram:' || NEW.message_id, NEW.file_size);
      END;`);
    await dbDriverInterface.exec(`CREATE TRIGGER IF NOT EXISTS telegram_file_usage_update
      AFTER UPDATE OF deleted_at, file_size, message_id ON telegram_attachments
      BEGIN
        DELETE FROM file_usage WHERE file_reference = 'telegram:' || OLD.message_id;
        INSERT OR REPLACE INTO file_usage (file_reference, bytes)
        SELECT 'telegram:' || NEW.message_id, NEW.file_size
        WHERE NEW.deleted_at IS NULL AND NEW.file_size IS NOT NULL;
      END;`);
    await dbDriverInterface.exec(`CREATE TRIGGER IF NOT EXISTS telegram_file_usage_delete
      AFTER DELETE ON telegram_attachments
      BEGIN
        DELETE FROM file_usage WHERE file_reference = 'telegram:' || OLD.message_id;
      END;`);

    await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id),
      author_name TEXT,
      field_name TEXT NOT NULL,
      old_value TEXT NOT NULL DEFAULT '',
      new_value TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    if (needsSchemaUpgrade) {
      const taskHistoryColumns = await dbDriverInterface.prepare('PRAGMA table_info(task_history)').all();
      if (!taskHistoryColumns.some(row => row.name === 'author_name')) {
        await dbDriverInterface.exec('ALTER TABLE task_history ADD COLUMN author_name TEXT');
      }
    }
    await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS task_history_task_activity_idx ON task_history(task_id, created_at, id)');

    if (needsSchemaUpgrade) console.log('Applying database schema upgrades.');

    if (needsSchemaUpgrade) {
    const rawUserPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(users)").all();
    const userColumns = rawUserPragmaRows.map(row => row.name);
    if (!userColumns.includes('must_change_password')) {
      await dbDriverInterface.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
      console.log('Migrated: added users.must_change_password column');
    }
    const adminAccounts = await dbDriverInterface.prepare("SELECT id, password_hash FROM users WHERE role = 'admin'").all();
    for (const admin of adminAccounts) {
      if (bcrypt.compareSync('admin123', String(admin.password_hash || ''))) {
        await dbDriverInterface.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(admin.id);
      }
    }
    if (!userColumns.includes('department')) {
      await dbDriverInterface.exec("ALTER TABLE users ADD COLUMN department TEXT NOT NULL DEFAULT ''");
      console.log('Migrated: added users.department column');
    }
    if (!userColumns.includes('active')) {
      await dbDriverInterface.exec("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
      console.log('Migrated: added users.active column');
    }
    if (!userColumns.includes('token_version')) {
      await dbDriverInterface.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
      console.log('Migrated: added users.token_version column');
    }
    await dbDriverInterface.exec('UPDATE users SET active = 0 WHERE active IS NULL');
    await dbDriverInterface.exec('UPDATE users SET token_version = 0 WHERE token_version IS NULL');
    const departmentMigration = await dbDriverInterface.prepare("SELECT value FROM settings WHERE key = '_legacy_departments_migrated'").get();
    if (schemaVersion < 1 && !departmentMigration) {
      await dbDriverInterface.exec("INSERT OR IGNORE INTO departments (name) SELECT DISTINCT trim(department) FROM users WHERE trim(department) <> ''");
      await dbDriverInterface.prepare("INSERT INTO settings (key, value) VALUES ('_legacy_departments_migrated', '1') ON CONFLICT(key) DO NOTHING").run();
    }
    if (schemaVersion < 1) await markSchemaVersion(1);
    }

    if (needsSchemaUpgrade) {
    const rawAttendancePragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(attendance)").all();
    const attendanceColumns = rawAttendancePragmaRows.map(row => row.name);
    if (!attendanceColumns.includes('in_location_text')) {
      await dbDriverInterface.exec("ALTER TABLE attendance ADD COLUMN in_location_text TEXT");
    }
    if (!attendanceColumns.includes('out_location_text')) {
      await dbDriverInterface.exec("ALTER TABLE attendance ADD COLUMN out_location_text TEXT");
    }
    if (!attendanceColumns.includes('in_device_type')) await dbDriverInterface.exec('ALTER TABLE attendance ADD COLUMN in_device_type TEXT');
    if (!attendanceColumns.includes('in_device_info')) await dbDriverInterface.exec('ALTER TABLE attendance ADD COLUMN in_device_info TEXT');
    if (!attendanceColumns.includes('out_device_type')) await dbDriverInterface.exec('ALTER TABLE attendance ADD COLUMN out_device_type TEXT');
    if (!attendanceColumns.includes('out_device_info')) await dbDriverInterface.exec('ALTER TABLE attendance ADD COLUMN out_device_info TEXT');
    }

    const attendanceMergeMarker = schemaVersion >= 2;
    const duplicateAttendanceDays = attendanceMergeMarker ? [] : await dbDriverInterface.prepare(`SELECT user_id, date
      FROM attendance GROUP BY user_id, date HAVING COUNT(*) > 1`).all();
    for (const duplicateDay of duplicateAttendanceDays) {
      const records = await dbDriverInterface.prepare(`SELECT * FROM attendance
        WHERE user_id = ? AND date = ? ORDER BY id`).all(duplicateDay.user_id, duplicateDay.date);
      if (records.length < 2) continue;
      const earliestPunchIn = records.filter(record => record.punch_in).sort((left, right) => String(left.punch_in).localeCompare(String(right.punch_in)))[0] || records[0];
      const latestPunchOut = records.filter(record => record.punch_out).sort((left, right) => String(right.punch_out).localeCompare(String(left.punch_out)))[0] || records[0];
      const notes = [...new Set(records.flatMap(record => String(record.notes || '').split('\n').map(note => note.trim()).filter(Boolean)))].join('\n') || null;
      const locationStatus = [...records].reverse().find(record => record.location_status)?.location_status || null;
      const keepId = records[0].id;
      const statements = [{ sql: `UPDATE attendance SET punch_in = ?, in_lat = ?, in_lng = ?,
        in_location_text = ?, in_device_type = ?, in_device_info = ?, punch_out = ?, out_lat = ?, out_lng = ?,
        out_location_text = ?, out_device_type = ?, out_device_info = ?, location_status = ?, notes = ?
        WHERE id = ?`, args: [
          earliestPunchIn.punch_in, earliestPunchIn.in_lat, earliestPunchIn.in_lng,
          earliestPunchIn.in_location_text, earliestPunchIn.in_device_type, earliestPunchIn.in_device_info,
          latestPunchOut.punch_out, latestPunchOut.out_lat, latestPunchOut.out_lng,
          latestPunchOut.out_location_text, latestPunchOut.out_device_type, latestPunchOut.out_device_info,
          locationStatus, notes, keepId
        ] }];
      for (const duplicate of records.slice(1)) {
        statements.push(
          { sql: 'UPDATE attendance_locations SET attendance_id = ? WHERE attendance_id = ?', args: [keepId, duplicate.id] },
          { sql: "UPDATE activity_log SET entity_id = ? WHERE entity_type = 'attendance' AND entity_id = ?", args: [keepId, duplicate.id] },
          { sql: 'DELETE FROM attendance WHERE id = ?', args: [duplicate.id] }
        );
      }
      await dbDriverInterface.batch(statements);
    }
    if (!attendanceMergeMarker) await markSchemaVersion(2);
    await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS attendance_user_date_unique ON attendance (user_id, date)');

    if (needsSchemaUpgrade) {
    const rawTaskPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(tasks)").all();
    const taskColumns = rawTaskPragmaRows.map(row => row.name);
    if (!taskColumns.includes('created_by')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id)");
    if (!taskColumns.includes('updated_at')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT");
    await dbDriverInterface.exec("UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL");
    if (!taskColumns.includes('completed_at')) await dbDriverInterface.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");

    const rawPragmaRows = await dbDriverInterface.prepare("PRAGMA table_info(comments)").all();
    const commentCols = [];
    if (Array.isArray(rawPragmaRows)) {
      rawPragmaRows.forEach(row => {
        if (row) {
          const columnName = row.name;
          if (columnName) commentCols.push(columnName);
        }
      });
    }

    if (!commentCols.includes('image_path')) {
      await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN image_path TEXT');
      console.log('Migrated: added comments.image_path column');
    }
    if (!commentCols.includes('attachment_name')) {
      await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN attachment_name TEXT');
      console.log('Migrated: added comments.attachment_name column');
    }
    if (!commentCols.includes('attachment_type')) {
      await dbDriverInterface.exec('ALTER TABLE comments ADD COLUMN attachment_type TEXT');
      console.log('Migrated: added comments.attachment_type column');
    }
    }

    if (needsSchemaUpgrade) {
      const projectsToSeed = await dbDriverInterface.prepare('SELECT id, created_by FROM projects WHERE created_by IS NOT NULL').all();
      const seedMember = dbDriverInterface.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)');
      for (const project of projectsToSeed) {
        if (project.id && project.created_by) await seedMember.run(project.id, project.created_by);
      }
    }

    const usersCountObj = await dbDriverInterface.prepare('SELECT COUNT(*) as c FROM users').get();
    const totalUsers = Number(usersCountObj?.c ?? 0);
    
    if (seedInitialAdmin && (!totalUsers || totalUsers === 0)) {
      const initialPassword = String(process.env.INITIAL_ADMIN_PASSWORD || '');
      if (Buffer.byteLength(initialPassword, 'utf8') < 10 || Buffer.byteLength(initialPassword, 'utf8') > 72) {
        throw new Error('INITIAL_ADMIN_PASSWORD must contain between 10 and 72 UTF-8 bytes before creating the initial admin account.');
      }
      const hash = bcrypt.hashSync(initialPassword, 10);
      const result = await dbDriverInterface.prepare(`INSERT INTO users (name, username, password_hash, role, active, must_change_password, web_access_enabled)
        SELECT ?, ?, ?, 'admin', 1, 1, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`)
        .run('Admin', 'admin', hash);
      if (result.changes) {
        console.log('Initial admin created from INITIAL_ADMIN_PASSWORD. Change it at first login.');
      }
    }

    const defaults = {
      office_lat: '',
      office_lng: '',
      office_radius_m: '150',
      attendance_verification_enabled: 'false',
      attachment_retention_days: '0',
      attendance_location_retention_days: '90'
    };
    await dbDriverInterface.batch(Object.entries(defaults).map(([key, value]) => ({
      sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      args: [key, value]
    })));
    if (needsSchemaUpgrade) await markSchemaVersion(3);
    if (schemaVersion < 4) {
      const userColumns = await dbDriverInterface.prepare('PRAGMA table_info(users)').all();
      const existingUserColumns = new Set(userColumns.map(column => column.name));
      const emailColumns = [
        ['email', 'ALTER TABLE users ADD COLUMN email TEXT'],
        ['email_verified', 'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1))'],
        ['google_sub', 'ALTER TABLE users ADD COLUMN google_sub TEXT'],
        ['auth_provider', "ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password' CHECK (auth_provider IN ('password', 'google', 'email'))"]
      ];
      for (const [column, statement] of emailColumns) {
        if (!existingUserColumns.has(column)) await dbDriverInterface.exec(statement);
      }
      await dbDriverInterface.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users(lower(trim(email))) WHERE email IS NOT NULL AND trim(email) <> ''");
      await dbDriverInterface.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL');
      await markSchemaVersion(4);
    }
    if (schemaVersion < 5) {
      await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS email_auth_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
        email TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS email_auth_tokens_user_purpose_idx ON email_auth_tokens(user_id, purpose)');
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS email_auth_tokens_expiry_idx ON email_auth_tokens(expires_at)');
      await markSchemaVersion(5);
    }
    if (schemaVersion < 6) {
      const userColumns = await dbDriverInterface.prepare('PRAGMA table_info(users)').all();
      const existingUserColumns = new Set(userColumns.map(column => column.name));
      if (!existingUserColumns.has('date_of_birth')) await dbDriverInterface.exec('ALTER TABLE users ADD COLUMN date_of_birth TEXT');
      if (!existingUserColumns.has('phone')) await dbDriverInterface.exec('ALTER TABLE users ADD COLUMN phone TEXT');
      await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS email_login_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('login', 'enrollment')),
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS email_login_otps_user_purpose_idx ON email_login_otps(user_id, purpose, consumed_at)');
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS email_login_otps_expiry_idx ON email_login_otps(expires_at)');
      await markSchemaVersion(6);
    }
    if (schemaVersion < 7) {
      const locationColumns = await dbDriverInterface.prepare('PRAGMA table_info(attendance_locations)').all();
      const existingLocationColumns = new Set(locationColumns.map(column => column.name));
      if (!existingLocationColumns.has('activity_type')) await dbDriverInterface.exec("ALTER TABLE attendance_locations ADD COLUMN activity_type TEXT NOT NULL DEFAULT 'unknown'");
      if (!existingLocationColumns.has('activity_confidence')) await dbDriverInterface.exec('ALTER TABLE attendance_locations ADD COLUMN activity_confidence INTEGER NOT NULL DEFAULT 0');
      await markSchemaVersion(7);
    }
    if (schemaVersion < 8) {
      await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS push_notification_tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS push_notification_tokens_user_idx ON push_notification_tokens(user_id)');
      await markSchemaVersion(8);
    }
    if (schemaVersion < 9) {
      const userColumns = await dbDriverInterface.prepare('PRAGMA table_info(users)').all();
      if (!userColumns.some(column => column.name === 'web_access_enabled')) {
        await dbDriverInterface.exec('ALTER TABLE users ADD COLUMN web_access_enabled INTEGER NOT NULL DEFAULT 0');
      }
      await dbDriverInterface.exec("UPDATE users SET web_access_enabled = 1 WHERE role = 'admin'");
      await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS app_login_devices (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        device_id_hash TEXT NOT NULL,
        device_model TEXT NOT NULL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS app_login_devices_hash_idx ON app_login_devices(device_id_hash)');
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS app_login_devices_registered_idx ON app_login_devices(registered_at)');
      await markSchemaVersion(9);
    }
    if (schemaVersion < 10) {
      const attendanceLocationColumns = await dbDriverInterface.prepare('PRAGMA table_info(attendance_locations)').all();
      if (!attendanceLocationColumns.some(column => column.name === 'client_point_id')) {
        await dbDriverInterface.exec('ALTER TABLE attendance_locations ADD COLUMN client_point_id TEXT');
      }
      await dbDriverInterface.exec(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_locations_client_point_idx
        ON attendance_locations(attendance_id, client_point_id) WHERE client_point_id IS NOT NULL`);
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_tracking_events_user_time_idx ON attendance_tracking_events(user_id, recorded_at)');
      await markSchemaVersion(10);
    }
    if (schemaVersion < 11) {
      await dbDriverInterface.prepare(`UPDATE settings SET value = '90'
        WHERE key = 'attendance_location_retention_days' AND value = '60'`).run();
      await markSchemaVersion(11);
    }
    if (schemaVersion < 12) {
      await dbDriverInterface.exec(`CREATE TABLE IF NOT EXISTS attendance_punch_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        punch_in TEXT NOT NULL,
        punch_out TEXT,
        in_lat REAL,
        in_lng REAL,
        out_lat REAL,
        out_lng REAL,
        in_location_text TEXT,
        out_location_text TEXT,
        in_device_type TEXT,
        in_device_info TEXT,
        out_device_type TEXT,
        out_device_info TEXT,
        legacy_attendance_id INTEGER UNIQUE
      )`);
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_punch_sessions_user_date_idx ON attendance_punch_sessions(user_id, date, punch_in)');
      await dbDriverInterface.exec(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_punch_sessions_one_open_idx
        ON attendance_punch_sessions(user_id, date) WHERE punch_out IS NULL`);
      await dbDriverInterface.exec(`INSERT OR IGNORE INTO attendance_punch_sessions
        (attendance_id, user_id, date, punch_in, punch_out, in_lat, in_lng, out_lat, out_lng,
         in_location_text, out_location_text, in_device_type, in_device_info, out_device_type, out_device_info, legacy_attendance_id)
        SELECT id, user_id, date, punch_in, punch_out, in_lat, in_lng, out_lat, out_lng,
          in_location_text, out_location_text, in_device_type, in_device_info, out_device_type, out_device_info, id
        FROM attendance WHERE punch_in IS NOT NULL`);
      await markSchemaVersion(12);
    }
    if (schemaVersion < 13) {
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance(date)');
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_user_date_idx ON attendance(user_id, date)');
      await dbDriverInterface.exec('CREATE INDEX IF NOT EXISTS attendance_punch_sessions_attendance_idx ON attendance_punch_sessions(attendance_id)');
      await markSchemaVersion(13);
    }
    if (schemaVersion < 14) {
      const locationColumns = await dbDriverInterface.prepare('PRAGMA table_info(attendance_locations)').all();
      if (!locationColumns.some(column => column.name === 'flags')) {
        await dbDriverInterface.exec("ALTER TABLE attendance_locations ADD COLUMN flags TEXT NOT NULL DEFAULT ''");
      }
      await markSchemaVersion(14);
    }
    console.log('Database schema and default settings are ready.');
  } catch (err) {
    console.error(JSON.stringify({ event: 'tenant_database_initialization_failed', company_id: companyId ?? null }));
    throw err;
  }
    return dbDriverInterface;
}

module.exports = { initTenantSchema };
