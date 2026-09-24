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
  if (res.status === 401 && path !== '/auth/login') {
    ME = null;
    $('#app')?.classList.add('hidden');
    $('#login-screen')?.classList.remove('hidden');
    const loginError = $('#login-error');
    if (loginError) loginError.textContent = 'Your session expired. Please sign in again.';
  }
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

function getDueState(dateValue) {
  if (!dateValue) return { className: '', label: '—' };
  const due = new Date(`${dateValue}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (due < today) return { className: 'due-overdue', label: `${dateValue} · overdue` };
  if (due.getTime() === tomorrow.getTime()) return { className: 'due-tomorrow', label: `${dateValue} · tomorrow` };
  return { className: 'due-upcoming', label: dateValue };
}

function showAppNotification(message) {
  const bar = $('#app-notification');
  if (!bar) return;
  bar.textContent = message;
  bar.classList.remove('hidden');
  setTimeout(() => bar.classList.add('hidden'), 5000);
}

function reloadWithActionMessage(view, message, projectId = null) {
  sessionStorage.setItem('taskflow_return_view', view);
  sessionStorage.setItem('taskflow_flash_message', message);
  if (projectId) sessionStorage.setItem('taskflow_return_project_id', String(projectId));
  else sessionStorage.removeItem('taskflow_return_project_id');
  window.location.reload();
}

function currentViewName() {
  const active = document.querySelector('.nav-item.active');
  return active?.dataset.view || 'attendance';
}

function markNotificationsAvailable() {
  const button = document.querySelector('[data-view="notifications"]');
  if (!button) return;
  if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
  button.textContent = '🔔 Notifications (new)';
}

async function refreshNotificationsAfterAction() {
  markNotificationsAvailable();
  await renderNotifications();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function attachmentTypeLabel(type, name) {
  const mime = String(type || '').toLowerCase();
  if (mime === 'application/pdf') return 'PDF document';
  if (mime.includes('spreadsheet') || /\.(xlsx?|csv)$/i.test(name || '')) return 'Spreadsheet';
  if (mime.includes('word') || /\.(docx?)$/i.test(name || '')) return 'Word document';
  if (mime.includes('presentation') || /\.(pptx?)$/i.test(name || '')) return 'Presentation';
  if (mime.startsWith('image/')) return mime;
  return mime || 'File';
}

function renderCommentAttachment(entry) {
  if (!entry.image_path || !entry.attachment_available) return entry.image_path ? '<span class="hint">Attachment expired</span>' : '';
  const name = entry.attachment_name || 'Telegram attachment';
  const type = attachmentTypeLabel(entry.attachment_type, name);
  if (String(entry.attachment_type || '').toLowerCase().startsWith('image/')) {
    return `<a class="comment-attachment" href="${entry.image_path}" target="_blank" rel="noopener"><img class="comment-image" src="${entry.image_path}" loading="lazy" decoding="async" alt="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></a>`;
  }
  return `<a class="comment-file-card" href="${entry.image_path}" target="_blank" rel="noopener"><span class="comment-file-icon">▦</span><span><b>${escapeHtml(name)}</b><small>${escapeHtml(type)} · Download</small></span></a>`;
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
  const reimbursementDrawer = $('#reimbursement-drawer');
  if (reimbursementDrawer) reimbursementDrawer.classList.add('hidden');
  const app = $('#app');
  if (app) app.classList.remove('drawer-open');
}

function openReimbursementDrawer(row) {
  const drawer = $('#reimbursement-drawer');
  if (!drawer) return;
  $('#reimbursement-drawer-title').textContent = `Reimbursement #${row.id}`;
  $('#reimbursement-detail-employee').textContent = row.user_name || '—';
  $('#reimbursement-detail-department').textContent = row.department || '—';
  $('#reimbursement-detail-submitted').textContent = fmtDateTime(row.created_at);
  $('#reimbursement-detail-expense-date').textContent = row.expense_date || '—';
  $('#reimbursement-detail-category').textContent = row.category || '—';
  $('#reimbursement-detail-amount').textContent = `${row.currency || ''} ${Number(row.amount || 0).toFixed(2)}`;
  $('#reimbursement-detail-description').textContent = row.description || '—';
  $('#reimbursement-detail-status').textContent = row.status || '—';
  $('#reimbursement-detail-note').textContent = row.admin_note || 'No note';
  const receiptItems = (row.receipt_items || []).filter(item => item.url);
  const imageReceiptItems = receiptItems.filter(item => String(item.mime_type || '').startsWith('image/'));
  $('#reimbursement-detail-receipt').innerHTML = receiptItems.length
    ? `<div class="receipt-gallery">${receiptItems.map((item, index) => `<div class="receipt-item"><div class="receipt-storage-label">${escapeHtml(item.storage || 'Stored attachment')}</div>${String(item.mime_type || '').startsWith('image/')
      ? `<button type="button" class="receipt-preview-button" data-receipt-index="${imageReceiptItems.indexOf(item)}" title="Open receipt"><img src="${item.url}" alt="${escapeHtml(item.original_name || `Receipt ${index + 1}`)}"></button>`
      : `<a class="receipt-document-link" href="${item.url}" target="_blank" rel="noopener">${escapeHtml(item.original_name || 'View receipt document')}</a>`}</div>`).join('')}</div>`
    : (row.receipt_expired ? '<span class="hint">Attachment expired</span>' : '<span class="hint">No receipt</span>');
  $$('.receipt-preview-button').forEach(button => {
    button.onclick = () => openReceiptPreview(imageReceiptItems.map(item => item.url), Number(button.dataset.receiptIndex));
  });
  drawer.classList.remove('hidden');
  $('#app').classList.add('drawer-open');
  $('#reimbursement-drawer-close').onclick = closeDrawer;
  $('#reimbursement-drawer-back').onclick = closeDrawer;
}

function openReceiptPreview(urls, initialIndex = 0) {
  if (!urls.length) return;
  let index = Math.max(0, Math.min(initialIndex, urls.length - 1));
  let scale = 1;
  const render = () => {
    showModal(`
      <div class="receipt-preview-modal">
        <div class="receipt-preview-toolbar">
          <span>Receipt ${index + 1} of ${urls.length}</span>
          <div>
            <button class="btn btn-secondary btn-sm" id="receipt-zoom-out" type="button">−</button>
            <button class="btn btn-secondary btn-sm" id="receipt-zoom-in" type="button">+</button>
            <button class="btn btn-secondary btn-sm" id="receipt-preview-close" type="button">Close</button>
          </div>
        </div>
        <div class="receipt-preview-stage"><img id="receipt-preview-image" src="${urls[index]}" alt="Receipt preview" style="transform:scale(${scale})"></div>
        ${urls.length > 1 ? `<div class="receipt-preview-navigation"><button class="btn btn-secondary btn-sm" id="receipt-prev" type="button" ${index === 0 ? 'disabled' : ''}>Previous</button><button class="btn btn-secondary btn-sm" id="receipt-next" type="button" ${index === urls.length - 1 ? 'disabled' : ''}>Next</button></div>` : ''}
      </div>`);
    $('#receipt-preview-close').onclick = closeModal;
    $('#receipt-zoom-out').onclick = () => { scale = Math.max(.5, scale - .25); render(); };
    $('#receipt-zoom-in').onclick = () => { scale = Math.min(3, scale + .25); render(); };
    $('#receipt-prev')?.addEventListener('click', () => { index -= 1; scale = 1; render(); });
    $('#receipt-next')?.addEventListener('click', () => { index += 1; scale = 1; render(); });
  };
  render();
}

function autoGrowDescription() {
  const description = $('#drawer-desc');
  if (!description) return;
  description.style.height = 'auto';
  description.style.height = `${Math.max(description.scrollHeight, 180)}px`;
}

function autoGrowComment() {
  const comment = $('#drawer-comment-input');
  if (!comment) return;
  comment.style.height = 'auto';
  comment.style.height = `${Math.min(comment.scrollHeight, 180)}px`;
  comment.style.overflowY = comment.scrollHeight > 180 ? 'auto' : 'hidden';
}

// ---------- state ----------
let ME = null;
let PROJECTS = [];
let PEOPLE = [];
let CURRENT_PROJECT = null;
let CURRENT_TASK_ID = null;
const unlockedProjects = new Set();
let attendancePollTimer = null;
let notificationsPollTimer = null;
let taskListPollTimer = null;
let taskListPollBusy = false;
let taskListVisibilityHandler = null;
let latestNotificationId = null;
let pendingSearchTaskId = null;
let liveTrackingTimer = null;
let liveTrackingBusy = false;

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

function stopLiveTracking() {
  if (liveTrackingTimer) {
    clearInterval(liveTrackingTimer);
    liveTrackingTimer = null;
  }
  liveTrackingBusy = false;
}

function startLiveTracking() {
  if (liveTrackingTimer || !isPhoneDevice()) return;
  liveTrackingTimer = setInterval(async () => {
    if (document.hidden || liveTrackingBusy) return;
    liveTrackingBusy = true;
    try {
      const coords = await getLiveCoords();
      await api('/attendance/location-update', { method: 'POST', body: coords });
    } catch (error) {
      if (/active shift|punched out/i.test(error.message)) stopLiveTracking();
      else console.warn('Live location update failed:', error.message);
    } finally {
      liveTrackingBusy = false;
    }
  }, 5 * 60 * 1000);
}

async function syncLiveTracking() {
  if (!isPhoneDevice()) return;
  try {
    const status = await api('/attendance/today');
    if (status?.punch_in && !status.punch_out) startLiveTracking();
    else stopLiveTracking();
  } catch (error) {
    console.warn('Live tracking status check failed:', error.message);
  }
}

