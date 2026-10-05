'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const {
  createTenantManager,
  hasControlDatabaseConfiguration,
  localTenantDatabaseUrl
} = require('../tenant-manager');

test('shared Turso credentials enable registered-tenant enumeration', () => {
  assert.equal(hasControlDatabaseConfiguration({
    TURSO_DATABASE_URL: 'libsql://taskflow.turso.io',
    TURSO_AUTH_TOKEN: 'token'
  }), true);
  assert.equal(hasControlDatabaseConfiguration({ USE_LOCAL_DB: '1' }), false);
  assert.equal(hasControlDatabaseConfiguration({
    CONTROL_DATABASE_URL: 'libsql://control.turso.io',
    CONTROL_AUTH_TOKEN: 'token'
  }), true);
});

test('local tenant databases use safe company-code filenames', () => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-tenants-test-'));
  try {
    const databaseUrl = localTenantDatabaseUrl('solo-test', tenantRoot);
    assert.equal(databaseUrl, `file:${path.join(tenantRoot, 'solo-test.db').replace(/\\/g, '/')}`);
    const script = `
      const { createClient } = require('@libsql/client');
      const client = createClient({ url: ${JSON.stringify(databaseUrl)} });
      (async () => {
        await client.execute('CREATE TABLE tenant_probe (value TEXT NOT NULL)');
        await client.execute({ sql: 'INSERT INTO tenant_probe (value) VALUES (?)', args: ['local tenant file'] });
        const result = await client.execute('SELECT value FROM tenant_probe');
        if (result.rows[0].value !== 'local tenant file') throw new Error('local tenant file round trip failed');
        await client.close();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.throws(() => localTenantDatabaseUrl('../outside', tenantRoot), /valid company code/);
  } finally {
    fs.rmSync(tenantRoot, { recursive: true, force: true });
  }
});

test('tenant database access requires a company context', async () => {
  const manager = createTenantManager({
    environment: { USE_LOCAL_DB: '1' },
    legacyClient: createClient({ url: 'file::memory:' }),
    resolveTenantClient: async () => createClient({ url: 'file::memory:' }),
    initializeSchema: async () => {}
  });

  await manager.ready;
  assert.throws(() => manager.db.prepare('SELECT 1'), /without a tenant company context/);
  assert.throws(() => manager.db.exec('SELECT 1'), /without a tenant company context/);
  await manager.closeAll();
});

test('tenant contexts isolate reads and writes between two company databases', async () => {
  const tenantClients = new Map([
    [101, createClient({ url: 'file::memory:' })],
    [202, createClient({ url: 'file::memory:' })]
  ]);
  const manager = createTenantManager({
    environment: { USE_LOCAL_DB: '1' },
    legacyClient: createClient({ url: 'file::memory:' }),
    resolveTenantClient: async companyId => tenantClients.get(companyId),
    initializeSchema: async client => {
      await client.execute('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
    }
  });

  try {
    await manager.ready;
    await Promise.all([
      manager.runWithTenant(101, async () => {
        await manager.db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run(1, 'Company A private task');
      }),
      manager.runWithTenant(202, async () => {
        await manager.db.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run(1, 'Company B private task');
      })
    ]);
    const companyATasks = await manager.runWithTenant(101, () => manager.db.prepare('SELECT title FROM tasks').all());
    const companyBTasks = await manager.runWithTenant(202, () => manager.db.prepare('SELECT title FROM tasks').all());
    assert.deepEqual(companyATasks.map(task => task.title), ['Company A private task']);
    assert.deepEqual(companyBTasks.map(task => task.title), ['Company B private task']);
    assert.notEqual(await manager.getTenantClient(101), await manager.getTenantClient(202));
  } finally {
    await manager.closeAll();
  }
});
