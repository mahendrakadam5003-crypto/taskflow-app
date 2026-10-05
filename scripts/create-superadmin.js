'use strict';

const bcrypt = require('bcryptjs');
const { closeControlDatabase, getControlDatabase } = require('../control-db');

async function createInitialSuperAdmin(environment = process.env, getDatabase = getControlDatabase) {
  const name = String(environment.SUPERADMIN_NAME || '').trim();
  const email = String(environment.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(environment.SUPERADMIN_PASSWORD || '');
  if (!name || name.length > 120) throw new Error('SUPERADMIN_NAME must contain 1 to 120 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('SUPERADMIN_EMAIL must be a valid email address of at most 254 characters.');
  }
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < 12 || passwordBytes > 72) {
    throw new Error('SUPERADMIN_PASSWORD must contain between 12 and 72 UTF-8 bytes.');
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
      sql: 'INSERT INTO super_admins (name, email, password_hash) VALUES (?, ?, ?)',
      args: [name, email, passwordHash]
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
