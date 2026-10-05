'use strict';

const session = require('express-session');
const { getControlDatabase } = require('./control-db');

class ControlDatabaseSessionStore extends session.Store {
  constructor({ getDatabase = getControlDatabase } = {}) {
    super();
    this.getDatabase = getDatabase;
  }

  get(sessionId, callback) {
    Promise.resolve()
      .then(() => this.getDatabase())
      .then(async database => {
        const result = await database.execute({
          sql: 'SELECT data, expires_at FROM web_sessions WHERE sid = ? LIMIT 1',
          args: [sessionId]
        });
        const row = result.rows?.[0];
        if (!row) return null;
        if (Number(row.expires_at) <= Date.now()) {
          await database.execute({ sql: 'DELETE FROM web_sessions WHERE sid = ?', args: [sessionId] });
          return null;
        }
        return JSON.parse(row.data);
      })
      .then(value => callback(null, value), callback);
  }

  set(sessionId, sessionData, callback) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + Number(sessionData.cookie?.maxAge || 86400000);
    const userId = sessionData.userId == null ? null : Number(sessionData.userId);
    const companyId = sessionData.companyId == null ? null : String(sessionData.companyId);

    Promise.resolve()
      .then(() => this.getDatabase())
      .then(database => database.execute({
        sql: `INSERT INTO web_sessions (sid, data, user_id, company_id, expires_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET data = excluded.data, user_id = excluded.user_id,
            company_id = excluded.company_id, expires_at = excluded.expires_at`,
        args: [sessionId, JSON.stringify(sessionData), userId, companyId, expiresAt]
      }))
      .then(() => callback?.(null), error => callback?.(error));
  }

  destroy(sessionId, callback) {
    Promise.resolve()
      .then(() => this.getDatabase())
      .then(database => database.execute({ sql: 'DELETE FROM web_sessions WHERE sid = ?', args: [sessionId] }))
      .then(() => callback?.(null), error => callback?.(error));
  }

  touch(sessionId, sessionData, callback) {
    const expiresAt = sessionData.cookie?.expires
      ? new Date(sessionData.cookie.expires).getTime()
      : Date.now() + Number(sessionData.cookie?.maxAge || 86400000);

    Promise.resolve()
      .then(() => this.getDatabase())
      .then(database => database.execute({
        sql: 'UPDATE web_sessions SET expires_at = ? WHERE sid = ?',
        args: [expiresAt, sessionId]
      }))
      .then(() => callback?.(null), error => callback?.(error));
  }
}

module.exports = { ControlDatabaseSessionStore };
