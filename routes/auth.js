const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

// Helper middleware verification wrappers
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ASYNC LOGIN CONTROLLER: Resolves network promises cleanly before verification
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Await added to handle the Turso cloud database fetch loop safely
    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    
    res.json({ id: user.id, name: user.name, username: user.username, role: user.role });
  } catch (error) {
    console.error("Authentication logic failure:", error);
    res.status(500).json({ error: 'Internal server error during login operation.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || String(new_password).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = await db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
    if (!user || !bcrypt.compareSync(String(current_password), user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await db.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(bcrypt.hashSync(String(new_password), 10), req.session.userId);
      
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const user = await db.prepare('SELECT id, name, username, role FROM users WHERE id = ?').get(req.session.userId);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: user management endpoints ----
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.prepare('SELECT id, name, username, role, active, created_at FROM users ORDER BY name').all();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });
    
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)`)
      .run(name.trim(), username.trim(), hash, role === 'admin' ? 'admin' : 'employee');
      
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Username already taken or database operation rejected' });
  }
});

// ROUTE TO RESET PASSWORDS VIA YOUR CUSTOM MODAL WINDOW PANEL
router.put('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const id = req.params.id;

    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters long.' });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update target account password.' });
  }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, active, password } = req.body;
    const id = req.params.id;
    
    if (name !== undefined) await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    if (role !== undefined) await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'employee', id);
    if (active !== undefined) await db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    
    if (password) { 
      if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' }); 
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), id); 
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "Can't delete your own account" });
  try {
    await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- Admin: office location settings endpoints ----
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    rows.forEach(r => out[r.key] = r.value);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(req.body)) {
      await upsert.run(k, String(v));
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { router, requireAuth, requireAdmin };
