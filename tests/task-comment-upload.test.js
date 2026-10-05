const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const dbPath = require.resolve('../db');
const authPath = require.resolve('../routes/auth');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const limitsPath = require.resolve('../limits');
const originals = new Map([dbPath, authPath, auditPath, storagePath, limitsPath].map(modulePath => [modulePath, require.cache[modulePath]]));
const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
let telegramUploads = 0;
let dbWrites = 0;
let rejectStorageReservation = false;
class TestStorageLimitError extends Error {
  constructor() {
    super('Storage limit reached.');
    this.statusCode = 413;
  }
}

const mockDb = {
  ready: Promise.resolve(),
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('SELECT project_id, assignee_id FROM tasks')) return { project_id: 200, assignee_id: 77 };
        if (sql.includes('SELECT work_mode FROM tasks')) return { work_mode: 'office' };
        return null;
      },
      all: async () => [],
      run: async () => {
        dbWrites += 1;
        return { changes: 1, lastInsertRowid: dbWrites };
      }
    };
  },
  async batch() {
    dbWrites += 1;
    return [
      { rowsAffected: 1 },
      { rowsAffected: 1, lastInsertRowid: dbWrites },
      { rowsAffected: 1 }
    ];
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
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadToTelegram: async () => {
      telegramUploads += 1;
      return { fileId: `test-file-${telegramUploads}`, messageId: telegramUploads };
    }
  }
};
require.cache[limitsPath] = {
  id: limitsPath,
  filename: limitsPath,
  loaded: true,
  exports: {
    async getPlanUsage() { return { plan: null, features: { attendance: true, reimbursements: true, export: true }, usage: null }; },
    async reserveUpload() {
      if (rejectStorageReservation) throw new TestStorageLimitError();
      return 'pending:test';
    },
    async releaseUpload() {},
    requireFeature() { return (req, res, next) => next(); },
    StorageLimitError: TestStorageLimitError
  }
};
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const tasksRouter = require('../routes/tasks');
const app = express();
app.use(session({
  name: 'task-comment-upload-test.sid',
  secret: 'task-comment-upload-test-session-secret-32-chars',
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
app.use((error, req, res, next) => {
  const status = Number(error.statusCode || error.status);
  const clientError = status >= 400 && status < 500;
  res.status(clientError ? status : 500).json({ error: clientError ? error.message : 'Internal server error.' });
});

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
  if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
});

async function uploadComment(filename, mimeType, size) {
  const form = new FormData();
  form.set('body', 'Attachment test');
  form.set('attachment', new Blob([new Uint8Array(size)] , { type: mimeType }), filename);
  return fetch(`${baseUrl}/api/tasks/900/comments`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form
  });
}

test('comment uploads allow approved file types under 10 MB', async () => {
  telegramUploads = 0;
  const response = await uploadComment('photo.png', 'image/png', 32);
  assert.equal(response.status, 200);
  assert.equal(telegramUploads, 1);
});

test('comment upload stops before Telegram when company storage quota is exceeded', async () => {
  telegramUploads = 0;
  rejectStorageReservation = true;
  try {
    const response = await uploadComment('photo.png', 'image/png', 32);
    assert.equal(response.status, 413);
    assert.equal(telegramUploads, 0);
  } finally {
    rejectStorageReservation = false;
  }
});

test('comment uploads reject mismatched or disallowed file types', async () => {
  telegramUploads = 0;
  const response = await uploadComment('script.html', 'text/html', 32);
  assert.equal(response.status, 415);
  assert.equal(telegramUploads, 0);
});

test('comment uploads reject files over 10 MB before buffering to storage', async () => {
  telegramUploads = 0;
  const response = await uploadComment('large.pdf', 'application/pdf', 10 * 1024 * 1024 + 1);
  assert.ok(response.status >= 400);
  assert.equal(telegramUploads, 0);
});
