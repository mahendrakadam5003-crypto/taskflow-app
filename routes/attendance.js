const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const { csvValue } = require('../csv');
const axios = require('axios'); // Added axios to make the free API call
const { requireAuth, requireAdmin } = require('./auth');
const { logActivity } = require('../audit');
const { sendLocationToTelegram } = require('../telegram-storage');
const { logRequestEvent, wrapAsyncRoutes } = require('../http-errors');
const { requireFeature } = require('../limits');

const router = express.Router();
wrapAsyncRoutes(router);
router.use(requireAuth);
router.use(requireFeature('attendance'));
const attendanceVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: req => `${ipKeyGenerator(req.ip)}:attendance:${req.session.userId}`,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attendance verification attempts. Try again later.' }
});

async function canViewTracking(req) {
  if (req.session.role === 'admin') return true;
  return !!(await db.prepare('SELECT user_id FROM tracking_access WHERE user_id = ?').get(req.session.userId));
}

function todayStr(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getPunchDevice(req, reportedModel) {
  const userAgent = String(req.get('user-agent') || '').slice(0, 500);
  const clientHintModel = String(req.get('sec-ch-ua-model') || '').trim().replace(/^"|"$/g, '');
  const isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const suppliedModel = String(reportedModel || '').trim().slice(0, 80);
  const androidModel = clientHintModel || suppliedModel || userAgent.match(/Android\s+[^;;)]+;\s*([^;)]+)/i)?.[1]?.replace(/\s+Build\/.*$/i, '').trim();
  const iosVersion = userAgent.match(/OS\s+(\d+[._]\d+)/i)?.[1]?.replace('_', '.');
  let deviceName = 'Desktop browser';
  if (/iPhone/i.test(userAgent)) deviceName = `iPhone${iosVersion ? ` · iOS ${iosVersion}` : ''}`;
  else if (/iPad/i.test(userAgent)) deviceName = `iPad${iosVersion ? ` · iOS ${iosVersion}` : ''}`;
  else if (/Android/i.test(userAgent)) deviceName = androidModel && !/^k$/i.test(androidModel) ? `Android · ${androidModel}` : 'Android device';
  else if (/Macintosh|Mac OS X/i.test(userAgent)) deviceName = 'Mac browser';
  else if (/Windows/i.test(userAgent)) deviceName = 'Windows browser';
  let browserName = 'Browser';
  if (/Edg\//i.test(userAgent)) browserName = 'Edge';
  else if (/Firefox\//i.test(userAgent)) browserName = 'Firefox';
  else if (/Chrome\//i.test(userAgent)) browserName = 'Chrome';
  else if (/Safari\//i.test(userAgent)) browserName = 'Safari';
  return { type: isPhone ? 'phone' : 'laptop', info: `${deviceName} · ${browserName} · category indicative` };
}

function getDeviceTokenHash(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId)).digest('hex');
}

function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[a-zA-Z0-9-]{32,100}$/.test(deviceId);
}

async function checkRegisteredDevice(req, res) {
  const deviceId = req.body.device_id;
  if (!isValidDeviceId(deviceId)) {
    res.status(400).json({ error: 'This browser has no device ID. Reload the page and register this device.', code: 'DEVICE_REGISTRATION_REQUIRED' });
    return false;
  }
  const registration = await db.prepare('SELECT device_token_hash, device_name FROM attendance_registered_devices WHERE user_id=?').get(req.session.userId);
  if (!registration) {
    const pending = await db.prepare('SELECT user_id FROM attendance_device_rebind_pending WHERE user_id=?').get(req.session.userId);
    if (!pending) {
      res.status(409).json({ error: 'Register a named device before punching in.', code: 'DEVICE_REGISTRATION_REQUIRED' });
      return false;
    }
    const device = getPunchDevice(req, req.body.device_model);
    const deviceName = String(req.body.device_name || device.info).trim().slice(0, 60) || device.info;
    try {
      await db.prepare('INSERT INTO attendance_registered_devices (user_id, device_token_hash, device_name, device_info) VALUES (?, ?, ?, ?)')
        .run(req.session.userId, getDeviceTokenHash(deviceId), deviceName, device.info);
    } catch (error) {
      const current = await db.prepare('SELECT device_token_hash FROM attendance_registered_devices WHERE user_id=?').get(req.session.userId);
      if (!current || current.device_token_hash !== getDeviceTokenHash(deviceId)) {
        res.status(409).json({ error: 'Device binding changed while punching. Try again or ask an administrator to reset it.', code: 'DEVICE_MISMATCH' });
        return false;
      }
    }
    await db.prepare('DELETE FROM attendance_device_rebind_pending WHERE user_id=?').run(req.session.userId);
    await logActivity(req, 'Attendance device automatically rebound', 'user', req.session.userId, deviceName, req.session.userId);
    return true;
  }
  if (registration.device_token_hash !== getDeviceTokenHash(deviceId)) {
    res.status(403).json({ error: `This account is registered to "${registration.device_name}". Ask an administrator to reset the device before punching from another one.`, code: 'DEVICE_MISMATCH' });
    return false;
  }
  return true;
}

async function canPunchFromDevice(userId, deviceType) {
  const access = await db.prepare('SELECT allow_phone, allow_laptop FROM attendance_device_access WHERE user_id = ?').get(userId);
  if (!access) return deviceType === 'phone';
  return deviceType === 'laptop' ? Number(access.allow_laptop) === 1 : Number(access.allow_phone) === 1;
}

