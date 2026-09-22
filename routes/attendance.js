const express = require('express');
const db = require('../db');
const axios = require('axios'); // Added axios to make the free API call
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth);

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// Generates an instant, clickable Google Maps link from raw coordinates
function makeMapLink(lat, lng) {
  if (lat == null || lng == null || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return '';
  return `https://www.google.com/maps?q=${lat},${lng}`;
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

// PUNCH IN ROUTE WITH AUTOMATIC LOCATION NAMING
router.post('/punch-in', async (req, res) => {
  const { lat, lng } = req.body;
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
  res.json({ ok: true, time: now, status: mapStr });
});

// PUNCH OUT ROUTE WITH AUTOMATIC LOCATION NAMING
router.post('/punch-out', async (req, res) => {
  const { lat, lng } = req.body;
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
