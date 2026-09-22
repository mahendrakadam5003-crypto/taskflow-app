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
  const modalEl = $('#modal');
  const backdropEl = $('#modal-backdrop');
  if (modalEl && backdropEl) {
    modalEl.innerHTML = html;
    backdropEl.classList.remove('hidden');
  }
}
function closeModal() { 
  const modalEl = $('#modal');
  const backdropEl = $('#modal-backdrop');
  if (modalEl && backdropEl) {
    backdropEl.classList.add('hidden'); 
    modalEl.innerHTML = ''; 
  }
}

const backdrop = $('#modal-backdrop');
if (backdrop) {
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
}

function confirmModal(title, body, confirmLabel = 'Delete', danger = true) {
  return new Promise((resolve) => {
    showModal(`
      <h3>${title}</h3>
      <p class="hint">${body}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">${confirmLabel}</button>
      </div>`);
    const cancelBtn = $('#m-cancel');
    const okBtn = $('#m-ok');
    if (cancelBtn) cancelBtn.onclick = () => { closeModal(); resolve(false); };
    if (okBtn) okBtn.onclick = () => { closeModal(); resolve(true); };
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
let attendancePollTimer = null;

// ---------- live tracking data synchronization ----------
function startAttendancePolling() {
  stopAttendancePolling();
  attendancePollTimer = setInterval(() => {
    if (document.hidden) return; 
    renderLiveList();
    renderHistory();
    renderPunchCard();
  }, 15000); 
}

function stopAttendancePolling() {
  if (attendancePollTimer) {
    clearInterval(attendancePollTimer);
    attendancePollTimer = null;
  }
}

// ---------- boot backend authentication initialization ----------
(async function init() {
  try {
    ME = await api('/auth/me');
    enterApp();
  } catch (e) {
    const loginScreen = $('#login-screen');
    if (loginScreen) loginScreen.classList.remove('hidden');
  }
})();

const loginForm = $('#login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = $('#login-error');
    if (errorEl) errorEl.textContent = '';
    
    const userField = $('#login-username');
    const passField = $('#login-password');
    if (!userField || !passField) return;

    try {
      ME = await api('/auth/login', {
        method: 'POST',
        body: { username: userField.value.trim(), password: passField.value },
      });
      enterApp();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
    }
  });
}

const btnLogout = $('#btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    stopAttendancePolling();
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });
}

async function enterApp() {
  const loginScreen = $('#login-screen');
  if (loginScreen) loginScreen.classList.add('hidden');
  const appEl = $('#app');
  if (appEl) appEl.classList.remove('hidden');
  
  const meBadge = $('#me-badge');
  if (meBadge) meBadge.innerHTML = `Signed in as<br><b>${escapeHtml(ME.name)}</b>`;
  
  const navAdmin = $('#nav-admin');
  if (ME.role === 'admin' && navAdmin) navAdmin.style.display = '';
  
  try {
    PEOPLE = await api('/users'); 
    await loadProjects();
    showView('attendance');
  } catch (err) {
    console.error("App boot failure:", err);
  }
}

// ---------- navigation panels controller ----------
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

  if (view !== 'attendance') stopAttendancePolling();

  if (view === 'attendance') {
    const viewAttendance = $('#view-attendance');
    if (viewAttendance) viewAttendance.classList.remove('hidden');
    renderPunchCard(); renderLiveList(); renderHistory();
    startAttendancePolling();
  } else if (view === 'admin') {
    const viewAdmin = $('#view-admin');
    if (viewAdmin) viewAdmin.classList.remove('hidden');
    renderAdmin();
  } else if (view === 'mytasks') {
    const viewMyTasks = $('#view-mytasks');
    if (viewMyTasks) viewMyTasks.classList.remove('hidden');
    renderMyTasks();
  } else if (view === 'project') {
    const viewProject = $('#view-project');
    if (viewProject) viewProject.classList.remove('hidden');
  } else {
    const viewEmpty = $('#view-empty');
    if (viewEmpty) viewEmpty.classList.remove('hidden');
  }
}

// ================= PROJECTS MODULE =================
async function loadProjects() {
  try {
    PROJECTS = await api('/projects');
    renderProjectList();
  } catch (e) {
    PROJECTS = [];
  }
}

