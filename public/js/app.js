// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

function showModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); $('#modal').innerHTML = ''; }
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

function confirmModal(title, body, confirmLabel = 'Delete', danger = true) {
  return new Promise((resolve) => {
    showModal(`
      <h3>${title}</h3>
      <p class="hint">${body}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">${confirmLabel}</button>
      </div>`);
    $('#m-cancel').onclick = () => { closeModal(); resolve(false); };
    $('#m-ok').onclick = () => { closeModal(); resolve(true); };
  });
}

// ---------- state ----------
let ME = null;
let PROJECTS = [];
let PEOPLE = [];
let CURRENT_PROJECT = null;
let CURRENT_TASK_ID = null;
const unlockedProjects = new Set();

// ---------- boot ----------
(async function init() {
  try {
    ME = await api('/auth/me');
    enterApp();
  } catch (e) {
    $('#login-screen').classList.remove('hidden');
  }
})();

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    ME = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value, password: $('#login-password').value },
    });
    enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.reload();
});

async function enterApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#me-badge').innerHTML = `Signed in as<br><b>${ME.name}</b>`;
  if (ME.role === 'admin') $('#nav-admin').style.display = '';
  PEOPLE = await api('/people');
  await loadProjects();
  showView('attendance');
  renderPunchCard();
  renderLiveList();
  renderHistory();
}

// ---------- nav ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function showView(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.project-item').forEach((b) => b.classList.remove('active'));
  ['attendance', 'admin', 'project', 'empty'].forEach((v) => $('#view-' + v).classList.add('hidden'));
  closeDrawer();
  if (view === 'attendance') {
    $('#view-attendance').classList.remove('hidden');
    renderPunchCard(); renderLiveList(); renderHistory();
  } else if (view === 'admin') {
    $('#view-admin').classList.remove('hidden');
    renderAdmin();
  } else if (view === 'project') {
    $('#view-project').classList.remove('hidden');
  } else {
    $('#view-empty').classList.remove('hidden');
  }
}

// ================= PROJECTS =================
async function loadProjects() {
  PROJECTS = await api('/projects');
  renderProjectList();
}

function renderProjectList() {
  const list = $('#project-list');
  list.innerHTML = '';
  PROJECTS.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'project-item-row';
    row.innerHTML = `
      <button class="project-item" data-id="${p.id}">${p.locked ? '<span class="lock">🔒</span> ' : ''}${escapeHtml(p.name)}</button>
      <button class="project-del" data-id="${p.id}" title="Delete project">✕</button>`;
    list.appendChild(row);
  });
  $$('.project-item').forEach((btn) => btn.addEventListener('click', () => openProject(Number(btn.dataset.id))));
  $$('.project-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const p = PROJECTS.find((x) => x.id === Number(btn.dataset.id));
    const ok = await confirmModal('Delete project?', `"${p.name}" and all its tasks will be permanently deleted.`);
    if (!ok) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    if (CURRENT_PROJECT && CURRENT_PROJECT.id === p.id) showView('empty');
    await loadProjects();
  }));
}

