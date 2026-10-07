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

function safeErrorDiagnostics(error) {
  const diagnostics = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && diagnostics.length < 4 && !seen.has(current)) {
    seen.add(current);
    const type = typeof current.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(current.name)
      ? current.name : 'Error';
    const code = typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(current.code)
      ? current.code : null;
    const message = typeof current.message === 'string'
      ? current.message.replace(/^(?:SQLITE_[A-Z_]+:\s*)+/i, '').trim()
      : '';
    const safeSummary = [
      /^no such (?:table|column|index|function): [A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/i,
      /^table [A-Za-z_][A-Za-z0-9_]* has no column named [A-Za-z_][A-Za-z0-9_]*$/i,
      /^(?:database is (?:locked|busy)|foreign key constraint failed|datatype mismatch|string or blob too big)$/i,
      /^(?:unique|not null|check) constraint failed(?:: [A-Za-z0-9_., ]+| \([A-Za-z0-9_]+\))?$/i,
      /^near '[A-Za-z_][A-Za-z0-9_]*': syntax error$/i,
      /^database access attempted without a tenant company context\.?$/i
    ].some(pattern => pattern.test(message)) ? message.slice(0, 180) : ({
      ECONNRESET: 'Connection reset by remote host.',
      ECONNREFUSED: 'Connection refused.',
      ETIMEDOUT: 'Connection timed out.',
      EAI_AGAIN: 'DNS resolution temporarily failed.',
      ENOTFOUND: 'DNS host not found.',
      SQLITE_BUSY: 'Database is busy or locked.',
      SQLITE_LOCKED: 'Database is locked.'
    })[code] || null;
    const diagnostic = { type, code, summary: safeSummary };
    const stack = typeof current.stack === 'string' ? current.stack.split('\n').slice(1) : [];
    for (const frame of stack) {
      const match = frame.replace(/\\/g, '/').match(/(?:^|\/)(routes|lib|public|scripts|server\.js)\/(?:([^():]+\.js):)?(\d+):\d+/);
      if (match) {
        diagnostic.location = match[1] === 'server.js' ? `server.js:${match[3]}` : `${match[1]}/${match[2]}:${match[3]}`;
        break;
      }
      const serverMatch = frame.replace(/\\/g, '/').match(/(?:^|\/)server\.js:(\d+):\d+/);
      if (serverMatch) {
        diagnostic.location = `server.js:${serverMatch[1]}`;
        break;
      }
    }
    diagnostics.push(diagnostic);
    current = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : null);
  }
  return diagnostics.length ? JSON.stringify(diagnostics) : null;
}

function createUserErrorReporter({
  getDatabase = getControlDatabase,
  isConfigured = hasControlDatabaseConfiguration,
  logger = console.warn
} = {}) {
  return async function reportUserError(req, event, statusCode = 500, error = null) {
    if (!Number.isInteger(statusCode) || statusCode < 500 || !isConfigured()) return false;
    if (req?.userErrorReportStarted) return false;
    if (req) req.userErrorReportStarted = true;

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
      statusCode,
      diagnostics: safeErrorDiagnostics(error)
    };

    try {
      const controlDb = await getDatabase();
      await controlDb.execute({
        sql: `INSERT INTO user_error_reports (
          company_id, company_code, actor_user_id, request_id, event, method, route, status_code, diagnostics
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [report.companyId, report.companyCode, report.actorUserId, report.requestId,
          report.event, report.method, report.route, report.statusCode, report.diagnostics]
      });
      return true;
    } catch (error) {
      logger(JSON.stringify({ event: 'user_error_report_persist_failed', company_id: report.companyId }));
      return false;
    }
  };
}

module.exports = { createUserErrorReporter, normalizeEvent, safeErrorDiagnostics };