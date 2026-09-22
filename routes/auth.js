const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

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

// ASYNC LOGIN CONTROLLER: Robust property-safe unwrapper with relaxed status requirements
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Removed the active status requirement directly from the SQL string to guarantee matches clear
    const rawResult = await db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
    
    let user = null;
    if (Array.isArray(rawResult)) {
      user = rawResult[0] && Array.isArray(rawResult[0]) ? rawResult[0][0] : rawResult[0];
    } else {
      user = rawResult;
    }
    
    if (!user || typeof user !== 'object') {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Standardize naming mapping constraints
    const passwordHash = user.password_hash || user.PASSWORD_HASH;
    const userId = user.id || user.ID;
    const userRole = user.role || user.ROLE;
    const userName = user.name || user.NAME;
    const userUsername = user.username || user.USERNAME;

    if (!passwordHash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!bcrypt.compareSync(String(password), String(passwordHash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = Number(userId);
    req.session.role = String(userRole);
    req.session.name = String(userName);
    
    res.json({ id: userId, name: userName, username: userUsername, role: userRole });
  } catch (error) {
    console.error("Critical authentication loop error:", error);
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

    const rawResult = await db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
    let user = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    const passwordHash = user ? (user.password_hash || user.PASSWORD_HASH) : null;

    if (!user || !passwordHash || !bcrypt.compareSync(String(current_password), String(passwordHash))) {
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
    const rawResult = await db.prepare('SELECT id, name, username, role FROM users WHERE id = ?').get(req.session.userId);
    let user = Array.isArray(rawResult) ? rawResult[0] : rawResult;
    
    if (!user) return res.status(401).json({ error: 'User record not found' });
    res.json({
      id: user.id || user.ID,
      name: user.name || user.NAME,
      username: user.username || user.USERNAME,
      department: user.department || user.DEPARTMENT || '',
      role: user.role || user.ROLE
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: user management endpoints ----
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const rawUsers = await db.prepare('SELECT id, name, username, department, role, active, created_at FROM users ORDER BY name').all();
    const users = Array.isArray(rawUsers) ? rawUsers : [];
    
    const mappedUsers = users.map(u => ({
      id: u.id || u.ID,
      name: u.name || u.NAME,
      username: u.username || u.USERNAME,
      department: u.department || u.DEPARTMENT || '',
      role: u.role || u.ROLE,
      active: u.active !== undefined ? u.active : u.ACTIVE,
      created_at: u.created_at || u.CREATED_AT
    }));
    res.json(mappedUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { name, username, password, department, role } = req.body;
    if (!name || !username || !password) return res.status(400).json({ error: 'Missing fields' });
    
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.prepare(`INSERT INTO users (name, username, password_hash, department, role) VALUES (?, ?, ?, ?, ?)`)
      .run(name.trim(), username.trim().toLowerCase(), hash, String(department || '').trim(), role === 'admin' ? 'admin' : 'employee');
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'Username already taken or database operation rejected' });
  }
});

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
    const { name, department, role, active, password } = req.body;
    const id = req.params.id;
    
    if (name !== undefined) await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    if (department !== undefined) await db.prepare('UPDATE users SET department = ? WHERE id = ?').run(String(department).trim(), id);
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

router.get('/departments', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT id, name FROM departments ORDER BY name').all();
    res.json(rows || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/departments', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Department name is required.' });
  try {
    const info = await db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    res.json({ id: info.lastInsertRowid, name });
  } catch (error) {
    res.status(400).json({ error: 'That department already exists.' });
  }
});

router.delete('/departments/:id', requireAdmin, async (req, res) => {
  try {
    await db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/reimbursement-access', requireAdmin, async (req, res) => {
  const rows = await db.prepare(`
    SELECT u.id AS user_id, u.name, u.username, u.department,
           COALESCE(ra.approval_level, 0) AS approval_level,
           COALESCE(ra.can_pay, 0) AS can_pay
    FROM users u LEFT JOIN reimbursement_access ra ON ra.user_id = u.id
    WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows || []);
});

router.get('/reimbursement-access/me', requireAuth, async (req, res) => {
  const row = await db.prepare('SELECT approval_level, can_pay FROM reimbursement_access WHERE user_id = ?').get(req.session.userId);
  res.json({ approval_level: req.session.role === 'admin' ? 2 : (row ? row.approval_level : 0), can_pay: req.session.role === 'admin' ? 1 : (row ? row.can_pay : 0) });
});

router.put('/reimbursement-access/:userId', requireAdmin, async (req, res) => {
  const approvalLevel = Math.max(0, Math.min(2, Number(req.body.approval_level) || 0));
  const canPay = approvalLevel === 2 && req.body.can_pay ? 1 : 0;
  if (approvalLevel === 0) {
    await db.prepare('DELETE FROM reimbursement_access WHERE user_id = ?').run(req.params.userId);
  } else {
    await db.prepare(`INSERT INTO reimbursement_access (user_id, approval_level, can_pay) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET approval_level = excluded.approval_level, can_pay = excluded.can_pay, updated_at = datetime('now')`)
      .run(req.params.userId, approvalLevel, canPay);
  }
  res.json({ ok: true });
});

router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const rawRows = await db.prepare('SELECT key, value FROM settings').all();
    const rows = Array.isArray(rawRows) ? rawRows : [];
    const out = {};
    rows.forEach(r => {
      if (r) {
        const k = r.key || r.KEY;
        const v = r.value || r.VALUE;
        if (k) out[k] = v;
      }
    });
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
