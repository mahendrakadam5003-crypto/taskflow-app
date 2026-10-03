const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('database startup refuses missing Turso configuration by default', () => {
  const env = { ...process.env };
  delete env.USE_LOCAL_DB;
  delete env.TURSO_DATABASE_URL;
  delete env.TURSO_AUTH_TOKEN;

  const result = spawnSync(process.execPath, ['-e', "require('./db')"], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 5000
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required/);
});

test('database startup refuses file URLs unless local mode is explicit', () => {
  const env = {
    ...process.env,
    TURSO_DATABASE_URL: 'file:taskflow.db',
    TURSO_AUTH_TOKEN: 'test-token'
  };
  delete env.USE_LOCAL_DB;

  const result = spawnSync(process.execPath, ['-e', "require('./db')"], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 5000
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a remote libsql:\/\/ or https:\/\//);
});

test('database startup refuses a missing auth token even when the URL exists', () => {
  const env = { ...process.env, TURSO_DATABASE_URL: 'libsql://test.example' };
  delete env.USE_LOCAL_DB;
  delete env.TURSO_AUTH_TOKEN;

  const result = spawnSync(process.execPath, ['-e', "require('./db')"], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 5000
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required/);
});

test('database initialization rejects a failed authenticated connection without local fallback', () => {
  const env = {
    ...process.env,
    TURSO_DATABASE_URL: 'libsql://test.example',
    TURSO_AUTH_TOKEN: 'wrong-test-token'
  };
  delete env.USE_LOCAL_DB;
  const script = `
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === '@libsql/client') return {
        createClient: () => ({
          execute: async () => { throw new Error('Unauthorized: invalid auth token'); },
          batch: async () => { throw new Error('database unavailable'); }
        })
      };
      return originalLoad.call(this, request, parent, isMain);
    };
    const db = require('./db');
    db.ready.then(() => process.exitCode = 2, error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 5000
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unauthorized: invalid auth token/);
  assert.doesNotMatch(result.stderr, /Using the explicitly enabled local SQLite database/);
});