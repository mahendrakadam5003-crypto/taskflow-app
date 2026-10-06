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

async function sendPushToUsers(db, userIds, { activityId, action }) {
  const messaging = getFirebaseMessaging();
  if (!messaging) return { enabled: false, sent: 0 };

  const recipients = [...new Set((userIds || []).map(Number))]
    .filter(userId => Number.isSafeInteger(userId) && userId > 0);
  if (!recipients.length) return { enabled: true, sent: 0 };

  const placeholders = recipients.map(() => '?').join(',');
  const tokens = await db.prepare(`SELECT token FROM push_notification_tokens WHERE user_id IN (${placeholders})`).all(...recipients);
  const invalidTokens = [];
  let sent = 0;

  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    if (!batch.length) continue;
    const result = await messaging.sendEachForMulticast({
      tokens: batch.map(row => row.token),
      notification: {
        title: String(action || 'TaskFlow update').slice(0, 80),
        body: 'Open TaskFlow to view the update.'
      },
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

module.exports = { sendPushToUsers, isFirebasePushConfigured };