$('#btn-new-project').addEventListener('click', () => {
  showModal(`
    <h3>New project</h3>
    <input id="np-name" placeholder="Project name" autofocus>
    <input id="np-pin" placeholder="Optional PIN (leave blank for none)" type="text" inputmode="numeric">
    <p class="hint">A PIN adds light in-app privacy — anyone opening this project on this device will be asked for it.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-ok">Create</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const name = $('#np-name').value.trim();
    if (!name) return;
    const pin = $('#np-pin').value.trim();
    await api('/projects', { method: 'POST', body: { name, pin: pin || null } });
    closeModal();
    await loadProjects();
  };
});

async function openProject(id) {
  const project = PROJECTS.find((p) => p.id === id);
  if (!project) return;
  if (project.locked && !unlockedProjects.has(id)) {
    showModal(`
      <h3>🔒 ${escapeHtml(project.name)}</h3>
      <input id="pin-input" placeholder="Enter PIN" type="password" autofocus>
      <div id="pin-error" class="form-error"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-ok">Unlock</button>
      </div>`);
    $('#m-cancel').onclick = closeModal;
    $('#m-ok').onclick = async () => {
      try {
        await api(`/projects/${id}/unlock`, { method: 'POST', body: { pin: $('#pin-input').value } });
        unlockedProjects.add(id);
        closeModal();
        await enterProjectView(project);
      } catch (e) {
        $('#pin-error').textContent = e.message;
      }
    };
    return;
  }
  await enterProjectView(project);
}

async function enterProjectView(project) {
  CURRENT_PROJECT = project;
  showView('project');
  $$('.project-item').forEach((b) => b.classList.toggle('active', Number(b.dataset.id) === project.id));
  $('#project-title').textContent = project.name;
  await renderTasks();
}

// ================= TASKS =================
async function renderTasks() {
  const tasks = await api(`/projects/${CURRENT_PROJECT.id}/tasks`);
  const tbody = $('#task-list');
  tbody.innerHTML = '';
  if (!tasks.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:20px 14px;">No tasks yet — add one above.</td></tr>`;
    return;
  }
  tasks.forEach((t) => {
    const tr = document.createElement('tr');
    tr.className = 'task-row' + (t.status === 'done' ? ' done' : '');
    const person = PEOPLE.find((p) => p.id === t.assignee_id);
    let dueClass = '';
    if (t.due_date) {
      if (t.due_date < todayISO() && t.status !== 'done') dueClass = 'overdue';
      else if (t.due_date === todayISO()) dueClass = 'today';
    }
    tr.innerHTML = `
      <td><input type="checkbox" class="task-check" ${t.status === 'done' ? 'checked' : ''}></td>
      <td class="task-title">${escapeHtml(t.title)}</td>
      <td>${person ? `<span class="assignee-chip">${escapeHtml(person.name)}</span>` : ''}</td>
      <td><span class="task-due ${dueClass}">${t.due_date ? fmtDate(t.due_date) : ''}</span></td>
      <td><button class="row-del" title="Delete">✕</button></td>`;
    tr.querySelector('.task-check').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/tasks/${t.id}`, { method: 'PUT', body: { status: e.target.checked ? 'done' : 'open' } });
      renderTasks();
    });
    tr.querySelector('.row-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmModal('Delete task?', `"${t.title}" will be permanently deleted.`);
      if (!ok) return;
      await api(`/tasks/${t.id}`, { method: 'DELETE' });
      renderTasks();
    });
    tr.addEventListener('click', () => openTaskDrawer(t.id));
    tbody.appendChild(tr);
  });
}

$('#btn-new-task').addEventListener('click', () => {
  showModal(`
    <h3>New task</h3>
    <input id="nt-title" placeholder="Task title" autofocus>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-ok">Add</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const title = $('#nt-title').value.trim();
    if (!title) return;
    await api(`/projects/${CURRENT_PROJECT.id}/tasks`, { method: 'POST', body: { title } });
    closeModal();
    renderTasks();
  };
});

// ---------- task drawer ----------
async function openTaskDrawer(id) {
  CURRENT_TASK_ID = id;
  const t = await api(`/tasks/${id}`);
  $('#task-drawer').classList.remove('hidden');
  $('#drawer-title').value = t.title;
  $('#drawer-desc').value = t.description || '';
  autoResize($('#drawer-desc'));
  $('#drawer-due').value = t.due_date || '';
  $('#drawer-status').value = t.status;
  const sel = $('#drawer-assignee');
  sel.innerHTML = '<option value="">Unassigned</option>' + PEOPLE.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  sel.value = t.assignee_id || '';

  renderSubtasks(t.subtasks);
  renderComments(t.comments);
}
function closeDrawer() { $('#task-drawer').classList.add('hidden'); CURRENT_TASK_ID = null; }
$('#drawer-close').addEventListener('click', closeDrawer);

let saveTimer;
function debounceSave(fn) { clearTimeout(saveTimer); saveTimer = setTimeout(fn, 400); }

$('#drawer-title').addEventListener('input', () => debounceSave(() =>
  api(`/tasks/${CURRENT_TASK_ID}`, { method: 'PUT', body: { title: $('#drawer-title').value } }).then(renderTasks)));
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
$('#drawer-desc').addEventListener('input', () => {
  autoResize($('#drawer-desc'));
  debounceSave(() => api(`/tasks/${CURRENT_TASK_ID}`, { method: 'PUT', body: { description: $('#drawer-desc').value } }));
});
$('#drawer-due').addEventListener('change', () =>
  api(`/tasks/${CURRENT_TASK_ID}`, { method: 'PUT', body: { due_date: $('#drawer-due').value || null } }).then(renderTasks));
$('#drawer-status').addEventListener('change', () =>
  api(`/tasks/${CURRENT_TASK_ID}`, { method: 'PUT', body: { status: $('#drawer-status').value } }).then(renderTasks));
$('#drawer-assignee').addEventListener('change', () =>
  api(`/tasks/${CURRENT_TASK_ID}`, { method: 'PUT', body: { assignee_id: $('#drawer-assignee').value || null } }).then(renderTasks));

$('#btn-delete-task').addEventListener('click', async () => {
  const ok = await confirmModal('Delete task?', 'This will be permanently deleted.');
  if (!ok) return;
  await api(`/tasks/${CURRENT_TASK_ID}`, { method: 'DELETE' });
  closeDrawer();
  renderTasks();
});

function renderSubtasks(subtasks) {
  const wrap = $('#drawer-subtasks');
  wrap.innerHTML = '';
  subtasks.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'subtask-row' + (s.done ? ' done' : '');
    row.innerHTML = `<input type="checkbox" ${s.done ? 'checked' : ''}><span class="subtask-title">${escapeHtml(s.title)}</span><button class="subtask-del">✕</button>`;
    row.querySelector('input').addEventListener('change', async (e) => {
      await api(`/subtasks/${s.id}`, { method: 'PUT', body: { done: e.target.checked } });
      openTaskDrawer(CURRENT_TASK_ID);
    });
    row.querySelector('.subtask-del').addEventListener('click', async () => {
      await api(`/subtasks/${s.id}`, { method: 'DELETE' });
      openTaskDrawer(CURRENT_TASK_ID);
    });
    wrap.appendChild(row);
  });
}

