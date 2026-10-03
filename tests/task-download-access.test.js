const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');
const { Readable } = require('node:stream');

const dbPath = require.resolve('../db');
const authPath = require.resolve('../routes/auth');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const axiosPath = require.resolve('axios');
const originals = new Map([dbPath, authPath, auditPath, storagePath, axiosPath].map(modulePath => [modulePath, require.cache[modulePath]]));
const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramRequests = 0;
let attachmentQueries = 0;
let isProjectMember = false;
let fileIdFromDb = 'telegram-secret-file-id';

const mockDb = {
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('SELECT id FROM tasks WHERE id')) return Number(args[0]) === 900 ? { id: 900 } : null;
        if (sql.includes('SELECT project_id, assignee_id FROM tasks')) return { project_id: 200, assignee_id: 44 };
        if (sql.includes('FROM projects p LEFT JOIN project_members')) return isProjectMember ? { allowed: 1 } : null;
        return null;
      },
      all: async (...args) => {
        if (sql.includes('FROM telegram_attachments WHERE file_id = ?')) {
          attachmentQueries += 1;
          assert.equal(args[0], fileIdFromDb);
          return [{ original_name: 'private.pdf', mime_type: 'application/pdf', task_id: 900 }];
        }
        return [];
      },
      run: async () => ({ changes: 0 })
    };
  }
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    requireAuth(req, res, next) {
      if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
      next();
    },
    requireAdmin(req, res, next) {
      return req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
    }
  }
};
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { logActivity: async () => {} } };
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { uploadToTelegram: async () => {} } };
const axiosMock = async () => ({ headers: { 'content-type': 'application/pdf' }, data: Readable.from(['test attachment']) });
axiosMock.get = async url => {
  telegramRequests += 1;
  assert.ok(url.includes(encodeURIComponent(fileIdFromDb)));
  return { data: { result: { file_path: 'documents/private.pdf' } } };
};
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosMock };
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const tasksRouter = require('../routes/tasks');
const app = express();
app.use(express.json());
app.use(session({
  name: 'task-download-test.sid',
  secret: 'task-download-test-session-secret-at-least-32-chars',
  resave: false,
  saveUninitialized: false
}));
app.post('/test-session', (req, res) => {
  req.session.userId = 77;
  req.session.role = 'employee';
  req.session.tokenVersion = 1;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api', tasksRouter);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

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
  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
});

test('logged-in non-member cannot download a Telegram file attached to another task', async () => {
  isProjectMember = false;
  fileIdFromDb = 'telegram-secret-file-id';
  attachmentQueries = 0;
  telegramRequests = 0;
  const response = await fetch(`${baseUrl}/api/download/telegram-secret-file-id`, {
    headers: { Cookie: cookie }
  });
  assert.equal(response.status, 403);
  assert.equal(telegramRequests, 0, 'Telegram lookup must not run before task authorization');
});

test('download rejects malformed file IDs before querying or contacting Telegram', async () => {
  attachmentQueries = 0;
  telegramRequests = 0;
  const response = await fetch(`${baseUrl}/api/download/bad%20file-id`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 400);
  assert.equal(attachmentQueries, 0);
  assert.equal(telegramRequests, 0);
});

test('authorized Telegram download URL encodes the validated file ID', async () => {
  isProjectMember = true;
  fileIdFromDb = 'File_id-123';
  telegramRequests = 0;
  const response = await fetch(`${baseUrl}/api/download/${encodeURIComponent(fileIdFromDb)}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'test attachment');
  assert.equal(telegramRequests, 1);
  isProjectMember = false;
  fileIdFromDb = 'telegram-secret-file-id';
});
