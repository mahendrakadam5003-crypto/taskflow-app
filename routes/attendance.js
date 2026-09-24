const express = require('express');
const db = require('../db');
const axios = require('axios'); // Added axios to make the free API call
const { requireAuth, requireAdmin } = require('./auth');
const { logActivity } = require('../audit');
const { sendLocationToTelegram } = require('../telegram-storage');

const router = express.Router();
router.use(requireAuth);

async function canViewTracking(req) {
  if (req.session.role === 'admin') return true;
  return !!(await db.prepare('SELECT user_id FROM tracking_access WHERE user_id = ?').get(req.session.userId));
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function normalizeDeviceType(value) {
  return value === 'laptop' ? 'laptop' : 'phone';
}

async function canPunchFromDevice(userId, deviceType) {
  const access = await db.prepare('SELECT allow_phone, allow_laptop FROM attendance_device_access WHERE user_id = ?').get(userId);
  if (!access) return deviceType === 'phone';
  return deviceType === 'laptop' ? Number(access.allow_laptop) === 1 : Number(access.allow_phone) === 1;
}

// Generates an instant, clickable Google Maps link from raw coordinates
function makeMapLink(lat, lng) {
  if (lat == null || lng == null || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return '';
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function distanceBetweenPoints(firstLat, firstLng, secondLat, secondLng) {
  const earthRadius = 6371000;
  const toRadians = value => value * Math.PI / 180;
  const deltaLat = toRadians(secondLat - firstLat);
  const deltaLng = toRadians(secondLng - firstLng);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(toRadians(firstLat)) * Math.cos(toRadians(secondLat)) * Math.sin(deltaLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function recordLocationPoint(attendanceId, userId, lat, lng, recordedAt) {
  const previous = await db.prepare('SELECT latitude, longitude FROM attendance_locations WHERE attendance_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1').get(attendanceId);
  const distanceMeters = previous ? distanceBetweenPoints(Number(previous.latitude), Number(previous.longitude), Number(lat), Number(lng)) : 0;
  const placeChanged = distanceMeters >= 50 ? 1 : 0;
  const info = await db.prepare('INSERT INTO attendance_locations (attendance_id, user_id, recorded_at, latitude, longitude, distance_meters, place_changed) VALUES (?, ?, ?, ?, ?, ?, ?)').run(attendanceId, userId, recordedAt, lat, lng, distanceMeters, placeChanged);
  return { id: info.lastInsertRowid, distanceMeters, placeChanged };
}

// Free Helper function to convert GPS points into a readable Location Name
async function getLocationName(lat, lng) {
  try {
    // Queries OpenStreetMap's free reverse geocoding engine
    const response = await axios.get(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
      headers: { 'User-Agent': 'TaskFlowApp/1.0' } // Required by OpenStreetMap policies
    });
    
    if (response.data && response.data.address) {
      const addr = response.data.address;
      // Builds a short clean name (e.g., "Main Street, Mumbai" or "Tech Park, Sector 4")
      const place = addr.road || addr.suburb || addr.neighbourhood || '';
      const city = addr.city || addr.town || addr.village || '';
      
      if (place && city) return `${place}, ${city}`;
      if (city) return city;
    }
    return 'Unknown Location';
  } catch (error) {
    console.error("Geocoding failed:", error.message);
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
    COALESCE(ada.allow_laptop, 0) AS allow_laptop
    FROM users u LEFT JOIN attendance_device_access ada ON ada.user_id = u.id
    WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows || []);
});

router.put('/device-access/:userId', requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'Valid user is required.' });
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
  if (!userId) return res.status(400).json({ error: 'Valid user is required.' });
  if (req.body.enabled) {
    await db.prepare('INSERT OR REPLACE INTO attendance_verification_access (user_id, enabled_by) VALUES (?, ?)').run(userId, req.session.userId);
  } else {
    await db.prepare('DELETE FROM attendance_verification_access WHERE user_id = ?').run(userId);
  }
  res.json({ ok: true });
});

