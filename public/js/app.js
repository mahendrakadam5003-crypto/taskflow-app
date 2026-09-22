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
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
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
  const drawer = $('#task-drawer');
  if (drawer) drawer.classList.add('hidden');
  const app = $('#app');
  if (app) app.classList.remove('drawer-open');
}

function autoGrowDescription() {
  const description = $('#drawer-desc');
  if (!description) return;
  description.style.height = 'auto';
  description.style.height = `${Math.max(description.scrollHeight, 180)}px`;
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

// 🟢 CHANGE 1: Clear polling cleanly on session changes
function stopAttendancePolling() {
  if (attendancePollTimer) {
    clearInterval(attendancePollTimer);
    attendancePollTimer = null;
  }
}

// ---------- boot backend authentication initialization ----------
(async function init() {
  try {
    const rawMe = await api('/auth/me');
    // Unrolls any array wrappers returned from cloud proxies
    ME = Array.isArray(rawMe) ? rawMe[0] : rawMe;
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
      const rawLogin = await api('/auth/login', {
        method: 'POST',
        body: { username: userField.value.trim(), password: passField.value },
      });
      ME = Array.isArray(rawLogin) ? rawLogin[0] : rawLogin;
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
  const changePasswordButton = $('#btn-change-password');
  if (changePasswordButton) changePasswordButton.onclick = () => showSelfPasswordModal();
  
  const navAdmin = $('#nav-admin');
  if (ME.role === 'admin' && navAdmin) navAdmin.style.display = '';
  
  try {
    const rawPeople = ME.role === 'admin' ? await api('/auth/users') : [ME];
    PEOPLE = Array.isArray(rawPeople) ? rawPeople.flat(5) : [];
    
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
  ['attendance', 'reimbursements', 'admin', 'project', 'mytasks', 'empty'].forEach((v) => {
    const el = $('#view-' + v);
    if (el) el.classList.add('hidden');
  });
  closeDrawer();

  if (view !== 'attendance') stopAttendancePolling();

  if (view === 'attendance') {
    const viewAttendance = $('#view-attendance');
    if (viewAttendance) viewAttendance.classList.remove('hidden');
    renderPunchCard(); renderLiveList(); renderHistory();
    if (ME && ME.role === 'admin') renderAdminAttendance(PEOPLE, 'admin-attendance-monitor');
    startAttendancePolling();
  } else if (view === 'admin') {
    const viewAdmin = $('#view-admin');
    if (viewAdmin) viewAdmin.classList.remove('hidden');
    renderAdmin();
  } else if (view === 'reimbursements') {
    const viewReimbursements = $('#view-reimbursements');
    if (viewReimbursements) viewReimbursements.classList.remove('hidden');
    renderReimbursements();
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

async function renderReimbursements() {
  const wrap = $('#reimbursements-content');
  if (!wrap) return;
  const isAdmin = ME && ME.role === 'admin';
  const access = await api('/auth/reimbursement-access/me');
  const canReview = isAdmin || Number(access.approval_level) > 0;
  const canPay = isAdmin || Number(access.can_pay) === 1;
  const peopleOptions = PEOPLE.map(person => `<option value="${person.id}">${escapeHtml(person.name || person.NAME)}</option>`).join('');
  const categoryOptions = ['Travel', 'Fuel', 'Meals', 'Lodging', 'Supplies', 'Other'].map(category => `<option>${category}</option>`).join('');

  wrap.innerHTML = `
    <div class="project-header"><div><h1>Reimbursements</h1><div class="hint">Submit field expenses with receipts and track approval status.</div></div></div>
    ${!isAdmin ? `<div class="admin-block">
      <h3>Submit expense</h3>
      <form id="reimbursement-form" class="admin-form-row">
        <input id="reimbursement-amount" type="number" min="0.01" step="0.01" placeholder="Amount" required>
        <select id="reimbursement-currency"><option>INR</option><option>USD</option><option>EUR</option></select>
        <select id="reimbursement-category">${categoryOptions}</select>
        <input id="reimbursement-date" type="date" value="${todayISO()}" required>
        <input id="reimbursement-description" placeholder="Description" required>
        <input id="reimbursement-receipt" type="file" accept="image/*,.pdf">
        <button class="btn btn-primary" type="submit">Submit claim</button>
      </form>
      <div id="reimbursement-form-error" class="form-error"></div>
    </div>` : ''}
    <div class="admin-block">
      <h3>${canReview ? 'Expense approvals' : 'My expense claims'}</h3>
      ${canReview ? `<div class="attendance-filters">
        <label>Employee <select id="reimbursement-user"><option value="">All employees</option>${peopleOptions}</select></label>
        <label>Status <select id="reimbursement-status"><option value="">All statuses</option><option>submitted</option><option>approved_level_1</option><option>approved</option><option>rejected</option><option>paid</option></select></label>
        <button class="btn btn-primary" id="reimbursement-filter">Filter</button>
      </div>` : ''}
      <div class="task-table-wrap" style="overflow-x:auto; margin-top:14px;">
        <table class="attn-table" style="min-width:850px;"><thead><tr>
          ${canReview ? '<th>Employee</th><th>Department</th>' : ''}
          <th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Receipt</th><th>Status</th>${canReview ? '<th>Action</th>' : ''}
        </tr></thead><tbody id="reimbursements-table"></tbody></table>
      </div>
    </div>`;

  const table = $('#reimbursements-table');
  const renderRows = async () => {
    const params = new URLSearchParams();
    if (canReview && $('#reimbursement-user').value) params.set('user_id', $('#reimbursement-user').value);
    if (canReview && $('#reimbursement-status').value) params.set('status', $('#reimbursement-status').value);
    try {
      const rows = await api(`/reimbursements?${params.toString()}`);
      table.innerHTML = rows.length ? rows.map(row => `<tr>
        ${canReview ? `<td>${escapeHtml(row.user_name)}</td><td>${escapeHtml(row.department || '—')}</td>` : ''}
        <td>${escapeHtml(row.expense_date)}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.description)}</td>
        <td>${escapeHtml(row.currency)} ${Number(row.amount).toFixed(2)}</td>
        <td>${row.receipt_url ? `<a href="${row.receipt_url}" target="_blank">View receipt</a>` : (row.receipt_expired ? '<span class="hint">Attachment expired</span>' : '—')}</td>
        <td><span class="tag">${escapeHtml(row.status)}</span>${row.admin_note ? `<small class="hint">${escapeHtml(row.admin_note)}</small>` : ''}</td>
        ${canReview ? `<td>${(row.status === 'submitted' && (isAdmin || Number(access.approval_level) === 1)) || (row.status === 'approved_level_1' && (isAdmin || Number(access.approval_level) >= 2)) ? `<button class="btn btn-primary btn-sm reimbursement-action" data-id="${row.id}" data-status="approved">Approve</button> <button class="btn btn-danger btn-sm reimbursement-action" data-id="${row.id}" data-status="rejected">Reject</button>` : row.status === 'approved' && canPay ? `<button class="btn btn-secondary btn-sm reimbursement-action" data-id="${row.id}" data-status="paid">Mark paid</button>` : '—'}</td>` : ''}
      </tr>`).join('') : `<tr><td colspan="${isAdmin ? 9 : 7}" class="hint" style="text-align:center; padding:15px;">No reimbursement claims found.</td></tr>`;
      $$('.reimbursement-action').forEach(button => {
        button.onclick = async () => {
          const note = button.dataset.status === 'rejected' ? prompt('Reason for rejection (optional):') || '' : '';
          await api(`/reimbursements/${button.dataset.id}/status`, { method: 'PUT', body: { status: button.dataset.status, admin_note: note } });
          renderRows();
        };
      });
    } catch (err) {
      table.innerHTML = `<tr><td colspan="9" class="form-error">${escapeHtml(err.message)}</td></tr>`;
    }
  };

  if (!isAdmin) {
    $('#reimbursement-form').onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData();
      formData.append('amount', $('#reimbursement-amount').value);
      formData.append('currency', $('#reimbursement-currency').value);
      formData.append('category', $('#reimbursement-category').value);
      formData.append('expense_date', $('#reimbursement-date').value);
      formData.append('description', $('#reimbursement-description').value.trim());
      const receipt = $('#reimbursement-receipt').files[0];
      if (receipt) formData.append('receipt', receipt);
      const response = await fetch('/api/reimbursements', { method: 'POST', body: formData, credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) { $('#reimbursement-form-error').textContent = result.error || 'Unable to submit claim.'; return; }
      event.target.reset();
      $('#reimbursement-date').value = todayISO();
      renderRows();
    };
  } else if (canReview) {
    $('#reimbursement-filter').onclick = renderRows;
  }
  renderRows();
}

// ================= PROJECTS MODULE =================
async function loadProjects() {
  try {
    const rawProj = await api('/projects');
    PROJECTS = Array.isArray(rawProj) ? rawProj.flat(5) : [];
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
  setupTaskFilters();
  await renderTasks();
  const newTaskButton = $('#btn-new-task');
  if (newTaskButton) newTaskButton.onclick = () => showNewTaskDrawer();
  const manageMembersButton = $('#btn-manage-members');
  if (manageMembersButton) manageMembersButton.onclick = () => showMembersModal();
}

async function renderProjectMembersHint() {
  if (!CURRENT_PROJECT) return;
  try {
    const members = await api(`/projects/${CURRENT_PROJECT.id}/members`);
    const hint = $('#project-members-hint');
    if (hint) hint.textContent = `${members.length} member${members.length === 1 ? '' : 's'}`;
  } catch (err) { }
}

async function renderTaskAssigneeFilter(){
  if(!CURRENT_PROJECT) return;
  try {
    const members = await api(`/projects/${CURRENT_PROJECT.id}/members`);
    const assignee = $('#task-filter-assignee');
    const creator = $('#task-filter-created-by');
    if (assignee) assignee.innerHTML = '<option value="all">All assignees</option>' + members.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    if (creator) creator.innerHTML = '<option value="all">Anyone</option>' + PEOPLE.map(p => `<option value="${p.id}">${escapeHtml(p.name || p.NAME)}</option>`).join('');
  } catch (err) { }
}

function setupTaskFilters() {
  const panel = $('#task-filter-panel');
  if (!panel) return;
  $('#btn-task-filters').onclick = () => panel.classList.toggle('hidden');
  $('#btn-close-task-filters').onclick = () => panel.classList.add('hidden');
  $('#btn-apply-task-filters').onclick = () => { renderTasks(); panel.classList.add('hidden'); };
  $('#task-sort').onchange = () => renderTasks();
  let searchTimer = null;
  $('#task-search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderTasks, 250);
  };
  $('#btn-task-clear-filters').onclick = () => {
    $('#task-filter-status').value = 'open';
    $('#task-filter-assignee').value = 'all';
    $('#task-filter-created-by').value = 'all';
    ['task-filter-due', 'task-filter-created-on', 'task-filter-modified-on', 'task-filter-completed-on'].forEach(id => { $(`#${id}`).value = ''; });
    renderTasks();
  };
}

async function renderTasks() {
  if (!CURRENT_PROJECT) return;
  const list = $('#task-list');
  if (!list) return;
  try {
    const search = $('#task-search')?.value.trim() || '';
    const query = new URLSearchParams({
      status: search ? 'all' : ($('#task-filter-status')?.value || 'open'),
      assignee_id: $('#task-filter-assignee')?.value || 'all',
      created_by: $('#task-filter-created-by')?.value || 'all'
    });
    if (search) query.set('q', search);
    [['due_date', 'task-filter-due'], ['created_on', 'task-filter-created-on'], ['modified_on', 'task-filter-modified-on'], ['completed_on', 'task-filter-completed-on']].forEach(([key, id]) => {
      const value = $(`#${id}`)?.value;
      if (value) query.set(key, value);
    });
    let tasks = search
      ? await api(`/tasks/search?q=${encodeURIComponent(search)}`)
      : await api(`/projects/${CURRENT_PROJECT.id}/tasks?${query.toString()}`);
    const resultsHeading = $('#task-search-results-heading');
    if (resultsHeading) {
      resultsHeading.classList.toggle('hidden', !search);
      resultsHeading.innerHTML = search ? `Search results for “${escapeHtml(search)}” <span>${tasks.length} task${tasks.length === 1 ? '' : 's'} found</span>` : '';
    }
    const sort = $('#task-sort')?.value || 'manual';
    if (sort === 'assignee') tasks.sort((a, b) => (a.assignee_name || 'Unassigned').localeCompare(b.assignee_name || 'Unassigned'));
    if (sort === 'due') tasks.sort((a, b) => (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'));
    if (sort === 'created') tasks.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    list.innerHTML = tasks.length ? tasks.map(task => `
      <tr class="task-row ${search ? 'search-result ' : ''}${task.status === 'done' ? 'done' : ''}" data-task-id="${task.id}">
        <td><button class="row-complete" data-task-id="${task.id}" title="${task.status === 'done' ? 'Completed' : 'Complete task'}" ${task.status === 'done' ? 'disabled' : ''}>✓</button></td>
        <td class="task-title-cell"><b>${escapeHtml(task.title)}</b>${search && task.project_name ? `<div class="task-result-project">Project: ${escapeHtml(task.project_name)}</div>` : ''}</td>
        <td class="task-assignee-cell"><span class="assignee-chip">${escapeHtml(task.assignee_name || 'Unassigned')}</span></td>
        <td class="task-due-cell">${escapeHtml(task.due_date || '—')}</td>
        <td class="task-status-cell"><span class="task-status ${task.status === 'done' ? 'task-status-done' : 'task-status-open'}">${task.status === 'done' ? 'Completed' : 'Open'}</span></td>
      </tr>`).join('') : '<tr><td colspan="5" class="hint" style="padding:15px;">No open tasks yet.</td></tr>';
    $$('.row-complete:not(:disabled)').forEach(button => {
      button.onclick = async () => {
        await api(`/tasks/${button.dataset.taskId}`, { method: 'PUT', body: { status: 'done' } });
        renderTasks();
      };
    });
    $$('.task-row').forEach(row => {
      row.onclick = (event) => {
        if (event.target.closest('.row-complete')) return;
        openTaskDrawer(Number(row.dataset.taskId));
      };
    });
  } catch (err) {
    list.innerHTML = `<tr><td colspan="5" class="form-error">${escapeHtml(err.message)}</td></tr>`;
  }
}

async function showNewTaskDrawer() {
  if (!CURRENT_PROJECT) return;
  const drawer = $('#task-drawer');
  if (!drawer) return;
  const members = await api(`/projects/${CURRENT_PROJECT.id}/members`);
  const title = $('#drawer-title');
  const assignee = $('#drawer-assignee');
  const due = $('#drawer-due');
  const status = $('#drawer-status');
  const description = $('#drawer-desc');
  const created = $('#drawer-created');
  const saveButton = $('#btn-save-task');
  const completeButton = $('#btn-complete-task');
  const deleteButton = $('#btn-delete-task');
  if (title) title.value = '';
  if (assignee) assignee.innerHTML = '<option value="">No assignee</option>' + members.map(member => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join('');
  if (due) due.value = '';
  if (created) created.textContent = 'Created when saved';
  if (status) { status.value = 'open'; status.disabled = true; }
  if (description) description.value = '';
  if (description) {
    description.oninput = autoGrowDescription;
    autoGrowDescription();
  }
  if (saveButton) saveButton.style.display = 'none';
  if (completeButton) { completeButton.textContent = 'Create task'; completeButton.className = 'btn btn-primary btn-block'; completeButton.style.display = ''; }
  if (deleteButton) deleteButton.style.display = 'none';
  $('#drawer-subtasks').innerHTML = '';
  $('#drawer-comments').innerHTML = '<div class="hint">Comments will be available after the task is created.</div>';
  drawer.classList.remove('hidden');
  $('#app').classList.add('drawer-open');
  title?.focus();
  $('#drawer-close').onclick = closeDrawer;
  completeButton.onclick = async () => {
    if (!title.value.trim()) { title.focus(); return; }
    try {
      await api(`/projects/${CURRENT_PROJECT.id}/tasks`, { method: 'POST', body: {
        title: title.value.trim(),
        description: description.value.trim(),
        assignee_id: assignee.value || null,
        due_date: due.value || null
      }});
      closeDrawer();
      renderTasks();
    } catch (err) { alert(err.message); }
  };
}

async function openTaskDrawer(taskId) {
  const drawer = $('#task-drawer');
  if (!drawer) return;
  try {
    const task = await api(`/tasks/${taskId}`);
    const members = await api(`/projects/${task.project_id}/members`);
    $('#drawer-title').value = task.title || '';
    $('#drawer-assignee').innerHTML = '<option value="">No assignee</option>' + members.map(member => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join('');
    $('#drawer-assignee').value = task.assignee_id || '';
    $('#drawer-due').value = task.due_date || '';
    $('#drawer-created').textContent = fmtDateTime(task.created_at);
    $('#drawer-status').value = task.status || 'open';
    $('#drawer-status').disabled = false;
    $('#drawer-desc').value = task.description || '';
    $('#drawer-desc').oninput = autoGrowDescription;
    autoGrowDescription();
    $('#drawer-subtasks').innerHTML = (task.subtasks || []).map(item => `<label class="subtask-row"><input type="checkbox" class="subtask-check" data-subtask-id="${item.id}" ${item.done ? 'checked' : ''}><span class="subtask-title ${item.done ? 'done' : ''}">${escapeHtml(item.title)}</span><button class="subtask-del" data-subtask-id="${item.id}" title="Delete subtask">✕</button></label>`).join('') || '<div class="hint">No subtasks yet.</div>';
    $$('.subtask-check').forEach(input => {
      input.onchange = async () => {
        await api(`/subtasks/${input.dataset.subtaskId}`, { method: 'PUT', body: { done: input.checked } });
        openTaskDrawer(taskId);
      };
    });
    $$('.subtask-del').forEach(button => {
      button.onclick = async () => {
        await api(`/subtasks/${button.dataset.subtaskId}`, { method: 'DELETE' });
        openTaskDrawer(taskId);
      };
    });
    $('#drawer-comments').innerHTML = (task.comments || []).map(comment => `<div class="comment">
      <div class="comment-meta"><b>${escapeHtml(comment.user_name || 'User')}</b> · ${escapeHtml(fmtDateTime(comment.created_at))}</div>
      ${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}
      ${comment.image_path && comment.attachment_available ? `<a class="comment-attachment" href="${comment.image_path}" target="_blank" rel="noopener"><img class="comment-image" src="${comment.image_path}" alt="Comment attachment"><span>Open attachment</span></a>` : (comment.image_path ? '<span class="hint">Attachment expired</span>' : '')}
    </div>`).join('') || '<div class="hint">No comments yet.</div>';
    $('#comment-image-preview').innerHTML = '';
    $('#comment-image-preview').classList.add('hidden');
    $('#comment-file-input').value = '';
    $('#drawer-comment-input').value = '';
    $('#btn-save-task').style.display = '';
    $('#btn-save-task').className = 'btn btn-secondary btn-sm';
    $('#btn-complete-task').textContent = task.status === 'done' ? 'Completed' : '✓ Complete task';
    $('#btn-complete-task').disabled = task.status === 'done';
    $('#btn-complete-task').className = task.status === 'done' ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-block';
    $('#btn-delete-task').style.display = ME && ME.role === 'admin' ? '' : 'none';
    drawer.classList.remove('hidden');
    $('#app').classList.add('drawer-open');
    $('#drawer-close').onclick = closeDrawer;
    const saveChanges = async () => {
      const saveState = $('#drawer-save-state');
      if (saveState) { saveState.textContent = 'Saving...'; saveState.className = 'drawer-save-state'; }
      await api(`/tasks/${taskId}`, { method: 'PUT', body: {
        title: $('#drawer-title').value.trim(),
        description: $('#drawer-desc').value,
        assignee_id: $('#drawer-assignee').value || null,
        due_date: $('#drawer-due').value || null,
        status: $('#drawer-status').value
      }});
      if (saveState) { saveState.textContent = 'Saved'; saveState.className = 'drawer-save-state saved'; }
    };
    let autosaveTimer = null;
    const queueAutosave = () => {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => saveChanges().catch(err => {
        const saveState = $('#drawer-save-state');
        if (saveState) { saveState.textContent = 'Save failed'; saveState.className = 'drawer-save-state error'; }
        console.error('Task autosave failed:', err);
      }), 500);
    };
    $('#drawer-title').oninput = queueAutosave;
    $('#drawer-desc').oninput = queueAutosave;
    $('#drawer-assignee').onchange = queueAutosave;
    $('#drawer-due').onchange = queueAutosave;
    $('#drawer-status').onchange = queueAutosave;
    $('#btn-save-task').onclick = async () => {
      clearTimeout(autosaveTimer);
      await saveChanges();
    };
    $('#btn-complete-task').onclick = async () => {
      await api(`/tasks/${taskId}`, { method: 'PUT', body: { status: 'done' } });
      closeDrawer();
      renderTasks();
    };
    $('#btn-delete-task').onclick = async () => {
      if (!confirm('Delete this task permanently?')) return;
      await api(`/tasks/${taskId}`, { method: 'DELETE' });
      closeDrawer();
      renderTasks();
    };
    $('#btn-add-subtask').onclick = async () => {
      showModal(`
        <h3>Add subtask</h3>
        <input id="new-subtask-title" placeholder="Subtask name" autofocus>
        <div id="new-subtask-error" class="form-error"></div>
        <div class="modal-actions"><button class="btn btn-secondary" id="new-subtask-cancel">Cancel</button><button class="btn btn-primary" id="new-subtask-save">Add subtask</button></div>`);
      $('#new-subtask-cancel').onclick = closeModal;
      $('#new-subtask-save').onclick = async () => {
        const title = $('#new-subtask-title').value.trim();
        if (!title) { $('#new-subtask-error').textContent = 'Subtask name is required.'; return; }
        try {
          await api(`/tasks/${taskId}/subtasks`, { method: 'POST', body: { title } });
          closeModal();
          openTaskDrawer(taskId);
        } catch (err) { $('#new-subtask-error').textContent = err.message; }
      };
    };
    const commentInput = $('#drawer-comment-input');
    const fileInput = $('#comment-file-input');
    const filePreview = $('#comment-image-preview');
    $('#btn-attach-image').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      if (!file) { filePreview.classList.add('hidden'); return; }
      filePreview.innerHTML = `<span>${escapeHtml(file.name)}</span>`;
      filePreview.classList.remove('hidden');
    };
    $('#btn-add-comment').onclick = async () => {
      const formData = new FormData();
      formData.append('body', commentInput.value.trim());
      if (fileInput.files[0]) formData.append('attachment', fileInput.files[0]);
      const response = await fetch(`/api/tasks/${taskId}/comments`, { method: 'POST', body: formData, credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) { alert(result.error || 'Unable to post comment.'); return; }
      commentInput.value = '';
      fileInput.value = '';
      filePreview.innerHTML = '';
      filePreview.classList.add('hidden');
      await openTaskDrawer(taskId);
    };
  } catch (err) { alert(err.message); }
}

async function showNewTaskModal() {
  if (!CURRENT_PROJECT) return;
  const members = await api(`/projects/${CURRENT_PROJECT.id}/members`);
  showModal(`
    <h3>New task</h3>
    <input id="new-task-title" placeholder="Task title" autofocus>
    <textarea id="new-task-description" rows="3" placeholder="Description (optional)"></textarea>
    <select id="new-task-assignee"><option value="">Unassigned</option>${members.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}</select>
    <input id="new-task-due" type="date">
    <div id="new-task-error" class="form-error"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="new-task-cancel">Cancel</button><button class="btn btn-primary" id="new-task-save">Create task</button></div>`);
  $('#new-task-cancel').onclick = closeModal;
  $('#new-task-save').onclick = async () => {
    const title = $('#new-task-title').value.trim();
    if (!title) { $('#new-task-error').textContent = 'Task title is required.'; return; }
    try {
      await api(`/projects/${CURRENT_PROJECT.id}/tasks`, { method: 'POST', body: {
        title,
        description: $('#new-task-description').value.trim(),
        assignee_id: $('#new-task-assignee').value || null,
        due_date: $('#new-task-due').value || null
      }});
      closeModal();
      renderTasks();
    } catch (err) { $('#new-task-error').textContent = err.message; }
  };
}

async function showMembersModal() {
  if (!CURRENT_PROJECT) return;
  const [members, users] = await Promise.all([
    api(`/projects/${CURRENT_PROJECT.id}/members`),
    ME.role === 'admin' ? api('/auth/users') : Promise.resolve(PEOPLE)
  ]);
  const memberIds = new Set(members.map(member => Number(member.id)));
  showModal(`
    <h3>Project members</h3>
    <div class="member-list">${users.map(user => `<label class="member-option"><input type="checkbox" class="project-member-check" value="${user.id}" ${memberIds.has(Number(user.id)) ? 'checked' : ''}>${escapeHtml(user.name || user.NAME)}</label>`).join('')}</div>
    <div id="members-error" class="form-error"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="members-cancel">Cancel</button><button class="btn btn-primary" id="members-save">Save members</button></div>`);
  $('#members-cancel').onclick = closeModal;
  $('#members-save').onclick = async () => {
    try {
      const userIds = $$('.project-member-check:checked').map(input => Number(input.value));
      await api(`/projects/${CURRENT_PROJECT.id}/members`, { method: 'PUT', body: { user_ids: userIds } });
      closeModal();
      await renderProjectMembersHint();
      await renderTaskAssigneeFilter();
      renderTasks();
    } catch (err) { $('#members-error').textContent = err.message; }
  };
}
async function renderMyTasks() {
  const list = $('#my-task-list');
  if (!list) return;
  try {
    const tasks = await api('/my-tasks');
    list.innerHTML = tasks.length ? tasks.map(task => `
      <tr class="my-task-row" data-task-id="${task.id}">
        <td><button class="row-complete" data-task-id="${task.id}" title="Complete task">✓</button></td>
        <td><b>${escapeHtml(task.title)}</b></td>
        <td>${escapeHtml(task.project_name)}</td>
        <td>${escapeHtml(task.due_date || '—')}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="hint" style="padding:15px;">No open tasks assigned to you.</td></tr>';
    $$('.my-task-row .row-complete').forEach(button => {
      button.onclick = async (event) => {
        event.stopPropagation();
        await api(`/tasks/${button.dataset.taskId}`, { method: 'PUT', body: { status: 'done' } });
        renderMyTasks();
      };
    });
    $$('.my-task-row').forEach(row => {
      row.onclick = (event) => {
        if (!event.target.closest('.row-complete')) openTaskDrawer(Number(row.dataset.taskId));
      };
    });
  } catch (err) {
    list.innerHTML = `<tr><td colspan="4" class="form-error">${escapeHtml(err.message)}</td></tr>`;
  }
}

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
    const status = await api('/attendance/today');
    if (!status) {
      card.innerHTML = `<button class="btn btn-primary btn-lg" id="btn-punch-in" style="width:100%; padding:15px; font-size:18px;">📍 Punch In Field Shift</button>`;
      $('#btn-punch-in').onclick = async () => {
        try {
          const coords = await getLiveCoords();
          await api('/attendance/punch-in', { method: 'POST', body: coords });
          alert('Shift started safely! Location registered.');
          renderPunchCard(); renderLiveList(); renderHistory();
        } catch (err) { alert(err.message); }
      };
    } else if (!status.punch_in) {
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
    list.innerHTML = rows.map(r => `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding:10px;"><b>${escapeHtml(r.user_name || r.USER_NAME)}</b></td>
        <td style="padding:10px;">${fmtTime(r.punch_in || r.PUNCH_IN)}</td>
        <td style="padding:10px;"><a href="https://www.google.com/maps?q=${r.in_lat || r.IN_LAT},${r.in_lng || r.IN_LNG}" target="_blank" class="map-link" style="color:#007bff; text-decoration:none; font-weight:bold;">🗺️ View Live Site</a></td>
      </tr>
    `).join('');
  } catch (err) { console.error(err); }
}

async function renderHistory() {
  const table = $('#attendance-history-table');
  if (!table) return;
  try {
    const rawRows = await api('/attendance/mine');
    const rows = Array.isArray(rawRows) ? rawRows.flat(5) : [];
    if (!rows || !rows.length) {
      table.innerHTML = '<tr><td colspan="4" class="hint" style="text-align:center; padding:15px; color:#888;">No tracking history entries generated.</td></tr>';
      return;
    }
    table.innerHTML = rows.map(r => {
      const inLat = r.in_lat || r.IN_LAT;
      const inLng = r.in_lng || r.IN_LNG;
      const outLat = r.out_lat || r.OUT_LAT;
      const outLng = r.out_lng || r.OUT_LNG;
      
      const inMapUrl = inLat ? `https://www.google.com/maps?q=${inLat},${inLng}` : null;
      const outMapUrl = outLat ? `https://www.google.com/maps?q=${outLat},${outLng}` : null;
      return `
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding:10px;">${fmtDate(r.date || r.DATE)}</td>
        <td style="padding:10px; color:green;">${fmtTime(r.punch_in || r.PUNCH_IN) || '--'}</td>
        <td style="padding:10px; color:red;">${fmtTime(r.punch_out || r.PUNCH_OUT) || '--'}</td>
        <td style="padding:10px;">
          <small style="display:block; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#555;" title="${escapeHtml(r.location_status || r.LOCATION_STATUS || '')}">
            ${escapeHtml(r.location_status || r.LOCATION_STATUS || '')}
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
    const [users, settings, departments, reimbursementAccess] = await Promise.all([api('/auth/users'), api('/auth/settings'), api('/auth/departments'), api('/auth/reimbursement-access')]);
    const wrap = $('#admin-content');
    if (!wrap) return;
    const departmentOptions = departments.map(d => `<option value="${escapeHtml(d.name || d.NAME)}">${escapeHtml(d.name || d.NAME)}</option>`).join('');

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
        <h3>Departments</h3>
        <div class="admin-form-row">
          <input id="new-department-name" placeholder="Department name">
          <button class="btn btn-primary" id="btn-add-department">Create department</button>
        </div>
        <div id="department-list" class="member-list"></div>
      </div>

      <div class="admin-block">
        <h3>Reimbursement approval access</h3>
        <p class="hint">Level 1 approves first. Final approver + payer can approve the second stage and mark approved claims as paid.</p>
        <div id="reimbursement-access-list"></div>
      </div>

      <div class="admin-block">
        <h3>Team members <button class="btn btn-secondary" id="btn-my-password" style="float:right;">Change my password</button></h3>
        <div class="admin-form-row" style="margin-bottom: 20px;">
          <input id="u-name" placeholder="Full name">
          <input id="u-username" placeholder="Username">
          <select id="u-department"><option value="">No department</option>${departmentOptions}</select>
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
              <th style="padding:10px;">Department</th>
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
            <button class="btn btn-secondary btn-sm" onclick="adminChangePassword(${u.id}, '${escapeHtml(u.name)}')">Change Password</button>
          `;
        }

        tr.innerHTML = `
          <td style="padding:10px;"><b>${escapeHtml(u.name || u.NAME)}</b></td>
          <td style="padding:10px;">${escapeHtml(u.username || u.USERNAME)}</td>
          <td style="padding:10px;"><input class="admin-department" data-user-id="${u.id}" value="${escapeHtml(u.department || u.DEPARTMENT || '')}" placeholder="Department" style="width:120px; padding:5px;"><button class="btn btn-secondary btn-sm admin-save-department" data-user-id="${u.id}" style="margin-left:5px;">Save</button></td>
          <td style="padding:10px;"><span class="badge" style="background:#e3f2fd; color:#0d47a1; padding:4px 8px; border-radius:4px; font-size:12px;">${escapeHtml(u.role || u.ROLE)}</span></td>
          <td style="padding:10px;"><span class="badge" style="background:#c8e6c9; color:#25602a; padding:4px 8px; border-radius:4px; font-size:12px;">${u.active || u.ACTIVE ? 'Active' : 'Disabled'}</span></td>
          <td style="padding:10px;">${actionsHtml}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    const departmentList = $('#department-list');
    departments.forEach((department) => {
      const row = document.createElement('div');
      row.className = 'member-option';
      row.innerHTML = `<span style="flex:1;">${escapeHtml(department.name || department.NAME)}</span><button class="btn btn-danger btn-sm" data-delete-department="${department.id}">Delete</button>`;
      departmentList.appendChild(row);
    });

    const accessList = $('#reimbursement-access-list');
    reimbursementAccess.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'admin-form-row';
      row.innerHTML = `<b style="min-width:180px;">${escapeHtml(person.name)}</b>
        <select class="reimbursement-access-level" data-user-id="${person.user_id}">
          <option value="0" ${Number(person.approval_level) === 0 ? 'selected' : ''}>No access</option>
          <option value="1" ${Number(person.approval_level) === 1 ? 'selected' : ''}>Level 1 approver</option>
          <option value="2" ${Number(person.approval_level) === 2 ? 'selected' : ''}>Final approver + payer</option>
        </select>
        <button class="btn btn-secondary btn-sm save-reimbursement-access" data-user-id="${person.user_id}">Save</button>`;
      accessList.appendChild(row);
    });
    $$('.save-reimbursement-access').forEach((button) => {
      button.onclick = async () => {
        const select = document.querySelector(`.reimbursement-access-level[data-user-id="${button.dataset.userId}"]`);
        await api(`/auth/reimbursement-access/${button.dataset.userId}`, {
          method: 'PUT', body: { approval_level: Number(select.value), can_pay: select.value === '2' }
        });
        button.textContent = 'Saved';
        setTimeout(() => { button.textContent = 'Save'; }, 1200);
      };
    });

    $('#btn-add-department').onclick = async () => {
      const input = $('#new-department-name');
      const name = input.value.trim();
      if (!name) return;
      try {
        await api('/auth/departments', { method: 'POST', body: { name } });
        renderAdmin();
      } catch (err) { alert(err.message); }
    };

    $$('[data-delete-department]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm('Delete this department? Existing employee records will keep their current text.')) return;
        try {
          await api(`/auth/departments/${button.dataset.deleteDepartment}`, { method: 'DELETE' });
          renderAdmin();
        } catch (err) { alert(err.message); }
      };
    });

    $$('.admin-save-department').forEach((button) => {
      button.onclick = async () => {
        const input = document.querySelector(`.admin-department[data-user-id="${button.dataset.userId}"]`);
        try {
          await api(`/auth/users/${button.dataset.userId}`, { method: 'PUT', body: { department: input.value.trim() } });
          button.textContent = 'Saved';
          setTimeout(() => { button.textContent = 'Save'; }, 1200);
        } catch (err) { alert(err.message); }
      };
    });

    $('#admin-settings-save').onclick = async () => {
      const lat = parseFloat($('#admin-lat').value);
      const lng = parseFloat($('#admin-lng').value);
      const radius = parseInt($('#admin-radius').value);
      try {
        await api('/auth/settings', { method: 'PUT', body: { office_lat: lat, office_lng: lng, office_radius_m: radius } });
        alert('Tracking center settings saved successfully.');
      } catch (err) { alert(err.message); }
    };

    $('#u-add').onclick = async () => {
      const name = $('#u-name').value.trim();
      const username = $('#u-username').value.trim();
      const department = $('#u-department').value.trim();
      const password = $('#u-password').value.trim();
      const role = $('#u-role').value;

      if (!name || !username || !password) return alert('Please complete all form fields.');

      try {
        await api('/auth/users', { method: 'POST', body: { name, username, password, department, role } });
        alert('Employee profile generated successfully!');
        renderAdmin(); 
      } catch (err) { alert(err.message); }
    };

    $('#btn-my-password').onclick = () => adminChangePassword(ME.id, ME.name);

  } catch (err) {
    console.error("Failed loading administrative template layers:", err);
  }
}

async function renderAdminAttendance(users, targetId = 'admin-attendance-content') {
  const wrap = $(`#${targetId}`);
  if (!wrap) return;
  const today = todayISO();
  const employeeOptions = users.map(u => `<option value="${u.id}">${escapeHtml(u.name || u.NAME)}</option>`).join('');
  const departments = [...new Set(users.map(u => u.department || u.DEPARTMENT || '').filter(Boolean))].sort();
  const departmentOptions = departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

  wrap.innerHTML = `
    <div class="attendance-filters">
      <label>From <input type="date" id="admin-att-from" value="${today}"></label>
      <label>To <input type="date" id="admin-att-to" value="${today}"></label>
      <label>Employee <select id="admin-att-employee"><option value="">All employees</option>${employeeOptions}</select></label>
      <label>Department <select id="admin-att-department"><option value="">All departments</option>${departmentOptions}</select></label>
      <button class="btn btn-primary" id="admin-att-apply">Filter</button>
      <button class="btn btn-secondary" id="admin-att-export">Export CSV</button>
    </div>
    <div class="task-table-wrap" style="margin-top:14px; overflow-x:auto;">
      <table class="attn-table" style="min-width:980px;">
        <thead><tr><th>Employee</th><th>Department</th><th>Date</th><th>Punch in</th><th>Punch-in location</th><th>Punch out</th><th>Punch-out location</th><th>Action</th></tr></thead>
        <tbody id="admin-attendance-table"></tbody>
      </table>
    </div>`;

  const table = $('#admin-attendance-table');
  const renderRows = async () => {
    const from = $('#admin-att-from').value;
    const to = $('#admin-att-to').value;
    const userId = $('#admin-att-employee').value;
    const department = $('#admin-att-department').value;
    if (!from || !to || from > to) {
      table.innerHTML = '<tr><td colspan="8" class="form-error">Choose a valid date range.</td></tr>';
      return;
    }
    try {
      let rows;
      if (from === to) {
        rows = await api(`/attendance/overview?date=${encodeURIComponent(from)}${userId ? `&user_id=${encodeURIComponent(userId)}` : ''}${department ? `&department=${encodeURIComponent(department)}` : ''}`);
      } else {
        rows = await api(`/attendance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${userId ? `&user_id=${encodeURIComponent(userId)}` : ''}${department ? `&department=${encodeURIComponent(department)}` : ''}`);
      }
      if (!rows.length) {
        table.innerHTML = '<tr><td colspan="8" class="hint" style="text-align:center; padding:15px;">No attendance records found.</td></tr>';
        return;
      }
      table.innerHTML = rows.map(row => {
        const name = row.user_name || row.name || '—';
        const departmentName = row.department || '—';
        const isToday = from === to && from === today;
        const action = isToday ? (row.punch_in && !row.punch_out
          ? `<button class="btn btn-danger btn-sm admin-punch" data-action="out" data-user-id="${row.user_id}">Punch out</button>`
          : !row.punch_in ? `<button class="btn btn-primary btn-sm admin-punch" data-action="in" data-user-id="${row.user_id}">Punch in</button>` : '<span class="hint">Complete</span>') : '<span class="hint">—</span>';
        return `<tr>
          <td><b>${escapeHtml(name)}</b></td>
          <td>${escapeHtml(departmentName)}</td>
          <td>${escapeHtml(row.date || from)}</td>
          <td>${fmtTime(row.punch_in) || '--'}</td>
          <td>${escapeHtml(row.in_location_text || (row.punch_in ? 'Location unavailable' : '--'))}</td>
          <td>${fmtTime(row.punch_out) || '--'}</td>
          <td>${escapeHtml(row.out_location_text || (row.punch_out ? 'Location unavailable' : '--'))}</td>
          <td>${action}</td>
        </tr>`;
      }).join('');
      $$('.admin-punch').forEach(button => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            const coords = await getLiveCoords();
            await api(`/attendance/admin-punch-${button.dataset.action}`, {
              method: 'POST', body: { user_id: Number(button.dataset.userId), ...coords }
            });
            await renderRows();
          } catch (err) {
            alert(err.message);
            button.disabled = false;
          }
        };
      });
    } catch (err) {
      table.innerHTML = `<tr><td colspan="8" class="form-error">${escapeHtml(err.message)}</td></tr>`;
    }
  };

  $('#admin-att-apply').onclick = renderRows;
  $('#admin-att-export').onclick = () => {
    const query = new URLSearchParams({ from: $('#admin-att-from').value, to: $('#admin-att-to').value });
    if ($('#admin-att-employee').value) query.set('user_id', $('#admin-att-employee').value);
    if ($('#admin-att-department').value) query.set('department', $('#admin-att-department').value);
    window.open(`/api/attendance/export.csv?${query.toString()}`, '_blank');
  };
  renderRows();
}

// ================= MODAL DIALOG OPERATIONS CONTEXTS =================
function showSelfPasswordModal() {
  showModal(`
    <h3>Change password</h3>
    <input id="self-current-password" type="password" placeholder="Current password">
    <input id="self-new-password" type="password" placeholder="New password (minimum 6 characters)">
    <div id="self-password-error" class="form-error"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="self-password-cancel">Cancel</button><button class="btn btn-primary" id="self-password-save">Update password</button></div>`);
  $('#self-password-cancel').onclick = closeModal;
  $('#self-password-save').onclick = async () => {
    const error = $('#self-password-error');
    try {
      await api('/auth/change-password', { method: 'POST', body: {
        current_password: $('#self-current-password').value,
        new_password: $('#self-new-password').value
      }});
      closeModal();
      alert('Password updated successfully.');
    } catch (err) { error.textContent = err.message; }
  };
}

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

  $('#adm-pass-cancel').onclick = closeModal;
  
  $('#adm-pass-save').onclick = async () => {
    const password = $('#adm-new-pass').value.trim();
    const errorEl = $('#adm-pass-error');
    if (errorEl) errorEl.textContent = '';

    if (!password || password.length < 4) {
      if (errorEl) errorEl.textContent = 'Password must be at least 4 characters long.';
      return;
    }

    try {
      await api(`/auth/users/${userId}/reset-password`, {
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
    await api(`/auth/users/${userId}`, { method: 'DELETE' });
    alert('User dropped successfully from system registries.');
    renderAdmin();
  } catch (err) {
    alert(err.message);
  }
}