function startNotificationsPolling() {
  stopNotificationsPolling();
  api('/auth/activity').then((entries) => {
    latestNotificationId = entries.length ? Math.max(...entries.map(entry => Number(entry.id) || 0)) : 0;
  }).catch(() => {});
  notificationsPollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const entries = await api('/auth/activity');
      const newestId = entries.length ? Math.max(...entries.map(entry => Number(entry.id) || 0)) : 0;
      if (latestNotificationId !== null && newestId > latestNotificationId) markNotificationsAvailable();
      latestNotificationId = Math.max(latestNotificationId || 0, newestId);
    } catch (error) {
      // Notifications are supplementary and should not interrupt the current screen.
    }
  }, 10000);
}

function stopNotificationsPolling() {
  if (notificationsPollTimer) {
    clearInterval(notificationsPollTimer);
    notificationsPollTimer = null;
  }
}

function startTaskListPolling() {
  stopTaskListPolling();
  const refreshVisibleTaskList = async () => {
    if (document.hidden) return;
    if (taskListPollBusy) return;
    taskListPollBusy = true;
    const activeView = currentViewName();
    try {
      if (activeView === 'mytasks') await renderMyTasks();
      else if (CURRENT_PROJECT && document.querySelector('#view-project:not(.hidden)')) await renderTasks();
    } catch (error) {
      console.warn('Task list refresh failed:', error.message);
    } finally {
      taskListPollBusy = false;
    }
  };
  taskListPollTimer = setInterval(refreshVisibleTaskList, 5000);
  refreshVisibleTaskList();
  taskListVisibilityHandler = refreshVisibleTaskList;
  document.addEventListener('visibilitychange', taskListVisibilityHandler);
}

function stopTaskListPolling() {
  if (taskListPollTimer) {
    clearInterval(taskListPollTimer);
    taskListPollTimer = null;
  }
  if (taskListVisibilityHandler) {
    document.removeEventListener('visibilitychange', taskListVisibilityHandler);
    taskListVisibilityHandler = null;
  }
  taskListPollBusy = false;
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
    stopLiveTracking();
    stopNotificationsPolling();
    stopTaskListPolling();
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });
}

const mobileNavButton = $('#btn-mobile-nav');
const mobileNavBackdrop = $('#mobile-nav-backdrop');
const mobilePageTitle = $('#mobile-page-title');
function closeMobileNav() {
  $('#app')?.classList.remove('mobile-nav-open');
  mobileNavBackdrop?.classList.add('hidden');
}
if (mobileNavButton) mobileNavButton.onclick = () => {
  $('#app')?.classList.add('mobile-nav-open');
  mobileNavBackdrop?.classList.remove('hidden');
};
if (mobileNavBackdrop) mobileNavBackdrop.onclick = closeMobileNav;
const mobileViewTitles = { dashboard: 'TaskFlow', projects: 'Projects', attendance: 'Attendance', reimbursements: 'Reimbursements', mytasks: 'My Tasks', notifications: 'Notifications', admin: 'Admin', tracking: 'Tracking', project: 'Project' };
const mobileBackButton = $('#btn-mobile-back');
const dashboardLogoutButton = $('#dashboard-logout-btn');
if (mobileBackButton) {
  mobileBackButton.onclick = () => { closeDrawer(); showView('dashboard'); };
}
if (dashboardLogoutButton) {
  dashboardLogoutButton.addEventListener('click', async () => {
    stopAttendancePolling();
    stopLiveTracking();
    stopNotificationsPolling();
    stopTaskListPolling();
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });
}

function updateDashboardGreeting() {
  const greetingText = $('#dashboard-greeting-text');
  const dateText = $('#dashboard-date-text');
  if (!greetingText || !dateText) return;

  const hour = new Date().getHours();
  let greeting = 'Good evening';
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';

  const name = ME?.name || 'there';
  greetingText.textContent = `${greeting}, ${name}`;
  dateText.textContent = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date());
}

function formatStorageDisplay(gb, bytes) {
  if (bytes > 0 && gb < 0.01) return `${(bytes / (1024 ** 2)).toFixed(2)} MB`;
  return `${gb} GB`;
}

function showStorageDetails(storage) {
  if (!storage) return;
  const storageAvailable = storage.available !== false;
  showModal(`
    <h3>Storage usage</h3>
    <div class="storage-detail-grid">
      <div><small>Used</small><b>${storageAvailable ? formatStorageDisplay(storage.used_gb, storage.used_bytes) : 'Unavailable'}</b></div>
      <div><small>Remaining</small><b>${storageAvailable ? formatStorageDisplay(storage.free_gb, storage.free_bytes) : 'Unavailable'}</b></div>
      <div><small>Total</small><b>${storageAvailable ? `${storage.total_gb} GB` : 'Unavailable'}</b></div>
      <div><small>Usage</small><b>${storageAvailable ? `${storage.percent_used}%` : 'Unavailable'}</b></div>
    </div>
    <div class="dashboard-progress"><span style="width:${storageAvailable ? Math.min(100, Math.max(0, storage.percent_used)) : 0}%"></span></div>
    <p class="hint">Source: ${storage.source === 'turso' ? 'Turso database' : 'App server disk'}</p>
    <div class="modal-actions"><button class="btn btn-primary" id="storage-details-close">Close</button></div>`);
  $('#storage-details-close')?.addEventListener('click', closeModal);
}

async function renderDashboard() {
  updateDashboardGreeting();
  const adminCard = $('#dashboard-admin-card');
  if (adminCard) adminCard.style.display = ME?.role === 'admin' ? '' : 'none';
  const trackingCard = $('#dashboard-tracking-card');
  let trackingAllowed = ME?.role === 'admin';
  try { trackingAllowed = trackingAllowed || (await api('/attendance/tracking-access/me')).allowed; } catch (error) { trackingAllowed = false; }
  if (trackingCard) trackingCard.style.display = trackingAllowed ? '' : 'none';
  const storageCard = $('#dashboard-storage-card');
  if (storageCard) storageCard.style.display = ME?.role === 'admin' ? '' : 'none';
  $$('.dashboard-card[data-dashboard-view]').forEach(card => { card.onclick = () => showView(card.dataset.dashboardView); });
  try {
    const summary = await api('/dashboard/summary');
    const summaryPanel = $('#dashboard-summary');
    if (summaryPanel) {
      const storageMetric = ME?.role === 'admin' && summary?.storage ? `
        <div class="dashboard-metric storage">
          <small>Storage used</small>
          <b>${summary.storage.available === false ? 'Unavailable' : `${summary.storage.percent_used}%`}</b>
          <div class="dashboard-progress"><span style="width:${summary.storage.available === false ? 0 : Math.min(100, Math.max(0, summary.storage.percent_used))}%"></span></div>
          <small>${summary.storage.available === false ? 'Turso did not provide a storage limit' : `${formatStorageDisplay(summary.storage.used_gb, summary.storage.used_bytes)} used · ${formatStorageDisplay(summary.storage.free_gb, summary.storage.free_bytes)} left`}</small>
          <small>${summary.storage.available === false ? 'Check your Turso plan quota' : `${summary.storage.total_gb} GB total`}</small>
        </div>` : '';

      summaryPanel.innerHTML = `
        <div class="dashboard-metric"><small>Open tasks</small><b>${summary.open_tasks}</b></div>
        <div class="dashboard-metric alert"><small>Overdue tasks</small><b>${summary.overdue_tasks}</b></div>
        <div class="dashboard-metric money"><small>Pending reimbursements</small><b>${summary.pending_reimbursements} · INR ${Number(summary.pending_reimbursement_amount).toFixed(2)}</b></div>
        ${storageMetric}`;
    }
    if (storageCard && ME?.role === 'admin' && summary?.storage) {
      storageCard.onclick = () => showStorageDetails(summary.storage);
      storageCard.setAttribute('role', 'button');
      storageCard.setAttribute('tabindex', '0');
      storageCard.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          showStorageDetails(summary.storage);
        }
      };
    }
    const projectSummary = new Map((summary.projects || []).map(project => [Number(project.id), project]));
    const projects = $('#dashboard-projects');
    if (projects) {
      projects.innerHTML = PROJECTS.length ? PROJECTS.map(project => {
        const stats = projectSummary.get(Number(project.id)) || { open_tasks: 0, overdue_tasks: 0 };
        return `<button class="dashboard-project" data-dashboard-project="${project.id}"><b>${project.locked ? '🔒 ' : ''}${escapeHtml(project.name)}</b><span>${stats.open_tasks} open task${stats.open_tasks === 1 ? '' : 's'} · ${stats.overdue_tasks} overdue</span></button>`;
      }).join('') : '<div class="hint">No projects yet.</div>';
      $$('.dashboard-project').forEach(button => button.onclick = () => openProject(Number(button.dataset.dashboardProject)));
    }
  } catch (error) {
    const summaryPanel = $('#dashboard-summary');
    if (summaryPanel) summaryPanel.innerHTML = '<div class="hint">Dashboard metrics are temporarily unavailable.</div>';
  }
}

function renderProjectsDirectory() {
  const directory = $('#projects-directory');
  if (!directory) return;
  directory.innerHTML = PROJECTS.length ? PROJECTS.map(project => `<button class="dashboard-project projects-directory-card" data-directory-project="${project.id}"><b>${project.locked ? '🔒 ' : ''}${escapeHtml(project.name)}</b><span>Open project workspace</span></button>`).join('') : '<div class="hint">No projects yet.</div>';
  $$('.dashboard-project[data-directory-project]').forEach(button => button.onclick = () => openProject(Number(button.dataset.directoryProject)));
  const newProject = $('#projects-new-project');
  if (newProject) newProject.onclick = () => document.querySelector('#btn-new-project')?.click();
}

