'use strict';

function getServiceAccount() {
  const serviceAccountJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!serviceAccountJson) return null;
  const serviceAccount = JSON.parse(serviceAccountJson);
  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) return null;
  return serviceAccount;
}

function isFirebasePushConfigured() {
  try { return !!getServiceAccount(); } catch { return false; }
}

function getFirebaseMessaging() {
  const serviceAccount = getServiceAccount();
  if (!serviceAccount) return null;
  const firebaseAdmin = require('firebase-admin');
  const existingApp = firebaseAdmin.apps.find(app => app.name === 'taskflow-push');
  if (existingApp) return existingApp.messaging();
  const app = firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  }, 'taskflow-push');
  return app.messaging();
}

function formatActivityNotification({ action, details, actor_name: actorName, subject_name: subjectName, task_title: taskTitle } = {}) {
  const actor = String(actorName || 'Someone').trim();
  const detail = String(details || '').trim();
  const task = String(taskTitle || detail || 'your task').trim();
  let title = String(action || 'TaskFlow update').slice(0, 80);
  let body = 'Open TaskFlow to view the update.';

  if (action === 'Task completed') {
    title = 'Task completed';
    body = `${actor} completed "${task}".`;
  } else if (action === 'Task reopened') {
    title = 'Task reopened';
    body = `${actor} reopened "${task}".`;
  } else if (action === 'Task comment added') {
    title = 'New task comment';
    body = `${actor} commented on "${task}".`;
  } else if (action === 'Task due date changed') {
    title = 'Task due date changed';
    body = `${actor} changed the due date for "${task}"${detail ? `: ${detail}` : ''}.`;
  } else if (String(action || '').startsWith('Reimbursement ')) {
    const status = String(action).slice('Reimbursement '.length);
    const expense = subjectName && String(subjectName).trim() !== actor
      ? `${String(subjectName).trim()}'s expense`
      : 'an expense';
    title = status.startsWith('approved') ? `Expense approved${status.includes('level 1') ? ' (level 1)' : ''}`
      : status === 'rejected' ? 'Expense rejected'
        : status === 'paid' ? 'Expense paid'
          : status === 'added' ? 'New expense' : 'Expense updated';
    if (status.startsWith('approved')) {
      body = `${actor} approved ${expense}${detail ? `: ${detail}` : ''}.`;
    } else if (status === 'paid') {
      body = `${actor} marked ${expense} as paid${detail ? `: ${detail}` : ''}.`;
    } else {
      const verb = status === 'rejected' ? 'rejected' : status === 'added' ? 'submitted' : 'updated';
      body = `${actor} ${verb} ${expense}${detail ? `: ${detail}` : ''}.`;
    }
  }

  return { title: title.slice(0, 80), body: body.slice(0, 180) };
}

async function sendPushToUsers(db, userIds, { activityId, action, details, actor_name: actorName, subject_name: subjectName, task_title: taskTitle }) {
  const messaging = getFirebaseMessaging();
  if (!messaging) return { enabled: false, sent: 0 };

  const recipients = [...new Set((userIds || []).map(Number))]
    .filter(userId => Number.isSafeInteger(userId) && userId > 0);
  if (!recipients.length) return { enabled: true, sent: 0 };

  const placeholders = recipients.map(() => '?').join(',');
  const tokens = await db.prepare(`SELECT token FROM push_notification_tokens WHERE user_id IN (${placeholders})`).all(...recipients);
  const invalidTokens = [];
  let sent = 0;
  const notification = formatActivityNotification({
    action,
    details,
    actor_name: actorName,
    subject_name: subjectName,
    task_title: taskTitle
  });

  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    if (!batch.length) continue;
    const result = await messaging.sendEachForMulticast({
      tokens: batch.map(row => row.token),
      notification,
      data: {
        activity_id: String(activityId || ''),
        action: String(action || 'TaskFlow update').slice(0, 80),
        screen: 'notifications'
      },
      android: {
        priority: 'high',
        notification: { channelId: 'taskflow-updates' }
      },
      apns: { payload: { aps: { sound: 'default' } } }
    });
    sent += result.successCount;
    result.responses.forEach((response, index) => {
      const code = response.error?.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        invalidTokens.push(batch[index].token);
      }
    });
  }

  if (invalidTokens.length) {
    await db.batch(invalidTokens.map(token => ({
      sql: 'DELETE FROM push_notification_tokens WHERE token=?',
      args: [token]
    })));
  }
  return { enabled: true, sent };
}

module.exports = { sendPushToUsers, isFirebasePushConfigured, formatActivityNotification };