// PUNCH IN ROUTE WITH AUTOMATIC LOCATION NAMING
router.post('/punch-in', async (req, res) => {
  const { lat, lng } = req.body;
  const deviceType = normalizeDeviceType(req.body.device_type);
  if (!(await canPunchFromDevice(req.session.userId, deviceType))) return res.status(403).json({ error: 'Punching from this device is not allowed. Ask an admin to enable it.' });
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required to punch in.' });
  
  const date = todayStr();
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (existing && existing.punch_in) return res.status(400).json({ error: 'Already punched in today' });
  
  // Automatically fetch the readable address name
  const locationName = await getLocationName(lat, lng);
  const mapStr = `📍 In: ${locationName}`;
  const now = new Date().toISOString();
  
  if (existing) {
    await db.prepare('UPDATE attendance SET punch_in = ?, in_lat = ?, in_lng = ?, in_location_text = ?, location_status = ? WHERE id = ?')
      .run(now, lat, lng, locationName, mapStr, existing.id);
  } else {
    await db.prepare('INSERT INTO attendance (user_id, date, punch_in, in_lat, in_lng, in_location_text, location_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, date, now, lat, lng, locationName, mapStr);
  }
  const attendance = await db.prepare('SELECT id FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  const recordedAt = new Date().toISOString();
  const locationInfo = await recordLocationPoint(attendance.id, req.session.userId, lat, lng, recordedAt);
  try {
    const telegramMessageId = await sendLocationToTelegram(lat, lng, `Live tracking started: ${req.session.userId}`);
    await db.prepare('UPDATE attendance_locations SET telegram_message_id = ? WHERE id = ?').run(telegramMessageId, locationInfo.id);
  } catch (error) {
    console.error(error.message);
  }
  await logActivity(req, 'Punched in', 'attendance', existing ? existing.id : null, `${date} - ${locationName}`, req.session.userId);
  res.json({ ok: true, time: now, status: mapStr });
});

router.post('/location-update', async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required.' });
  const attendance = await db.prepare('SELECT id, punch_in, punch_out FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, todayStr());
  if (!attendance?.punch_in || attendance.punch_out) return res.status(400).json({ error: 'Live tracking is only available during an active shift.' });
  const recordedAt = new Date().toISOString();
  const locationInfo = await recordLocationPoint(attendance.id, req.session.userId, lat, lng, recordedAt);
  try {
    const telegramMessageId = await sendLocationToTelegram(lat, lng, `Live tracking update: ${req.session.userId}`);
    await db.prepare('UPDATE attendance_locations SET telegram_message_id = ? WHERE id = ?').run(telegramMessageId, locationInfo.id);
    res.json({ ok: true, recorded_at: recordedAt });
  } catch (error) {
    console.error(error.message);
    res.json({ ok: true, recorded_at: recordedAt, telegram_warning: error.message });
  }
});

// PUNCH OUT ROUTE WITH AUTOMATIC LOCATION NAMING
router.post('/punch-out', async (req, res) => {
  const { lat, lng } = req.body;
  const deviceType = normalizeDeviceType(req.body.device_type);
  if (!(await canPunchFromDevice(req.session.userId, deviceType))) return res.status(403).json({ error: 'Punching from this device is not allowed. Ask an admin to enable it.' });
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required to punch out.' });
  
  const date = todayStr();
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (!existing || !existing.punch_in) return res.status(400).json({ error: "You haven't punched in today" });
  if (existing.punch_out) return res.status(400).json({ error: 'Already punched out today' });
  
  const now = new Date().toISOString();
  
  // Fetch new readable address for where they are punching out
  const outLocationName = await getLocationName(lat, lng);
  
  // Clean up the previous string text or fetch the new layout format
  const finalLocationStatus = `${existing.location_status || '📍 In: Unknown'} | Out: ${outLocationName}`;
  
  await db.prepare('UPDATE attendance SET punch_out = ?, out_lat = ?, out_lng = ?, out_location_text = ?, location_status = ? WHERE id = ?')
    .run(now, lat, lng, outLocationName, finalLocationStatus, existing.id);
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
           a.location_status, a.notes
    FROM users u
    LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
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
  const { user_id, lat, lng } = req.body;
  if (!(await canPunchFromDevice(req.session.userId, normalizeDeviceType(req.body.device_type)))) return res.status(403).json({ error: 'Punching from this device is not allowed for your admin account.' });
  if (!user_id || lat == null || lng == null) return res.status(400).json({ error: 'Employee and location are required.' });
  const date = todayStr();
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(user_id, date);
  if (existing && existing.punch_in) return res.status(400).json({ error: 'This employee is already punched in today.' });
  const locationName = await getLocationName(lat, lng);
  const now = new Date().toISOString();
  const mapStr = `📍 In: ${locationName}`;
  if (existing) {
    await db.prepare('UPDATE attendance SET punch_in = ?, in_lat = ?, in_lng = ?, in_location_text = ?, location_status = ? WHERE id = ?')
      .run(now, lat, lng, locationName, mapStr, existing.id);
  } else {
    await db.prepare('INSERT INTO attendance (user_id, date, punch_in, in_lat, in_lng, in_location_text, location_status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user_id, date, now, lat, lng, locationName, mapStr);
  }
  res.json({ ok: true });
});

router.post('/admin-punch-out', requireAdmin, async (req, res) => {
  const { user_id, lat, lng } = req.body;
  if (!(await canPunchFromDevice(req.session.userId, normalizeDeviceType(req.body.device_type)))) return res.status(403).json({ error: 'Punching from this device is not allowed for your admin account.' });
  if (!user_id || lat == null || lng == null) return res.status(400).json({ error: 'Employee and location are required.' });
  const existing = await db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(user_id, todayStr());
  if (!existing || !existing.punch_in) return res.status(400).json({ error: 'This employee has not punched in today.' });
  if (existing.punch_out) return res.status(400).json({ error: 'This employee is already punched out today.' });
  const outLocationName = await getLocationName(lat, lng);
  const now = new Date().toISOString();
  const status = `${existing.location_status || '📍 In: Unknown'} | Out: ${outLocationName}`;
  await db.prepare('UPDATE attendance SET punch_out = ?, out_lat = ?, out_lng = ?, out_location_text = ?, location_status = ? WHERE id = ?')
    .run(now, lat, lng, outLocationName, status, existing.id);
  res.json({ ok: true });
});

// employee: own attendance history (last 30 days)
router.get('/mine', async (req, res) => {
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fromQuery = req.query.from || from.toISOString().slice(0, 10);
  const toQuery = req.query.to || todayStr();
  const rows = await db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC`).all(req.session.userId, fromQuery, toQuery);
  
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng),
    out_map_url: makeMapLink(r.out_lat, r.out_lng)
  }));
  res.json(mappedRows);
});

// admin: view all attendance
router.get('/', requireAdmin, async (req, res) => {
  const { date, from, to, user_id, department } = req.query;
  let sql = `SELECT a.*, u.name AS user_name, u.department FROM attendance a JOIN users u ON u.id = a.user_id WHERE 1=1`;
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
    WHERE a.date = ? AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
    ORDER BY a.punch_in`).all(todayStr());
    
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng)
  }));
  res.json(mappedRows);
});

