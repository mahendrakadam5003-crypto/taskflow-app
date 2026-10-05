'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createClient } = require('@libsql/client');
const { closeControlDatabase, decryptTenantDatabaseToken, getControlDatabase } = require('./control-db');
const { initTenantSchema } = require('./tenant-schema');

const LEGACY_TENANT_ID = 'legacy';

function createLegacyClient(environment = process.env, clientFactory = createClient) {
  if (environment.USE_LOCAL_DB === '1') {
    console.warn('Using the explicitly enabled local SQLite database.');
    return clientFactory({ url: 'file:taskflow.db' });
  }

  const databaseUrl = String(environment.TURSO_DATABASE_URL || '').trim();
  const authToken = String(environment.TURSO_AUTH_TOKEN || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!databaseUrl || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required unless USE_LOCAL_DB=1.');
  }
  if (!/^libsql:\/\//i.test(databaseUrl) && !/^https:\/\//i.test(databaseUrl)) {
    throw new Error('TURSO_DATABASE_URL must be a remote libsql:// or https:// URL; set USE_LOCAL_DB=1 for local SQLite.');
  }
  return clientFactory({ url: databaseUrl, authToken });
}

function normalizeTenantId(companyId) {
  if (companyId === LEGACY_TENANT_ID) return LEGACY_TENANT_ID;
  const normalized = Number(companyId);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError('A valid company ID is required to access a tenant database.');
  }
  return normalized;
}

function localTenantDatabaseUrl(companyCode, tenantRoot = path.join(__dirname, 'tenants')) {
  if (typeof companyCode !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(companyCode)) {
    throw new TypeError('A valid company code is required for a local tenant database.');
  }
  fs.mkdirSync(tenantRoot, { recursive: true });
  const databasePath = path.join(tenantRoot, `${companyCode}.db`).replace(/\\/g, '/');
  return `file:${databasePath}`;
}

