'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUserErrorReporter, safeErrorDiagnostics } = require('../user-error-reporter');

test('unexpected errors persist request metadata without exception or request contents', async () => {
  const statements = [];
  const reporter = createUserErrorReporter({
    isConfigured: () => true,
    getDatabase: async () => ({ execute: async statement => statements.push(statement) })
  });
  const request = {
    companyTenantId: 42,
    companyCode: 'small-test',
    session: { userId: 7, password: 'private-password' },
    requestId: 'request-123',
    method: 'POST',
    baseUrl: '/api',
    path: '/tasks/91?token=private-token',
    route: { path: '/tasks/:id' },
    body: { password: 'private-password', lat: 12.345, lng: 67.89 }
  };

  assert.equal(await reporter(request, 'Task creation failed', 500), true);
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].args, [42, 'small-test', 7, 'request-123', 'task_creation_failed', 'POST', '/api/tasks/:id', 500, null]);
  assert.doesNotMatch(JSON.stringify(statements[0]), /private-password|private-token|12\.345|67\.89/);
});

test('error diagnostics retain safe SQLite details and causes without persisting arbitrary messages', async () => {
  const statements = [];
  const reporter = createUserErrorReporter({
    isConfigured: () => true,
    getDatabase: async () => ({ execute: async statement => statements.push(statement) })
  });
  const cause = Object.assign(new Error('private token: abc123'), { code: 'ECONNRESET' });
  const error = Object.assign(new Error('SQLITE_ERROR: no such column: allow_phone'), {
    code: 'SQLITE_ERROR', cause
  });

  await reporter({ method: 'GET', path: '/api/attendance/device-access/me' }, 'Unhandled request error', 500, error);

  const diagnostics = JSON.parse(statements[0].args[8]);
  assert.deepEqual(diagnostics, [
    { type: 'Error', code: 'SQLITE_ERROR', summary: 'no such column: allow_phone' },
    { type: 'Error', code: 'ECONNRESET', summary: 'Connection reset by remote host.' }
  ]);
  assert.doesNotMatch(JSON.stringify(statements[0]), /private token|abc123|SQLITE_ERROR:/);
});

test('error diagnostics expose safe configuration failures without leaking values', () => {
  const error = new Error('Unable to decrypt tenant database token; verify APP_ENCRYPTION_KEY.');
  error.cause = Object.assign(new Error('bad decrypt: private-token-value'), { code: 'AUTHENTICATION_FAILED' });

  assert.deepEqual(JSON.parse(safeErrorDiagnostics(error)), [
    {
      type: 'Error',
      code: null,
      summary: 'Unable to decrypt tenant database token; verify APP_ENCRYPTION_KEY.'
    },
    {
      type: 'Error',
      code: 'AUTHENTICATION_FAILED',
      summary: 'Database authentication failed.'
    }
  ]);
  assert.doesNotMatch(safeErrorDiagnostics(error), /private-token-value/);
});

test('error diagnostics expose bounded TypeError shapes without arbitrary messages', () => {
  assert.deepEqual(JSON.parse(safeErrorDiagnostics(
    new TypeError("Cannot read properties of undefined (reading 'get')")
  )), [{
    type: 'TypeError',
    code: null,
    summary: "Cannot read properties of undefined (reading 'get')"
  }]);

  assert.equal(safeErrorDiagnostics(
    new TypeError('failed with token=private-secret-value')
  ), '[{"type":"TypeError","code":null,"summary":null}]');
});

test('unknown errors expose only an application-relative source location and safe tenant context details', () => {
  const error = Object.assign(new Error('private query value: secret-123'), {
    stack: 'Error: private query value: secret-123\n    at handler (C:\\app\\routes\\tasks.js:123:45)'
  });
  assert.deepEqual(JSON.parse(safeErrorDiagnostics(error)), [{
    type: 'Error', code: null, summary: null, location: 'routes/tasks.js:123'
  }]);
  assert.deepEqual(JSON.parse(safeErrorDiagnostics(new Error('Database access attempted without a tenant company context.'))), [{
    type: 'Error', code: null, summary: 'Database access attempted without a tenant company context.'
  }]);
  assert.doesNotMatch(safeErrorDiagnostics(error), /C:\\app|secret-123/);
});

test('one request produces no duplicate inbox reports when multiple error boundaries run', async () => {
  const statements = [];
  const reporter = createUserErrorReporter({
    isConfigured: () => true,
    getDatabase: async () => ({ execute: async statement => statements.push(statement) })
  });
  const request = { method: 'GET', path: '/api/example' };

  assert.equal(await reporter(request, 'database failure', 500, new Error('safe to omit')), true);
  assert.equal(await reporter(request, 'http_5xx_response', 500), false);
  assert.equal(statements.length, 1);
});

test('expected client errors are not sent to the super-admin inbox', async () => {
  let writes = 0;
  const reporter = createUserErrorReporter({
    isConfigured: () => true,
    getDatabase: async () => ({ execute: async () => { writes += 1; } })
  });

  assert.equal(await reporter({ companyTenantId: 42 }, 'Invalid request', 403), false);
  assert.equal(writes, 0);
});

test('reporting failure is swallowed and emits only a fixed safe event', async () => {
  const logs = [];
  const reporter = createUserErrorReporter({
    isConfigured: () => true,
    getDatabase: async () => { throw new Error('private database token'); },
    logger: value => logs.push(value)
  });

  assert.equal(await reporter({ companyTenantId: 9 }, 'Failure', 500), false);
  assert.deepEqual(logs.map(JSON.parse), [{ event: 'user_error_report_persist_failed', company_id: 9 }]);
});