router.get('/live/:userId/timeline', requireAdmin, async (req, res) => {
  const rows = await db.prepare(`SELECT al.recorded_at, al.latitude, al.longitude, u.name AS user_name
    FROM attendance_locations al JOIN users u ON u.id = al.user_id
    JOIN attendance a ON a.id = al.attendance_id
    WHERE al.user_id = ? AND a.date = ? ORDER BY al.recorded_at ASC`).all(req.params.userId, req.query.date || todayStr());
  const totalDistance = (rows || []).reduce((total, row) => total + Number(row.distance_meters || 0), 0);
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
  const rows = await db.prepare(`SELECT u.id AS user_id, u.name AS user_name, u.department,
      a.punch_in, a.punch_out, a.in_lat, a.in_lng,
      (SELECT al.latitude FROM attendance_locations al WHERE al.attendance_id = a.id ORDER BY al.recorded_at DESC LIMIT 1) AS latest_lat,
      (SELECT al.longitude FROM attendance_locations al WHERE al.attendance_id = a.id ORDER BY al.recorded_at DESC LIMIT 1) AS latest_lng,
      (SELECT al.recorded_at FROM attendance_locations al WHERE al.attendance_id = a.id ORDER BY al.recorded_at DESC LIMIT 1) AS latest_at
    FROM users u LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
    WHERE u.active = 1 ORDER BY u.name`).all(todayStr());
  res.json(rows || []);
});

