'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const express = require('express');
const { COOKIE_NAME, createSuperAdminRouter } = require('../routes/superadmin');

const token = 'A'.repeat(43);
const sidHash = crypto.createHash('sha256').update(token).digest('hex');
const statements = [];
const controlDatabase = {
  async execute(statement) {
    statements.push(statement);
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (sql.includes('FROM super_admin_sessions s')) {
      return { rows: [{ id: 8, name: 'Test Admin', username: 'admin', admin_token_version: 2, session_token_version: 2, expires_at: Date.now() + 60000 }] };
    }
    if (sql.includes('FROM user_error_reports e LEFT JOIN companies')) {
      return { rows: [{
        id: 19,
        company_id: 42,
        company_code: 'small-test',
        actor_user_id: 5,
        request_id: 'request-19',
        event: 'task_creation_failed',
        method: 'POST',
        route: '/api/tasks',
        status_code: 500,
        created_at: '2026-10-05 12:00:00',
        resolved_at: null,
        company_name: 'Small Test',
        registered_company_code: 'small-test'
      }] };
    }
    if (sql.includes('COUNT(*) AS count FROM user_error_reports')) return { rows: [{ count: 1 }] };
    if (sql.startsWith('UPDATE user_error_reports')) return { rowsAffected: 1 };
    if (sql.includes('INSERT INTO super_admin_audit')) return { rowsAffected: 1 };
    assert.fail(`Unexpected control database statement: ${sql}`);
  }
};

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', createSuperAdminRouter({ getDatabase: async () => controlDatabase }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/superadmin`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('user-error inbox requires super-admin authentication and supports review', async () => {
  const unauthorized = await fetch(`${baseUrl}/user-errors`);
  assert.equal(unauthorized.status, 401);

  const headers = { Cookie: `${COOKIE_NAME}=${token}` };
  const response = await fetch(`${baseUrl}/user-errors`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.pendingCount, 1);
  assert.equal(body.errors[0].companyName, 'Small Test');
  assert.equal(body.errors[0].requestId, 'request-19');
  assert.equal(body.errors[0].event, 'task_creation_failed');
  assert.equal('stack' in body.errors[0], false);
  assert.equal('message' in body.errors[0], false);

  const resolveResponse = await fetch(`${baseUrl}/user-errors/19/resolve`, { method: 'POST', headers });
  assert.equal(resolveResponse.status, 200);
  assert.deepEqual(await resolveResponse.json(), { id: 19, resolved: true });
  assert.ok(statements.some(statement => String(statement.sql || '').includes('UPDATE user_error_reports')));
  assert.ok(statements.some(statement => String(statement.sql || '').includes('INSERT INTO super_admin_audit')));
  assert.equal(sidHash.length, 64);
});