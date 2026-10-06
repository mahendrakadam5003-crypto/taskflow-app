const db = require('./db');

async function logActivity(req, action, entityType, entityId, details = '', subjectUserId = null) {
  const result = await db.prepare(`INSERT INTO activity_log (actor_id, subject_user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    req.session.userId,
    subjectUserId == null ? null : Number(subjectUserId),
    action,
    entityType,
    entityId == null ? null : Number(entityId),
    details
  );
  return result.lastInsertRowid;
}

async function notifyActivityRecipients(activityId, userIds) {
  const id = Number(activityId);
  const recipients = [...new Set((userIds || []).map(Number))]
    .filter(userId => Number.isSafeInteger(userId) && userId > 0);
  if (!Number.isSafeInteger(id) || id < 1 || !recipients.length) return;
  await db.batch(recipients.map(userId => ({
    sql: 'INSERT OR IGNORE INTO activity_notification_recipients (activity_id, user_id) VALUES (?, ?)',
    args: [id, userId]
  })));
}

module.exports = { logActivity, notifyActivityRecipients };
