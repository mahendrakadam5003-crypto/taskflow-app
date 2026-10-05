const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const { getControlDatabase } = require('../control-db');
const { hasControlDatabaseConfiguration, LEGACY_TENANT_ID } = require('../tenant-manager');
const { clearCompanyContextCookie } = require('../company-context');
const { logActivity } = require('../audit');
const { asyncHandler, sendInternalError, wrapAsyncRoutes } = require('../http-errors');
const { getPlan, getPlanUsage } = require('../limits');

const router = express.Router();
wrapAsyncRoutes(router);
const passwordMinLength = 10;
const sessionCookieName = 'taskflow.sid.v2';
const dummyPasswordHash = bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
const settingKeys = new Set([
  'office_lat',
  'office_lng',
  'office_radius_m',
  'attendance_verification_enabled',
  'attachment_retention_days',
  'attendance_location_retention_days'
]);
const booleanSettingKeys = new Set(['attendance_verification_enabled']);
const loginLimitOptions = {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again later.' }
};
const loginIpLimiter = rateLimit(loginLimitOptions);
const loginUsernameLimiter = rateLimit({
  ...loginLimitOptions,
  keyGenerator: req => `username:${String(req.body?.username || '').trim().toLowerCase().slice(0, 128) || 'missing'}`
});
const loginCompanyLimiter = rateLimit({
  ...loginLimitOptions,
  keyGenerator: req => `company:${String(req.body?.company_code || process.env.LEGACY_COMPANY_CODE || 'existing-company')
    .trim().toLowerCase().slice(0, 63) || 'existing-company'}`
});

function logFailedLogin(req, username) {
  const attemptedUsername = String(username || '').trim().toLowerCase().slice(0, 128);
  console.warn('Failed login attempt', JSON.stringify({ username: attemptedUsername || null, ip: req.ip }));
}

function mustChangePassword(user) {
  return Number(user.must_change_password) === 1;
}

function isPasswordFlowAllowed(req) {
  const requestPath = String(req.originalUrl || req.path).split('?')[0];
  return req.method === 'POST' && ['/api/auth/change-password', '/api/auth/logout', '/auth/change-password', '/auth/logout', '/change-password', '/logout'].includes(requestPath);
}

function rejectUntilPasswordChanged(res) {
  return res.status(403).json({ error: 'Change your password before continuing.', must_change_password: true });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => error ? reject(error) : resolve());
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => error ? reject(error) : resolve());
  });
}

async function setAuthenticatedSession(req, user) {
  await regenerateSession(req);
  req.session.userId = Number(user.id);
  req.session.role = user.role;
  req.session.name = user.name;
  req.session.tokenVersion = Number(user.token_version);
  req.session.companyId = req.companyTenantId ?? LEGACY_TENANT_ID;
  await saveSession(req);
}

async function rejectInvalidSession(req, res) {
  await new Promise(resolve => req.session.destroy(() => resolve()));
  res.clearCookie(sessionCookieName, { path: '/' });
  return res.status(401).json({ error: 'Your session is no longer valid. Please sign in again.' });
}

async function deleteUserSessions(userId, companyId) {
  if (hasControlDatabaseConfiguration()) {
    const controlDatabase = await getControlDatabase();
    await controlDatabase.execute({
      sql: 'DELETE FROM web_sessions WHERE user_id = ? AND company_id = ?',
      args: [userId, String(companyId ?? LEGACY_TENANT_ID)]
    });
    return;
  }
  await db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId);
}