async function enterApp() {
  const loginScreen = $('#login-screen');
  if (loginScreen) loginScreen.classList.add('hidden');
  const appEl = $('#app');
  if (appEl) {
    appEl.classList.remove('hidden');
    appEl.classList.add('booting');
  }
  
  const meBadge = $('#me-badge');
  if (meBadge) meBadge.innerHTML = `Signed in as<br><b>${escapeHtml(ME.name)}</b>`;
  const changePasswordButton = $('#btn-change-password');
  if (changePasswordButton) changePasswordButton.onclick = () => showSelfPasswordModal();
  
  const navAdmin = $('#nav-admin');
  if (ME.role === 'admin' && navAdmin) navAdmin.style.display = '';
  
  try {
    const rawPeople = await api('/auth/users/directory');
    PEOPLE = Array.isArray(rawPeople) ? rawPeople.flat(5) : [];
    
    await loadProjects();
    await renderDashboard();
    syncLiveTracking();
    startNotificationsPolling();
    const returnView = sessionStorage.getItem('taskflow_return_view') || sessionStorage.getItem('taskflow_last_view') || 'dashboard';
    const returnProjectId = sessionStorage.getItem('taskflow_return_project_id') || sessionStorage.getItem('taskflow_last_project_id');
    const flashMessage = sessionStorage.getItem('taskflow_flash_message');
    sessionStorage.removeItem('taskflow_return_view');
    sessionStorage.removeItem('taskflow_return_project_id');
    sessionStorage.removeItem('taskflow_flash_message');
    if (returnView === 'project' && returnProjectId) {
      await openProject(Number(returnProjectId));
    } else {
      showView(returnView);
    }
    appEl?.classList.remove('booting');
    if (flashMessage) showAppNotification(flashMessage);
  } catch (err) {
    console.error('App boot failure:', err);
    appEl?.classList.remove('booting');
    appEl?.classList.add('hidden');
    loginScreen?.classList.remove('hidden');
    const loginError = $('#login-error');
    if (loginError) loginError.textContent = `Unable to start the app: ${err.message}`;
  }
}

// ---------- navigation panels controller ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => { closeMobileNav(); showView(btn.dataset.view); });
});

function showView(view) {
  if (mobilePageTitle) mobilePageTitle.textContent = view === 'dashboard' ? 'TaskFlow' : (mobileViewTitles[view] || 'TaskFlow');
  const compactSidebarViews = new Set(['dashboard', 'attendance', 'reimbursements', 'mytasks', 'notifications', 'admin', 'tracking']);
  const projectSidebarViews = new Set(['projects', 'project']);
  $('#app')?.classList.toggle('focused-view', compactSidebarViews.has(view));
  $('#app')?.classList.toggle('project-shell', projectSidebarViews.has(view));
  if (mobileBackButton) mobileBackButton.style.display = view === 'dashboard' ? 'none' : '';
  if (dashboardLogoutButton) dashboardLogoutButton.style.display = view === 'dashboard' ? '' : 'none';
  const sidebarLogout = $('#btn-logout');
  if (sidebarLogout) sidebarLogout.style.display = view === 'dashboard' ? 'none' : 'none';
  const sidebarBottom = $('#sidebar-bottom');
  if (sidebarBottom) sidebarBottom.style.display = view === 'dashboard' ? '' : 'none';
  const mainNavSection = $('#main-nav-section');
  if (mainNavSection) mainNavSection.style.display = projectSidebarViews.has(view) ? 'none' : '';
  const projectSwitcherBar = $('#project-switcher-bar');
  if (projectSwitcherBar) projectSwitcherBar.style.display = view === 'project' ? 'none' : '';
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.project-item').forEach((b) => b.classList.remove('active'));
  sessionStorage.setItem('taskflow_last_view', view);
  if (view === 'project' && CURRENT_PROJECT) sessionStorage.setItem('taskflow_last_project_id', String(CURRENT_PROJECT.id));
  ['dashboard', 'projects', 'attendance', 'reimbursements', 'admin', 'tracking', 'project', 'mytasks', 'notifications', 'empty'].forEach((v) => {
    const el = $('#view-' + v);
    if (el) el.classList.add('hidden');
  });
  closeDrawer();

  if (view !== 'attendance') stopAttendancePolling();
  if (view === 'project' || view === 'mytasks') startTaskListPolling();
  else stopTaskListPolling();

  if (view === 'dashboard') {
    const viewDashboard = $('#view-dashboard');
    if (viewDashboard) viewDashboard.classList.remove('hidden');
    renderDashboard();
  } else if (view === 'projects') {
    const viewProjects = $('#view-projects');
    if (viewProjects) viewProjects.classList.remove('hidden');
    renderProjectsDirectory();
  } else if (view === 'attendance') {
    const viewAttendance = $('#view-attendance');
    if (viewAttendance) viewAttendance.classList.remove('hidden');
    renderPunchCard(); renderLiveList(); renderHistory();
    if (ME && ME.role === 'admin') renderAdminAttendance(PEOPLE, 'admin-attendance-monitor');
    startAttendancePolling();
  } else if (view === 'admin') {
    const viewAdmin = $('#view-admin');
    if (viewAdmin) viewAdmin.classList.remove('hidden');
    renderAdmin();
  } else if (view === 'tracking') {
    const trackingView = $('#view-tracking');
    if (trackingView) trackingView.classList.remove('hidden');
    renderTracking();
  } else if (view === 'reimbursements') {
    const viewReimbursements = $('#view-reimbursements');
    if (viewReimbursements) viewReimbursements.classList.remove('hidden');
    renderReimbursements();
  } else if (view === 'mytasks') {
    const viewMyTasks = $('#view-mytasks');
    if (viewMyTasks) viewMyTasks.classList.remove('hidden');
    renderMyTasks();
  } else if (view === 'notifications') {
    const viewNotifications = $('#view-notifications');
    if (viewNotifications) viewNotifications.classList.remove('hidden');
    const notificationButton = document.querySelector('[data-view="notifications"]');
    if (notificationButton && notificationButton.dataset.originalLabel) notificationButton.textContent = notificationButton.dataset.originalLabel;
    renderNotifications();
  } else if (view === 'project') {
    const viewProject = $('#view-project');
    if (viewProject) viewProject.classList.remove('hidden');
  } else {
    const viewEmpty = $('#view-empty');
    if (viewEmpty) viewEmpty.classList.remove('hidden');
  }
}

