const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const session = require('express-session');

const dbPath = require.resolve('../db');
const auditPath = require.resolve('../audit');
const storagePath = require.resolve('../telegram-storage');
const limitsPath = require.resolve('../limits');
const originalDbModule = require.cache[dbPath];
const originalAuditModule = require.cache[auditPath];
const originalStorageModule = require.cache[storagePath];
const originalLimitsModule = require.cache[limitsPath];
const employee = {
  id: 41,
  name: 'Approver Employee',
  username: 'approver',
  department: 'Testing',
  role: 'employee',
  email: 'approver@example.test',
  email_verified: 1,
  active: 1,
  must_change_password: 0,
  token_version: 1
};
const ownClaim = {
  id: 501,
  user_id: employee.id,
  status: 'approved_level_1',
  amount: 12.34,
  currency: 'INR',
  category: 'Travel',
  department: 'Testing'
};
const secondStageClaim = {
  id: 502,
  user_id: 200,
  status: 'approved_level_1',
  approved_level_1_by: 42,
  amount: 80,
  currency: 'INR',
  category: 'Travel',
  department: 'Testing'
};
const paidClaim = { id: 503, user_id: 200, status: 'paid', amount: 80, currency: 'INR', category: 'Travel', department: 'Testing' };
const submittedClaim = { id: 504, user_id: 200, status: 'submitted', amount: 20, currency: 'INR', category: 'Travel', department: 'Testing' };
const approvedClaim = { id: 505, user_id: 200, status: 'approved', approved_by: 10, admin_note: 'Level 1 review complete', amount: 90, currency: 'INR', category: 'Travel', department: 'Testing' };
const crossDepartmentClaim = { id: 506, user_id: 300, status: 'submitted', amount: 20, currency: 'INR', category: 'Travel', department: 'Finance' };
const deletableClaim = { id: 508, user_id: 200, status: 'submitted', amount: 10, currency: 'INR', category: 'Travel', receipt_path: 'telegram:receipt-to-delete', receipt_paths: '[]' };
const editableClaim = { id: 507, user_id: employee.id, status: 'submitted', amount: 30, currency: 'INR', category: 'Travel', expense_date: '2026-10-01', description: '', receipt_path: null, receipt_paths: null, receipt_meta: null };
let reimbursementWrites = 0;
let reimbursementWriteStatements = [];
let lastBatchStatements = [];
let batchCalls = 0;
let approvalLevel = 2;
let reimbursementListQuery = '';
let reimbursementSummaryQuery = '';
let receiptUploadCalls = 0;
let deletedTelegramMessages = [];
const auditEntries = [];
const submissionClaims = new Map();
class TestStorageLimitError extends Error {
  constructor() {
    super('Storage limit reached.');
    this.statusCode = 413;
  }
}
let reimbursementRowsForList = [];
let receiptMetadataQueryCount = 0;
let reimbursementListArgs = [];