async function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  if (req.companyTenantId !== undefined
    && String(req.session.companyId ?? LEGACY_TENANT_ID) !== String(req.companyTenantId)) {
    return rejectInvalidSession(req, res);
  }
  if (req.authenticatedUser) {
    if (req.companyStatus === 'suspended'
      && (req.authenticatedUser.role !== 'admin' || !['GET', 'HEAD'].includes(req.method))) {
      return res.status(403).json({
        error: 'Account suspended, contact support.',
        suspended: true,
        read_only: true
      });
    }
    if (mustChangePassword(req.authenticatedUser)
      && !isPasswordFlowAllowed(req)) return rejectUntilPasswordChanged(res);
    return next();
  }
  try {
    const user = await db.prepare('SELECT role, name, active, must_change_password, token_version FROM users WHERE id = ?').get(req.session.userId);
    if (!user || Number(user.active) !== 1) return rejectInvalidSession(req, res);
    if (Number(req.session.tokenVersion) !== Number(user.token_version)) return rejectInvalidSession(req, res);
    req.session.role = user.role;
    req.session.name = user.name;
    if (req.companyStatus === 'suspended'
      && (user.role !== 'admin' || !['GET', 'HEAD'].includes(req.method))) {
      return res.status(403).json({
        error: 'Account suspended, contact support.',
        suspended: true,
        read_only: true
      });
    }
    if (mustChangePassword(user) && !isPasswordFlowAllowed(req)) return rejectUntilPasswordChanged(res);
    req.authenticatedUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

router.post('/login', loginIpLimiter, loginUsernameLimiter, loginCompanyLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      logFailedLogin(req, username);
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(normalizedUsername);
    const passwordHash = user?.password_hash || await dummyPasswordHash;
    const passwordMatches = await bcrypt.compare(password, passwordHash);
    if (!user || Number(user.active) !== 1 || !user.password_hash || !passwordMatches) {
      logFailedLogin(req, username);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (req.companyStatus === 'suspended' && user.role !== 'admin') {
      return res.status(403).json({
        error: 'Account suspended, contact support.',
        suspended: true,
        read_only: true
      });
    }

    await setAuthenticatedSession(req, user);
    res.json({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      must_change_password: mustChangePassword(user),
      company_status: req.companyStatus
    });
  } catch (error) {
    logFailedLogin(req, req.body?.username);
    sendInternalError(res, error, 'Login failed');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(error => {
    res.clearCookie(sessionCookieName, { path: '/' });
    clearCompanyContextCookie(res, { secure: req.secure });
    if (error) return sendInternalError(res, error, 'Logout failed');
    res.json({ ok: true });
  });
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (typeof current_password !== 'string' || typeof new_password !== 'string' || new_password.length < passwordMinLength) {
      return res.status(400).json({ error: `New password must be at least ${passwordMinLength} characters.` });
    }

    const user = await db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
    const passwordHash = user?.password_hash;

    if (!user || !passwordHash || !await bcrypt.compare(current_password, passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordHashNext = await bcrypt.hash(new_password, 10);
    await db.prepare('UPDATE users SET password_hash=?, must_change_password=0, token_version=token_version+1 WHERE id=?')
      .run(passwordHashNext, req.session.userId);
    await logActivity(req, 'Password changed', 'user', req.session.userId, 'Your password was changed', req.session.userId);
    await deleteUserSessions(req.session.userId, req.session.companyId);
    const updatedUser = await db.prepare('SELECT id, name, role, token_version FROM users WHERE id=?').get(req.session.userId);
    await setAuthenticatedSession(req, updatedUser);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Password change failed');
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, name, username, department, role, must_change_password FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'User record not found' });
    const planUsage = await getPlanUsage(req);
    res.json({
      id: user.id,
      name: user.name,
      username: user.username,
      department: user.department,
      role: user.role,
      must_change_password: mustChangePassword(user),
      company_status: req.companyStatus,
      plan: planUsage.plan,
      features: planUsage.features,
      usage: planUsage.usage
    });
  } catch (err) {
    sendInternalError(res, err, 'Current user lookup failed');
  }
});

// ---- Admin: user management endpoints ----
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.prepare('SELECT id, name, username, department, role, active, created_at FROM users ORDER BY name').all();
    res.json(users);
  } catch (err) {
    sendInternalError(res, err, 'User list request failed');
  }
});

