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
  return `https://google.com{lat},${lng}`;
}

// Free Helper function to convert GPS points into a readable Location Name
async function getLocationName(lat, lng) {
  try {
    // Queries OpenStreetMap's free reverse geocoding engine
    const response = await axios.get(`https://openstreetmap.org{lat}&lon=${lng}&format=json`, {
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
router.get('/today', (req, res) => {
  const row = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, todayStr());
  res.json(row || null);
});

// PUNCH IN ROUTE WITH AUTOMATIC LOCATION NAMING
router.post('/punch-in', async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required to punch in.' });
  
  const date = todayStr();
  const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (existing && existing.punch_in) return res.status(400).json({ error: 'Already punched in today' });
  
  // Automatically fetch the readable address name
  const locationName = await getLocationName(lat, lng);
  const mapStr = `📍 In: ${locationName}`;
  const now = new Date().toISOString();
  
  if (existing) {
    db.prepare('UPDATE attendance SET punch_in = ?, in_lat = ?, in_lng = ?, location_status = ? WHERE id = ?')
      .run(now, lat, lng, mapStr, existing.id);
  } else {
    db.prepare('INSERT INTO attendance (user_id, date, punch_in, in_lat, in_lng, location_status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, date, now, lat, lng, mapStr);
  }
  res.json({ ok: true, time: now, status: mapStr });
});

// PUNCH OUT ROUTE WITH AUTOMATIC LOCATION NAMING
router.post('/punch-out', async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required to punch out.' });
  
  const date = todayStr();
  const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (!existing || !existing.punch_in) return res.status(400).json({ error: "You haven't punched in today" });
  if (existing.punch_out) return res.status(400).json({ error: 'Already punched out today' });
  
  const now = new Date().toISOString();
  
  // Fetch new readable address for where they are punching out
  const outLocationName = await getLocationName(lat, lng);
  
  // Clean up the previous string text or fetch the new layout format
  const finalLocationStatus = `${existing.location_status || '📍 In: Unknown'} | Out: ${outLocationName}`;
  
  db.prepare('UPDATE attendance SET punch_out = ?, out_lat = ?, out_lng = ?, location_status = ? WHERE id = ?')
    .run(now, lat, lng, finalLocationStatus, existing.id);
    
  res.json({ ok: true, time: now, status: finalLocationStatus });
});

// employee: own attendance history (last 30 days)
router.get('/mine', (req, res) => {
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fromQuery = req.query.from || from.toISOString().slice(0, 10);
  const toQuery = req.query.to || todayStr();
  const rows = db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC`).all(req.session.userId, fromQuery, toQuery);
  
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng),
    out_map_url: makeMapLink(r.out_lat, r.out_lng)
  }));
  res.json(mappedRows);
});

// admin: view all attendance
router.get('/', requireAdmin, (req, res) => {
  const { date, from, to, user_id } = req.query;
  let sql = `SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND a.date = ?'; params.push(date); }
  if (from) { sql += ' AND a.date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.date <= ?'; params.push(to); }
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY a.date DESC, u.name';
  
  const rows = db.prepare(sql).all(...params);
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng),
    out_map_url: makeMapLink(r.out_lat, r.out_lng)
  }));
  res.json(mappedRows);
});

// admin: who is currently active right now
router.get('/live', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.date = ? AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
    ORDER BY a.punch_in`).all(todayStr());
    
  const mappedRows = rows.map(r => ({
    ...r,
    in_map_url: makeMapLink(r.in_lat, r.in_lng)
  }));
  res.json(mappedRows);
});

// admin: CSV export
router.get('/export.csv', requireAdmin, (req, res) => {
  const { from, to, user_id } = req.query;
  let sql = `SELECT u.name, a.date, a.punch_in, a.punch_out, a.in_lat, a.in_lng, a.out_lat, a.out_lng, a.location_status FROM attendance a JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND a.date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.date <= ?'; params.push(to); }
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY a.date, u.name';
  
  const rows = db.prepare(sql).all(...params);
  let csv = 'Name,Date,Punch In Time,Punch Out Time,Text Location Summary,Punch In Maps URL,Punch Out Maps URL\n';
  rows.forEach(r => {
    const inUrl = makeMapLink(r.in_lat, r.in_lng);
    const outUrl = makeMapLink(r.out_lat, r.out_lng);
    csv += `"${r.name}",${r.date},"${r.punch_in || ''}","${r.punch_out || ''}","${r.location_status || ''}","${inUrl}","${outUrl}"\n`;
  });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="field_attendance.csv"');
  res.send(csv);
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
