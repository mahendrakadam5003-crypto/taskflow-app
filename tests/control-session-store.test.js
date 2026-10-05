'use strict';

const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { migrateControlDatabase } = require('../control-db');
const { ControlDatabaseSessionStore } = require('../control-session-store');

function storeCall(method, ...args) {
  return new Promise((resolve, reject) => {
    method(...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test('control-database sessions persist company identity and support expiry, touch, and destroy', async () => {
  const database = createClient({ url: 'file::memory:' });
  try {
    await migrateControlDatabase(database);
    const store = new ControlDatabaseSessionStore({ getDatabase: async () => database });
    const sessionData = {
      userId: 12,
      companyId: 34,
      role: 'admin',
      cookie: { maxAge: 60_000 }
    };

    await storeCall(store.set.bind(store), 'session-1', sessionData);
    assert.deepEqual(await storeCall(store.get.bind(store), 'session-1'), sessionData);

    const row = await database.execute({
      sql: 'SELECT user_id, company_id, expires_at FROM web_sessions WHERE sid = ?',
      args: ['session-1']
    });
    assert.equal(Number(row.rows[0].user_id), 12);
    assert.equal(row.rows[0].company_id, '34');
    assert.ok(Number(row.rows[0].expires_at) > Date.now());

    await storeCall(store.touch.bind(store), 'session-1', {
      ...sessionData,
      cookie: { expires: new Date(Date.now() + 120_000).toISOString() }
    });
    const updatedRow = await database.execute({
      sql: 'SELECT expires_at FROM web_sessions WHERE sid = ?',
      args: ['session-1']
    });
    assert.ok(Number(updatedRow.rows[0].expires_at) > Number(row.rows[0].expires_at));

    await storeCall(store.destroy.bind(store), 'session-1');
    assert.equal(await storeCall(store.get.bind(store), 'session-1'), null);

    await database.execute({
      sql: 'INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)',
      args: ['expired-session', JSON.stringify(sessionData), Date.now() - 1]
    });
    assert.equal(await storeCall(store.get.bind(store), 'expired-session'), null);
  } finally {
    await database.close();
  }
});