router.get('/users/directory', requireAuth, async (req, res) => {
  try {
    if (req.session.role !== 'admin') {
      const [paymentAccess, reimbursementAccess] = await Promise.all([
        db.prepare('SELECT user_id FROM payment_history_access WHERE user_id = ?').get(req.session.userId),
        db.prepare('SELECT approval_level FROM reimbursement_access WHERE user_id = ?').get(req.session.userId)
      ]);
      if (!paymentAccess && Number(reimbursementAccess?.approval_level || 0) === 0) {
        return res.status(403).json({ error: 'User directory access is restricted.' });
      }
    }
    const rows = await db.prepare('SELECT id, name, department FROM users WHERE active = 1 ORDER BY name').all();
    res.json(rows);
  } catch (err) {
    sendInternalError(res, err, 'User directory request failed');
  }
});

router.get('/activity', requireAuth, async (req, res) => {
  try {
    const visibilityFilter = req.session.role === 'admin' ? '' : ' WHERE a.actor_id = ? OR a.subject_user_id = ?';
    const visibilityParams = req.session.role === 'admin' ? [] : [req.session.userId, req.session.userId];
    const activityRowsPromise = db.prepare(`SELECT a.*, u.name AS actor_name
      FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id
      ${visibilityFilter}
      ORDER BY a.id DESC LIMIT 100`).all(...visibilityParams);
    if (req.session.role !== 'admin') return res.json(await activityRowsPromise || []);

    const [activityRows, taskHistoryRows] = await Promise.all([
      activityRowsPromise,
      db.prepare(`SELECT h.id, h.actor_id, u.name AS actor_name, h.field_name,
          h.old_value, h.new_value, h.created_at, t.title AS task_title
        FROM task_history h
        JOIN tasks t ON t.id = h.task_id
        LEFT JOIN users u ON u.id = h.actor_id
        WHERE h.field_name <> 'Task created'
        ORDER BY h.id DESC LIMIT 100`).all()
    ]);
    const taskActivity = (taskHistoryRows || []).map(row => ({
      id: row.id,
      actor_id: row.actor_id,
      actor_name: row.actor_name,
      action: `Task ${String(row.field_name || 'details').toLowerCase()} updated`,
      details: `${row.task_title}: ${row.old_value || '—'} -> ${row.new_value || '—'}`,
      created_at: row.created_at
    }));
    const rows = [...(activityRows || []), ...taskActivity]
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, 100);
    res.json(rows || []);
  } catch (err) {
    sendInternalError(res, err, 'Activity request failed');
  }
});

router.post('/users', requireAdmin, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'User details must be provided as an object.' });
    }
    const { name, username, password, department, role } = req.body;
    if (typeof name !== 'string' || typeof username !== 'string' || typeof password !== 'string'
      || (department !== undefined && typeof department !== 'string')
      || (role !== undefined && !['admin', 'employee'].includes(role))) {
      return res.status(400).json({ error: 'Name, username, password, department, or role has an invalid type or value.' });
    }
    const normalizedName = name.trim();
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedName || !normalizedUsername) return res.status(400).json({ error: 'Name and username are required.' });
    if (password.length < passwordMinLength) return res.status(400).json({ error: `Password must be at least ${passwordMinLength} characters.` });

    const plan = await getPlan(req);
    const hash = await bcrypt.hash(password, 10);
    const inserted = await db.batch([
      {
        sql: `INSERT INTO users (name, username, password_hash, department, role)
          SELECT ?, ?, ?, ?, ?
          WHERE ? IS NULL OR (SELECT COUNT(*) FROM users WHERE active = 1) < ?`,
        args: [
          normalizedName,
          normalizedUsername,
          hash,
          (department || '').trim(),
          role === 'admin' ? 'admin' : 'employee',
          plan?.maxUsers ?? null,
          plan?.maxUsers ?? null
        ]
      },
      { sql: 'SELECT last_insert_rowid() AS id', args: [] }
    ]);
    if (Number(inserted?.[0]?.rowsAffected ?? inserted?.[0]?.changes ?? 0) !== 1) {
      return res.status(403).json({ error: 'User limit reached. Contact support to upgrade.' });
    }
    const userId = Number(inserted?.[1]?.rows?.[0]?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('New user record was not returned after insert.');
    await logActivity(req, 'Employee added', 'user', userId, `${normalizedName} (${normalizedUsername})`, userId);
    res.json({ id: userId });
  } catch (e) {
    if (/unique constraint/i.test(String(e.message))) {
      return res.status(409).json({ error: 'That username is already in use.' });
    }
    sendInternalError(res, e, 'User creation failed');
  }
});

