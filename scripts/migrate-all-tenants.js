'use strict';

const db = require('../db');

async function migrateAllTenants() {
  try {
    await db.ready;
    await db.runForEachTenant(async companyId => {
      await db.getTenantClient(companyId);
      console.log(`Tenant database ${companyId} is up to date.`);
    });
  } catch (error) {
    console.error('Tenant database migration failed.');
    process.exitCode = 1;
  } finally {
    await db.closeAll();
  }
}

migrateAllTenants().catch(() => {
  console.error('Tenant database migration shutdown failed.');
  process.exitCode = 1;
});
