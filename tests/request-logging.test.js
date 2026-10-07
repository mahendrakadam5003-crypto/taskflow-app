'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { logRequestEvent, sendInternalError } = require('../http-errors');

test('request logs include company ID and exclude exception contents', () => {
  const lines = [];
  const reports = [];
  const originalError = console.error;
  console.error = line => lines.push(line);
  const response = {
    locals: {
      company_id: 202,
      reportUserError: (event, statusCode) => reports.push([event, statusCode])
    },
    req: {
      requestId: 'request-123',
      method: 'POST',
      baseUrl: '/api/auth',
      path: '/login',
      route: { path: '/login' }
    },
    headersSent: false,
    status(status) {
      this.statusCode = status;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  try {
    logRequestEvent({ companyTenantId: 202 }, 'upload_failed');
    sendInternalError(response, new Error('password=private token=private gps=12.345678,98.765432'), 'upload_processing_failed');
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(lines.map(line => JSON.parse(line)), [
    { event: 'upload_failed', company_id: 202 },
    {
      event: 'upload_processing_failed',
      company_id: 202,
      request_id: 'request-123',
      method: 'POST',
      route: '/api/auth/login',
      diagnostics: '[{"type":"Error","code":null,"summary":null}]'
    }
  ]);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: 'Internal server error.' });
  assert.deepEqual(reports, [['upload_processing_failed', 500]]);
});

test('internal error diagnostics log safe database details without raw messages', () => {
  const lines = [];
  const originalError = console.error;
  console.error = line => lines.push(line);
  const response = {
    locals: { company_id: 1, reportUserError: () => {} },
    req: { requestId: 'login-request', method: 'POST', baseUrl: '/api/auth', path: '/login' },
    headersSent: false,
    status(status) {
      this.statusCode = status;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };

  try {
    sendInternalError(response, Object.assign(new Error('SQLITE_ERROR: no such column: web_access_enabled'), {
      code: 'SQLITE_ERROR'
    }), 'Login failed');
  } finally {
    console.error = originalError;
  }

  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'Login failed');
  assert.equal(entry.request_id, 'login-request');
  assert.equal(entry.route, '/api/auth/login');
  assert.deepEqual(JSON.parse(entry.diagnostics), [{
    type: 'Error',
    code: 'SQLITE_ERROR',
    summary: 'no such column: web_access_enabled'
  }]);
});