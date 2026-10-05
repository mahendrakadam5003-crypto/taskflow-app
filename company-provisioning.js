'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');
const {
  encryptTenantDatabaseToken,
  getControlDatabase
} = require('./control-db');
const { initTenantSchema } = require('./tenant-schema');
const { createTursoProvisioner } = require('./turso-provisioner');
const { createIdentityAuthRouter } = require('./routes/identity-auth');
const { createMailer } = require('./mailer');

const COMPANY_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_COMPANY_CODES = new Set(['www', 'admin', 'api', 'superadmin', 'app']);
const TRIAL_LENGTH_DAYS = 7;

class ProvisioningError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ProvisioningError';
    this.statusCode = statusCode;
  }
}

function validateProvisioningInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProvisioningError('Enter company and administrator details.');
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  const adminName = typeof body.adminName === 'string' ? body.adminName.trim() : '';
  const requestedAdminUsername = typeof body.adminUsername === 'string' ? body.adminUsername.trim().toLowerCase() : '';
  const ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : '';
  const planId = Number(body.planId);

  if (!name || name.length > 160) throw new ProvisioningError('Company name must contain 1 to 160 characters.');
  if (code.length > 61 || !COMPANY_CODE_PATTERN.test(code)) {
    throw new ProvisioningError('Company code must use 1 to 61 lowercase letters, numbers, and single hyphens only.');
  }
  if (RESERVED_COMPANY_CODES.has(code)) throw new ProvisioningError('That company code is reserved.');
  if (!adminName || adminName.length > 120) throw new ProvisioningError('Administrator name must contain 1 to 120 characters.');
  const adminUsername = requestedAdminUsername || `email-${crypto.randomUUID()}`;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(adminUsername)) {
    throw new ProvisioningError('Administrator username must use 1 to 64 lowercase letters, numbers, dots, underscores, or hyphens.');
  }
  if (!ownerEmail || ownerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new ProvisioningError('A valid owner email address is required for the administrator invitation.');
  }
  if (!Number.isSafeInteger(planId) || planId < 1) throw new ProvisioningError('Choose an active plan.');

  return { name, code, adminName, adminUsername, ownerEmail: ownerEmail || null, planId };
}

