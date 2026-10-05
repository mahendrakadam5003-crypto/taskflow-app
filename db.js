'use strict';

const { createTenantManager } = require('./tenant-manager');

const tenantManager = createTenantManager();
const db = tenantManager.db;

db.ready = tenantManager.ready;
db.runForEachTenant = tenantManager.runForEachTenant;
db.closeAll = tenantManager.closeAll;
db.closeTenant = tenantManager.closeTenant;

module.exports = db;