router.put('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    const id = req.params.id;

    if (typeof password !== 'string' || password.length < passwordMinLength) {
      return res.status(400).json({ error: `Password must be at least ${passwordMinLength} characters.` });
    }

    const target = await db.prepare('SELECT name, active FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot reset a deactivated user account.' });
    const hash = await bcrypt.hash(password, 10);
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?').run(hash, id);
    await deleteUserSessions(id, req.session.companyId);
    await logActivity(req, 'Employee password changed', 'user', id, target.name, id);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Password reset failed');
  }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { name, username, department, role, active, password } = req.body || {};
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid user id.' });
    if ((name !== undefined && typeof name !== 'string')
      || (username !== undefined && typeof username !== 'string')
      || (department !== undefined && typeof department !== 'string')
      || (role !== undefined && !['admin', 'employee'].includes(role))
      || (active !== undefined && ![true, false, 0, 1].includes(active))) {
      return res.status(400).json({ error: 'Invalid user fields.' });
    }
    if (password !== undefined && password !== '' && typeof password !== 'string') {
      return res.status(400).json({ error: 'Password must be a string.' });
    }
    const target = await db.prepare('SELECT name, username, department, role, active FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const nextActive = active === undefined ? undefined : active === true || Number(active) === 1;
    const nextRole = role === undefined ? undefined : role;
    if (id === Number(req.session.userId) && nextActive === false) return res.status(400).json({ error: "You can't disable your own account." });
    if (id === Number(req.session.userId) && nextRole !== undefined && nextRole !== 'admin') return res.status(400).json({ error: "You can't remove your own admin access." });
    const activeChanged = nextActive !== undefined && Number(target.active) !== (nextActive ? 1 : 0);
    let userLimit = null;
    if (activeChanged && nextActive) {
      const plan = await getPlan(req);
      userLimit = plan?.maxUsers ?? null;
    }
    if (password && password.length < passwordMinLength) return res.status(400).json({ error: `Password must be at least ${passwordMinLength} characters.` });
    const nextName = name === undefined ? undefined : name.trim();
    const nextUsername = username === undefined ? undefined : username.trim().toLowerCase();
    if (nextName === '') return res.status(400).json({ error: 'Employee name cannot be empty.' });
    if (nextUsername === '') return res.status(400).json({ error: 'Username cannot be empty.' });
    if (nextUsername !== undefined) {
      const duplicate = await db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(nextUsername, id);
      if (duplicate) return res.status(409).json({ error: 'That username is already in use.' });
    }

    if (activeChanged && nextActive) {
      const activation = await db.prepare(`UPDATE users SET active = 1
        WHERE id = ? AND active = 0
          AND (? IS NULL OR (SELECT COUNT(*) FROM users WHERE active = 1) < ?)`)
        .run(id, userLimit, userLimit);
      if (Number(activation?.changes ?? activation?.rowsAffected ?? 0) !== 1) {
        return res.status(403).json({ error: 'User limit reached. Contact support to upgrade.' });
      }
    }
    
    if (nextName !== undefined) await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(nextName, id);
    if (nextUsername !== undefined) await db.prepare('UPDATE users SET username = ? WHERE id = ?').run(nextUsername, id);
    if (department !== undefined) {
      const nextDepartment = department.trim();
      await db.prepare('UPDATE users SET department = ? WHERE id = ?').run(nextDepartment, id);
      if (target.department !== nextDepartment) await logActivity(req, 'Department changed', 'user', id, `${target.name}: ${target.department || 'No department'} -> ${nextDepartment || 'No department'}`, id);
    }
    const roleChanged = nextRole !== undefined && target.role !== nextRole;
    if (roleChanged) {
      await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextRole, id);
      await logActivity(req, 'Role changed', 'user', id, `${target.name}: ${target.role} -> ${nextRole}`, id);
    }
    if (activeChanged && !nextActive) await db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    if (activeChanged) await logActivity(req, 'Account status changed', 'user', id, `${target.name}: ${Number(target.active) === 1 ? 'active' : 'inactive'} -> ${nextActive ? 'active' : 'inactive'}`, id);
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?').run(hash, id);
    } else if (roleChanged || activeChanged) {
      await db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
    }
    if (password || roleChanged || activeChanged) await deleteUserSessions(id, req.session.companyId);
    if ((password || roleChanged || activeChanged) && id === Number(req.session.userId) && nextActive !== false) {
      const updatedUser = await db.prepare('SELECT id, name, role, token_version FROM users WHERE id = ?').get(id);
      await setAuthenticatedSession(req, updatedUser);
    }
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'User update failed');
  }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "Can't delete your own account" });
  try {
    const target = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    await db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
    await db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.params.id);
    await deleteUserSessions(req.params.id, req.session.companyId);
    await logActivity(req, 'Employee access removed', 'user', req.params.id, target.name, Number(req.params.id));
    res.json({ ok: true, archived: true });
  } catch (error) {
    sendInternalError(res, error, 'User archive failed');
  }
});

