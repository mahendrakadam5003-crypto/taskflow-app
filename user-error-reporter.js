'use strict';

const crypto = require('node:crypto');
const { getControlDatabase } = require('./control-db');
const { hasControlDatabaseConfiguration } = require('./tenant-manager');

function normalizeEvent(event) {
  return String(event || 'server_error')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'server_error';
}

function createUserErrorReporter({
  getDatabase = getControlDatabase,
  isConfigured = hasControlDatabaseConfiguration,
  logger = console.warn
} = {}) {
  return async function reportUserError(req, event, statusCode = 500) {
    if (!Number.isInteger(statusCode) || statusCode < 500 || !isConfigured()) return false;

    const rawCompanyId = Number(req?.companyTenantId);
    const rawUserId = Number(req?.session?.userId);
    const route = req?.route?.path || req?.path || '/';
    const report = {
      companyId: Number.isSafeInteger(rawCompanyId) && rawCompanyId > 0 ? rawCompanyId : null,
      companyCode: typeof req?.companyCode === 'string'
        ? req.companyCode.slice(0, 63)
        : (req?.path?.startsWith('/api/superadmin') ? 'platform' : null),
      actorUserId: Number.isSafeInteger(rawUserId) && rawUserId > 0 ? rawUserId : null,
      requestId: typeof req?.requestId === 'string' ? req.requestId.slice(0, 64) : crypto.randomUUID(),
      event: normalizeEvent(event),
      method: typeof req?.method === 'string' ? req.method.slice(0, 10).toUpperCase() : 'UNKNOWN',
      route: `${req?.baseUrl || ''}${route}`.replace(/[?#].*$/, '').slice(0, 300),
      statusCode
    };

    try {
      const controlDb = await getDatabase();
      await controlDb.execute({
        sql: `INSERT INTO user_error_reports (
          company_id, company_code, actor_user_id, request_id, event, method, route, status_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [report.companyId, report.companyCode, report.actorUserId, report.requestId,
          report.event, report.method, report.route, report.statusCode]
      });
      return true;
    } catch (error) {
      logger(JSON.stringify({ event: 'user_error_report_persist_failed', company_id: report.companyId }));
      return false;
    }
  };
}

module.exports = { createUserErrorReporter, normalizeEvent };