async function renderNotifications() {
  const list = $('#notifications-list');
  if (!list) return;
  try {
    const activity = await api('/auth/activity');
    if (!activity.length) {
      list.innerHTML = '<p class="hint">No notifications yet.</p>';
      return;
    }
    list.innerHTML = activity.map((entry) => `
      <div style="padding:12px 0; border-bottom:1px solid #eee;">
        <b>${escapeHtml(entry.action)}</b>
        <span class="hint"> by ${escapeHtml(entry.actor_name || 'Unknown user')} on ${escapeHtml(fmtDateTime(entry.created_at))}</span>
        ${entry.details ? `<div>${escapeHtml(entry.details)}</div>` : ''}
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
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
  let allEmployeeRows = [];

  wrap.innerHTML = `
    <div class="project-header"><div><h1>Reimbursements</h1><div class="hint">Submit field expenses with receipts and track approval status.</div></div></div>
    ${!isAdmin ? `<div class="admin-block">
      <div id="employee-reimbursement-overview">
        <div class="reimbursement-summary">
          <div class="reimbursement-summary-card"><span>Total claims</span><b id="reimbursement-total-amount">INR 0.00</b><small id="reimbursement-total-count">0 claims</small></div>
          <div class="reimbursement-summary-card"><span>Pending</span><b class="pending" id="reimbursement-pending-amount">INR 0.00</b></div>
          <div class="reimbursement-summary-card"><span>Approved</span><b class="approved" id="reimbursement-approved-amount">INR 0.00</b></div>
        </div>
        <div class="reimbursement-section-heading"><h3>Recent expenses</h3><button class="btn btn-primary" id="reimbursement-new-expense" type="button">+ New expense</button></div>
      </div>
      <div id="employee-reimbursement-form" class="hidden">
        <div class="reimbursement-section-heading"><h3>Submit expense</h3><button class="btn btn-secondary" id="reimbursement-cancel-new" type="button">Back to expenses</button></div>
      <form id="reimbursement-form" class="admin-form-row">
        <input id="reimbursement-amount" type="number" min="0.01" step="0.01" placeholder="Amount" required>
        <select id="reimbursement-currency"><option>INR</option><option>USD</option><option>EUR</option></select>
        <select id="reimbursement-category">${categoryOptions}</select>
        <input id="reimbursement-date" type="date" value="${todayISO()}" required>
        <input id="reimbursement-description" placeholder="Description" required>
        <input id="reimbursement-receipt" type="file" accept="image/*,.pdf" multiple aria-label="Choose receipt photos or files">
        <button class="btn btn-primary" type="submit">Submit claim</button>
      </form>
      <div id="reimbursement-form-error" class="form-error"></div>
      <div id="reimbursement-form-success" style="color:#25602a; font-size:13px; min-height:16px;"></div>
      </div>
    </div>` : ''}
    <div class="admin-block">
      <h3>${canReview ? 'Expense approvals' : 'My expense claims'}</h3>
      <div class="attendance-filters">
        ${canReview ? `<label>Employee <select id="reimbursement-user"><option value="">All employees</option>${peopleOptions}</select></label>
        <label>Status <select id="reimbursement-status"><option value="">All statuses</option><option>submitted</option><option>approved_level_1</option><option>approved</option><option>rejected</option><option>paid</option></select></label>` : ''}
        <label>From <input type="date" id="reimbursement-from"></label>
        <label>To <input type="date" id="reimbursement-to"></label>
        <button class="btn btn-primary" id="reimbursement-filter">Filter</button>
        <button class="btn btn-secondary" id="reimbursement-export">Export CSV</button>
        ${canReview ? '<button class="btn btn-primary" id="reimbursement-bulk-approve" style="display:none;">Approve selected</button>' : ''}
      </div>
      <div class="task-table-wrap" style="overflow-x:auto; margin-top:14px;">
        <table class="attn-table" style="min-width:850px;"><thead><tr>
          ${canReview ? '<th><input type="checkbox" id="reimbursement-select-all" title="Select approvable expenses"></th>' : ''}
          ${canReview ? '<th>Employee</th><th>Department</th>' : ''}
          <th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Receipt</th><th>Status</th>${canReview ? '<th>Action</th>' : ''}
        </tr></thead><tbody id="reimbursements-table"></tbody></table>
      </div>
    </div>`;

  const table = $('#reimbursements-table');
  const renderEmployeeSummary = () => {
    if (isAdmin) return;
    const total = allEmployeeRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const pending = allEmployeeRows.filter(row => ['submitted', 'approved_level_1'].includes(row.status)).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const approved = allEmployeeRows.filter(row => ['approved', 'paid'].includes(row.status)).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    $('#reimbursement-total-amount').textContent = `INR ${total.toFixed(2)}`;
    $('#reimbursement-total-count').textContent = `${allEmployeeRows.length} claim${allEmployeeRows.length === 1 ? '' : 's'}`;
    $('#reimbursement-pending-amount').textContent = `INR ${pending.toFixed(2)}`;
    $('#reimbursement-approved-amount').textContent = `INR ${approved.toFixed(2)}`;
  };
  const refreshEmployeeSummary = async () => {
    if (isAdmin) return;
    allEmployeeRows = await api('/reimbursements');
    renderEmployeeSummary();
  };
  const renderRows = async () => {
    const params = new URLSearchParams();
    if (canReview && $('#reimbursement-user')?.value) params.set('user_id', $('#reimbursement-user').value);
    if (canReview && $('#reimbursement-status')?.value) params.set('status', $('#reimbursement-status').value);
    if ($('#reimbursement-from')?.value) params.set('from', $('#reimbursement-from').value);
    if ($('#reimbursement-to')?.value) params.set('to', $('#reimbursement-to').value);
    try {
      const rows = await api(`/reimbursements?${params.toString()}`);
      table.innerHTML = rows.length ? rows.map(row => {
        const canApprove = canReview && ((row.status === 'submitted' && (isAdmin || Number(access.approval_level) === 1)) || (row.status === 'approved_level_1' && (isAdmin || Number(access.approval_level) >= 2)));
        return `<tr class="reimbursement-row" data-reimbursement-id="${row.id}">
        ${canReview ? `<td><input type="checkbox" class="reimbursement-select" data-id="${row.id}" ${canApprove ? '' : 'disabled'}></td><td>${escapeHtml(row.user_name)}</td><td>${escapeHtml(row.department || '—')}</td>` : ''}
        <td>${escapeHtml(row.expense_date)}</td><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.description)}</td>
        <td>${escapeHtml(row.currency)} ${Number(row.amount).toFixed(2)}</td>
        <td>${row.receipt_url ? `<a href="${row.receipt_url}" target="_blank">View receipt</a>` : (row.receipt_expired ? '<span class="hint">Attachment expired</span>' : '—')}</td>
        <td><span class="tag">${escapeHtml(row.status)}</span>${row.admin_note ? `<small class="hint">${escapeHtml(row.admin_note)}</small>` : ''}</td>
        ${canReview ? `<td>${canApprove ? `<button class="btn btn-primary btn-sm reimbursement-action" data-id="${row.id}" data-status="approved">Approve</button> <button class="btn btn-danger btn-sm reimbursement-action" data-id="${row.id}" data-status="rejected">Reject</button>` : row.status === 'approved' && canPay ? `<button class="btn btn-secondary btn-sm reimbursement-action" data-id="${row.id}" data-status="paid">Mark paid</button>` : '—'}</td>` : ''}
      </tr>`;
      }).join('') : `<tr><td colspan="${isAdmin ? 10 : 7}" class="hint" style="text-align:center; padding:15px;">No reimbursement claims found.</td></tr>`;
      $$('.reimbursement-action').forEach(button => {
        button.onclick = async (event) => {
          event.stopPropagation();
          if (button.dataset.status === 'approved' && !await confirmModal('Approve reimbursement?', 'Are you sure you want to approve this reimbursement?', 'Approve', false)) return;
          const note = button.dataset.status === 'rejected' ? prompt('Reason for rejection (optional):') || '' : '';
          await api(`/reimbursements/${button.dataset.id}/status`, { method: 'PUT', body: { status: button.dataset.status, admin_note: note } });
          if (button.dataset.status === 'approved') {
            showAppNotification('Expense has been approved successfully.');
          }
          await renderRows();
          await refreshNotificationsAfterAction();
        };
      });
      $$('.reimbursement-row').forEach(rowElement => {
        rowElement.onclick = (event) => {
          if (event.target.closest('button, input, a')) return;
          const row = rows.find(item => String(item.id) === rowElement.dataset.reimbursementId);
          if (row) openReimbursementDrawer(row);
        };
      });
      const selectAll = $('#reimbursement-select-all');
      const updateBulkButton = () => {
        const bulkApprove = $('#reimbursement-bulk-approve');
        if (bulkApprove) bulkApprove.style.display = $$('.reimbursement-select:checked').length ? '' : 'none';
      };
      if (selectAll) selectAll.onchange = () => {
        $$('.reimbursement-select:not(:disabled)').forEach(input => { input.checked = selectAll.checked; });
        updateBulkButton();
      };
      $$('.reimbursement-select').forEach(input => input.onchange = updateBulkButton);
      const bulkApprove = $('#reimbursement-bulk-approve');
      if (bulkApprove) bulkApprove.onclick = async () => {
        const ids = $$('.reimbursement-select:checked').map(input => Number(input.dataset.id));
        if (!ids.length) return alert('Select at least one reimbursement to approve.');
        if (!await confirmModal('Approve selected reimbursements?', `Are you sure you want to approve ${ids.length} reimbursement${ids.length === 1 ? '' : 's'}?`, 'Approve all', false)) return;
        await api('/reimbursements/bulk-status', { method: 'PUT', body: { ids } });
        showAppNotification('Expenses have been approved successfully.');
        await renderRows();
        await refreshNotificationsAfterAction();
      };
    } catch (err) {
      table.innerHTML = `<tr><td colspan="9" class="form-error">${escapeHtml(err.message)}</td></tr>`;
    }
  };

  if (!isAdmin) {
    $('#reimbursement-new-expense').onclick = () => {
      $('#employee-reimbursement-overview').classList.add('hidden');
      $('#employee-reimbursement-form').classList.remove('hidden');
      $('#reimbursement-form-error').textContent = '';
      $('#reimbursement-form-success').textContent = '';
      $('#reimbursement-amount').focus();
    };
    $('#reimbursement-cancel-new').onclick = () => {
      $('#employee-reimbursement-form').classList.add('hidden');
      $('#employee-reimbursement-overview').classList.remove('hidden');
    };
    $('#reimbursement-form').onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData();
      formData.append('amount', $('#reimbursement-amount').value);
      formData.append('currency', $('#reimbursement-currency').value);
      formData.append('category', $('#reimbursement-category').value);
      formData.append('expense_date', $('#reimbursement-date').value);
      formData.append('description', $('#reimbursement-description').value.trim());
      Array.from($('#reimbursement-receipt').files || []).forEach(receipt => formData.append('receipt', receipt));
      const response = await fetch('/api/reimbursements', { method: 'POST', body: formData, credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) { $('#reimbursement-form-error').textContent = result.error || 'Unable to submit claim.'; return; }
      $('#reimbursement-form-success').textContent = 'Expense submitted successfully.';
      $('#employee-reimbursement-form').classList.add('hidden');
      $('#employee-reimbursement-overview').classList.remove('hidden');
      await refreshEmployeeSummary();
      await renderRows();
      showAppNotification('Expense submitted successfully.');
    };
  }
  $('#reimbursement-filter').onclick = renderRows;
  $('#reimbursement-export').onclick = () => {
    const params = new URLSearchParams();
    if (canReview && $('#reimbursement-user')?.value) params.set('user_id', $('#reimbursement-user').value);
    if (canReview && $('#reimbursement-status')?.value) params.set('status', $('#reimbursement-status').value);
    if ($('#reimbursement-from')?.value) params.set('from', $('#reimbursement-from').value);
    if ($('#reimbursement-to')?.value) params.set('to', $('#reimbursement-to').value);
    window.open(`/api/reimbursements/export.csv?${params.toString()}`, '_blank');
  };
  renderRows();
  refreshEmployeeSummary().catch(error => console.warn('Expense summary refresh failed:', error.message));
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
  $$('.project-item').forEach((btn) => btn.addEventListener('click', () => {
    pendingSearchTaskId = null;
    openProject(Number(btn.dataset.id));
  }));
  $$('.project-del').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const p = PROJECTS.find((x) => x.id === Number(btn.dataset.id));
    const ok = await confirmModal('Delete project?', `"${escapeHtml(p.name)}" and all its tasks will be permanently deleted.`);
    if (!ok) return;
    try {
      await api(`/projects/${p.id}`, { method: 'DELETE' });
      const deletedCurrentProject = CURRENT_PROJECT && CURRENT_PROJECT.id === p.id;
      if (deletedCurrentProject) {
        CURRENT_PROJECT = null;
        closeDrawer();
      }
      await loadProjects();
      if (deletedCurrentProject) {
        if (PROJECTS.length) await openProject(Number(PROJECTS[0].id));
        else showView('projects');
      }
    } catch (error) {
      showAppNotification(`Unable to delete project: ${error.message}`);
    }
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
      <div id="np-error" class="form-error"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-ok">Create</button>
      </div>`);
    $('#m-cancel').onclick = closeModal;
    $('#m-ok').onclick = async () => {
      const name = $('#np-name').value.trim();
      if (!name) return;
      const pin = $('#np-pin').value.trim();
      try {
        await api('/projects', { method: 'POST', body: { name, pin: pin || null } });
        closeModal();
        await loadProjects();
      } catch (error) {
        const errorMessage = $('#np-error');
        if (errorMessage) errorMessage.textContent = error.message;
      }
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
  renderFocusedProjectSwitcher();
  $$('.project-item').forEach((b) => b.classList.toggle('active', Number(b.dataset.id) === project.id));
  const pTitle = $('#project-title');
  if (pTitle) pTitle.textContent = project.name;
  const searchInput = $('#task-search');
  const suggestions = $('#task-search-suggestions');
  if (searchInput) {
    searchInput.value = '';
    searchInput.dataset.fullSearch = 'false';
  }
  if (suggestions) suggestions.classList.add('hidden');
  await renderProjectMembersHint();
  await renderTaskAssigneeFilter();
  setupTaskFilters();
  await renderTasks();
  const newTaskButton = $('#btn-new-task');
  if (newTaskButton) newTaskButton.onclick = () => showNewTaskDrawer();
  const manageMembersButton = $('#btn-manage-members');
  if (manageMembersButton) manageMembersButton.onclick = () => showMembersModal();
  const newProjectButton = $('#project-new-project');
  if (newProjectButton) newProjectButton.onclick = () => document.querySelector('#btn-new-project')?.click();
}

