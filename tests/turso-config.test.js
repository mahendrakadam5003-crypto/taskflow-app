const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getConfiguredTursoDatabaseName } = require('../lib/turso-config');

test('Turso database lookup prefers an explicit configured name', () => {
  assert.equal(getConfiguredTursoDatabaseName(' taskflow-prod '), 'taskflow-prod');
});

test('Turso database lookup derives the host from the configured database URL', () => {
  const originalUrl = process.env.TURSO_DATABASE_URL;
  process.env.TURSO_DATABASE_URL = 'libsql://taskflow-prod-org.turso.io';
  try {
    assert.equal(getConfiguredTursoDatabaseName(''), 'taskflow-prod-org.turso.io');
  } finally {
    if (originalUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = originalUrl;
  }
});

test('Turso database lookup rejects missing or invalid configuration', () => {
  const originalUrl = process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_DATABASE_URL;
  try {
    assert.throws(() => getConfiguredTursoDatabaseName(''), /TURSO_DATABASE or a valid TURSO_DATABASE_URL/);
    process.env.TURSO_DATABASE_URL = 'not a URL';
    assert.throws(() => getConfiguredTursoDatabaseName(''), /TURSO_DATABASE_URL must be a valid URL/);
  } finally {
    if (originalUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = originalUrl;
  }
});
