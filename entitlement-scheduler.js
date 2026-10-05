'use strict';

const { getControlDatabase } = require('./control-db');
const { hasControlDatabaseConfiguration } = require('./tenant-manager');
const { createMailer } = require('./mailer');
const { parseAccessDate } = require('./entitlements');

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DATA_NOTICE = 'Trial data may be deleted at any time after the trial ends. Export anything you need. No data retention or backup is guaranteed.';

function calendarDaysRemaining(value, now) {
  const end = parseAccessDate(value, { endOfDay: true });
  if (end == null) return null;
  return Math.floor((end - now.getTime()) / DAY_MS);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function createEntitlementScheduler({
  getDatabase = getControlDatabase,
  isConfigured = hasControlDatabaseConfiguration,
  mailer = createMailer(),
  now = () => new Date(),
  logger = console.warn
} = {}) {
  let activeRun = null;

  async function sendOnce(companyId, email, eventKey, notificationType, subject, text) {
    if (!email) return false;
    const controlDb = await getDatabase();
    await controlDb.execute({
      sql: `INSERT OR IGNORE INTO entitlement_notifications (company_id, event_key, notification_type, recipient_email)
        VALUES (?, ?, ?, ?)`,
      args: [companyId, eventKey, notificationType, email]
    });
    const result = await controlDb.execute({
      sql: `UPDATE entitlement_notifications SET status = 'sending', attempts = attempts + 1,
        last_attempt_at = datetime('now') WHERE company_id = ? AND event_key = ?
        AND (status IN ('pending', 'failed')
          OR (status = 'sending' AND last_attempt_at <= datetime('now', '-15 minutes')))`,
      args: [companyId, eventKey]
    });
    if (Number(result.rowsAffected || 0) !== 1) return false;
    const notification = await controlDb.execute({
      sql: 'SELECT id FROM entitlement_notifications WHERE company_id = ? AND event_key = ? LIMIT 1',
      args: [companyId, eventKey]
    });
    const notificationId = Number(notification.rows?.[0]?.id);
    if (!Number.isSafeInteger(notificationId) || notificationId < 1) return false;
    try {
      await mailer.send({ to: email, subject, text });
      await controlDb.execute({
        sql: "UPDATE entitlement_notifications SET status = 'sent', sent_at = datetime('now') WHERE id = ?",
        args: [notificationId]
      });
      return true;
    } catch (error) {
      await controlDb.execute({
        sql: "UPDATE entitlement_notifications SET status = 'failed' WHERE id = ?",
        args: [notificationId]
      });
      logger(JSON.stringify({ event: 'entitlement_email_failed', company_id: companyId, notification_type: notificationType }));
      return false;
    }
  }

  async function notifyStorageWarning(companyId, threshold, usedBytes, limitBytes) {
    if (!isConfigured() || ![80, 95].includes(Number(threshold))) return false;
    try {
      const controlDb = await getDatabase();
      const companyResult = await controlDb.execute({
        sql: "SELECT id, name, owner_email FROM companies WHERE id = ? AND status <> 'deleted' LIMIT 1",
        args: [Number(companyId)]
      });
      const company = companyResult.rows?.[0];
      if (!company?.owner_email) return false;
      return await sendOnce(
        Number(company.id),
        company.owner_email,
        `storage-${Number(threshold)}`,
        'storage_warning',
        `TaskFlow storage usage at ${Number(threshold)}%`,
        `${company.name} has used ${formatBytes(usedBytes)} of ${formatBytes(limitBytes)} storage (${Number(threshold)}% or more). Contact support to discuss additional capacity.`
      );
    } catch (error) {
      logger(JSON.stringify({ event: 'storage_warning_email_failed', company_id: Number(companyId) || null }));
      return false;
    }
  }

  async function runOnce() {
    if (!isConfigured()) return { skipped: true };
    const controlDb = await getDatabase();
    const [settingsResult, companiesResult] = await Promise.all([
      controlDb.execute('SELECT trial_days, grace_period_days, read_only_period_days FROM pricing_settings WHERE id = 1'),
      controlDb.execute(`SELECT c.id, c.name, c.owner_email, c.status, c.trial_ends_at, c.delete_after,
          c.trial_policy_version, s.id AS subscription_id, s.status AS subscription_status,
          s.current_period_end
        FROM companies c LEFT JOIN subscriptions s ON s.id = (
          SELECT latest.id FROM subscriptions latest WHERE latest.company_id = c.id ORDER BY latest.id DESC LIMIT 1
        ) WHERE c.status <> 'deleted' ORDER BY c.id`)
    ]);
    const settings = settingsResult.rows?.[0] || { trial_days: 7, grace_period_days: 3, read_only_period_days: 7 };
    const currentTime = now();
    let remindersSent = 0;
    let trialsScheduledForDeletion = 0;
    let subscriptionsPastDue = 0;
    let subscriptionsExpired = 0;

    for (const company of companiesResult.rows || []) {
      const companyId = Number(company.id);
      const endTime = parseAccessDate(company.trial_ends_at, { endOfDay: true });
      const remainingDays = company.trial_ends_at ? calendarDaysRemaining(company.trial_ends_at, currentTime) : null;
      const hasPaidSubscription = ['active', 'past_due'].includes(company.subscription_status);

      if (company.status === 'trial' && Number(company.trial_policy_version) === 1 && !hasPaidSubscription && endTime != null) {
        const reminderDay = new Map([[2, 5], [1, 6], [0, 7]]).get(remainingDays);
        if (reminderDay) {
          const sent = await sendOnce(
            companyId,
            company.owner_email,
            `trial-day-${reminderDay}`,
            'trial_reminder',
            `TaskFlow trial ends in ${remainingDays} day${remainingDays === 1 ? '' : 's'}`,
            `Your TaskFlow trial ends on ${company.trial_ends_at}. ${TRIAL_DATA_NOTICE}`
          );
          if (sent) remindersSent += 1;
        }
        if (currentTime.getTime() > endTime && !company.delete_after) {
          const deleteAfter = new Date(endTime + 7 * DAY_MS).toISOString().slice(0, 10);
          const updated = await controlDb.execute({
            sql: `UPDATE companies SET delete_after = ?
              WHERE id = ? AND status = 'trial' AND trial_policy_version = 1 AND delete_after IS NULL`,
            args: [deleteAfter, companyId]
          });
          if (Number(updated.rowsAffected || 0) === 1) trialsScheduledForDeletion += 1;
          await controlDb.execute({
            sql: `INSERT INTO super_admin_audit (company_id, action, details)
              VALUES (?, ?, ?)`,
            args: [companyId, 'Trial ended; deletion scheduled', `New-policy trial data scheduled for deletion after ${deleteAfter}.`]
          });
        }
      }

      const subscriptionEnd = parseAccessDate(company.current_period_end, { endOfDay: true });
      if (company.subscription_id && company.subscription_status === 'active' && subscriptionEnd != null) {
        const renewalDays = calendarDaysRemaining(company.current_period_end, currentTime);
        if ([7, 3, 1].includes(renewalDays)) {
          const sent = await sendOnce(
            companyId,
            company.owner_email,
            `renewal-${company.current_period_end}-${renewalDays}`,
            'renewal_reminder',
            `TaskFlow renewal in ${renewalDays} day${renewalDays === 1 ? '' : 's'}`,
            `Your TaskFlow subscription for ${company.name} renews on ${company.current_period_end}.`
          );
          if (sent) remindersSent += 1;
        }
        if (currentTime.getTime() > subscriptionEnd) {
          await controlDb.execute({
            sql: "UPDATE subscriptions SET status = 'past_due' WHERE id = ? AND status = 'active' AND current_period_end <= ?",
            args: [Number(company.subscription_id), currentTime.toISOString()]
          });
          subscriptionsPastDue += 1;
        }
      }

      if (company.subscription_id && company.subscription_status === 'past_due' && subscriptionEnd != null) {
        const lockAfter = subscriptionEnd
          + (Number(settings.grace_period_days) || 0) * DAY_MS
          + (Number(settings.read_only_period_days) || 0) * DAY_MS;
        if (currentTime.getTime() > lockAfter) {
          const expired = await controlDb.execute({
            sql: "UPDATE subscriptions SET status = 'expired' WHERE id = ? AND status = 'past_due'",
            args: [Number(company.subscription_id)]
          });
          subscriptionsExpired += Number(expired.rowsAffected || 0);
        }
      }
    }

    return { remindersSent, trialsScheduledForDeletion, subscriptionsPastDue, subscriptionsExpired };
  }

  function runEntitlementMaintenance() {
    if (!activeRun) {
      activeRun = runOnce().finally(() => { activeRun = null; });
    }
    return activeRun;
  }

  return { notifyStorageWarning, runEntitlementMaintenance };
}

module.exports = { createEntitlementScheduler, formatBytes };