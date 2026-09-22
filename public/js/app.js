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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function showModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); $('#modal').innerHTML = ''; }
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

function confirmModal(title, body, confirmLabel = 'Delete', danger = true) {
  return new Promise((resolve) => {
    showModal(`
      <h3>\${title}</h3>
      <p class="hint">\${body}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn \${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">\${confirmLabel}</button>
      </div>`);
    $('#m-cancel').onclick = () => { closeModal(); resolve(false); };
    $('#m-ok').onclick = () => { closeModal(); resolve(true); };
  });
}

function closeDrawer() {
  const drawer = $('#drawer');
  if (drawer) drawer.classList.add('hidden');
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
  $('#me-badge').innerHTML = `Signed in as<br><b>\${ME.name}</b>`;
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
  ['attendance', 'admin', 'project', 'mytasks', 'empty'].forEach((v) => {
    const el = $('#view-' + v);
    if (el) el.classList.add('hidden');
  });
  closeDrawer();
  if (view === 'attendance') {
    $('#view-attendance').classList.remove('hidden');
    renderPunchCard(); renderLiveList(); renderHistory();
  } else if (view === 'admin') {
    $('#view-admin').classList.remove('hidden');
    renderAdmin();
  } else if (view === 'mytasks') {
    $('#view-mytasks').classList.remove('hidden');
    renderMyTasks();
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
      <button class="project-item" data-id="\${p.id}">\${p.locked ? '<span class="lock">🔒</span> ' : ''}\${escapeHtml(p.name)}</button>
      \${ME.role === 'admin' ? `<button class="project-del" data-id="\${p.id}" title="Delete project">✕</button>` : ''}`;
    list.appendChild(row);
  });
  $$('.project-item').forEach((btn) => btn.addEventListener('click', () => openProject(Number(btn.dataset.id))));
  $$('.project-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const p = PROJECTS.find((x) => x.id === Number(btn.dataset.id));
    const ok = await confirmModal('Delete project?', `"\${p.name}" and all its tasks will be permanently deleted.`);
    if (!ok) return;
    await api(`/projects/\${p.id}`, { method: 'DELETE' });
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
      <h3>🔒 \${escapeHtml(project.name)}</h3>
      <input id="pin-input" placeholder="Enter PIN" type="password" autofocus>
      <div id="pin-error" class="form-error"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-ok">Unlock</button>
      </div>`);
    $('#m-cancel').onclick = closeModal;
    $('#m-ok').onclick = async () => {
      try {
        await api(`/projects/\${id}/unlock`, { method: 'POST', body: { pin: $('#pin-input').value } });
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
  await renderProjectMembersHint();
  await renderTaskAssigneeFilter();
  await renderTasks();
}

async function renderProjectMembersHint() { /* Stub for your existing project members display logic */ }

async function renderTaskAssigneeFilter(){
  if(!CURRENT_PROJECT) return;
  const members = await api(`/projects/\${CURRENT_PROJECT.id}/members`);
  const sel = $('#task-assignee-filter'); if(!sel) return;
  const old = sel.value || 'all';
  sel.innerHTML = '<option value="all">All assignees</option>' + members.map(p => `<option value="\${p.id}">\${escapeHtml(p.name)}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === old) ? old : 'all';
}

// ================= TASKS =================
async function renderTasks() {
  if (!CURRENT_PROJECT) return;
  const filter = $('#task-assignee-filter')?.value || 'all';
  // Stub for your core project tasks loading UI logic
}

async function renderMyTasks() { /* Stub for your personal tasks display view logic */ }

// ================= ATTENDANCE (FIELD OPERATION MECHANICS) =================
function getLiveCoords() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation is not supported by your browser.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error('Location access denied. Please enable GPS permissions.')),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function renderPunchCard() {
  const card = $('#punch-card-container');
  if (!card) return;
  try {
    const status = await api('/attendance/today');
    if (!status) {
      card.innerHTML = `<button class="btn btn-primary btn-lg" id="btn-punch-in">📍 Punch In Shift</button>`;
      $('#btn-punch-in').onclick = async () => {
        try {
          const coords = await getLiveCoords();
          const res = await api('/attendance/punch-in', { method: 'POST', body: coords });
          alert('Punched in successfully!');
          renderPunchCard(); renderLiveList(); renderHistory();
        } catch (err) { alert(err.message); }
      };
    } else if (status.punch_in && !status.punch_out) {
      card.innerHTML = `
        <div class="status-alert">Active Shift Started: \${fmtTime(status.punch_in)}</div>
        <button class="btn btn-danger btn-lg" id="btn-punch-out">🏁 Punch Out Shift</button>`;
      $('#btn-punch-out').onclick = async () => {
        try {
          const coords = await getLiveCoords();
          const res = await api('/attendance/punch-out', { method: 'POST', body: coords });
          alert('Punched out successfully!');
          renderPunchCard(); renderLiveList(); renderHistory();
        } catch (err) { alert(err.message); }
      };
    } else {
      card.innerHTML = `<div class="status-complete">✅ Duty Completed Today (\${fmtTime(status.punch_in)} - \${fmtTime(status.punch_out)})</div>`;
    }
  } catch (err) {
    card.innerHTML = `<div class="form-error">Failed to sync tracker metrics: \${err.message}</div>`;
  }
}

async function renderLiveList() {
  const list = $('#live-attendance-list');
  if (!list) return;
  try {
    const rows = await api('/attendance/live');
    if (!rows.length) {
      list.innerHTML = '<tr><td colspan="3" class="hint">No field workers active right now.</td></tr>';
      return;
    }
    list.innerHTML = rows.map(r => `
      <tr>
        <td><b>\${escapeHtml(r.user_name)}</b></td>
        <td>\${fmtTime(r.punch_in)}</td>
        <td><a href="\${r.in_map_url}" target="_blank" class="map-link">\${r.location_status || 'View Map'}</a></td>
      </tr>
    `).join('');
  } catch (err) { console.error(err); }
}

async function renderHistory() {
  const table = $('#attendance-history-table');
  if (!table) return;
  try {
    const rows = await api('/attendance/mine');
    if (!rows.length) {
      table.innerHTML = '<tr><td colspan="4" class="hint">No tracking entries logged in the last 30 days.</td></tr>';
      return;
    }
    table.innerHTML = rows.map(r => `
      <tr>
        <td>\${fmtDate(r.date)}</td>
        <td>\${fmtTime(r.punch_in) || '--'}</td>
        <td>\${fmtTime(r.punch_out) || '--'}</td>
        <td>
          <small style="display:block; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${escapeHtml(r.location_status || '')}</small>
          <div class="row-actions" style="margin-top:4px;">
            \${r.in_map_url ? `<a href="\${r.in_map_url}" target="_blank" style="font-size:12px; margin-right:8px;">📍 In Map</a>` : ''}
            \${r.out_map_url ? `<a href="\${r.out_map_url}" target="_blank" style="font-size:12px;">📍 Out Map</a>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) { console.error(err); }
}

// ================= ADMIN CONSOLE MANAGEMENT =================
async function renderAdmin() {
  try {
    const [users, settings] = await Promise.all([api('/auth/users'), api('/auth/settings')]);
    const wrap = $('#admin-content');
    if (!wrap) return;

    wrap.innerHTML = `
      <div class="admin-block">
        <h3>Office location (for on-site detection)</h3>
        <p class="hint">Set your office's coordinates once – punches within the radius are marked 🟢 On-site, others 🟡 Remote.</p>
        <div class="admin-form-row">
          <input id="admin-lat" placeholder="Latitude" value="\${settings.office_lat || ''}">
          <input id="admin-lng" placeholder="Longitude" value="\${settings.office_lng || ''}">
          <input id="admin-radius" placeholder="Radius (meters)" value="\${settings.office_radius_m || '150'}">
          <button class="btn btn-primary" id="admin-settings-save">Save</button>
        </div>
      </div>

      <div class="admin-block">
        <h3>Remote attendance access</h3>
        <p class="hint">Recommended: use Tailscale Serve so employees use an HTTPS TaskFlow URL from anywhere.</p>
        <div class="hint"><b>On the TaskFlow server:</b> run <code>tailscale serve --bg 3000</code> and share the address with staff.</div>
      </div>

      <div class="admin-block">
        <h3>Team members <button class="btn btn-secondary" id="btn-my-password" style="float:right;">Change my password</button></h3>
        <div class="admin-form-row" style="margin-bottom: 20px;">
          <input id="u-name" placeholder="Full name">
          <input id="u-username" placeholder="Username">
          <input id="u-password" placeholder="Password" type="password">
          <select id="u-role">
            <option value="employee">Employee</option>
            <option value="admin">Admin</option>
          </select>
          <button class="btn btn-primary" id="u-add">Add person</button>
        </div>

        <table class="admin-table" style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="text-align:left; border-bottom:2px solid #ddd;">
              <th style="padding:8px;">Name</th>
              <th style="padding:8px;">Username</th>
              <th style="padding:8px;">Role</th>
              <th style="padding:8px;">Status</th>
              <th style="padding:8px;">Actions</th>
            </tr>
          </thead>
          <tbody id="admin-employees-table-body"></tbody>
        </table>
      </div>
    `;

    // Populate user listing dynamically into the container template body loop
    const tbody = $('#admin-employees-table-body');
    users.forEach((u) => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = "1px solid #eee";
      
      let actionsHtml = '';
      if (u.id !== ME.id) {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm" style="margin-right:4px;" onclick="adminChangePassword(\${u.id}, '\${escapeHtml(u.name)}')">Change Password</button>
          <button class="btn btn-danger btn-sm" onclick="adminRemoveUser(\${u.id}, '\${escapeHtml(u.name)}')">Remove</button>
        `;
      } else {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm" onclick="adminChangePassword(\${u.id}, '\${escapeHtml(u.name)}')">Change Password</button>
        `;
      }

      tr.innerHTML = `
        <td style="padding:8px;"><b>\${escapeHtml(u.name)}</b></td>
        <td style="padding:8px;">\${escapeHtml(u.username)}</td>
        <td style="padding:8px;"><span class="badge">\${escapeHtml(u.role)}</span></td>
        <td style="padding:8px;"><span class="badge">\${escapeHtml(u.status || 'Active')}</span></td>
        <td style="padding:8px;">\${actionsHtml}</td>
      `;
      tbody.appendChild(tr);
    });

    // Event hooks configuration assignments
    $('#admin-settings-save').onclick = async () => {
      const lat = parseFloat($('#admin-lat').value);
      const lng = parseFloat($('#admin-lng').value);
      const radius = parseInt($('#admin-radius').value);
      try {
        await api('/auth/settings', { method: 'POST', body: { office_lat: lat, office_lng: lng, office_radius_m: radius } });
        alert('Global tracking configurations locked.');
      } catch (err) { alert(err.message); }
    };

    $('#u-add').onclick = async () => {
      const name = $('#u-name').value.trim();
      const username = $('#u-username').value.trim();
      const password = $('#u-password').value.trim();
      const role = $('#u-role').value;

      if (!name || !username || !password) return alert('Please complete all form fields.');

      try {
        await api('/admin/users', { method: 'POST', body: { name, username, password, role } });
        alert('New profile added successfully!');
        PEOPLE = await api('/people'); // Re-sync local state lists
        renderAdmin(); 
      } catch (err) { alert(err.message); }
    };

    $('#btn-my-password').onclick = () => adminChangePassword(ME.id, ME.name);

  } catch (err) {
    console.error("Admin view loading failed:", err);
  }
}

// ---------- INTERACTIVE MODAL OVERLAY INJECTIONS ----------
async function adminChangePassword(userId, userName) {
  showModal(`
    <h3>Change Password for \${escapeHtml(userName)}</h3>
    <div style="margin: 15px 0;">
      <label style="display:block; margin-bottom:5px; font-weight:bold;">New Password</label>
      <input id="adm-new-pass" type="password" placeholder="Enter new password (min 4 characters)" autofocus style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
    </div>
    <div id="adm-pass-error" class="form-error" style="color:red; margin-bottom:10px; font-size:13px;"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="adm-pass-cancel">Cancel</button>
      <button class="btn btn-primary" id="adm-pass-save">Update Credentials</button>
    </div>
  `);

  $('#adm-pass-cancel').onclick = closeModal;
  
  $('#adm-pass-save').onclick = async () => {
    const password = $('#adm-new-pass').value.trim();
    const errorEl = $('#adm-pass-error');
    errorEl.textContent = '';

    if (!password || password.length < 4) {
      errorEl.textContent = 'Password must be at least 4 characters long.';
      return;
    }

    try {
      await api(`/admin/users/\${userId}/reset-password`, {
        method: 'PUT',
        body: { password }
      });
      closeModal();
      alert(`Password for \${userName} updated successfully!`);
      renderAdmin();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  };
}

async function adminRemoveUser(userId, userName) {
  const confirmed = await confirmModal(
    'Remove Employee?', 
    `Are you sure you want to permanently remove "\${userName}" from the team roster?`,
    'Remove User',
    true
  );
  
  if (!confirmed) return;

  try {
    await api(`/admin/users/\${userId}`, { method: 'DELETE' });
    alert('User account successfully dropped.');
    PEOPLE = await api('/people');
    renderAdmin();
  } catch (err) {
    alert(err.message);
  }
}
