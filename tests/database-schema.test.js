const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { initTenantSchema } = require('../tenant-schema');

function runInIsolatedDatabase(script) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-db-test-'));
  const dbPath = path.resolve(__dirname, '..', 'db.js');
  const env = {
    ...process.env,
    USE_LOCAL_DB: '1',
    INITIAL_ADMIN_PASSWORD: 'IsolatedSchemaTestPassword123'
  };
  const source = `const db = require(${JSON.stringify(dbPath)});\ndb.ready.then(() => db.runWithTenant('legacy', async () => {\n${script}\n})).catch(error => { console.error(error); process.exitCode = 1; });`;

  try {
    const result = spawnSync(process.execPath, ['-e', source], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 20000
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('tenant identity schema upgrade preserves existing users and is repeatable', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      department TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await client.execute({
      sql: 'INSERT INTO users (id, name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      args: [77, 'Legacy Employee', 'legacy.employee', 'existing-password-hash', 'employee']
    });
    await client.execute('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
    await client.execute('INSERT INTO schema_version (version) VALUES (3)');

    await initTenantSchema(client, { seedInitialAdmin: false, companyId: 42 });
    await initTenantSchema(client, { seedInitialAdmin: false, companyId: 42 });

    const user = await client.execute('SELECT id, name, username, password_hash, email, email_verified, google_sub, auth_provider FROM users WHERE id = 77');
    assert.deepEqual(user.rows.map(row => [row.id, row.name, row.username, row.password_hash, row.email, Number(row.email_verified), row.google_sub, row.auth_provider]), [
      [77, 'Legacy Employee', 'legacy.employee', 'existing-password-hash', null, 0, null, 'password']
    ]);
    const version = await client.execute('SELECT MAX(version) AS version FROM schema_version');
    assert.equal(Number(version.rows[0].version), 5);
    const tokenTable = await client.execute('PRAGMA table_info(email_auth_tokens)');
    assert.ok(tokenTable.rows.some(row => row.name === 'token_hash'));
    assert.ok(tokenTable.rows.some(row => row.name === 'expires_at'));

    await client.execute({
      sql: 'INSERT INTO users (name, username, password_hash, email, google_sub) VALUES (?, ?, ?, ?, ?)',
      args: ['New User', 'new.user', 'hash', 'Person@example.test', 'google-sub-1']
    });
    await assert.rejects(client.execute({
      sql: 'INSERT INTO users (name, username, password_hash, email) VALUES (?, ?, ?, ?)',
      args: ['Duplicate Email', 'duplicate.email', 'hash', 'person@EXAMPLE.test']
    }), /UNIQUE constraint failed/);
    await assert.rejects(client.execute({
      sql: 'INSERT INTO users (name, username, password_hash, google_sub) VALUES (?, ?, ?, ?)',
      args: ['Duplicate Google', 'duplicate.google', 'hash', 'google-sub-1']
    }), /UNIQUE constraint failed/);
  } finally {
    await client.close();
  }
});

test('foreign keys reject missing parents and cascade project tasks, comments, and check-ins', () => {
  const output = runInIsolatedDatabase(`
    const foreignKeys = await db.prepare('PRAGMA foreign_keys').get();
    assert.equal(Number(foreignKeys.foreign_keys), 1);
    const reimbursementColumns = await db.prepare('PRAGMA table_info(reimbursements)').all();
    const reimbursementColumnNames = reimbursementColumns.map(column => column.name);
    for (const column of ['approved_level_1_by', 'approved_by', 'paid_by', 'paid_at', 'submission_key', 'edited_at']) {
      assert.ok(reimbursementColumnNames.includes(column));
    }
    const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    let invalidProjectRejected = false;
    try { await db.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(99999, 'invalid'); }
    catch (error) { invalidProjectRejected = true; }
    assert.equal(invalidProjectRejected, true);

    const project = await db.prepare('INSERT INTO projects (name, created_by) VALUES (?, ?)').run('Cascade test', admin.id);
    const task = await db.prepare('INSERT INTO tasks (project_id, title, invoice_number) VALUES (?, ?, ?)').run(project.lastInsertRowid, 'Task one', 'DUPLICATE-INVOICE');
    await db.prepare('INSERT INTO tasks (project_id, title, invoice_number) VALUES (?, ?, ?)').run(project.lastInsertRowid, 'Task two', 'DUPLICATE-INVOICE');
    await db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.lastInsertRowid, admin.id, 'comment');
    await db.prepare('INSERT INTO task_checkins (task_id, user_id, check_in_at) VALUES (?, ?, ?)').run(task.lastInsertRowid, admin.id, new Date().toISOString());
    const invoices = await db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE invoice_number = ?').get('DUPLICATE-INVOICE');
    assert.equal(Number(invoices.count), 2, 'duplicate invoice numbers remain allowed pending accounting policy');

    await db.prepare('DELETE FROM projects WHERE id = ?').run(project.lastInsertRowid);
    for (const table of ['tasks', 'comments', 'task_checkins']) {
      const remaining = await db.prepare('SELECT COUNT(*) AS count FROM ' + table).get();
      assert.equal(Number(remaining.count), 0, table + ' rows should cascade on project deletion');
    }
    console.log('Foreign-key rejection and project cascades passed.');
  `);
  assert.match(output, /Foreign-key rejection and project cascades passed/);
});

test('normalized username and department indexes reject look-alike names', () => {
  runInIsolatedDatabase(`
    let usernameRejected = false;
    try {
      await db.prepare('INSERT INTO users (name, username, password_hash) VALUES (?, ?, ?)').run('Lookalike', 'Admin', 'unused');
    } catch (error) { usernameRejected = true; }
    assert.equal(usernameRejected, true);

    await db.prepare('INSERT INTO departments (name) VALUES (?)').run('Sales');
    let departmentRejected = false;
    try { await db.prepare('INSERT INTO departments (name) VALUES (?)').run('sales'); }
    catch (error) { departmentRejected = true; }
    assert.equal(departmentRejected, true);
    console.log('Case-insensitive username and department uniqueness passed.');
  `);
});

test('simultaneous insert-or-ignore punches leave exactly one attendance row', () => {
  runInIsolatedDatabase(`
    const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    const insert = db.prepare('INSERT OR IGNORE INTO attendance (user_id, date, punch_in) VALUES (?, ?, ?)');
    const date = '2099-08-01';
    const results = await Promise.all([
      insert.run(admin.id, date, new Date().toISOString()),
      insert.run(admin.id, date, new Date().toISOString())
    ]);
    const rows = await db.prepare('SELECT COUNT(*) AS count FROM attendance WHERE user_id = ? AND date = ?').get(admin.id, date);
    assert.equal(Number(rows.count), 1);
    assert.equal(results.reduce((sum, result) => sum + result.changes, 0), 1);
    console.log('Concurrent punch insert leaves one attendance row without a unique-conflict error.');
  `);
});

test('expired sessions can be pruned while current rows remain', () => {
  runInIsolatedDatabase(`
    const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    const now = Date.now();
    await db.prepare('INSERT INTO web_sessions (sid, data, user_id, expires_at) VALUES (?, ?, ?, ?)').run('expired', '{}', admin.id, now - 1);
    await db.prepare('INSERT INTO web_sessions (sid, data, user_id, expires_at) VALUES (?, ?, ?, ?)').run('current', '{}', admin.id, now + 60000);
    await db.deleteExpiredSessions(now);
    const rows = await db.prepare('SELECT sid FROM web_sessions').all();
    assert.deepEqual(rows.map(row => row.sid), ['current']);
    console.log('Expired session cleanup preserves unexpired rows.');
  `);
});

test('Telegram attachment storage usage tracks insert, soft-delete, and delete', () => {
  runInIsolatedDatabase(`
    const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    const project = await db.prepare('INSERT INTO projects (name, created_by) VALUES (?, ?)').run('Attachment usage', admin.id);
    const task = await db.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(project.lastInsertRowid, 'Attachment usage');
    await db.prepare('INSERT INTO telegram_attachments (file_id, message_id, task_id, uploaded_by, file_size) VALUES (?, ?, ?, ?, ?)').run('usage-file', 9001, task.lastInsertRowid, admin.id, 2048);
    let usage = await db.prepare('SELECT bytes FROM file_usage WHERE file_reference = ?').get('telegram:9001');
    assert.equal(Number(usage.bytes), 2048);

    await db.prepare('UPDATE telegram_attachments SET deleted_at = CURRENT_TIMESTAMP WHERE file_id = ?').run('usage-file');
    let count = await db.prepare('SELECT COUNT(*) AS count FROM file_usage WHERE file_reference = ?').get('telegram:9001');
    assert.equal(Number(count.count), 0);

    await db.prepare('UPDATE telegram_attachments SET deleted_at = NULL WHERE file_id = ?').run('usage-file');
    await db.prepare('DELETE FROM telegram_attachments WHERE file_id = ?').run('usage-file');
    count = await db.prepare('SELECT COUNT(*) AS count FROM file_usage WHERE file_reference = ?').get('telegram:9001');
    assert.equal(Number(count.count), 0);
    console.log('Telegram attachment storage accounting follows insert, soft-delete, and delete.');
  `);
});

test('SQLite UTC timestamps render the same instant as ISO punch timestamps', () => {
  const output = runInIsolatedDatabase(`
    const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    const project = await db.prepare('INSERT INTO projects (name, created_by) VALUES (?, ?)').run('Timestamp test', admin.id);
    const task = await db.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(project.lastInsertRowid, 'Timestamp test');
    const knownIsoTime = '2026-05-01T12:00:00.000Z';
    const sqliteUtcTime = '2026-05-01 12:00:00';
    await db.prepare('INSERT INTO attendance (user_id, date, punch_in) VALUES (?, ?, ?)').run(admin.id, '2026-05-01', knownIsoTime);
    await db.prepare('INSERT INTO attendance_locations (attendance_id, user_id, recorded_at) VALUES (?, ?, ?)').run(1, admin.id, knownIsoTime);
    await db.prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(task.lastInsertRowid, admin.id, 'known time', sqliteUtcTime);
    await db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(task.lastInsertRowid, admin.id, 'Timestamp', '', 'known time', sqliteUtcTime);
    await db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(task.lastInsertRowid, admin.id, 'default timestamp');
    await db.prepare('INSERT INTO task_history (task_id, actor_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?, ?)').run(task.lastInsertRowid, admin.id, 'Default timestamp', '', 'created');
    const punch = await db.prepare('SELECT punch_in FROM attendance WHERE user_id = ?').get(admin.id);
    const location = await db.prepare('SELECT recorded_at FROM attendance_locations WHERE attendance_id = ?').get(1);
    const comment = await db.prepare('SELECT created_at FROM comments WHERE task_id = ?').get(task.lastInsertRowid);
    const history = await db.prepare('SELECT created_at FROM task_history WHERE task_id = ?').get(task.lastInsertRowid);
    assert.equal(punch.punch_in, knownIsoTime);
    assert.equal(location.recorded_at, knownIsoTime);
    assert.equal(comment.created_at, sqliteUtcTime);
    assert.equal(history.created_at, sqliteUtcTime);
    const defaultComment = await db.prepare('SELECT created_at FROM comments WHERE body = ?').get('default timestamp');
    const defaultHistory = await db.prepare('SELECT created_at FROM task_history WHERE field_name = ?').get('Default timestamp');
    assert.equal(defaultComment.created_at.length, 19);
    assert.equal(defaultComment.created_at[10], ' ');
    assert.equal(defaultHistory.created_at.length, 19);
    assert.equal(defaultHistory.created_at[10], ' ');
    console.log('Raw timestamp format test passed.');
  `);
  assert.match(output, /Raw timestamp format test passed/);

  const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(appSource.includes("return new Date(`${value.replace(' ', 'T')}Z`);"));
  const isoTime = new Date('2026-05-01T12:00:00.000Z').getTime();
  const sqliteTimestampAsRendered = new Date('2026-05-01T12:00:00Z').getTime();
  assert.equal(sqliteTimestampAsRendered, isoTime);
});