router.get('/tracking/:userId/timeline', async (req, res) => {
  if (!(await canViewTracking(req))) return res.status(403).json({ error: 'Tracking access has not been granted to this account.' });
  let rows = await db.prepare(`SELECT al.recorded_at, al.latitude, al.longitude, u.name AS user_name
    FROM attendance_locations al JOIN users u ON u.id = al.user_id JOIN attendance a ON a.id = al.attendance_id
    WHERE al.user_id = ? AND a.date = ? ORDER BY al.recorded_at ASC`).all(req.params.userId, req.query.date || todayStr());
  if (!rows.length) {
    const initial = await db.prepare(`SELECT a.punch_in AS recorded_at, a.in_lat AS latitude, a.in_lng AS longitude, u.name AS user_name
      FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ? AND a.date = ? AND a.in_lat IS NOT NULL AND a.in_lng IS NOT NULL`).get(req.params.userId, req.query.date || todayStr());
    if (initial) rows = [initial];
  }
  res.json(rows || []);
});

// admin: CSV export
router.get('/export.csv', requireAdmin, async (req, res) => {
  const today = todayStr();
  const from = req.query.from || today;
  const to = req.query.to || from;
  const { user_id, department } = req.query;
  let userSql = 'SELECT id, name, department FROM users WHERE active = 1';
  const userParams = [];
  if (user_id) { userSql += ' AND id = ?'; userParams.push(user_id); }
  if (department) { userSql += ' AND department = ?'; userParams.push(department); }
  userSql += ' ORDER BY name';
  const users = await db.prepare(userSql).all(...userParams);

  const attendanceRows = await db.prepare(`
    SELECT * FROM attendance
    WHERE date >= ? AND date <= ?
    ORDER BY date, user_id
  `).all(from, to);
  const attendanceByKey = new Map(attendanceRows.map(row => [`${row.user_id}|${row.date}`, row]));

  const shiftStart = String(req.query.shift_start || '11:00');
  const [shiftHour, shiftMinute] = shiftStart.split(':').map(Number);
  const dates = [];
  for (let cursor = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  function csvEscape(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }
  function displayDate(date) {
    const [year, month, day] = date.split('-');
    return `${day}-${month}-${year}`;
  }
  function displayTime(value) {
    if (!value) return '-';
    return new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
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
      const shiftDate = new Date(inDate);
      shiftDate.setHours(shiftHour, shiftMinute, 0, 0);
      lateMinutes = Math.max(0, Math.round((inDate - shiftDate) / 60000));
    }
    const lateText = lateMinutes > 0 ? `${lateMinutes >= 60 ? `${Math.floor(lateMinutes / 60)}hr ` : ''}${lateMinutes % 60 ? `${lateMinutes % 60} mins` : ''}`.trim() : '-';
    lines.push([serial++, displayDate(date), user.name, punchedIn ? 'P' : 'A', inTime, outTime, duration(workingMinutes), lateText].map(csvEscape).join(','));
  }));
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_report.csv"');
  res.send(`\ufeff${lines.join('\n')}\n`);
});

// admin: manual correction
router.put('/:id', requireAdmin, (req, res) => {
  const { punch_in, punch_out, notes } = req.body;
  const updates = [];
  const vals = [];
  if (punch_in !== undefined) { updates.push('punch_in = ?'); vals.push(punch_in); }
  if (punch_out !== undefined) { updates.push('punch_out = ?'); vals.push(punch_out); }
  if (notes !== undefined) { updates.push('notes = ?'); vals.push(notes); }
  if (!updates.length) return res.json({ ok: true });
  vals.push(req.params.id);
  db.prepare(`UPDATE attendance SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

module.exports = router;