const mockDb = {
  batch: async statements => {
    batchCalls += 1;
    lastBatchStatements = statements;
    return statements.map(() => ({ rowsAffected: 1 }));
  },
  prepare(sql) {
    return {
      get: async (...args) => {
        if (sql.includes('FROM users WHERE id')) {
          const userId = Number(args.at(-1));
          if (userId === employee.id) return { ...employee };
          if (userId === 42) return { ...employee, id: 42, role: 'employee' };
          return null;
        }
        if (sql.includes('FROM reimbursement_access')) return { approval_level: approvalLevel, can_pay: 1, department: 'Testing' };
        if (sql.includes('FROM reimbursements WHERE id=?')) {
          const claimId = Number(args.at(-1));
          if (claimId === paidClaim.id) return { ...paidClaim, receipt_path: null, receipt_paths: null };
          if (claimId === deletableClaim.id) return { ...deletableClaim };
        }
        if (sql.includes('SELECT * FROM reimbursements WHERE id')) {
          return Number(args.at(-1)) === editableClaim.id ? { ...editableClaim } : null;
        }
        if (sql.includes('FROM reimbursements WHERE submission_key')) return submissionClaims.get(args[0]) || null;
        if (sql.includes('FROM reimbursements r JOIN users u') && sql.includes('WHERE r.id=?')) {
          const claimId = Number(args.at(-1));
          if (claimId === ownClaim.id) return { ...ownClaim };
          if (claimId === secondStageClaim.id) return { ...secondStageClaim };
          if (claimId === paidClaim.id) return { ...paidClaim };
          if (claimId === submittedClaim.id) return { ...submittedClaim };
          if (claimId === approvedClaim.id) return { ...approvedClaim };
          if (claimId === crossDepartmentClaim.id) return { ...crossDepartmentClaim };
          return null;
        }
        return null;
      },
      all: async (...args) => {
        if (sql.includes('FROM telegram_attachments WHERE reimbursement_id=?')) {
          return [{ file_id: 'receipt-to-delete', message_id: 202 }];
        }
        if (sql.includes('FROM telegram_attachments WHERE reimbursement_id IS NOT NULL')) {
          receiptMetadataQueryCount += 1;
          return [
            { file_id: 'live-file', original_name: 'live.pdf', mime_type: 'application/pdf', deleted_at: null },
            { file_id: 'deleted-file', original_name: 'old.pdf', mime_type: 'application/pdf', deleted_at: '2026-10-04 10:00:00' }
          ];
        }
        if (sql.includes('FROM reimbursements r JOIN users u')) {
          if (sql.includes('GROUP BY r.currency')) {
            reimbursementSummaryQuery = sql;
            return [
              { currency: 'INR', claim_count: 2, total_amount: 40, pending_amount: 10, approved_amount: 30 },
              { currency: 'USD', claim_count: 1, total_amount: 15, pending_amount: 15, approved_amount: 0 }
            ];
          }
          reimbursementListQuery = sql;
          reimbursementListArgs = args;
          return reimbursementRowsForList;
        }
        return [];
      },
      run: async (...args) => {
        reimbursementWrites += 1;
        reimbursementWriteStatements.push({ sql, args });
        if (sql.includes('INSERT INTO reimbursements')) {
          const claim = {
            id: 800 + submissionClaims.size,
            user_id: args[0], amount: args[1], currency: args[2], category: args[3],
            description: args[4], expense_date: args[5], submission_key: args.at(-1)
          };
          submissionClaims.set(claim.submission_key, claim);
          return { changes: 1, lastInsertRowid: claim.id };
        }
        return { changes: 1 };
      }
    };
  }
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    async logActivity(...args) { auditEntries.push(args); return auditEntries.length; },
    async notifyActivityRecipients() {}
  }
};
require.cache[storagePath] = {
  id: storagePath,
  filename: storagePath,
  loaded: true,
  exports: {
    uploadToTelegram: async file => {
      receiptUploadCalls += 1;
      if (file.originalname === 'fail.png') throw new Error('simulated receipt upload failure');
      return { fileId: 'receipt-file-1', messageId: 101 };
    },
    deleteTelegramMessage: async messageId => { deletedTelegramMessages.push(messageId); },
    streamFromTelegram: async () => {}
  }
};
require.cache[limitsPath] = {
  id: limitsPath,
  filename: limitsPath,
  loaded: true,
  exports: {
    async getPlanUsage() { return { plan: null, features: { attendance: true, reimbursements: true, export: true }, usage: null }; },
    async reserveUpload() { return 'pending:test'; },
    async releaseUpload() {},
    requireFeature() { return (req, res, next) => next(); },
    StorageLimitError: TestStorageLimitError
  }
};

const reimbursementsRouter = require('../routes/reimbursements');
const app = express();
app.use(express.json());
app.use(session({
  name: 'reimbursement-test.sid',
  secret: 'reimbursement-test-session-secret-at-least-32-chars',
  resave: false,
  saveUninitialized: false
}));
app.post('/test-session', (req, res) => {
  req.session.userId = employee.id;
  req.session.role = employee.role;
  req.session.tokenVersion = employee.token_version;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.post('/test-second-approver-session', (req, res) => {
  req.session.userId = 42;
  req.session.role = 'employee';
  req.session.tokenVersion = employee.token_version;
  req.session.save(error => error ? res.status(500).end() : res.json({ ok: true }));
});
app.use('/api/reimbursements', reimbursementsRouter);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

let server;
let baseUrl;
let cookie;
let secondApproverCookie;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/test-session`, { method: 'POST' });
  cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const secondApprover = await fetch(`${baseUrl}/test-second-approver-session`, { method: 'POST' });
  secondApproverCookie = secondApprover.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (originalDbModule) require.cache[dbPath] = originalDbModule;
  else delete require.cache[dbPath];
  if (originalAuditModule) require.cache[auditPath] = originalAuditModule;
  else delete require.cache[auditPath];
  if (originalStorageModule) require.cache[storagePath] = originalStorageModule;
  else delete require.cache[storagePath];
  if (originalLimitsModule) require.cache[limitsPath] = originalLimitsModule;
  else delete require.cache[limitsPath];
  delete require.cache[require.resolve('../routes/reimbursements')];
  delete require.cache[require.resolve('../routes/auth')];
});

async function submit(route, body) {
  return submitWithCookie(cookie, route, body);
}

async function submitWithCookie(sessionCookie, route, body) {
  return fetch(`${baseUrl}/api/reimbursements${route}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body)
  });
}