router.get('/departments', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT id, name FROM departments ORDER BY name').all();
    res.json(rows || []);
  } catch (error) {
    sendInternalError(res, error, 'Department list request failed');
  }
});

router.post('/departments', requireAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Department name is required.' });
  try {
    const info = await db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    await logActivity(req, 'Department added', 'department', info.lastInsertRowid, name);
    res.json({ id: info.lastInsertRowid, name });
  } catch (error) {
    if (/unique constraint/i.test(String(error.message))) {
      return res.status(409).json({ error: 'That department already exists.' });
    }
    sendInternalError(res, error, 'Department creation failed');
  }
});

router.delete('/departments/:id', requireAdmin, async (req, res) => {
  try {
    const department = await db.prepare('SELECT name FROM departments WHERE id = ?').get(req.params.id);
    if (!department) return res.status(404).json({ error: 'Department not found.' });
    const result = await db.prepare(`DELETE FROM departments WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM users WHERE lower(trim(department)) = lower(?))`)
      .run(req.params.id, department.name);
    if (!result.changes) return res.status(409).json({ error: 'Cannot delete a department while users are assigned to it.' });
    await logActivity(req, 'Department deleted', 'department', req.params.id, department.name);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Department deletion failed');
  }
});

router.get('/reimbursement-access', requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT u.id AS user_id, u.name, u.username, u.department,
           COALESCE(ra.approval_level, 0) AS approval_level,
           COALESCE(ra.can_pay, 0) AS can_pay
    FROM users u LEFT JOIN reimbursement_access ra ON ra.user_id = u.id
    WHERE u.active = 1 ORDER BY u.name`).all();
  res.json(rows || []);
}));

router.get('/reimbursement-access/me', requireAuth, asyncHandler(async (req, res) => {
  const row = await db.prepare('SELECT approval_level, can_pay FROM reimbursement_access WHERE user_id = ?').get(req.session.userId);
  res.json({ approval_level: req.session.role === 'admin' ? 2 : (row ? row.approval_level : 0), can_pay: req.session.role === 'admin' ? 1 : (row ? row.can_pay : 0) });
}));

router.put('/reimbursement-access/:userId', requireAdmin, asyncHandler(async (req, res) => {
  const approvalLevel = Number(req.body?.approval_level);
  if (![0, 1, 2].includes(approvalLevel)) return res.status(400).json({ error: 'Approval level must be 0, 1, or 2.' });
  const canPay = approvalLevel === 2 && req.body?.can_pay ? 1 : 0;
  const target = await db.prepare('SELECT name, active FROM users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (approvalLevel > 0 && Number(target.active) !== 1) return res.status(400).json({ error: 'Cannot grant reimbursement access to a deactivated user.' });
  if (approvalLevel === 0) {
    await db.prepare('DELETE FROM reimbursement_access WHERE user_id = ?').run(req.params.userId);
  } else {
    await db.prepare(`INSERT INTO reimbursement_access (user_id, approval_level, can_pay) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET approval_level = excluded.approval_level, can_pay = excluded.can_pay, updated_at = datetime('now')`)
      .run(req.params.userId, approvalLevel, canPay);
  }
  await logActivity(req, 'Reimbursement permission changed', 'user', req.params.userId, `${target.name}: approval level ${approvalLevel}, can pay ${canPay ? 'yes' : 'no'}`, req.params.userId);
  res.json({ ok: true });
}));

router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const row of rows) {
      if (settingKeys.has(row.key)) out[row.key] = row.value ?? '';
    }
    res.json(out);
  } catch (err) {
    sendInternalError(res, err, 'Settings request failed');
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Settings must be provided as an object.' });
    }
    const entries = Object.entries(req.body);
    if (entries.some(([key]) => !settingKeys.has(key))) {
      return res.status(400).json({ error: 'One or more setting keys are not allowed.' });
    }
    const settings = {};
    for (const [key, value] of entries) {
      if (value === null || !['string', 'number', 'boolean'].includes(typeof value)) {
        return res.status(400).json({ error: `Invalid value for ${key}.` });
      }
      if (booleanSettingKeys.has(key)) {
        const normalized = typeof value === 'string' ? value.toLowerCase() : value;
        if (![true, false, 'true', 'false'].includes(normalized)) {
          return res.status(400).json({ error: `${key} must be true or false.` });
        }
        settings[key] = String(normalized);
      } else {
        settings[key] = String(value).trim();
      }
    }

    const officeSettingKeys = ['office_lat', 'office_lng', 'office_radius_m'];
    if (officeSettingKeys.some(key => Object.hasOwn(settings, key))) {
      const storedOfficeRows = await db.prepare(`SELECT key, value FROM settings
        WHERE key IN ('office_lat', 'office_lng', 'office_radius_m')`).all();
      const storedOfficeSettings = Object.fromEntries(storedOfficeRows.map(row => [row.key, row.value]));
      const settingValue = key => Object.hasOwn(settings, key) ? settings[key] : storedOfficeSettings[key];
      const parseNumber = value => {
        if (value === null || value === undefined || String(value).trim() === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const latitude = parseNumber(settingValue('office_lat'));
      const longitude = parseNumber(settingValue('office_lng'));
      const radius = parseNumber(settingValue('office_radius_m'));
      if (latitude === null || latitude < -90 || latitude > 90) {
        return res.status(400).json({ error: 'Office latitude must be between -90 and 90.' });
      }
      if (longitude === null || longitude < -180 || longitude > 180) {
        return res.status(400).json({ error: 'Office longitude must be between -180 and 180.' });
      }
      if (radius === null || !Number.isInteger(radius) || radius < 1 || radius > 100000) {
        return res.status(400).json({ error: 'Office radius must be a whole number from 1 to 100000 meters.' });
      }
      if (Object.hasOwn(settings, 'office_lat')) settings.office_lat = String(latitude);
      if (Object.hasOwn(settings, 'office_lng')) settings.office_lng = String(longitude);
      if (Object.hasOwn(settings, 'office_radius_m')) settings.office_radius_m = String(radius);
    }
    const retentionLimits = {
      attachment_retention_days: { min: 0, max: 36500 },
      attendance_location_retention_days: { min: 1, max: 36500 }
    };
    for (const [key, { min, max }] of Object.entries(retentionLimits)) {
      if (settings[key] === undefined) continue;
      const value = settings[key];
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        return res.status(400).json({ error: `${key} must be a whole number from ${min} to ${max}.` });
      }
      settings[key] = String(Number(value));
    }
    const statements = Object.entries(settings).map(([key, value]) => ({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [key, value]
    }));
    if (statements.length) await db.batch(statements);
    res.json({ ok: true });
  } catch (error) {
    sendInternalError(res, error, 'Settings update failed');
  }
});

module.exports = { router, requireAuth, requireAdmin };
