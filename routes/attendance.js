const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
router.use(requireAuth);

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function locationStatus(lat, lng) {
  const oLat = parseFloat(getSetting('office_lat'));
  const oLng = parseFloat(getSetting('office_lng'));
  const radius = parseFloat(getSetting('office_radius_m')) || 150;
  if (lat == null || lng == null) return 'unknown';
  if (isNaN(oLat) || isNaN(oLng)) return 'unknown'; // admin hasn't set office location yet
  const dist = haversineMeters(lat, lng, oLat, oLng);
  return dist <= radius ? 'on-site' : 'remote';
}

// today's own attendance
router.get('/today', (req, res) => {
  const row = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, todayStr());
  res.json(row || null);
});

router.post('/punch-in', (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required to punch in. Please enable location access and try again.' });
  const date = todayStr();
  const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (existing && existing.punch_in) return res.status(400).json({ error: 'Already punched in today' });
  const status = locationStatus(lat, lng);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE attendance SET punch_in = ?, in_lat = ?, in_lng = ?, location_status = ? WHERE id = ?')
      .run(now, lat ?? null, lng ?? null, status, existing.id);
  } else {
    db.prepare('INSERT INTO attendance (user_id, date, punch_in, in_lat, in_lng, location_status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, date, now, lat ?? null, lng ?? null, status);
  }
  res.json({ ok: true, time: now, status });
});

router.post('/punch-out', (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location is required to punch out. Please enable location access and try again.' });
  const date = todayStr();
  const existing = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND date = ?').get(req.session.userId, date);
  if (!existing || !existing.punch_in) return res.status(400).json({ error: "You haven't punched in today" });
  if (existing.punch_out) return res.status(400).json({ error: 'Already punched out today' });
  const now = new Date().toISOString();
  db.prepare('UPDATE attendance SET punch_out = ?, out_lat = ?, out_lng = ? WHERE id = ?')
    .run(now, lat ?? null, lng ?? null, existing.id);
  res.json({ ok: true, time: now });
});

// employee: own attendance history (last 30 days)
router.get('/mine', (req, res) => {
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fromQuery = req.query.from || from.toISOString().slice(0, 10);
  const toQuery = req.query.to || todayStr();
  const rows = db.prepare(`SELECT * FROM attendance WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC`).all(req.session.userId, fromQuery, toQuery);
  res.json(rows);
});

// admin: view all attendance, optional filters ?date=YYYY-MM-DD or ?from=&to=&user_id=
router.get('/', requireAdmin, (req, res) => {
  const { date, from, to, user_id } = req.query;
  let sql = `SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND a.date = ?'; params.push(date); }
  if (from) { sql += ' AND a.date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.date <= ?'; params.push(to); }
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY a.date DESC, u.name';
  res.json(db.prepare(sql).all(...params));
});

// admin: who is currently on-site right now (punched in, not punched out, today)
router.get('/live', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.date = ? AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
    ORDER BY a.punch_in`).all(todayStr());
  res.json(rows);
});

// admin: CSV export
router.get('/export.csv', requireAdmin, (req, res) => {
  const { from, to, user_id } = req.query;
  let sql = `SELECT u.name, a.date, a.punch_in, a.punch_out, a.location_status FROM attendance a JOIN users u ON u.id = a.user_id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND a.date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.date <= ?'; params.push(to); }
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  sql += ' ORDER BY a.date, u.name';
  const rows = db.prepare(sql).all(...params);
  let csv = 'Name,Date,Punch In,Punch Out,Location\n';
  rows.forEach(r => {
    csv += `"${r.name}",${r.date},"${r.punch_in || ''}","${r.punch_out || ''}",${r.location_status || ''}\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
  res.send(csv);
});

// admin: manual correction of a record
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
