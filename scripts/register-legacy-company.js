'use strict';

const { closeControlDatabase, encryptTenantDatabaseToken, getControlDatabase } = require('../control-db');

const DEFAULT_COMPANY_CODE = 'existing-company';
const DEFAULT_COMPANY_NAME = 'Existing Company';

function getLegacyDatabaseConfig(environment) {
  if (environment.USE_LOCAL_DB === '1') return null;
  const url = String(environment.TURSO_DATABASE_URL || '').trim().replace(/\/+$/, '');
  const authToken = String(environment.TURSO_AUTH_TOKEN || '').trim().replace(/^Bearer\s+/i, '').trim();
  if (!url || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required to link the existing company.');
  }
  if (!/^libsql:\/\//i.test(url) && !/^https:\/\//i.test(url)) {
    throw new Error('TURSO_DATABASE_URL must be a remote libsql:// or https:// URL.');
  }
  return { url, authToken };
}

async function registerLegacyCompany({
  environment = process.env,
  getDatabase = getControlDatabase,
  encryptToken = encryptTenantDatabaseToken
} = {}) {
  const database = getLegacyDatabaseConfig(environment);
  if (!database) return { status: 'skipped-local-database' };

  const code = String(environment.LEGACY_COMPANY_CODE || DEFAULT_COMPANY_CODE).trim().toLowerCase();
  const name = String(environment.LEGACY_COMPANY_NAME || DEFAULT_COMPANY_NAME).trim();
  const tenantDatabaseName = String(environment.TURSO_DATABASE || environment.LEGACY_TENANT_DATABASE_NAME || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(code)) {
    throw new Error('LEGACY_COMPANY_CODE must be a valid lowercase company code.');
  }
  if (!name || name.length > 160) throw new Error('LEGACY_COMPANY_NAME must contain 1 to 160 characters.');

  const encryptedToken = encryptToken(database.authToken);
  const controlDb = await getDatabase();
  const transaction = await controlDb.transaction('write');
  try {
    const matchingDatabase = await transaction.execute({
      sql: `SELECT id, code, name FROM companies
        WHERE lower(tenant_db_url) = lower(?) LIMIT 1`,
      args: [database.url]
    });
    const internalPlan = await transaction.execute({
      sql: "SELECT id FROM plans WHERE name = 'Internal / Unlimited' LIMIT 1",
      args: []
    });
    const internalPlanId = Number(internalPlan.rows?.[0]?.id);
    if (!Number.isSafeInteger(internalPlanId) || internalPlanId < 1) {
      throw new Error('The Internal / Unlimited plan is missing from the control database.');
    }
    if (matchingDatabase.rows?.[0]) {
      const companyId = Number(matchingDatabase.rows[0].id);
      const currentCompany = await transaction.execute({
        sql: 'SELECT plan_id, tenant_db_name FROM companies WHERE id = ? LIMIT 1',
        args: [companyId]
      });
      if (Number(currentCompany.rows?.[0]?.plan_id) !== internalPlanId) {
        await transaction.execute({
          sql: 'UPDATE companies SET plan_id = ? WHERE id = ?',
          args: [internalPlanId, companyId]
        });
        await transaction.execute({
          sql: 'INSERT INTO super_admin_audit (company_id, action, details) VALUES (?, ?, ?)',
          args: [companyId, 'Internal plan assigned', 'Assigned the existing company the Internal / Unlimited plan.']
        });
      }
      if (!currentCompany.rows?.[0]?.tenant_db_name && tenantDatabaseName) {
        await transaction.execute({
          sql: 'UPDATE companies SET tenant_db_name = ? WHERE id = ? AND tenant_db_name IS NULL',
          args: [tenantDatabaseName, companyId]
        });
      }
      await transaction.commit();
      return {
        status: 'already-registered',
        companyId,
        code: matchingDatabase.rows[0].code,
        name: matchingDatabase.rows[0].name
      };
    }

    const matchingCode = await transaction.execute({
      sql: 'SELECT id, tenant_db_url FROM companies WHERE code = ? LIMIT 1',
      args: [code]
    });
    if (matchingCode.rows?.[0]) {
      throw new Error(`Company code "${code}" is already linked to a different database; refusing to modify it.`);
    }

    const inserted = await transaction.execute({
      sql: `INSERT INTO companies (
        code, name, status, plan_id, tenant_db_url, tenant_db_token_encrypted, notes, tenant_db_name
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
      args: [
        code,
        name,
        internalPlanId,
        database.url,
        encryptedToken,
        'Existing TaskFlow workspace registered without moving or changing company data.',
        tenantDatabaseName || code
      ]
    });
    const companyId = Number(inserted.lastInsertRowid);
    await transaction.execute({
      sql: 'INSERT INTO super_admin_audit (company_id, action, details) VALUES (?, ?, ?)',
      args: [companyId, 'Existing company linked', 'Registered the existing Turso workspace without migrating tenant data.']
    });
    await transaction.commit();
    return { status: 'registered', companyId, code, name };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

if (require.main === module) {
  registerLegacyCompany()
    .then(result => {
      if (result.status === 'registered') {
        console.log(`Existing company "${result.name}" linked to the current Turso database as "${result.code}". No company records were moved.`);
      } else if (result.status === 'already-registered') {
        console.log(`Existing database is already linked to company "${result.name}" as "${result.code}".`);
      } else {
        console.log('Existing company linking skipped for the explicitly enabled local SQLite database.');
      }
    })
    .catch(error => {
      console.error(`Existing company linking failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(closeControlDatabase);
}

module.exports = { getLegacyDatabaseConfig, registerLegacyCompany };