function createTenantManager({
  environment = process.env,
  legacyClient = createLegacyClient(environment),
  clientFactory = createClient,
  resolveTenantClient,
  initializeSchema = initTenantSchema
} = {}) {
  const context = new AsyncLocalStorage();
  const tenantClients = new Map();
  const localTenantRoot = path.join(__dirname, 'tenants');

  async function createRegisteredTenantClient(companyId) {
    if (resolveTenantClient) return resolveTenantClient(companyId);

    const controlDatabase = await getControlDatabase();
    const companyResult = await controlDatabase.execute({
      sql: `SELECT code, tenant_db_url, tenant_db_token_encrypted
        FROM companies WHERE id = ? AND status IN ('trial', 'active', 'suspended')`,
      args: [companyId]
    });
    const company = companyResult.rows?.[0];
    if (!company) throw new Error(`No tenant database is registered for company ID ${companyId}.`);

    if (environment.USE_LOCAL_DB === '1') {
      return clientFactory({ url: localTenantDatabaseUrl(company.code, localTenantRoot) });
    }
    const databaseUrl = String(company.tenant_db_url || '').trim();
    if (!/^libsql:\/\//i.test(databaseUrl) && !/^https:\/\//i.test(databaseUrl)) {
      throw new Error(`Company ${companyId} has an invalid tenant database URL.`);
    }
    const authToken = decryptTenantDatabaseToken(company.tenant_db_token_encrypted);
    if (!authToken) throw new Error(`Company ${companyId} has no tenant database token.`);
    return clientFactory({ url: databaseUrl, authToken });
  }

  function getTenantClient(companyId) {
    const tenantId = normalizeTenantId(companyId);
    if (!tenantClients.has(tenantId)) {
      const opening = (async () => {
        const client = tenantId === LEGACY_TENANT_ID ? legacyClient : await createRegisteredTenantClient(tenantId);
        try {
          await initializeSchema(client);
          return client;
        } catch (error) {
          if (client !== legacyClient) await client.close?.();
          throw error;
        }
      })();
      tenantClients.set(tenantId, opening);
      opening.catch(() => {
        if (tenantClients.get(tenantId) === opening) tenantClients.delete(tenantId);
      });
    }
    return tenantClients.get(tenantId);
  }

  function getCurrentTenantId() {
    const tenantId = context.getStore();
    if (tenantId === undefined) {
      throw new Error('Database access attempted without a tenant company context.');
    }
    return tenantId;
  }

  function runWithTenant(companyId, callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required for tenant context.');
    return context.run(normalizeTenantId(companyId), callback);
  }

  function prepare(sql) {
    const tenantId = getCurrentTenantId();
    return {
      get: async (...params) => {
        const client = await getTenantClient(tenantId);
        const result = await client.execute({ sql, args: params });
        return result.rows?.length ? result.rows[0] : null;
      },
      all: async (...params) => {
        const client = await getTenantClient(tenantId);
        const result = await client.execute({ sql, args: params });
        return result.rows || [];
      },
      run: async (...params) => {
        try {
          const client = await getTenantClient(tenantId);
          const result = await client.execute({ sql, args: params });
          return {
            lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : null,
            changes: result.rowsAffected || 0
          };
        } catch (error) {
          console.error('Driver RUN error:', error.message);
          throw error;
        }
      }
    };
  }

  const db = {
    exec(sql) {
      const tenantId = getCurrentTenantId();
      return getTenantClient(tenantId).then(client => client.execute(sql)).catch(error => {
        const operation = String(sql).replace(/\s+/g, ' ').trim().slice(0, 120);
        console.error('Driver EXEC error:', error.message, 'Operation:', operation);
        console.error('Driver EXEC details:', JSON.stringify({ code: error.code, status: error.status, cause: error.cause?.message }));
        throw error;
      });
    },
    batch(statements) {
      const tenantId = getCurrentTenantId();
      return getTenantClient(tenantId).then(client => client.batch(statements, 'write'));
    },
    deleteExpiredSessions(now) {
      return prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now);
    },
    prepare,
    runWithTenant,
    getCurrentTenantId,
    getTenantClient
  };

  async function listActiveTenantIds() {
    const hasControlConfiguration = Boolean(environment.CONTROL_DATABASE_URL || environment.CONTROL_AUTH_TOKEN);
    if (!hasControlConfiguration) return [LEGACY_TENANT_ID];

    const controlDatabase = await getControlDatabase();
    const result = await controlDatabase.execute(
      "SELECT id FROM companies WHERE status IN ('trial', 'active', 'suspended') ORDER BY id"
    );
    const companyIds = result.rows.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > 0);
    return companyIds.length ? companyIds : [LEGACY_TENANT_ID];
  }

  async function runForEachTenant(callback) {
    if (typeof callback !== 'function') throw new TypeError('A callback is required for tenant iteration.');
    for (const tenantId of await listActiveTenantIds()) {
      await runWithTenant(tenantId, () => callback(tenantId));
    }
  }

  async function closeAll() {
    const openResults = await Promise.allSettled(Array.from(tenantClients.values()));
    const clients = openResults.filter(result => result.status === 'fulfilled').map(result => result.value);
    const closeResults = await Promise.allSettled(clients.map(client => client.close?.()));
    tenantClients.clear();
    const errors = [
      ...openResults.filter(result => result.status === 'rejected').map(result => result.reason),
      ...closeResults.filter(result => result.status === 'rejected').map(result => result.reason)
    ];
    try {
      await closeControlDatabase();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'One or more tenant database connections failed to close.');
  }

  const ready = getTenantClient(LEGACY_TENANT_ID);
  return { closeAll, db, getCurrentTenantId, getTenantClient, ready, runForEachTenant, runWithTenant };
}

module.exports = { LEGACY_TENANT_ID, createLegacyClient, createTenantManager, localTenantDatabaseUrl, normalizeTenantId };