function renderFocusedProjectSwitcher() {
  const list = $('#focused-project-list');
  if (!list) return;
  list.innerHTML = PROJECTS.map(project => `<button class="focused-project ${CURRENT_PROJECT && Number(CURRENT_PROJECT.id) === Number(project.id) ? 'active' : ''}" data-focused-project="${project.id}">${project.locked ? '🔒 ' : ''}${escapeHtml(project.name)}</button>`).join('');
  $$('.focused-project').forEach(button => button.onclick = () => openProject(Number(button.dataset.focusedProject)));
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
  const searchInput = $('#task-search');
  const suggestions = $('#task-search-suggestions');
  const showSuggestions = async () => {
    const value = searchInput.value.trim();
    searchInput.dataset.fullSearch = 'false';
    if (!value) { suggestions.classList.add('hidden'); return; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        const results = await api(`/tasks/search?q=${encodeURIComponent(value)}`);
        const visible = results.slice(0, 6);
        suggestions.innerHTML = `${visible.map(task => `<button type="button" class="task-suggestion" data-task-id="${task.id}" data-project-id="${task.project_id}"><b>${escapeHtml(task.title)}</b><span>${escapeHtml(task.project_name || '')}</span></button>`).join('')}${results.length ? `<button type="button" class="task-suggestion task-suggestion-all" data-show-all="true">Show all ${results.length} results</button>` : '<div class="task-suggestion-empty">No matching tasks</div>'}`;
        suggestions.classList.remove('hidden');
        $$('.task-suggestion[data-task-id]').forEach(button => {
          button.onclick = async () => {
            pendingSearchTaskId = Number(button.dataset.taskId);
            suggestions.classList.add('hidden');
            await openProject(Number(button.dataset.projectId));
          };
        });
        const showAll = $('.task-suggestion-all');
        if (showAll) showAll.onclick = () => { searchInput.dataset.fullSearch = 'true'; suggestions.classList.add('hidden'); renderTasks(); };
      } catch (error) { suggestions.classList.add('hidden'); }
    }, 180);
  };
  searchInput.oninput = showSuggestions;
  searchInput.onkeydown = (event) => {
    if (event.key === 'Enter' && searchInput.value.trim()) {
      event.preventDefault();
      searchInput.dataset.fullSearch = 'true';
      suggestions.classList.add('hidden');
      renderTasks();
    }
    if (event.key === 'Escape') suggestions.classList.add('hidden');
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
    const searchInput = $('#task-search');
    const search = searchInput?.dataset.fullSearch === 'true' ? searchInput.value.trim() : '';
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
        <td class="task-due-cell"><span class="task-due ${getDueState(task.due_date).className}">${escapeHtml(getDueState(task.due_date).label)}</span></td>
        <td class="task-status-cell"><span class="task-status ${task.status === 'done' ? 'task-status-done' : 'task-status-open'}">${task.status === 'done' ? 'Completed' : 'Open'}</span></td>
      </tr>`).join('') : '<tr><td colspan="5" class="hint" style="padding:15px;">No open tasks yet.</td></tr>';
    $$('.row-complete:not(:disabled)').forEach(button => {
      button.onclick = async () => {
        await api(`/tasks/${button.dataset.taskId}`, { method: 'PUT', body: { status: 'done' } });
        reloadWithActionMessage('project', 'Task completed successfully.', CURRENT_PROJECT.id);
      };
    });
    $$('.task-row').forEach(row => {
      row.onclick = (event) => {
        if (event.target.closest('.row-complete')) return;
        openTaskDrawer(Number(row.dataset.taskId));
      };
    });
    if (pendingSearchTaskId) {
      const taskId = pendingSearchTaskId;
      pendingSearchTaskId = null;
      await openTaskDrawer(taskId);
    }
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
  if (due) due.removeAttribute('min');
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
      reloadWithActionMessage('project', 'Task created successfully.', CURRENT_PROJECT.id);
    } catch (err) { alert(err.message); }
  };
}

function showTaskDrawerLoading() {
  const drawer = $('#task-drawer');
  if (!drawer) return;
  drawer.classList.add('loading');
  drawer.classList.remove('hidden');
  $('#app').classList.add('drawer-open');
  $('#drawer-close').onclick = closeDrawer;
  $('#drawer-title').value = 'Loading task...';
  $('#drawer-title').disabled = true;
  $('#drawer-assignee').innerHTML = '<option>Loading...</option>';
  $('#drawer-assignee').disabled = true;
  $('#drawer-due').value = '';
  $('#drawer-due').disabled = true;
  $('#drawer-created').textContent = 'Loading...';
  $('#drawer-status').disabled = true;
  $('#drawer-desc').value = '';
  $('#drawer-desc').disabled = true;
  $('#drawer-subtasks').innerHTML = '<div class="drawer-loading-line"></div><div class="drawer-loading-line short"></div>';
  $('#drawer-comments').innerHTML = '<div class="drawer-loading-line"></div><div class="drawer-loading-line"></div><div class="drawer-loading-line short"></div>';
  $('#btn-save-task').style.display = 'none';
  $('#btn-complete-task').style.display = 'none';
  $('#btn-delete-task').style.display = 'none';
}

async function openTaskDrawer(taskId) {
  const drawer = $('#task-drawer');
  if (!drawer) return;
  showTaskDrawerLoading();
  try {
    const task = await api(`/tasks/${taskId}`);
    const [taskHistoryResult, members] = await Promise.all([
      api(`/tasks/${taskId}/history`).catch(() => []),
      api(`/projects/${task.project_id}/members`)
    ]);
    const taskHistory = taskHistoryResult;
    drawer.classList.remove('loading');
    $('#drawer-title').value = task.title || '';
    $('#drawer-title').disabled = false;
    $('#drawer-assignee').innerHTML = '<option value="">No assignee</option>' + members.map(member => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join('');
    $('#drawer-assignee').disabled = false;
    $('#drawer-assignee').value = task.assignee_id || '';
    $('#drawer-due').value = task.due_date || '';
    $('#drawer-due').disabled = false;
    $('#drawer-due').removeAttribute('min');
    $('#drawer-created').textContent = fmtDateTime(task.created_at);
    $('#drawer-status').value = task.status || 'open';
    $('#drawer-status').disabled = false;
    $('#drawer-desc').value = task.description || '';
    $('#drawer-desc').disabled = false;
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
    const compactHistory = [];
    (task.history || taskHistory || []).forEach(change => {
      const previous = compactHistory[compactHistory.length - 1];
      if (previous?.field_name === 'Description' && change.field_name === 'Description') {
        previous.new_value = change.new_value;
        previous.created_at = change.created_at;
        previous.actor_name = change.actor_name;
      } else {
        compactHistory.push({ ...change });
      }
    });
    const activity = [
      ...(task.comments || []).map(comment => ({ ...comment, activityType: 'comment' })),
      ...compactHistory.map(change => ({ ...change, activityType: 'change' }))
    ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    $('#drawer-comments').innerHTML = activity.length ? activity.map((entry, index) => {
      if (entry.activityType === 'comment') return `<div class="comment" data-comment-id="${entry.id}">
        <div class="comment-meta"><b>${escapeHtml(entry.user_name || 'User')}</b> · ${escapeHtml(fmtDateTime(entry.created_at))}${entry.edited_at ? ` <span class="comment-edited">Edited · ${escapeHtml(fmtDateTime(entry.edited_at))}</span>` : ''}${Number(entry.user_id) === Number(ME?.id) ? ` <button type="button" class="link-btn comment-edit-button" data-comment-id="${entry.id}">Edit</button>` : ''}</div>
        <div class="comment-body">${escapeHtml(entry.body || '').replace(/\n/g, '<br>')}</div>
        ${renderCommentAttachment(entry)}
      </div>`;
      const actor = escapeHtml(entry.actor_name || 'User');
      const oldValue = escapeHtml(entry.old_value || '(empty)');
      const newValue = escapeHtml(entry.new_value || '(empty)');
      let message = entry.field_name === 'Task created' ? 'created this task' : `changed the ${entry.field_name.toLowerCase()}`;
      if (entry.field_name === 'Assignee') message = `reassigned this task from ${oldValue} to ${newValue}`;
      if (entry.field_name === 'Due date') message = `changed the due date from ${oldValue} to ${newValue}`;
      const difference = entry.field_name === 'Description' ? `<button type="button" class="link-btn task-difference-toggle" data-history-index="${index}">Show difference</button><div class="task-difference hidden" data-history-panel="${index}"><div class="task-history-old"><b>Old:</b> ${oldValue}</div><div class="task-history-new"><b>New:</b> ${newValue}</div></div>` : '';
      return `<div class="task-activity-change" data-activity-index="${index}"><b>${actor}</b> ${message} <span>· ${escapeHtml(fmtDateTime(entry.created_at))}</span>${difference}</div>`;
    }).join('') : '<div class="hint">No activity yet.</div>';
    $$('.task-difference-toggle').forEach(button => {
      button.onclick = () => {
        const panel = document.querySelector(`[data-history-panel="${button.dataset.historyIndex}"]`);
        const expanded = panel.classList.toggle('hidden');
        button.textContent = expanded ? 'Show difference' : 'Hide difference';
      };
    });
    $$('.comment-edit-button').forEach(button => {
      button.onclick = () => {
        const comment = (task.comments || []).find(item => Number(item.id) === Number(button.dataset.commentId));
        const commentElement = button.closest('.comment');
        const bodyElement = commentElement?.querySelector('.comment-body');
        if (!comment || !bodyElement || commentElement.querySelector('.comment-edit-form')) return;
        const originalBody = comment.body || '';
        bodyElement.innerHTML = `<div class="comment-edit-form"><textarea rows="3"></textarea><div class="comment-edit-actions"><button type="button" class="btn btn-secondary btn-sm comment-edit-cancel">Cancel</button><button type="button" class="btn btn-primary btn-sm comment-edit-save">Save</button></div><div class="form-error comment-edit-error"></div></div>`;
        const editor = bodyElement.querySelector('textarea');
        const error = bodyElement.querySelector('.comment-edit-error');
        editor.value = originalBody;
        editor.focus();
        bodyElement.querySelector('.comment-edit-cancel').onclick = () => { bodyElement.innerHTML = escapeHtml(originalBody).replace(/\n/g, '<br>'); };
        bodyElement.querySelector('.comment-edit-save').onclick = async () => {
          const nextBody = editor.value.trim();
          if (!nextBody) { error.textContent = 'Comment cannot be empty.'; return; }
          try {
            const result = await api(`/comments/${comment.id}`, { method: 'PUT', body: { body: nextBody } });
            comment.body = nextBody;
            comment.edited_at = result.edited_at;
            bodyElement.innerHTML = escapeHtml(nextBody).replace(/\n/g, '<br>');
            const meta = commentElement.querySelector('.comment-meta');
            const editButton = meta.querySelector('.comment-edit-button');
            meta.innerHTML = `<b>${escapeHtml(comment.user_name || 'User')}</b> · ${escapeHtml(fmtDateTime(comment.created_at))} <span class="comment-edited">Edited · ${escapeHtml(fmtDateTime(result.edited_at))}</span>`;
            meta.appendChild(editButton);
          } catch (err) { error.textContent = err.message; }
        };
      };
    });
    $('#comment-image-preview').innerHTML = '';
    $('#comment-image-preview').classList.add('hidden');
    $('#comment-file-input').value = '';
    $('#drawer-comment-input').value = '';
    $('#drawer-comment-input').oninput = autoGrowComment;
    autoGrowComment();
    $('#btn-save-task').style.display = '';
    $('#btn-save-task').className = 'btn btn-secondary btn-sm';
    $('#btn-complete-task').textContent = task.status === 'done' ? 'Completed' : '✓ Complete task';
    $('#btn-complete-task').disabled = task.status === 'done';
    $('#btn-complete-task').className = task.status === 'done' ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-block';
    $('#btn-delete-task').style.display = ME && ME.role === 'admin' ? '' : 'none';
    drawer.classList.remove('hidden');
    $('#app').classList.add('drawer-open');
    $('#drawer-close').onclick = closeDrawer;
    const getTaskDraftKey = () => JSON.stringify({
      title: $('#drawer-title').value.trim(),
      description: $('#drawer-desc').value,
      assignee_id: $('#drawer-assignee').value || null,
      due_date: $('#drawer-due').value || null,
      status: $('#drawer-status').value
    });
    let savedTaskDraftKey = getTaskDraftKey();
    const saveChanges = async () => {
      const draftKey = getTaskDraftKey();
      if (draftKey === savedTaskDraftKey) return;
      const saveState = $('#drawer-save-state');
      if (saveState) { saveState.textContent = 'Saving...'; saveState.className = 'drawer-save-state'; }
      await api(`/tasks/${taskId}`, { method: 'PUT', body: {
        title: $('#drawer-title').value.trim(),
        description: $('#drawer-desc').value,
        assignee_id: $('#drawer-assignee').value || null,
        due_date: $('#drawer-due').value || null,
        status: $('#drawer-status').value
      }});
      savedTaskDraftKey = draftKey;
      await renderTasks();
      taskHistory = await api(`/tasks/${taskId}/history`);
      await openTaskDrawer(taskId);
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
    $('#drawer-desc').onblur = async () => {
      clearTimeout(autosaveTimer);
      try {
        await saveChanges();
      } catch (err) {
        const saveState = $('#drawer-save-state');
        if (saveState) { saveState.textContent = 'Save failed'; saveState.className = 'drawer-save-state error'; }
        console.error('Description save failed:', err);
      }
    };
    $('#drawer-assignee').onchange = queueAutosave;
    $('#drawer-due').onchange = queueAutosave;
    $('#drawer-status').onchange = queueAutosave;
    $('#btn-save-task').onclick = async () => {
      clearTimeout(autosaveTimer);
      await saveChanges();
    };
    $('#btn-complete-task').onclick = async () => {
      await api(`/tasks/${taskId}`, { method: 'PUT', body: { status: 'done' } });
      reloadWithActionMessage('project', 'Task completed successfully.', CURRENT_PROJECT.id);
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
    const mentionSuggestions = $('#comment-mention-suggestions');
    const fileInput = $('#comment-file-input');
    const filePreview = $('#comment-image-preview');
    let mentionRange = null;
    let mentionIndex = 0;
    const hideMentionSuggestions = () => {
      mentionRange = null;
      mentionSuggestions.classList.add('hidden');
      mentionSuggestions.innerHTML = '';
    };
    const chooseMention = (member) => {
      if (!mentionRange) return;
      const before = commentInput.value.slice(0, mentionRange.start);
      const after = commentInput.value.slice(mentionRange.end);
      commentInput.value = `${before}@${member.name} ${after}`;
      const cursor = before.length + member.name.length + 2;
      commentInput.focus();
      commentInput.setSelectionRange(cursor, cursor);
      hideMentionSuggestions();
      autoGrowComment();
    };
    const updateMentionSuggestions = () => {
      const beforeCursor = commentInput.value.slice(0, commentInput.selectionStart);
      const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
      if (!match) { hideMentionSuggestions(); return; }
      const query = match[1].toLowerCase();
      const start = beforeCursor.length - match[0].length + (match[0].startsWith('@') ? 0 : 1);
      const matchingMembers = members.filter(member => String(member.name || '').toLowerCase().includes(query)).slice(0, 8);
      if (!matchingMembers.length) { hideMentionSuggestions(); return; }
      mentionRange = { start, end: commentInput.selectionStart };
      mentionIndex = 0;
      mentionSuggestions.innerHTML = matchingMembers.map((member, index) => `<button type="button" class="${index === 0 ? 'active' : ''}" data-member-id="${member.id}">${escapeHtml(member.name)}</button>`).join('');
      mentionSuggestions.classList.remove('hidden');
      mentionSuggestions.querySelectorAll('button').forEach(button => {
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => chooseMention(matchingMembers.find(member => String(member.id) === button.dataset.memberId));
      });
    };
    commentInput.oninput = () => { autoGrowComment(); updateMentionSuggestions(); };
    commentInput.onkeydown = event => {
      if (mentionSuggestions.classList.contains('hidden')) return;
      const options = Array.from(mentionSuggestions.querySelectorAll('button'));
      if (event.key === 'Escape') { hideMentionSuggestions(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        options.forEach((option, index) => option.classList.toggle('active', index === mentionIndex));
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const memberId = options[mentionIndex]?.dataset.memberId;
        const member = members.find(item => String(item.id) === memberId);
        if (member) chooseMention(member);
      }
    };
    commentInput.onblur = () => setTimeout(hideMentionSuggestions, 120);
    $('#btn-attach-image').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files[0];
      if (!file) { filePreview.classList.add('hidden'); return; }
      filePreview.innerHTML = `<span>${escapeHtml(file.name)}</span>`;
      filePreview.classList.remove('hidden');
    };
    const uploadTaskComment = (url, formData, onProgress) => new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', url);
      request.withCredentials = true;
      request.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onload = () => {
        let result = null;
        try { result = JSON.parse(request.responseText); } catch (error) { }
        if (request.status >= 200 && request.status < 300) resolve(result || {});
        else reject(new Error(result?.error || 'Unable to post comment.'));
      };
      request.onerror = () => reject(new Error('Network error while uploading the attachment.'));
      request.onabort = () => reject(new Error('Attachment upload was cancelled.'));
      request.send(formData);
    });
    $('#btn-add-comment').onclick = async () => {
      const body = commentInput.value.trim();
      const attachment = fileInput.files[0];
      if (!body && !attachment) return;
      const attachmentPreviewUrl = attachment && attachment.type.startsWith('image/') ? URL.createObjectURL(attachment) : null;
      const commentEntry = document.createElement('div');
      commentEntry.className = 'comment comment-pending';
      commentEntry.innerHTML = `
        <div class="comment-meta"><b>${escapeHtml(ME?.name || 'You')}</b> · just now</div>
        ${escapeHtml(body).replace(/\n/g, '<br>')}
        ${attachmentPreviewUrl ? `<img class="comment-image comment-pending-attachment" src="${attachmentPreviewUrl}" alt="Uploading attachment">` : (attachment ? `<div class="hint comment-pending-attachment">${escapeHtml(attachment.name)}</div>` : '')}
        ${attachment ? '<div class="hint comment-pending-status">Uploading attachment...</div>' : '<div class="hint comment-pending-status">Sending...</div>'}`;
      $('#drawer-comments').appendChild(commentEntry);
      commentEntry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const previousBody = body;
      const previousAttachment = attachment;
      commentInput.value = '';
      fileInput.value = '';
      filePreview.innerHTML = '';
      filePreview.classList.add('hidden');
      hideMentionSuggestions();
      autoGrowComment();
      const postButton = $('#btn-add-comment');
      if (postButton) postButton.disabled = true;
      const formData = new FormData();
      formData.append('body', body);
      if (attachment) formData.append('attachment', attachment);
      try {
        const result = await uploadTaskComment(`/api/tasks/${taskId}/comments`, formData, percent => {
          const pendingStatus = commentEntry.querySelector('.comment-pending-status');
          if (pendingStatus) pendingStatus.textContent = `Uploading attachment... ${percent}%`;
        });
        const pendingStatus = commentEntry.querySelector('.comment-pending-status');
        if (pendingStatus) pendingStatus.remove();
        commentEntry.classList.remove('comment-pending');
      } catch (error) {
        commentEntry.remove();
        if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
        commentInput.value = previousBody;
        if (previousAttachment) {
          const restoredTransfer = new DataTransfer();
          restoredTransfer.items.add(previousAttachment);
          fileInput.files = restoredTransfer.files;
          filePreview.innerHTML = `<span>${escapeHtml(previousAttachment.name)}</span>`;
          filePreview.classList.remove('hidden');
        }
        autoGrowComment();
        alert(error.message);
      } finally {
        if (postButton) postButton.disabled = false;
      }
    };
  } catch (err) {
    drawer.classList.remove('loading');
    $('#drawer-title').value = 'Unable to load task';
    $('#drawer-comments').innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  }
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
    if (!navigator.geolocation) return reject(new Error('Location is not supported by this device browser.'));
    const requestLocation = () => navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) reject(new Error('Location permission is off. Enable Location for this browser in phone settings, then try again.'));
        else if (err.code === err.TIMEOUT) reject(new Error('Location took too long. Turn on GPS and try again.'));
        else reject(new Error('Unable to read your location. Turn on GPS and try again.'));
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
    if (!navigator.permissions?.query) {
      alert('TaskFlow needs your location to record attendance. Please allow location when your browser asks.');
      return requestLocation();
    }
    navigator.permissions.query({ name: 'geolocation' }).then(permission => {
      if (permission.state === 'denied') {
        reject(new Error('Location permission is blocked. Enable Location for this browser in phone settings, then try again.'));
        return;
      }
      if (permission.state === 'prompt') alert('TaskFlow needs your location to record attendance. Tap Allow when your browser asks.');
      requestLocation();
    }).catch(requestLocation);
  });
}

async function verifyAttendanceIfRequired(action) {
  const setting = await api('/attendance/verification-required');
  if (!setting.required) return true;
  const biometricAuth = window.Capacitor?.Plugins?.BiometricAuth;
  if (!biometricAuth) throw new Error('Attendance verification requires the installed TaskFlow mobile app.');
  const availability = await biometricAuth.checkBiometry();
  if (!availability.isAvailable) throw new Error('Set up fingerprint or Face ID on this device before punching ' + action + '.');
  try {
    await biometricAuth.authenticate({
      reason: `Verify identity before punch ${action}`,
      androidTitle: `Verify before punch ${action}`,
      androidSubtitle: 'Use your enrolled fingerprint or face',
      allowDeviceCredential: false,
      iosFallbackTitle: ''
    });
    return true;
  } catch (error) {
    throw new Error('Biometric verification failed. Punch ' + action + ' was not recorded.');
  }
}

function isPhoneDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function renderPunchCard() {
  const card = $('#punch-card-container');
  if (!card) return;
  if (!isPhoneDevice()) {
    card.innerHTML = '<div class="admin-block attendance-phone-only"><b>Attendance is phone-only</b><p class="hint">Use TaskFlow on a phone to punch in or punch out. Location access is disabled on laptops.</p></div>';
    return;
  }
  try {
    const status = await api('/attendance/today');
    if (!status) {
      card.innerHTML = `<button class="btn btn-primary btn-lg" id="btn-punch-in" style="width:100%; padding:15px; font-size:18px;">📍 Punch In Field Shift</button>`;
      $('#btn-punch-in').onclick = async () => {
        try {
          await verifyAttendanceIfRequired('in');
          const coords = await getLiveCoords();
          await api('/attendance/punch-in', { method: 'POST', body: coords });
          reloadWithActionMessage('attendance', 'Punched in successfully.');
        } catch (err) { alert(err.message); }
      };
    } else if (!status.punch_in) {
      card.innerHTML = `<button class="btn btn-primary btn-lg" id="btn-punch-in" style="width:100%; padding:15px; font-size:18px;">📍 Punch In Field Shift</button>`;
      $('#btn-punch-in').onclick = async () => {
        try {
          await verifyAttendanceIfRequired('in');
          const coords = await getLiveCoords();
          await api('/attendance/punch-in', { method: 'POST', body: coords });
          reloadWithActionMessage('attendance', 'Punched in successfully.');
        } catch (err) { alert(err.message); }
      };
    } else if (status.punch_in && !status.punch_out) {
      startLiveTracking();
      card.innerHTML = `
        <div class="status-alert" style="background:#e3f2fd; color:#0d47a1; padding:12px; border-radius:4px; margin-bottom:10px; font-weight:bold; text-align:center;">
          ⚡ On-Duty Since: ${fmtTime(status.punch_in)}<br><small>📍 Live location active</small>
        </div>
        <button class="btn btn-danger btn-lg" id="btn-punch-out" style="width:100%; padding:15px; font-size:18px;">🏁 Punch Out Field Shift</button>`;
      $('#btn-punch-out').onclick = async () => {
        try {
          await verifyAttendanceIfRequired('out');
          const coords = await getLiveCoords();
          await api('/attendance/punch-out', { method: 'POST', body: coords });
          stopLiveTracking();
          reloadWithActionMessage('attendance', 'Punched out successfully.');
        } catch (err) { alert(err.message); }
      };
    } else {
      stopLiveTracking();
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
        <td style="padding:10px;"><a href="https://www.google.com/maps?q=${r.in_lat || r.IN_LAT},${r.in_lng || r.IN_LNG}" target="_blank" class="map-link" style="color:#007bff; text-decoration:none; font-weight:bold;">🗺️ View Live Site</a><button class="link-btn live-timeline-btn" data-user-id="${r.user_id || r.USER_ID}" data-user-name="${escapeHtml(r.user_name || r.USER_NAME)}" style="display:block; margin-top:6px;">View timeline</button></td>
      </tr>
    `).join('');
    $$('.live-timeline-btn').forEach(button => {
      button.onclick = async () => {
        try {
          const timeline = await api(`/attendance/live/${button.dataset.userId}/timeline`);
          showModal(`<h3>Location timeline: ${escapeHtml(button.dataset.userName)}</h3>${timeline.length ? `<div class="location-timeline">${timeline.map((point, index) => `<div class="location-timeline-item"><b>${index + 1}. ${escapeHtml(fmtDateTime(point.recorded_at))}</b><span>${Number(point.latitude).toFixed(6)}, ${Number(point.longitude).toFixed(6)}</span><a href="https://www.google.com/maps?q=${point.latitude},${point.longitude}" target="_blank" rel="noopener">Open map</a></div>`).join('')}</div>` : '<p class="hint">No live location points recorded yet.</p>'}<div class="modal-actions"><button class="btn btn-primary" id="location-timeline-close">Close</button></div>`);
          $('#location-timeline-close')?.addEventListener('click', closeModal);
        } catch (error) { alert(error.message); }
      };
    });
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

