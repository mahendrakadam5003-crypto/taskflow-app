const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const passwordHash = user.password_hash || user.PASSWORD_HASH;
    if (!passwordHash || !bcrypt.compareSync(String(password), String(passwordHash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = Number(user.id || user.ID);
    req.session.role = String(user.role || user.ROLE);
    req.session.name = String(user.name || user.NAME);
    
    res.json({ id: req.session.userId, name: req.session.name, username: user.username, role: req.session.role });
  } catch (error) {
    console.error("Login endpoint fault loop tracking query crash:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const user = await db.prepare('SELECT id, name, username, role FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/people', requireAuth, async (req, res) => {
  try {
    const users = await db.prepare('SELECT id, name, username, role, active FROM users ORDER BY name').all();
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY name').all();
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)`).run(name.trim(), username.trim().toLowerCase(), hash, role === 'admin' ? 'admin' : 'employee');
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'Username already taken' }); }
});

router.put('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const hash = bcrypt.hashSync(String(req.body.password), 10);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: 'Failed to reset password' }); }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "Can't delete yourself" });
  try {
    await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    rows.forEach(r => { out[r.key] = r.value; });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(req.body)) { await upsert.run(k, String(v)); }
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = { router, requireAuth, requireAdmin };
