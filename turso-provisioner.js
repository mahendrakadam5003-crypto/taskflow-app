'use strict';

const axios = require('axios');

class TursoDatabaseCreatedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TursoDatabaseCreatedError';
    this.databaseCreated = true;
  }
}

function createTursoProvisioner({
  environment = process.env,
  http = axios
} = {}) {
  const token = String(environment.TURSO_PLATFORM_TOKEN || '').trim().replace(/^Bearer\s+/i, '').trim();
  const organization = String(environment.TURSO_ORG || '').trim();
  const group = String(environment.TURSO_GROUP || 'default').trim();
  if (!token || !organization || !group) {
    throw new Error('TURSO_PLATFORM_TOKEN, TURSO_ORG, and a valid TURSO_GROUP are required to provision a company database.');
  }

  const headers = { Authorization: `Bearer ${token}` };
  const organizationPath = `/v1/organizations/${encodeURIComponent(organization)}`;

  return {
    async createDatabase(databaseName) {
      const response = await http.post(`https://api.turso.tech${organizationPath}/databases`, {
        name: databaseName,
        group
      }, { headers });
      const database = response.data?.database;
      const hostname = String(database?.Hostname || database?.hostname || '').trim();
      if (!hostname) throw new TursoDatabaseCreatedError('Turso created the database but did not return its hostname.');
      return { databaseUrl: `libsql://${hostname}` };
    },

    async createDatabaseToken(databaseName) {
      const response = await http.post(
        `https://api.turso.tech${organizationPath}/databases/${encodeURIComponent(databaseName)}/auth/tokens?expiration=never&authorization=full-access`,
        {},
        { headers }
      );
      const databaseToken = response.data?.jwt;
      if (typeof databaseToken !== 'string' || !databaseToken) {
        throw new Error('Turso did not return a database authorization token.');
      }
      return databaseToken;
    },

    async deleteDatabase(databaseName) {
      await http.delete(
        `https://api.turso.tech${organizationPath}/databases/${encodeURIComponent(databaseName)}`,
        { headers }
      );
    }
  };
}

module.exports = { TursoDatabaseCreatedError, createTursoProvisioner };