async function renderTracking() {
  const peoplePanel = $('#tracking-people');
  const detail = $('#tracking-detail');
  if (!peoplePanel || !detail) return;
  try {
    const people = await api('/attendance/tracking/people');
    peoplePanel.innerHTML = people.length ? people.map(person => `
      <button class="tracking-person" data-tracking-user-id="${person.user_id}">
        <b>${escapeHtml(person.user_name)}</b><small>${escapeHtml(person.department || 'Employee')}</small>
        <span class="tracking-status ${person.punch_in && !person.punch_out ? 'active' : ''}">${person.punch_in && !person.punch_out ? 'Live now' : 'Not active'}</span>
      </button>`).join('') : '<div class="hint">No employees found.</div>';
    $$('.tracking-person').forEach(button => {
      button.onclick = () => loadTrackingTimeline(Number(button.dataset.trackingUserId), button);
    });
    if (people.length) loadTrackingTimeline(people[0].user_id, peoplePanel.querySelector('.tracking-person'));
  } catch (error) {
    peoplePanel.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
  }
}

async function loadTrackingTimeline(userId, selectedButton) {
  $$('.tracking-person').forEach(button => button.classList.toggle('active', button === selectedButton));
  const detail = $('#tracking-detail');
  if (!detail) return;
  try {
    const trackingData = await api(`/attendance/tracking/${userId}/timeline`);
    const timeline = trackingData.points || [];
    const latest = timeline[timeline.length - 1];
    const totalDistanceKm = Number(trackingData.total_distance_meters || 0) / 1000;
    const distanceLabel = totalDistanceKm >= 1 ? `${totalDistanceKm.toFixed(2)} km` : `${Number(trackingData.total_distance_meters || 0).toFixed(0)} m`;
    detail.innerHTML = `<div class="tracking-detail-header"><div><span class="eyebrow">Location timeline</span><h2>${escapeHtml(selectedButton?.querySelector('b')?.textContent || 'Employee')}</h2></div><span class="hint">${timeline.length} points · ${distanceLabel} today · ${trackingData.place_changes || 0} place changes</span></div>
      ${latest ? `<iframe class="tracking-map" title="Latest employee location" src="https://www.google.com/maps?q=${latest.latitude},${latest.longitude}&output=embed" loading="lazy"></iframe>` : '<div class="tracking-map tracking-map-empty">No location points recorded yet.</div>'}
      <div class="tracking-timeline">${timeline.length ? timeline.map((point, index) => `<a class="tracking-point" href="https://www.google.com/maps?q=${point.latitude},${point.longitude}" target="_blank" rel="noopener"><b>${index + 1}. ${escapeHtml(fmtDateTime(point.recorded_at))}${Number(point.place_changed) ? ' · Place changed' : ''}</b><span>+${Number(point.distance_meters || 0).toFixed(0)} m · ${Number(point.latitude).toFixed(6)}, ${Number(point.longitude).toFixed(6)}</span></a>`).join('') : '<div class="hint">The first point appears when the employee punches in.</div>'}</div>`;
  } catch (error) {
    detail.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
  }
}

