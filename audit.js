const db = require('./db');

async function logActivity(req, action, entityType, entityId, details = '', subjectUserId = null) {
  await db.prepare(`INSERT INTO activity_log (actor_id, subject_user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    req.session.userId,
    subjectUserId == null ? null : Number(subjectUserId),
    action,
    entityType,
    entityId == null ? null : Number(entityId),
    details
  );
}

module.exports = { logActivity };
