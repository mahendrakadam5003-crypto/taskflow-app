'use strict';

const crypto = require('node:crypto');

const nativeAppAgent = /TaskFlowNative\/1(?:\s|$)/;
const mobileBrowserAgent = /Android|iPhone|iPad|iPod|Mobile/i;

function isMobileBrowserLoginEnabled(environment = process.env) {
  const setting = String(environment.ALLOW_MOBILE_BROWSER_LOGIN || '').trim();
  return setting === '' || /^(1|true|yes|on)$/i.test(setting);
}

function getLoginDevice(req, payload = {}) {
  const userAgent = String(req.get?.('user-agent') || req.headers?.['user-agent'] || '');
  if (!nativeAppAgent.test(userAgent)) {
    const mobileHint = req.get?.('sec-ch-ua-mobile') || req.headers?.['sec-ch-ua-mobile'];
    return { type: 'web', mobileBrowser: mobileBrowserAgent.test(userAgent) || mobileHint === '?1' };
  }

  const deviceId = typeof payload.device_id === 'string' ? payload.device_id.trim() : '';
  const manufacturer = typeof payload.manufacturer === 'string' ? payload.manufacturer.trim() : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (deviceId.length < 8 || deviceId.length > 128 || !manufacturer || !model) {
    return { type: 'app', invalid: true };
  }

  const deviceModel = `${manufacturer} ${model}`.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  if (!deviceModel.trim()) return { type: 'app', invalid: true };
  return {
    type: 'app',
    deviceIdHash: crypto.createHash('sha256').update(deviceId).digest('hex'),
    deviceModel
  };
}

async function authorizeLogin(database, user, device, { allowMobileBrowserLogin = false } = {}) {
  if (device.type === 'web') {
    // Browser login (laptop, desktop or phone browser) needs "Allow browser login" for this user.
    if (Number(user.web_access_enabled) !== 1) {
      return {
        ok: false,
        status: 403,
        code: 'WEB_LOGIN_NOT_ALLOWED',
        error: 'This account is limited to its registered TaskFlow mobile app. Ask your company admin to enable web access.'
      };
    }
    return { ok: true, loginClient: device.mobileBrowser ? 'mobile-web' : 'web', loginDeviceHash: null };
  }

  if (device.invalid) {
    return {
      ok: false,
      status: 403,
      code: 'APP_DEVICE_ID_REQUIRED',
      error: 'TaskFlow could not identify this app installation. Update the app and try again.'
    };
  }

  let registered = await database.prepare('SELECT device_id_hash, device_model FROM app_login_devices WHERE user_id = ?').get(user.id);
  if (!registered) {
    await database.prepare(`INSERT OR IGNORE INTO app_login_devices (user_id, device_id_hash, device_model)
      VALUES (?, ?, ?)`).run(user.id, device.deviceIdHash, device.deviceModel);
    registered = await database.prepare('SELECT device_id_hash, device_model FROM app_login_devices WHERE user_id = ?').get(user.id);
  }
  if (registered?.device_id_hash !== device.deviceIdHash) {
    return {
      ok: false,
      status: 403,
      code: 'APP_DEVICE_MISMATCH',
      error: `This account is registered to ${registered?.device_model || 'another mobile device'}. Ask your company admin to reset the registered app device before signing in here.`
    };
  }
  return { ok: true, loginClient: 'app', loginDeviceHash: device.deviceIdHash };
}

async function isLoginSessionAllowed(database, user, session, { allowMobileBrowserLogin = false } = {}) {
  if (session.loginClient === 'app') {
    if (typeof session.loginDeviceHash !== 'string') return false;
    const registered = await database.prepare('SELECT device_id_hash FROM app_login_devices WHERE user_id = ?').get(user.id);
    return registered?.device_id_hash === session.loginDeviceHash;
  }
  const webAccess = user.web_access_enabled === undefined
    ? await database.prepare('SELECT web_access_enabled FROM users WHERE id = ?').get(user.id)
    : user;
  // Browser sessions (desktop or phone) are valid only while "Allow browser login" is on.
  return Number(webAccess?.web_access_enabled) === 1;
}

module.exports = { authorizeLogin, getLoginDevice, isLoginSessionAllowed, isMobileBrowserLoginEnabled };