// ================= ADMINISTRATIVE CORE VIEW MODULE =================
async function renderAdmin() {
  try {
    const [users, settings, departments, reimbursementAccess, activity, trackingAccess, verificationAccess] = await Promise.all([api('/auth/users'), api('/auth/settings'), api('/auth/departments'), api('/auth/reimbursement-access'), api('/auth/activity'), api('/attendance/tracking-access'), api('/attendance/verification-access')]);
    const verificationByUser = new Map(verificationAccess.map(person => [Number(person.id), Number(person.verification_required) === 1]));
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
        <h3>Live tracking access</h3>
        <p class="hint">Allow selected employees to open the Tracking dashboard and view location timelines.</p>
        <div id="tracking-access-list"></div>
      </div>

      <div class="admin-block">
        <h3>Activity log</h3>
        <p class="hint">Recent changes made in TaskFlow.</p>
        <div id="activity-log-list"></div>
      </div>

      <div class="admin-block">
        <h3>Team members</h3>
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
              <th style="padding:10px;">Biometric</th>
              <th style="padding:10px;">Actions</th>
            </tr>
          </thead>
          <tbody id="admin-employees-table-body"></tbody>
        </table>
      </div>`;

    wrap.querySelectorAll('.admin-block').forEach((section) => {
      section.classList.add('is-collapsible');
      section.classList.add('is-collapsed');
      const heading = section.querySelector('h3');
      if (!heading || heading.querySelector('.admin-section-toggle')) return;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'admin-section-toggle';
      toggle.textContent = '+';
      toggle.title = 'Expand section';
      toggle.setAttribute('aria-label', 'Expand section');
      toggle.onclick = () => {
        const collapsed = section.classList.toggle('is-collapsed');
        toggle.textContent = collapsed ? '+' : '−';
        toggle.title = collapsed ? 'Expand section' : 'Collapse section';
        toggle.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
      };
      heading.prepend(toggle);
    });

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
          <td style="padding:10px;"><select class="admin-department" data-user-id="${u.id}" style="width:140px; padding:5px;"><option value="">No department</option>${departments.map(department => `<option value="${escapeHtml(department.name || department.NAME)}" ${String(u.department || u.DEPARTMENT || '') === String(department.name || department.NAME) ? 'selected' : ''}>${escapeHtml(department.name || department.NAME)}</option>`).join('')}</select><button class="btn btn-secondary btn-sm admin-save-department" data-user-id="${u.id}" style="margin-left:5px;">Save</button></td>
          <td style="padding:10px;"><span class="badge" style="background:#e3f2fd; color:#0d47a1; padding:4px 8px; border-radius:4px; font-size:12px;">${escapeHtml(u.role || u.ROLE)}</span></td>
          <td style="padding:10px;"><span class="badge" style="background:#c8e6c9; color:#25602a; padding:4px 8px; border-radius:4px; font-size:12px;">${u.active || u.ACTIVE ? 'Active' : 'Disabled'}</span></td>
          <td style="padding:10px;"><label class="admin-biometric-toggle"><input type="checkbox" data-verification-user="${u.id}" ${verificationByUser.get(Number(u.id)) ? 'checked' : ''}><span>${verificationByUser.get(Number(u.id)) ? 'Required' : 'Off'}</span></label></td>
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

    const trackingAccessList = $('#tracking-access-list');
    trackingAccess.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'tracking-access-row';
      row.innerHTML = `<div><b>${escapeHtml(person.name)}</b><span class="tracking-username">${escapeHtml(person.username)}</span></div><span class="tracking-access-status ${person.tracking_allowed ? 'allowed' : 'denied'}">${person.tracking_allowed ? 'Allowed' : 'Denied'}</span><label class="tracking-toggle"><input type="checkbox" ${person.tracking_allowed ? 'checked' : ''} data-tracking-access-user="${person.id}"><span>Allow tracking view</span></label>`;
      trackingAccessList.appendChild(row);
    });
    $$('[data-tracking-access-user]').forEach((checkbox) => {
      checkbox.onchange = async () => {
        try {
          await api(`/attendance/tracking-access/${checkbox.dataset.trackingAccessUser}`, { method: 'PUT', body: { allowed: checkbox.checked } });
          const row = checkbox.closest('.tracking-access-row');
          const status = row?.querySelector('.tracking-access-status');
          if (status) {
            status.textContent = checkbox.checked ? 'Allowed' : 'Denied';
            status.classList.toggle('allowed', checkbox.checked);
            status.classList.toggle('denied', !checkbox.checked);
          }
          showAppNotification(checkbox.checked ? 'Tracking access granted.' : 'Tracking access removed.');
        } catch (error) { checkbox.checked = !checkbox.checked; alert(error.message); }
      };
    });

    const activityList = $('#activity-log-list');
    if (!activity.length) {
      activityList.innerHTML = '<p class="hint">No activity recorded yet.</p>';
    } else {
      activityList.innerHTML = activity.map((entry) => `
        <div class="member-option" style="display:block; padding:10px 0; border-bottom:1px solid #eee;">
          <b>${escapeHtml(entry.action)}</b>
          <span class="hint"> by ${escapeHtml(entry.actor_name || 'Unknown user')} on ${escapeHtml(new Date(entry.created_at).toLocaleString())}</span>
          ${entry.details ? `<div>${escapeHtml(entry.details)}</div>` : ''}
        </div>`).join('');
    }
    $$('.save-reimbursement-access').forEach((button) => {
      button.onclick = async () => {
        const select = document.querySelector(`.reimbursement-access-level[data-user-id="${button.dataset.userId}"]`);
        await api(`/auth/reimbursement-access/${button.dataset.userId}`, {
          method: 'PUT', body: { approval_level: Number(select.value), can_pay: select.value === '2' }
        });
        refreshNotificationsAfterAction();
        renderAdmin();
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
        reloadWithActionMessage('admin', 'Department added successfully.');
      } catch (err) { alert(err.message); }
    };

    $$('[data-delete-department]').forEach((button) => {
      button.onclick = async () => {
        if (!confirm('Delete this department? Existing employee records will keep their current text.')) return;
        try {
          await api(`/auth/departments/${button.dataset.deleteDepartment}`, { method: 'DELETE' });
          refreshNotificationsAfterAction();
          renderAdmin();
        } catch (err) { alert(err.message); }
      };
    });

    $$('.admin-save-department').forEach((button) => {
      button.onclick = async () => {
        const input = document.querySelector(`.admin-department[data-user-id="${button.dataset.userId}"]`);
        try {
          await api(`/auth/users/${button.dataset.userId}`, { method: 'PUT', body: { department: input.value.trim() } });
          refreshNotificationsAfterAction();
          renderAdmin();
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

    $$('[data-verification-user]').forEach((checkbox) => {
      checkbox.onchange = async () => {
        try {
          await api(`/attendance/verification-access/${checkbox.dataset.verificationUser}`, { method: 'PUT', body: { enabled: checkbox.checked } });
          checkbox.nextElementSibling.textContent = checkbox.checked ? 'Required' : 'Off';
          showAppNotification(checkbox.checked ? 'Biometric verification enabled.' : 'Biometric verification disabled.');
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          alert(error.message);
        }
      };
    });

    $('#u-add').onclick = async () => {
      const name = $('#u-name').value.trim();
      const username = $('#u-username').value.trim();
      const department = $('#u-department').value.trim();
      const password = $('#u-password').value.trim();
      const role = $('#u-role').value;

      if (!name || !username || !password) return alert('Please complete all form fields.');

      try {
        await api('/auth/users', { method: 'POST', body: { name, username, password, department, role } });
        reloadWithActionMessage('admin', 'Employee added successfully.');
      } catch (err) { alert(err.message); }
    };


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
          ? (isPhoneDevice() ? `<button class="btn btn-danger btn-sm admin-punch" data-action="out" data-user-id="${row.user_id}">Punch out</button>` : '<span class="hint">Phone required</span>')
          : !row.punch_in ? (isPhoneDevice() ? `<button class="btn btn-primary btn-sm admin-punch" data-action="in" data-user-id="${row.user_id}">Punch in</button>` : '<span class="hint">Phone required</span>') : '<span class="hint">Complete</span>') : '<span class="hint">—</span>';
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
      reloadWithActionMessage(currentViewName(), 'Password changed successfully.');
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
      reloadWithActionMessage('admin', `Password for ${userName} changed successfully.`);
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
