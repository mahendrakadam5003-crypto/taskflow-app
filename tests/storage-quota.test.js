const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const modulePaths = ['../db', '../routes/auth', '../audit', '../telegram-storage', '../limits', 'axios'];
const originals = new Map(modulePaths.map(moduleName => {
  const modulePath = require.resolve(moduleName);
  return [modulePath, require.cache[modulePath]];
}));
const originalEnvironment = Object.fromEntries(['TURSO_PLATFORM_TOKEN', 'TURSO_ORG', 'TURSO_DATABASE', 'TURSO_DATABASE_URL'].map(key => [key, process.env[key]]));
process.env.TURSO_PLATFORM_TOKEN = 'test-platform-token';
process.env.TURSO_ORG = 'taskflow-org';
process.env.TURSO_DATABASE = 'taskflow';
let failOrganizationUsage = false;
let plansEndpointAvailable = false;
let dashboardCheckinTasks = [];
let dashboardCheckinSql = '';

const mockDb = {
  ready: Promise.resolve(),
  prepare(sql) {
    return {
      get: async () => {
        if (sql.includes('PRAGMA page_count')) return { page_count: 2 };
        if (sql.includes('PRAGMA page_size')) return { page_size: 4096 };
        if (sql.includes('FROM reimbursements')) return { count: 0, amount: 0 };
        if (sql.includes('FROM payment_history_access')) return null;
        return null;
      },
      all: async () => {
        if (sql.includes('FROM task_checkins c JOIN tasks t ON t.id = c.task_id JOIN projects p ON p.id = t.project_id')) {
          dashboardCheckinSql = sql;
          return dashboardCheckinTasks;
        }
        return [];
      }
    };
  }
};

const mockAxios = {
  get: async url => {
    if (url.endsWith('/organizations')) return { data: [{ slug: 'taskflow-org', plan_id: 'developer' }] };
    if (url.endsWith('/databases')) return { data: { databases: [{ Name: 'taskflow', Hostname: 'taskflow.taskflow-org.turso.io' }] } };
    if (url.endsWith('/organizations/taskflow-org/usage')) {
      if (failOrganizationUsage) throw new Error('Organization usage endpoint unavailable');
      return { data: { organization: {
        usage: { storage_bytes: 9_000_000_000 },
        databases: [{ name: 'taskflow', total: { storage_bytes: 4096 } }]
      } } };
    }
    if (url.endsWith('/plans') && plansEndpointAvailable) {
      return { data: { plans: [{ id: 'developer', name: 'developer', quotas: { storage: 9_000_000_000 } }] } };
    }
    throw new Error(`Optional Turso endpoint unavailable: ${url}`);
  }
};

for (const [moduleName, exports] of [
  ['../db', mockDb],
  ['../routes/auth', {
    requireAuth(req, res, next) { return req.session?.userId ? next() : res.status(401).end(); },
    requireAdmin(req, res, next) { return req.session?.role === 'admin' ? next() : res.status(403).end(); }
  }],
  ['../audit', { logActivity: async () => {} }],
  ['../telegram-storage', { uploadToTelegram: async () => {}, streamFromTelegram: async () => {} }],
  ['../limits', {
    async getPlanUsage() {
      return {
        plan: { storageLimitBytes: 9_000_000_000 },
        usage: { storageBytes: 8192, percentUsed: 0.1 }
      };
    },
    reserveUpload: async () => 'pending:test',
    releaseUpload: async () => {},
    requireFeature: () => (req, res, next) => next()
  }],
  ['axios', mockAxios]
]) {
  const modulePath = require.resolve(moduleName);
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

const tasksRouter = require('../routes/tasks');
const app = express();
app.use(session({ name: 'storage-quota.sid', secret: 'storage-quota-test-session-secret-at-least-32', resave: false, saveUninitialized: false }));
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
  const response = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = response.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const [modulePath, original] of originals) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
  delete require.cache[require.resolve('../routes/tasks')];
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('dashboard reports the company plan limit and tenant storage usage', async () => {
  const response = await fetch(`${baseUrl}/api/dashboard/summary`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.storage.available, true);
  assert.equal(summary.storage.total_bytes, 9_000_000_000);
  assert.equal(summary.storage.used_bytes, 8192);
  assert.equal(summary.storage.source, 'company');
});

test('dashboard continues reporting the company plan limit independently of Turso APIs', async () => {
  failOrganizationUsage = true;
  plansEndpointAvailable = true;
  const response = await fetch(`${baseUrl}/api/dashboard/summary`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.storage.available, true);
  assert.equal(summary.storage.total_bytes, 9_000_000_000);
  assert.equal(summary.storage.source, 'company');
});


test('dashboard company storage is independent of the configured Turso database URL', async () => {
  delete process.env.TURSO_DATABASE;
  process.env.TURSO_DATABASE_URL = 'libsql://taskflow.taskflow-org.turso.io';
  const response = await fetch(`${baseUrl}/api/dashboard/summary`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.storage.available, true);
  assert.equal(summary.storage.total_bytes, 9_000_000_000);
  assert.equal(summary.storage.source, 'company');
});

test('dashboard lists distinct tasks checked in or out today for admins', async () => {
  dashboardCheckinTasks = [
    { id: 12, project_id: 3, title: 'Site inspection' },
    { id: 13, project_id: 3, title: 'Equipment setup' }
  ];
  const response = await fetch(`${baseUrl}/api/dashboard/summary`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.checkin_task_count, 2);
  assert.deepEqual(summary.checkin_tasks, dashboardCheckinTasks);
  assert.match(dashboardCheckinSql, /SELECT DISTINCT t\.id, t\.project_id, t\.title/);
  assert.match(dashboardCheckinSql, /date\(c\.check_in_at, '\+5 hours', '\+30 minutes'\)/);
  assert.match(dashboardCheckinSql, /date\(c\.check_out_at, '\+5 hours', '\+30 minutes'\)/);
  assert.doesNotMatch(dashboardCheckinSql, /c\.user_id = \?/);
  dashboardCheckinTasks = [];
});