const db = require('./db');
const { sendPushToUsers } = require('./lib/firebase-push');

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
  const activityId = result.lastInsertRowid;
  if (subjectUserId != null && Number(subjectUserId) !== Number(req.session.userId)) {
    await notifyActivityRecipients(activityId, [subjectUserId]);
  }
  return activityId;
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
  try {
    const activity = await db.prepare(`SELECT al.action, al.details, al.entity_type, al.entity_id, t.project_id AS task_project_id,
        actor.name AS actor_name, subject.name AS subject_name, t.title AS task_title
      FROM activity_log al
      LEFT JOIN users actor ON actor.id = al.actor_id
      LEFT JOIN users subject ON subject.id = al.subject_user_id
      LEFT JOIN tasks t ON al.entity_type = 'task' AND t.id = al.entity_id
      WHERE al.id = ?`).get(id);
    await sendPushToUsers(db, recipients, { activityId: id, ...activity });
  } catch (error) {
    console.error(JSON.stringify({ event: 'activity_push_send_failed' }));
  }
}

async function notifyAdmins(req, activityId) {
  try {
    const admins = await db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
    await notifyActivityRecipients(activityId, (admins || [])
      .map(admin => Number(admin.id))
      .filter(userId => userId !== Number(req.session.userId)));
  } catch (error) {
    console.error(JSON.stringify({ event: 'admin_activity_push_failed' }));
  }
}

module.exports = { logActivity, notifyActivityRecipients, notifyAdmins };