$('#btn-add-subtask').addEventListener('click', () => {
  showModal(`
    <h3>Add subtask</h3>
    <input id="st-title" placeholder="Subtask title" autofocus>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="m-cancel">Cancel</button>
      <button class="btn btn-primary" id="m-ok">Add</button>
    </div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-ok').onclick = async () => {
    const title = $('#st-title').value.trim();
    if (!title) return;
    await api(`/tasks/${CURRENT_TASK_ID}/subtasks`, { method: 'POST', body: { title } });
    closeModal();
    openTaskDrawer(CURRENT_TASK_ID);
  };
});

function renderComments(comments) {
  const wrap = $('#drawer-comments');
  wrap.innerHTML = comments.length ? '' : '<p class="hint">No comments yet.</p>';
  comments.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'comment';
    const img = c.image_path ? `<a href="${c.image_path}" target="_blank"><img class="comment-image" src="${c.image_path}"></a>` : '';
    el.innerHTML = `<div class="comment-meta">${escapeHtml(c.user_name || 'Someone')} · ${fmtDate(c.created_at)} ${fmtTime(c.created_at)}</div>${escapeHtml(c.body)}${img}`;
    wrap.appendChild(el);
  });
}

let pendingCommentFile = null;

$('#btn-attach-image').addEventListener('click', () => $('#comment-file-input').click());
$('#comment-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const preview = $('#comment-image-preview');
  if (!file) { pendingCommentFile = null; preview.classList.add('hidden'); preview.innerHTML = ''; return; }
  if (file.size > 50 * 1024 * 1024) {
    alert('That image is larger than 50MB — please pick a smaller one.');
    e.target.value = '';
    return;
  }
  pendingCommentFile = file;
  preview.classList.remove('hidden');
  preview.innerHTML = `<img src="${URL.createObjectURL(file)}"><button type="button" id="remove-comment-image">✕ remove</button>`;
  $('#remove-comment-image').addEventListener('click', () => {
    pendingCommentFile = null;
    $('#comment-file-input').value = '';
    preview.classList.add('hidden');
    preview.innerHTML = '';
  });
});

$('#btn-add-comment').addEventListener('click', addComment);
$('#drawer-comment-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addComment(); });
async function addComment() {
  const input = $('#drawer-comment-input');
  const body = input.value.trim();
  if (!body && !pendingCommentFile) return;

  const fd = new FormData();
  fd.append('body', body);
  if (pendingCommentFile) fd.append('image', pendingCommentFile);

  const res = await fetch(`/api/tasks/${CURRENT_TASK_ID}/comments`, {
    method: 'POST', credentials: 'same-origin', body: fd,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) { alert((data && data.error) || 'Could not post comment'); return; }

  input.value = '';
  pendingCommentFile = null;
  $('#comment-file-input').value = '';
  $('#comment-image-preview').classList.add('hidden');
  $('#comment-image-preview').innerHTML = '';
  openTaskDrawer(CURRENT_TASK_ID);
}

// ================= ATTENDANCE =================
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('This browser/device does not support location.'));
    }
    if (window.isSecureContext === false) {
      return reject(new Error('Location requires a secure connection (HTTPS). Ask your admin to set up HTTPS/Tailscale cert for remote access.'));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error('Location permission was denied. Enable location access for this site in your browser/phone settings, then try again.'));
        } else {
          reject(new Error('Could not get your location. Make sure location/GPS is turned on and try again.'));
        }
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });
}

function statusBadge(status) {
  const map = { 'on-site': '🟢 On-site', 'remote': '🟡 Remote', 'unknown': '⚪ Location not confirmed' };
  return `<span class="badge ${status || 'unknown'}">${map[status] || map.unknown}</span>`;
}

async function renderPunchCard() {
  const today = await api('/attendance/today');
  const card = $('#attendance-punch');
  if (!today || !today.punch_in) {
    card.innerHTML = `
      <div class="punch-card">
        <div>
          <h2>You haven't punched in today</h2>
          <div class="punch-status">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
        <button class="btn btn-primary" id="btn-punch-in">Punch in</button>
        <div class="punch-error" id="punch-error"></div>
      </div>`;
    $('#btn-punch-in').addEventListener('click', async () => {
      const btn = $('#btn-punch-in');
      const errBox = $('#punch-error');
      errBox.textContent = '';
      btn.textContent = 'Locating…';
      btn.disabled = true;
      try {
        const loc = await getLocation();
        await api('/attendance/punch-in', { method: 'POST', body: loc });
        renderPunchCard(); renderLiveList(); renderHistory();
      } catch (e) {
        errBox.textContent = e.message;
        btn.textContent = 'Punch in';
        btn.disabled = false;
      }
    });
  } else if (!today.punch_out) {
    card.innerHTML = `
      <div class="punch-card">
        <div>
          <h2>Punched in at ${fmtTime(today.punch_in)}</h2>
          <div class="punch-status">${statusBadge(today.location_status)}</div>
        </div>
        <button class="btn btn-secondary" id="btn-punch-out">Punch out</button>
        <div class="punch-error" id="punch-error"></div>
      </div>`;
    $('#btn-punch-out').addEventListener('click', async () => {
      const btn = $('#btn-punch-out');
      const errBox = $('#punch-error');
      errBox.textContent = '';
      btn.textContent = 'Locating…';
      btn.disabled = true;
      try {
        const loc = await getLocation();
        await api('/attendance/punch-out', { method: 'POST', body: loc });
        renderPunchCard(); renderLiveList(); renderHistory();
      } catch (e) {
        errBox.textContent = e.message;
        btn.textContent = 'Punch out';
        btn.disabled = false;
      }
    });
  } else {
    card.innerHTML = `
      <div class="punch-card">
        <div>
          <h2>Done for today ✓</h2>
          <div class="punch-status">In ${fmtTime(today.punch_in)} → Out ${fmtTime(today.punch_out)} · ${statusBadge(today.location_status)}</div>
        </div>
      </div>`;
  }
}

async function renderLiveList() {
  if (ME.role !== 'admin') { $('#attendance-live').innerHTML = ''; return; }
  const live = await api('/attendance/live');
  const wrap = $('#attendance-live');
  wrap.innerHTML = `<div class="section-title">Currently on the clock (${live.length})</div>
    <div class="live-list">${
      live.length
        ? live.map((r) => `<div class="live-chip"><span class="dot"></span>${escapeHtml(r.user_name)} · since ${fmtTime(r.punch_in)}</div>`).join('')
        : '<span style="color:var(--muted);font-size:13.5px;">No one is currently punched in.</span>'
    }</div>`;
}

async function renderHistory() {
  const wrap = $('#attendance-history');
  if (ME.role !== 'admin') {
    const mine = await api('/attendance/mine');
    wrap.innerHTML = `<div class="section-title">Your recent attendance</div>
      <table class="attn-table">
        <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Location</th></tr></thead>
        <tbody>${
          mine.length
            ? mine.map((r) => `<tr><td>${r.date}</td><td>${fmtTime(r.punch_in) || '—'}</td><td>${fmtTime(r.punch_out) || '—'}</td><td>${statusBadge(r.location_status)}</td></tr>`).join('')
            : `<tr><td colspan="4" style="color:var(--muted);">No records yet.</td></tr>`
        }</tbody>
      </table>`;
    return;
  }
  const dataRows = await api('/attendance?' + new URLSearchParams({ from: last14Days() }));
  const title = 'Team attendance — last 14 days';
  wrap.innerHTML = `<div class="section-title">${title}</div>
    <table class="attn-table">
      <thead><tr><th>Name</th><th>Date</th><th>In</th><th>Out</th><th>Location</th></tr></thead>
      <tbody>${
        dataRows.length
          ? dataRows.map((r) => `<tr><td>${escapeHtml(r.user_name)}</td><td>${r.date}</td><td>${fmtTime(r.punch_in)}</td><td>${fmtTime(r.punch_out) || '—'}</td><td>${statusBadge(r.location_status)}</td></tr>`).join('')
          : `<tr><td colspan="5" style="color:var(--muted);">No records yet.</td></tr>`
      }</tbody>
    </table>
    <p style="margin-top:10px;"><a href="/api/attendance/export.csv?from=${last14Days()}" style="color:var(--green);font-size:13px;font-weight:600;">Export CSV ↓</a></p>`;
}
function last14Days() { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10); }

// ================= ADMIN =================
async function renderAdmin() {
  const [users, settings] = await Promise.all([api('/auth/users'), api('/auth/settings')]);
  const wrap = $('#admin-content');
  wrap.innerHTML = `
    <div class="admin-block">
      <h3>Office location (for on-site detection)</h3>
      <p class="hint">Set your office's coordinates once — punches within the radius are marked 🟢 On-site, others 🟡 Remote. Find coordinates by searching your address on Google Maps, right-click → "What's here?".</p>
      <div class="admin-form-row">
        <input id="s-lat" placeholder="Latitude" value="${settings.office_lat || ''}">
        <input id="s-lng" placeholder="Longitude" value="${settings.office_lng || ''}">
        <input id="s-radius" placeholder="Radius (meters)" value="${settings.office_radius_m || '150'}">
        <button class="btn btn-primary" id="s-save">Save</button>
      </div>
    </div>

    <div class="admin-block">
      <h3>Team members</h3>
      <div class="admin-form-row">
        <input id="u-name" placeholder="Full name">
        <input id="u-username" placeholder="Username">
        <input id="u-password" placeholder="Password" type="text">
        <select id="u-role"><option value="employee">Employee</option><option value="admin">Admin</option></select>
        <button class="btn btn-primary" id="u-add">Add person</button>
      </div>
      <table class="admin-table">
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td>${escapeHtml(u.name)}</td>
            <td>${escapeHtml(u.username)}</td>
            <td><span class="tag ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span></td>
            <td>${u.active ? 'Active' : 'Disabled'}</td>
            <td><button class="link-btn" data-id="${u.id}" data-action="toggle">${u.active ? 'Disable' : 'Enable'}</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $('#s-save').addEventListener('click', async () => {
    await api('/auth/settings', { method: 'PUT', body: {
      office_lat: $('#s-lat').value, office_lng: $('#s-lng').value, office_radius_m: $('#s-radius').value,
    }});
    $('#s-save').textContent = 'Saved ✓';
    setTimeout(() => $('#s-save').textContent = 'Save', 1200);
  });

  $('#u-add').addEventListener('click', async () => {
    const name = $('#u-name').value.trim();
    const username = $('#u-username').value.trim();
    const password = $('#u-password').value.trim();
    if (!name || !username || !password) return;
    try {
      await api('/auth/users', { method: 'POST', body: { name, username, password, role: $('#u-role').value } });
      renderAdmin();
    } catch (e) { alert(e.message); }
  });

  $$('#admin-content [data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = users.find((x) => x.id === Number(btn.dataset.id));
      await api(`/auth/users/${u.id}`, { method: 'PUT', body: { active: !u.active } });
      renderAdmin();
    });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
