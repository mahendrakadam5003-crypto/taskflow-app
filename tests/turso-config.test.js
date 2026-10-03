const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getConfiguredTursoDatabaseName } = require('../lib/turso-config');

test('Turso database lookup requires an explicit configured name', () => {
  assert.throws(() => getConfiguredTursoDatabaseName(''), /TURSO_DATABASE must identify/);
  assert.throws(() => getConfiguredTursoDatabaseName('   '), /TURSO_DATABASE must identify/);
  assert.equal(getConfiguredTursoDatabaseName(' taskflow-prod '), 'taskflow-prod');
});
