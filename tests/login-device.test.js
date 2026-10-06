'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { authorizeLogin, getLoginDevice, isLoginSessionAllowed } = require('../lib/login-device');

function createDatabase() {
  const devices = new Map();
  return {
    devices,
    prepare(sql) {
      return {
        get: async (...args) => sql.includes('app_login_devices')
          ? devices.get(Number(args[0])) || null
          : { web_access_enabled: 1 },
        run: async (...args) => {
          const [userId, deviceIdHash, deviceModel] = args;
          if (!devices.has(Number(userId))) {
            devices.set(Number(userId), { device_id_hash: deviceIdHash, device_model: deviceModel });
          }
          return { changes: 1 };
        }
      };
    }
  };
}

function appDevice(deviceId, model = 'Pixel 9') {
  return getLoginDevice({ headers: { 'user-agent': 'Mozilla/5.0 TaskFlowNative/1' } }, {
    device_id: deviceId,
    manufacturer: 'Google',
    model
  });
}

test('browser login requires explicit web access', async () => {
  const database = createDatabase();
  const user = { id: 1, web_access_enabled: 0 };
  assert.deepEqual(await authorizeLogin(database, user, { type: 'web' }), {
    ok: false,
    status: 403,
    code: 'WEB_LOGIN_NOT_ALLOWED',
    error: 'This account is limited to its registered TaskFlow mobile app. Ask your company admin to enable web access.'
  });
  assert.equal((await authorizeLogin(database, { ...user, web_access_enabled: 1 }, { type: 'web' })).ok, true);
});

test('native app login registers one Android device and permits that device again', async () => {
  const database = createDatabase();
  const device = appDevice('android-id-1234567890');
  const user = { id: 2, web_access_enabled: 0 };

  const firstLogin = await authorizeLogin(database, user, device);
  assert.equal(firstLogin.ok, true);
  assert.equal(firstLogin.loginClient, 'app');
  assert.equal(database.devices.get(user.id).device_model, 'Google Pixel 9');
  assert.equal((await authorizeLogin(database, user, device)).ok, true);
});

test('a different app device is rejected until an admin clears the binding', async () => {
  const database = createDatabase();
  const user = { id: 3, web_access_enabled: 0 };
  const original = appDevice('android-id-original');
  await authorizeLogin(database, user, original);

  const denied = await authorizeLogin(database, user, appDevice('android-id-second', 'Galaxy S25'));
  assert.equal(denied.code, 'APP_DEVICE_MISMATCH');
  database.devices.delete(user.id);
  assert.equal((await authorizeLogin(database, user, appDevice('android-id-second', 'Galaxy S25'))).ok, true);
});

test('app sessions are invalidated when their device binding is removed', async () => {
  const database = createDatabase();
  const user = { id: 4, web_access_enabled: 0 };
  const login = await authorizeLogin(database, user, appDevice('android-id-session'));
  const session = { loginClient: login.loginClient, loginDeviceHash: login.loginDeviceHash };
  assert.equal(await isLoginSessionAllowed(database, user, session), true);
  database.devices.delete(user.id);
  assert.equal(await isLoginSessionAllowed(database, user, session), false);
});

test('browser claims cannot masquerade as the native app without its user-agent marker', () => {
  const device = getLoginDevice({ headers: { 'user-agent': 'Chrome Mobile' } }, {
    device_id: 'android-id-claimed',
    manufacturer: 'Google',
    model: 'Pixel 9'
  });
  assert.deepEqual(device, { type: 'web' });
});