async function requireAttendanceVerification(req, res, device) {
  const access = await db.prepare('SELECT user_id FROM attendance_verification_access WHERE user_id=?').get(req.session.userId);
  if (!access) return true;
  if (req.body.verification_method === 'native-device-credential' && device.type === 'phone') return true;
  const password = req.body.verification_password;
  if (typeof password !== 'string' || !password) {
    res.status(403).json({ error: 'Re-enter your TaskFlow password to verify this attendance punch.' });
    return false;
  }
  const user = await db.prepare('SELECT password_hash FROM users WHERE id=? AND active=1').get(req.session.userId);
  if (!user?.password_hash || !await bcrypt.compare(password, user.password_hash)) {
    res.status(401).json({ error: 'Attendance password verification failed.' });
    return false;
  }
  return true;
}

function makeMapLink(lat, lng) {
  if (lat == null || lng == null || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return '';
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function validateCoordinates(rawLat, rawLng) {
  if (rawLat == null || rawLng == null || (typeof rawLat === 'string' && !rawLat.trim()) || (typeof rawLng === 'string' && !rawLng.trim())) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

let nextNominatimRequestAt = 0;
const locationNameCache = new Map();

function distanceBetweenPoints(firstLat, firstLng, secondLat, secondLng) {
  const earthRadius = 6371000;
  const toRadians = value => value * Math.PI / 180;
  const deltaLat = toRadians(secondLat - firstLat);
  const deltaLng = toRadians(secondLng - firstLng);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(toRadians(firstLat)) * Math.cos(toRadians(secondLat)) * Math.sin(deltaLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function recordLocationPoint(attendanceId, userId, lat, lng, recordedAt, minimumIntervalMs = 0) {
  const previous = await db.prepare(`SELECT latitude, longitude FROM attendance_locations
    WHERE attendance_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY recorded_at DESC, id DESC LIMIT 1`).get(attendanceId);
  const distanceMeters = previous ? distanceBetweenPoints(Number(previous.latitude), Number(previous.longitude), Number(lat), Number(lng)) : 0;
  const placeChanged = distanceMeters >= 50 ? 1 : 0;
  const info = minimumIntervalMs > 0
    ? await db.prepare(`INSERT INTO attendance_locations (attendance_id, user_id, recorded_at, latitude, longitude, distance_meters, place_changed)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM attendance_locations WHERE attendance_id=? AND recorded_at >= ?
      )`).run(attendanceId, userId, recordedAt, lat, lng, distanceMeters, placeChanged,
      attendanceId, new Date(Date.now() - minimumIntervalMs).toISOString())
    : await db.prepare('INSERT INTO attendance_locations (attendance_id, user_id, recorded_at, latitude, longitude, distance_meters, place_changed) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(attendanceId, userId, recordedAt, lat, lng, distanceMeters, placeChanged);
  if (minimumIntervalMs > 0 && !info.changes) return null;
  return { id: info.lastInsertRowid, distanceMeters, placeChanged };
}

async function getLocationName(lat, lng, req) {
  try {
    const cacheKey = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
    if (locationNameCache.has(cacheKey)) return locationNameCache.get(cacheKey);
    const requestAt = Math.max(Date.now(), nextNominatimRequestAt);
    nextNominatimRequestAt = requestAt + 1000;
    const waitMs = requestAt - Date.now();
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon: lng, format: 'json' },
      headers: { 'User-Agent': 'TaskFlowApp/1.0' },
      timeout: 5000
    });
    let locationName = 'Unknown Location';
    if (response.data && response.data.address) {
      const addr = response.data.address;
      const place = addr.road || addr.suburb || addr.neighbourhood || '';
      const city = addr.city || addr.town || addr.village || '';
      if (place && city) locationName = `${place}, ${city}`;
      else if (city) locationName = city;
    }
    if (locationNameCache.size >= 1000) locationNameCache.delete(locationNameCache.keys().next().value);
    locationNameCache.set(cacheKey, locationName);
    return locationName;
  } catch (error) {
    logRequestEvent(req, 'attendance_geocoding_failed', 'warn');
    return 'Location Saved'; // Fallback text if network drops out
  }
}

// today's own attendance
router.get('/today', async (req, res) => {
  const row = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, todayStr());
  res.json(row || null);
});

router.get('/verification-required', async (req, res) => {
  const access = await db.prepare('SELECT user_id FROM attendance_verification_access WHERE user_id = ?').get(req.session.userId);
  res.json({ required: !!access });
});

router.get('/device-access/me', async (req, res) => {
  const row = await db.prepare('SELECT allow_phone, allow_laptop FROM attendance_device_access WHERE user_id = ?').get(req.session.userId);
  res.json({ allow_phone: row ? Number(row.allow_phone) === 1 : true, allow_laptop: row ? Number(row.allow_laptop) === 1 : false });
});

router.get('/device-access', requireAdmin, async (req, res) => {
  const rows = await db.prepare(`SELECT u.id, u.name, u.username,
    COALESCE(ada.allow_phone, 1) AS allow_phone,
    COALESCE(ada.allow_laptop, 0) AS allow_laptop,
    rd.device_name AS registered_device_name, rd.device_info AS registered_device_info, rd.registered_at,
    CASE WHEN drp.user_id IS NULL THEN 0 ELSE 1 END AS device_rebind_pending
    FROM users u LEFT JOIN attendance_device_access ada ON ada.user_id = u.id
    LEFT JOIN attendance_registered_devices rd ON rd.user_id=u.id
    LEFT JOIN attendance_device_rebind_pending drp ON drp.user_id=u.id
    WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows || []);
});

router.get('/device-registration/me', async (req, res) => {
  const deviceId = String(req.query.device_id || '');
  const registration = await db.prepare('SELECT device_token_hash, device_name, device_info, registered_at FROM attendance_registered_devices WHERE user_id=?').get(req.session.userId);
  const pending = !registration && await db.prepare('SELECT user_id FROM attendance_device_rebind_pending WHERE user_id=?').get(req.session.userId);
  res.json({
    registered: !!registration,
    rebind_pending: !!pending,
    device_name: registration?.device_name || null,
    device_info: registration?.device_info || null,
    registered_at: registration?.registered_at || null,
    is_current_device: !!registration && isValidDeviceId(deviceId) && registration.device_token_hash === getDeviceTokenHash(deviceId)
  });
});

router.post('/device-registration/register', async (req, res) => {
  const deviceId = req.body.device_id;
  const deviceName = String(req.body.device_name || '').trim().slice(0, 60);
  if (!isValidDeviceId(deviceId)) return res.status(400).json({ error: 'Invalid browser device ID. Reload TaskFlow and try again.' });
  if (!deviceName) return res.status(400).json({ error: 'Enter a name for this device.' });
  const tokenHash = getDeviceTokenHash(deviceId);
  const existing = await db.prepare('SELECT device_token_hash, device_name FROM attendance_registered_devices WHERE user_id=?').get(req.session.userId);
  if (existing && existing.device_token_hash !== tokenHash) {
    return res.status(403).json({ error: `This account is already registered to "${existing.device_name}". Ask an administrator to reset it before using another device.` });
  }
  if (existing) {
    if (existing.device_name !== deviceName) {
      const device = getPunchDevice(req, req.body.device_model);
      const updated = await db.prepare('UPDATE attendance_registered_devices SET device_name=?, device_info=? WHERE user_id=? AND device_token_hash=?')
        .run(deviceName, device.info, req.session.userId, tokenHash);
      if (!updated.changes) return res.status(409).json({ error: 'Device registration changed in another request. Reload and try again.' });
      await logActivity(req, 'Attendance device renamed', 'user', req.session.userId, `${existing.device_name} -> ${deviceName}`, req.session.userId);
      return res.json({ ok: true, device_name: deviceName });
    }
    return res.json({ ok: true, device_name: existing.device_name });
  } else {
    try {
      await db.prepare('INSERT INTO attendance_registered_devices (user_id, device_token_hash, device_name, device_info) VALUES (?, ?, ?, ?)')
        .run(req.session.userId, tokenHash, deviceName, getPunchDevice(req, req.body.device_model).info);
    } catch (error) {
      return res.status(409).json({ error: 'Device registration changed in another request. Reload and try again.' });
    }
  }
  await db.prepare('DELETE FROM attendance_device_rebind_pending WHERE user_id=?').run(req.session.userId);
  await logActivity(req, 'Attendance device registered', 'user', req.session.userId, deviceName, req.session.userId);
  res.json({ ok: true, device_name: deviceName });
});

router.delete('/device-registration/:userId', requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const target = await db.prepare('SELECT name FROM users WHERE id=? AND active=1').get(userId);
  if (!target) return res.status(404).json({ error: 'Active user not found.' });
  await db.prepare('INSERT OR REPLACE INTO attendance_device_rebind_pending (user_id, reset_by) VALUES (?, ?)').run(userId, req.session.userId);
  await db.prepare('DELETE FROM attendance_registered_devices WHERE user_id=?').run(userId);
  await logActivity(req, 'Attendance device reset by admin', 'user', userId, target.name, userId);
  res.json({ ok: true });
});

router.put('/device-access/:userId', requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Valid user is required.' });
  const target = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot update device access for an inactive user.' });
  const allowPhone = req.body.allow_phone ? 1 : 0;
  const allowLaptop = req.body.allow_laptop ? 1 : 0;
  if (!allowPhone && !allowLaptop) return res.status(400).json({ error: 'Allow at least one device.' });
  await db.prepare(`INSERT INTO attendance_device_access (user_id, allow_phone, allow_laptop, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET allow_phone=excluded.allow_phone, allow_laptop=excluded.allow_laptop, updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .run(userId, allowPhone, allowLaptop, req.session.userId);
  res.json({ ok: true });
});

router.get('/verification-access', requireAdmin, async (req, res) => {
  const rows = await db.prepare(`SELECT u.id, u.name, u.username, CASE WHEN ava.user_id IS NULL THEN 0 ELSE 1 END AS verification_required
    FROM users u LEFT JOIN attendance_verification_access ava ON ava.user_id = u.id WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows || []);
});

router.put('/verification-access/:userId', requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Valid user is required.' });
  const target = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (req.body.enabled && Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot require attendance verification for an inactive user.' });
  if (req.body.enabled) {
    await db.prepare('INSERT OR REPLACE INTO attendance_verification_access (user_id, enabled_by) VALUES (?, ?)').run(userId, req.session.userId);
  } else {
    await db.prepare('DELETE FROM attendance_verification_access WHERE user_id = ?').run(userId);
  }
  res.json({ ok: true });
});

async function savePunchIn(userId, date, lat, lng, device, { adminEnteredBy = false, req } = {}) {
  await db.ready;
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, date);
  if (existing?.punch_in) return null;

  const locationName = adminEnteredBy ? 'Entered by admin' : await getLocationName(lat, lng, req);
  const storedLat = adminEnteredBy ? null : lat;
  const storedLng = adminEnteredBy ? null : lng;
  const storedDeviceType = adminEnteredBy ? null : device.type;
  const storedDeviceInfo = adminEnteredBy ? 'Entered by admin' : device.info;
  const now = new Date().toISOString();
  const mapStr = adminEnteredBy ? 'Entered by admin' : `📍 In: ${locationName}`;
  let attendanceId;
  if (existing) {
    const updated = await db.prepare(`UPDATE attendance SET punch_in = ?, in_lat = ?, in_lng = ?,
      in_location_text = ?, in_device_type = ?, in_device_info = ?, location_status = ?
      WHERE id = ? AND punch_in IS NULL`)
      .run(now, storedLat, storedLng, locationName, storedDeviceType, storedDeviceInfo, mapStr, existing.id);
    if (!updated.changes) return null;
    attendanceId = existing.id;
  } else {
    const inserted = await db.prepare(`INSERT OR IGNORE INTO attendance
      (user_id, date, punch_in, in_lat, in_lng, in_location_text, in_device_type, in_device_info, location_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, date, now, storedLat, storedLng, locationName, storedDeviceType, storedDeviceInfo, mapStr);
    if (!inserted.changes) return null;
    attendanceId = inserted.lastInsertRowid;
  }
  return { attendanceId, locationName, now, mapStr };
}

router.post('/punch-in', attendanceVerificationLimiter, async (req, res) => {
  if (!(await checkRegisteredDevice(req, res))) return;
  const device = getPunchDevice(req, req.body.device_model);
  const deviceType = device.type;
  if (!(await canPunchFromDevice(req.session.userId, deviceType))) return res.status(403).json({ error: 'Punching from this device is not allowed. Ask an admin to enable it.' });
  const coordinates = validateCoordinates(req.body.lat, req.body.lng);
  if (!coordinates) return res.status(400).json({ error: 'A valid latitude and longitude are required to punch in.' });
  const { lat, lng } = coordinates;
  if (!(await requireAttendanceVerification(req, res, device))) return;
  
  const date = todayStr();
  const punchIn = await savePunchIn(req.session.userId, date, lat, lng, device, { req });
  if (!punchIn) return res.status(400).json({ error: 'Already punched in today' });
  const { attendanceId, locationName, now, mapStr } = punchIn;
  const recordedAt = new Date().toISOString();
  const locationInfo = await recordLocationPoint(attendanceId, req.session.userId, lat, lng, recordedAt);
  try {
    const telegramMessageId = await sendLocationToTelegram(lat, lng, `Live tracking started: ${req.session.userId}`);
    await db.prepare('UPDATE attendance_locations SET telegram_message_id = ? WHERE id = ?').run(telegramMessageId, locationInfo.id);
  } catch (error) {
    logRequestEvent(req, 'attendance_punch_location_notification_failed', 'warn');
  }
  await logActivity(req, 'Punched in', 'attendance', attendanceId, `${date} - ${locationName}`, req.session.userId);
  res.json({ ok: true, time: now, status: mapStr });
});

router.post('/location-update', async (req, res) => {
  if (!(await checkRegisteredDevice(req, res))) return;
  const device = getPunchDevice(req, req.body.device_model);
  if (!(await canPunchFromDevice(req.session.userId, device.type))) return res.status(403).json({ error: 'Live tracking from this device is not allowed.' });
  const coordinates = validateCoordinates(req.body.lat, req.body.lng);
  if (!coordinates) return res.status(400).json({ error: 'A valid latitude and longitude are required.' });
  const { lat, lng } = coordinates;
  const attendance = await db.prepare('SELECT id, punch_in, punch_out FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, todayStr());
  if (!attendance?.punch_in || attendance.punch_out) return res.status(400).json({ error: 'Live tracking is only available during an active shift.' });
  const recordedAt = new Date().toISOString();
  const locationInfo = await recordLocationPoint(attendance.id, req.session.userId, lat, lng, recordedAt, 30_000);
  if (!locationInfo) return res.json({ ok: true, ignored: true, recorded_at: recordedAt });
  try {
    const telegramMessageId = await sendLocationToTelegram(lat, lng, `Live tracking update: ${req.session.userId}`);
    await db.prepare('UPDATE attendance_locations SET telegram_message_id = ? WHERE id = ?').run(telegramMessageId, locationInfo.id);
    res.json({ ok: true, recorded_at: recordedAt });
  } catch (error) {
    logRequestEvent(req, 'attendance_live_location_notification_failed', 'warn');
    res.json({ ok: true, recorded_at: recordedAt, telegram_warning: 'Location tracking notification is temporarily unavailable.' });
  }
});

router.post('/punch-out', attendanceVerificationLimiter, async (req, res) => {
  if (!(await checkRegisteredDevice(req, res))) return;
  const device = getPunchDevice(req, req.body.device_model);
  const deviceType = device.type;
  if (!(await canPunchFromDevice(req.session.userId, deviceType))) return res.status(403).json({ error: 'Punching from this device is not allowed. Ask an admin to enable it.' });
  const coordinates = validateCoordinates(req.body.lat, req.body.lng);
  if (!coordinates) return res.status(400).json({ error: 'A valid latitude and longitude are required to punch out.' });
  const { lat, lng } = coordinates;
  if (!(await requireAttendanceVerification(req, res, device))) return;
  
  const date = todayStr();
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (!existing || !existing.punch_in) return res.status(400).json({ error: "You haven't punched in today" });
  if (existing.punch_out) return res.status(400).json({ error: 'Already punched out today' });
  
  const now = new Date().toISOString();
  
  const outLocationName = await getLocationName(lat, lng);
  
  const finalLocationStatus = `${existing.location_status || '📍 In: Unknown'} | Out: ${outLocationName}`;
  
  await db.prepare('UPDATE attendance SET punch_out = ?, out_lat = ?, out_lng = ?, out_location_text = ?, out_device_type = ?, out_device_info = ?, location_status = ? WHERE id = ?')
    .run(now, lat, lng, outLocationName, deviceType, device.info, finalLocationStatus, existing.id);
  await logActivity(req, 'Punched out', 'attendance', existing.id, `${date} - ${outLocationName}`, req.session.userId);
  res.json({ ok: true, time: now, status: finalLocationStatus });
});

// admin: attendance overview with one row per active employee
router.get('/overview', requireAdmin, async (req, res) => {
  const date = req.query.date || todayStr();
  const { user_id, department } = req.query;
  let sql = `
    SELECT u.id AS user_id, u.name AS user_name, u.department, u.role,
           a.id, a.date, a.punch_in, a.punch_out, a.in_lat, a.in_lng,
           a.out_lat, a.out_lng, a.in_location_text, a.out_location_text,
           a.in_device_type, a.in_device_info, a.out_device_type, a.out_device_info,
          rd.device_name AS registered_device_name, rd.device_info AS registered_device_info,
           a.location_status, a.notes
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
        LEFT JOIN attendance_registered_devices rd ON rd.user_id=u.id
    WHERE u.active = 1`;
  const params = [date];
  if (user_id) { sql += ' AND u.id = ?'; params.push(user_id); }
  if (department) { sql += ' AND u.department = ?'; params.push(department); }
  sql += ' ORDER BY u.name';
  const rows = await db.prepare(sql).all(...params);
  res.json(rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng),
    out_map_url: makeMapLink(r.out_lat, r.out_lng)
  })));
});

// admin: punch on behalf of an employee from the monitoring screen
router.post('/admin-punch-in', requireAdmin, async (req, res) => {
  const userId = Number(req.body.user_id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Valid employee ID is required.' });
  const employee = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  if (Number(employee.active) !== 1) return res.status(400).json({ error: 'Cannot punch in an inactive employee.' });
  const device = getPunchDevice(req, req.body.device_model);
  if (!(await canPunchFromDevice(req.session.userId, device.type))) return res.status(403).json({ error: 'Punching from this device is not allowed for your admin account.' });
  const date = todayStr();
  const punchIn = await savePunchIn(userId, date, null, null, device, { adminEnteredBy: true, req });
  if (!punchIn) return res.status(400).json({ error: 'This employee is already punched in today.' });
  await logActivity(req, 'Admin entered punch-in', 'attendance', punchIn.attendanceId, `${date} - ${employee.id}`, userId);
  res.json({ ok: true });
});

router.post('/admin-punch-out', requireAdmin, async (req, res) => {
  const userId = Number(req.body.user_id);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Valid employee ID is required.' });
  const employee = await db.prepare('SELECT id, active FROM users WHERE id=?').get(userId);
  if (!employee) return res.status(404).json({ error: 'Employee not found.' });
  if (Number(employee.active) !== 1) return res.status(400).json({ error: 'Cannot punch out an inactive employee.' });
  const device = getPunchDevice(req, req.body.device_model);
  if (!(await canPunchFromDevice(req.session.userId, device.type))) return res.status(403).json({ error: 'Punching from this device is not allowed for your admin account.' });
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(userId, todayStr());
  if (!existing || !existing.punch_in) return res.status(400).json({ error: 'This employee has not punched in today.' });
  if (existing.punch_out) return res.status(400).json({ error: 'This employee is already punched out today.' });
  const now = new Date().toISOString();
  const status = `${existing.location_status || '📍 In: Unknown'} | Out: Entered by admin`;
  await db.prepare('UPDATE attendance SET punch_out = ?, out_lat = ?, out_lng = ?, out_location_text = ?, out_device_type = ?, out_device_info = ?, location_status = ? WHERE id = ?')
    .run(now, null, null, 'Entered by admin', null, 'Entered by admin', status, existing.id);
  await logActivity(req, 'Admin entered punch-out', 'attendance', existing.id, `${existing.date} - ${employee.id}`, userId);
  res.json({ ok: true });
});

// employee: own attendance history (last 30 days)
router.get('/mine', async (req, res) => {
  const defaultFrom = new Date(`${todayStr()}T00:00:00.000Z`);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const fromQuery = String(req.query.from || defaultFrom.toISOString().slice(0, 10));
  const toQuery = String(req.query.to || todayStr());
  if (!isValidDateOnly(fromQuery) || !isValidDateOnly(toQuery) || fromQuery > toQuery) {
    return res.status(400).json({ error: 'Choose a valid attendance date range.' });
  }
  const rangeDays = (Date.parse(`${toQuery}T00:00:00Z`) - Date.parse(`${fromQuery}T00:00:00Z`)) / 86_400_000;
  if (rangeDays > 365) return res.status(400).json({ error: 'Attendance history is limited to 366 days.' });
  const rows = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC')
    .all(req.session.userId, fromQuery, toQuery);
  const rowsByDate = new Map(rows.map(row => [row.date, row]));
  const fromDate = new Date(`${fromQuery}T00:00:00Z`);
  const toDate = new Date(`${toQuery}T00:00:00Z`);
  const history = [];
  for (const date = new Date(toDate); date >= fromDate; date.setUTCDate(date.getUTCDate() - 1)) {
    const dateKey = date.toISOString().slice(0, 10);
    const row = rowsByDate.get(dateKey);
    history.push(row ? {
      ...row,
      present: !!row.punch_in,
      in_map_url: makeMapLink(row.in_lat, row.in_lng),
      out_map_url: makeMapLink(row.out_lat, row.out_lng)
    } : { date: dateKey, present: false });
  }
  res.json(history);
});

// admin: view all attendance
router.get('/', requireAdmin, async (req, res) => {
  const { date, from, to, user_id, department } = req.query;
  let sql = `SELECT a.*, u.name AS user_name, u.department, rd.device_name AS registered_device_name, rd.device_info AS registered_device_info
    FROM attendance a JOIN users u ON u.id = a.user_id
    LEFT JOIN attendance_registered_devices rd ON rd.user_id=u.id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND a.date = ?'; params.push(date); }
  if (from) { sql += ' AND a.date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.date <= ?'; params.push(to); }
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  if (department) { sql += ' AND u.department = ?'; params.push(department); }
  sql += ' ORDER BY a.date DESC, u.name';
  
  const rows = await db.prepare(sql).all(...params);
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng),
    out_map_url: makeMapLink(r.out_lat, r.out_lng)
  }));
  res.json(mappedRows);
});

// admin: who is currently active right now
router.get('/live', requireAdmin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT a.*, u.name AS user_name, u.department FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.date <= ? AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
    ORDER BY a.date DESC, a.punch_in`).all(todayStr());
    
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng)
  }));
  res.json(mappedRows);
});

