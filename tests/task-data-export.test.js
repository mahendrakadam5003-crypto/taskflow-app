const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const dbPath = require.resolve('../db');
const authPath = require.resolve('../routes/auth');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const originals = new Map([dbPath, authPath, auditPath, storagePath].map(modulePath => [modulePath, require.cache[modulePath]]));
let projectQuery = '';
const importedTaskRows = [];
const importedHistoryRows = [];
let taskDetailsFixture = null;
let tenantContextCalls = 0;

const mockDb = {
  runWithTenant(tenantId, callback) { tenantContextCalls += 1; return callback(); },
  prepare(sql) {
    if (sql.includes('FROM projects ORDER BY name, id')) projectQuery = sql;
    return {
      get: async () => {
        if (taskDetailsFixture && sql.includes('FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?')) {
          const { asana_assignee_name, ...task } = taskDetailsFixture;
          return sql.includes('t.asana_assignee_name') ? { ...task, asana_assignee_name } : task;
        }
        return null;
      },
      all: async () => {
        if (sql.includes('FROM projects ORDER BY name, id')) return [{ id: 10, name: 'Export project', created_by: 1, asana_gid: null, created_at: '2026-01-01' }];
        if (sql.includes('FROM project_members')) return [];
        if (sql.includes('FROM tasks t LEFT JOIN users assignee')) return [{ id: 50, project_id: 10, title: '=1+1' }];
        if (sql.includes('FROM telegram_attachments WHERE task_id IN')) return [{ id: 7, file_id: 'telegram-file-reference', message_id: 8, original_name: 'evidence.pdf', mime_type: 'application/pdf', uploaded_by: 1, task_id: 50, created_at: '2026-01-01', deleted_at: null }];
        return [];
      },
      run: async (...args) => {
        if (sql.startsWith('INSERT INTO projects')) return { lastInsertRowid: 10, changes: 1 };
        if (sql.startsWith('INSERT INTO tasks')) {
          importedTaskRows.push({ sql, args });
          return { lastInsertRowid: 50 + importedTaskRows.length, changes: 1 };
        }
        if (sql.startsWith('INSERT INTO task_history')) importedHistoryRows.push({ sql, args });
        return { changes: 1 };
      }
    };
  }
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireAuth(req, res, next) { return req.session?.userId ? next() : res.status(401).end(); },
    requireAdmin(req, res, next) { return req.session?.role === 'admin' ? next() : res.status(403).end(); }
  }
};
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { logActivity: async () => {} } };
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadToTelegram: async () => {} } };
const tasksRouter = require('../routes/tasks');
const app = express();
app.use(express.json());
app.use(session({ name: 'task-export-test.sid', secret: 'task-export-test-session-secret-at-least-32-chars', resave: false, saveUninitialized: false }));
app.use((req, res, next) => { req.companyTenantId = 'legacy'; next(); });
app.post('/test-session', (req, res) => {
  req.session.userId = 1;
  req.session.role = 'admin';
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api', tasksRouter);
app.use((error, req, res, next) => res.status(500).json({ error: 'Internal server error.' }));

let server;
let baseUrl;
let cookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sessionResponse = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = sessionResponse.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/tasks')];
});

test('admin project backup excludes PIN hashes and includes attachment references', async () => {
  const response = await fetch(`${baseUrl}/api/admin/data-export`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.doesNotMatch(projectQuery, /SELECT\s+\*/i);
  assert.doesNotMatch(projectQuery, /pin_hash/i);
  const backup = await response.json();
  const project = backup.projects[0].project;
  assert.equal(Object.hasOwn(project, 'pin_hash'), false);
  assert.equal(backup.projects[0].tasks[0].attachments[0].original_name, 'evidence.pdf');
  assert.equal(backup.projects[0].tasks[0].attachments[0].file_id, 'telegram-file-reference');
});

test('admin project CSV export quotes fields and neutralizes spreadsheet formulas', async () => {
  const response = await fetch(`${baseUrl}/api/admin/data-export?format=csv`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  const csv = await response.text();
  assert.match(csv, /"project","task_id","title"/);
  assert.match(csv, /"'\=1\+1"/);
  assert.match(csv, /"evidence\.pdf"/);
});

test('admin Asana import accepts month-keyed JSON and keeps completed tasks completed', async () => {
  importedTaskRows.length = 0;
  importedHistoryRows.length = 0;
  const contextCallsBefore = tenantContextCalls;
  const source = {
    project: { gid: '1200', name: 'Monthly Asana project', created_at: '2026-10-01T00:00:00.000Z', members: [] },
    'Oct 26': [{
      task: {
        gid: '1201', name: 'Completed October task', notes: 'Imported notes', completed: true,
        created_at: '2026-10-02T00:00:00.000Z', modified_at: '2026-10-03T00:00:00.000Z',
        completed_at: '2026-10-03T00:00:00.000Z', due_on: '2026-10-04',
        created_by: { gid: 'actor-1', name: 'Asana-only person' }, memberships: [], custom_fields: []
      },
      stories: [[
        {
          created_by: { gid: 'actor-1', name: 'Asana-only person' },
          created_at: '2026-10-02T00:01:00.000Z',
          resource_subtype: 'added_to_project',
          text: 'Asana-only person added this task to SRS'
        },
        {
          created_by: { gid: 'actor-1', name: 'Asana-only person' },
          created_at: '2026-10-02T00:02:00.000Z',
          resource_subtype: 'assigned',
          text: 'Asana-only person assigned to Mahendra kadam'
        },
        {
          created_by: { gid: 'actor-1', name: 'Asana-only person' },
          created_at: '2026-10-02T01:00:00.000Z',
          resource_subtype: 'due_date_changed',
          text: 'Asana-only person changed the due date to Oct 4'
        }
      ]],
      subtasks: [], attachments: []
    }]
  };
  const form = new FormData();
  form.append('projects', new Blob([JSON.stringify(source)], { type: 'application/json' }), 'Oct 26.json');
  const response = await fetch(`${baseUrl}/api/admin/asana-import`, {
    method: 'POST', headers: { Cookie: cookie }, body: form
  });

  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.results[0].project_name, 'Monthly Asana project');
  assert.equal(result.results[0].tasks, 1);
  assert.equal(tenantContextCalls, contextCallsBefore + 1);
  assert.equal(importedTaskRows.length, 1);
  assert.equal(importedTaskRows[0].args[1], 'Completed October task');
  assert.equal(importedTaskRows[0].args[7], 'done');
  assert.deepEqual(importedHistoryRows.map(({ args }) => args[3]), [
    'Task created',
    'Asana: added_to_project',
    'Asana: assigned',
    'Asana: due_date_changed'
  ]);
  assert.deepEqual(importedHistoryRows.map(({ args }) => args[5]), [
    'Completed October task',
    'Asana-only person added this task to SRS',
    'Asana-only person assigned to Mahendra kadam',
    'Asana-only person changed the due date to Oct 4'
  ]);
});

test('task details expose the imported Asana assignee name', async () => {
  taskDetailsFixture = {
    id: 91,
    project_id: 10,
    title: 'Task assigned to an Asana-only person',
    asana_assignee_name: 'Asana-only person',
    assignee_name: 'Asana-only person'
  };
  const response = await fetch(`${baseUrl}/api/tasks/91`, { headers: { Cookie: cookie } });
  const task = await response.json();
  taskDetailsFixture = null;

  assert.equal(response.status, 200);
  assert.equal(task.asana_assignee_name, 'Asana-only person');
  assert.equal(task.assignee_name, 'Asana-only person');
});