function createCompanyProvisioner({
  environment = process.env,
  getDatabase = getControlDatabase,
  createTursoClient = createTursoProvisioner,
  createTenantClient = createClient,
  initializeTenantSchema = initTenantSchema,
  encryptToken = encryptTenantDatabaseToken,
  hashPassword = password => bcrypt.hash(password, 10),
  mailer,
  localTenantRoot = path.join(__dirname, 'tenants'),
  now = () => new Date()
} = {}) {
  const emailMailer = mailer || createMailer({ environment });
  return async function provisionCompany(body, admin) {
    const input = validateProvisioningInput(body);
    const controlDb = await getDatabase();
    const [companyCodeResult, planResult, pricingSettingsResult] = await Promise.all([
      controlDb.execute({
        sql: 'SELECT id FROM companies WHERE code = ? LIMIT 1',
        args: [input.code]
      }),
      controlDb.execute({
        sql: 'SELECT id FROM plans WHERE id = ? AND is_active = 1 LIMIT 1',
        args: [input.planId]
      }),
      controlDb.execute({ sql: 'SELECT trial_days FROM pricing_settings WHERE id = 1', args: [] })
    ]);
    if (companyCodeResult.rows?.[0]) throw new ProvisioningError('That company code is already in use.', 409);
    if (!planResult.rows?.[0]) throw new ProvisioningError('Choose an active plan.', 400);
    if (!environment.APP_BASE_URL || !emailMailer.isConfigured?.()) {
      throw new ProvisioningError('Configure APP_BASE_URL and SMTP delivery before provisioning invited accounts.', 503);
    }

    const databaseName = `tf-${input.code}`;
    const passwordHash = await hashPassword(crypto.randomBytes(48).toString('base64url'));
    const configuredTrialDays = Number(pricingSettingsResult.rows?.[0]?.trial_days);
    const trialDays = Number.isSafeInteger(configuredTrialDays) && configuredTrialDays >= 1 && configuredTrialDays <= 60
      ? configuredTrialDays
      : TRIAL_LENGTH_DAYS;
    const trialEndsAt = new Date(now().getTime() + trialDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    let tenantDatabaseUrl;
    let tenantDatabaseToken;
    let databaseCreated = false;
    let localDatabasePath;
    let tenantClient;
    let transaction;
    let turso;

    try {
      if (environment.USE_LOCAL_DB === '1') {
        await fs.mkdir(localTenantRoot, { recursive: true });
        localDatabasePath = path.join(localTenantRoot, `${input.code}.db`);
        const fileHandle = await fs.open(localDatabasePath, 'wx');
        databaseCreated = true;
        await fileHandle.close();
        tenantDatabaseUrl = `file:${localDatabasePath.replace(/\\/g, '/')}`;
        tenantDatabaseToken = 'local-tenant-database';
      } else {
        turso = createTursoClient({ environment });
        try {
          const databaseUrlResult = await turso.createDatabase(databaseName);
          databaseCreated = true;
          tenantDatabaseUrl = databaseUrlResult.databaseUrl;
        } catch (error) {
          if (error.databaseCreated === true) databaseCreated = true;
          throw error;
        }
        tenantDatabaseToken = await turso.createDatabaseToken(databaseName);
      }

      tenantClient = createTenantClient({ url: tenantDatabaseUrl, authToken: tenantDatabaseToken });
      await initializeTenantSchema(tenantClient, { seedInitialAdmin: false });
      const createdAdmin = await tenantClient.execute({
        sql: `INSERT INTO users
          (name, username, password_hash, role, department, active, must_change_password, email, auth_provider)
          VALUES (?, ?, ?, 'admin', '', 1, 0, ?, 'email')`,
        args: [input.adminName, input.adminUsername, passwordHash, input.ownerEmail]
      });
      const adminId = Number(createdAdmin.lastInsertRowid);
      if (!Number.isSafeInteger(adminId) || adminId < 1) throw new Error('New company administrator ID was not returned.');

      transaction = await controlDb.transaction('write');
      const insertResult = await transaction.execute({
        sql: `INSERT INTO companies (
          code, name, owner_name, owner_email, status, plan_id, trial_ends_at,
          tenant_db_url, tenant_db_token_encrypted, notes, tenant_db_name, trial_policy_version
        ) VALUES (?, ?, ?, ?, 'trial', ?, ?, ?, ?, ?, ?, 1)`,
        args: [
          input.code,
          input.name,
          input.adminName,
          input.ownerEmail,
          input.planId,
          trialEndsAt,
          tenantDatabaseUrl,
          encryptToken(tenantDatabaseToken),
          'Provisioned from the super-admin company form.',
          environment.USE_LOCAL_DB === '1' ? input.code : databaseName
        ]
      });
      const companyId = Number(insertResult.lastInsertRowid);
      const identity = createIdentityAuthRouter({
        database: {
          prepare(sql) {
            return {
              async get(...args) {
                const result = await tenantClient.execute({ sql, args });
                return result.rows?.[0] || null;
              },
              async run(...args) {
                const result = await tenantClient.execute({ sql, args });
                return {
                  changes: Number(result.rowsAffected || 0),
                  lastInsertRowid: Number(result.lastInsertRowid || 0)
                };
              }
            };
          }
        },
        mailer: emailMailer,
        environment
      });
      const invitation = await identity.sendInvitationEmail(
        { companyCode: input.code },
        { id: adminId, email: input.ownerEmail }
      );
      if (!invitation.sent) throw new ProvisioningError(invitation.error || 'Administrator invitation could not be sent.', 503);
      await transaction.execute({
        sql: 'INSERT INTO super_admin_audit (super_admin_id, company_id, action, details) VALUES (?, ?, ?, ?)',
        args: [admin.id, companyId, 'Company provisioned', `Created company ${input.code} on trial through ${trialEndsAt}.`]
      });
      await transaction.commit();
      transaction = null;
      await tenantClient.close?.();
      tenantClient = null;

      return {
        company: {
          id: companyId,
          code: input.code,
          name: input.name,
          status: 'trial',
          trialEndsAt,
          planId: input.planId
        },
        admin: {
          name: input.adminName,
          username: input.adminUsername,
          email: input.ownerEmail,
          invitationSent: true
        }
      };
    } catch (error) {
      if (transaction) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error(JSON.stringify({ event: 'company_provisioning_control_rollback_failed', company_id: null }));
        }
      }
      if (tenantClient) {
        try {
          await tenantClient.close?.();
        } catch (closeError) {
          console.error(JSON.stringify({ event: 'company_provisioning_tenant_close_failed', company_id: null }));
        }
      }
      if (databaseCreated) {
        if (localDatabasePath) {
          try {
            await fs.rm(localDatabasePath, { force: true });
            await fs.rm(`${localDatabasePath}-wal`, { force: true });
            await fs.rm(`${localDatabasePath}-shm`, { force: true });
          } catch (rollbackError) {
            console.error(JSON.stringify({ event: 'company_provisioning_local_database_cleanup_failed', company_id: null }));
          }
        } else {
          try {
            if (!turso) turso = createTursoClient({ environment });
            await turso.deleteDatabase(databaseName);
          } catch (rollbackError) {
            console.error(JSON.stringify({ event: 'company_provisioning_remote_database_cleanup_failed', company_id: null }));
          }
        }
      }
      if (error instanceof ProvisioningError) throw error;
      console.error(JSON.stringify({ event: 'company_provisioning_failed', company_id: null }));
      throw new ProvisioningError('Company provisioning failed. Verify Turso settings and retry; no company was registered.', 502);
    }
  };
}

const provisionCompany = createCompanyProvisioner();

module.exports = {
  COMPANY_CODE_PATTERN,
  RESERVED_COMPANY_CODES,
  TRIAL_LENGTH_DAYS,
  ProvisioningError,
  createCompanyProvisioner,
  provisionCompany,
  validateProvisioningInput
};
