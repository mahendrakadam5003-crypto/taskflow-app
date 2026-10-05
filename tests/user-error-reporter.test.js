'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUserErrorReporter } = require('../user-error-reporter');

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
  assert.deepEqual(statements[0].args, [42, 'small-test', 7, 'request-123', 'task_creation_failed', 'POST', '/api/tasks/:id', 500]);
  assert.doesNotMatch(JSON.stringify(statements[0]), /private-password|private-token|12\.345|67\.89/);
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