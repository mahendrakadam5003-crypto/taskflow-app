const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.name = user.name;
  res.json({ id: user.id, name: user.name, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || String(new_password).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
  if (!user || !bcrypt.compareSync(String(current_password), user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(new_password),10), req.session.userId);
  res.json({ ok:true });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const user = db.prepare('SELECT id, name, username, role FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// ---- Admin: user management ----
router.get('/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY name').all();
  res.json(users);
});

router.post('/users', requireAdmin, (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(name.trim(), username.trim(), hash, role === 'admin' ? 'admin' : 'employee');
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Username already taken' });
  }
});

router.put('/users/:id', requireAdmin, (req, res) => {
  const { name, role, active, password } = req.body;
  const id = req.params.id;
  if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
  if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'employee', id);
  if (active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  if (password) { if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' }); db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id); }
  res.json({ ok: true });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "Can't delete your own account" });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Admin: office location settings (for on-site detection) ----
router.get('/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  res.json(out);
});

router.put('/settings', requireAdmin, (req, res) => {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(req.body)) upsert.run(k, String(v));
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireAdmin };
