'use strict';

const bcrypt = require('bcryptjs');
const { closeControlDatabase, getControlDatabase } = require('../control-db');

async function createInitialSuperAdmin(environment = process.env, getDatabase = getControlDatabase) {
  const username = String(environment.SUPERADMIN_USERNAME || '').trim().toLowerCase();
  const name = String(environment.SUPERADMIN_NAME || username).trim();
  const password = String(environment.SUPERADMIN_PASSWORD || '');
  if (!username || username.length > 80 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error('SUPERADMIN_USERNAME must contain 1 to 80 printable characters.');
  }
  if (!name || name.length > 120) throw new Error('SUPERADMIN_NAME must contain 1 to 120 characters.');
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < 10 || passwordBytes > 72) {
    throw new Error('SUPERADMIN_PASSWORD must contain between 10 and 72 UTF-8 bytes.');
  }

  const controlDb = await getDatabase();
  const transaction = await controlDb.transaction('write');
  try {
    const admins = await transaction.execute('SELECT COUNT(*) AS count FROM super_admins');
    if (Number(admins.rows?.[0]?.count || 0) !== 0) {
      throw new Error('A super-admin already exists; bootstrap will not add or replace accounts.');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await transaction.execute({
      sql: 'INSERT INTO super_admins (name, username, password_hash) VALUES (?, ?, ?)',
      args: [name, username, passwordHash]
    });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

if (require.main === module) {
  createInitialSuperAdmin()
    .then(() => console.log('Initial super-admin account created. Sign in at /superadmin.'))
    .catch(error => {
      console.error(`Super-admin bootstrap failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(closeControlDatabase);
}

module.exports = { createInitialSuperAdmin };
