'use strict';

const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { test } = require('node:test');
const { migrateControlDatabase } = require('../control-db');
const { createEntitlementScheduler } = require('../entitlement-scheduler');

async function insertCompany(client, { code, status, trialEndsAt, trialPolicyVersion = null, ownerEmail }) {
  const result = await client.execute({
    sql: `INSERT INTO companies (
      code, name, owner_email, status, plan_id, trial_ends_at, tenant_db_url,
      tenant_db_token_encrypted, trial_policy_version
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    args: [code, code, ownerEmail, status, trialEndsAt, `libsql://${code}.example`, 'ciphertext', trialPolicyVersion]
  });
  return Number(result.lastInsertRowid);
}

test('daily entitlement maintenance is idempotent and does not schedule tenant purges', async () => {
  const client = createClient({ url: 'file::memory:' });
  const deliveries = [];
  try {
    await migrateControlDatabase(client);
    const trialSoonId = await insertCompany(client, {
      code: 'trial-soon', status: 'trial', trialEndsAt: '2026-10-08', trialPolicyVersion: 1, ownerEmail: 'trial@example.test'
    });
    const expiredNewTrialId = await insertCompany(client, {
      code: 'expired-new-trial', status: 'trial', trialEndsAt: '2026-10-01', trialPolicyVersion: 1, ownerEmail: 'expired@example.test'
    });
    const expiredLegacyTrialId = await insertCompany(client, {
      code: 'expired-legacy-trial', status: 'trial', trialEndsAt: '2026-10-01', ownerEmail: 'legacy@example.test'
    });
    const paidCompanyId = await insertCompany(client, {
      code: 'paid-company', status: 'active', trialEndsAt: null, ownerEmail: 'paid@example.test'
    });
    await client.execute({
      sql: `INSERT INTO subscriptions (
        company_id, billing_cycle, seats, unit_price_paise, status,
        current_period_start, current_period_end, provider
      ) VALUES (?, 'monthly', 3, 19900, 'active', ?, ?, 'manual')`,
      args: [paidCompanyId, '2026-09-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z']
    });

    const scheduler = createEntitlementScheduler({
      getDatabase: async () => client,
      isConfigured: () => true,
      now: () => new Date('2026-10-06T12:00:00.000Z'),
      mailer: { async send(message) { deliveries.push(message); return { accepted: true }; } },
      logger: message => assert.fail(message)
    });

    const first = await scheduler.runEntitlementMaintenance();
    const second = await scheduler.runEntitlementMaintenance();
    assert.equal(first.remindersSent, 1);
    assert.equal(first.trialsScheduledForDeletion, 0);
    assert.equal(first.subscriptionsPastDue, 1);
    assert.equal(second.remindersSent, 0);
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].text, /Automatic workspace deletion is disabled/);

    const deletionDates = await client.execute({
      sql: 'SELECT id, delete_after FROM companies WHERE id IN (?, ?, ?) ORDER BY id',
      args: [trialSoonId, expiredNewTrialId, expiredLegacyTrialId]
    });
    assert.deepEqual(deletionDates.rows.map(row => row.delete_after), [null, null, null]);
    const subscription = await client.execute({ sql: 'SELECT status FROM subscriptions WHERE company_id = ?', args: [paidCompanyId] });
    assert.equal(subscription.rows[0].status, 'past_due');

    assert.equal(await scheduler.notifyStorageWarning(trialSoonId, 80, 819, 1024), true);
    assert.equal(await scheduler.notifyStorageWarning(trialSoonId, 80, 819, 1024), false);
    assert.equal(await scheduler.notifyStorageWarning(trialSoonId, 95, 973, 1024), true);
    assert.equal(deliveries.length, 3);
  } finally {
    await client.close();
  }
});