function renderProjectList() {
  const list = $('#project-list');
  if (!list) return;
  list.innerHTML = '';
  PROJECTS.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'project-item-row';
    row.innerHTML = `
      <button class="project-item" data-id="${p.id}">${p.locked ? '<span class="lock">🔒</span> ' : ''}${escapeHtml(p.name)}</button>
      ${ME.role === 'admin' ? `<button class="project-del" data-id="${p.id}" title="Delete project">✕</button>` : ''}`;
    list.appendChild(row);
  });
  $$('.project-item').forEach((btn) => btn.addEventListener('click', () => openProject(Number(btn.dataset.id))));
  $$('.project-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const p = PROJECTS.find((x) => x.id === Number(btn.dataset.id));
    const ok = await confirmModal('Delete project?', `"${escapeHtml(p.name)}" and all its tasks will be permanently deleted.`);
    if (!ok) return;
    await api(`/projects/${p.id}`, { method: 'DELETE' });
    if (CURRENT_PROJECT && CURRENT_PROJECT.id === p.id) showView('empty');
    await loadProjects();
  }));
}

const btnNewProject = $('#btn-new-project');
if (btnNewProject) {
  btnNewProject.addEventListener('click', () => {
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
}

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
        const pinErr = $('#pin-error');
        if (pinErr) pinErr.textContent = e.message;
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
  const pTitle = $('#project-title');
  if (pTitle) pTitle.textContent = project.name;
  await renderProjectMembersHint();
  await renderTaskAssigneeFilter();
  await renderTasks();
}

async function renderProjectMembersHint() { }

async function renderTaskAssigneeFilter(){
  if(!CURRENT_PROJECT) return;
  try {
    const members = await api(`/projects/${CURRENT_PROJECT.id}/members`);
    const sel = $('#task-assignee-filter'); if(!sel) return;
    const old = sel.value || 'all';
    sel.innerHTML = '<option value="all">All assignees</option>' + members.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === old) ? old : 'all';
  } catch (err) { }
}

async function renderTasks() { }
async function renderMyTasks() { }

// ================= FIELD ATTENDANCE GEO-TRACKING OPERATORS =================
function getLiveCoords() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation tracking is not supported by this device browser.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error('Location access denied. Please enable phone GPS location parameters.')),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function renderPunchCard() {
  const card = $('#punch-card-container');
  if (!card) return;
  try {
    const rawStatus = await api('/attendance/today');
    let status = rawStatus;
    while (Array.isArray(status) && status.length > 0) { status = status[0]; }
    
    if (!status || Array.isArray(status)) {
      card.innerHTML = `<button class="btn btn-primary btn-lg" id="btn-punch-in" style="width:100%; padding:15px; font-size:18px;">📍 Punch In Field Shift</button>`;
      $('#btn-punch-in').onclick = async () => {
        try {
          const coords = await getLiveCoords();
          await api('/attendance/punch-in', { method: 'POST', body: coords });
          alert('Shift started safely! Location registered.');
          renderPunchCard(); renderLiveList(); renderHistory();
        } catch (err) { alert(err.message); }
      };
    } else if (status.punch_in && !status.punch_out) {
      card.innerHTML = `
        <div class="status-alert" style="background:#e3f2fd; color:#0d47a1; padding:12px; border-radius:4px; margin-bottom:10px; font-weight:bold; text-align:center;">
          ⚡ On-Duty Since: ${fmtTime(status.punch_in)}
        </div>
        <button class="btn btn-danger btn-lg" id="btn-punch-out" style="width:100%; padding:15px; font-size:18px;">🏁 Punch Out Field Shift</button>`;
      $('#btn-punch-out').onclick = async () => {
        try {
          const coords = await getLiveCoords();
          await api('/attendance/punch-out', { method: 'POST', body: coords });
          alert('Shift ended successfully! Out-location registered.');
          renderPunchCard(); renderLiveList(); renderHistory();
        } catch (err) { alert(err.message); }
      };
    } else {
      card.innerHTML = `
        <div class="status-complete" style="background:#e8f5e9; color:#1b5e20; padding:15px; border-radius:4px; font-weight:bold; text-align:center;">
          ✅ Today's Shift Completed (${fmtTime(status.punch_in)} - ${fmtTime(status.punch_out)})
        </div>`;
    }
  } catch (err) {
    card.innerHTML = `<div class="form-error">Failed to sync tracker parameters: ${err.message}</div>`;
  }
}

