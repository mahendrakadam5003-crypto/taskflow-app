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

function getBootstrapCredentials(environment) {
  const rawUsername = String(environment.SUPERADMIN_USERNAME || '').trim();
  const password = String(environment.SUPERADMIN_PASSWORD || '');
  if (!rawUsername && !password) return null;
  if (!rawUsername || !password) {
    throw new Error('Both SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD must be set for initial account bootstrap.');
  }

  const username = rawUsername.toLowerCase();
  const name = String(environment.SUPERADMIN_NAME || username).trim();
  if (!username || username.length > 80 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error('SUPERADMIN_USERNAME must contain 1 to 80 printable characters.');
  }
  if (!name || name.length > 120) throw new Error('SUPERADMIN_NAME must contain 1 to 120 characters.');
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < 10 || passwordBytes > 72) {
    throw new Error('SUPERADMIN_PASSWORD must contain between 10 and 72 UTF-8 bytes.');
  }
  return { name, password, username };
}

async function bootstrapConfiguredSuperAdmin(environment = process.env, getDatabase = getControlDatabase) {
  const configured = getBootstrapCredentials(environment);
  if (!configured) return false;

  const controlDb = await getDatabase();
  const transaction = await controlDb.transaction('write');
  try {
    const result = await transaction.execute({
      sql: 'SELECT id, password_hash FROM super_admins WHERE lower(username) = ? LIMIT 1',
      args: [configured.username]
    });
    const existingAdmin = result.rows?.[0];
    if (existingAdmin) {
      if (await bcrypt.compare(configured.password, existingAdmin.password_hash)) {
        await transaction.rollback();
        return 'unchanged';
      }
      const passwordHash = await bcrypt.hash(configured.password, 12);
      await transaction.execute({
        sql: `UPDATE super_admins
          SET name = ?, password_hash = ?, token_version = token_version + 1
          WHERE id = ?`,
        args: [configured.name, passwordHash, Number(existingAdmin.id)]
      });
      await transaction.execute({
        sql: 'INSERT INTO super_admin_audit (super_admin_id, action, details) VALUES (?, ?, ?)',
        args: [Number(existingAdmin.id), 'Super-admin bootstrap credentials updated', 'Credentials updated from deployment settings']
      });
      await transaction.commit();
      return 'updated';
    }

    const adminCount = await transaction.execute('SELECT COUNT(*) AS count FROM super_admins');
    if (Number(adminCount.rows?.[0]?.count || 0) > 0) {
      throw new Error('A different super-admin username already exists; refusing to replace or add accounts.');
    }
    const passwordHash = await bcrypt.hash(configured.password, 12);
    const insertResult = await transaction.execute({
      sql: 'INSERT INTO super_admins (name, username, password_hash) VALUES (?, ?, ?)',
      args: [configured.name, configured.username, passwordHash]
    });
    await transaction.execute({
      sql: 'INSERT INTO super_admin_audit (super_admin_id, action, details) VALUES (?, ?, ?)',
      args: [Number(insertResult.lastInsertRowid), 'Initial super-admin account created', 'Initial credentials set from deployment settings']
    });
    await transaction.commit();
    return 'created';
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

if (require.main === module) {
  bootstrapConfiguredSuperAdmin()
    .then(result => {
      if (result === 'created') console.log('Initial super-admin account created. Sign in at /superadmin.');
      else if (result === 'updated') console.log('Super-admin credentials updated. Sign in at /superadmin.');
      else if (result === 'unchanged') console.log('Configured super-admin account is ready.');
      else console.log('Super-admin bootstrap credentials are not configured.');
    })
    .catch(error => {
      console.error(`Super-admin bootstrap failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(closeControlDatabase);
}

module.exports = { bootstrapConfiguredSuperAdmin, createInitialSuperAdmin, getBootstrapCredentials };