async function createClaim(body) {
  return fetch(`${baseUrl}/api/reimbursements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });
}

async function createClaimWithFormData(fields) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.append(key, String(value));
  return fetch(`${baseUrl}/api/reimbursements`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: formData
  });
}

test('approvers cannot approve or pay their own claim, including in bulk', async () => {
  reimbursementWrites = 0;
  const approve = await submit(`/${ownClaim.id}/status`, { status: 'approved' });
  const pay = await submit(`/${ownClaim.id}/status`, { status: 'paid' });
  const bulk = await submit('/bulk-status', { ids: [ownClaim.id] });

  assert.equal(approve.status, 403);
  assert.equal(pay.status, 403);
  assert.equal(bulk.status, 403);

  employee.role = 'admin';
  const adminSelfApproval = await submit(`/${ownClaim.id}/status`, { status: 'approved' });
  employee.role = 'employee';
  assert.equal(adminSelfApproval.status, 403, 'administrators cannot approve their own claims');
  assert.equal(reimbursementWrites, 0, 'self-approval requests must not write reimbursement status');
});

test('level 1 and level 2 approval must be performed by different people', async () => {
  reimbursementWrites = 0;
  const response = await submitWithCookie(secondApproverCookie, `/${secondStageClaim.id}/status`, { status: 'approved' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Level 1 and level 2 approvals must be completed by different people.' });
  assert.equal(reimbursementWrites, 0);
});

test('paid and rejected claims cannot move backward, including for admins and bulk actions', async () => {
  reimbursementWrites = 0;
  reimbursementWriteStatements = [];
  batchCalls = 0;
  const employeeApproval = await submitWithCookie(secondApproverCookie, `/${paidClaim.id}/status`, { status: 'approved' });
  assert.equal(employeeApproval.status, 409);

  employee.role = 'admin';
  const adminApproval = await submit(`/${paidClaim.id}/status`, { status: 'approved' });
  employee.role = 'employee';
  assert.equal(adminApproval.status, 409);

  const mixedBulk = await submitWithCookie(secondApproverCookie, '/bulk-status', { ids: [submittedClaim.id, paidClaim.id] });
  assert.equal(mixedBulk.status, 409);
  assert.equal(reimbursementWrites, 0);
  assert.equal(batchCalls, 0, 'bulk validation must finish before writing any claim');
});

test('rejections require reasons, level 1 cannot reject final approval, and later steps preserve notes', async () => {
  reimbursementWrites = 0;
  reimbursementWriteStatements = [];
  approvalLevel = 1;
  const level1Reject = await submitWithCookie(secondApproverCookie, `/${approvedClaim.id}/status`, {
    status: 'rejected', admin_note: 'Reject after final approval'
  });
  assert.equal(level1Reject.status, 403);
  assert.equal(reimbursementWrites, 0);

  approvalLevel = 2;
  const missingReason = await submitWithCookie(secondApproverCookie, `/${approvedClaim.id}/status`, { status: 'rejected' });
  assert.equal(missingReason.status, 400);
  assert.equal(reimbursementWrites, 0);

  const rejected = await submitWithCookie(secondApproverCookie, `/${approvedClaim.id}/status`, {
    status: 'rejected', admin_note: 'Duplicate receipt'
  });
  assert.equal(rejected.status, 200);
  const update = reimbursementWriteStatements.at(-1);
  assert.match(update.sql, /admin_note=\?/);
  assert.ok(update.args.includes('Level 1 review complete\nDuplicate receipt'));
  approvalLevel = 2;
});

test('approvers only list and act on claims in their own department', async () => {
  const list = await fetch(`${baseUrl}/api/reimbursements`, { headers: { Cookie: secondApproverCookie } });
  assert.equal(list.status, 200);
  assert.match(reimbursementListQuery, /u\.department = \?/);

  reimbursementWrites = 0;
  const denied = await submitWithCookie(secondApproverCookie, `/${crossDepartmentClaim.id}/status`, { status: 'approved' });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'You do not have access to this reimbursement.' });
  assert.equal(reimbursementWrites, 0);
});

test('receipt uploads reject unsupported MIME types and mismatched content as JSON', async () => {
  const unsupportedForm = new FormData();
  unsupportedForm.append('receipt', new Blob(['not a receipt'], { type: 'text/plain' }), 'receipt.txt');
  const unsupported = await fetch(`${baseUrl}/api/reimbursements`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: unsupportedForm
  });
  assert.equal(unsupported.status, 415);
  assert.deepEqual(await unsupported.json(), { error: 'Receipts must be JPEG, PNG, GIF, WebP, or PDF files.' });

  const mismatchedForm = new FormData();
  mismatchedForm.append('receipt', new Blob(['not really a png'], { type: 'image/png' }), 'receipt.png');
  const mismatched = await fetch(`${baseUrl}/api/reimbursements`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: mismatchedForm
  });
  assert.equal(mismatched.status, 415);
  assert.deepEqual(await mismatched.json(), { error: 'Receipt content does not match its declared file type.' });
  assert.equal(reimbursementWrites, 0);
});

test('receipt uploads stop when aggregate request bytes exceed the memory budget', async () => {
  const form = new FormData();
  form.append('amount', '25.00');
  form.append('category', 'Travel');
  form.append('expense_date', '2026-10-05');
  form.append('submission_key', '550e8400-e29b-41d4-a716-446655440002');
  const largeReceipt = new Blob([Buffer.alloc(8 * 1024 * 1024)], { type: 'image/png' });
  for (let index = 0; index < 3; index += 1) form.append('receipt', largeReceipt, `large-${index}.png`);
  const uploadsBefore = receiptUploadCalls;
  const response = await fetch(`${baseUrl}/api/reimbursements`, {
    method: 'POST', headers: { Cookie: cookie }, body: form
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Receipt uploads cannot exceed 20 MB total per request.' });
  assert.equal(receiptUploadCalls, uploadsBefore);
  assert.equal(reimbursementWrites, 0);
});

test('failed multi-receipt upload deletes earlier Telegram messages before creating a claim', async () => {
  receiptUploadCalls = 0;
  deletedTelegramMessages = [];
  reimbursementWrites = 0;
  const form = new FormData();
  form.append('amount', '25.00');
  form.append('category', 'Travel');
  form.append('expense_date', '2026-10-05');
  form.append('submission_key', '550e8400-e29b-41d4-a716-446655440000');
  const pngSignature = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/+E0AAAAASUVORK5CYII=', 'base64');
  form.append('receipt', new Blob([pngSignature], { type: 'image/png' }), 'first.png');
  form.append('receipt', new Blob([pngSignature], { type: 'image/png' }), 'fail.png');

  const response = await fetch(`${baseUrl}/api/reimbursements`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form
  });

  assert.equal(response.status, 500);
  assert.equal(receiptUploadCalls, 2);
  assert.deepEqual(deletedTelegramMessages, [101]);
  assert.equal(reimbursementWrites, 0);
});

test('claim input bounds reject invalid dates, currencies, categories, and excessive amounts', async () => {
  reimbursementWrites = 0;
  const base = { amount: '25.00', category: 'Travel', expense_date: '2026-10-05', currency: 'INR' };
  for (const body of [
    { ...base, expense_date: '2026-02-30' },
    { ...base, expense_date: '2099-01-01' },
    { ...base, currency: 'INRU' },
    { ...base, category: 'x'.repeat(101) },
    { ...base, amount: '1000000000.01' }
  ]) {
    const response = await createClaim(body);
    assert.equal(response.status, 400);
  }
  assert.equal(reimbursementWrites, 0);
});

test('reimbursement summaries keep currencies separate', async () => {
  const response = await fetch(`${baseUrl}/api/reimbursements/summary`, { headers: { Cookie: secondApproverCookie } });
  assert.equal(response.status, 200);
  assert.match(reimbursementSummaryQuery, /GROUP BY r\.currency/);
  assert.deepEqual(await response.json(), {
    claim_count: 3,
    currency_totals: [
      { currency: 'INR', claim_count: 2, total_amount: 40, pending_amount: 10, approved_amount: 30 },
      { currency: 'USD', claim_count: 1, total_amount: 15, pending_amount: 15, approved_amount: 0 }
    ]
  });
});

test('an expense created without a description remains editable', async () => {
  reimbursementWriteStatements = [];
  lastBatchStatements = [];
  auditEntries.length = 0;
  const response = await submit(`/${editableClaim.id}`, {
    amount: '35.00', currency: 'INR', category: 'Travel', expense_date: '2026-10-01'
  });
  assert.equal(response.status, 200);
  const update = lastBatchStatements.at(-1);
  assert.match(update.sql, /edited_at = datetime\('now'\)/);
  const audit = auditEntries.find(entry => entry[1] === 'Reimbursement updated');
  assert.ok(audit);
  assert.match(audit[4], /Amount: 30\.00 INR -> 35\.00 INR/);
});

test('reimbursement create retries with the same key return one claim', async () => {
  reimbursementWrites = 0;
  const submissionKey = '550e8400-e29b-41d4-a716-446655440001';
  const fields = {
    amount: '25.00', currency: 'INR', category: 'Travel', expense_date: '2026-01-01',
    description: 'Taxi', submission_key: submissionKey
  };
  const first = await createClaimWithFormData(fields);
  const firstBody = await first.json();
  assert.equal(first.status, 200);

  const retry = await createClaimWithFormData(fields);
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.duplicate, true);
  assert.equal(retryBody.id, firstBody.id);
  assert.equal(reimbursementWrites, 1);

  const changed = await createClaimWithFormData({ ...fields, amount: '30.00' });
  assert.equal(changed.status, 409);
  assert.equal(reimbursementWrites, 1);
});

test('paid claims cannot be deleted and deleting unpaid claims cleans linked receipts', async () => {
  employee.role = 'admin';
  reimbursementWrites = 0;
  lastBatchStatements = [];
  deletedTelegramMessages = [];
  const paid = await fetch(`${baseUrl}/api/reimbursements/${paidClaim.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(paid.status, 409);
  assert.equal(reimbursementWrites, 0);

  const unpaid = await fetch(`${baseUrl}/api/reimbursements/${deletableClaim.id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  employee.role = 'employee';
  assert.equal(unpaid.status, 200);
  assert.ok(lastBatchStatements.some(statement => statement.sql.includes('DELETE FROM telegram_attachments WHERE reimbursement_id')));
  assert.deepEqual(deletedTelegramMessages, [202]);
});

test('deleted and missing Telegram receipts are marked expired with a single metadata query', async () => {
  reimbursementRowsForList = [{
    id: 509, user_id: 200, department: 'Testing', status: 'submitted', currency: 'INR', amount: 10,
    receipt_paths: JSON.stringify(['telegram:live-file', 'telegram:deleted-file', 'telegram:missing-file']),
    receipt_meta: null
  }];
  receiptMetadataQueryCount = 0;
  const response = await fetch(`${baseUrl}/api/reimbursements`, { headers: { Cookie: secondApproverCookie } });
  assert.equal(response.status, 200);
  const [claim] = (await response.json()).items;
  assert.equal(claim.receipt_items[0].expired, false);
  assert.ok(claim.receipt_items[0].url);
  assert.equal(claim.receipt_items[1].expired, true);
  assert.equal(claim.receipt_items[1].url, null);
  assert.equal(claim.receipt_items[2].expired, true);
  assert.equal(receiptMetadataQueryCount, 1);
  reimbursementRowsForList = [];
});

test('reimbursement list returns bounded pages and a next offset', async () => {
  reimbursementRowsForList = Array.from({ length: 51 }, (_, index) => ({
    id: 600 + index, user_id: 200, department: 'Testing', status: 'submitted', currency: 'INR', amount: 10,
    category: 'Travel', expense_date: '2026-01-01', receipt_paths: null, receipt_meta: null
  }));
  const firstPage = await fetch(`${baseUrl}/api/reimbursements?limit=2&offset=0`, { headers: { Cookie: secondApproverCookie } });
  assert.equal(firstPage.status, 200);
  const firstPageBody = await firstPage.json();
  assert.equal(firstPageBody.items.length, 2);
  assert.equal(firstPageBody.has_more, true);
  assert.equal(firstPageBody.next_offset, 2);

  const cappedPage = await fetch(`${baseUrl}/api/reimbursements?limit=10000&offset=0`, { headers: { Cookie: secondApproverCookie } });
  assert.equal(cappedPage.status, 200);
  assert.equal(reimbursementListArgs.at(-2), 51);
  assert.equal((await cappedPage.json()).items.length, 50);
  const oversizedOffset = await fetch(`${baseUrl}/api/reimbursements?offset=1000001`, { headers: { Cookie: secondApproverCookie } });
  assert.equal(oversizedOffset.status, 400);
  reimbursementRowsForList = [];
});