async function renderLiveList() {
  const list = $('#live-attendance-list');
  if (!list) return;
  try {
    const rawRows = await api('/attendance/live');
    const rows = Array.isArray(rawRows) ? rawRows.flat(5) : [];
    if (!rows || !rows.length) {
      list.innerHTML = '<tr><td colspan="3" class="hint" style="text-align:center; padding:15px; color:#888;">No field technicians active right now.</td></tr>';
      return;
    }
    list.innerHTML = rows.map(r => {
      const uName = r.user_name || r.USER_NAME;
      const pIn = r.punch_in || r.PUNCH_IN;
      const lat = r.in_lat || r.IN_LAT;
      const lng = r.in_lng || r.IN_LNG;
      return `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding:10px;"><b>${escapeHtml(uName)}</b></td>
        <td style="padding:10px;">${fmtTime(pIn)}</td>
        <td style="padding:10px;"><a href="https://google.com{lat},${lng}" target="_blank" class="map-link" style="color:#007bff; text-decoration:none; font-weight:bold;">🗺️ View Live Site</a></td>
      </tr>`;
    }).join('');
  } catch (err) { console.error(err); }
}

async function renderHistory() {
  const table = $('#attendance-history-table');
  if (!table) return;
  try {
    const rawRows = await api('/attendance/mine');
    const rows = Array.isArray(rawRows) ? rawRows.flat(5) : [];
    if (!rows || !rows.length) {
      table.innerHTML = '<tr><td colspan="4" class="hint" style="text-align:center; padding:15px; color:#888;">No logging history entries generated in the last 30 days.</td></tr>';
      return;
    }
    table.innerHTML = rows.map(r => {
      const rDate = r.date || r.DATE;
      const pIn = r.punch_in || r.PUNCH_IN;
      const pOut = r.punch_out || r.PUNCH_OUT;
      const inLat = r.in_lat || r.IN_LAT;
      const inLng = r.in_lng || r.IN_LNG;
      const outLat = r.out_lat || r.OUT_LAT;
      const outLng = r.out_lng || r.OUT_LNG;
      const locStatus = r.location_status || r.LOCATION_STATUS || '';

      const inMapUrl = inLat ? `https://google.com{inLat},${inLng}` : null;
      const outMapUrl = outLat ? `https://google.com{outLat},${outLng}` : null;
      return `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding:10px;">${fmtDate(rDate)}</td>
        <td style="padding:10px; color:green;">${fmtTime(pIn) || '--'}</td>
        <td style="padding:10px; color:red;">${fmtTime(pOut) || '--'}</td>
        <td style="padding:10px;">
          <small style="display:block; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#555;" title="${escapeHtml(locStatus)}">
            ${escapeHtml(locStatus)}
          </small>
          <div class="row-actions" style="margin-top:6px;">
            ${inMapUrl ? `<a href="${inMapUrl}" target="_blank" style="font-size:12px; margin-right:12px; color:#007bff; text-decoration:none; font-weight:bold;">📍 In Pin</a>` : ''}
            ${outMapUrl ? `<a href="${outMapUrl}" target="_blank" style="font-size:12px; color:#007bff; text-decoration:none; font-weight:bold;">📍 Out Pin</a>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) { console.error(err); }
}

// ================= ADMINISTRATIVE CORE VIEW MODULE =================
async function renderAdmin() {
  try {
    const [users, settings] = await Promise.all([api('/admin/users'), api('/admin/settings')]);
    const wrap = $('#admin-content');
    if (!wrap) return;

    wrap.innerHTML = `
      <div class="admin-block">
        <h3>Office location (for on-site detection)</h3>
        <p class="hint">Set your office's coordinates once – punches within the radius are marked 🟢 On-site, others 🟡 Remote.</p>
        <div class="admin-form-row">
          <input id="admin-lat" placeholder="Latitude" value="${settings.office_lat || ''}">
          <input id="admin-lng" placeholder="Longitude" value="${settings.office_lng || ''}">
          <input id="admin-radius" placeholder="Radius (meters)" value="${settings.office_radius_m || '150'}">
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

        <table class="admin-table" style="width:100%; border-collapse:collapse; margin-top:15px;">
          <thead>
            <tr style="text-align:left; border-bottom:2px solid #ddd; background:#f8f9fa;">
              <th style="padding:10px;">Name</th>
              <th style="padding:10px;">Username</th>
              <th style="padding:10px;">Role</th>
              <th style="padding:10px;">Status</th>
              <th style="padding:10px;">Actions</th>
            </tr>
          </thead>
          <tbody id="admin-employees-table-body"></tbody>
        </table>
      </div>`;

    const tbody = $('#admin-employees-table-body');
    if (tbody && Array.isArray(users)) {
      users.forEach((u) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid #eee";
        
        let actionsHtml = '';
        if (u.id !== ME.id) {
          actionsHtml = `
            <button class="btn btn-secondary btn-sm" style="margin-right:6px;" onclick="adminChangePassword(${u.id}, '${escapeHtml(u.name)}')">Change Password</button>
            <button class="btn btn-danger btn-sm" onclick="adminRemoveUser(${u.id}, '${escapeHtml(u.name)}')">Remove</button>
          `;
        } else {
          actionsHtml = `
                      <button class="btn btn-danger btn-sm" onclick="adminRemoveUser(u.id, '{escapeHtml(u.name)}')">Remove</button>
        `;
      } else {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm" onclick="adminChangePassword(${u.id}, '${escapeHtml(u.name)}')">Change Password</button>
        `;
      }

      tr.innerHTML = `
        <td style="padding:10px;"><b>${escapeHtml(u.name)}</b></td>
        <td style="padding:10px;">${escapeHtml(u.username)}</td>
        <td style="padding:10px;"><span class="badge" style="background:#e0e0e0; padding:4px 8px; border-radius:4px; font-size:12px;">${escapeHtml(u.role)}</span></td>
        <td style="padding:10px;"><span class="badge" style="background:#c8e6c9; color:#25602a; padding:4px 8px; border-radius:4px; font-size:12px;">${u.active ? 'Active' : 'Disabled'}</span></td>
        <td style="padding:10px;">${actionsHtml}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  \$('#admin-settings-save').onclick = async () => {
    const lat = parseFloat(\$('#admin-lat').value);
    const lng = parseFloat(\$('#admin-lng').value);
    const radius = parseInt(\$('#admin-radius').value);
    try {
      await api('/admin/settings', { method: 'PUT', body: { office_lat: lat, office_lng: lng, office_radius_m: radius } });
      alert('Tracking center layout settings saved successfully.');
    } catch (err) { alert(err.message); }
  };

  \$('#u-add').onclick = async () => {
    const name = \$('#u-name').value.trim();
    const username = \$('#u-username').value.trim();
    const password = \$('#u-password').value.trim();
    const role = \$('#u-role').value;

    if (!name || !username || !password) return alert('Please complete all form blocks before submission.');

    try {
      await api('/admin/users', { method: 'POST', body: { name, username, password, role } });
      alert('Employee profile generated successfully!');
      renderAdmin(); 
    } catch (err) { alert(err.message); }
  };

  \$('#btn-my-password').onclick = () => adminChangePassword(ME.id, ME.name);

  } catch (err) {
    console.error("Failed loading administrative template layers:", err);
  }
}

// ================= MODAL DIALOG OPERATIONS CONTEXTS =================
async function adminChangePassword(userId, userName) {
  showModal(`
    <h3>Modify Credentials for ${escapeHtml(userName)}</h3>
    <div style="margin: 15px 0;">
      <label style="display:block; margin-bottom:5px; font-weight:bold;">New Password</label>
      <input id="adm-new-pass" type="password" placeholder="Enter new password (min 4 characters)" autofocus style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
    </div>
    <div id="adm-pass-error" class="form-error" style="color:red; margin-bottom:10px; font-size:13px;"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="adm-pass-cancel">Cancel</button>
      <button class="btn btn-primary" id="adm-pass-save">Update Password</button>
    </div>
  `);

  \$('#adm-pass-cancel').onclick = closeModal;
  
  \$('#adm-pass-save').onclick = async () => {
    const password = \$('#adm-new-pass').value.trim();
    const errorEl = \$('#adm-pass-error');
    if (errorEl) errorEl.textContent = '';

    if (!password || password.length < 4) {
      if (errorEl) errorEl.textContent = 'Password must be at least 4 characters long.';
      return;
    }

    try {
      await api(`/admin/users/${userId}/reset-password`, {
        method: 'PUT',
        body: { password }
      });
      closeModal();
      alert(`Password for ${userName} updated successfully!`);
      renderAdmin();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
    }
  };
}

async function adminRemoveUser(userId, userName) {
  const confirmed = await confirmModal(
    'Remove Employee?', 
    `Are you sure you want to permanently drop "${userName}" from the application system databases?`,
    'Remove User',
    true
  );
  
  if (!confirmed) return;

  try {
    await api(`/admin/users/${userId}`, { method: 'DELETE' });
    alert('User dropped successfully from system registries.');
    renderAdmin();
  } catch (err) {
    alert(err.message);
  }
}
