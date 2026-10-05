'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createUsageSnapshotCollector } = require('../usage-snapshots');

test('daily usage snapshots collect active users, database bytes, and only referenced local files', async () => {
  const uploadsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'taskflow-usage-snapshots-'));
  try {
    await fs.mkdir(path.join(uploadsDirectory, 'receipts'));
    await fs.writeFile(path.join(uploadsDirectory, 'task-proof.png'), Buffer.alloc(13));
    await fs.writeFile(path.join(uploadsDirectory, 'receipts', 'receipt.pdf'), Buffer.alloc(29));
    const tenantIds = [];
    const snapshotStatements = [];
    let currentTenantId;
    const tenantData = {
      11: {
        userCount: 4,
        pages: 8,
        pageSize: 4096,
        comments: [{ image_path: '/uploads/task-proof.png' }],
        reimbursements: [{ receipt_path: 'telegram:external-file', receipt_paths: JSON.stringify(['telegram:external-file', 'receipt.pdf']) }]
      },
      22: {
        userCount: 2,
        pages: 3,
        pageSize: 4096,
        comments: [{ image_path: '/uploads/missing.png' }],
        reimbursements: []
      }
    };
    const db = {
      ready: Promise.resolve(),
      runWithTenant(companyId, callback) {
        currentTenantId = companyId;
        tenantIds.push(companyId);
        return callback();
      },
      prepare(sql) {
        return {
          async get() {
            const data = tenantData[currentTenantId];
            if (sql.includes('COUNT(*)')) return { user_count: data.userCount };
            if (sql.includes('page_count')) return { page_count: data.pages };
            if (sql.includes('page_size')) return { page_size: data.pageSize };
            assert.fail(`Unexpected tenant query: ${sql}`);
          },
          async all() {
            const data = tenantData[currentTenantId];
            if (sql.includes('FROM comments')) return data.comments;
            if (sql.includes('FROM reimbursements')) return data.reimbursements;
            assert.fail(`Unexpected tenant query: ${sql}`);
          }
        };
      }
    };
    const controlDb = {
      async execute(statement) {
        assert.match(statement.sql, /FROM companies/);
        return { rows: [{ id: 11 }, { id: 22 }] };
      },
      async batch(statements, mode) {
        assert.equal(mode, 'write');
        snapshotStatements.push(...statements);
      }
    };
    const collectUsageSnapshots = createUsageSnapshotCollector({
      db,
      getDatabase: async () => controlDb,
      uploadsDirectory,
      environment: { TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'test-token' }
    });

    assert.equal(await collectUsageSnapshots(), 2);
    assert.deepEqual(tenantIds, [11, 22]);
    assert.deepEqual(snapshotStatements.slice(0, 2).map(statement => statement.args), [
      [11, 4, 32768, 42],
      [22, 2, 12288, 0]
    ]);
    assert.match(snapshotStatements[2].sql, /365 days/);
  } finally {
    await fs.rm(uploadsDirectory, { recursive: true, force: true });
  }
});

test('usage collection rejects invalid company IDs and does not write partial snapshots', async () => {
  let batchCalled = false;
  const db = {
    ready: Promise.resolve(),
    runWithTenant() {
      assert.fail('Tenant data must not be queried for invalid company IDs.');
    },
    prepare() {
      assert.fail('Tenant data must not be queried for invalid company IDs.');
    }
  };
  const collectUsageSnapshots = createUsageSnapshotCollector({
    db,
    getDatabase: async () => ({
      execute: async () => ({ rows: [{ id: 'invalid' }] }),
      batch: async () => { batchCalled = true; }
    }),
    environment: { TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'test-token' }
  });

  await assert.rejects(collectUsageSnapshots(), /invalid company ID/);
  assert.equal(batchCalled, false);
});

test('usage collection skips cleanly when control database credentials are not configured', async () => {
  let databaseOpened = false;
  const db = {
    ready: Promise.resolve(),
    runWithTenant() {
      assert.fail('Tenant data must not be queried without a control database.');
    },
    prepare() {
      assert.fail('Tenant data must not be queried without a control database.');
    }
  };
  const collectUsageSnapshots = createUsageSnapshotCollector({
    db,
    getDatabase: async () => {
      databaseOpened = true;
      throw new Error('Control database should not be opened.');
    },
    environment: {}
  });

  assert.equal(await collectUsageSnapshots(), 0);
  assert.equal(databaseOpened, false);
});