router.get('/live/:userId/timeline', requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid employee ID.' });
  const selectedDate = String(req.query.date || todayStr());
  const rows = await db.prepare(`SELECT al.recorded_at, al.latitude, al.longitude,
      al.distance_meters, al.place_changed, u.name AS user_name
    FROM attendance_locations al JOIN users u ON u.id = al.user_id
    JOIN attendance a ON a.id = al.attendance_id
    WHERE al.user_id = ? AND a.date = ? AND al.latitude IS NOT NULL AND al.longitude IS NOT NULL
    ORDER BY al.recorded_at ASC`).all(userId, selectedDate);
  const totalDistance = (rows || []).reduce((total, row) => total + Number(row.distance_meters || 0), 0);
  await logActivity(req, 'Viewed employee location timeline', 'user', userId, `Attendance date: ${selectedDate}`, userId);
  res.json({ points: rows || [], total_distance_meters: totalDistance, place_changes: (rows || []).filter(row => Number(row.place_changed) === 1).length });
});

router.get('/tracking-access/me', async (req, res) => {
  res.json({ allowed: await canViewTracking(req) });
});

router.get('/tracking-access', requireAdmin, async (req, res) => {
  const rows = await db.prepare(`SELECT u.id, u.name, u.username, u.role, CASE WHEN ta.user_id IS NULL THEN 0 ELSE 1 END AS tracking_allowed
    FROM users u LEFT JOIN tracking_access ta ON ta.user_id = u.id WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows || []);
});

router.put('/tracking-access/:userId', requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Valid user is required.' });
  if (req.body.allowed) {
    await db.prepare('INSERT OR REPLACE INTO tracking_access (user_id, granted_by) VALUES (?, ?)').run(userId, req.session.userId);
  } else {
    await db.prepare('DELETE FROM tracking_access WHERE user_id = ?').run(userId);
  }
  res.json({ ok: true });
});

router.get('/tracking/people', async (req, res) => {
  if (!(await canViewTracking(req))) return res.status(403).json({ error: 'Tracking access has not been granted to this account.' });
  const selectedDate = req.query.date || todayStr();
  const rows = await db.prepare(`SELECT u.id AS user_id, u.name AS user_name, u.department,
      a.punch_in, a.punch_out, a.in_lat, a.in_lng,
      (SELECT al.latitude FROM attendance_locations al WHERE al.attendance_id = a.id AND al.latitude IS NOT NULL AND al.longitude IS NOT NULL ORDER BY al.recorded_at DESC LIMIT 1) AS latest_lat,
      (SELECT al.longitude FROM attendance_locations al WHERE al.attendance_id = a.id AND al.latitude IS NOT NULL AND al.longitude IS NOT NULL ORDER BY al.recorded_at DESC LIMIT 1) AS latest_lng,
      (SELECT al.recorded_at FROM attendance_locations al WHERE al.attendance_id = a.id AND al.latitude IS NOT NULL AND al.longitude IS NOT NULL ORDER BY al.recorded_at DESC LIMIT 1) AS latest_at
    FROM users u LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
    WHERE u.active = 1 ORDER BY u.name`).all(selectedDate);
  res.json(rows || []);
});

router.get('/tracking/:userId/timeline', async (req, res) => {
  if (!(await canViewTracking(req))) return res.status(403).json({ error: 'Tracking access has not been granted to this account.' });
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return res.status(400).json({ error: 'Invalid employee ID.' });
  const selectedDate = req.query.date || todayStr();
  if (!isValidDateOnly(String(selectedDate))) return res.status(400).json({ error: 'Choose a valid attendance date.' });
  const rows = await db.prepare(`SELECT al.recorded_at, al.latitude, al.longitude, al.distance_meters, al.place_changed, u.name AS user_name
    FROM attendance_locations al JOIN users u ON u.id = al.user_id JOIN attendance a ON a.id = al.attendance_id
    WHERE al.user_id = ? AND a.date = ? AND al.latitude IS NOT NULL AND al.longitude IS NOT NULL
    ORDER BY al.recorded_at ASC`).all(userId, selectedDate);
  const attendance = await db.prepare(`SELECT a.punch_in, a.punch_out, a.in_lat, a.in_lng, a.out_lat, a.out_lng,
      a.in_location_text, a.out_location_text, u.name AS user_name
    FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.user_id = ? AND a.date = ?`).get(userId, selectedDate);
  const previousUtcDate = new Date(`${selectedDate}T00:00:00Z`);
  previousUtcDate.setUTCDate(previousUtcDate.getUTCDate() - 1);
  const earliestUtcDate = previousUtcDate.toISOString().slice(0, 10);
  const taskCheckins = await db.prepare(`SELECT c.check_in_at, c.check_in_lat, c.check_in_lng,
      c.check_out_at, c.check_out_lat, c.check_out_lng,
      t.title AS task_title, t.customer_name, p.name AS project_name
    FROM task_checkins c
    JOIN tasks t ON t.id = c.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE c.user_id = ?
      AND ((substr(c.check_in_at, 1, 10) BETWEEN ? AND ?) OR (substr(c.check_out_at, 1, 10) BETWEEN ? AND ?))
    ORDER BY c.check_in_at ASC`).all(userId, earliestUtcDate, selectedDate, earliestUtcDate, selectedDate);
  const points = [...(rows || [])];
  const events = [];
  const addEvent = (event) => {
    const eventDate = new Date(event.recorded_at);
    if (!event.recorded_at || !Number.isFinite(eventDate.getTime()) || todayStr(eventDate) !== selectedDate) return;
    events.push(event);
  };
  if (attendance?.punch_in) {
    addEvent({
      type: 'attendance',
      action: 'Punched in',
      recorded_at: attendance.punch_in,
      latitude: attendance.in_lat,
      longitude: attendance.in_lng,
      location: attendance.in_location_text || ''
    });
    if (attendance.in_lat != null && attendance.in_lng != null) {
      const punchInTime = new Date(attendance.punch_in).getTime();
      const hasPunchInPoint = points.some(point => {
        const pointTime = new Date(point.recorded_at).getTime();
        return Number(point.latitude) === Number(attendance.in_lat)
          && Number(point.longitude) === Number(attendance.in_lng)
          && Math.abs(pointTime - punchInTime) <= 60_000;
      });
      if (!hasPunchInPoint) {
        points.push({
          recorded_at: attendance.punch_in,
          latitude: attendance.in_lat,
          longitude: attendance.in_lng,
          distance_meters: 0,
          place_changed: 0,
          user_name: attendance.user_name
        });
      }
    }
  }
  if (attendance?.punch_out) {
    addEvent({
      type: 'attendance',
      action: 'Punched out',
      recorded_at: attendance.punch_out,
      latitude: attendance.out_lat,
      longitude: attendance.out_lng,
      location: attendance.out_location_text || ''
    });
  }
  for (const checkin of taskCheckins || []) {
    const taskDetails = {
      task_title: checkin.task_title,
      customer_name: checkin.customer_name,
      project_name: checkin.project_name
    };
    addEvent({
      ...taskDetails,
      type: 'task',
      action: 'Checked in to task',
      recorded_at: checkin.check_in_at,
      latitude: checkin.check_in_lat,
      longitude: checkin.check_in_lng
    });
    if (checkin.check_out_at) {
      addEvent({
        ...taskDetails,
        type: 'task',
        action: 'Checked out of task',
        recorded_at: checkin.check_out_at,
        latitude: checkin.check_out_lat,
        longitude: checkin.check_out_lng
      });
    }
  }
  events.sort((first, second) => new Date(first.recorded_at) - new Date(second.recorded_at));
  points.sort((first, second) => new Date(first.recorded_at) - new Date(second.recorded_at));
  const routePoints = [...points];
  events.forEach(event => {
    if (event.latitude != null && event.longitude != null
      && Number.isFinite(Number(event.latitude)) && Number.isFinite(Number(event.longitude))) {
      routePoints.push({ recorded_at: event.recorded_at, latitude: event.latitude, longitude: event.longitude });
    }
  });
  routePoints.sort((first, second) => new Date(first.recorded_at) - new Date(second.recorded_at));
  const uniqueRoutePoints = routePoints.filter((point, index, all) => {
    if (index === 0) return true;
    const previous = all[index - 1];
    return Number(point.latitude) !== Number(previous.latitude)
      || Number(point.longitude) !== Number(previous.longitude)
      || Math.abs(new Date(point.recorded_at) - new Date(previous.recorded_at)) > 60_000;
  });
  const totalDistance = uniqueRoutePoints.slice(1).reduce((total, point, index) => (
    total + distanceBetweenPoints(
      Number(uniqueRoutePoints[index].latitude),
      Number(uniqueRoutePoints[index].longitude),
      Number(point.latitude),
      Number(point.longitude)
    )
  ), 0);
  await logActivity(req, 'Viewed employee location timeline', 'user', userId, `Attendance date: ${selectedDate}`, userId);
  res.json({
    points,
    events,
    route_points: uniqueRoutePoints,
    total_distance_meters: totalDistance,
    place_changes: points.filter(row => Number(row.place_changed) === 1).length
  });
});

// admin: CSV export
router.get('/export.csv', requireAdmin, async (req, res) => {
  const today = todayStr();
  const from = String(req.query.from || today);
  const to = String(req.query.to || from);
  const isValidDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isValidDate(from) || !isValidDate(to) || from > to) return res.status(400).json({ error: 'Choose a valid attendance date range.' });
  const dayCount = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (dayCount > 365) return res.status(400).json({ error: 'Attendance exports are limited to 366 days.' });
  const shiftStart = String(req.query.shift_start || '11:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shiftStart)) return res.status(400).json({ error: 'Shift start must use 24-hour HH:MM format.' });
  const { user_id, department } = req.query;
  let userSql = `SELECT DISTINCT u.id, u.name, u.department FROM users u
    LEFT JOIN attendance a ON a.user_id=u.id AND a.date>=? AND a.date<=?
    WHERE (u.active=1 OR a.id IS NOT NULL)`;
  const userParams = [from, to];
  if (user_id) { userSql += ' AND u.id = ?'; userParams.push(user_id); }
  if (department) { userSql += ' AND u.department = ?'; userParams.push(department); }
  userSql += ' ORDER BY u.name';
  const users = await db.prepare(userSql).all(...userParams);

  const attendanceRows = await db.prepare(`
    SELECT * FROM attendance
    WHERE date >= ? AND date <= ?
    ORDER BY date, user_id
  `).all(from, to);
  const attendanceByKey = new Map(attendanceRows.map(row => [`${row.user_id}|${row.date}`, row]));

  const [shiftHour, shiftMinute] = shiftStart.split(':').map(Number);
  const dates = [];
  for (let cursor = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  function displayDate(date) {
    const [year, month, day] = date.split('-');
    return `${day}-${month}-${year}`;
  }
  function displayTime(value) {
    if (!value) return '-';
    return new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  }
  function duration(value) {
    if (!value || value < 0) return '-';
    const hours = Math.floor(value / 60);
    const minutes = value % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  function minutesBetween(start, end) {
    return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  }

  let serial = 1;
  const lines = ['S.No,Date,Name,Attendance,In Time,Out Time,Working Hours,Late Time'];
  dates.forEach(date => users.forEach(user => {
    const row = attendanceByKey.get(`${user.id}|${date}`);
    const punchedIn = !!(row && row.punch_in);
    const inTime = punchedIn ? displayTime(row.punch_in) : '-';
    const outTime = row && row.punch_out ? displayTime(row.punch_out) : '-';
    const workingMinutes = row && row.punch_in && row.punch_out ? minutesBetween(row.punch_in, row.punch_out) : null;
    let lateMinutes = null;
    if (punchedIn) {
      const inDate = new Date(row.punch_in);
      const indiaParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(inDate);
      const indiaTime = Object.fromEntries(indiaParts.map(part => [part.type, part.value]));
      const punchMinutes = Number(indiaTime.hour) * 60 + Number(indiaTime.minute);
      lateMinutes = Math.max(0, punchMinutes - (shiftHour * 60 + shiftMinute));
    }
    const lateText = lateMinutes > 0 ? `${lateMinutes >= 60 ? `${Math.floor(lateMinutes / 60)}hr ` : ''}${lateMinutes % 60 ? `${lateMinutes % 60} mins` : ''}`.trim() : '-';
    lines.push([serial++, displayDate(date), user.name, punchedIn ? 'P' : 'A', inTime, outTime, duration(workingMinutes), lateText].map(csvValue).join(','));
  }));
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
  res.send(`\ufeff${lines.join('\n')}\n`);
});

// admin: manual correction
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const attendanceId = Number(req.params.id);
    if (!Number.isSafeInteger(attendanceId) || attendanceId < 1) return res.status(400).json({ error: 'Invalid attendance record ID.' });
    const existing = await db.prepare('SELECT id, user_id, punch_in, punch_out, notes FROM attendance WHERE id=?').get(attendanceId);
    if (!existing) return res.status(404).json({ error: 'Attendance record not found.' });
    const reason = String(req.body.reason || '').trim();
    if (!reason || reason.length > 500) return res.status(400).json({ error: 'A correction reason of at most 500 characters is required.' });

    const normalizeTimestamp = value => {
      if (value === null || value === '') return null;
      if (typeof value !== 'string' || !value.trim()) return undefined;
      const timestamp = new Date(value);
      return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
    };
    const punchIn = req.body.punch_in === undefined ? existing.punch_in : normalizeTimestamp(req.body.punch_in);
    const punchOut = req.body.punch_out === undefined ? existing.punch_out : normalizeTimestamp(req.body.punch_out);
    if (punchIn === undefined || punchOut === undefined) return res.status(400).json({ error: 'Punch times must be valid date-time values.' });
    if (punchIn && punchOut && new Date(punchOut) < new Date(punchIn)) return res.status(400).json({ error: 'Punch-out cannot be earlier than punch-in.' });
    if (req.body.notes !== undefined && (typeof req.body.notes !== 'string' || req.body.notes.length > 2000)) {
      return res.status(400).json({ error: 'Notes must be a string of at most 2000 characters.' });
    }

    const updates = [];
    const values = [];
    if (req.body.punch_in !== undefined) { updates.push('punch_in=?'); values.push(punchIn); }
    if (req.body.punch_out !== undefined) { updates.push('punch_out=?'); values.push(punchOut); }
    if (req.body.notes !== undefined) { updates.push('notes=?'); values.push(req.body.notes); }
    if (!updates.length) return res.status(400).json({ error: 'Provide a punch time or notes change.' });
    values.push(attendanceId);
    const updated = await db.prepare(`UPDATE attendance SET ${updates.join(', ')} WHERE id=?`).run(...values);
    if (!updated.changes) return res.status(404).json({ error: 'Attendance record not found.' });
    const details = [
      `Reason: ${reason}`,
      ...(req.body.punch_in !== undefined ? [`Punch in: ${existing.punch_in || '(none)'} -> ${punchIn || '(none)'}`] : []),
      ...(req.body.punch_out !== undefined ? [`Punch out: ${existing.punch_out || '(none)'} -> ${punchOut || '(none)'}`] : []),
      ...(req.body.notes !== undefined ? [`Notes: ${existing.notes || '(none)'} -> ${req.body.notes || '(none)'}`] : [])
    ].join('; ');
    await logActivity(req, 'Attendance record corrected', 'attendance', attendanceId, details, existing.user_id);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Attendance correction failed');
  }
});

module.exports = router;
