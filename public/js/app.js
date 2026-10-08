// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const nativeApp = Boolean(window.Capacitor?.isNativePlatform?.())
  || /TaskFlowNative\/1(?:\s|$)/.test(navigator.userAgent);
const htmlElement = document.documentElement;
const nativeThemeKey = 'taskflow.native.theme';
const nativeTextSizeKey = 'taskflow.native.text-size';
const nativeDashboardCacheKey = 'taskflow.native.dashboard-cache.v1';

if (nativeApp) {
  htmlElement.classList.add('is-native');
  htmlElement.classList.add(/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'is-ios' : 'is-android');
}
let nativeAppResumeGeneration = 0;

function applyNativeAppearance(theme, textSize) {
  if (!nativeApp) return;
  htmlElement.dataset.theme = theme;
  htmlElement.style.fontSize = { small: '14px', default: '16px', large: '18px' }[textSize] || '16px';
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  htmlElement.style.colorScheme = dark ? 'dark' : 'light';
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dark ? '#0B1220' : '#F4F6F8';
  const appleStatusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (appleStatusBar && /iPhone|iPad|iPod/i.test(navigator.userAgent)) appleStatusBar.content = dark ? 'black' : 'default';
}

if (nativeApp) {
  const storedTheme = localStorage.getItem(nativeThemeKey);
  const storedTextSize = localStorage.getItem(nativeTextSizeKey);
  const initialTheme = ['system', 'light', 'dark'].includes(storedTheme) ? storedTheme : 'system';
  const initialTextSize = ['small', 'default', 'large'].includes(storedTextSize) ? storedTextSize : 'default';
  applyNativeAppearance(initialTheme, initialTextSize);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (htmlElement.dataset.theme === 'system') {
      applyNativeAppearance('system', localStorage.getItem(nativeTextSizeKey) || 'default');
    }
  });
}

if (nativeApp) {
  const offlineBanner = $('#mobile-offline-banner');
  const offlineMessage = $('#mobile-offline-message');
  const retryButton = $('#mobile-offline-retry');
  let connectivityCheckId = 0;
  const checkBackendConnectivity = async () => {
    const checkId = ++connectivityCheckId;
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (checkId !== connectivityCheckId) return;
      if (!response.ok && response.status !== 401) throw new Error(`Server returned ${response.status}.`);
      offlineBanner?.classList.add('hidden');
    } catch (error) {
      if (checkId !== connectivityCheckId) return;
      if (offlineMessage) offlineMessage.textContent = 'TaskFlow is still unreachable. Check your connection and retry.';
      offlineBanner?.classList.remove('hidden');
    }
  };
  const handleAppResume = () => {
    nativeAppResumeGeneration += 1;
    void checkBackendConnectivity();
  };
  const updateConnectivity = () => {
    if (!offlineBanner) return;
    offlineBanner.classList.toggle('hidden', navigator.onLine);
    if (!navigator.onLine && offlineMessage) offlineMessage.textContent = 'No connection. Check your internet and try again.';
  };
  updateConnectivity();
  window.addEventListener('offline', updateConnectivity);
  window.addEventListener('online', () => void checkBackendConnectivity());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleAppResume();
  });
  window.TaskFlowApp?.addListener('appStateChange', ({ isActive }) => {
    if (isActive) handleAppResume();
  });
  retryButton?.addEventListener('click', async () => {
    retryButton.disabled = true;
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok || response.status === 401) {
        window.location.reload();
        return;
      }
      throw new Error(`Server returned ${response.status}.`);
    } catch (error) {
      if (offlineMessage) offlineMessage.textContent = 'TaskFlow is still unreachable. Check your connection and retry.';
      retryButton.disabled = false;
    }
  });

  const updateKeyboardViewport = () => {
    const viewport = window.visualViewport;
    const keyboardOpen = Boolean(viewport && window.innerHeight - viewport.height > 120);
    htmlElement.classList.toggle('native-keyboard-open', keyboardOpen);
  };
  window.visualViewport?.addEventListener('resize', updateKeyboardViewport);
  window.addEventListener('resize', updateKeyboardViewport);
  document.addEventListener('focusin', event => {
    if (!event.target.matches('input, select, textarea, [contenteditable="true"]')) return;
    window.setTimeout(() => {
      updateKeyboardViewport();
      event.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }, 250);
  });
  document.addEventListener('focusout', () => window.setTimeout(updateKeyboardViewport, 200));
}

let activeTaskDrawerController = null;
let taskListRequestId = 0;
let activeTaskListController = null;
let taskListPagination = { key: '', afterId: 0, hasMore: false, tasks: [] };
let dashboardSummaryRequestId = 0;
let attendanceHistoryMonth = null;
let attendanceHistoryRequestId = 0;
let forcedPasswordModalOpen = false;
let modalReturnFocus = null;
let modalCloseHandler = null;

function updateCompanyAccessBanner(state, message = '', reasons = []) {
  const app = $('#app');
  if (!app) return;
  let banner = $('#company-access-banner');
  const isTrial = state === 'full' && reasons.includes('trial_active');
  if (!['grace', 'read_only', 'locked'].includes(state) && !isTrial) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'company-access-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    app.prepend(banner);
  }
  banner.className = `company-access-banner ${isTrial ? 'trial' : state}`;
  banner.textContent = message || (state === 'grace'
    ? 'Payment is due. Full access continues during the grace period.'
    : state === 'read_only' ? 'This workspace is read-only.' : 'This workspace is locked.');
}

async function api(path, opts = {}) {
  let res;
  const requestResumeGeneration = nativeAppResumeGeneration;
  try {
    res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (error) {
    if (nativeApp && document.visibilityState !== 'hidden' && requestResumeGeneration === nativeAppResumeGeneration) {
      const banner = $('#mobile-offline-banner');
      const message = $('#mobile-offline-message');
      if (message) message.textContent = 'TaskFlow could not be reached. Check your connection and retry.';
      banner?.classList.remove('hidden');
    }
    throw error;
  }
  if (nativeApp && (res.ok || res.status === 401)) $('#mobile-offline-banner')?.classList.add('hidden');
  const accessState = res.headers.get('X-Company-Access-State');
  if (accessState) {
    let accessReasons = [];
    try { accessReasons = JSON.parse(res.headers.get('X-Company-Access-Reasons') || '[]'); } catch (error) { accessReasons = []; }
    updateCompanyAccessBanner(accessState, res.headers.get('X-Company-Access-Message') || '', accessReasons);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/change-password' && ME) {
    clearNativeDashboardCache();
    ME = null;
    $('#app')?.classList.add('hidden');
    $('#login-screen')?.classList.remove('hidden');
    const loginError = $('#login-error');
    if (loginError) loginError.textContent = 'Your session expired. Please sign in again.';
  }
  if (res.status === 403 && data?.must_change_password) {
    $('#startup-screen')?.classList.add('hidden');
    $('#login-screen')?.classList.add('hidden');
    showSelfPasswordModal(true);
  }
  if (!res.ok) {
    if (data?.access_state) updateCompanyAccessBanner(data.access_state, data.error || '', data.reasons || []);
    const error = new Error((data && data.error) || `Request failed (${res.status} ${res.statusText})`);
    error.status = res.status;
    error.mustChangePassword = Boolean(data?.must_change_password);
    throw error;
  }
  return data;
}

function parseTaskFlowTimestamp(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = parseTaskFlowTimestamp(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = parseTaskFlowTimestamp(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = parseTaskFlowTimestamp(iso);
  return `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function todayISO() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getDueState(dateValue) {
  if (!dateValue) return { className: 'chip-neutral', label: 'No due date' };
  const date = new Date(`${dateValue}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const today = todayISO();
  if (dateValue < today) return { className: 'chip-danger', label: `Overdue · ${date}` };
  if (dateValue === today) return { className: 'chip-warning', label: 'Due today' };
  return { className: 'chip-neutral', label: date };
}

function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0].slice(0, 2)).toUpperCase();
}

const reimbursementStatuses = {
  submitted: { label: 'Submitted', className: 'chip-neutral', step: 0 },
  approved_level_1: { label: 'Level 1 approved', className: 'chip-warning', step: 1 },
  approved: { label: 'Approved', className: 'chip-info', step: 2 },
  paid: { label: 'Paid', className: 'chip-success', step: 3 },
  rejected: { label: 'Rejected', className: 'chip-danger', step: 0 }
};
function reimbursementStatus(status) {
  return reimbursementStatuses[status] || { label: String(status || 'Unknown'), className: 'chip-neutral', step: -1 };
}

// ================= SHARED UI STATES =================
// One look for loading, empty, error, offline, slow and permission states on every screen.
function describeRequestError(error) {
  if (error?.name === 'AbortError') return { kind: 'timeout', title: 'Taking too long', message: 'The connection looks slow. Check your network and try again.' };
  if (error?.status === 401) return { kind: 'session', title: 'Session expired', message: 'Please sign in again to continue.' };
  if (error?.status === 403) return { kind: 'permission', title: 'Access not allowed', message: error.message || 'You do not have permission to see this.' };
  if (error?.status >= 500) return { kind: 'server', title: 'Something went wrong', message: 'The server could not finish this request. Try again in a moment.' };
  if (error instanceof TypeError || navigator.onLine === false) return { kind: 'offline', title: 'No connection', message: 'Check your internet connection and try again.' };
  return { kind: 'error', title: 'Could not load', message: error?.message || 'Something went wrong.' };
}

// Skeleton placeholders: same shape as the real content, so the screen doesn't jump when data arrives.
function uiSkeletonCalendar() {
  const cells = Array.from({ length: 35 }, () => '<span class="ui-skel ui-skel-cell" aria-hidden="true"></span>').join('');
  return `<div class="ui-skeleton" role="status" aria-label="Loading calendar">
    <div class="ui-skel-row ui-skel-heading"><span class="ui-skel ui-skel-arrow"></span><span class="ui-skel ui-skel-title"></span><span class="ui-skel ui-skel-arrow"></span></div>
    <div class="ui-skel-row ui-skel-summary"><span class="ui-skel"></span><span class="ui-skel"></span><span class="ui-skel"></span></div>
    <div class="ui-skel-grid">${cells}</div>
  </div>`;
}

function uiSkeletonRows(count = 5) {
  const rows = Array.from({ length: count }, () => `<div class="ui-skel-line">
    <span class="ui-skel ui-skel-avatar"></span>
    <span class="ui-skel ui-skel-text"></span>
    <span class="ui-skel ui-skel-chip"></span>
  </div>`).join('');
  return `<div class="ui-skeleton" role="status" aria-label="Loading">${rows}</div>`;
}

function uiLoadingState(label = 'Loading...') {
  return `<div class="ui-state ui-state-loading" role="status" aria-live="polite"><span class="ui-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span><small class="ui-state-slow hidden">Still loading. Your connection may be slow.</small></div>`;
}

// Shows the "slow connection" note if loading takes longer than delayMs. Returns a function that cancels it.
function startSlowLoadingHint(container, delayMs = 8000) {
  const timer = setTimeout(() => container?.querySelector('.ui-state-slow')?.classList.remove('hidden'), delayMs);
  return () => clearTimeout(timer);
}

function uiEmptyState({ title, message = '', actionId = '', actionLabel = '' } = {}) {
  return `<div class="ui-state ui-state-empty"><b>${escapeHtml(title)}</b>${message ? `<p>${escapeHtml(message)}</p>` : ''}${actionId ? `<button class="btn btn-primary" id="${actionId}" type="button">${escapeHtml(actionLabel)}</button>` : ''}</div>`;
}

function uiErrorState(error, retryId = '') {
  const info = describeRequestError(error);
  return `<div class="ui-state ui-state-${info.kind}" role="alert"><b>${escapeHtml(info.title)}</b><p>${escapeHtml(info.message)}</p>${retryId ? `<button class="btn btn-secondary" id="${retryId}" type="button">Try again</button>` : ''}</div>`;
}

function showAppNotification(message) {
  const bar = $('#app-notification');
  if (!bar) return;
  bar.textContent = message;
  bar.classList.remove('hidden');
  setTimeout(() => bar.classList.add('hidden'), 4000);
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
  const label = button.querySelector('.nav-label');
  if (label) label.textContent = 'Notifications (new)';
}

async function refreshNotificationsAfterAction() {
  markNotificationsAvailable();
  await renderNotifications();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
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
  return `<a class="comment-file-card" href="${entry.image_path}" target="_blank" rel="noopener"><span class="comment-file-icon">${icon('folder')}</span><span><b>${escapeHtml(name)}</b><small>${escapeHtml(type)} · Download</small></span></a>`;
}

function showModal(html) {
  const modalEl = $('#modal');
  const backdropEl = $('#modal-backdrop');
  if (modalEl && backdropEl) {
    if (!backdropEl.classList.contains('hidden') && modalCloseHandler) {
      const cancelPendingModal = modalCloseHandler;
      modalCloseHandler = null;
      cancelPendingModal();
    }
    if (backdropEl.classList.contains('hidden')) modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalEl.innerHTML = html;
    modalEl.classList.toggle('user-edit-modal', html.includes('user-edit-dialog'));
    modalEl.classList.toggle('receipt-preview-dialog', html.includes('receipt-preview-modal'));
    const title = modalEl.querySelector('h3');
    if (title) {
      title.id = 'modal-title';
      modalEl.setAttribute('aria-labelledby', title.id);
      modalEl.removeAttribute('aria-label');
    } else {
      modalEl.setAttribute('aria-label', 'TaskFlow dialog');
      modalEl.removeAttribute('aria-labelledby');
    }
    backdropEl.classList.remove('hidden');
    requestAnimationFrame(() => {
      const firstControl = modalEl.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]');
      (firstControl || modalEl).focus();
    });
  }
}
function closeModal() { 
  const modalEl = $('#modal');
  const backdropEl = $('#modal-backdrop');
  if (modalEl && backdropEl) {
    backdropEl.classList.add('hidden'); 
    modalEl.innerHTML = ''; 
    modalEl.classList.remove('user-edit-modal', 'receipt-preview-dialog');
  }
  const onClose = modalCloseHandler;
  modalCloseHandler = null;
  onClose?.();
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
  forcedPasswordModalOpen = false;
}

const backdrop = $('#modal-backdrop');
if (backdrop) {
  backdrop.addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop' && !forcedPasswordModalOpen) closeModal(); });
}

document.addEventListener('keydown', event => {
  const modalEl = $('#modal');
  const backdropEl = $('#modal-backdrop');
  if (!modalEl || !backdropEl || backdropEl.classList.contains('hidden')) return;
  if (event.key === 'Escape') {
    if (!forcedPasswordModalOpen) {
      event.preventDefault();
      closeModal();
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(modalEl.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
    .filter(element => element.getClientRects().length);
  if (!focusable.length) {
    event.preventDefault();
    modalEl.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!modalEl.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === modalEl)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function confirmModal(title, body, confirmLabel = 'Delete', danger = true) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      modalCloseHandler = null;
      closeModal();
      resolve(value);
    };
    showModal(`
      <h3>${title}</h3>
      <p class="hint">${body}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="m-ok">${confirmLabel}</button>
      </div>`);
    const cancelBtn = $('#m-cancel');
    const okBtn = $('#m-ok');
    if (cancelBtn) cancelBtn.onclick = () => finish(false);
    if (okBtn) okBtn.onclick = () => finish(true);
    modalCloseHandler = () => {
      if (settled) return;
      settled = true;
      resolve(false);
    };
  });
}

function inputModal(title, label, initialValue = '', type = 'text') {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      modalCloseHandler = null;
      closeModal();
      resolve(value);
    };
    showModal(`
      <h3>${escapeHtml(title)}</h3>
      <label class="field-block" for="modal-input">${escapeHtml(label)}
        <input id="modal-input" type="${type}" value="${escapeHtml(initialValue)}" autocomplete="off">
      </label>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="modal-input-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="modal-input-submit" type="button">Continue</button>
      </div>`);
    const input = $('#modal-input');
    const submit = () => finish(input.value);
    $('#modal-input-submit').onclick = submit;
    $('#modal-input-cancel').onclick = closeModal;
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    modalCloseHandler = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
  });
}

function rejectionModal() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      modalCloseHandler = null;
      closeModal();
      resolve(value);
    };
    showModal(`
      <h3>Reject reimbursement?</h3>
      <p class="hint">Are you sure you want to reject this reimbursement?</p>
      <label>Reason <span class="hint">(optional)</span>
        <textarea id="rejection-reason" rows="3" placeholder="Add a reason if helpful"></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="rejection-cancel">Cancel</button>
        <button class="btn btn-danger" id="rejection-confirm">Reject</button>
      </div>`);
    $('#rejection-cancel').onclick = () => finish(null);
    $('#rejection-confirm').onclick = () => {
      const reason = $('#rejection-reason').value.trim();
      finish(reason);
    };
    modalCloseHandler = () => {
      if (settled) return;
      settled = true;
      resolve(null);
    };
  });
}

function closeDrawer() {
  activeTaskDrawerController?.abort();
  activeTaskDrawerController = null;
  $$('.task-row.is-selected').forEach(row => row.classList.remove('is-selected'));
  const drawer = $('#task-drawer');
  if (drawer) drawer.classList.add('hidden');
  const reimbursementDrawer = $('#reimbursement-drawer');
  if (reimbursementDrawer) reimbursementDrawer.classList.add('hidden');
  const app = $('#app');
  if (app) app.classList.remove('drawer-open');
}
$('#reimbursement-drawer-floating-close')?.addEventListener('click', closeDrawer);
$('#reimbursement-drawer-floating-close-label')?.addEventListener('click', closeDrawer);

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
  const status = reimbursementStatus(row.status);
  const statusElement = $('#reimbursement-detail-status');
  statusElement.textContent = status.label;
  statusElement.className = `chip ${status.className}`;
  const stepElement = $('#reimbursement-detail-steps');
  const stepLabels = ['Submitted', 'Level 1', 'Level 2', 'Paid'];
  stepElement.classList.toggle('is-rejected', row.status === 'rejected');
  stepElement.innerHTML = stepLabels.map((label, index) => `<div class="reimbursement-step ${index < status.step ? 'complete' : ''} ${index === status.step ? 'current' : ''}"><span>${index < status.step ? '✓' : index + 1}</span><small>${label}</small></div>`).join('');
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
  let rotation = 0;
  let offsetX = 0;
  let offsetY = 0;
  const render = () => {
    showModal(`
      <div class="receipt-preview-modal">
        <div class="receipt-preview-toolbar">
          <span>Receipt ${index + 1} of ${urls.length}</span>
          <div>
            <button class="btn btn-secondary btn-sm" id="receipt-zoom-out" type="button">−</button>
            <button class="btn btn-secondary btn-sm" id="receipt-zoom-in" type="button">+</button>
            <button class="btn btn-secondary btn-sm" id="receipt-rotate-left" type="button" aria-label="Rotate counterclockwise" title="Rotate counterclockwise">↶</button>
            <button class="btn btn-secondary btn-sm" id="receipt-rotate-right" type="button" aria-label="Rotate clockwise" title="Rotate clockwise">↻</button>
            <button class="btn btn-secondary btn-sm" id="receipt-preview-reset" type="button">Reset</button>
            <button class="btn btn-secondary btn-sm" id="receipt-preview-close" type="button">Close</button>
          </div>
        </div>
        <div class="receipt-preview-stage"><img id="receipt-preview-image" src="${urls[index]}" alt="Receipt preview" draggable="false"></div>
        ${urls.length > 1 ? `<div class="receipt-preview-navigation"><button class="btn btn-secondary btn-sm" id="receipt-prev" type="button" ${index === 0 ? 'disabled' : ''}>Previous</button><button class="btn btn-secondary btn-sm" id="receipt-next" type="button" ${index === urls.length - 1 ? 'disabled' : ''}>Next</button></div>` : ''}
      </div>`);
    const image = $('#receipt-preview-image');
    const stage = $('.receipt-preview-stage');
    const activePointers = new Map();
    let dragStart = null;
    let pinchStart = null;
    const clampScale = value => Math.max(.5, Math.min(6, value));
    const updateTransform = () => {
      image.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg) scale(${scale})`;
      image.style.cursor = activePointers.size ? 'grabbing' : 'grab';
    };
    const resetTransform = () => {
      scale = 1;
      rotation = 0;
      offsetX = 0;
      offsetY = 0;
      updateTransform();
    };
    const pointerDistance = () => {
      const [first, second] = [...activePointers.values()];
      return Math.hypot(second.x - first.x, second.y - first.y);
    };
    stage.addEventListener('wheel', event => {
      event.preventDefault();
      scale = clampScale(scale * Math.exp(-event.deltaY * .001));
      updateTransform();
    }, { passive: false });
    stage.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      stage.setPointerCapture(event.pointerId);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.size === 1) {
        dragStart = { x: event.clientX, y: event.clientY, offsetX, offsetY };
      } else {
        dragStart = null;
        pinchStart = { distance: pointerDistance(), scale };
      }
      updateTransform();
    });
    stage.addEventListener('pointermove', event => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (activePointers.size > 1 && pinchStart) {
        scale = clampScale(pinchStart.scale * pointerDistance() / Math.max(1, pinchStart.distance));
      } else if (dragStart) {
        offsetX = dragStart.offsetX + event.clientX - dragStart.x;
        offsetY = dragStart.offsetY + event.clientY - dragStart.y;
      }
      updateTransform();
    });
    const finishPointer = event => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.delete(event.pointerId);
      pinchStart = null;
      if (activePointers.size === 1) {
        const remaining = [...activePointers.values()][0];
        dragStart = { x: remaining.x, y: remaining.y, offsetX, offsetY };
      } else {
        dragStart = null;
      }
      updateTransform();
    };
    stage.addEventListener('pointerup', finishPointer);
    stage.addEventListener('pointercancel', finishPointer);
    $('#receipt-preview-close').onclick = closeModal;
    $('#receipt-zoom-out').onclick = () => { scale = clampScale(scale - .25); updateTransform(); };
    $('#receipt-zoom-in').onclick = () => { scale = clampScale(scale + .25); updateTransform(); };
    $('#receipt-rotate-left').onclick = () => { rotation = (rotation - 90 + 360) % 360; updateTransform(); };
    $('#receipt-rotate-right').onclick = () => { rotation = (rotation + 90) % 360; updateTransform(); };
    $('#receipt-preview-reset').onclick = resetTransform;
    $('#receipt-prev')?.addEventListener('click', () => { index -= 1; resetTransform(); render(); });
    $('#receipt-next')?.addEventListener('click', () => { index += 1; resetTransform(); render(); });
    updateTransform();
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
let supportModeTimer = null;
let PROJECTS = [];
let PROJECT_ACTION_ACCESS = {};
let projectActionRefreshInProgress = false;
let PEOPLE = [];
let CURRENT_PROJECT = null;
let CURRENT_TASK_ID = null;
const unlockedProjects = new Set();

async function refreshProjectActionAccess() {
  if (!ME || projectActionRefreshInProgress) return;
  projectActionRefreshInProgress = true;
  try {
    const access = await api('/project-action-access/me');
    if (JSON.stringify(access) === JSON.stringify(PROJECT_ACTION_ACCESS)) return;
    PROJECT_ACTION_ACCESS = access;
    const drawer = $('#task-drawer');
    if (drawer && !drawer.classList.contains('hidden')) {
      showAppNotification('Task permissions changed. Close and reopen this task to apply them.');
      return;
    }
    const activeView = $$('.view').find(view => !view.classList.contains('hidden'));
    if (activeView?.id.startsWith('view-')) showView(activeView.id.slice(5));
  } catch (error) {
    console.warn('Project permission refresh failed:', error.message);
  } finally {
    projectActionRefreshInProgress = false;
  }
}

window.addEventListener('focus', refreshProjectActionAccess);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshProjectActionAccess();
});
setInterval(() => {
  if (document.visibilityState === 'visible') refreshProjectActionAccess();
}, 60000);

let attendancePollTimer = null;
let attendanceClockTimer = null;
let notificationsPollTimer = null;
let notificationsPollBusy = false;
let knownActivityNotificationKeys = null;
let notificationSequence = 0;
let taskListPollTimer = null;
let taskListPollBusy = false;
let taskListVisibilityHandler = null;
let hideTaskSearchSuggestions = () => {};
let latestNotificationId = null;
let pendingSearchTaskId = null;
let liveTrackingTimer = null;
let liveTrackingBusy = false;
let pushListenersRegistered = false;
let pushBackendEnabled = false;
let pushTokenRegistered = false;
let registeredPushToken = null;
const deliveredPushActivityIds = new Set();
let selectedTrackingUserId = null;

// ---------- live tracking data synchronization ----------
function startAttendancePolling() {
  stopAttendancePolling();
  attendancePollTimer = setInterval(() => {
    if (document.hidden) return; 
    renderHistory();
    renderPunchCard();
    if (nativeApp) void syncLiveTracking();
  }, 15000); 
}

// 🟢 CHANGE 1: Clear polling cleanly on session changes
function stopAttendancePolling() {
  if (attendancePollTimer) {
    clearInterval(attendancePollTimer);
    attendancePollTimer = null;
  }
}

function stopAttendanceClock() {
  if (attendanceClockTimer) {
    clearInterval(attendanceClockTimer);
    attendanceClockTimer = null;
  }
}

function stopLiveTracking() {
  const wasTracking = Boolean(liveTrackingTimer);
  if (liveTrackingTimer) {
    clearInterval(liveTrackingTimer);
    liveTrackingTimer = null;
  }
  liveTrackingBusy = false;
  if (wasTracking) window.TaskFlowActivityRecognition?.stopUpdates?.().catch(error => console.warn('Activity recognition stop failed:', error.message));
}

async function getTravelActivity(startUpdates = false) {
  const plugin = window.TaskFlowActivityRecognition;
  if (!window.Capacitor?.isNativePlatform?.() || !plugin) return { activity_type: 'unknown', activity_confidence: 0 };
  try {
    if (startUpdates) await plugin.startUpdates();
    const activity = await plugin.getCurrentActivity();
    if (!activity?.updated_at || Date.now() - Number(activity.updated_at) > 10 * 60 * 1000) {
      return { activity_type: 'unknown', activity_confidence: 0 };
    }
    return {
      activity_type: String(activity.type || 'unknown'),
      activity_confidence: Number(activity.confidence) || 0
    };
  } catch (error) {
    console.warn('Physical activity recognition unavailable; continuing with GPS only:', error.message);
    return { activity_type: 'unknown', activity_confidence: 0 };
  }
}

function startLiveTracking() {
  if (liveTrackingTimer || !isPhoneDevice()) return;
  if (nativeApp) return;
  getTravelActivity(true);
  liveTrackingTimer = setInterval(async () => {
    if (document.hidden || liveTrackingBusy) return;
    liveTrackingBusy = true;
    try {
      const coords = await getLiveCoords();
      const devicePayload = await getPunchDevicePayload();
      const activityPayload = await getTravelActivity();
      await api('/attendance/location-update', { method: 'POST', body: { ...coords, ...devicePayload, ...activityPayload } });
    } catch (error) {
      if (/active shift|punched out/i.test(error.message)) stopLiveTracking();
      else console.warn('Live location update failed:', error.message);
    } finally {
      liveTrackingBusy = false;
    }
  }, 5 * 60 * 1000);
}

const trackingStatusQueueKey = 'taskflow.attendance.tracking-status.queue';
const backgroundTrackingOptOutKey = 'taskflow.attendance.background-opt-out-date';
let lastTrackingHealthState = null;
let trackingStatusFlushPromise = null;
let backgroundTrackingPluginUnavailable = false;

function showBackgroundTrackingAppUpdateRequired() {
  backgroundTrackingPluginUnavailable = true;
  setTrackingHealthBanner('This installed TaskFlow app does not include background tracking. Install the latest APK; changing permissions cannot fix this version.', true);
  const button = $('#attendance-tracking-health-settings');
  if (button) button.textContent = 'Update app';
}

function hasDeclinedBackgroundTracking(shiftDate = todayISO()) {
  return localStorage.getItem(backgroundTrackingOptOutKey) === shiftDate;
}

function setBackgroundTrackingOptOut(shiftDate = todayISO()) {
  localStorage.setItem(backgroundTrackingOptOutKey, shiftDate);
}

function setTrackingHealthBanner(message, visible) {
  const banner = $('#attendance-tracking-health-banner');
  const label = $('#attendance-tracking-health-message');
  if (label && message) label.textContent = message;
  banner?.classList.toggle('hidden', !visible);
}

async function stopNativeShiftTracking() {
  if (!nativeApp) return { ok: true, flushed: true };
  const plugin = window.TaskFlowBackgroundLocation;
  if (!plugin?.stopTracking) {
    console.warn('Background tracking could not be stopped because the native plugin is unavailable.');
    return { ok: false, flushed: false };
  }
  return plugin.stopTracking();
}

async function reportTrackingHealthState(state) {
  if (lastTrackingHealthState === state) return;
  lastTrackingHealthState = state;
  try {
    const queued = JSON.parse(localStorage.getItem(trackingStatusQueueKey) || '[]');
    queued.push({ state, at: new Date().toISOString() });
    localStorage.setItem(trackingStatusQueueKey, JSON.stringify(queued.slice(-20)));
  } catch (error) {
    console.warn('Unable to queue attendance tracking status:', error.message);
  }
  await flushTrackingHealthEvents();
}

async function flushTrackingHealthEvents() {
  if (trackingStatusFlushPromise || !navigator.onLine) return trackingStatusFlushPromise;
  trackingStatusFlushPromise = (async () => {
    let queued;
    try {
      queued = JSON.parse(localStorage.getItem(trackingStatusQueueKey) || '[]');
    } catch (error) {
      console.warn('Unable to read queued attendance tracking status:', error.message);
      localStorage.removeItem(trackingStatusQueueKey);
      return;
    }
    while (queued.length) {
      try {
        await api('/attendance/tracking-status', { method: 'POST', body: queued[0] });
        queued.shift();
        localStorage.setItem(trackingStatusQueueKey, JSON.stringify(queued));
      } catch (error) {
        if (error.status && error.status < 500) {
          console.warn('Attendance tracking status was rejected:', error.message);
          queued.shift();
          localStorage.setItem(trackingStatusQueueKey, JSON.stringify(queued));
          continue;
        }
        return;
      }
    }
  })().finally(() => { trackingStatusFlushPromise = null; });
  return trackingStatusFlushPromise;
}

async function requestNativeBackgroundTrackingPermission() {
  const plugin = window.TaskFlowBackgroundLocation;
  if (!nativeApp || !plugin) {
    setTrackingHealthBanner('Update TaskFlow to enable background shift tracking. Punch-in still works, but location history may have gaps.', true);
    return false;
  }
  try {
    const current = await plugin.getPermissionStatus();
    const consent = await confirmModal(
      'Background location during your shift',
      'TaskFlow records location only while you are punched in, including when the app is locked or in the background. Location is stored in TaskFlow, not sent to Telegram. You can still punch in without this permission, but your location history may have gaps.',
      'Continue',
      false
    );
    if (!consent) {
      setBackgroundTrackingOptOut();
      return false;
    }
    localStorage.removeItem(backgroundTrackingOptOutKey);
    if (current.always) return true;
    const permission = await plugin.requestBackgroundPermission();
    if (!permission?.always) {
      setBackgroundTrackingOptOut();
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Background location permission was not granted:', error.message);
    setBackgroundTrackingOptOut();
    return false;
  }
}

async function requestTrackingNotificationPermission() {
  if (!nativeApp || !/Android/i.test(navigator.userAgent)) return true;
  const plugin = window.TaskFlowLocalNotifications;
  if (!plugin?.checkPermissions || !plugin?.requestPermissions) return false;
  try {
    let permission = await plugin.checkPermissions();
    if (permission.display === 'granted') return true;
    const consent = await confirmModal(
      'Show shift tracking notification',
      'Android uses a visible ongoing notification while TaskFlow records your location during an active shift.',
      'Allow notifications',
      false
    );
    if (!consent) return false;
    permission = await plugin.requestPermissions();
    return permission.display === 'granted';
  } catch (error) {
    console.warn('Shift tracking notification permission is unavailable:', error.message);
    return false;
  }
}

async function startNativeShiftTracking(shiftDate = todayISO()) {
  if (!nativeApp) return false;
  if (hasDeclinedBackgroundTracking(shiftDate)) {
    setTrackingHealthBanner('Background tracking was declined for this shift. Punch out and start a new shift if you want to enable it.', true);
    return false;
  }
  const plugin = window.TaskFlowBackgroundLocation;
  if (!plugin) {
    setTrackingHealthBanner('Update TaskFlow to enable background shift tracking. Location may stop when the app is locked.', true);
    return false;
  }
  const permission = await plugin.getPermissionStatus();
  if (!permission?.always) {
    setTrackingHealthBanner('Background location is off. Your location history may have gaps while the app is locked.', true);
    await reportTrackingHealthState('background_location_off');
    return false;
  }
  if (!permission.gps_enabled) {
    setTrackingHealthBanner('Location/GPS is off. Turn it on to continue shift tracking.', true);
    await reportTrackingHealthState('gps_off');
    return false;
  }
  const devicePayload = await getPunchDevicePayload();
  await plugin.startTracking({
    server_url: location.origin,
    device_id: devicePayload.device_id,
    device_model: devicePayload.device_model || 'Mobile device',
    shift_date: shiftDate
  });
  setTrackingHealthBanner('', false);
  await reportTrackingHealthState('restored');
  return true;
}

async function updateNativeTrackingHealth(active) {
  const banner = $('#attendance-tracking-health-banner');
  if (!nativeApp || !banner) return;
  if (!active) {
    setTrackingHealthBanner('', false);
    lastTrackingHealthState = null;
    return;
  }
  if (hasDeclinedBackgroundTracking()) {
    setTrackingHealthBanner('Background tracking was declined for this shift. Punch out and start a new shift if you want to enable it.', true);
    await reportTrackingHealthState('background_location_off');
    return;
  }
  if (!navigator.onLine) {
    try {
      const status = await window.TaskFlowBackgroundLocation?.getPermissionStatus?.();
      if (Number(status?.queued_points) >= 1000) {
        setTrackingHealthBanner('The offline location queue is full. Reconnect to upload saved points; new samples are paused.', true);
        await reportTrackingHealthState('offline_queue_full');
      } else {
        setTrackingHealthBanner('No connection. Location points are saved on this device and will upload when the connection returns.', true);
        await reportTrackingHealthState('offline');
      }
    } catch (error) {
      console.warn('Unable to check queued tracking points while offline:', error.message);
      setTrackingHealthBanner('No connection. Location points are saved on this device and will upload when the connection returns.', true);
      await reportTrackingHealthState('offline');
    }
    return;
  }
  try {
    const plugin = window.TaskFlowBackgroundLocation;
    if (!plugin?.getPermissionStatus) {
      setTrackingHealthBanner('Update the TaskFlow app to enable background shift tracking. Location may stop when the app is locked.', true);
      await reportTrackingHealthState('background_location_off');
      return;
    }
    const status = await plugin.getPermissionStatus();
    if (Number(status.queued_points) >= 1000) {
      setTrackingHealthBanner('The offline location queue is full. Reconnect to upload saved points; new samples are paused.', true);
      await reportTrackingHealthState('offline_queue_full');
    } else if (!status.gps_enabled) {
      setTrackingHealthBanner('Location/GPS is off. Turn it on to continue shift tracking.', true);
      await reportTrackingHealthState('gps_off');
    } else if (!status.always) {
      setTrackingHealthBanner('Background location is off. Your location history may have gaps while the app is locked.', true);
      await reportTrackingHealthState('background_location_off');
    } else if (status.accuracy === 'approximate') {
      setTrackingHealthBanner('Precise location is off. TaskFlow may record less accurate shift locations.', true);
      await reportTrackingHealthState('approximate_location');
    } else if (status.notifications_enabled === false) {
      setTrackingHealthBanner('Notifications are off. Android may hide the ongoing shift-tracking notification; GPS tracking can continue.', true);
      await reportTrackingHealthState('notification_off');
    } else if (status.activity_enabled === false) {
      setTrackingHealthBanner('Activity recognition is off. GPS tracking continues, but travel type will be unavailable.', true);
      await reportTrackingHealthState('activity_off');
    } else {
      setTrackingHealthBanner('', false);
      await reportTrackingHealthState('restored');
    }
  } catch (error) {
    console.warn('Unable to check background tracking health:', error.message);
    setTrackingHealthBanner('Unable to check location tracking. Open settings to review TaskFlow permissions.', true);
  }
}

$('#attendance-tracking-health-settings')?.addEventListener('click', async () => {
  const button = $('#attendance-tracking-health-settings');
  if (backgroundTrackingPluginUnavailable) {
    setTrackingHealthBanner('Install the latest TaskFlow APK to add background tracking support. Android permissions alone cannot add the missing feature.', true);
    return;
  }
  if (!nativeApp || !window.TaskFlowBackgroundLocation) {
    setTrackingHealthBanner('Update or reopen the TaskFlow app to manage background location settings.', true);
    return;
  }
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.textContent = 'Checking...';
  }
  try {
    const plugin = window.TaskFlowBackgroundLocation;
    localStorage.removeItem(backgroundTrackingOptOutKey);
    let permission = await plugin.getPermissionStatus();
    if (!permission?.always) {
      try {
        permission = await plugin.requestBackgroundPermission();
      } catch (error) {
        console.warn('Background location permission request could not be shown:', error.message);
      }
    }
    if (!permission?.always || !permission.gps_enabled) {
      await plugin.openAppSettings();
      setTrackingHealthBanner(
        !permission?.always
          ? 'In TaskFlow app settings, set Location to Allow all the time, then return to TaskFlow.'
          : 'Turn on Location Services in your phone settings, then return to TaskFlow.',
        true
      );
      return;
    }

    const shift = await api('/attendance/today');
    const active = Boolean(shift?.punch_in && !shift.punch_out);
    if (active && !permission.active) {
      await startNativeShiftTracking(shift.date || todayISO());
    }
    await updateNativeTrackingHealth(active);
    if (active && (permission.notifications_enabled === false || permission.activity_enabled === false)) {
      await plugin.openAppSettings();
    }
  } catch (error) {
    console.warn('Unable to open location settings:', error.message);
    if (/BackgroundLocation.*plugin is not implemented/i.test(error.message)) {
      showBackgroundTrackingAppUpdateRequired();
    } else {
      setTrackingHealthBanner(`Unable to fix background tracking settings: ${error.message}`, true);
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = backgroundTrackingPluginUnavailable ? 'Update app' : 'Fix settings';
    }
  }
});

window.addEventListener('online', () => { void flushTrackingHealthEvents(); });
window.TaskFlowApp?.addListener('appStateChange', ({ isActive }) => {
  if (isActive) void syncLiveTracking();
});

async function syncLiveTracking() {
  if (!isPhoneDevice()) return;
  try {
    const status = await api('/attendance/today');
    const active = Boolean(status?.punch_in && !status.punch_out);
    if (nativeApp) {
      if (!active) {
        stopLiveTracking();
        const trackingStatus = await window.TaskFlowBackgroundLocation?.getPermissionStatus?.();
        if (trackingStatus?.active) await stopNativeShiftTracking();
        await updateNativeTrackingHealth(false);
        return;
      }
      await updateNativeTrackingHealth(true);
      const permission = await window.TaskFlowBackgroundLocation?.getPermissionStatus?.();
      if (!hasDeclinedBackgroundTracking(status.date || todayISO())
          && permission?.always && permission.gps_enabled && !permission.active) {
        await startNativeShiftTracking(status.date || todayISO());
      }
      return;
    }
    if (active) startLiveTracking();
    else stopLiveTracking();
  } catch (error) {
    console.warn('Live tracking status check failed:', error.message);
  }
}

function startNotificationsPolling() {
  stopNotificationsPolling();
  const pollActivity = async () => {
    if (document.hidden || currentViewName() === 'notifications' || notificationsPollBusy) return;
    notificationsPollBusy = true;
    try {
      const entries = await api('/auth/activity');
      const keys = new Set(entries.map(entry => `${entry.entity_type || ''}:${entry.id}:${entry.action}:${entry.created_at}`));
      if (knownActivityNotificationKeys !== null) {
        const newEntries = entries.filter(entry => !knownActivityNotificationKeys.has(`${entry.entity_type || ''}:${entry.id}:${entry.action}:${entry.created_at}`));
        if (newEntries.length) {
          markNotificationsAvailable();
          await showNativeActivityNotifications(newEntries);
        }
      }
      knownActivityNotificationKeys = keys;
      const newestId = entries.length ? Math.max(...entries.map(entry => Number(entry.id) || 0)) : 0;
      latestNotificationId = Math.max(latestNotificationId || 0, newestId);
    } catch (error) {
      // Notifications are supplementary and should not interrupt the current screen.
    } finally {
      notificationsPollBusy = false;
    }
  };
  pollActivity();
  notificationsPollTimer = setInterval(pollActivity, 60000);
}

async function requestNativeNotificationPermission() {
  const notifications = window.TaskFlowLocalNotifications;
  if (!window.Capacitor?.isNativePlatform?.() || !notifications) return false;
  try {
    let permission = await notifications.checkPermissions();
    if (permission.display !== 'granted') permission = await notifications.requestPermissions();
    const push = window.TaskFlowPushNotifications;
    if (push) {
      if (!pushListenersRegistered) {
        await push.addListener('registration', async token => {
          try {
            registeredPushToken = token.value;
            await api('/auth/push/register', { method: 'POST', body: { token: token.value, platform: window.Capacitor.getPlatform() } });
            pushTokenRegistered = true;
          } catch (error) {
            console.warn('Push token registration failed:', error.message);
          }
        });
        await push.addListener('registrationError', error => console.warn('Push registration failed:', error.error || 'Firebase configuration is missing.'));
        await push.addListener('pushNotificationReceived', notification => {
          const activityId = notification.data?.activity_id;
          if (activityId) deliveredPushActivityIds.add(String(activityId));
          showAppNotification(notification.body || notification.title || 'TaskFlow has a new update.');
        });
        await push.addListener('pushNotificationActionPerformed', () => showView('notifications'));
        pushListenersRegistered = true;
      }
      let pushPermission = await push.checkPermissions();
      if (pushPermission.receive !== 'granted') pushPermission = await push.requestPermissions();
      if (pushPermission.receive === 'granted') {
        try {
          const config = await api('/auth/push/config');
          pushBackendEnabled = !!config.enabled;
        } catch { pushBackendEnabled = false; }
        if (pushBackendEnabled) {
          if (window.Capacitor.getPlatform() === 'android') {
            try {
              await push.createChannel({
                id: 'taskflow-updates',
                name: 'TaskFlow updates',
                description: 'Task and expense updates',
                importance: 4,
                visibility: 1
              });
            } catch (error) {
              console.warn('Notification channel setup failed:', error.message);
            }
          }
          await push.register();
        }
      }
    }
    return permission.display === 'granted';
  } catch (error) {
    console.warn('Notification permission request failed:', error.message);
    return false;
  }
}

async function unregisterPushToken() {
  const push = window.TaskFlowPushNotifications;
  if (registeredPushToken) {
    try { await api('/auth/push/register', { method: 'DELETE', body: { token: registeredPushToken } }); }
    catch (error) { console.warn('Push token removal failed:', error.message); }
  }
  if (pushBackendEnabled && push) {
    try { await push.unregister(); } catch (error) { console.warn('Device push unregister failed:', error.message); }
  }
  registeredPushToken = null;
  pushTokenRegistered = false;
  pushBackendEnabled = false;
}

async function showNativeActivityNotifications(entries) {
  const notifications = window.TaskFlowLocalNotifications;
  if (!notifications || !window.Capacitor?.isNativePlatform?.()) return;
  if (pushBackendEnabled && pushTokenRegistered) return;
  try {
    const permission = await notifications.checkPermissions();
    if (permission.display !== 'granted') return;
    const pendingEntries = entries.filter(entry => !deliveredPushActivityIds.has(String(entry.id)));
    if (!pendingEntries.length) return;
    await notifications.schedule({
      notifications: pendingEntries.slice(0, 5).map(entry => {
        notificationSequence = (notificationSequence + 1) % 1000;
        return {
          id: (Date.now() + notificationSequence) % 2147483647,
          title: String(entry.action || 'TaskFlow update').slice(0, 80),
          body: [entry.actor_name, entry.details].filter(Boolean).join(' · ').slice(0, 180),
          schedule: { at: new Date(Date.now() + 1000) }
        };
      })
    });
  } catch (error) {
    console.warn('Activity notification could not be displayed:', error.message);
  }
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

function clearNativeDashboardCache() {
  try { localStorage.removeItem(nativeDashboardCacheKey); } catch (error) { }
  const app = $('#app');
  if (!app) return;
  app.classList.remove('native-dashboard-preview');
  app.removeAttribute('aria-busy');
  app.inert = false;
  app.style.pointerEvents = '';
}

function saveNativeDashboardCache() {
  if (!nativeApp || !ME?.id) return;
  const summary = $('#dashboard-summary');
  const projects = $('#dashboard-projects');
  if (!summary || !projects) return;
  const cached = {
    version: 1,
    savedAt: Date.now(),
    displayName: String(ME.name || ''),
    greetingText: $('#dashboard-greeting-text')?.textContent || '',
    dateText: $('#dashboard-date-text')?.textContent || '',
    summaryHtml: summary.innerHTML,
    projectsHtml: projects.innerHTML,
    adminVisible: ME.role === 'admin',
    trackingVisible: $('#dashboard-tracking-card')?.style.display !== 'none',
    paymentVisible: $('#dashboard-payment-history-card')?.style.display !== 'none',
    storageVisible: $('#dashboard-storage-card')?.style.display !== 'none'
  };
  try { localStorage.setItem(nativeDashboardCacheKey, JSON.stringify(cached)); } catch (error) { }
}

function restoreNativeDashboardPreview() {
  if (!nativeApp) return false;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(nativeDashboardCacheKey) || 'null'); } catch (error) { }
  if (!cached || cached.version !== 1 || !Number.isFinite(Number(cached.savedAt))
    || Date.now() - Number(cached.savedAt) > 14 * 24 * 60 * 60 * 1000
    || typeof cached.summaryHtml !== 'string' || typeof cached.projectsHtml !== 'string') {
    clearNativeDashboardCache();
    return false;
  }

  const app = $('#app');
  const dashboard = $('#view-dashboard');
  const summary = $('#dashboard-summary');
  const projects = $('#dashboard-projects');
  if (!app || !dashboard || !summary || !projects) return false;
  summary.innerHTML = cached.summaryHtml;
  projects.innerHTML = cached.projectsHtml;
  $('#dashboard-greeting-text').textContent = cached.greetingText || 'TaskFlow';
  $('#dashboard-date-text').textContent = cached.dateText || '';
  $('#me-badge').innerHTML = `Signed in as<br><b>${escapeHtml(cached.displayName || '')}</b>`;
  $('#dashboard-admin-card')?.style.setProperty('display', cached.adminVisible ? '' : 'none');
  $('#dashboard-tracking-card')?.style.setProperty('display', cached.trackingVisible ? '' : 'none');
  $('#dashboard-payment-history-card')?.style.setProperty('display', cached.paymentVisible ? '' : 'none');
  $('#dashboard-storage-card')?.style.setProperty('display', cached.storageVisible ? '' : 'none');
  $$('#app .view').forEach(view => view.classList.toggle('hidden', view !== dashboard));
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === 'dashboard'));
  $$('.mobile-tab[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === 'dashboard'));
  $('#mobile-page-title').textContent = 'TaskFlow';
  app.classList.remove('hidden', 'booting');
  app.classList.add('dashboard-view', 'focused-view', 'native-dashboard-preview');
  app.setAttribute('aria-busy', 'true');
  app.inert = true;
  app.style.pointerEvents = 'none';
  $('#startup-screen')?.classList.add('hidden');
  $('#login-screen')?.classList.add('hidden');
  return true;
}

// ---------- boot backend authentication initialization ----------
function setLoginStatus(element, message, state = '') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('is-error', state === 'error');
  element.classList.toggle('is-success', state === 'success');
}

async function getLoginDevicePayload() {
  if (!window.Capacitor?.isNativePlatform?.()) return {};
  if (!window.TaskFlowAppDevice?.getIdentity) throw new Error('Update the TaskFlow app before signing in.');
  return window.TaskFlowAppDevice.getIdentity();
}

(async function init() {
  const cachedDashboardPreview = restoreNativeDashboardPreview();
  const startupController = new AbortController();
  const startupTimeout = setTimeout(() => startupController.abort(), nativeApp ? 15_000 : 90_000);
  try {
    const rawMe = await api('/auth/me', { signal: startupController.signal });
    // Unrolls any array wrappers returned from cloud proxies
    ME = Array.isArray(rawMe) ? rawMe[0] : rawMe;
    if (ME.must_change_password) {
      showSelfPasswordModal(true);
      return;
    }
    enterApp();
  } catch (e) {
    if (e.mustChangePassword) return;
    if (e.status !== 401) {
      if (nativeApp && cachedDashboardPreview) {
        const banner = $('#mobile-offline-banner');
        const message = $('#mobile-offline-message');
        if (message) message.textContent = 'Showing the last saved dashboard. Retry to refresh.';
        banner?.classList.remove('hidden');
        const app = $('#app');
        if (app) { app.inert = false; app.style.pointerEvents = ''; app.removeAttribute('aria-busy'); }
      } else {
        $('#startup-message').textContent = nativeApp
          ? (e.name === 'AbortError'
            ? 'Could not restore your session yet. Check your connection and retry.'
            : 'Unable to connect. Check your connection and retry.')
          : (e.name === 'AbortError'
            ? 'TaskFlow is taking longer than expected to respond. Please try again.'
            : 'Unable to connect. Check your connection and try again.');
        $('#startup-retry').classList.remove('hidden');
      }
    } else {
      clearNativeDashboardCache();
      $('#startup-screen').classList.add('hidden');
      $('#app')?.classList.add('hidden');
      $('#login-screen')?.classList.remove('hidden');
    }
  } finally {
    clearTimeout(startupTimeout);
  }
})();
$('#startup-retry').onclick = () => location.reload();

const loginForm = $('#login-form');
if (loginForm) {
  const companyField = $('#login-company-code');
  if (companyField) companyField.value = localStorage.getItem('taskflow.companyCode') || '';
  const emailLoginRequestForm = $('#email-login-request-form');
  const emailLoginVerifyForm = $('#email-login-verify-form');
  const saveCompanyCode = () => {
    const companyCode = companyField?.value.trim() || '';
    if (companyCode) localStorage.setItem('taskflow.companyCode', companyCode);
    else localStorage.removeItem('taskflow.companyCode');
    return companyCode;
  };
  emailLoginRequestForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('#email-login-request-status');
    const email = $('#email-login-address').value.trim();
    setLoginStatus(status, '');
    try {
      const result = await api('/auth/email/login/request', {
        method: 'POST',
        body: { email, company_code: saveCompanyCode() }
      });
      setLoginStatus(status, result.message, 'success');
      emailLoginVerifyForm?.classList.remove('hidden');
      $('#email-login-code')?.focus();
    } catch (error) {
      setLoginStatus(status, error.message, 'error');
    }
  });
  emailLoginVerifyForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('#email-login-verify-status');
    setLoginStatus(status, '');
    try {
      ME = await api('/auth/email/login/verify', {
        method: 'POST',
        body: {
          email: $('#email-login-address').value.trim(),
          code: $('#email-login-code').value.trim(),
          company_code: saveCompanyCode(),
          ...await getLoginDevicePayload()
        }
      });
      if (ME.must_change_password) showSelfPasswordModal(true);
      else enterApp();
    } catch (error) {
      setLoginStatus(status, error.message, 'error');
    }
  });
  $('#email-login-toggle')?.addEventListener('click', () => {
    const emailLoginVisible = !emailLoginRequestForm?.classList.contains('hidden');
    emailLoginRequestForm?.classList.toggle('hidden', emailLoginVisible);
    emailLoginVerifyForm?.classList.add('hidden');
    loginForm.classList.toggle('hidden', !emailLoginVisible);
    $('#email-login-toggle').textContent = emailLoginVisible
      ? 'Use username and password instead'
      : 'Use email code instead';
  });
  const authReason = new URLSearchParams(location.hash.slice(1)).get('auth');
  const authMessages = {
    google_unavailable: 'Google sign-in is not configured for this TaskFlow service.',
    google_cancelled: 'Google sign-in was cancelled.',
    google_suspended: 'This company workspace is suspended. Contact support.',
    google_billing_required: 'This workspace is locked. Contact your administrator.',
    google_account_unavailable: 'No active TaskFlow account is linked to that verified Google email. Ask your administrator to add and verify your email first.',
    web_login_not_allowed: 'Web access is disabled for this account. Ask your company admin to enable it.',
    app_device_mismatch: 'This app installation has a different device identity. Ask an admin to use Reset all app sign-in devices under Team members & admin access. This is separate from attendance device access.',
    app_device_id_required: 'TaskFlow could not identify this app installation. Update the app and try again.',
    google_failed: 'Google sign-in could not be completed. Try again.'
  };
  if (authReason && authMessages[authReason]) {
    const errorEl = $('#login-error');
    if (errorEl) errorEl.textContent = authMessages[authReason];
    history.replaceState(null, document.title, `${location.pathname}${location.search}`);
  }
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = $('#login-error');
    if (errorEl) errorEl.textContent = '';
    
    const userField = $('#login-username');
    const passField = $('#login-password');
    if (!userField || !passField) return;
    if (companyField?.value.trim()) localStorage.setItem('taskflow.companyCode', companyField.value.trim());
    else localStorage.removeItem('taskflow.companyCode');

    try {
      const rawLogin = await api('/auth/login', {
        method: 'POST',
        body: {
          username: userField.value.trim(),
          password: passField.value,
          company_code: companyField?.value.trim() || '',
          ...await getLoginDevicePayload()
        },
      });
      ME = Array.isArray(rawLogin) ? rawLogin[0] : rawLogin;
      if (ME.must_change_password) showSelfPasswordModal(true);
      else enterApp();
    } catch (err) {
      if (errorEl) errorEl.textContent = err.message;
    }
  });

  $('#login-password-toggle')?.addEventListener('click', event => {
    const input = $('#login-password');
    const button = event.currentTarget;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} password`);
    button.setAttribute('aria-pressed', String(reveal));
  });

  $('#google-login-button')?.addEventListener('click', async () => {
    const companyCode = companyField?.value.trim() || '';
    if (companyCode) localStorage.setItem('taskflow.companyCode', companyCode);
    else localStorage.removeItem('taskflow.companyCode');
    const query = companyCode ? `?company_code=${encodeURIComponent(companyCode)}` : '';
    try {
      await api('/auth/google/device-context', { method: 'POST', body: await getLoginDevicePayload() });
      location.assign(`/api/auth/google/start${query}`);
    } catch (error) {
      const errorEl = $('#login-error');
      if (errorEl) errorEl.textContent = error.message;
    }
  });

}

const btnLogout = $('#btn-logout');
if (btnLogout) {
  btnLogout.addEventListener('click', async () => {
    ME = null;
    stopAttendancePolling();
    stopLiveTracking();
    try { await stopNativeShiftTracking(); } catch (error) { console.warn('Unable to stop native shift tracking before logout:', error.message); }
    stopNotificationsPolling();
    stopTaskListPolling();
    clearNativeDashboardCache();
    await unregisterPushToken();
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
const mobileViewTitles = { dashboard: 'TaskFlow', projects: 'Projects', attendance: 'Attendance', reimbursements: 'Reimbursements', mytasks: 'My Tasks', 'payment-history': 'Payment History', notifications: 'Notifications', admin: 'Admin', tracking: 'Tracking', project: 'Project' };
const mobileBackButton = $('#btn-mobile-back');
const dashboardLogoutButton = $('#dashboard-logout-btn');
if (mobileBackButton) {
  mobileBackButton.onclick = () => {
    closeDrawer();
    if (currentTaskFlowView === 'project') {
      if (taskFlowViewHistory[taskFlowViewHistory.length - 1] === 'projects') taskFlowViewHistory.pop();
      showView('projects', { fromBack: true });
      return;
    }
    showView('dashboard');
  };
}
if (dashboardLogoutButton) {
  dashboardLogoutButton.addEventListener('click', async () => {
    ME = null;
    stopAttendancePolling();
    stopLiveTracking();
    try { await stopNativeShiftTracking(); } catch (error) { console.warn('Unable to stop native shift tracking before logout:', error.message); }
    stopNotificationsPolling();
    stopTaskListPolling();
    clearNativeDashboardCache();
    await unregisterPushToken();
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
  const size = Number(bytes || 0);
  if (size >= 1024 ** 3) return `${(size / (1024 ** 3)).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / (1024 ** 2)).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function isStorageQuotaAvailable(storage) {
  if (storage?.unlimited) return true;
  return storage?.available !== false
    && (Number(storage?.total_bytes || 0) > 0 || Number(storage?.total_gb || 0) > 0);
}

function showStorageDetails(storage) {
  if (!storage) return;
  const storageAvailable = isStorageQuotaAvailable(storage);
  showModal(`
    <h3>Storage usage</h3>
    <div class="storage-detail-grid">
      <div><small>Used</small><b>${Number(storage.used_bytes || 0) > 0 ? formatStorageDisplay(storage.used_gb, storage.used_bytes) : storageAvailable ? formatStorageDisplay(storage.used_gb, storage.used_bytes) : 'Unavailable'}</b></div>
      <div><small>Remaining</small><b>${storage.unlimited ? 'Unlimited' : storageAvailable ? formatStorageDisplay(storage.free_gb, storage.free_bytes) : 'Unavailable'}</b></div>
      <div><small>Total</small><b>${storage.unlimited ? 'Unlimited' : storageAvailable ? formatStorageDisplay(storage.total_gb, storage.total_bytes) : 'Unavailable'}</b></div>
      <div><small>Usage</small><b>${storage.unlimited ? 'No plan limit' : storageAvailable ? `${storage.percent_used}%` : 'Unavailable'}</b></div>
    </div>
    <div class="dashboard-progress"><span style="width:${storageAvailable && !storage.unlimited ? Math.min(100, Math.max(0, storage.percent_used)) : 0}%"></span></div>
    <p class="hint">Usage includes this company's database and tracked uploaded files.</p>
    <div class="modal-actions"><button class="btn btn-primary" id="storage-details-close">Close</button></div>`);
  $('#storage-details-close')?.addEventListener('click', closeModal);
}

async function renderDashboard() {
  const projectsPlaceholder = $('#dashboard-projects');
  if (projectsPlaceholder && !projectsPlaceholder.children.length) projectsPlaceholder.innerHTML = uiSkeletonRows(3);
  const requestId = ++dashboardSummaryRequestId;
  updateDashboardGreeting();
  const adminCard = $('#dashboard-admin-card');
  if (adminCard) adminCard.style.display = ME?.role === 'admin' ? '' : 'none';
  const trackingCard = $('#dashboard-tracking-card');
  let trackingAllowed = ME?.role === 'admin';
  try { trackingAllowed = trackingAllowed || (await api('/attendance/tracking-access/me')).allowed; } catch (error) { trackingAllowed = false; }
  if (trackingCard) trackingCard.style.display = trackingAllowed ? '' : 'none';
  const dashboardProjectsLink = $('#dashboard-projects-link');
  if (dashboardProjectsLink) dashboardProjectsLink.onclick = () => showView('projects');
  const storageCard = $('#dashboard-storage-card');
  if (storageCard) storageCard.style.display = ME?.role === 'admin' ? '' : 'none';
  $$('.dashboard-card[data-dashboard-view]').forEach(card => { card.onclick = () => showView(card.dataset.dashboardView); });
  try {
    const summary = await api('/dashboard/summary');
    if (requestId !== dashboardSummaryRequestId || $('#view-dashboard')?.classList.contains('hidden')) return;
    const summaryPanel = $('#dashboard-summary');
    if (summaryPanel) {
      const storageQuotaAvailable = isStorageQuotaAvailable(summary.storage);
      const storagePercent = Number(summary.storage?.percent_used || 0);
      const storageMetric = ME?.role === 'admin' && summary?.storage ? `
        <div class="dashboard-metric storage">
          <small>Storage used</small>
          <b>${summary.storage.unlimited ? 'No limit' : storageQuotaAvailable ? `${storagePercent}%` : 'Quota unavailable'}</b>
          <div class="dashboard-progress"><span style="width:${storageQuotaAvailable && !summary.storage.unlimited ? Math.min(100, Math.max(0, storagePercent)) : 0}%"></span></div>
          <small>${formatStorageDisplay(summary.storage.used_gb, summary.storage.used_bytes)} used${summary.storage.unlimited ? '' : storageQuotaAvailable ? ` · ${formatStorageDisplay(summary.storage.free_gb, summary.storage.free_bytes)} left` : ''}</small>
          <small>${summary.storage.unlimited ? 'Unlimited plan storage' : storageQuotaAvailable ? `${formatStorageDisplay(summary.storage.total_gb, summary.storage.total_bytes)} plan limit` : 'No company storage limit configured'}</small>
        </div>` : '';

      summaryPanel.innerHTML = `
        ${summary.active_task ? `<button type="button" class="dashboard-metric dashboard-active-task" id="dashboard-active-task-card"><small>Currently working on</small><b>${escapeHtml(summary.active_task.title)}</b><span>${escapeHtml(summary.active_task.customer_name || summary.active_task.project_name || 'Task')}</span><span class="dashboard-active-task-hint">Click to open task</span></button>` : ''}
        <div class="dashboard-metric dashboard-checkin-count"><small>Tasks checked in/out today</small><b>${Number(summary.checkin_task_count) || 0}</b></div>
        <div class="dashboard-metric dashboard-checkin-list"><small>Task names</small><div class="dashboard-checkin-task-list">${summary.checkin_tasks?.length ? summary.checkin_tasks.map(task => `<button type="button" class="dashboard-checkin-task" data-task-id="${Number(task.id)}" data-project-id="${Number(task.project_id)}">${escapeHtml(task.title)}</button>`).join('') : '<span class="hint">No tasks checked in/out today</span>'}</div></div>
        <div class="dashboard-metric money"><small>Pending reimbursements</small><b>${summary.pending_reimbursements} · INR ${Number(summary.pending_reimbursement_amount).toFixed(2)}</b></div>
        ${summary.payment_alerts?.length ? `<div class="dashboard-metric alert dashboard-payment-alert"><small>Overdue invoices</small><b>${summary.payment_alerts.length}</b>${summary.payment_alerts.slice(0, 3).map(invoice => `<span>${escapeHtml(invoice.invoice_number)} · ${escapeHtml(invoice.customer_name || 'No customer')} · pending ${Number(invoice.pending_amount || 0).toFixed(2)}</span>`).join('')}</div>` : ''}
        ${storageMetric}`;
      $$('.dashboard-checkin-task').forEach(button => button.onclick = async () => {
        const projectId = Number(button.dataset.projectId);
        const project = PROJECTS.find(item => Number(item.id) === projectId);
        if (!project) return showAppNotification('This task project is no longer available.');
        pendingSearchTaskId = Number(button.dataset.taskId);
        await openProject(projectId);
      });
      const activeTaskCard = $('#dashboard-active-task-card');
      if (activeTaskCard) activeTaskCard.onclick = async () => {
        const project = PROJECTS.find(item => Number(item.id) === Number(summary.active_task.project_id));
        if (!project) return showAppNotification('This task project is no longer available.');
        pendingSearchTaskId = Number(summary.active_task.id);
        await openProject(Number(project.id));
      };
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
        const stats = projectSummary.get(Number(project.id)) || { open_tasks: 0, overdue_tasks: 0, total_tasks: 0, completed_tasks: 0 };
        const totalTasks = Number(stats.total_tasks) || 0;
        const completedTasks = Number(stats.completed_tasks) || 0;
        const percentComplete = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;
        return `<button class="dashboard-project" data-dashboard-project="${project.id}">
          <b>${project.locked ? `${icon('lock', 'icon project-lock-icon')} ` : ''}${escapeHtml(project.name)}</b>
          <span>${stats.open_tasks} open task${stats.open_tasks === 1 ? '' : 's'} · ${stats.overdue_tasks} overdue</span>
          <div class="dashboard-project-progress" role="progressbar" aria-label="${escapeHtml(project.name)} complete" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentComplete}"><span style="width:${percentComplete}%"></span></div>
          <small>${completedTasks} of ${totalTasks} tasks complete · ${percentComplete}%</small>
        </button>`;
      }).join('') : `<div class="empty-state">${icon('folder')}<b>No projects yet</b><p>Create a project to organize your team's tasks.</p>${PROJECT_ACTION_ACCESS.create_project ? '<button class="btn btn-primary" type="button" id="dashboard-create-project">Create project</button>' : ''}</div>`;
      $$('.dashboard-project').forEach(button => button.onclick = () => openProject(Number(button.dataset.dashboardProject)));
      $('#dashboard-create-project')?.addEventListener('click', () => $('#btn-new-project')?.click());
    }
    const paymentHint = $('#dashboard-payment-history-hint');
    if (paymentHint && Number(summary.payment_alert_count || 0)) paymentHint.textContent = `${summary.payment_alert_count} invoice${summary.payment_alert_count === 1 ? '' : 's'} overdue`;
  } catch (error) {
    if (requestId !== dashboardSummaryRequestId || $('#view-dashboard')?.classList.contains('hidden')) return;
    const summaryPanel = $('#dashboard-summary');
    if (summaryPanel) summaryPanel.innerHTML = '<div class="hint">Dashboard metrics are temporarily unavailable.</div>';
  }
  saveNativeDashboardCache();

}

async function renderPaymentHistory() {
    const wrap = $('#payment-history-content');
    if (!wrap) return;
    const summarySection = (title, key, includeInvoiceCount = false) => `
      <section class="payment-summary-section">
        <h2>${title}</h2>
        <div class="payment-summary-cards">
          <div class="payment-summary-card revenue"><span>Total revenue</span><b id="payment-summary-${key}-revenue">0.00</b>${includeInvoiceCount ? `<small id="payment-summary-invoices">0 invoices</small>` : ''}</div>
          <div class="payment-summary-card received"><span>Payment received</span><b id="payment-summary-${key}-received">0.00</b></div>
          <div class="payment-summary-card pending"><span>Payment pending</span><b id="payment-summary-${key}-pending">0.00</b></div>
        </div>
      </section>`;
    wrap.innerHTML = `<div class="project-header"><div><h1>Payment History</h1><div class="hint">Track invoices, received payments, and pending balances.</div></div></div>
      <div class="admin-block">
        <div class="payment-summary-period" id="payment-summary-period">All time</div>
        ${summarySection('Overall', 'overall', true)}
        ${summarySection('Cash invoices', 'cash')}
        ${summarySection('GST invoices', 'gst')}
        <div class="attendance-filters">
          <label>From <input type="date" id="payment-history-from"></label>
          <label>To <input type="date" id="payment-history-to"></label>
          <label>Member <select id="payment-history-assignee"><option value="">All members</option>${PEOPLE.map(person => `<option value="${person.id}">${escapeHtml(person.name || person.NAME)}</option>`).join('')}</select></label>
          <label>Invoice type <select id="payment-history-invoice-type"><option value="">All types</option><option value="cash">Cash</option><option value="gst">GST</option></select></label>
          <label>Status <select id="payment-history-status"><option value="">All statuses</option><option value="received">Received</option><option value="not_received">Not received</option><option value="pending">Pending</option></select></label>
          <button class="btn btn-primary" id="payment-history-filter">Filter</button>
        </div>
          <div class="task-table-wrap" style="overflow-x:auto; margin-top:14px;"><table class="attn-table payment-history-table"><thead><tr><th>Member</th><th>Invoice</th><th>Invoice type</th><th>Invoice date</th><th>Customer</th><th>Task / project</th><th>Total</th><th>Status</th><th>Received date</th><th>Received</th><th>Pending</th><th>Save</th></tr></thead><tbody id="payment-history-table"></tbody></table></div>
      </div>`;
    const table = $('#payment-history-table');
    const renderSummary = async () => {
      const params = new URLSearchParams();
      if ($('#payment-history-from').value) params.set('from', $('#payment-history-from').value);
      if ($('#payment-history-to').value) params.set('to', $('#payment-history-to').value);
      if ($('#payment-history-assignee').value) params.set('assignee_id', $('#payment-history-assignee').value);
      if ($('#payment-history-invoice-type').value) params.set('invoice_type', $('#payment-history-invoice-type').value);
      if ($('#payment-history-status').value) params.set('status', $('#payment-history-status').value);
      const summary = await api(`/payment-history/summary?${params.toString()}`);
      const setAmount = (id, value) => { $(`#payment-summary-${id}`).textContent = Number(value || 0).toFixed(2); };
      setAmount('overall-revenue', summary.total_revenue);
      setAmount('overall-received', summary.payment_received);
      setAmount('overall-pending', summary.payment_pending);
      setAmount('cash-revenue', summary.cash_revenue);
      setAmount('cash-received', summary.cash_received);
      setAmount('cash-pending', summary.cash_pending);
      setAmount('gst-revenue', summary.gst_revenue);
      setAmount('gst-received', summary.gst_received);
      setAmount('gst-pending', summary.gst_pending);
      $('#payment-summary-invoices').textContent = `${summary.invoice_count} invoice${summary.invoice_count === 1 ? '' : 's'}`;
      const selectedMember = $('#payment-history-assignee').selectedOptions[0]?.textContent;
      const selectedInvoiceType = $('#payment-history-invoice-type').selectedOptions[0]?.textContent;
      const selectedStatus = $('#payment-history-status').selectedOptions[0]?.textContent;
      $('#payment-summary-period').textContent = `${summary.from || summary.to ? `Selected period${summary.from ? ` from ${summary.from}` : ''}${summary.to ? ` to ${summary.to}` : ''}` : 'All time'}${summary.assignee_id ? ` · ${selectedMember}` : ''}${summary.invoice_type ? ` · ${selectedInvoiceType}` : ''}${summary.status ? ` · ${selectedStatus}` : ''}`;
    };
    const renderRows = async () => {
      const params = new URLSearchParams();
      if ($('#payment-history-from').value) params.set('from', $('#payment-history-from').value);
      if ($('#payment-history-to').value) params.set('to', $('#payment-history-to').value);
      if ($('#payment-history-assignee').value) params.set('assignee_id', $('#payment-history-assignee').value);
      if ($('#payment-history-invoice-type').value) params.set('invoice_type', $('#payment-history-invoice-type').value);
      if ($('#payment-history-status').value) params.set('status', $('#payment-history-status').value);
      try {
        const rows = await api(`/payment-history?${params.toString()}`);
        table.innerHTML = rows.length ? rows.map(row => {
          const selectedMemberId = row.payment_member_id ?? row.assignee_id ?? '';
          const invoiceTypeLabel = ({ cash: 'Cash', gst: 'GST' })[row.invoice_type] || 'GST';
          return `<tr>
          <td><select class="payment-row-member" data-id="${row.id}"><option value="">Unassigned</option>${PEOPLE.map(person => `<option value="${person.id}" ${Number(selectedMemberId) === Number(person.id) ? 'selected' : ''}>${escapeHtml(person.name || person.NAME)}</option>`).join('')}</select>${!selectedMemberId && row.asana_assignee_name ? `<small class="hint asana-unlinked-label" style="display:block;">Asana name: ${escapeHtml(row.asana_assignee_name)} · not linked to a TaskFlow account</small>` : ''}</td><td><b>${escapeHtml(row.invoice_number || '—')}</b></td><td>${invoiceTypeLabel}</td><td>${escapeHtml(row.invoice_date || '—')}</td><td>${escapeHtml(row.customer_name || '—')}</td>
          <td>${escapeHtml(row.title)}<small class="hint">${escapeHtml(row.project_name || '')}</small></td><td>${Number(row.total_amount || 0).toFixed(2)}</td>
          <td><select class="payment-row-status" data-id="${row.id}"><option value="received" ${row.payment_status === 'received' ? 'selected' : ''}>Received</option><option value="not_received" ${row.payment_status === 'not_received' ? 'selected' : ''}>Not received</option><option value="pending" ${row.payment_status === 'pending' ? 'selected' : ''}>Pending</option></select></td>
          <td><input class="payment-row-date" data-id="${row.id}" type="date" value="${escapeHtml(row.payment_received_date || '')}"></td><td><input class="payment-row-received" data-id="${row.id}" type="number" min="0" step="0.01" value="${Number(row.amount_received || 0).toFixed(2)}"></td>
          <td class="payment-pending" data-id="${row.id}">${Number(row.pending_amount || 0).toFixed(2)}</td><td><button class="btn btn-primary btn-sm payment-save" data-id="${row.id}">Save</button></td>
        </tr>`;
        }).join('') : '<tr><td colspan="12" class="hint" style="text-align:center;padding:15px;">No invoices found.</td></tr>';
        $$('.payment-save').forEach(button => button.onclick = async () => {
          const id = button.dataset.id;
          const received = Number($(`.payment-row-received[data-id="${id}"]`).value || 0);
          await api(`/payment-history/${id}`, { method: 'PUT', body: { payment_member_id: $(`.payment-row-member[data-id="${id}"]`).value || null, payment_status: $(`.payment-row-status[data-id="${id}"]`).value, payment_received_date: $(`.payment-row-date[data-id="${id}"]`).value || null, amount_received: received } });
          await renderSummary();
          await renderRows();
          showAppNotification('Payment history updated.');
        });
      } catch (error) { table.innerHTML = `<tr><td colspan="12" class="form-error">${escapeHtml(error.message)}</td></tr>`; }
    };
    $('#payment-history-filter').onclick = async () => { await renderSummary(); await renderRows(); };
    renderSummary().catch(error => console.warn('Payment summary refresh failed:', error.message));
    renderRows().catch(error => {
      table.innerHTML = `<tr><td colspan="11" class="form-error">${escapeHtml(error.message)}</td></tr>`;
    });
}

function renderProjectsDirectory() {
  const directory = $('#projects-directory');
  if (!directory) return;
  directory.innerHTML = PROJECTS.length ? PROJECTS.map(project => `<button class="dashboard-project projects-directory-card" data-directory-project="${project.id}"><b>${project.locked ? `${icon('lock', 'icon project-lock-icon')} ` : ''}${escapeHtml(project.name)}</b><span>Open project workspace</span></button>`).join('') : `<div class="empty-state">${icon('folder')}<b>No projects yet</b><p>Create a project to organize work.</p>${PROJECT_ACTION_ACCESS.create_project ? '<button class="btn btn-primary" type="button" id="projects-directory-create">Create project</button>' : ''}</div>`;
  $$('.dashboard-project[data-directory-project]').forEach(button => button.onclick = () => openProject(Number(button.dataset.directoryProject)));
  $('#projects-directory-create')?.addEventListener('click', () => $('#btn-new-project')?.click());
  const newProject = $('#projects-new-project');
   if (newProject) {
  newProject.style.display = PROJECT_ACTION_ACCESS.create_project ? '' : 'none';
  newProject.onclick = () => document.querySelector('#btn-new-project')?.click();
   }
}

async function enterApp() {
  const loginScreen = $('#login-screen');
  if (loginScreen) loginScreen.classList.add('hidden');
  const appEl = $('#app');
  const cachedPreview = appEl?.classList.contains('native-dashboard-preview');
  if (appEl) {
    appEl.classList.remove('hidden');
    if (!cachedPreview) appEl.classList.add('booting');
  }
  const companyStatusBanner = $('#company-status-banner');
  if (companyStatusBanner) {
    const messages = [];
    if (ME.company_status === 'suspended') messages.push('Account suspended, contact support. This workspace is read-only.');
    const warningThreshold = Number(ME.usage?.warningThreshold);
    if (ME.role === 'admin' && [80, 95].includes(warningThreshold)) {
      messages.push(`Storage usage has reached ${warningThreshold}% of this plan. Contact support to upgrade.`);
    }
    companyStatusBanner.textContent = messages.join(' ');
    companyStatusBanner.classList.toggle('hidden', messages.length === 0);
  }
  renderSupportModeBanner();

  const features = ME.features || { attendance: true, reimbursements: true, export: true };
  $$('[data-feature]').forEach(element => {
    element.style.display = features[element.dataset.feature] === false ? 'none' : '';
  });
  
  const meBadge = $('#me-badge');
  if (meBadge) meBadge.innerHTML = `Signed in as<br><b>${escapeHtml(ME.name)}</b>`;
  const changePasswordButton = $('#btn-change-password');
  if (changePasswordButton) changePasswordButton.onclick = () => showSelfPasswordModal();
  
  const navAdmin = $('#nav-admin');
  if (ME.role === 'admin' && navAdmin) navAdmin.style.display = '';
  const billingLink = $('#admin-billing-link');
  if (billingLink) billingLink.style.display = ME.role === 'admin' ? '' : 'none';
  
  try {
    const [paymentAccess, projectActionAccess, reimbursementAccess] = await Promise.all([
      api('/payment-history/access/me'),
      api('/project-action-access/me'),
      api('/auth/reimbursement-access/me')
    ]);
    const canViewDirectory = ME.role === 'admin' || paymentAccess.allowed || Number(reimbursementAccess.approval_level) > 0;
    const rawPeople = canViewDirectory
      ? await api('/auth/users/directory').catch((error) => {
        if (error.status !== 403) throw error;
        return [ME];
      })
      : [];
    PEOPLE = Array.isArray(rawPeople) ? rawPeople.flat(5) : [];
    PROJECT_ACTION_ACCESS = projectActionAccess;
    const paymentAllowed = ME.role === 'admin' || paymentAccess.allowed;
    $('#nav-payment-history')?.style.setProperty('display', paymentAllowed ? '' : 'none');
    $('#dashboard-payment-history-card')?.style.setProperty('display', paymentAllowed ? '' : 'none');
    
    await loadProjects();
    await renderDashboard();
    syncLiveTracking();
    requestNativeNotificationPermission();
    startNotificationsPolling();
    const returnView = sessionStorage.getItem('taskflow_return_view') || (nativeApp ? 'dashboard' : sessionStorage.getItem('taskflow_last_view')) || 'dashboard';
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
    appEl?.classList.remove('booting', 'native-dashboard-preview');
    if (appEl) { appEl.inert = false; appEl.style.pointerEvents = ''; appEl.removeAttribute('aria-busy'); }
    $('#startup-screen')?.classList.add('hidden');
    if (flashMessage) showAppNotification(flashMessage);
  } catch (err) {
    console.error('App boot failure:', err);
    appEl?.classList.remove('booting');
    appEl?.classList.add('hidden');
    appEl?.classList.remove('native-dashboard-preview');
    if (appEl) { appEl.inert = false; appEl.style.pointerEvents = ''; appEl.removeAttribute('aria-busy'); }
    $('#startup-screen')?.classList.add('hidden');
    loginScreen?.classList.remove('hidden');
    const loginError = $('#login-error');
    if (loginError) loginError.textContent = `Unable to start the app: ${err.message}`;
  }
}

function renderSupportModeBanner() {
  const banner = $('#support-mode-banner');
  if (!banner) return;
  if (supportModeTimer) clearInterval(supportModeTimer);
  const supportMode = ME?.supportMode;
  if (!supportMode) {
    banner.classList.add('hidden');
    return;
  }
  const expiresAt = new Date(supportMode.expiresAt).getTime();
  const countdown = $('#support-mode-countdown');
  const button = $('#end-support-mode');
  const updateCountdown = () => {
    const secondsRemaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(secondsRemaining / 60);
    const seconds = String(secondsRemaining % 60).padStart(2, '0');
    countdown.textContent = `${supportMode.companyName} · ${minutes}:${seconds} remaining`;
    if (secondsRemaining === 0) button.textContent = 'Return to control panel';
  };
  updateCountdown();
  supportModeTimer = setInterval(updateCountdown, 1000);
  banner.classList.remove('hidden');
  button.onclick = async () => {
    button.disabled = true;
    try {
      await api('/auth/end-support', { method: 'POST' });
      window.location.assign('/superadmin');
    } catch (error) {
      showAppNotification(error.message);
      button.disabled = false;
    }
  };
}

// ---------- navigation panels controller ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => { closeMobileNav(); showView(btn.dataset.view); });
});
$$('.mobile-tab[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => { closeMobileNav(); showView(btn.dataset.view); });
});
$('#btn-mobile-more')?.addEventListener('click', () => $('#btn-mobile-nav')?.click());
if (nativeApp) {
  const attendanceTabLabel = $('.mobile-bottom-nav [data-view="attendance"] span');
  if (attendanceTabLabel) attendanceTabLabel.textContent = 'Punch';
}
const appearanceSettingsButton = $('#btn-appearance-settings');
if (nativeApp && appearanceSettingsButton) {
  appearanceSettingsButton.addEventListener('click', () => {
    const theme = htmlElement.dataset.theme || 'system';
    const textSize = localStorage.getItem(nativeTextSizeKey) || 'default';
    showModal(`<div class="native-appearance-settings">
      <h3>Appearance</h3>
      <label for="native-theme-setting">Theme</label>
      <select id="native-theme-setting">
        <option value="system" ${theme === 'system' ? 'selected' : ''}>System</option>
        <option value="light" ${theme === 'light' ? 'selected' : ''}>Light</option>
        <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Dark</option>
      </select>
      <label for="native-text-size-setting">Text size</label>
      <select id="native-text-size-setting">
        <option value="small" ${textSize === 'small' ? 'selected' : ''}>Small</option>
        <option value="default" ${textSize === 'default' ? 'selected' : ''}>Default</option>
        <option value="large" ${textSize === 'large' ? 'selected' : ''}>Large</option>
      </select>
      <div class="modal-actions"><button class="btn btn-primary" id="native-appearance-done" type="button">Done</button></div>
    </div>`);
    const themeSelect = $('#native-theme-setting');
    const textSizeSelect = $('#native-text-size-setting');
    const savePreferences = () => {
      localStorage.setItem(nativeThemeKey, themeSelect.value);
      localStorage.setItem(nativeTextSizeKey, textSizeSelect.value);
      applyNativeAppearance(themeSelect.value, textSizeSelect.value);
    };
    themeSelect.addEventListener('change', savePreferences);
    textSizeSelect.addEventListener('change', savePreferences);
    $('#native-appearance-done').addEventListener('click', closeModal);
  });
}

const taskFlowViewHistory = [];
let currentTaskFlowView = document.querySelector('.nav-item.active')?.dataset.view || 'dashboard';

function showView(view, { fromBack = false } = {}) {
  const featureForView = { attendance: 'attendance', reimbursements: 'reimbursements' }[view];
  if (featureForView && ME?.features?.[featureForView] === false) {
    showView('dashboard');
    return;
  }
  if (view !== currentTaskFlowView) {
    if (!fromBack) taskFlowViewHistory.push(currentTaskFlowView);
    currentTaskFlowView = view;
  }
  if (view !== 'attendance') stopAttendanceClock();
  if (mobilePageTitle) mobilePageTitle.textContent = view === 'project' ? '' : (view === 'dashboard' ? 'TaskFlow' : (mobileViewTitles[view] || 'TaskFlow'));
  if (mobileBackButton) {
    const backToProjects = view === 'project';
    mobileBackButton.title = backToProjects ? 'Back to projects' : 'Back to dashboard';
    mobileBackButton.setAttribute('aria-label', mobileBackButton.title);
    mobileBackButton.classList.toggle('back-to-projects', backToProjects);
    mobileBackButton.innerHTML = backToProjects ? '<span aria-hidden="true">‹</span><span class="mobile-back-label">Projects</span>' : '‹';
  }
  const compactSidebarViews = new Set(['dashboard', 'attendance', 'reimbursements', 'mytasks', 'payment-history', 'notifications', 'admin', 'tracking']);
  const projectSidebarViews = new Set(['projects', 'project']);
  $('#app')?.classList.toggle('dashboard-view', view === 'dashboard');
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
  $$('.mobile-tab[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.project-item').forEach((b) => b.classList.remove('active'));
  sessionStorage.setItem('taskflow_last_view', view);
  if (view === 'project' && CURRENT_PROJECT) sessionStorage.setItem('taskflow_last_project_id', String(CURRENT_PROJECT.id));
  ['dashboard', 'projects', 'attendance', 'reimbursements', 'admin', 'tracking', 'project', 'mytasks', 'payment-history', 'notifications', 'empty'].forEach((v) => {
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
    renderPunchCard(); renderHistory();
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
  } else if (view === 'payment-history') {
    const paymentView = $('#view-payment-history');
    if (paymentView) paymentView.classList.remove('hidden');
    renderPaymentHistory();
  } else if (view === 'notifications') {
    const viewNotifications = $('#view-notifications');
    if (viewNotifications) viewNotifications.classList.remove('hidden');
    const notificationButton = document.querySelector('[data-view="notifications"]');
    const notificationLabel = notificationButton?.querySelector('.nav-label');
    if (notificationLabel) notificationLabel.textContent = 'Notifications';
    renderNotifications();
  } else if (view === 'project') {
    const viewProject = $('#view-project');
    if (viewProject) viewProject.classList.remove('hidden');
  } else {
    const viewEmpty = $('#view-empty');
    if (viewEmpty) viewEmpty.classList.remove('hidden');
  }
}

window.TaskFlowApp?.addListener('backButton', async () => {
  const modalBackdrop = $('#modal-backdrop');
  if (modalBackdrop && !modalBackdrop.classList.contains('hidden')) {
    if (!forcedPasswordModalOpen) closeModal();
    return;
  }
  if ($('#app')?.classList.contains('drawer-open')) {
    closeDrawer();
    return;
  }
  if ($('#app')?.classList.contains('mobile-nav-open')) {
    closeMobileNav();
    return;
  }
  if (taskFlowViewHistory.length) {
    showView(taskFlowViewHistory.pop(), { fromBack: true });
    return;
  }
  if (currentTaskFlowView !== 'dashboard') {
    showView('dashboard', { fromBack: true });
    return;
  }
  await window.TaskFlowApp.minimizeApp();
});

const NOTIFICATION_PAGE_SIZE = 10;
let notificationFeed = null; // { items, seen, hasMore, loading, observer }

function notificationKey(entry) {
  return `${entry.source || 'activity'}:${entry.id}`;
}

function notificationGroupsMarkup(items) {
  const today = todayISO();
  const yesterdayDate = new Date(`${today}T12:00:00+05:30`);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(yesterdayDate);
  const groups = new Map([['Today', []], ['Yesterday', []], ['Earlier', []]]);
  items.forEach(entry => {
    const date = parseTaskFlowTimestamp(entry.created_at);
    const day = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date) : '';
    groups.get(day === today ? 'Today' : day === yesterday ? 'Yesterday' : 'Earlier').push(entry);
  });
  return Array.from(groups, ([label, entries]) => entries.length ? `
    <section class="notification-group" aria-label="${label}">
      <h2>${label}</h2>
      ${entries.map(entry => {
        const action = String(entry.action || '').toLowerCase();
        const iconName = /attendance|punch|location/.test(action) ? 'clock'
          : /reimburse|expense|receipt/.test(action) ? 'receipt'
            : /project/.test(action) ? 'folder'
              : /setting|access|user|permission/.test(action) ? 'settings' : 'check';
        return `<article class="notification-item">
          <span class="notification-icon">${icon(iconName)}</span>
          <div><b>${escapeHtml(entry.action)}</b><p>By ${escapeHtml(entry.actor_name || 'Unknown user')} · ${escapeHtml(fmtDateTime(entry.created_at))}</p>${entry.details ? `<small>${escapeHtml(entry.details)}</small>` : ''}</div>
        </article>`;
      }).join('')}
    </section>` : '').join('');
}

function renderNotificationFeed(list, feed) {
  if (feed.observer) { feed.observer.disconnect(); feed.observer = null; }
  if (!feed.items.length) {
    list.innerHTML = '<p class="hint">No recent activity is available for your account yet.</p>';
    return;
  }
  list.innerHTML = `${notificationGroupsMarkup(feed.items)}
    <div id="notifications-more" class="notifications-more">
      ${feed.hasMore
        ? '<div id="notifications-sentinel" class="ui-state-loading" role="status"><span class="ui-spinner" aria-hidden="true"></span><span>Loading more...</span></div><button type="button" class="btn btn-secondary btn-sm" id="notifications-load-more">Load more</button>'
        : '<p class="hint">You are all caught up.</p>'}
    </div>`;
  $('#notifications-load-more')?.addEventListener('click', () => renderNotifications({ more: true }));
  const sentinel = $('#notifications-sentinel');
  if (sentinel && 'IntersectionObserver' in window) {
    feed.observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) renderNotifications({ more: true });
    }, { rootMargin: '150px' });
    feed.observer.observe(sentinel);
  }
}

async function renderNotifications({ more = false } = {}) {
  const list = $('#notifications-list');
  if (!list) return;
  if (!more || !notificationFeed) {
    if (notificationFeed?.observer) notificationFeed.observer.disconnect();
    notificationFeed = { items: [], seen: new Set(), hasMore: true, loading: false, observer: null };
    list.innerHTML = uiSkeletonRows(3);
  }
  const feed = notificationFeed;
  if (feed.loading || !feed.hasMore) return;
  feed.loading = true;
  const cursor = feed.items.length ? String(feed.items[feed.items.length - 1].created_at) : null;
  const query = new URLSearchParams({ limit: String(NOTIFICATION_PAGE_SIZE) });
  if (more && cursor) query.set('before', cursor);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const page = await api(`/auth/activity?${query}`, { signal: controller.signal });
    if (feed !== notificationFeed) return;
    const rows = Array.isArray(page) ? page : [];
    rows.forEach(entry => {
      const key = notificationKey(entry);
      if (feed.seen.has(key)) return;
      feed.seen.add(key);
      feed.items.push(entry);
    });
    feed.hasMore = rows.length === NOTIFICATION_PAGE_SIZE;
    latestNotificationId = Math.max(latestNotificationId || 0, 0, ...rows.map(entry => Number(entry.id) || 0));
    renderNotificationFeed(list, feed);
  } catch (error) {
    if (feed !== notificationFeed) return;
    if (feed.items.length) {
      const more = $('#notifications-more');
      if (more) {
        more.innerHTML = uiErrorState(error, 'notifications-more-retry');
        $('#notifications-more-retry')?.addEventListener('click', () => renderNotifications({ more: true }));
      }
    } else {
      list.innerHTML = uiErrorState(error, 'notifications-retry');
      $('#notifications-retry')?.addEventListener('click', () => renderNotifications());
    }
  } finally {
    clearTimeout(timeout);
    feed.loading = false;
  }
}

async function renderReimbursements() {
  const wrap = $('#reimbursements-content');
  if (!wrap) return;
  if (!wrap.children.length) wrap.innerHTML = uiSkeletonRows(4);
  const isAdmin = ME && ME.role === 'admin';
  const access = await api('/auth/reimbursement-access/me');
  const canReview = isAdmin || Number(access.approval_level) > 0;
  const canPay = isAdmin || Number(access.can_pay) === 1;
  const peopleOptions = PEOPLE.map(person => `<option value="${person.id}">${escapeHtml(person.name || person.NAME)}</option>`).join('');
  const categoryOptions = ['Travel', 'Fuel', 'Meals', 'Lodging', 'Supplies', 'Other'].map(category => `<option>${category}</option>`).join('');
  const reimbursementSummary = `
    <div class="reimbursement-summary">
      <div class="reimbursement-summary-card"><span>Total claims</span><b id="reimbursement-total-amount"><span class="ui-skel ui-skel-inline"></span></b><small id="reimbursement-total-count"><span class="ui-skel ui-skel-inline ui-skel-inline-sm"></span></small></div>
      <div class="reimbursement-summary-card"><span>Pending</span><b class="pending" id="reimbursement-pending-amount"><span class="ui-skel ui-skel-inline"></span></b></div>
      <div class="reimbursement-summary-card"><span>Approved</span><b class="approved" id="reimbursement-approved-amount"><span class="ui-skel ui-skel-inline"></span></b></div>
    </div>`;
  const employeeOverview = isAdmin ? `<div class="admin-block">${reimbursementSummary}</div>` : `
    <div class="admin-block">
      <div id="employee-reimbursement-overview">
        ${reimbursementSummary}
        <div class="reimbursement-section-heading"><h3>Recent expenses</h3><button class="btn btn-primary" id="reimbursement-new-expense" type="button">+ New expense</button></div>
      </div>
      <div id="employee-reimbursement-form" class="hidden">
        <div class="reimbursement-section-heading"><h3 id="reimbursement-form-title">Submit expense</h3><button class="btn btn-secondary" id="reimbursement-cancel-new" type="button">Back to expenses</button></div>
        <form id="reimbursement-form" class="admin-form-row">
          <input id="reimbursement-amount" type="number" min="0.01" step="0.01" placeholder="Amount" required>
          <select id="reimbursement-currency"><option>INR</option><option>USD</option><option>EUR</option></select>
          <select id="reimbursement-category">${categoryOptions}</select>
          <input id="reimbursement-date" type="date" value="${todayISO()}" required>
          <textarea id="reimbursement-description" class="reimbursement-description" rows="2" placeholder="Description"></textarea>
          <input id="reimbursement-receipt" type="file" accept="image/*,.pdf" multiple aria-label="Choose receipt photos or files">
          <div class="receipt-source-actions"><button class="btn btn-secondary btn-sm" id="reimbursement-gallery" type="button">${icon('gallery')} Choose from gallery</button>${window.Capacitor?.isNativePlatform?.() ? `<button class="btn btn-secondary btn-sm" id="reimbursement-camera" type="button">${icon('camera')} Take photo</button>` : ''}</div>
          <p id="reimbursement-receipt-selection" class="hint receipt-selection" aria-live="polite">No receipts selected</p>
          <button class="btn btn-primary" id="reimbursement-submit" type="submit">Submit claim</button>
        </form>
        <div id="reimbursement-form-error" class="form-error"></div>
        <div id="reimbursement-form-success" style="color:#25602a; font-size:13px; min-height:16px;"></div>
      </div>
    </div>`;

  wrap.innerHTML = `
    <div class="project-header"><div><h1>Reimbursements</h1><div class="hint">Submit field expenses with receipts and track approval status.</div></div></div>
    ${employeeOverview}
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
      <div class="task-table-wrap reimbursement-table-wrap" style="overflow-x:auto; margin-top:14px;">
        <table class="attn-table reimbursement-table"><thead><tr>
          ${canReview ? '<th><input type="checkbox" id="reimbursement-select-all" title="Select approvable expenses"></th>' : ''}
          ${canReview ? '<th>Employee</th><th>Department</th>' : ''}
          <th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Receipt</th><th>Status</th><th>Action</th>
        </tr></thead><tbody id="reimbursements-table"></tbody></table>
      </div>
      <div class="attendance-filters" id="reimbursement-pagination" style="justify-content:flex-end; align-items:center; margin-top:10px;">
        <button class="btn btn-secondary btn-sm" id="reimbursement-prev" type="button" disabled>Previous</button>
        <span class="hint" id="reimbursement-page-label">Page 1</span>
        <button class="btn btn-secondary btn-sm" id="reimbursement-next" type="button" disabled>Next</button>
      </div>
    </div>`;

  const table = $('#reimbursements-table');
  const reimbursementPageSize = 10;
  let reimbursementOffset = 0;
  let reimbursementHasMore = false;
  let editingReimbursementId = null;
  let reimbursementSubmissionKey = null;
  let selectedReceiptFiles = [];
  const updateReceiptSelection = () => {
    const label = $('#reimbursement-receipt-selection');
    if (label) label.textContent = selectedReceiptFiles.length
      ? `${selectedReceiptFiles.length} receipt${selectedReceiptFiles.length === 1 ? '' : 's'} selected`
      : 'No receipts selected';
  };
  const showExpenseForm = (row = null) => {
    editingReimbursementId = row ? Number(row.id) : null;
    reimbursementSubmissionKey = row ? null : (reimbursementSubmissionKey || crypto.randomUUID());
    $('#reimbursement-form').reset();
    $('#reimbursement-amount').value = row ? Number(row.amount).toFixed(2) : '';
    $('#reimbursement-currency').value = row?.currency || 'INR';
    const category = $('#reimbursement-category');
    if (row && !Array.from(category.options).some(option => option.value === row.category)) {
      category.add(new Option(row.category, row.category));
    }
    category.value = row?.category || 'Travel';
    $('#reimbursement-date').value = row?.expense_date || todayISO();
    const description = $('#reimbursement-description');
    description.value = row?.description || '';
    description.style.height = 'auto';
    description.style.height = `${description.scrollHeight}px`;
    $('#reimbursement-receipt').value = '';
    selectedReceiptFiles = [];
    updateReceiptSelection();
    $('#reimbursement-form-title').textContent = row ? 'Edit expense' : 'Submit expense';
    $('#reimbursement-submit').textContent = row ? 'Save changes' : 'Submit claim';
    $('#reimbursement-form-error').textContent = '';
    $('#reimbursement-form-success').textContent = row
      ? 'Existing receipts will be kept. Any new receipts will be added.'
      : '';
    $('#employee-reimbursement-overview').classList.add('hidden');
    $('#employee-reimbursement-form').classList.remove('hidden');
    description.focus();
  };
  const hideExpenseForm = () => {
    editingReimbursementId = null;
    reimbursementSubmissionKey = null;
    $('#reimbursement-form').reset();
    selectedReceiptFiles = [];
    updateReceiptSelection();
    $('#employee-reimbursement-form').classList.add('hidden');
    $('#employee-reimbursement-overview').classList.remove('hidden');
  };
  $('#reimbursement-description')?.addEventListener('input', event => {
    event.currentTarget.style.height = 'auto';
    event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
  });
  const receiptInput = $('#reimbursement-receipt');
  receiptInput?.addEventListener('change', () => {
    selectedReceiptFiles.push(...Array.from(receiptInput.files || []));
    receiptInput.value = '';
    updateReceiptSelection();
  });
  $('#reimbursement-gallery')?.addEventListener('click', () => receiptInput?.click());
  $('#reimbursement-camera')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const error = $('#reimbursement-form-error');
    button.disabled = true;
    error.textContent = '';
    try {
      const camera = window.TaskFlowCamera;
      if (!camera) throw new Error('Camera is unavailable. Update TaskFlow and try again.');
      let permission = await camera.checkPermissions();
      if (permission.camera !== 'granted') permission = await camera.requestPermissions({ permissions: ['camera'] });
      if (permission.camera !== 'granted') throw new Error('Allow camera access for TaskFlow in phone settings, then try again.');
      const photo = await camera.getPhoto({
        source: window.TaskFlowCameraSource.Camera,
        resultType: window.TaskFlowCameraResultType.Base64,
        quality: 85,
        width: 1800,
        height: 1800,
        allowEditing: false,
        saveToGallery: false
      });
      if (!photo.base64String) throw new Error('The camera did not return a photo. Try again.');
      const mimeType = photo.format === 'jpg' ? 'image/jpeg' : `image/${photo.format}`;
      const binary = atob(photo.base64String);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      selectedReceiptFiles.push(new File([bytes], `receipt-${Date.now()}.${photo.format}`, { type: mimeType }));
      updateReceiptSelection();
    } catch (captureError) {
      error.textContent = captureError.message || 'Unable to capture receipt photo.';
      const chooseGallery = await confirmModal(
        'Camera unavailable',
        'You can still attach the receipt by selecting an image or PDF from your device.',
        'Choose from gallery',
        false
      );
      if (chooseGallery) receiptInput?.click();
    } finally {
      button.disabled = false;
    }
  });
  const refreshReimbursementSummary = async () => {
    try {
      const summary = await api('/reimbursements/summary');
      const currencyTotals = summary.currency_totals || [];
      const formatCurrencyTotals = field => currencyTotals.length
        ? currencyTotals.map(row => `${escapeHtml(row.currency)} ${Number(row[field] || 0).toFixed(2)}`).join(' · ')
        : '—';
      $('#reimbursement-total-amount').textContent = formatCurrencyTotals('total_amount');
      $('#reimbursement-total-count').textContent = `${Number(summary.claim_count || 0)} claim${Number(summary.claim_count || 0) === 1 ? '' : 's'}`;
      $('#reimbursement-pending-amount').textContent = formatCurrencyTotals('pending_amount');
      $('#reimbursement-approved-amount').textContent = formatCurrencyTotals('approved_amount');
    } catch (error) {
      $('#reimbursement-total-amount').textContent = '—';
      $('#reimbursement-total-count').textContent = 'Unable to load claims';
      $('#reimbursement-pending-amount').textContent = '—';
      $('#reimbursement-approved-amount').textContent = '—';
      console.warn('Expense summary refresh failed:', error.message);
    }
  };
  const renderRows = async () => {
    const params = new URLSearchParams();
    if (canReview && $('#reimbursement-user')?.value) params.set('user_id', $('#reimbursement-user').value);
    if (canReview && $('#reimbursement-status')?.value) params.set('status', $('#reimbursement-status').value);
    if ($('#reimbursement-from')?.value) params.set('from', $('#reimbursement-from').value);
    if ($('#reimbursement-to')?.value) params.set('to', $('#reimbursement-to').value);
    params.set('limit', String(reimbursementPageSize));
    params.set('offset', String(reimbursementOffset));
    try {
      const page = await api(`/reimbursements?${params.toString()}`);
      const rows = Array.isArray(page) ? page : (page.items || []);
      reimbursementHasMore = !!page.has_more;
      if (!rows.length && reimbursementOffset > 0) {
        reimbursementOffset = Math.max(0, reimbursementOffset - reimbursementPageSize);
        return renderRows();
      }
      $('#reimbursement-prev').disabled = reimbursementOffset === 0;
      $('#reimbursement-next').disabled = !reimbursementHasMore;
      $('#reimbursement-page-label').textContent = rows.length
        ? `Claims ${reimbursementOffset + 1}–${reimbursementOffset + rows.length}`
        : 'No claims';
      table.innerHTML = rows.length ? rows.map(row => {
        const awaitingDifferentApprover = row.status === 'approved_level_1'
          && Number(row.approved_level_1_by) === Number(ME?.id);
        const canApprove = canReview && !awaitingDifferentApprover
          && ((row.status === 'submitted' && (isAdmin || Number(access.approval_level) === 1))
            || (row.status === 'approved_level_1' && (isAdmin || Number(access.approval_level) >= 2)));
        const canEdit = !isAdmin && Number(row.user_id) === Number(ME?.id) && row.status === 'submitted';
        const receiptItems = Array.isArray(row.receipt_items) ? row.receipt_items : (row.receipt_url ? [{ url: row.receipt_url, original_name: 'View receipt' }] : []);
        const availableReceiptCount = receiptItems.filter(item => item.url).length;
        const expiredReceiptCount = receiptItems.length - availableReceiptCount;
        const receiptCell = availableReceiptCount
          ? `<span class="reimbursement-receipt-count">${icon('receipt')}<span>${availableReceiptCount} ${availableReceiptCount === 1 ? 'file' : 'files'}</span></span>${expiredReceiptCount ? `<small class="hint">${expiredReceiptCount} expired</small>` : ''}`
          : (expiredReceiptCount || row.receipt_expired ? '<span class="hint">Attachment expired</span>' : '—');
        return `<tr class="reimbursement-row" data-reimbursement-id="${row.id}">
        ${canReview ? `<td data-label="Select"><input type="checkbox" class="reimbursement-select" data-id="${row.id}" ${canApprove ? '' : 'disabled'}></td><td data-label="Employee">${escapeHtml(row.user_name)}</td><td data-label="Department">${escapeHtml(row.department || '—')}</td>` : ''}
        <td data-label="Date">${escapeHtml(row.expense_date)}</td><td data-label="Category">${escapeHtml(row.category)}</td><td data-label="Description">${escapeHtml(row.description)}</td>
        <td data-label="Amount">${escapeHtml(row.currency)} ${Number(row.amount).toFixed(2)}</td>
        <td data-label="Receipt">${receiptCell}</td>
        <td data-label="Status"><span class="chip ${reimbursementStatus(row.status).className}">${escapeHtml(reimbursementStatus(row.status).label)}</span>${canReview && row.edited_at ? `<small class="hint">Edited after submission · ${escapeHtml(fmtDateTime(row.edited_at))}</small>` : ''}${row.admin_note ? `<small class="hint">${escapeHtml(row.admin_note)}</small>` : ''}</td>
        <td data-label="Action">${canReview ? (canApprove ? `<button class="btn btn-primary btn-sm reimbursement-action" data-id="${row.id}" data-status="approved">Approve</button> <button class="btn btn-danger btn-sm reimbursement-action" data-id="${row.id}" data-status="rejected">Reject</button>` : awaitingDifferentApprover ? '<span class="hint">Waiting for a different approver</span>' : row.status === 'approved' && canPay ? `<button class="btn btn-secondary btn-sm reimbursement-action" data-id="${row.id}" data-status="paid">Mark paid</button>` : '—') : ''}${canEdit ? ` <button class="btn btn-secondary btn-sm reimbursement-edit" data-id="${row.id}" type="button">Edit</button>` : ''}${isAdmin ? ` <button class="btn btn-danger btn-sm reimbursement-delete" data-id="${row.id}">Delete</button>` : ''}</td>
      </tr>`;
      }).join('') : `<tr><td colspan="${canReview ? 10 : 7}" class="hint" style="text-align:center; padding:15px;">No reimbursement claims found.</td></tr>`;
      if (canReview) {
        table.insertAdjacentHTML('beforeend', `<tr class="reimbursement-selection-summary"><td colspan="10" style="text-align:right; font-weight:600;"><span id="reimbursement-selected-count">Selected expenses: 0</span> &nbsp; <span id="reimbursement-selected-total">Total: INR 0.00</span></td></tr>`);
      }
      $$('.reimbursement-edit').forEach(button => {
        button.onclick = event => {
          event.stopPropagation();
          const row = rows.find(item => String(item.id) === button.dataset.id);
          if (row && row.status === 'submitted' && Number(row.user_id) === Number(ME?.id)) showExpenseForm(row);
        };
      });
      $$('.reimbursement-action').forEach(button => {
        button.onclick = async (event) => {
          event.stopPropagation();
          if (button.dataset.status === 'approved' && !await confirmModal('Approve reimbursement?', 'Are you sure you want to approve this reimbursement?', 'Approve', false)) return;
          const rejectionReason = button.dataset.status === 'rejected' ? await rejectionModal() : '';
          if (button.dataset.status === 'rejected' && rejectionReason === null) return;
          const note = rejectionReason || '';
          await api(`/reimbursements/${button.dataset.id}/status`, { method: 'PUT', body: { status: button.dataset.status, admin_note: note } });
          if (button.dataset.status === 'approved') {
            showAppNotification('Expense has been approved successfully.');
          }
          await renderRows();
          await refreshReimbursementSummary();
          await refreshNotificationsAfterAction();
        };
      });
      $$('.reimbursement-delete').forEach(button => {
        button.onclick = async (event) => {
          event.stopPropagation();
          if (!await confirmModal('Delete expense?', 'This expense will be permanently deleted.', 'Delete', true)) return;
          await api(`/reimbursements/${button.dataset.id}`, { method: 'DELETE' });
          showAppNotification('Expense deleted successfully.');
          await renderRows();
          await refreshReimbursementSummary();
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
      const updateSelectedSummary = () => {
        const selected = $$('.reimbursement-select:checked')
          .map(input => rows.find(row => String(row.id) === input.dataset.id))
          .filter(Boolean);
        const totalsByCurrency = new Map();
        selected.forEach(row => {
          const currency = String(row.currency || 'INR');
          totalsByCurrency.set(currency, (totalsByCurrency.get(currency) || 0) + Number(row.amount || 0));
        });
        const total = totalsByCurrency.size
          ? [...totalsByCurrency].map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join(', ')
          : 'INR 0.00';
        $('#reimbursement-selected-count').textContent = `Selected expenses: ${selected.length}`;
        $('#reimbursement-selected-total').textContent = `Total: ${total}`;
      };
      const updateBulkButton = () => {
        const bulkApprove = $('#reimbursement-bulk-approve');
        if (bulkApprove) bulkApprove.style.display = $$('.reimbursement-select:checked').length ? '' : 'none';
        updateSelectedSummary();
      };
      if (selectAll) selectAll.onchange = () => {
        $$('.reimbursement-select:not(:disabled)').forEach(input => { input.checked = selectAll.checked; });
        updateBulkButton();
      };
      $$('.reimbursement-select').forEach(input => input.onchange = updateBulkButton);
      const bulkApprove = $('#reimbursement-bulk-approve');
      if (bulkApprove) bulkApprove.onclick = async () => {
        const ids = $$('.reimbursement-select:checked').map(input => Number(input.dataset.id));
        if (!ids.length) return showAppNotification('Select at least one reimbursement to approve.');
        if (!await confirmModal('Approve selected reimbursements?', `Are you sure you want to approve ${ids.length} reimbursement${ids.length === 1 ? '' : 's'}?`, 'Approve all', false)) return;
        await api('/reimbursements/bulk-status', { method: 'PUT', body: { ids } });
        showAppNotification('Expenses have been approved successfully.');
        await renderRows();
        await refreshReimbursementSummary();
        await refreshNotificationsAfterAction();
      };
    } catch (err) {
      table.innerHTML = `<tr><td colspan="9" class="form-error">${escapeHtml(err.message)}</td></tr>`;
    }
  };

  if (!isAdmin) {
    $('#reimbursement-new-expense').onclick = () => showExpenseForm();
    $('#reimbursement-cancel-new').onclick = hideExpenseForm;
    $('#reimbursement-form').onsubmit = async (event) => {
      event.preventDefault();
      const editing = editingReimbursementId !== null;
      const formData = new FormData();
      formData.append('amount', $('#reimbursement-amount').value);
      formData.append('currency', $('#reimbursement-currency').value);
      formData.append('category', $('#reimbursement-category').value);
      formData.append('expense_date', $('#reimbursement-date').value);
      formData.append('description', $('#reimbursement-description').value.trim());
      if (!editing) formData.append('submission_key', reimbursementSubmissionKey || crypto.randomUUID());
      selectedReceiptFiles.forEach(receipt => formData.append('receipt', receipt));
      const response = await fetch(editing ? `/api/reimbursements/${editingReimbursementId}` : '/api/reimbursements', {
        method: editing ? 'PUT' : 'POST', body: formData, credentials: 'same-origin'
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { $('#reimbursement-form-error').textContent = result.error || 'Unable to save expense.'; return; }
      if (!editing) reimbursementOffset = 0;
      editingReimbursementId = null;
      reimbursementSubmissionKey = null;
      $('#reimbursement-form').reset();
      $('#reimbursement-date').value = todayISO();
      $('#reimbursement-form-title').textContent = 'Submit expense';
      $('#reimbursement-submit').textContent = 'Submit claim';
      $('#reimbursement-receipt').value = '';
      selectedReceiptFiles = [];
      updateReceiptSelection();
      $('#reimbursement-description').style.height = 'auto';
      $('#reimbursement-form-error').textContent = '';
      $('#reimbursement-form-success').textContent = editing ? 'Expense updated successfully.' : 'Expense submitted successfully.';
      $('#employee-reimbursement-form').classList.add('hidden');
      $('#employee-reimbursement-overview').classList.remove('hidden');
      await refreshReimbursementSummary();
      await renderRows();
      showAppNotification(editing ? 'Expense updated successfully.' : 'Expense submitted successfully.');
    };
  }
  ['reimbursement-user', 'reimbursement-status', 'reimbursement-from', 'reimbursement-to'].forEach(id => {
    const filter = $(`#${id}`);
    if (filter) filter.onchange = () => { reimbursementOffset = 0; renderRows(); };
  });
  $('#reimbursement-filter').onclick = () => { reimbursementOffset = 0; renderRows(); };
  $('#reimbursement-prev').onclick = () => {
    reimbursementOffset = Math.max(0, reimbursementOffset - reimbursementPageSize);
    renderRows();
  };
  $('#reimbursement-next').onclick = () => {
    if (!reimbursementHasMore) return;
    reimbursementOffset += reimbursementPageSize;
    renderRows();
  };
  $('#reimbursement-export').onclick = () => {
    const params = new URLSearchParams();
    if (canReview && $('#reimbursement-user')?.value) params.set('user_id', $('#reimbursement-user').value);
    if (canReview && $('#reimbursement-status')?.value) params.set('status', $('#reimbursement-status').value);
    if ($('#reimbursement-from')?.value) params.set('from', $('#reimbursement-from').value);
    if ($('#reimbursement-to')?.value) params.set('to', $('#reimbursement-to').value);
    window.open(`/api/reimbursements/export.csv?${params.toString()}`, '_blank');
  };
  renderRows();
  refreshReimbursementSummary();
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
      <button class="project-item" data-id="${p.id}">${p.locked ? `${icon('lock', 'icon lock')} ` : ''}${escapeHtml(p.name)}</button>
      ${PROJECT_ACTION_ACCESS.delete_project ? `<button class="project-del" data-id="${p.id}" title="Delete project">✕</button>` : ''}`;
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
btnNewProject.style.display = PROJECT_ACTION_ACCESS.create_project ? '' : 'none';
  btnNewProject.addEventListener('click', () => {
    showModal(`
      <h3>New project</h3>
      <input id="np-name" placeholder="Project name" autofocus>
      <input id="np-pin" placeholder="Optional PIN (4–12 digits)" type="text" inputmode="numeric" minlength="4" maxlength="12" pattern="[0-9]{4,12}">
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
      if (pin && !/^\d{4,12}$/.test(pin)) {
        $('#np-error').textContent = 'Project PIN must contain 4 to 12 digits.';
        return;
      }
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
      <h3>${icon('lock')} ${escapeHtml(project.name)}</h3>
      <input id="pin-input" placeholder="Enter PIN" type="password" autofocus>
      <div id="pin-error" class="form-error"></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn btn-primary" id="m-ok">Unlock</button>
      </div>`);
    $('#m-cancel').onclick = () => {
      pendingSearchTaskId = null;
      closeModal();
    };
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
  const renameProjectButton = $('#btn-rename-project');
  if (renameProjectButton) {
    renameProjectButton.style.display = PROJECT_ACTION_ACCESS.edit_project ? '' : 'none';
    renameProjectButton.onclick = async () => {
      const name = await inputModal('Rename project', 'Project name', project.name);
      if (name === null || !name.trim()) return;
      const pinInput = await inputModal('Project PIN', 'New PIN (4–12 digits); leave blank to remove the PIN', '');
      const body = { name: name.trim() };
      if (pinInput !== null) {
        const pin = pinInput.trim();
        if (pin && !/^\d{4,12}$/.test(pin)) {
          showAppNotification('Project PIN must contain 4 to 12 digits.');
          return;
        }
        if (!pin && project.locked && !await confirmModal('Remove project PIN?', 'Remove the current project PIN?', 'Remove PIN')) return;
        body.pin = pin || null;
      }
      if (name.trim() === project.name && pinInput === null) return;
      try {
        await api(`/projects/${project.id}`, { method: 'PUT', body });
        project.name = name.trim();
        if (pinInput !== null) project.locked = Boolean(pinInput.trim());
        if (pTitle) pTitle.textContent = project.name;
        renderProjectList();
        renderProjectsDirectory();
        showAppNotification('Project updated.');
      } catch (error) { showAppNotification(error.message); }
    };
  }
  const searchInput = $('#task-search');
  const suggestions = $('#task-search-suggestions');
  if (searchInput) {
    searchInput.value = '';
    searchInput.dataset.fullSearch = 'false';
  }
  hideTaskSearchSuggestions();
  if (suggestions) suggestions.classList.add('hidden');
  setupTaskFilters();
  const projectMembersPromise = api(`/projects/${project.id}/members`).then(members => {
    if (Number(CURRENT_PROJECT?.id) !== Number(project.id)) return;
    const hint = $('#project-members-hint');
    if (hint) hint.textContent = `${members.length} member${members.length === 1 ? '' : 's'}`;
    const assignee = $('#task-filter-assignee');
    const creator = $('#task-filter-created-by');
    if (assignee) assignee.innerHTML = '<option value="all">All assignees</option>' + members.map(member => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join('');
    const creatorPeople = ME?.role === 'admin' ? PEOPLE : members;
    if (creator) creator.innerHTML = '<option value="all">Anyone</option>' + creatorPeople.map(person => `<option value="${person.id}">${escapeHtml(person.name || person.NAME)}</option>`).join('');
    restoreTaskFilterPreferences();
  }).catch(error => {
    console.warn('Project member filters unavailable:', error.message);
  });
  await projectMembersPromise;
  await renderTasks();
   const newTaskButton = $('#btn-new-task');
   if (newTaskButton) {
  newTaskButton.style.display = PROJECT_ACTION_ACCESS.create_task ? '' : 'none';
  newTaskButton.onclick = () => showNewTaskDrawer();
   }
  const manageMembersButton = $('#btn-manage-members');
  if (manageMembersButton) manageMembersButton.onclick = () => showMembersModal();
  const newProjectButton = $('#project-new-project');
  if (newProjectButton) {
    newProjectButton.style.display = PROJECT_ACTION_ACCESS.create_project ? '' : 'none';
    newProjectButton.onclick = () => document.querySelector('#btn-new-project')?.click();
  }
}

function renderFocusedProjectSwitcher() {
  const list = $('#focused-project-list');
  if (!list) return;
  list.innerHTML = PROJECTS.map(project => `<button class="focused-project ${CURRENT_PROJECT && Number(CURRENT_PROJECT.id) === Number(project.id) ? 'active' : ''}" data-focused-project="${project.id}">${project.locked ? `${icon('lock', 'icon project-lock-icon')} ` : ''}${escapeHtml(project.name)}</button>`).join('');
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
    const creatorPeople = ME?.role === 'admin' ? PEOPLE : members;
    if (creator) creator.innerHTML = '<option value="all">Anyone</option>' + creatorPeople.map(p => `<option value="${p.id}">${escapeHtml(p.name || p.NAME)}</option>`).join('');
  } catch (err) { }
}

function taskFilterPreferenceKey() {
  return `taskflow.taskFilters.v1.${ME?.id || 'anonymous'}.${CURRENT_PROJECT?.id || 'none'}`;
}

function readTaskFilterPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(taskFilterPreferenceKey()) || '{}');
    return preferences && typeof preferences === 'object' ? preferences : {};
  } catch {
    return {};
  }
}

function saveTaskFilterPreferences() {
  const searchInput = $('#task-search');
  const preferences = {
    assignee: $('#task-filter-assignee')?.value || 'all',
    createdBy: $('#task-filter-created-by')?.value || 'all',
    dueDate: $('#task-filter-due')?.value || '',
    createdOn: $('#task-filter-created-on')?.value || '',
    modifiedOn: $('#task-filter-modified-on')?.value || '',
    completedOn: $('#task-filter-completed-on')?.value || '',
    sort: $('#task-sort')?.value || 'manual'
  };
  try {
    localStorage.setItem(taskFilterPreferenceKey(), JSON.stringify(preferences));
  } catch { }
}

function restoreTaskFilterPreferences() {
  const preferences = readTaskFilterPreferences();
  const setSelectValue = (selector, value, allowedValues = null) => {
    const select = $(selector);
    if (!select) return;
    const normalizedValue = String(value ?? '');
    if (allowedValues && !allowedValues.includes(normalizedValue)) return;
    if (Array.from(select.options).some(option => option.value === normalizedValue)) select.value = normalizedValue;
  };
  setSelectValue('#task-filter-assignee', preferences.assignee);
  setSelectValue('#task-filter-created-by', preferences.createdBy);
  setSelectValue('#task-sort', preferences.sort, ['manual', 'title', 'assignee', 'due']);
  [['#task-filter-due', preferences.dueDate], ['#task-filter-created-on', preferences.createdOn],
    ['#task-filter-modified-on', preferences.modifiedOn], ['#task-filter-completed-on', preferences.completedOn]]
    .forEach(([selector, value]) => { const input = $(selector); if (input) input.value = String(value || ''); });
  const searchInput = $('#task-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.dataset.fullSearch = 'false';
  }
}

function setupTaskFilters() {
  const panel = $('#task-filter-panel');
  if (!panel) return;
  restoreTaskFilterPreferences();
  $('#btn-task-filters').onclick = () => panel.classList.toggle('hidden');
  $('#btn-close-task-filters').onclick = () => panel.classList.add('hidden');
  $('#btn-apply-task-filters').onclick = () => { saveTaskFilterPreferences(); renderTasks(); panel.classList.add('hidden'); };
  $('#task-sort').onchange = () => { saveTaskFilterPreferences(); renderTasks(); };
  let searchTimer = null;
  const searchInput = $('#task-search');
  const suggestions = $('#task-search-suggestions');
  const hideSuggestions = () => {
    clearTimeout(searchTimer);
    suggestions.classList.add('hidden');
    suggestions.innerHTML = '';
  };
  hideTaskSearchSuggestions = hideSuggestions;
  const showSuggestions = async () => {
    const value = searchInput.value.trim();
    searchInput.dataset.fullSearch = 'false';
    saveTaskFilterPreferences();
    if (!value) { hideSuggestions(); return; }
    clearTimeout(searchTimer);
    suggestions.classList.add('hidden');
    searchTimer = setTimeout(async () => {
      try {
        const results = await api(`/tasks/search?q=${encodeURIComponent(value)}`);
        if (searchInput.value.trim() !== value) return;
        const visible = results.slice(0, 6);
        suggestions.innerHTML = `${visible.map(task => `<button type="button" class="task-suggestion" data-task-id="${task.id}" data-project-id="${task.project_id}"><b>${escapeHtml(task.title)}</b><span>${escapeHtml(task.project_name || '')}</span></button>`).join('')}${results.length ? `<button type="button" class="task-suggestion task-suggestion-all" data-show-all="true">Show all ${results.length} results</button>` : '<div class="task-suggestion-empty">No matching tasks</div>'}`;
        suggestions.classList.remove('hidden');
        $$('.task-suggestion[data-task-id]').forEach(button => {
          button.onclick = async () => {
            pendingSearchTaskId = Number(button.dataset.taskId);
            hideSuggestions();
            await openProject(Number(button.dataset.projectId));
          };
        });
        const showAll = $('.task-suggestion-all');
        if (showAll) showAll.onclick = () => { searchInput.dataset.fullSearch = 'true'; hideSuggestions(); saveTaskFilterPreferences(); renderTasks(); };
      } catch (error) { hideSuggestions(); }
    }, 180);
  };
  searchInput.oninput = showSuggestions;
  searchInput.onkeydown = (event) => {
    if (event.key === 'Enter' && searchInput.value.trim()) {
      event.preventDefault();
      searchInput.dataset.fullSearch = 'true';
      hideSuggestions();
      saveTaskFilterPreferences();
      renderTasks();
    }
    if (event.key === 'Escape') hideSuggestions();
  };
  $('#btn-task-clear-filters').onclick = () => {
    $('#task-filter-assignee').value = 'all';
    $('#task-filter-created-by').value = 'all';
    ['task-filter-due', 'task-filter-created-on', 'task-filter-modified-on', 'task-filter-completed-on'].forEach(id => { $(`#${id}`).value = ''; });
    $('#task-sort').value = 'manual';
    searchInput.value = '';
    searchInput.dataset.fullSearch = 'false';
    hideSuggestions();
    saveTaskFilterPreferences();
    renderTasks();
  };
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.task-search-wrap')) hideTaskSearchSuggestions();
});

async function renderTasks({ loadMore = false } = {}) {
  if (!CURRENT_PROJECT) return;
  const list = $('#task-list');
  if (!list) return;
  const requestId = ++taskListRequestId;
  const projectId = Number(CURRENT_PROJECT.id);
  activeTaskListController?.abort();
  const controller = new AbortController();
  activeTaskListController = controller;
  const loadTimeout = setTimeout(() => controller.abort(), 30_000);
  const searchInput = $('#task-search');
  const search = searchInput?.dataset.fullSearch === 'true' ? searchInput.value.trim() : '';
  const query = new URLSearchParams({
    status: search ? 'all' : 'open',
    assignee_id: $('#task-filter-assignee')?.value || 'all',
    created_by: $('#task-filter-created-by')?.value || 'all'
  });
  if (search) query.set('q', search);
  [['due_date', 'task-filter-due'], ['created_on', 'task-filter-created-on'], ['modified_on', 'task-filter-modified-on'], ['completed_on', 'task-filter-completed-on']].forEach(([key, id]) => {
    const value = $(`#${id}`)?.value;
    if (value) query.set(key, value);
  });
  const paginationKey = `${projectId}?${query.toString()}`;
  const appendPage = !search && loadMore && taskListPagination.key === paginationKey && taskListPagination.hasMore;
  const pageSize = 50;
  if (!appendPage) {
    taskListPagination = { key: paginationKey, afterId: 0, hasMore: false, tasks: [] };
    list.innerHTML = `<tr><td colspan="4">${uiSkeletonRows(5)}</td></tr>`;
  } else {
    list.querySelector('#task-list-more')?.remove();
    list.querySelector('#task-list-retry')?.closest('tr')?.remove();
    list.insertAdjacentHTML('beforeend', '<tr id="task-list-loading-more"><td colspan="4" class="hint">Loading more tasks...</td></tr>');
  }
  let tasks = appendPage ? taskListPagination.tasks.slice() : [];
  try {
    if (search) {
      query.set('q', search);
      query.set('after_id', '0');
      query.set('limit', String(pageSize));
      tasks = await api(`/projects/${projectId}/tasks?${query.toString()}`, { signal: controller.signal });
      if (requestId !== taskListRequestId || Number(CURRENT_PROJECT?.id) !== projectId) return;
    } else {
      const afterId = appendPage ? taskListPagination.afterId : 0;
      const pageQuery = new URLSearchParams(query);
      pageQuery.set('after_id', String(afterId));
      pageQuery.set('limit', String(pageSize));
      let page;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          page = await api(`/projects/${projectId}/tasks?${pageQuery.toString()}`, { signal: controller.signal });
          break;
        } catch (error) {
          if (error.name === 'AbortError' || (error.status && error.status < 500) || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (requestId !== taskListRequestId || Number(CURRENT_PROJECT?.id) !== projectId) return;
      tasks = appendPage ? tasks.concat(page) : page;
      const nextAfterId = Number(page[page.length - 1]?.id);
      taskListPagination = {
        key: paginationKey,
        afterId: Number.isFinite(nextAfterId) && nextAfterId > afterId ? nextAfterId : afterId,
        hasMore: page.length === pageSize && Number.isFinite(nextAfterId) && nextAfterId > afterId,
        tasks
      };
    }
    if (requestId !== taskListRequestId || Number(CURRENT_PROJECT?.id) !== projectId) return;
    const resultsHeading = $('#task-search-results-heading');
    if (resultsHeading) {
      resultsHeading.classList.toggle('hidden', !search);
      resultsHeading.innerHTML = search ? `Search results for “${escapeHtml(search)}” <span>${tasks.length} task${tasks.length === 1 ? '' : 's'} found</span>` : '';
    }
    const sort = $('#task-sort')?.value || 'manual';
    if (sort === 'manual' && !search) tasks.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || (a.created_at || '').localeCompare(b.created_at || ''));
    if (sort === 'title') tasks.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (sort === 'assignee') tasks.sort((a, b) => (a.assignee_name || 'Unassigned').localeCompare(b.assignee_name || 'Unassigned'));
    if (sort === 'due') tasks.sort((a, b) => (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'));
    list.innerHTML = tasks.length ? tasks.map(task => {
      const due = getDueState(task.due_date);
      return `
      <tr class="task-row ${search ? 'search-result ' : ''}${task.status === 'done' ? 'done' : ''}" data-task-id="${task.id}" tabindex="0" aria-label="Open task: ${escapeHtml(task.title)}">
        <td data-label="Complete"><button class="row-complete ${task.status === 'done' ? 'row-reopen' : ''}" data-task-id="${task.id}" title="${task.status === 'done' ? 'Reopen task' : 'Complete task'}" aria-label="${task.status === 'done' ? 'Reopen task' : 'Complete task'}">${icon('check')}</button></td>
        <td class="task-title-cell" data-label="Task"><span class="task-mobile-label">Task</span><b>${escapeHtml(task.title)}</b></td>
        <td class="task-assignee-cell" data-label="Assignee"><span class="task-mobile-label">Assignee</span><span class="assignee-cell"><span class="avatar" aria-hidden="true">${escapeHtml(getInitials(task.assignee_name || ''))}</span>${escapeHtml(task.assignee_name || 'Unassigned')}</span></td>
        <td class="task-due-cell" data-label="Due"><span class="task-mobile-label">Due</span><span class="chip ${due.className}">${escapeHtml(due.label)}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="4"><div class="empty-state">${icon('check')}<b>${search ? 'No matching tasks' : 'No tasks yet'}</b><p>${search ? 'Try a different search or clear your filters.' : 'Add a task to get this project moving.'}</p>${PROJECT_ACTION_ACCESS.create_task ? '<button type="button" class="btn btn-primary" id="empty-add-task">Add task</button>' : ''}</div></td></tr>`;
    if (!search && taskListPagination.hasMore) {
      list.insertAdjacentHTML('beforeend', `<tr id="task-list-more"><td colspan="4" class="hint" style="text-align:center;padding:12px"><button type="button" class="link-btn" id="task-list-load-more">Load more tasks (${tasks.length} shown)</button></td></tr>`);
      $('#task-list-load-more').onclick = () => renderTasks({ loadMore: true });
    }
    $('#empty-add-task')?.addEventListener('click', () => $('#btn-new-task')?.click());
    $$('.row-complete').forEach(button => {
      button.onclick = async () => {
        const reopening = button.classList.contains('row-reopen');
        const row = button.closest('tr');
        const previousRowClass = row?.className;
        // Show the change at once; roll it back if the server refuses it.
        row?.classList.toggle('done', !reopening);
        button.classList.toggle('row-reopen', !reopening);
        button.disabled = true;
        try {
          await api(`/tasks/${button.dataset.taskId}`, { method: 'PUT', body: { status: reopening ? 'open' : 'done' } });
          showAppNotification(reopening ? 'Task reopened successfully.' : 'Task completed successfully.');
          renderTasks();
        } catch (error) {
          if (row) row.className = previousRowClass;
          button.classList.toggle('row-reopen', reopening);
          button.disabled = false;
          showAppNotification(error.message);
        }
      };
    });
    $$('.task-row').forEach(row => {
      row.onclick = (event) => {
        if (event.target.closest('.row-complete')) return;
        openTaskDrawer(Number(row.dataset.taskId));
      };
      row.onkeydown = event => {
        if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          openTaskDrawer(Number(row.dataset.taskId));
        }
      };
    });
    if (pendingSearchTaskId) {
      const taskId = pendingSearchTaskId;
      pendingSearchTaskId = null;
      await openTaskDrawer(taskId);
    }
  } catch (err) {
    if (requestId !== taskListRequestId || Number(CURRENT_PROJECT?.id) !== projectId) return;
    $('#task-list-loading-more')?.remove();
    const errorRow = `<tr><td colspan="4">${uiErrorState(err, 'task-list-retry')}</td></tr>`;
    if (tasks.length) list.insertAdjacentHTML('beforeend', errorRow);
    else list.innerHTML = errorRow;
    $('#task-list-retry').onclick = () => renderTasks({ loadMore: appendPage });
  } finally {
    clearTimeout(loadTimeout);
    if (activeTaskListController === controller) activeTaskListController = null;
  }
}

function setBillingFieldsDisabled(disabled) {
  const billingBox = $('#drawer-billing-details');
  billingBox?.classList.toggle('billing-disabled', disabled);
  ['drawer-customer-name', 'drawer-invoice-type', 'drawer-invoice-number', 'drawer-invoice-date', 'drawer-total-amount'].forEach(id => {
    const field = $(`#${id}`);
    if (field) field.disabled = disabled;
  });
}

async function showNewTaskDrawer() {
  if (!CURRENT_PROJECT) return;
  const drawer = $('#task-drawer');
  if (!drawer) return;
  const [members, workModeAccess] = await Promise.all([
    api(`/projects/${CURRENT_PROJECT.id}/members`),
    api('/task-work-mode-access/me')
  ]);
  const title = $('#drawer-title');
  const assignee = $('#drawer-assignee');
  const due = $('#drawer-due');
  const customerName = $('#drawer-customer-name');
  const invoiceNumber = $('#drawer-invoice-number');
  const invoiceType = $('#drawer-invoice-type');
  const invoiceDate = $('#drawer-invoice-date');
  const totalAmount = $('#drawer-total-amount');
  const noBillingRequired = $('#drawer-no-billing-required');
  const status = $('#drawer-status');
  const workMode = $('#drawer-work-mode');
  const description = $('#drawer-desc');
  const created = $('#drawer-created');
  const saveButton = $('#btn-save-task');
  const completeButton = $('#btn-complete-task');
  const deleteButton = $('#btn-delete-task');
  if (title) { title.value = ''; title.disabled = false; }
  if (assignee) assignee.innerHTML = '<option value="">No assignee</option>' + members.map(member => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join('');
  const assigneeOrigin = $('#drawer-assignee-origin');
  if (assigneeOrigin) { assigneeOrigin.textContent = ''; assigneeOrigin.classList.add('hidden'); }
  if (assignee) assignee.disabled = false;
  if (due) { due.value = ''; due.disabled = false; }
  if (customerName) { customerName.value = ''; customerName.disabled = false; }
  if (invoiceNumber) { invoiceNumber.value = ''; invoiceNumber.disabled = false; }
  if (invoiceType) { invoiceType.value = 'gst'; invoiceType.disabled = false; }
  if (invoiceDate) { invoiceDate.value = ''; invoiceDate.disabled = false; }
  if (totalAmount) { totalAmount.value = ''; totalAmount.disabled = false; }
  if (noBillingRequired) { noBillingRequired.checked = false; noBillingRequired.disabled = false; }
  setBillingFieldsDisabled(false);
  $('#drawer-billing-error')?.classList.add('hidden');
  if (due) due.removeAttribute('min');
  if (created) created.textContent = 'Created when saved';
  if (status) { status.value = 'open'; status.disabled = true; }
  if (workMode) {
    workMode.value = 'office';
    workMode.disabled = !workModeAccess.allowed;
  }
  if (description) { description.value = ''; description.disabled = false; }
  if (description) {
    description.oninput = autoGrowDescription;
    autoGrowDescription();
  }
  if (saveButton) saveButton.style.display = 'none';
  if (completeButton) { completeButton.textContent = 'Create task'; completeButton.className = 'btn btn-primary btn-block'; completeButton.style.display = ''; }
  if (deleteButton) deleteButton.style.display = 'none';
  $('#drawer-subtasks').innerHTML = '';
  $('#drawer-activity').innerHTML = '<div class="hint">Activity will be available after the task is created.</div>';
  drawer.classList.remove('hidden');
  $('#app').classList.add('drawer-open');
  title?.focus();
  $('#drawer-close').onclick = closeDrawer;
  if (noBillingRequired) {
    noBillingRequired.onchange = () => {
      setBillingFieldsDisabled(noBillingRequired.checked);
      $('#drawer-billing-error')?.classList.add('hidden');
    };
  }
  completeButton.onclick = async () => {
    if (!title.value.trim()) { title.focus(); return; }
    try {
      const body = {
        title: title.value.trim(),
        description: description.value.trim(),
        assignee_id: assignee.value || null,
        due_date: due.value || null,
        no_billing_required: noBillingRequired.checked,
        customer_name: customerName.value.trim(),
        invoice_type: invoiceType.value,
        invoice_number: invoiceNumber.value.trim() || null,
        invoice_date: invoiceDate.value || null,
        total_amount: totalAmount.value || 0
      };
      if (workModeAccess.allowed) body.work_mode = workMode.value;
      const createdTask = await api(`/projects/${CURRENT_PROJECT.id}/tasks`, { method: 'POST', body });
      closeDrawer();
      showAppNotification('Task created successfully.');
      try {
        await renderTasks();
        if (createdTask?.id) await openTaskDrawer(Number(createdTask.id));
      } catch (refreshError) {
        console.error('Task created, but the task view could not refresh:', refreshError);
        showAppNotification('Task created, but the task view could not refresh.');
      }
    } catch (error) { showAppNotification(`Unable to load location timeline: ${error.message}`); }
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
  $('#drawer-activity').innerHTML = '<div class="drawer-loading-line"></div><div class="drawer-loading-line"></div><div class="drawer-loading-line short"></div>';
  $('#btn-save-task').style.display = 'none';
  $('#btn-complete-task').style.display = 'none';
  $('#btn-delete-task').style.display = 'none';
}

async function openTaskDrawer(taskId) {
  const drawer = $('#task-drawer');
  if (!drawer) return;
  const drawerBody = drawer.querySelector('.drawer-body');
  if (drawerBody) drawerBody.scrollTop = 0;
  $$('.task-row.is-selected').forEach(row => row.classList.remove('is-selected'));
  document.querySelector(`.task-row[data-task-id="${CSS.escape(String(taskId))}"]`)?.classList.add('is-selected');
  activeTaskDrawerController?.abort();
  showTaskDrawerLoading();
  const controller = new AbortController();
  activeTaskDrawerController = controller;
  const loadTimeout = setTimeout(() => controller.abort(), 15000);
  try {
    const task = await api(`/tasks/${taskId}`, { signal: controller.signal });
    if (activeTaskDrawerController !== controller) { clearTimeout(loadTimeout); return; }
    clearTimeout(loadTimeout);
    const activityPagePromise = api(`/tasks/${taskId}/activity?limit=15&offset=0`, { signal: controller.signal })
      .catch(error => ({ items: [], has_more: false, error }));
    let members = [];
    const membersPromise = api(`/projects/${task.project_id}/members`, { signal: controller.signal })
      .then(projectMembers => {
        if (activeTaskDrawerController !== controller) return;
        members = projectMembers;
        const assigneeSelect = $('#drawer-assignee');
        const selectedAssignee = assigneeSelect.value;
        members.forEach(member => {
          if (assigneeSelect.querySelector(`option[value="${CSS.escape(String(member.id))}"]`)) return;
          const option = document.createElement('option');
          option.value = member.id;
          option.textContent = member.name;
          assigneeSelect.append(option);
        });
        assigneeSelect.value = selectedAssignee;
      })
      .catch(error => {
        if (error.name !== 'AbortError' && activeTaskDrawerController === controller) {
          console.warn('Project member options unavailable:', error.message);
        }
      });
    const currentCheckin = (task.checkin_users || []).find(user => Number(user.id) === Number(ME?.id));
    const taskCheckinRequired = ME?.role !== 'admin'
      && task.work_mode === 'on_field'
      && Number(task.checkin_required) === 1;
    const isCheckedIntoTask = !!currentCheckin?.check_in_at && !currentCheckin.check_out_at;
    const taskActionsLocked = taskCheckinRequired && !isCheckedIntoTask;
    const canEditTask = !!PROJECT_ACTION_ACCESS.edit_task;
    const canCompleteAfterCheckout = taskCheckinRequired && !!currentCheckin?.check_in_at
      && !!currentCheckin.check_out_at && !!PROJECT_ACTION_ACCESS.complete_task;
    drawer.classList.remove('loading');
    $('#drawer-title').value = task.title || '';
    $('#drawer-title').disabled = taskActionsLocked;
    $('#drawer-assignee').innerHTML = '<option value="">No TaskFlow account assigned</option>' + members.map(member => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join('');
    const currentAssigneeId = String(task.assignee_id ?? '');
    if (currentAssigneeId && !members.some(member => String(member.id) === currentAssigneeId)) {
      const option = document.createElement('option');
      option.value = currentAssigneeId;
      option.textContent = task.assignee_name || `Unknown assignee (${currentAssigneeId})`;
      $('#drawer-assignee').append(option);
    }
    $('#drawer-assignee').disabled = !canEditTask;
    $('#drawer-assignee').value = task.assignee_id || '';
    const assigneeOrigin = $('#drawer-assignee-origin');
    if (assigneeOrigin) {
      const importedAssigneeName = String(task.asana_assignee_name || '').trim();
      assigneeOrigin.textContent = !task.assignee_id && importedAssigneeName
        ? `Asana assignee: ${importedAssigneeName} · not linked to a TaskFlow account; this task remains unassigned.`
        : '';
      assigneeOrigin.classList.toggle('hidden', !assigneeOrigin.textContent);
    }
    const workModeInput = $('#drawer-work-mode');
    if (workModeInput) {
      workModeInput.value = task.work_mode || 'office';
      workModeInput.disabled = taskActionsLocked || Number(task.can_change_work_mode) !== 1;
    }
    $('#drawer-due').value = task.due_date || '';
    $('#drawer-due').disabled = taskActionsLocked;
    $('#drawer-customer-name').value = task.customer_name || '';
    $('#drawer-customer-name').disabled = taskActionsLocked;
    $('#drawer-invoice-number').value = task.invoice_number || '';
    $('#drawer-invoice-number').disabled = taskActionsLocked;
    $('#drawer-invoice-type').value = task.invoice_type || 'gst';
    $('#drawer-invoice-type').disabled = taskActionsLocked;
    $('#drawer-invoice-date').value = task.invoice_date || '';
    $('#drawer-invoice-date').disabled = taskActionsLocked;
    $('#drawer-total-amount').value = task.total_amount ? Number(task.total_amount).toFixed(2) : '';
    $('#drawer-total-amount').disabled = taskActionsLocked;
    const noBillingRequired = $('#drawer-no-billing-required');
    if (noBillingRequired) {
      noBillingRequired.checked = Number(task.no_billing_required) === 1;
      noBillingRequired.disabled = taskActionsLocked || !canEditTask;
    }
    setBillingFieldsDisabled(Number(task.no_billing_required) === 1 || taskActionsLocked || !canEditTask);
    $('#drawer-billing-error')?.classList.add('hidden');
    $('#drawer-due').removeAttribute('min');
    $('#drawer-created').textContent = fmtDateTime(task.created_at);
    $('#drawer-status').value = task.status || 'open';
    $('#drawer-status').disabled = taskActionsLocked;
    $('#drawer-desc').value = task.description || '';
    $('#drawer-desc').disabled = taskActionsLocked;
    $('#drawer-desc').oninput = autoGrowDescription;
    autoGrowDescription();
    $('#drawer-subtasks').innerHTML = (task.subtasks || []).map(item => `<label class="subtask-row ${item.done ? 'done' : ''}"><input type="checkbox" class="subtask-check" data-subtask-id="${item.id}" ${item.done ? 'checked' : ''} ${taskActionsLocked ? 'disabled' : ''}><span class="subtask-title">${escapeHtml(item.title)}</span><button class="subtask-del" data-subtask-id="${item.id}" title="Delete subtask" ${taskActionsLocked || !PROJECT_ACTION_ACCESS.delete_task ? 'disabled' : ''}>✕</button></label>`).join('') || '<div class="hint">No subtasks yet.</div>';
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
    const activityContainer = $('#drawer-activity');
    const activityItems = [];
    let activityOffset = 0;
    let activityHasMore = false;
    let activityLoading = false;
    let activityMode = 'all';
    const bindActivityActions = () => {
      $$('.task-difference-toggle').forEach(button => {
        button.onclick = () => {
          const panel = activityContainer.querySelector(`[data-history-panel="${button.dataset.historyIndex}"]`);
          if (!panel) return;
          const expanded = panel.classList.toggle('hidden');
          button.textContent = expanded ? 'Show difference' : 'Hide difference';
        };
      });
      $$('.comment-edit-button').forEach(button => {
        button.onclick = () => {
          const comment = activityItems.find(item => item.activity_type === 'comment' && Number(item.id) === Number(button.dataset.commentId));
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
              meta.innerHTML = `<b>${escapeHtml(comment.user_name || comment.author_name || 'Unknown user')}</b> · ${escapeHtml(fmtDateTime(comment.created_at))} <span class="comment-edited">Edited · ${escapeHtml(fmtDateTime(result.edited_at))}</span>`;
              if (editButton) meta.appendChild(editButton);
            } catch (err) { error.textContent = err.message; }
          };
        };
      });
    };
    const renderActivity = () => {
      const orderedItems = [...activityItems].sort((left, right) => {
        const timeDifference = Date.parse(left.created_at) - Date.parse(right.created_at);
        if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
        if (left.activity_type !== right.activity_type) return left.activity_type === 'history' ? -1 : 1;
        return Number(left.id) - Number(right.id);
      });
      const visibleItems = activityMode === 'comments'
        ? orderedItems.filter(entry => entry.activity_type === 'comment')
        : orderedItems;
      const activityHtml = visibleItems.map((entry, index) => {
        const timestamp = escapeHtml(fmtDateTime(entry.created_at));
        if (entry.activity_type === 'comment') {
          return `<div class="task-activity-group"><div class="activity-group-entry comment" data-comment-id="${entry.id}">
            <div class="comment-meta"><b>${escapeHtml(entry.user_name || entry.author_name || 'Unknown user')}</b> <span class="activity-inline-time">· ${timestamp}</span>${entry.edited_at ? ` <span class="comment-edited">Edited · ${escapeHtml(fmtDateTime(entry.edited_at))}</span>` : ''}${!taskActionsLocked && Number(entry.user_id) === Number(ME?.id) ? ` <button type="button" class="link-btn comment-edit-button" data-comment-id="${entry.id}">Edit</button>` : ''}</div>
            <div class="comment-body">${escapeHtml(entry.body || '').replace(/\n/g, '<br>')}</div>
            ${renderCommentAttachment(entry)}
          </div></div>`;
        }
        const isAsanaStory = String(entry.field_name || '').startsWith('Asana:');
        const actorName = entry.author_name || entry.actor_name || '';
        const actor = escapeHtml(actorName || (isAsanaStory ? 'Unknown Asana user' : 'Unknown user'));
        const oldValue = escapeHtml(entry.old_value || '(empty)');
        const newValue = escapeHtml(entry.new_value || '(empty)');
        let message = entry.field_name === 'Task created' ? 'created this task' : `changed the ${String(entry.field_name || 'activity').toLowerCase()}`;
        if (entry.field_name === 'Assignee') message = `reassigned this task from ${oldValue} to ${newValue}`;
        if (entry.field_name === 'Due date') message = `changed the due date from ${oldValue} to ${newValue}`;
        if (entry.field_name === 'Task check-in') message = 'checked in to this task';
        if (entry.field_name === 'Task check-out') message = 'checked out of this task';
        if (isAsanaStory) {
          message = String(entry.new_value || '').trim();
          if (actorName && message.toLocaleLowerCase().startsWith(actorName.toLocaleLowerCase())) message = message.slice(actorName.length).trim();
          message = escapeHtml(message || 'updated this task');
        }
        const difference = entry.field_name === 'Description' ? `<button type="button" class="link-btn task-difference-toggle" data-history-index="${index}">Show difference</button><div class="task-difference hidden" data-history-panel="${index}"><div class="task-history-old"><b>Old:</b> ${oldValue}</div><div class="task-history-new"><b>New:</b> ${newValue}</div></div>` : '';
        return `<div class="task-activity-group"><div class="activity-group-entry task-activity-change"><b>${actor}</b> ${message} <span class="activity-inline-time">· ${timestamp}</span>${difference}</div></div>`;
      }).join('');
      const emptyMessage = activityMode === 'comments' ? 'No comments yet.' : 'No activity yet.';
      activityContainer.innerHTML = `${activityHasMore ? '<button type="button" id="task-activity-load-more" class="link-btn">Load older activity</button>' : ''}${activityHtml || `<div class="hint">${emptyMessage}</div>`}<div id="task-activity-error" class="form-error"></div>`;
      bindActivityActions();
      const loadOlderButton = $('#task-activity-load-more');
      if (loadOlderButton) loadOlderButton.onclick = async () => {
        if (activityLoading) return;
        activityLoading = true;
        loadOlderButton.disabled = true;
        loadOlderButton.textContent = 'Loading older activity...';
        try {
          const page = await api(`/tasks/${taskId}/activity?limit=15&offset=${activityOffset}`, { signal: controller.signal });
          if (activeTaskDrawerController !== controller) return;
          activityItems.push(...page.items);
          activityOffset = page.next_offset;
          activityHasMore = page.has_more;
          renderActivity();
        } catch (error) {
          const errorNode = $('#task-activity-error');
          if (errorNode) errorNode.textContent = error.message;
          loadOlderButton.disabled = false;
          loadOlderButton.textContent = 'Retry loading older activity';
        } finally {
          activityLoading = false;
        }
      };
    };
    $$('.activity-filter-tab').forEach(button => {
      button.onclick = () => {
        activityMode = button.dataset.activityMode;
        $$('.activity-filter-tab').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
        renderActivity();
      };
    });
    activityContainer.innerHTML = uiSkeletonRows(3);
    activityPagePromise.then(page => {
      if (activeTaskDrawerController !== controller) return;
      if (page.error) {
        activityContainer.innerHTML = `<div class="form-error">Unable to load activity: ${escapeHtml(page.error.message)}</div><button type="button" id="task-activity-retry" class="link-btn">Retry</button>`;
        $('#task-activity-retry').onclick = () => {
          activityContainer.innerHTML = uiSkeletonRows(3);
          api(`/tasks/${taskId}/activity?limit=15&offset=0`, { signal: controller.signal }).then(nextPage => {
            if (activeTaskDrawerController !== controller) return;
            activityItems.push(...nextPage.items);
            activityOffset = nextPage.next_offset;
            activityHasMore = nextPage.has_more;
            renderActivity();
          }).catch(error => { activityContainer.innerHTML = `<div class="form-error">Unable to load activity: ${escapeHtml(error.message)}</div>`; });
        };
        return;
      }
      activityItems.push(...page.items);
      activityOffset = page.next_offset;
      activityHasMore = page.has_more;
      renderActivity();
    });
    membersPromise.catch(() => {});
    $('#comment-image-preview').innerHTML = '';
    $('#comment-image-preview').classList.add('hidden');
    $('#comment-file-input').value = '';
    $('#drawer-comment-input').value = '';
    $('#drawer-comment-input').disabled = taskActionsLocked;
    $('#btn-attach-image').disabled = taskActionsLocked;
    $('#btn-add-comment').disabled = taskActionsLocked;
    $('#drawer-comment-input').oninput = autoGrowComment;
    autoGrowComment();
    $('#btn-save-task').style.display = PROJECT_ACTION_ACCESS.edit_task || Number(task.can_change_work_mode) === 1 ? '' : 'none';
    $('#btn-save-task').disabled = taskActionsLocked && !canEditTask;
    $('#btn-save-task').className = 'btn btn-secondary btn-sm';
    $('#btn-complete-task').style.display = PROJECT_ACTION_ACCESS.complete_task ? '' : 'none';
    $('#btn-complete-task').textContent = task.status === 'done' ? '↻ Reopen task' : '✓ Complete task';
    $('#btn-complete-task').disabled = taskActionsLocked && !canCompleteAfterCheckout;
    $('#btn-complete-task').className = 'btn btn-primary btn-block';
    $('#btn-delete-task').style.display = PROJECT_ACTION_ACCESS.delete_task ? '' : 'none';
    $('#btn-delete-task').disabled = taskActionsLocked;
    $('#btn-add-subtask').disabled = taskActionsLocked;
    drawer.classList.remove('hidden');
    $('#app').classList.add('drawer-open');
    $('#drawer-close').onclick = closeDrawer;
    const getTaskDraft = () => ({
      title: $('#drawer-title').value.trim(),
      description: $('#drawer-desc').value,
      assignee_id: $('#drawer-assignee').value || null,
      due_date: $('#drawer-due').value || null,
      no_billing_required: $('#drawer-no-billing-required').checked,
      customer_name: $('#drawer-customer-name').value.trim(),
      invoice_type: $('#drawer-invoice-type').value,
      invoice_number: $('#drawer-invoice-number').value.trim() || null,
      invoice_date: $('#drawer-invoice-date').value || null,
      total_amount: $('#drawer-total-amount').value || 0,
      status: $('#drawer-status').value,
      work_mode: $('#drawer-work-mode').value
    });
    const syncTaskListRow = (draft, status = task.status) => {
      const row = document.querySelector(`.task-row[data-task-id="${CSS.escape(String(taskId))}"]`);
      if (!row) return;
      const assigneeFilter = $('#task-filter-assignee')?.value || 'all';
      const isSearching = $('#task-search')?.dataset.fullSearch === 'true';
      row.hidden = (!isSearching && status === 'done')
        || (assigneeFilter !== 'all' && String(draft.assignee_id || '') !== assigneeFilter);
      if (row.hidden) return;
      row.classList.toggle('done', status === 'done');
      const statusButton = row.querySelector('.row-complete');
      if (statusButton) {
        statusButton.classList.toggle('row-reopen', status === 'done');
        statusButton.title = status === 'done' ? 'Reopen task' : 'Complete task';
        statusButton.setAttribute('aria-label', status === 'done' ? 'Reopen task' : 'Complete task');
      }
      const title = row.querySelector('.task-title-cell b');
      if (title) title.textContent = draft.title;
      const assigneeCell = row.querySelector('.task-assignee-cell .assignee-cell');
      if (assigneeCell) {
        const assigneeName = draft.assignee_id
          ? $('#drawer-assignee').selectedOptions[0]?.textContent || task.assignee_name || 'Unassigned'
          : task.asana_assignee_name || 'Unassigned';
        assigneeCell.innerHTML = `<span class="avatar" aria-hidden="true">${escapeHtml(getInitials(assigneeName))}</span>${escapeHtml(assigneeName)}`;
      }
      const dueChip = row.querySelector('.task-due-cell .chip');
      if (dueChip) {
        const due = getDueState(draft.due_date);
        dueChip.className = `chip ${due.className}`;
        dueChip.textContent = due.label;
      }
    };
    let savedTaskDraft = getTaskDraft();
    let savedTaskDraftKey = JSON.stringify(savedTaskDraft);
    const showTaskSaveError = (error, action) => {
      const saveState = $('#drawer-save-state');
      if (saveState) {
        saveState.textContent = 'Save failed';
        saveState.className = 'drawer-save-state error';
        saveState.title = error.message;
      }
      console.error(`${action}:`, error);
    };
    const saveChanges = async () => {
      const draft = getTaskDraft();
      const draftKey = JSON.stringify(draft);
      if (draftKey === savedTaskDraftKey) return;
      const saveState = $('#drawer-save-state');
      if (saveState) { saveState.textContent = 'Saving...'; saveState.className = 'drawer-save-state'; saveState.title = ''; }
      const body = {};
      Object.keys(draft).forEach(key => {
        if (draft[key] !== savedTaskDraft[key]
          && (key !== 'work_mode' || Number(task.can_change_work_mode) === 1)) {
          body[key] = draft[key];
        }
      });
      if (Object.keys(body).length === 0) {
        savedTaskDraft = draft;
        savedTaskDraftKey = draftKey;
        if (saveState) { saveState.textContent = 'Saved'; saveState.className = 'drawer-save-state saved'; saveState.title = ''; }
        return;
      }
      await api(`/tasks/${taskId}`, { method: 'PUT', body });
      savedTaskDraft = draft;
      savedTaskDraftKey = draftKey;
      if (saveState) { saveState.textContent = 'Saved'; saveState.className = 'drawer-save-state saved'; saveState.title = ''; }
      syncTaskListRow(draft);
    };
    let autosaveTimer = null;
    const queueAutosave = () => {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => saveChanges().catch(err => showTaskSaveError(err, 'Task autosave failed')), 500);
    };
    $('#drawer-title').oninput = queueAutosave;
    $('#drawer-desc').onblur = async () => {
      clearTimeout(autosaveTimer);
      try {
        await saveChanges();
      } catch (err) {
        showTaskSaveError(err, 'Description save failed');
      }
    };
    $('#drawer-assignee').onchange = queueAutosave;
    $('#drawer-due').onchange = queueAutosave;
    $('#drawer-no-billing-required').onchange = () => {
      setBillingFieldsDisabled($('#drawer-no-billing-required').checked || taskActionsLocked || !canEditTask);
      $('#drawer-billing-error')?.classList.add('hidden');
      queueAutosave();
    };
    $('#drawer-customer-name').onchange = queueAutosave;
    $('#drawer-invoice-number').onchange = queueAutosave;
    $('#drawer-invoice-type').onchange = queueAutosave;
    $('#drawer-invoice-date').onchange = queueAutosave;
    $('#drawer-total-amount').onchange = queueAutosave;
    $('#drawer-status').onchange = queueAutosave;
    $('#drawer-work-mode').onchange = queueAutosave;
    $('#btn-save-task').onclick = async () => {
      clearTimeout(autosaveTimer);
      if (!canEditTask && Number(task.can_change_work_mode) !== 1) return;
      try {
        await saveChanges();
        closeDrawer();
        showAppNotification('Task saved successfully.');
      } catch (err) {
        showTaskSaveError(err, 'Task save failed');
      }
    };
    const checkinControls = $('#task-checkin-controls');
    if (checkinControls) {
      if (task.work_mode !== 'on_field' || !currentCheckin) {
        checkinControls.innerHTML = task.work_mode === 'on_field' ? '<div class="hint">You are not required to check in/out for this task.</div>' : '';
      } else if (!currentCheckin.check_in_at || currentCheckin.check_out_at) {
        checkinControls.innerHTML = `<button class="btn btn-secondary btn-block" id="btn-task-check-in">${icon('pin')} ${Number(task.assignee_id) === Number(ME?.id) ? 'Check in to task' : 'Take task & check in'}</button>`;
      } else if (!currentCheckin.check_out_at) {
        checkinControls.innerHTML = `<div class="hint">Checked in at ${escapeHtml(fmtDateTime(currentCheckin.check_in_at))}</div><button class="btn btn-secondary btn-block" id="btn-task-check-out">${icon('pin')} Check out of task</button>`;
      }
      if (taskActionsLocked) {
        checkinControls.insertAdjacentHTML('afterbegin', '<div class="hint">Check in to unlock task editing and comments. You may reassign this task before checking in.</div>');
      }
      const checkInButton = $('#btn-task-check-in');
      const checkOutButton = $('#btn-task-check-out');
      const recordTaskLocation = async (path, message) => {
        try {
          if (path === 'check-in') await saveChanges();
          const coords = await getLiveCoords();
          await api(`/tasks/${taskId}/${path}`, { method: 'POST', body: coords });
          await renderTasks();
          await openTaskDrawer(taskId);
        } catch (error) { showAppNotification(error.message); }
      };
      if (checkInButton) checkInButton.onclick = () => recordTaskLocation('check-in', 'Task check-in recorded.');
      if (checkOutButton) checkOutButton.onclick = () => recordTaskLocation('check-out', 'Task check-out recorded.');
    }
    let isCompleted = task.status === 'done';
    $('#btn-complete-task').onclick = async () => {
      if (!isCompleted && !$('#drawer-no-billing-required').checked) {
        const billingError = $('#drawer-billing-error');
        const missingField = !$('#drawer-customer-name').value.trim() ? $('#drawer-customer-name')
          : !$('#drawer-invoice-number').value.trim() ? $('#drawer-invoice-number')
            : !$('#drawer-invoice-date').value ? $('#drawer-invoice-date')
              : !(Number($('#drawer-total-amount').value) > 0) ? $('#drawer-total-amount') : null;
        if (missingField) {
          billingError.textContent = 'Enter customer, invoice number, invoice date, and a total amount greater than zero, or select No billing required.';
          billingError.classList.remove('hidden');
          missingField.focus();
          return;
        }
      }
      $('#drawer-billing-error')?.classList.add('hidden');
      try {
        clearTimeout(autosaveTimer);
        if (!isCompleted) await saveChanges();
        const nextStatus = isCompleted ? 'open' : 'done';
        await api(`/tasks/${taskId}`, { method: 'PUT', body: { status: nextStatus } });
        isCompleted = nextStatus === 'done';
        task.status = nextStatus;
        $('#drawer-status').value = nextStatus;
        savedTaskDraft = getTaskDraft();
        savedTaskDraftKey = JSON.stringify(savedTaskDraft);
        $('#btn-complete-task').textContent = isCompleted ? '↻ Reopen task' : '✓ Complete task';
        syncTaskListRow(savedTaskDraft, nextStatus);
        showAppNotification(isCompleted ? 'Task reopened successfully.' : 'Task completed successfully.');
      } catch (error) {
        if (!isCompleted && /billing details/i.test(error.message)) {
          const billingError = $('#drawer-billing-error');
          if (billingError) { billingError.textContent = error.message; billingError.classList.remove('hidden'); }
        } else showAppNotification(error.message);
      }
    };
    $('#btn-delete-task').onclick = async () => {
      if (!await confirmModal('Delete task?', 'Delete this task permanently?')) return;
      try {
        await api(`/tasks/${taskId}`, { method: 'DELETE' });
        closeDrawer();
        await renderTasks();
        showAppNotification('Task deleted successfully.');
      } catch (error) {
        showAppNotification(`Unable to delete task: ${error.message}`);
      }
    };
    $('#btn-add-subtask').onclick = async () => {
      if (taskActionsLocked) return;
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
    $('#btn-attach-image').onclick = () => { if (!taskActionsLocked) fileInput.click(); };
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
      if (taskActionsLocked) return;
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
      $('#drawer-activity').appendChild(commentEntry);
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
        showAppNotification(`Attendance update failed: ${error.message}`);
      } finally {
        if (postButton) postButton.disabled = false;
      }
    };
  } catch (err) {
    clearTimeout(loadTimeout);
    if (activeTaskDrawerController !== controller) return;
    drawer.classList.remove('loading');
    $('#drawer-title').value = 'Unable to load task';
    const message = err.name === 'AbortError' ? 'Task loading timed out. Close and reopen the task to try again.' : err.message;
    $('#drawer-activity').innerHTML = `<div class="form-error">${escapeHtml(message)}</div>`;
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
    ME.role === 'admin' ? api('/auth/users') : api(`/projects/${CURRENT_PROJECT.id}/member-candidates`)
  ]);
  const memberIds = new Set(members.map(member => Number(member.id)));
  showModal(`
    <h3>Project members</h3>
    <input type="search" id="project-member-search" placeholder="Search employee name" aria-label="Search employee name" autocomplete="off">
    <div class="member-list">${users.map(user => {
      const name = String(user.name || user.NAME || '');
      return `<label class="member-option project-member-option" data-member-name="${escapeHtml(name.toLocaleLowerCase())}"><input type="checkbox" class="project-member-check" value="${user.id}" ${memberIds.has(Number(user.id)) ? 'checked' : ''}><span class="project-member-name">${escapeHtml(name)}</span></label>`;
    }).join('')}</div>
    <div id="members-error" class="form-error"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="members-cancel">Cancel</button><button class="btn btn-primary" id="members-save">Save members</button></div>`);
  $('#project-member-search').oninput = event => {
    const query = event.currentTarget.value.trim().toLocaleLowerCase();
    $$('.project-member-option').forEach(option => {
      option.hidden = !option.dataset.memberName.includes(query);
    });
  };
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
    list.innerHTML = tasks.length ? tasks.map(task => {
      const due = getDueState(task.due_date);
      return `
      <tr class="my-task-row" data-task-id="${task.id}" tabindex="0" aria-label="Open task: ${escapeHtml(task.title)}">
        <td data-label="Complete"><button class="row-complete" data-task-id="${task.id}" title="Complete task" aria-label="Complete task">${icon('check')}</button></td>
        <td data-label="Task"><span class="task-mobile-label">Task</span><b>${escapeHtml(task.title)}</b></td>
        <td data-label="Project"><span class="task-mobile-label">Project</span>${escapeHtml(task.project_name)}</td>
        <td data-label="Due"><span class="task-mobile-label">Due</span><span class="chip ${due.className}">${escapeHtml(due.label)}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="4"><div class="empty-state">${icon('check')}<b>All caught up</b><p>No open tasks are assigned to you.</p></div></td></tr>`;
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
      row.onkeydown = event => {
        if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          openTaskDrawer(Number(row.dataset.taskId));
        }
      };
    });
  } catch (err) {
    list.innerHTML = `<tr><td colspan="4" class="form-error">${escapeHtml(err.message)}</td></tr>`;
  }
}

// ================= FIELD ATTENDANCE GEO-TRACKING OPERATORS =================
async function getLiveCoords() {
  const nativeGeolocation = window.TaskFlowGeolocation;
  if (window.Capacitor?.isNativePlatform?.()) {
    if (!nativeGeolocation) throw new Error('Update the TaskFlow mobile app to enable location access.');
    try {
      let permission = await nativeGeolocation.checkPermissions();
      if (permission.location !== 'granted') {
        permission = await nativeGeolocation.requestPermissions({ permissions: ['location'] });
      }
      if (permission.location !== 'granted') {
        throw new Error('Allow location permission for TaskFlow in phone settings, then try again.');
      }
      const position = await nativeGeolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
      return { lat: position.coords.latitude, lng: position.coords.longitude };
    } catch (error) {
      if (error.message?.startsWith('Allow location permission')) throw error;
      if (/location services are disabled|location is disabled/i.test(error.message || '')) {
        throw new Error('Turn on Location/GPS in phone settings, then try again.');
      }
      throw new Error('Unable to access location. Allow location for TaskFlow and turn on GPS, then try again.');
    }
  }
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
      return requestLocation();
    }
    navigator.permissions.query({ name: 'geolocation' }).then(permission => {
      if (permission.state === 'denied') {
        reject(new Error('Location permission is blocked. Enable Location for this browser in phone settings, then try again.'));
        return;
      }
      requestLocation();
    }).catch(requestLocation);
  });
}

function attendanceFeedbackMarkup() {
  return `<div id="attendance-biometric-feedback" class="attendance-biometric-feedback hidden" role="status" aria-live="polite"><span id="attendance-biometric-icon" class="attendance-biometric-icon">${icon('fingerprint')}</span><span id="attendance-biometric-message"></span></div><p id="attendance-punch-progress" class="attendance-punch-progress hidden" role="status" aria-live="polite"></p>`;
}

function showAttendanceLocationHelp(actionRegion, error) {
  if (!nativeApp || !/location|gps/i.test(error.message || '')) return;
  let notice = actionRegion.querySelector('.attendance-location-error');
  if (!notice) {
    notice = document.createElement('p');
    notice.className = 'attendance-location-error';
    notice.setAttribute('role', 'alert');
    actionRegion.prepend(notice);
  }
  notice.textContent = `${error.message} You can manage the permission in your phone settings.`;
}

function setAttendanceBiometricFeedback(state, message) {
  const feedback = $('#attendance-biometric-feedback');
  const biometricIcon = $('#attendance-biometric-icon');
  const label = $('#attendance-biometric-message');
  if (!feedback || !biometricIcon || !label) return;
  feedback.classList.remove('hidden');
  biometricIcon.classList.remove('is-pending', 'is-success', 'is-error');
  biometricIcon.classList.add(`is-${state}`);
  label.textContent = message;
}

function setAttendancePunchProgress(message) {
  const progress = $('#attendance-punch-progress');
  if (!progress) return;
  progress.textContent = message;
  progress.classList.toggle('hidden', !message);
}

async function vibrateAttendance(pulses = 1) {
  const haptics = window.TaskFlowHaptics;
  if (nativeApp && haptics?.impact) {
    try {
      for (let pulse = 0; pulse < pulses; pulse++) {
        await haptics.impact({ style: 'MEDIUM' });
        if (pulse + 1 < pulses) await new Promise(resolve => setTimeout(resolve, 160));
      }
      return;
    } catch (error) {
      console.warn('Native attendance haptics failed; using browser vibration fallback.', error);
    }
  }
  if (typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pulses > 1 ? [90, 100, 90] : 90);
    } catch (error) {
      console.warn('Browser attendance vibration fallback failed.', error);
    }
  }
}

function bindAttendancePunchAction(button, action) {
  if (!nativeApp) {
    button.onclick = () => action(button);
    return;
  }

  let holdTimer = null;
  let holdCompleted = false;
  const cancelHold = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    button.classList.remove('is-holding');
    if (!holdCompleted) setAttendancePunchProgress('');
  };

  button.addEventListener('pointerdown', event => {
    if (button.disabled || (event.button != null && event.button !== 0)) return;
    holdCompleted = false;
    button.classList.add('is-holding');
    setAttendancePunchProgress('Keep holding to verify…');
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holdCompleted = true;
      button.classList.remove('is-holding');
      setAttendancePunchProgress('');
      void action(button);
    }, 650);
  });
  button.addEventListener('pointerup', cancelHold);
  button.addEventListener('pointercancel', cancelHold);
  button.addEventListener('pointerleave', () => {
    if (holdTimer) cancelHold();
  });
  button.addEventListener('click', event => {
    if (holdCompleted) {
      holdCompleted = false;
      event.preventDefault();
      return;
    }
    if (event.detail === 0 && !button.disabled) void action(button);
    else event.preventDefault();
  });
}

function loadNativeBridgeScript() {
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = `/js/native-capacitor.js?v=43&retry=${Date.now()}`;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

async function waitForNativeBridge(timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (window.TaskFlowBiometricAuth) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return Boolean(window.TaskFlowBiometricAuth);
}

async function verifyAttendanceIfRequired(action) {
  const setting = await api('/attendance/verification-required');
  if (!setting.required) return null;
  const insideApp = Boolean(window.Capacitor?.isNativePlatform?.());
  if (insideApp && !window.TaskFlowBiometricAuth) {
    // Inside the app but the native bridge script did not finish loading (slow or dropped connection).
    // Wait briefly, then try loading it once more before giving up.
    if (!await waitForNativeBridge()) {
      await loadNativeBridgeScript();
      await waitForNativeBridge(3000);
    }
  }
  const biometricAuth = window.TaskFlowBiometricAuth;
  if (!insideApp) {
    setAttendanceBiometricFeedback('error', 'Open the TaskFlow mobile app to punch.');
    await vibrateAttendance(2);
    throw new Error('Attendance verification requires the installed TaskFlow mobile app.');
  }
  if (!biometricAuth) {
    setAttendanceBiometricFeedback('error', 'Phone verification did not load. Check your connection and try again.');
    await vibrateAttendance(2);
    throw new Error('Phone verification did not load. Check your connection and try again.');
  }
  setAttendanceBiometricFeedback('pending', 'Verify with fingerprint or phone screen lock.');
  try {
    await biometricAuth.authenticate({
      reason: `Verify identity before punch ${action}`,
      androidTitle: `Verify before punch ${action}`,
      androidSubtitle: 'Use fingerprint, face, or your phone screen lock',
      allowDeviceCredential: true,
      androidConfirmationRequired: false,
      androidBiometryStrength: window.TaskFlowAndroidBiometryStrength?.weak,
      iosFallbackTitle: 'Use device passcode'
    });
  } catch (error) {
    const failureDetail = error?.code || error?.message;
    setAttendanceBiometricFeedback('error', failureDetail
      ? `Verification failed (${failureDetail}). Use your phone screen lock and try again.`
      : 'Verification failed. Use your phone screen lock and try again.');
    await vibrateAttendance(2);
    throw new Error('Phone verification failed. Use your phone screen lock and try again.');
  }
  setAttendanceBiometricFeedback('success', 'Phone verification successful.');
  await vibrateAttendance(1);
  return 'native-device-credential';
}

function isPhoneDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function currentDeviceType() {
  if (window.Capacitor?.isNativePlatform?.()) return 'phone';
  return isPhoneDevice() ? 'mobile_browser' : 'laptop';
}

function currentDeviceLabel() {
  const deviceType = currentDeviceType();
  return deviceType === 'phone'
    ? 'TaskFlow app'
    : deviceType === 'mobile_browser' ? 'mobile browser' : 'laptop browser';
}

function getBrowserAttendanceDeviceId() {
  const storageKey = `taskflow-attendance-device:${ME.id}`;
  let deviceId = localStorage.getItem(storageKey);
  if (!deviceId) {
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    deviceId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(storageKey, deviceId);
  }
  return deviceId;
}

async function getAttendanceDeviceId(nativeIdentity = null) {
  if (!window.Capacitor?.isNativePlatform?.()) return getBrowserAttendanceDeviceId();
  const identity = nativeIdentity || await getLoginDevicePayload();
  const source = new TextEncoder().encode(`taskflow-attendance:${identity.device_id}`);
  const digest = await window.crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getPunchDevicePayload() {
  const nativeIdentity = window.Capacitor?.isNativePlatform?.() ? await getLoginDevicePayload() : null;
  const payload = {
    device_type: currentDeviceType(),
    device_id: await getAttendanceDeviceId(nativeIdentity)
  };
  if (nativeIdentity) {
    payload.device_model = `${nativeIdentity.manufacturer} ${nativeIdentity.model}`.trim().slice(0, 80);
    return payload;
  }
  try {
    const details = await navigator.userAgentData?.getHighEntropyValues?.(['model']);
    if (details?.model && !/^k$/i.test(details.model.trim())) payload.device_model = details.model.trim();
  } catch (error) {
    console.debug('Device model is unavailable from this browser.');
  }
  return payload;
}

async function renderPunchCard() {
  const card = $('#punch-card-container');
  if (!card) return;
  try {
    const nativeIdentity = window.Capacitor?.isNativePlatform?.() ? await getLoginDevicePayload() : null;
    const deviceId = await getAttendanceDeviceId(nativeIdentity);
    const [status, deviceAccess, registration] = await Promise.all([
      api('/attendance/today'),
      api('/attendance/device-access/me'),
      api(`/attendance/device-registration/me?device_id=${encodeURIComponent(deviceId)}`)
    ]);
    if (!deviceAccess[`allow_${currentDeviceType()}`]) {
      card.innerHTML = `<div class="admin-block attendance-phone-only"><b>Attendance is disabled on this device</b><p class="hint">Ask an administrator to allow punching from the ${currentDeviceLabel()}.</p></div>`;
      return;
    }
    if (!registration.registered && !registration.rebind_pending) {
      const nativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
      const deviceLabel = nativeApp ? 'this TaskFlow app' : 'this browser';
      const deviceExample = nativeApp ? "Amit's TaskFlow app" : "Amit's Pixel";
      card.innerHTML = `<div class="admin-block attendance-device-enrollment"><b>Register this device</b><p class="hint">Name the ${nativeApp ? 'app installation' : 'phone or computer'} you use for attendance. This account can punch only from ${deviceLabel} until an administrator resets the device.</p><label>Device name<input id="attendance-device-name" maxlength="60" placeholder="For example, ${escapeHtml(deviceExample)}"></label><button class="btn btn-primary" id="attendance-device-register" type="button">Register device</button><div class="form-error" id="attendance-device-error"></div></div>`;
      $('#attendance-device-register').onclick = async (event) => {
        const button = event.currentTarget;
        const error = $('#attendance-device-error');
        const deviceName = $('#attendance-device-name').value.trim();
        if (!deviceName) { error.textContent = 'Enter a name for this device.'; return; }
        button.disabled = true;
        try {
          const devicePayload = await getPunchDevicePayload();
          await api('/attendance/device-registration/register', { method: 'POST', body: { ...devicePayload, device_name: deviceName } });
          await renderPunchCard();
        } catch (err) { error.textContent = err.message; button.disabled = false; }
      };
      return;
    }
    if (registration.registered && !registration.is_current_device) {
      const nativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
      const currentDevice = nativeApp ? 'this TaskFlow app' : 'this browser';
      const resetInstructions = nativeApp
        ? 'An administrator must open Admin → Attendance device access and select Reset device for your account. Resetting your app sign-in device alone does not clear attendance registration.'
        : 'Ask an administrator to open Admin → Attendance device access and select Reset device for your account.';
      card.innerHTML = `<div class="admin-block attendance-phone-only"><b>This account is registered to ${escapeHtml(registration.device_name || 'another device')}</b><p class="hint">Punching from ${currentDevice} is blocked. ${resetInstructions}</p></div>`;
      return;
    }
    const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
    const latestSession = sessions[sessions.length - 1] || (status?.punch_in
      ? { punch_in: status.punch_in, punch_out: status.punch_out }
      : null);
    const activeShift = status?.active_shift || sessions.find(session => !session.punch_out)
      || (status?.punch_in && !status.punch_out ? { punch_in: status.punch_in, punch_out: null } : null);
    const displayedSession = activeShift || latestSession;
    const onShift = Boolean(activeShift);
    const shiftComplete = Boolean(!onShift && latestSession?.punch_out);
    const shiftLabel = onShift ? 'On shift' : shiftComplete ? 'Shift complete' : 'Not started';
    const shiftClass = onShift ? 'chip-success' : shiftComplete ? 'chip-neutral' : 'chip-warning';
    const deviceSummary = registration.registered
      ? `<div><span>Registered device</span><b>${escapeHtml(registration.device_name)}</b></div>`
      : '<div><span>Device</span><b>Will be registered when you punch in</b></div>';
    const todayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    const startTime = displayedSession?.punch_in ? fmtTime(displayedSession.punch_in) : '—';
    const endTime = displayedSession?.punch_out ? fmtTime(displayedSession.punch_out) : '—';
    const completedMinutes = sessions.reduce((total, session) => {
      if (!session.punch_out) return total;
      const start = Date.parse(session.punch_in);
      const end = Date.parse(session.punch_out);
      return Number.isFinite(start) && Number.isFinite(end)
        ? total + Math.max(0, Math.floor((end - start) / 60000))
        : total;
    }, 0);
    const workedMinutes = sessions.length ? completedMinutes : Number(status?.worked_minutes) || 0;
    card.innerHTML = `
      <section class="attendance-shift-card ${onShift ? 'is-on-shift' : ''}">
        <div class="attendance-shift-heading">
          <div><span class="eyebrow">${escapeHtml(todayLabel)}</span><time id="attendance-live-clock"></time></div>
          <span class="chip ${shiftClass}"><span class="attendance-status-dot"></span>${shiftLabel}</span>
        </div>
        <div class="attendance-shift-action">
          <p>${onShift ? 'Your shift is in progress.' : shiftComplete ? 'Your shift is complete. Start another shift when you are ready.' : 'Ready when you are.'}</p>
          <div id="attendance-action-region"></div>
        </div>
        <div class="attendance-shift-details">
          <div><span>Shift started</span><b>${escapeHtml(startTime)}</b></div>
          <div><span>Shift ended</span><b>${escapeHtml(endTime)}</b></div>
          <div><span>Time worked today</span><b id="attendance-shift-duration">${onShift ? 'Calculating…' : shiftComplete ? `${Math.floor(workedMinutes / 60)}h ${String(workedMinutes % 60).padStart(2, '0')}m` : '—'}</b></div>
          ${deviceSummary}
        </div>
        <p class="attendance-location-note">${icon('pin')} GPS location is an indicative reference only and can be spoofed; it does not prove physical presence.</p>
      </section>`;
    const updateClock = () => {
      const clock = $('#attendance-live-clock');
      if (clock) clock.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date());
      const duration = $('#attendance-shift-duration');
      if (duration && onShift) {
        const startedAt = parseTaskFlowTimestamp(activeShift.punch_in).getTime();
        const elapsedMinutes = Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 60000)) : 0;
        const totalMinutes = workedMinutes + elapsedMinutes;
        duration.textContent = `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
      }
    };
    stopAttendanceClock();
    updateClock();
    attendanceClockTimer = setInterval(updateClock, 1000);
    const actionRegion = $('#attendance-action-region');
    if (onShift) {
      startLiveTracking();
      actionRegion.innerHTML = `${attendanceFeedbackMarkup()}<button class="btn btn-danger attendance-punch-action" id="btn-punch-out" type="button">${icon('clock')} Hold to punch out</button>`;
      bindAttendancePunchAction($('#btn-punch-out'), async button => {
        button.disabled = true;
        setAttendancePunchProgress('');
        let nativeTrackingStopped = false;
        try {
          const verificationMethod = await verifyAttendanceIfRequired('out');
          const coords = await getLiveCoords();
          const devicePayload = await getPunchDevicePayload();
          const activityPayload = await getTravelActivity();
          if (nativeApp) {
            await stopNativeShiftTracking();
            nativeTrackingStopped = true;
          }
          setAttendancePunchProgress('Connecting to TaskFlow...');
          await api('/attendance/punch-out', { method: 'POST', body: { ...coords, ...devicePayload, ...activityPayload, verification_method: verificationMethod } });
          stopLiveTracking();
          await updateNativeTrackingHealth(false);
          if (!verificationMethod) await vibrateAttendance();
          showAppNotification('Punched out successfully.');
          await renderPunchCard();
          if (verificationMethod) setAttendanceBiometricFeedback('success', 'Punch out recorded.');
        } catch (error) {
          if (nativeTrackingStopped) {
            try { await startNativeShiftTracking(); }
            catch (trackingError) { console.warn('Unable to resume shift tracking after a failed punch out:', trackingError.message); }
          }
          setAttendancePunchProgress('');
          showAttendanceLocationHelp(actionRegion, error);
          showAppNotification(`Punch out failed: ${error.message}`);
          button.disabled = false;
        }
      });
    } else {
      stopLiveTracking();
      actionRegion.innerHTML = `${attendanceFeedbackMarkup()}<button class="btn btn-primary attendance-punch-action" id="btn-punch-in" type="button">${icon('clock')} Hold to punch in</button>`;
      bindAttendancePunchAction($('#btn-punch-in'), async button => {
        button.disabled = true;
        setAttendancePunchProgress('');
        try {
          const verificationMethod = await verifyAttendanceIfRequired('in');
          const coords = await getLiveCoords();
          const backgroundAllowed = nativeApp ? await requestNativeBackgroundTrackingPermission() : false;
          const notificationAllowed = backgroundAllowed ? await requestTrackingNotificationPermission() : true;
          const devicePayload = await getPunchDevicePayload();
          const activityPayload = await getTravelActivity(true);
          setAttendancePunchProgress('Connecting to TaskFlow...');
          await api('/attendance/punch-in', { method: 'POST', body: { ...coords, ...devicePayload, ...activityPayload, verification_method: verificationMethod } });
          if (nativeApp) {
            if (backgroundAllowed) {
              try {
                await startNativeShiftTracking();
                if (!notificationAllowed) await reportTrackingHealthState('notification_off');
              } catch (trackingError) {
                console.warn('Punch-in succeeded but background tracking did not start:', trackingError.message);
                setTrackingHealthBanner('Punch-in succeeded, but background location tracking did not start. Open settings to fix permissions.', true);
              }
            } else {
              await updateNativeTrackingHealth(true);
            }
          }
          if (!verificationMethod) await vibrateAttendance();
          showAppNotification('Punched in successfully.');
          await renderPunchCard();
          if (verificationMethod) setAttendanceBiometricFeedback('success', 'Punch in recorded.');
        } catch (error) {
          setAttendancePunchProgress('');
          showAttendanceLocationHelp(actionRegion, error);
          showAppNotification(`Punch in failed: ${error.message}`);
          button.disabled = false;
        }
      });
    }
  } catch (err) {
    stopAttendanceClock();
    card.innerHTML = `<div class="form-error" role="alert">Unable to load attendance: ${escapeHtml(err.message)}</div>`;
  }
}

function attendanceSessionsForRow(row) {
  if (Array.isArray(row.sessions) && row.sessions.length) return row.sessions;
  return row.punch_in || row.punch_out ? [row] : [];
}

function attendanceMonthMarkup(rows, year, month, options = {}) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthRows = rows.filter(row => String(row.date || '').startsWith(monthKey));
  const attendedRows = monthRows.filter(row => row.punch_in || row.punch_out);
  const sessions = attendedRows.flatMap(attendanceSessionsForRow);
  const presentCount = options.admin
    ? new Set(attendedRows.map(row => Number(row.user_id))).size
    : new Set(attendedRows.map(row => row.date)).size;
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month, 1)));
  const today = todayISO();
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weekdayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map(day => `<span class="attendance-calendar-weekday">${day}</span>`).join('');
  const emptyDays = Array.from({ length: firstWeekday }, () => '<span class="attendance-calendar-empty" aria-hidden="true"></span>').join('');
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${monthKey}-${String(index + 1).padStart(2, '0')}`;
    const dayRows = monthRows.filter(row => row.date === date);
    const presentOnDay = dayRows.filter(row => row.punch_in || row.punch_out);
    const daySessions = presentOnDay.flatMap(attendanceSessionsForRow);
    const count = options.admin ? presentOnDay.length : Number(presentOnDay.length > 0);
    const outsideRange = (options.from && date < options.from) || (options.to && date > options.to);
    const dayLabel = new Intl.DateTimeFormat(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata'
    }).format(new Date(`${date}T12:00:00.000Z`));
    return `<button type="button" class="attendance-calendar-day ${count ? 'has-attendance' : ''} ${date === today ? 'is-today' : ''} ${outsideRange ? 'outside-range' : ''}"
        data-attendance-date="${date}" aria-label="${dayLabel}${count ? `, ${count} ${options.admin ? 'employees' : 'attendance record'}; ${daySessions.filter(session => session.punch_in).length} punch-ins and ${daySessions.filter(session => session.punch_out).length} punch-outs` : ', no recorded punches'}">
        <span class="attendance-calendar-day-number">${index + 1}</span>
        ${count ? `<span class="attendance-calendar-day-count">${count}</span>` : ''}
      </button>`;
  }).join('');
  const controls = options.monthNavigation ? `
    <button type="button" class="attendance-calendar-nav" id="attendance-history-prev" aria-label="Previous month">‹</button>
    <h3>${monthTitle}</h3>
    <button type="button" class="attendance-calendar-nav" id="attendance-history-next" aria-label="Next month" ${monthKey >= today.slice(0, 7) ? 'disabled' : ''}>›</button>`
    : `<h3>${monthTitle}</h3>`;
  return `<section class="attendance-calendar-month">
    <div class="attendance-calendar-heading">${controls}</div>
    <div class="attendance-calendar-summary">
      <div><b>${presentCount}</b><small>${options.admin ? 'Employees present' : 'Present days'}</small></div>
      <div><b>${sessions.filter(session => session.punch_in).length}</b><small>Punch-ins</small></div>
      <div><b>${sessions.filter(session => session.punch_out).length}</b><small>Punch-outs</small></div>
    </div>
    <div class="attendance-calendar-weekdays">${weekdayHeaders}</div>
    <div class="attendance-calendar-grid">${emptyDays}${days}</div>
  </section>`;
}

function showAttendanceDayDetails(date, rows, options = {}) {
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata'
  }).format(new Date(`${date}T12:00:00.000Z`));
  let content;
  if (!options.withinRange) {
    content = '<p class="hint">This day is outside the selected date range.</p>';
  } else if (!rows.length || (!options.admin && !attendanceSessionsForRow(rows[0]).length)) {
    content = '<p class="hint">No punches recorded for this day.</p>';
  } else {
    const presentRows = rows.filter(row => row.punch_in || row.punch_out);
    const detailRows = options.admin && options.allowAdminPunch ? rows : presentRows;
    content = detailRows.length ? `<div class="attendance-day-details">${detailRows.map(row => {
      const sessions = attendanceSessionsForRow(row);
      const sessionMarkup = sessions.length ? sessions.map((session, index) => `
        <div class="attendance-day-session"><span>${sessions.length > 1 ? `Shift ${index + 1}` : 'Punch times'}</span>
          <div><small>Punch in</small><b>${fmtTime(session.punch_in) || '--'}</b></div>
          <div><small>Punch out</small><b>${fmtTime(session.punch_out) || '--'}</b></div>
        </div>`).join('') : '<p class="hint attendance-day-no-punch">No punches recorded.</p>';
      const isActive = Boolean(row.punch_in && !row.punch_out);
      const action = options.allowAdminPunch ? (isActive
        ? `<button class="btn btn-danger btn-sm attendance-admin-punch" data-action="out" data-user-id="${Number(row.user_id)}">Punch out</button>`
        : !row.punch_in ? `<button class="btn btn-primary btn-sm attendance-admin-punch" data-action="in" data-user-id="${Number(row.user_id)}">Punch in</button>`
          : '<span class="hint">Complete</span>') : '';
      return `<article class="attendance-day-person">
        ${options.admin ? `<div class="attendance-day-person-heading"><b>${escapeHtml(row.user_name || row.name || 'Employee')}</b>${row.department ? `<small>${escapeHtml(row.department)}</small>` : ''}</div>` : ''}
        <div class="attendance-day-session-list">${sessionMarkup}</div>
        ${action}
      </article>`;
    }).join('')}</div>` : '<p class="hint">No punches recorded for this day.</p>';
  }
  showModal(`<div class="attendance-day-dialog"><h3>${dateLabel}</h3>${content}<div class="modal-actions"><button class="btn btn-secondary" id="attendance-day-close" type="button">Close</button></div></div>`);
  $('#attendance-day-close')?.addEventListener('click', closeModal);
  $$('.attendance-admin-punch').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await options.onAdminPunch?.(button, date);
      } catch (error) {
        showAppNotification(error.message);
        button.disabled = false;
      }
    };
  });
}

function renderHistory() {
  if (ME?.role === 'admin') {
    // Admins use the single attendance calendar above (choose "My attendance" in its employee filter).
    $('#attendance-history')?.classList.add('hidden');
    return;
  }
  const calendar = $('#attendance-history-calendar');
  if (!calendar) return;
  if (!attendanceHistoryMonth) {
    const [year, month] = todayISO().split('-').map(Number);
    attendanceHistoryMonth = new Date(Date.UTC(year, month - 1, 1));
  }
  const requestId = ++attendanceHistoryRequestId;
  if (!calendar.children.length) calendar.innerHTML = uiSkeletonCalendar();
  const year = attendanceHistoryMonth.getUTCFullYear();
  const month = attendanceHistoryMonth.getUTCMonth();
  const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const to = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
  api(`/attendance/mine?from=${from}&to=${to}`).then(rawRows => {
    if (requestId !== attendanceHistoryRequestId) return;
    const rows = Array.isArray(rawRows) ? rawRows.flat(5) : [];
    calendar.innerHTML = attendanceMonthMarkup(rows, year, month, { monthNavigation: true });
    calendar.querySelectorAll('[data-attendance-date]').forEach(button => {
      button.onclick = () => showAttendanceDayDetails(button.dataset.attendanceDate, rows.filter(row => row.date === button.dataset.attendanceDate), { withinRange: true });
    });
    $('#attendance-history-prev').onclick = () => {
      attendanceHistoryMonth = new Date(Date.UTC(year, month - 1, 1));
      renderHistory();
    };
    $('#attendance-history-next')?.addEventListener('click', () => {
      attendanceHistoryMonth = new Date(Date.UTC(year, month + 1, 1));
      renderHistory();
    });
  }).catch(error => {
    if (requestId === attendanceHistoryRequestId) {
      calendar.innerHTML = uiErrorState(error, 'attendance-history-retry');
      $('#attendance-history-retry')?.addEventListener('click', () => renderHistory());
    }
  });
}

function openTrackingMapLink(event) {
  const link = event.currentTarget;
  const browser = window.TaskFlowBrowser;
  if (!window.Capacitor?.isNativePlatform?.() || !browser) return;
  event.preventDefault();
  browser.open({ url: link.href }).catch(error => {
    showAppNotification('Unable to open the map. Check your internet connection.');
    console.warn('Native map browser failed:', error.message);
  });
}

async function renderTracking() {
  const peoplePanel = $('#tracking-people');
  const detail = $('#tracking-detail');
  const dateInput = $('#tracking-date-filter');
  if (!peoplePanel || !detail) return;
  if (!peoplePanel.children.length) peoplePanel.innerHTML = uiSkeletonRows(6);
  if (!detail.children.length) detail.innerHTML = uiSkeletonRows(3);
  const selectedDate = dateInput?.value || todayISO();
  if (dateInput) dateInput.value = selectedDate;
  if (dateInput) dateInput.onchange = () => {
    if (!dateInput.value) dateInput.value = todayISO();
    renderTracking();
  };
  try {
    const people = await api(`/attendance/tracking/people?date=${encodeURIComponent(selectedDate)}`);
    peoplePanel.innerHTML = people.length ? people.map(person => {
      const active = Boolean(person.punch_in && !person.punch_out);
      const gapMinutes = person.tracking_gap_minutes;
      const hasGap = active && (gapMinutes == null || Number(gapMinutes) > 15);
      const stateAt = person.tracking_state_at ? Date.parse(person.tracking_state_at) : NaN;
      const latestAt = person.latest_at ? Date.parse(person.latest_at) : NaN;
      const hasIssue = active && person.tracking_state && person.tracking_state !== 'restored'
        && (!Number.isFinite(stateAt) || !Number.isFinite(latestAt) || stateAt >= latestAt);
      const label = !active ? 'Not active'
        : hasGap ? `GPS gap${gapMinutes == null ? '' : ` · ${gapMinutes} min`}`
          : hasIssue ? 'Tracking issue'
            : Number.isFinite(latestAt) ? 'Tracking OK' : 'Tracking status unknown';
      return `<button class="tracking-person" data-tracking-user-id="${person.user_id}">
        <b>${escapeHtml(person.user_name)}</b><small>${escapeHtml(person.department || 'Employee')}</small>
        <span class="tracking-status ${active ? 'active' : ''} ${hasGap || hasIssue ? 'warning' : ''}">${escapeHtml(label)}</span>
      </button>`;
    }).join('') : '<div class="hint">No employees found.</div>';
    const selectedPerson = people.find(person => Number(person.user_id) === Number(selectedTrackingUserId)) || people[0];
    selectedTrackingUserId = selectedPerson ? Number(selectedPerson.user_id) : null;
    $$('.tracking-person').forEach(button => {
      button.onclick = () => {
        selectedTrackingUserId = Number(button.dataset.trackingUserId);
        loadTrackingTimeline(selectedTrackingUserId, button, selectedDate);
      };
    });
    if (selectedPerson) {
      const selectedButton = peoplePanel.querySelector(`[data-tracking-user-id="${selectedPerson.user_id}"]`);
      loadTrackingTimeline(selectedPerson.user_id, selectedButton, selectedDate);
    }
  } catch (error) {
    peoplePanel.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
  }
}

async function loadTrackingTimeline(userId, selectedButton, selectedDate = todayISO()) {
  $$('.tracking-person').forEach(button => button.classList.toggle('active', button === selectedButton));
  const detail = $('#tracking-detail');
  if (!detail) return;
  try {
    const trackingData = await api(`/attendance/tracking/${userId}/timeline?date=${encodeURIComponent(selectedDate)}`);
    const timeline = trackingData.points || [];
    const events = trackingData.events || [];
    const routePoints = trackingData.route_points || timeline;
    const latest = routePoints[routePoints.length - 1] || timeline[timeline.length - 1];
    const totalDistanceKm = Number(trackingData.total_distance_meters || 0) / 1000;
    const distanceLabel = totalDistanceKm >= 1 ? `${totalDistanceKm.toFixed(2)} km` : `${Number(trackingData.total_distance_meters || 0).toFixed(0)} m`;
    const travelModeLabels = { in_vehicle: 'In vehicle', on_bicycle: 'Bicycle', walking: 'Walking', running: 'Running', on_foot: 'On foot', still: 'Still', tilting: 'Moving', unknown: 'Unknown' };
    const routeWaypoints = routePoints.length > 2
      ? routePoints.slice(1, -1).filter((_, index, middle) => index % Math.max(1, Math.ceil(middle.length / 8)) === 0).slice(0, 8)
      : [];
    const routeUrl = routePoints.length > 1
      ? `https://www.google.com/maps/dir/?api=1&origin=${routePoints[0].latitude},${routePoints[0].longitude}&destination=${routePoints[routePoints.length - 1].latitude},${routePoints[routePoints.length - 1].longitude}${routeWaypoints.length ? `&waypoints=${routeWaypoints.map(point => `${point.latitude},${point.longitude}`).join('%7C')}` : ''}`
      : '';
    const mapPadding = 0.01;
    const mapEmbedUrl = latest
      ? `https://www.openstreetmap.org/export/embed.html?bbox=${latest.longitude - mapPadding}%2C${latest.latitude - mapPadding}%2C${latest.longitude + mapPadding}%2C${latest.latitude + mapPadding}&layer=mapnik&marker=${latest.latitude}%2C${latest.longitude}`
      : '';
    const eventTimeline = events.length ? events.map(event => {
      const hasLocation = event.latitude != null && event.longitude != null;
      const locationUrl = hasLocation ? `https://www.google.com/maps?q=${event.latitude},${event.longitude}` : '';
      const location = event.location || (hasLocation ? `${Number(event.latitude).toFixed(6)}, ${Number(event.longitude).toFixed(6)}` : 'Location unavailable');
      const details = event.type === 'task'
        ? `<b>${escapeHtml(event.customer_name || 'Customer not specified')}</b><span>${escapeHtml(event.task_title || 'Task')}${event.project_name ? ` · ${escapeHtml(event.project_name)}` : ''}</span>`
        : event.type === 'tracking' ? `<span>${event.state === 'gap' ? 'GPS sample gap' : `Tracking status · ${escapeHtml(event.state || 'unknown')}`}</span>`
          : `<span>${escapeHtml(location)}</span>`;
      return `<article class="tracking-event ${event.type === 'task' ? 'tracking-event-task' : event.type === 'tracking' ? 'tracking-event-health' : 'tracking-event-attendance'}">
        <div class="tracking-event-time">${escapeHtml(fmtTime(event.recorded_at))}<small>${escapeHtml(fmtDate(event.recorded_at))}</small></div>
        <div class="tracking-event-marker" aria-hidden="true">${event.type === 'task' ? 'T' : event.type === 'tracking' ? '!' : 'A'}</div>
        <div class="tracking-event-content"><b class="tracking-event-action">${escapeHtml(event.action)}</b>${details}
          ${event.type === 'task' ? `<span>${escapeHtml(location)}</span>` : ''}
          ${locationUrl ? `<a class="tracking-map-link" href="${locationUrl}" target="_blank" rel="noopener">View location on map</a>` : ''}
        </div>
      </article>`;
    }).join('') : `<div class="hint">No attendance or task check-in/out events for ${escapeHtml(selectedDate)}.</div>`;
    detail.innerHTML = `<div class="tracking-detail-header"><div><span class="eyebrow">Location timeline · ${escapeHtml(selectedDate)}</span><h2>${escapeHtml(selectedButton?.querySelector('b')?.textContent || 'Employee')}</h2></div><span class="hint">${events.length} events · ${routePoints.length} GPS points · ${distanceLabel} travel</span></div>
      <div class="tracking-event-timeline">${eventTimeline}</div>
      ${routeUrl ? `<div class="tracking-route-link"><a class="btn btn-secondary btn-sm tracking-map-link" href="${routeUrl}" target="_blank" rel="noopener">View travel route in Google Maps</a><span class="hint">${routePoints.length} GPS points · estimated ${distanceLabel}</span></div>` : ''}
      ${latest ? `<iframe class="tracking-map" title="Latest employee location" src="${mapEmbedUrl}" loading="lazy" referrerpolicy="no-referrer"></iframe>` : '<div class="tracking-map tracking-map-empty">No location points recorded yet.</div>'}
      <div class="tracking-timeline">${timeline.length ? timeline.map((point, index) => `<a class="tracking-point tracking-map-link" href="https://www.google.com/maps?q=${point.latitude},${point.longitude}" target="_blank" rel="noopener"><b>${index + 1}. ${escapeHtml(fmtDateTime(point.recorded_at))}${Number(point.place_changed) ? ' · Place changed' : ''}</b><span>+${Number(point.distance_meters || 0).toFixed(0)} m · ${Number(point.latitude).toFixed(6)}, ${Number(point.longitude).toFixed(6)}</span><small>Travel: ${escapeHtml(travelModeLabels[point.activity_type] || 'Unknown')} · ${Number(point.activity_confidence || 0)}% confidence</small></a>`).join('') : `<div class="hint">No location records for ${escapeHtml(selectedDate)}. If the employee punched in, confirm their GPS punch-in was saved.</div>`}</div>`;
    detail.querySelectorAll('.tracking-map-link').forEach(link => link.addEventListener('click', openTrackingMapLink));
  } catch (error) {
    detail.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
  }
}

// ================= ADMINISTRATIVE CORE VIEW MODULE =================
function addAdminListPagination(container, searchLabel) {
  if (!container) return;
  const rows = container.tagName === 'TBODY'
    ? Array.from(container.rows)
    : Array.from(container.children);
  const anchor = container.tagName === 'TBODY' ? container.closest('table') : container;
  if (!anchor?.parentElement) return;

  const controls = document.createElement('div');
  controls.className = 'admin-form-row permission-list-controls';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = searchLabel;
  search.setAttribute('aria-label', searchLabel);
  const pageSizeLabel = document.createElement('label');
  pageSizeLabel.append('Rows per page ');
  const pageSizeSelect = document.createElement('select');
  pageSizeSelect.setAttribute('aria-label', `${searchLabel} rows per page`);
  [25, 50, 100].forEach(size => {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = String(size);
    pageSizeSelect.appendChild(option);
  });
  pageSizeLabel.appendChild(pageSizeSelect);
  const count = document.createElement('span');
  count.className = 'hint';
  count.setAttribute('aria-live', 'polite');
  const pagination = document.createElement('div');
  pagination.className = 'permission-pagination';
  anchor.parentElement.insertBefore(controls, anchor);
  controls.append(search, pageSizeLabel, count);
  anchor.parentElement.insertBefore(pagination, anchor.nextSibling);

  let pageIndex = 0;
  const renderPage = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = rows.filter(row => row.textContent.toLocaleLowerCase().includes(query));
    const pageSize = Number(pageSizeSelect.value) || 25;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    pageIndex = Math.min(pageIndex, pageCount - 1);
    const start = pageIndex * pageSize;
    const visibleRows = new Set(filtered.slice(start, start + pageSize));
    rows.forEach(row => { row.style.display = visibleRows.has(row) ? '' : 'none'; });
    count.textContent = filtered.length
      ? `Showing ${start + 1}-${Math.min(start + visibleRows.size, filtered.length)} of ${filtered.length} users`
      : 'No matching users';
    pagination.innerHTML = pageCount > 1
      ? `<button type="button" class="btn btn-secondary btn-sm" data-list-page="previous" ${pageIndex === 0 ? 'disabled' : ''}>Previous</button><span>Page ${pageIndex + 1} of ${pageCount}</span><button type="button" class="btn btn-secondary btn-sm" data-list-page="next" ${pageIndex >= pageCount - 1 ? 'disabled' : ''}>Next</button>`
      : '';
    pagination.querySelector('[data-list-page="previous"]')?.addEventListener('click', () => { pageIndex--; renderPage(); });
    pagination.querySelector('[data-list-page="next"]')?.addEventListener('click', () => { pageIndex++; renderPage(); });
  };
  search.oninput = () => { pageIndex = 0; renderPage(); };
  pageSizeSelect.onchange = () => { pageIndex = 0; renderPage(); };
  renderPage();
}

function renderAttendanceDeviceAccess(devices) {
  const list = $('#attendance-device-access-list');
  const search = $('#attendance-device-access-search');
  const pageSizeSelect = $('#attendance-device-access-page-size');
  const count = $('#attendance-device-access-count');
  const pagination = $('#attendance-device-access-pagination');
  let pageIndex = 0;

  const renderPage = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = devices.filter(person =>
      `${person.name || ''} ${person.username || ''} ${person.registered_device_name || ''} ${person.registered_device_info || ''}`
        .toLocaleLowerCase().includes(query));
    const pageSize = Number(pageSizeSelect.value) || 25;
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    pageIndex = Math.min(pageIndex, pageCount - 1);
    const start = pageIndex * pageSize;
    const page = filtered.slice(start, start + pageSize);
    list.innerHTML = '';

    page.forEach(person => {
      const row = document.createElement('div');
      row.className = 'admin-form-row attendance-device-access-row';
      const deviceStatus = person.registered_device_name
        || (Number(person.device_rebind_pending) === 1 ? 'Reset; next punch will auto-bind' : 'No device registered');
      row.innerHTML = `<div class="attendance-device-admin-person"><b>${escapeHtml(person.name)}</b><span class="attendance-device-username">${escapeHtml(person.username || '')}</span><span class="attendance-device-status">${escapeHtml(deviceStatus)}</span>${person.registered_device_info ? `<small>${escapeHtml(person.registered_device_info)}</small>` : ''}</div>
        <label><input type="checkbox" data-device-phone="${person.id}" ${Number(person.allow_phone) === 1 ? 'checked' : ''}> TaskFlow app</label>
        <label><input type="checkbox" data-device-mobile-browser="${person.id}" ${Number(person.allow_mobile_browser) === 1 ? 'checked' : ''}> Mobile browser</label>
        <label><input type="checkbox" data-device-laptop="${person.id}" ${Number(person.allow_laptop) === 1 ? 'checked' : ''}> Laptop browser</label>
        <button class="btn btn-secondary btn-sm save-device-access" data-device-user="${person.id}">Save access</button>
        <button class="btn btn-danger btn-sm reset-attendance-device" data-device-user="${person.id}" type="button">Reset device</button>`;
      row.querySelector('.reset-attendance-device').dataset.deviceName = person.registered_device_name || '';
      list.appendChild(row);
    });

    count.textContent = filtered.length
      ? `Showing ${start + 1}-${Math.min(start + page.length, filtered.length)} of ${filtered.length} users`
      : 'No matching users';
    pagination.innerHTML = pageCount > 1
      ? `<button type="button" class="btn btn-secondary btn-sm" data-device-page="previous" ${pageIndex === 0 ? 'disabled' : ''}>Previous</button><span>Page ${pageIndex + 1} of ${pageCount}</span><button type="button" class="btn btn-secondary btn-sm" data-device-page="next" ${pageIndex >= pageCount - 1 ? 'disabled' : ''}>Next</button>`
      : '';
    pagination.querySelector('[data-device-page="previous"]')?.addEventListener('click', () => { pageIndex--; renderPage(); });
    pagination.querySelector('[data-device-page="next"]')?.addEventListener('click', () => { pageIndex++; renderPage(); });

    list.querySelectorAll('.save-device-access').forEach(button => {
      button.onclick = async () => {
        const userId = button.dataset.deviceUser;
        const row = button.closest('.admin-form-row');
        const phone = row.querySelector(`[data-device-phone="${userId}"]`);
        const mobileBrowser = row.querySelector(`[data-device-mobile-browser="${userId}"]`);
        const laptop = row.querySelector(`[data-device-laptop="${userId}"]`);
        button.disabled = true;
        try {
          await api(`/attendance/device-access/${userId}`, { method: 'PUT', body: { allow_phone: phone.checked, allow_mobile_browser: mobileBrowser.checked, allow_laptop: laptop.checked } });
          showAppNotification('Attendance device access updated.');
        } catch (error) {
          showAppNotification(error.message);
        } finally {
          button.disabled = false;
        }
      };
    });
    list.querySelectorAll('.reset-attendance-device').forEach(button => {
      button.onclick = async () => {
        const deviceName = button.dataset.deviceName;
        const confirmed = await confirmModal('Reset attendance device?', `${deviceName ? `Clear ${escapeHtml(deviceName)}'s device binding` : "Clear this employee's device binding"}? The employee's next punch will automatically bind the app or browser used.`, 'Reset device', true);
        if (!confirmed) return;
        try {
          await api(`/attendance/device-registration/${button.dataset.deviceUser}`, { method: 'DELETE' });
          const person = devices.find(item => String(item.id) === button.dataset.deviceUser);
          if (person) {
            person.registered_device_name = null;
            person.registered_device_info = null;
            person.device_rebind_pending = 1;
          }
          renderPage();
          showAppNotification('Device reset successfully.');
        } catch (error) {
          showAppNotification(error.message);
        }
      };
    });
  };

  search.oninput = () => { pageIndex = 0; renderPage(); };
  pageSizeSelect.onchange = () => { pageIndex = 0; renderPage(); };
  renderPage();
}

async function renderAdmin() {
  const wrap = $('#admin-content');
  if (!wrap) return;
  wrap.innerHTML = `<div class="hint" id="admin-loading-status" role="status">Loading administrator settings...</div>${uiSkeletonRows(4)}`;
  try {
    const adminPaths = ['/auth/users', '/auth/settings', '/auth/departments', '/auth/reimbursement-access', '/attendance/tracking-access', '/attendance/verification-access', '/payment-history/access', '/attendance/device-access', '/attendance/device-access/me', '/project-action-access', '/task-checkin-access', '/task-work-mode-access'];
    const pendingPaths = new Set(adminPaths);
    const loadAdminData = async (path) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        return await api(path, { signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError') throw new Error(`${path} timed out after 15 seconds.`);
        throw new Error(`${path}: ${error.message}`);
      } finally {
        clearTimeout(timeout);
        pendingPaths.delete(path);
        const status = $('#admin-loading-status');
        if (status && pendingPaths.size) status.textContent = `Loading administrator settings... ${pendingPaths.size} requests remaining.`;
      }
    };
    const [users, settings, departments, reimbursementAccess, trackingAccess, verificationAccess, paymentAccess, deviceAccess, myDeviceAccess, projectActionAccess, taskCheckinAccess, taskWorkModeAccess] = await Promise.all(adminPaths.map(loadAdminData));
    const verificationByUser = new Map(verificationAccess.map(person => [Number(person.id), Number(person.verification_required) === 1]));
    const departmentOptions = departments.map(d => `<option value="${escapeHtml(d.name || d.NAME)}">${escapeHtml(d.name || d.NAME)}</option>`).join('');

    wrap.innerHTML = `
      <div class="admin-block">
        <h3>Project data import / export</h3>
        <p class="hint">Import Asana project JSON files; optionally choose the exported Run folder or attachments folder to copy downloaded files onto their tasks. The project archive includes projects, tasks, comments, task history, and check-ins, but not accounts, reimbursements, or attendance. Project text may contain secrets; store backups securely.</p>
        <div class="admin-form-row">
          <select id="my-data-export-format" aria-label="Download my data format"><option value="json">JSON</option><option value="csv">CSV</option></select>
          <button class="btn btn-primary" id="download-my-data" type="button">Download my data</button>
        </div>
        <div class="admin-form-row">
          <input id="asana-project-import-files" type="file" accept=".json,application/json" multiple aria-label="Choose Asana project JSON files">
          <input id="asana-project-import-folder" type="file" webkitdirectory directory multiple aria-label="Choose Asana export or attachments folder">
          <button class="btn btn-primary" id="asana-project-import" type="button">Import Asana projects</button>
          <button class="btn btn-secondary" id="taskflow-project-export" type="button">Export TaskFlow backup</button>
        </div>
        <progress id="project-data-tools-progress" class="project-data-tools-progress" max="100" value="0" hidden></progress>
        <div class="project-data-tools-feedback"><strong id="project-data-tools-percent">0%</strong><div id="project-data-tools-status" class="hint" role="status">Choose Asana project files to begin.</div></div>
        <ul id="project-data-tools-issues" class="project-data-tools-issues" aria-live="polite" hidden></ul>
        <ul id="project-data-tools-warnings" class="project-data-tools-warnings" aria-live="polite" hidden></ul>
      </div>

      <div class="admin-block">
        <h3>Office location (GPS reference)</h3>
        <p class="hint">GPS-based location is indicative only and can be spoofed. It is not proof of physical presence. Use it as a reference, not for disciplinary or payroll decisions without independent verification.</p>
        <div class="admin-form-row">
          <input id="admin-lat" placeholder="Latitude" value="${settings.office_lat || ''}">
          <input id="admin-lng" placeholder="Longitude" value="${settings.office_lng || ''}">
          <input id="admin-radius" placeholder="Radius (meters)" value="${settings.office_radius_m || '150'}">
          <button class="btn btn-primary" id="admin-settings-save">Save</button>
        </div>
      </div>

      <div class="admin-block">
        <h3>Data retention</h3>
        <p class="hint">Reimbursement receipts and comment attachments are never auto-deleted by default. Check retention requirements with your accountant before enabling deletion. GPS points and precise location/device details are cleared after the configured period; punch times remain.</p>
        <div class="admin-form-row">
          <label>Attachments (days; 0 = keep)<input id="attachment-retention-days" type="number" min="0" max="36500" step="1" value="${settings.attachment_retention_days ?? '0'}"></label>
          <label>GPS/device details (days)<input id="attendance-retention-days" type="number" min="1" max="36500" step="1" value="${settings.attendance_location_retention_days ?? '90'}"></label>
          <button class="btn btn-primary" id="admin-retention-save" type="button">Save retention</button>
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
        <h3>Attendance device access</h3>
        <p class="hint">Choose separately whether each person may punch from the TaskFlow app, a mobile browser, or a laptop browser. Allowing browser login only permits sign-in; it does not grant attendance access. Laptop punching still requires browser location permission.</p>
        <div class="admin-form-row permission-list-controls">
          <input id="attendance-device-access-search" type="search" placeholder="Search by employee, username, or device" aria-label="Search attendance device users">
          <label>Rows per page <select id="attendance-device-access-page-size" aria-label="Attendance device users per page"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
          <span id="attendance-device-access-count" class="hint" aria-live="polite"></span>
        </div>
        <div id="attendance-device-access-list"></div>
        <div id="attendance-device-access-pagination" class="permission-pagination"></div>
      </div>

      <div class="admin-block">
        <h3>Task check-in / check-out access</h3>
        <p class="hint">Enable employees who must use GPS check-in and check-out when they are assigned an on-field task.</p>
        <div id="task-checkin-access-list"></div>
      </div>

      <div class="admin-block">
        <h3>Task work location access</h3>
        <p class="hint">Allow selected employees to change a task between Office and On-field. Admins can always change this setting.</p>
        <div id="task-work-mode-access-list"></div>
      </div>

      <div class="admin-block">
        <h3>Payment History access</h3>
        <p class="hint">Allow selected employees to view and update invoice payment history.</p>
        <div id="payment-history-access-list"></div>
      </div>

      <div class="admin-block">
        <h3>Project and task permissions</h3>
        <p class="hint">Choose which project and task actions each user may perform. Admins always retain full access.</p>
        <div class="admin-form-row permission-list-controls">
          <input id="project-action-access-search" type="search" placeholder="Search by employee name or username" aria-label="Search permission users">
          <label>Rows per page <select id="project-action-access-page-size" aria-label="Permission users per page"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
          <span id="project-action-access-count" class="hint" aria-live="polite"></span>
        </div>
        <div id="project-action-access-list"></div>
        <div id="project-action-access-pagination" class="permission-pagination"></div>
      </div>

      <div class="admin-block">
        <h3>Activity log</h3>
        <p class="hint">Recent changes made in TaskFlow.</p>
        <div id="activity-log-list"></div>
      </div>

      <div class="admin-block">
        <h3>Team members &amp; admin access</h3>
        <p class="hint">Create a username and temporary password so the new member can sign in without email delivery. Email verification and Google sign-in remain optional.</p>
        <div class="admin-form-row">
          <button class="btn btn-danger" id="reset-app-login-devices" type="button">Reset all app sign-in devices</button>
          <span class="hint">Use after reinstalling or changing the APK signing version if users cannot sign in. This is separate from attendance device access.</span>
        </div>
        <div class="admin-form-row">
          <button class="btn btn-danger" id="reset-attendance-devices" type="button">Reset all attendance devices</button>
          <span class="hint">Employees must register an attendance device again before punching. App sign-in devices, access permissions, and attendance records are unchanged.</span>
        </div>
        <div class="admin-form-row" style="margin-bottom: 20px;">
          <input id="u-name" placeholder="Full name">
          <input id="u-username" placeholder="Username" autocomplete="username" required>
          <input id="u-password" type="password" placeholder="Temporary password (10+ characters)" autocomplete="new-password" required>
          <input id="u-email" type="email" placeholder="Work email (required)" autocomplete="email" required>
          <input id="u-date-of-birth" type="date" aria-label="Date of birth" required>
          <input id="u-phone" type="tel" placeholder="Phone number (required)" autocomplete="tel" required>
          <select id="u-department" required><option value="">Select department (required)</option>${departmentOptions}</select>
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
              <th style="padding:10px;">Email &amp; verification</th>
              <th style="padding:10px;">Date of birth · Phone</th>
              <th style="padding:10px;">Department</th>
              <th style="padding:10px;">Role</th>
              <th style="padding:10px;">Status</th>
              <th style="padding:10px;">Login access</th>
              <th style="padding:10px;">Biometric</th>
              <th style="padding:10px;">Actions</th>
            </tr>
          </thead>
          <tbody id="admin-employees-table-body"></tbody>
        </table>
      </div>

      <div class="admin-block">
        <h3>Plan &amp; Usage</h3>
        <div id="plan-usage-panel"></div>
        <p class="hint">Contact support to discuss plan changes or additional capacity. Payments are handled outside TaskFlow.</p>
      </div>`;

    const adminBlocks = Array.from(wrap.querySelectorAll(':scope > .admin-block'));
    const adminTabDefinitions = [
      { id: 'people', label: 'People & access', matches: /Departments|Reimbursement approval|Live tracking|Task check-in|Task work location|Payment History|Team members/i },
      { id: 'attendance', label: 'Attendance', matches: /Office location|Data retention|Attendance device/i },
      { id: 'workspace', label: 'Workspace', matches: /Project data|Project and task permissions|Activity log/i },
      { id: 'plan-usage', label: 'Plan & Usage', matches: /Plan & Usage/i }
    ];
    const adminTabs = document.createElement('div');
    adminTabs.className = 'admin-tabs';
    adminTabs.setAttribute('role', 'tablist');
    adminTabs.setAttribute('aria-label', 'Administrator settings');
    adminTabs.innerHTML = adminTabDefinitions.map((tab, index) => `
      <button class="admin-tab" id="admin-tab-${tab.id}" type="button" role="tab"
        aria-controls="admin-panel-${tab.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? '0' : '-1'}">${tab.label}</button>`).join('');
    const adminPanels = adminTabDefinitions.map((tab, index) => {
      const panel = document.createElement('section');
      panel.className = 'admin-tab-panel';
      panel.id = `admin-panel-${tab.id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `admin-tab-${tab.id}`);
      panel.tabIndex = 0;
      panel.hidden = index !== 0;
      return panel;
    });
    const adminFirstBlock = adminBlocks[0];
    if (adminFirstBlock) {
      wrap.insertBefore(adminTabs, adminFirstBlock);
      adminPanels.forEach(panel => wrap.insertBefore(panel, adminFirstBlock));
    }
    adminBlocks.forEach(block => {
      const title = block.querySelector('h3')?.textContent || '';
      const matchingTab = adminTabDefinitions.find(tab => tab.matches.test(title));
      const panel = adminPanels.find(candidate => candidate.id === `admin-panel-${matchingTab?.id}`);
      if (panel) panel.appendChild(block);
    });
    const planUsagePanel = $('#plan-usage-panel');
    if (planUsagePanel) {
      const plan = ME.plan || {};
      const usage = ME.usage || {};
      const isTrial = ME.access?.reasons?.includes('trial_active') && usage.trialEndsAt;
      const expiryDate = isTrial ? usage.trialEndsAt : plan.subscriptionEndsAt;
      const expiryLabel = isTrial ? 'Trial ends' : (expiryDate ? 'Plan expires' : 'Trial ends');
      const expiryText = expiryDate ? new Date(expiryDate).toLocaleDateString() : 'Not in trial';
      const limitText = (used, limit, formatter = value => Number(value || 0).toLocaleString()) =>
        `${formatter(used)} / ${limit == null ? 'Unlimited' : formatter(limit)}`;
      planUsagePanel.innerHTML = `
        <dl class="plan-usage-grid">
          <div><dt>Plan</dt><dd>${escapeHtml(plan.name || 'No plan assigned')}</dd></div>
          <div><dt>Active users</dt><dd>${escapeHtml(limitText(usage.activeUsers, plan.maxUsers))}</dd></div>
          <div><dt>Storage</dt><dd>${escapeHtml(limitText(usage.storageBytes, plan.storageLimitBytes, value => formatStorageDisplay(0, value)))}</dd></div>
          <div><dt>${escapeHtml(expiryLabel)}</dt><dd>${escapeHtml(expiryText)}</dd></div>
        </dl>`;
    }
    const activateAdminTab = selected => {
      adminTabDefinitions.forEach(tab => {
        const button = $(`#admin-tab-${tab.id}`);
        const panel = $(`#admin-panel-${tab.id}`);
        const active = tab.id === selected;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        panel.hidden = !active;
      });
    };
    adminTabDefinitions.forEach((tab, index) => {
      const button = $(`#admin-tab-${tab.id}`);
      button.addEventListener('click', () => activateAdminTab(tab.id));
      button.addEventListener('keydown', event => {
        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % adminTabDefinitions.length
          : event.key === 'ArrowLeft' ? (index + adminTabDefinitions.length - 1) % adminTabDefinitions.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? adminTabDefinitions.length - 1 : -1;
        if (nextIndex < 0) return;
        event.preventDefault();
        const next = adminTabDefinitions[nextIndex];
        activateAdminTab(next.id);
        $(`#admin-tab-${next.id}`).focus();
      });
    });

    const dataToolsStatus = $('#project-data-tools-status');
    const dataToolsProgress = $('#project-data-tools-progress');
    const dataToolsPercent = $('#project-data-tools-percent');
    const dataToolsIssues = $('#project-data-tools-issues');
    const dataToolsWarnings = $('#project-data-tools-warnings');
    const renderDataToolIssues = issues => {
      if (!dataToolsIssues) return;
      dataToolsIssues.replaceChildren(...issues.map(issue => {
        const item = document.createElement('li');
        item.textContent = issue;
        return item;
      }));
      dataToolsIssues.hidden = issues.length === 0;
    };
    const renderDataToolWarnings = warnings => {
      if (!dataToolsWarnings) return;
      dataToolsWarnings.replaceChildren(...warnings.map(warning => {
        const item = document.createElement('li');
        item.textContent = warning;
        return item;
      }));
      dataToolsWarnings.hidden = warnings.length === 0;
    };
    const setDataToolsProgress = (value, message, indeterminate = false, percentLabel = null) => {
      if (dataToolsProgress) {
        dataToolsProgress.hidden = false;
        if (indeterminate) dataToolsProgress.removeAttribute('value');
        else dataToolsProgress.value = Math.max(0, Math.min(100, Number(value) || 0));
        dataToolsProgress.classList.toggle('indeterminate', indeterminate);
      }
      if (dataToolsPercent) dataToolsPercent.textContent = percentLabel || (indeterminate ? 'Working' : `${Math.round(Math.max(0, Math.min(100, Number(value) || 0)))}%`);
      if (dataToolsStatus && message) dataToolsStatus.textContent = message;
    };
    const finishDataToolsProgress = () => {
      if (!dataToolsProgress) return;
      dataToolsProgress.classList.remove('indeterminate');
      dataToolsProgress.value = 100;
      if (dataToolsPercent) dataToolsPercent.textContent = '100%';
    };
    const formatImportEta = seconds => {
      if (seconds == null || !Number.isFinite(Number(seconds))) return 'estimating time';
      const remaining = Math.max(0, Math.ceil(Number(seconds)));
      if (remaining < 60) return `about ${remaining}s left`;
      return `about ${Math.floor(remaining / 60)}m ${remaining % 60}s left`;
    };
    const prepareProjectUpload = async file => {
      const uploadLimit = 20 * 1024 * 1024;
      if (file.size <= uploadLimit) return { blob: file, filename: file.name };
      if (typeof CompressionStream === 'undefined') {
        throw new Error(`${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB, above the 20 MB server limit, and this browser cannot gzip it. Try a current Chrome or Edge browser.`);
      }
      setDataToolsProgress(0, `Compressing ${file.name} for upload...`, true);
      const compressed = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (compressed.size >= file.size || compressed.size > uploadLimit) {
        throw new Error(`${file.name} is too large to upload. Its compressed size is ${(compressed.size / (1024 * 1024)).toFixed(1)} MB; the server limit is 20 MB.`);
      }
      return { blob: compressed, filename: `${file.name}.gz` };
    };
    const postFormWithProgress = (url, formData, onProgress, progressId = null) => new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      let pollTimer = null;
      let stopped = false;
      const stopPolling = () => {
        stopped = true;
        clearTimeout(pollTimer);
      };
      const pollServerProgress = async () => {
        if (stopped || !progressId) return;
        try {
          const response = await fetch(`/api/admin/asana-import/progress/${encodeURIComponent(progressId)}`, { credentials: 'same-origin', cache: 'no-store' });
          if (response.ok) {
            const progress = await response.json();
            onProgress(progress.percent, 'server', progress);
          }
        } catch (error) {
          console.warn('Import progress refresh failed:', error.message);
        }
        if (!stopped) pollTimer = setTimeout(pollServerProgress, 700);
      };
      request.open('POST', url);
      request.withCredentials = true;
      request.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100), 'upload');
      };
      request.upload.onload = () => {
        onProgress(100, 'processing');
        pollServerProgress();
      };
      request.onload = () => {
        stopPolling();
        let payload = {};
        try { payload = JSON.parse(request.responseText); } catch (error) { }
        if (request.status >= 200 && request.status < 300) resolve(payload);
        else {
          const operation = url.includes('/attachments') ? 'Attachment upload' : 'Asana project import';
          reject(new Error(payload.error || `${operation} failed with HTTP ${request.status}.`));
        }
      };
      request.onerror = () => { stopPolling(); reject(new Error('Network error while uploading data.')); };
      request.onabort = () => { stopPolling(); reject(new Error('Upload was cancelled.')); };
      request.send(formData);
    });
    const importProjectsButton = $('#asana-project-import');
    if (importProjectsButton) importProjectsButton.onclick = async () => {
      const selectedJsonFiles = Array.from($('#asana-project-import-files')?.files || []);
      const directoryFiles = Array.from($('#asana-project-import-folder')?.files || []);
      const monthKeyPattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}$/i;
      const candidateJsonFiles = [...selectedJsonFiles, ...directoryFiles.filter(file => /^(?:project(?:-\d+)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2}(?: \(\d+\))?)\.json$/i.test(file.name))];
      const projectsToImport = [];
      const seenFiles = new Set();
      const selectionErrors = [];
      for (const file of candidateJsonFiles) {
        try {
          const source = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
          const projectGid = String(source.project?.gid || '');
          const monthKeys = Object.keys(source).filter(key => monthKeyPattern.test(key) && Array.isArray(source[key]));
          let uploadFile = file;
          if (!Array.isArray(source.tasks) && monthKeys.length) {
            source.tasks = monthKeys.flatMap(key => source[key]);
            uploadFile = new File([JSON.stringify(source)], file.name, {
              type: 'application/json',
              lastModified: file.lastModified
            });
          }
          if (!projectGid || !Array.isArray(source.tasks)) throw new Error('Missing Asana project or tasks data.');
          const fileKey = `${file.name}|${file.size}|${file.lastModified}`;
          if (!seenFiles.has(fileKey)) {
            const monthLabel = monthKeys.sort((left, right) => {
              const leftYear = Number(left.slice(-2));
              const rightYear = Number(right.slice(-2));
              if (leftYear !== rightYear) return rightYear - leftYear;
              const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
              return monthNames.indexOf(right.slice(0, 3).toLowerCase()) - monthNames.indexOf(left.slice(0, 3).toLowerCase());
            })[0] || '';
            const monthParts = /\((\d+)\)\.json$/i.exec(file.name);
            projectsToImport.push({
              file: uploadFile,
              source,
              projectGid,
              monthLabel,
              monthOrder: monthLabel ? Number(monthLabel.slice(-2)) * 12
                + ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthLabel.slice(0, 3).toLowerCase())
                : Number.NEGATIVE_INFINITY,
              partNumber: Number(monthParts?.[1] || 1)
            });
            seenFiles.add(fileKey);
          }
        } catch (error) {
          selectionErrors.push(`${file.name}: ${error.message}`);
        }
      }
      projectsToImport.sort((left, right) => right.monthOrder - left.monthOrder
        || left.partNumber - right.partNumber
        || left.file.name.localeCompare(right.file.name));
      if (!projectsToImport.length) {
        renderDataToolIssues(selectionErrors);
        if (dataToolsStatus) dataToolsStatus.textContent = selectionErrors.length ? 'Some selected files could not be read.' : 'Choose Asana project JSON files or the exported Run folder.';
        return;
      }
      const confirmed = await confirmModal(
        'Import Asana projects?',
        `${projectsToImport.length} task file${projectsToImport.length === 1 ? '' : 's'} will be imported one at a time. Existing projects are reused, and a failed task file will not stop the rest. Users map by exact name; matching files from the selected export folder will be attached to their tasks.`,
        'Import projects',
        false
      );
      if (!confirmed) return;
      importProjectsButton.disabled = true;
      const synchronizedProjects = new Map();
      let attachmentCount = 0;
      let missingFileCount = 0;
      let unavailableFileCount = 0;
      let unsupportedProjectAttachmentCount = 0;
      const failures = [...selectionErrors];
      const warnings = [];
      renderDataToolIssues(failures);
      renderDataToolWarnings(warnings);
      setDataToolsProgress(0, `Importing 0 of ${projectsToImport.length} task files...`);
      try {
        const directoryFilesByName = new Map(directoryFiles.map(file => [file.name.toLocaleLowerCase(), file]));
        for (let index = 0; index < projectsToImport.length; index++) {
          const entry = projectsToImport[index];
          const projectProgress = (percent, phase = 'upload', serverProgress = null) => {
            if (phase === 'processing') {
              setDataToolsProgress(100, `Uploaded task file ${index + 1} of ${projectsToImport.length}; waiting for the server to import it into ${entry.source.project.name}...`, true, 'Upload 100%');
              return;
            }
            if (phase === 'server') {
              if (serverProgress?.status === 'failed') {
                setDataToolsProgress(percent, `Import failed: ${serverProgress.message}`, false, 'Failed');
                return;
              }
              setDataToolsProgress(percent, `${serverProgress?.message || `Importing ${entry.source.project.name}...`} · ${formatImportEta(serverProgress?.eta_seconds)}`, false, `${percent}% · ${formatImportEta(serverProgress?.eta_seconds)}`);
              return;
            }
            setDataToolsProgress(percent, `Uploading task file ${index + 1} of ${projectsToImport.length}: ${entry.source.project.name} (${percent}%)...`, false, `File ${index + 1}/${projectsToImport.length}: ${percent}%`);
          };
          projectProgress(0);
          let projectPayload;
          try {
            const projectForm = new FormData();
            const preparedProject = await prepareProjectUpload(entry.file);
            projectForm.append('projects', preparedProject.blob, preparedProject.filename);
            const progressId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            projectForm.append('progress_id', progressId);
            projectPayload = await postFormWithProgress('/api/admin/asana-import', projectForm, (percent, phase, serverProgress) => projectProgress(percent, phase, serverProgress), progressId);
          } catch (error) {
            failures.push(`${entry.file.name}: ${error.message}`);
            renderDataToolIssues(failures);
            setDataToolsProgress(((index + 1) / projectsToImport.length) * 100, `Skipped task file ${index + 1}; continuing with the next task.`);
            continue;
          }
          setDataToolsProgress(((index + 1) / projectsToImport.length) * 100, `Project ${index + 1} of ${projectsToImport.length} imported: ${entry.source.project.name}.`);
          const projectResult = projectPayload.results?.[0];
          if (!projectResult || projectResult.status === 'failed') {
            failures.push(`${entry.file.name}: ${projectResult?.error || 'Import failed.'}`);
            renderDataToolIssues(failures);
            continue;
          }
          const projectKey = String(projectResult.project_id || entry.projectGid);
          const synchronizedProject = synchronizedProjects.get(projectKey) || {
            id: Number(projectResult.project_id) || null,
            name: entry.source.project.name,
            tasks: 0
          };
          synchronizedProject.tasks += Number(projectResult.tasks || 0);
          synchronizedProjects.set(projectKey, synchronizedProject);
          if (projectResult.unmatched_users?.length) {
            warnings.push(`${entry.source.project.name}: no unique exact-name TaskFlow accounts matched ${projectResult.unmatched_users.join(', ')}. These people remain unassigned; their original Asana names stay visible on imported tasks and activity. Create matching TaskFlow accounts only if you want to assign them.`);
            renderDataToolWarnings(warnings);
          }

          const taskAttachments = [];
          const collectTaskAttachments = (bundle, rootTaskGid = '', rootTaskTitle = '', taskPath = []) => {
            const task = bundle?.task || {};
            const taskGid = String(task.gid || '');
            const targetTaskGid = rootTaskGid || taskGid;
            const targetTaskTitle = rootTaskTitle || String(task.name || '');
            const currentPath = [...taskPath, String(task.name || 'Untitled task')];
            for (const attachment of bundle?.attachments || []) {
              const filename = String(attachment.local_file || '').split(/[\\/]/).pop();
              if (!filename) unavailableFileCount++;
              else if (targetTaskGid || targetTaskTitle) taskAttachments.push({
                attachment,
                taskGid: targetTaskGid,
                taskTitle: targetTaskTitle,
                filename,
                context: taskPath.length ? currentPath.slice(1).join(' / ') : ''
              });
            }
            (bundle?.subtasks || []).forEach(child => collectTaskAttachments(child, targetTaskGid, targetTaskTitle, currentPath));
          };
          (entry.source.tasks || []).forEach(collectTaskAttachments);
          unsupportedProjectAttachmentCount += (entry.source.project_attachments || []).length;
          const matchedAttachments = [];
          for (const item of taskAttachments) {
            const file = directoryFilesByName.get(item.filename.toLocaleLowerCase());
            if (file) matchedAttachments.push({ ...item, file });
            else missingFileCount++;
          }
          const maxMappingBytes = 512 * 1024;
          const attachmentBatches = [];
          let batchItems = [];
          let batchMappings = [];
          for (const item of matchedAttachments) {
            const mapping = {
              task_gid: item.taskGid,
              task_title: item.taskTitle,
              attachment_gid: item.attachment.gid,
              name: item.attachment.name || item.filename,
              context: String(item.context || '').slice(-4000),
              created_at: item.attachment.created_at
            };
            const nextMappings = [...batchMappings, mapping];
            const nextSize = new TextEncoder().encode(JSON.stringify(nextMappings)).byteLength;
            if (batchItems.length && (batchItems.length >= 5 || nextSize > maxMappingBytes)) {
              attachmentBatches.push({ items: batchItems, mappings: batchMappings });
              batchItems = [];
              batchMappings = [];
            }
            if (new TextEncoder().encode(JSON.stringify([mapping])).byteLength > maxMappingBytes) {
              failures.push(`${entry.source.project.name}/${item.filename}: attachment metadata is too large to import.`);
              renderDataToolIssues(failures);
              continue;
            }
            batchItems.push(item);
            batchMappings.push(mapping);
          }
          if (batchItems.length) attachmentBatches.push({ items: batchItems, mappings: batchMappings });
          for (let batchIndex = 0; batchIndex < attachmentBatches.length; batchIndex++) {
            const { items: batch, mappings } = attachmentBatches[batchIndex];
            const batchNumber = batchIndex + 1;
            const batchCount = attachmentBatches.length;
            const attachmentForm = new FormData();
            attachmentForm.append('mappings', JSON.stringify(mappings));
            batch.forEach(item => attachmentForm.append('attachments', item.file, item.file.name));
            let attachmentPayload;
            try {
              attachmentPayload = await postFormWithProgress(`/api/admin/asana-import/${projectResult.project_id}/attachments`, attachmentForm, (percent, phase = 'upload') => {
                if (phase === 'processing') {
                  setDataToolsProgress(100, `Uploaded attachment batch ${batchNumber} of ${batchCount}; waiting for the server...`, true, 'Upload 100%');
                  return;
                }
                setDataToolsProgress(percent, `Uploading attachments for ${entry.source.project.name}, batch ${batchNumber} of ${batchCount} (${percent}%)...`, false, `Batch ${batchNumber}/${batchCount}: ${percent}%`);
              });
            } catch (error) {
              failures.push(`${entry.file.name}: attachment batch ${batchNumber} failed: ${error.message}`);
              renderDataToolIssues(failures);
              continue;
            }
            for (const result of attachmentPayload.results || []) {
              if (result.status === 'imported') attachmentCount++;
              else if (result.status === 'failed') {
                failures.push(`${entry.source.project.name}/${result.filename}: ${result.error}`);
                renderDataToolIssues(failures);
              }
            }
          }
          setDataToolsProgress(((index + 1) / projectsToImport.length) * 100, `Project ${index + 1} of ${projectsToImport.length} processed: ${entry.source.project.name}.`);
        }
        const projectList = Array.from(synchronizedProjects.values());
        const projectSummary = projectList.map(project => `${project.name}: ${project.tasks} tasks`).join('; ');
        const summary = [`Processed ${projectsToImport.length} task file${projectsToImport.length === 1 ? '' : 's'}.`, `Synchronized ${projectList.length} project${projectList.length === 1 ? '' : 's'}${projectSummary ? ` (${projectSummary})` : ''}.`, `${attachmentCount} attachments copied.`];
        if (missingFileCount) failures.push(`${missingFileCount} attachment file(s) were not found in the selected folder.`);
        if (unavailableFileCount) failures.push(`${unavailableFileCount} Asana task attachment(s) had no downloaded file in the JSON export.`);
        if (unsupportedProjectAttachmentCount) failures.push(`${unsupportedProjectAttachmentCount} project-level attachment(s) are not supported yet.`);
        dataToolsStatus.textContent = summary.join(' ');
        renderDataToolIssues(failures);
        renderDataToolWarnings(warnings);
        finishDataToolsProgress();
        if (projectList.length || attachmentCount) {
          await loadProjects();
        }
        if (failures.length) {
          dataToolsStatus.textContent = `${summary.join(' ')} Review the listed issues before leaving this page.`;
        }
        if (projectList.length) showAppNotification(`${projectList.length} Asana project${projectList.length === 1 ? '' : 's'} synchronized.`);
      } catch (error) {
        failures.push(error.message);
        renderDataToolIssues(failures);
        if (dataToolsStatus) dataToolsStatus.textContent = 'Import stopped because of an error.';
      } finally {
        importProjectsButton.disabled = false;
      }
    };

    const downloadMyDataButton = $('#download-my-data');
    if (downloadMyDataButton) downloadMyDataButton.onclick = async () => {
      const format = $('#my-data-export-format')?.value === 'csv' ? 'csv' : 'json';
      downloadMyDataButton.disabled = true;
      setDataToolsProgress(0, `Preparing ${format.toUpperCase()} task-data export...`, true);
      try {
        const response = await fetch(`/api/admin/data-export?format=${format}`, { credentials: 'same-origin' });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `Export failed (${response.status}).`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `taskflow-my-data-${todayISO()}.${format}`;
        link.click();
        URL.revokeObjectURL(url);
        finishDataToolsProgress();
        dataToolsStatus.textContent = `${format.toUpperCase()} task-data export downloaded.`;
      } catch (error) {
        dataToolsStatus.textContent = error.message;
      } finally {
        downloadMyDataButton.disabled = false;
      }
    };

    const exportProjectsButton = $('#taskflow-project-export');
    if (exportProjectsButton) exportProjectsButton.onclick = async () => {
      exportProjectsButton.disabled = true;
      setDataToolsProgress(0, 'Preparing TaskFlow project backup...', true);
      try {
        const response = await fetch('/api/admin/data-export', { credentials: 'same-origin' });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `Export failed (${response.status}).`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `taskflow-projects-${todayISO()}.json`;
        link.click();
        URL.revokeObjectURL(url);
        finishDataToolsProgress();
        dataToolsStatus.textContent = 'TaskFlow project backup downloaded.';
      } catch (error) {
        dataToolsStatus.textContent = error.message;
      } finally {
        exportProjectsButton.disabled = false;
      }
    };

    wrap.querySelectorAll('.admin-block').forEach((section) => {
      section.classList.add('is-collapsible');
      const sectionTitle = section.querySelector('h3')?.textContent || '';
      const storageKey = `taskflow-admin-section:${sectionTitle.trim()}`;
      const savedState = localStorage.getItem(storageKey);
      const isExpandedByDefault = sectionTitle.includes('Team members')
        || sectionTitle.includes('Project data import / export')
        || sectionTitle.includes('Task check-in / check-out access')
        || sectionTitle.includes('Task work location access');
      const isCollapsed = savedState ? savedState === 'collapsed' : !isExpandedByDefault;
      section.classList.toggle('is-collapsed', isCollapsed);
      const heading = section.querySelector('h3');
      if (!heading || heading.querySelector('.admin-section-toggle')) return;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'admin-section-toggle';
      const initiallyCollapsed = section.classList.contains('is-collapsed');
      toggle.textContent = initiallyCollapsed ? '+' : '−';
      toggle.title = initiallyCollapsed ? 'Expand section' : 'Collapse section';
      toggle.setAttribute('aria-label', initiallyCollapsed ? 'Expand section' : 'Collapse section');
      toggle.onclick = () => {
        const collapsed = section.classList.toggle('is-collapsed');
        localStorage.setItem(storageKey, collapsed ? 'collapsed' : 'expanded');
        toggle.textContent = collapsed ? '+' : '−';
        toggle.title = collapsed ? 'Expand section' : 'Collapse section';
        toggle.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
      };
      heading.prepend(toggle);
    });

    const tbody = $('#admin-employees-table-body');
    $('#reset-app-login-devices')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const confirmed = await confirmModal(
        'Reset all app sign-in devices?',
        'This clears the mobile-app sign-in binding for every user in this company. Each person must sign in again once; their new app installation will then be registered. Attendance device-access settings and attendance records are not changed.',
        'Reset app sign-ins',
        true
      );
      if (!confirmed) return;
      button.disabled = true;
      try {
        const result = await api('/auth/users/app-devices/reset', { method: 'POST', body: {} });
        showAppNotification(`Cleared ${Number(result.reset_count) || 0} app sign-in device bindings. Users can now sign in again.`);
      } catch (error) {
        showAppNotification(error.message);
      } finally {
        button.disabled = false;
      }
    });
    $('#reset-attendance-devices')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const confirmed = await confirmModal(
        'Reset all attendance devices?',
        'Clear attendance-device registrations for everyone? Each employee must register a device again before their next punch. This does not reset app sign-in devices, device access permissions, or attendance records.',
        'Reset attendance devices',
        true
      );
      if (!confirmed) return;
      button.disabled = true;
      try {
        const result = await api('/attendance/device-registration/reset-all', { method: 'POST', body: {} });
        showAppNotification(`Cleared ${Number(result.reset_count) || 0} attendance device registrations.`);
      } catch (error) {
        showAppNotification(error.message);
      } finally {
        button.disabled = false;
      }
    });
    if (tbody && Array.isArray(users)) {
      users.forEach((u) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = "1px solid #eee";
        const actionsHtml = `<button class="btn btn-secondary btn-sm admin-edit-user" type="button">Edit</button>`;
        tr.innerHTML = `
          <td style="padding:10px;"><b>${escapeHtml(u.name || u.NAME)}</b></td>
          <td style="padding:10px;">${escapeHtml(u.email || 'No email')}<br><small>${u.email ? (Number(u.email_verified) === 1 ? 'Verified · email code / Google available' : 'Unverified · password login available') : 'Password login available'}</small>${u.email && Number(u.email_verified) !== 1 ? '<br><button class="btn btn-secondary btn-sm admin-send-email-verification" type="button">Resend invitation</button>' : ''}</td>
          <td style="padding:10px;">${escapeHtml(u.date_of_birth || '—')}<br><small>${escapeHtml(u.phone || 'No phone')}</small></td>
          <td style="padding:10px;">${escapeHtml(u.department || u.DEPARTMENT || 'No department')}</td>
          <td style="padding:10px;">${escapeHtml(u.role || u.ROLE)}</td>
          <td style="padding:10px;"><span class="badge" style="background:${Number(u.active ?? u.ACTIVE) === 1 ? '#c8e6c9' : '#eeeeee'}; color:${Number(u.active ?? u.ACTIVE) === 1 ? '#25602a' : '#555'}; padding:4px 8px; border-radius:4px; font-size:12px;">${Number(u.active ?? u.ACTIVE) === 1 ? 'Active' : 'Disabled'}</span></td>
          <td style="padding:10px;"><label><input type="checkbox" data-web-login-user="${u.id}" ${Number(u.web_access_enabled) === 1 ? 'checked' : ''}> Allow browser login</label></td>
          <td style="padding:10px;"><label class="admin-biometric-toggle"><input type="checkbox" data-verification-user="${u.id}" ${verificationByUser.get(Number(u.id)) ? 'checked' : ''}><span>${verificationByUser.get(Number(u.id)) ? 'Required' : 'Off'}</span></label></td>
          <td style="padding:10px;">${actionsHtml}</td>
        `;
        tbody.appendChild(tr);
        tr.querySelector('.admin-edit-user').onclick = () => adminEditUser(u, departments);
        tr.querySelector('[data-web-login-user]').onchange = async event => {
          const checkbox = event.currentTarget;
          const enabled = checkbox.checked;
          checkbox.disabled = true;
          try {
            await api(`/auth/users/${Number(u.id)}/web-access`, { method: 'PUT', body: { enabled } });
            u.web_access_enabled = enabled ? 1 : 0;
            showAppNotification(`Browser login ${enabled ? 'allowed' : 'blocked'} for ${u.name}.`);
          } catch (error) {
            checkbox.checked = !enabled;
            showAppNotification(error.message);
          } finally {
            checkbox.disabled = false;
          }
        };
        tr.querySelector('.admin-send-email-verification')?.addEventListener('click', async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await api(`/auth/users/${Number(u.id)}/send-verification`, { method: 'POST' });
            showAppNotification('Email verification link sent.');
          } catch (error) {
            showAppNotification(error.message);
          } finally {
            button.disabled = false;
          }
        });
      });
      addAdminListPagination(tbody, 'Search team members by name, username, email, or department');
    }

    const departmentList = $('#department-list');
    departments.forEach((department) => {
      const row = document.createElement('div');
      row.className = 'member-option';
      row.innerHTML = `<span style="flex:1;">${escapeHtml(department.name || department.NAME)}</span><button class="btn btn-danger btn-sm" data-delete-department="${department.id}">Delete</button>`;
      departmentList.appendChild(row);
    });
    addAdminListPagination(departmentList, 'Search departments');

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
    addAdminListPagination(accessList, 'Search approvers by name or username');

    const trackingAccessList = $('#tracking-access-list');
    trackingAccess.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'tracking-access-row';
      row.innerHTML = `<div><b>${escapeHtml(person.name)}</b><span class="tracking-username">${escapeHtml(person.username)}</span></div><span class="tracking-access-status ${person.tracking_allowed ? 'allowed' : 'denied'}">${person.tracking_allowed ? 'Allowed' : 'Denied'}</span><label class="tracking-toggle"><input type="checkbox" ${person.tracking_allowed ? 'checked' : ''} data-tracking-access-user="${person.id}"><span>Allow tracking view</span></label>`;
      trackingAccessList.appendChild(row);
    });
    addAdminListPagination(trackingAccessList, 'Search employees by name or username');
    const paymentAccessList = $('#payment-history-access-list');
    paymentAccess.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'tracking-access-row';
      row.innerHTML = `<div><b>${escapeHtml(person.name)}</b><span class="tracking-username">${escapeHtml(person.username)}</span></div><span class="tracking-access-status ${person.allowed ? 'allowed' : 'denied'}">${person.allowed ? 'Allowed' : 'Denied'}</span><label class="tracking-toggle"><input type="checkbox" ${person.allowed ? 'checked' : ''} data-payment-access-user="${person.user_id}"><span>Allow payment history</span></label>`;
      paymentAccessList.appendChild(row);
    });
    addAdminListPagination(paymentAccessList, 'Search employees by name or username');
    const taskCheckinAccessList = $('#task-checkin-access-list');
    taskCheckinAccess.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'tracking-access-row';
      row.innerHTML = `<div><b>${escapeHtml(person.name)}</b><span class="tracking-username">${escapeHtml(person.username)}</span></div><label class="tracking-toggle"><input type="checkbox" ${Number(person.checkin_required) === 1 ? 'checked' : ''} data-task-checkin-user="${person.id}"><span>Require task GPS check-in/out</span></label>`;
      taskCheckinAccessList.appendChild(row);
    });
    addAdminListPagination(taskCheckinAccessList, 'Search employees by name or username');
    $$('[data-task-checkin-user]').forEach((checkbox) => {
      checkbox.onchange = async () => {
        try {
          await api(`/task-checkin-access/${checkbox.dataset.taskCheckinUser}`, { method: 'PUT', body: { enabled: checkbox.checked } });
          showAppNotification('Task check-in access updated.');
        } catch (error) { checkbox.checked = !checkbox.checked; showAppNotification(error.message); }
      };
    });
    const taskWorkModeAccessList = $('#task-work-mode-access-list');
    taskWorkModeAccess.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'tracking-access-row';
      row.innerHTML = `<div><b>${escapeHtml(person.name)}</b><span class="tracking-username">${escapeHtml(person.username)}</span></div><label class="tracking-toggle"><input type="checkbox" ${Number(person.can_change_work_mode) === 1 ? 'checked' : ''} data-task-work-mode-user="${person.id}"><span>Can change Office / On-field</span></label>`;
      taskWorkModeAccessList.appendChild(row);
    });
    addAdminListPagination(taskWorkModeAccessList, 'Search employees by name or username');
    $$('[data-task-work-mode-user]').forEach((checkbox) => {
      checkbox.onchange = async () => {
        try {
          await api(`/task-work-mode-access/${checkbox.dataset.taskWorkModeUser}`, { method: 'PUT', body: { enabled: checkbox.checked } });
          showAppNotification('Task work location access updated.');
        } catch (error) { checkbox.checked = !checkbox.checked; showAppNotification(error.message); }
      };
    });
    const projectActionList = $('#project-action-access-list');
    const projectActionLabels = { create_project: 'Create projects', edit_project: 'Rename/edit projects', delete_project: 'Delete projects', create_task: 'Add tasks', edit_task: 'Edit tasks', delete_task: 'Delete tasks', complete_task: 'Complete tasks' };
    const projectActionSearch = $('#project-action-access-search');
    const projectActionPageSize = $('#project-action-access-page-size');
    const projectActionCount = $('#project-action-access-count');
    const projectActionPagination = $('#project-action-access-pagination');
    let projectActionPage = 0;
    const renderProjectActionPage = () => {
      const query = projectActionSearch.value.trim().toLocaleLowerCase();
      const filtered = projectActionAccess.filter(person =>
        `${person.name || ''} ${person.username || ''}`.toLocaleLowerCase().includes(query));
      const pageSize = Number(projectActionPageSize.value) || 25;
      const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      projectActionPage = Math.min(projectActionPage, pageCount - 1);
      const start = projectActionPage * pageSize;
      const page = filtered.slice(start, start + pageSize);
      projectActionList.innerHTML = '';
      page.forEach(person => {
        const row = document.createElement('div');
        row.className = 'admin-form-row permission-user-row';
        const isAdmin = person.role === 'admin';
        row.innerHTML = `<div class="permission-user-name"><b>${escapeHtml(person.name)}</b><small>${escapeHtml(person.username || '')}</small></div><div class="permission-user-actions">${Object.entries(projectActionLabels).map(([action, label]) => `<label><input type="checkbox" data-project-action="${action}" data-project-user="${person.user_id}" ${Number(person[action]) === 1 ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}> ${label}</label>`).join('')}</div><button class="btn btn-secondary btn-sm save-project-actions" data-project-user="${person.user_id}" ${isAdmin ? 'disabled' : ''}>Save</button>`;
        projectActionList.appendChild(row);
      });
      projectActionCount.textContent = filtered.length
        ? `Showing ${start + 1}-${Math.min(start + page.length, filtered.length)} of ${filtered.length} users`
        : 'No matching users';
      projectActionPagination.innerHTML = pageCount > 1
        ? `<button type="button" class="btn btn-secondary btn-sm" data-permission-page="previous" ${projectActionPage === 0 ? 'disabled' : ''}>Previous</button><span>Page ${projectActionPage + 1} of ${pageCount}</span><button type="button" class="btn btn-secondary btn-sm" data-permission-page="next" ${projectActionPage >= pageCount - 1 ? 'disabled' : ''}>Next</button>`
        : '';
      projectActionPagination.querySelector('[data-permission-page="previous"]')?.addEventListener('click', () => { projectActionPage--; renderProjectActionPage(); });
      projectActionPagination.querySelector('[data-permission-page="next"]')?.addEventListener('click', () => { projectActionPage++; renderProjectActionPage(); });
      projectActionList.querySelectorAll('.save-project-actions').forEach(button => {
        button.onclick = async () => {
          const userId = button.dataset.projectUser;
          const row = button.closest('.permission-user-row');
          const body = {};
          row.querySelectorAll('[data-project-action]').forEach(input => { body[input.dataset.projectAction] = input.checked; });
          button.disabled = true;
          try {
            await api(`/project-action-access/${userId}`, { method: 'PUT', body });
            showAppNotification('Project and task permissions updated.');
          } catch (error) {
            showAppNotification(error.message);
          } finally {
            button.disabled = false;
          }
        };
      });
    };
    projectActionSearch.oninput = () => { projectActionPage = 0; renderProjectActionPage(); };
    projectActionPageSize.onchange = () => { projectActionPage = 0; renderProjectActionPage(); };
    renderProjectActionPage();
    renderAttendanceDeviceAccess(deviceAccess);
    $$('[data-payment-access-user]').forEach((checkbox) => {
      checkbox.onchange = async () => {
        try {
          await api(`/payment-history/access/${checkbox.dataset.paymentAccessUser}`, { method: 'PUT', body: { allowed: checkbox.checked } });
          const row = checkbox.closest('.tracking-access-row');
          const status = row?.querySelector('.tracking-access-status');
          if (status) { status.textContent = checkbox.checked ? 'Allowed' : 'Denied'; status.classList.toggle('allowed', checkbox.checked); status.classList.toggle('denied', !checkbox.checked); }
          showAppNotification(checkbox.checked ? 'Payment History access granted.' : 'Payment History access removed.');
        } catch (error) { checkbox.checked = !checkbox.checked; showAppNotification(error.message); }
      };
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
        } catch (error) { checkbox.checked = !checkbox.checked; showAppNotification(error.message); }
      };
    });

    const activityList = $('#activity-log-list');
    activityList.innerHTML = uiSkeletonRows(3);
    const loadActivity = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        return await api('/auth/activity?limit=100', { signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('/auth/activity timed out after 60 seconds.');
        throw new Error(`/auth/activity: ${error.message}`);
      } finally {
        clearTimeout(timeout);
      }
    };
    loadActivity().then(activity => {
      if (!activityList.isConnected) return;
      if (!activity.length) {
        activityList.innerHTML = '<p class="hint">No activity recorded yet.</p>';
      } else {
        activityList.innerHTML = activity.map((entry) => `
        <div class="member-option" style="display:block; padding:10px 0; border-bottom:1px solid #eee;">
          <b>${escapeHtml(entry.action)}</b>
          <span class="hint"> by ${escapeHtml(entry.actor_name || 'Unknown user')} on ${escapeHtml(parseTaskFlowTimestamp(entry.created_at).toLocaleString())}</span>
          ${entry.details ? `<div>${escapeHtml(entry.details)}</div>` : ''}
        </div>`).join('');
      }
    }).catch(error => {
      if (!activityList.isConnected) return;
      activityList.innerHTML = `<p class="form-error">Recent activity unavailable: ${escapeHtml(error.message)}</p><button class="btn btn-secondary" id="activity-retry" type="button">Retry</button>`;
      $('#activity-retry').onclick = () => {
        activityList.innerHTML = uiSkeletonRows(3);
        loadActivity().then(entries => {
          if (!activityList.isConnected) return;
          activityList.innerHTML = entries.length ? entries.map(entry => `
            <div class="member-option" style="display:block; padding:10px 0; border-bottom:1px solid #eee;">
              <b>${escapeHtml(entry.action)}</b>
              <span class="hint"> by ${escapeHtml(entry.actor_name || 'Unknown user')} on ${escapeHtml(parseTaskFlowTimestamp(entry.created_at).toLocaleString())}</span>
              ${entry.details ? `<div>${escapeHtml(entry.details)}</div>` : ''}
            </div>`).join('') : '<p class="hint">No activity recorded yet.</p>';
        }).catch(retryError => {
          if (activityList.isConnected) activityList.innerHTML = `<p class="form-error">Recent activity unavailable: ${escapeHtml(retryError.message)}</p>`;
        });
      };
    });
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
      } catch (err) { showAppNotification(err.message); }
    };

    $$('[data-delete-department]').forEach((button) => {
      button.onclick = async () => {
        if (!await confirmModal('Delete department?', 'Existing employee records will keep their current text.')) return;
        try {
          await api(`/auth/departments/${button.dataset.deleteDepartment}`, { method: 'DELETE' });
          refreshNotificationsAfterAction();
          renderAdmin();
        } catch (err) { showAppNotification(err.message); }
      };
    });

    $('#admin-settings-save').onclick = async () => {
      const lat = parseFloat($('#admin-lat').value);
      const lng = parseFloat($('#admin-lng').value);
      const radius = parseInt($('#admin-radius').value);
      try {
        await api('/auth/settings', { method: 'PUT', body: { office_lat: lat, office_lng: lng, office_radius_m: radius } });
        showAppNotification('Tracking center settings saved successfully.');
      } catch (err) { showAppNotification(err.message); }
    };

    $('#admin-retention-save').onclick = async () => {
      const attachmentDays = Number($('#attachment-retention-days').value);
      const locationDays = Number($('#attendance-retention-days').value);
      if (!Number.isInteger(attachmentDays) || attachmentDays < 0 || attachmentDays > 36500
        || !Number.isInteger(locationDays) || locationDays < 1 || locationDays > 36500) {
        return showAppNotification('Retention periods must be whole days from 0 to 36500; GPS/device retention must be at least 1 day.');
      }
      try {
        await api('/auth/settings', { method: 'PUT', body: {
          attachment_retention_days: attachmentDays,
          attendance_location_retention_days: locationDays
        }});
        showAppNotification('Data retention settings saved.');
      } catch (err) { showAppNotification(err.message); }
    };

    $$('[data-verification-user]').forEach((checkbox) => {
      checkbox.onchange = async () => {
        try {
          await api(`/attendance/verification-access/${checkbox.dataset.verificationUser}`, { method: 'PUT', body: { enabled: checkbox.checked } });
          checkbox.nextElementSibling.textContent = checkbox.checked ? 'Required' : 'Off';
          showAppNotification(checkbox.checked ? 'Biometric and password verification enabled.' : 'Attendance verification disabled.');
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          showAppNotification(error.message);
        }
      };
    });

    $('#u-add').onclick = async () => {
      const name = $('#u-name').value.trim();
      const username = $('#u-username').value.trim();
      const password = $('#u-password').value;
      const date_of_birth = $('#u-date-of-birth').value;
      const phone = $('#u-phone').value.trim();
      const department = $('#u-department').value.trim();
      const email = $('#u-email').value.trim();
      const role = $('#u-role').value;

      if (!name || !username || !password || !date_of_birth || !phone || !department || !email) {
        return showAppNotification('Name, username, temporary password, date of birth, phone, email, and department are required.');
      }

      try {
        const result = await api('/auth/users', {
          method: 'POST',
          body: { name, username, password, date_of_birth, phone, department, role, email }
        });
        const notice = result.invitationSent
          ? ' Optional email verification invitation sent.'
          : ` Email verification invitation not sent (${result.invitationError || 'check email delivery settings'}); username/password login is ready.`;
        reloadWithActionMessage('admin', `Employee added. Share the username and temporary password securely; they must change the password at first sign-in.${notice}`);
      } catch (err) { showAppNotification(err.message); }
    };


  } catch (err) {
    console.error('Failed loading administrator settings:', err);
    wrap.innerHTML = `<div class="admin-block" role="alert"><p class="form-error">Unable to load administrator settings: ${escapeHtml(err.message)}</p><button class="btn btn-secondary" id="admin-retry" type="button">Retry</button></div>`;
    $('#admin-retry').onclick = () => renderAdmin();
  }
}

function attendanceSummaryMonthMarkup(summary, year, month, options = {}) {
  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const today = options.today;
  const days = Array.isArray(summary?.days) ? summary.days : [];
  const byDate = new Map(days.map(day => [day.date, day]));
  const activeStaff = Number(summary?.active_staff) || 0;
  const presentTotal = days.reduce((sum, day) => sum + Number(day.present), 0);
  const punchIns = days.reduce((sum, day) => sum + Number(day.punch_ins), 0);
  const punchOuts = days.reduce((sum, day) => sum + Number(day.punch_outs), 0);
  const presentDays = days.filter(day => Number(day.present) > 0).length;
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month, 1)));
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weekdayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map(day => `<span class="attendance-calendar-weekday">${day}</span>`).join('');
  const emptyDays = Array.from({ length: firstWeekday }, () => '<span class="attendance-calendar-empty" aria-hidden="true"></span>').join('');
  const dayCells = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${monthKey}-${String(index + 1).padStart(2, '0')}`;
    const present = Number(byDate.get(date)?.present || 0);
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const isWorkday = weekday !== 0 && weekday !== 6;
    const outsideRange = (options.from && date < options.from) || (options.to && date > options.to);
    let state = '';
    if (date > today) state = '';                                   // future: nothing yet
    else if (present > 0 && present >= activeStaff) state = 'has-attendance';
    else if (date === today) state = present > 0 ? 'has-attendance' : '';  // today is still in progress
    else if (isWorkday) state = 'is-absent';                        // past working day, someone missing
    else state = present > 0 ? 'has-attendance' : '';               // weekend with punches
    const label = state === 'is-absent' ? ', absent' : (present ? `, ${present} present` : '');
    return `<button type="button" class="attendance-calendar-day ${state} ${date === today ? 'is-today' : ''} ${outsideRange ? 'outside-range' : ''}"
        data-attendance-date="${date}" aria-label="${date}${label}">
        <span class="attendance-calendar-day-number">${index + 1}</span>
        ${options.admin && present ? `<span class="attendance-calendar-day-count">${present}</span>` : ''}
      </button>`;
  }).join('');
  const controls = options.monthNavigation ? `
    <button type="button" class="attendance-calendar-nav" id="attendance-history-prev" aria-label="Previous month">‹</button>
    <h3>${monthTitle}</h3>
    <button type="button" class="attendance-calendar-nav" id="attendance-history-next" aria-label="Next month" ${monthKey >= today.slice(0, 7) ? 'disabled' : ''}>›</button>`
    : `<h3>${monthTitle}</h3>`;
  return `<section class="attendance-calendar-month">
    <div class="attendance-calendar-heading">${controls}</div>
    <div class="attendance-calendar-summary">
      <div><b>${options.admin ? presentTotal : presentDays}</b><small>${options.admin ? 'Employee-days present' : 'Present days'}</small></div>
      <div><b>${punchIns}</b><small>Punch-ins</small></div>
      <div><b>${punchOuts}</b><small>Punch-outs</small></div>
    </div>
    <div class="attendance-calendar-weekdays">${weekdayHeaders}</div>
    <div class="attendance-calendar-grid">${emptyDays}${dayCells}</div>
  </section>`;
}

async function renderAdminAttendance(users, targetId = 'admin-attendance-content') {
  const wrap = $(`#${targetId}`);
  if (!wrap) return;
  const myDeviceAccess = await api('/attendance/device-access/me');
  const today = todayISO();
  const myId = Number(ME?.id);
  // Put the signed-in admin first so they can check their own attendance in the same calendar.
  const orderedUsers = [...users].sort((a, b) => Number(Number(b.id ?? b.ID) === myId) - Number(Number(a.id ?? a.ID) === myId));
  const employeeOptions = orderedUsers.map(u => {
    const id = Number(u.id ?? u.ID);
    const name = escapeHtml(u.name || u.NAME);
    return `<option value="${id}">${id === myId ? `My attendance (${name})` : name}</option>`;
  }).join('');
  const departments = [...new Set(users.map(u => u.department || u.DEPARTMENT || '').filter(Boolean))].sort();
  const departmentOptions = departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

  // The calendar always shows one month. It opens on the current month; a From/To range
  // inside that month narrows the view and dims the days outside it.
  const monthBounds = (year, month) => ({
    from: `${year}-${String(month + 1).padStart(2, '0')}-01`,
    to: new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)
  });
  const [startYear, startMonth] = today.split('-').map(Number);
  const defaults = monthBounds(startYear, startMonth - 1);
  let monthStart = new Date(Date.UTC(startYear, startMonth - 1, 1));
  let rangeFrom = null;
  let rangeTo = null;
  let requestCounter = 0;

  const activeRange = () => {
    const year = monthStart.getUTCFullYear();
    const month = monthStart.getUTCMonth();
    const bounds = monthBounds(year, month);
    return { year, month, from: rangeFrom || bounds.from, to: rangeTo || bounds.to };
  };

  wrap.innerHTML = `
    <h2 class="section-title">Attendance calendar</h2>
    <div class="attendance-filters">
      <label>From <input type="date" id="admin-att-from" value="${defaults.from}"></label>
      <label>To <input type="date" id="admin-att-to" value="${defaults.to}"></label>
      <button class="btn btn-secondary btn-sm" id="admin-att-filter" type="button">Filter</button>
      <label>Employee <select id="admin-att-employee"><option value="">All employees</option>${employeeOptions}</select></label>
      <label>Department <select id="admin-att-department"><option value="">All departments</option>${departmentOptions}</select></label>
      <button class="btn btn-secondary" id="admin-att-export" type="button">Export CSV</button>
    </div>
    <p class="form-error" id="admin-att-range-error" role="alert"></p>
    <div id="admin-attendance-calendar"></div>`;

  const calendar = $('#admin-attendance-calendar');
  const filterQuery = () => {
    const userId = $('#admin-att-employee').value;
    const department = $('#admin-att-department').value;
    return `${userId ? `&user_id=${encodeURIComponent(userId)}` : ''}${department ? `&department=${encodeURIComponent(department)}` : ''}`;
  };

  const setMonth = date => {
    monthStart = date;
    rangeFrom = null;
    rangeTo = null;
    const bounds = activeRange();
    $('#admin-att-from').value = bounds.from;
    $('#admin-att-to').value = bounds.to;
    $('#admin-att-range-error').textContent = '';
    renderRows();
  };

  const applyRange = () => {
    const error = $('#admin-att-range-error');
    const from = $('#admin-att-from').value;
    const to = $('#admin-att-to').value;
    if (!from || !to) {
      error.textContent = 'Choose both From and To dates.';
      return;
    }
    if (from > to) {
      error.textContent = 'The From date must be before the To date.';
      return;
    }
    if (from.slice(0, 7) !== to.slice(0, 7)) {
      error.textContent = 'Choose a range within one month. The calendar shows one month at a time.';
      return;
    }
    error.textContent = '';
    const [year, month] = from.split('-').map(Number);
    monthStart = new Date(Date.UTC(year, month - 1, 1));
    rangeFrom = from;
    rangeTo = to;
    renderRows();
  };

  const renderRows = async (openDate = null) => {
    const requestId = ++requestCounter;
    const { year, month, from, to } = activeRange();
    const userId = $('#admin-att-employee').value;
    calendar.innerHTML = uiSkeletonCalendar();
    const stopSlowHint = startSlowLoadingHint(calendar);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      // One small row per day from the server, not every punch row for the month.
      const summary = await api(`/attendance/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${filterQuery()}`, { signal: controller.signal });
      clearTimeout(timeout);
      stopSlowHint();
      if (requestId !== requestCounter) return;
      calendar.innerHTML = attendanceSummaryMonthMarkup(summary, year, month, { admin: !userId, monthNavigation: true, from, to, today });
      const openDay = async date => {
        // Details load for the one day clicked.
        const allowAdminPunch = date === today && Boolean(myDeviceAccess[`allow_${currentDeviceType()}`]);
        let dayRows;
        try {
          dayRows = await api(`${allowAdminPunch ? '/attendance/overview' : '/attendance'}?date=${encodeURIComponent(date)}${filterQuery()}`);
        } catch (error) {
          showAppNotification(error.message);
          return;
        }
        showAttendanceDayDetails(date, Array.isArray(dayRows) ? dayRows : [], {
          admin: true,
          withinRange: date >= from && date <= to,
          allowAdminPunch,
          onAdminPunch: async (button, selectedDate) => {
            await api(`/attendance/admin-punch-${button.dataset.action}`, {
              method: 'POST', body: { user_id: Number(button.dataset.userId) }
            });
            await renderRows(selectedDate);
          }
        });
      };
      calendar.querySelectorAll('[data-attendance-date]').forEach(button => {
        button.onclick = () => openDay(button.dataset.attendanceDate);
      });
      $('#attendance-history-prev').onclick = () => setMonth(new Date(Date.UTC(year, month - 1, 1)));
      $('#attendance-history-next')?.addEventListener('click', () => setMonth(new Date(Date.UTC(year, month + 1, 1))));
      if (openDate) await openDay(openDate);
    } catch (err) {
      clearTimeout(timeout);
      stopSlowHint();
      if (requestId === requestCounter) {
        calendar.innerHTML = uiErrorState(err, 'admin-att-retry');
        $('#admin-att-retry').onclick = () => renderRows();
      }
    }
  };

  $('#admin-att-filter').onclick = applyRange;
  $('#admin-att-employee').onchange = () => renderRows();
  $('#admin-att-department').onchange = () => renderRows();
  $('#admin-att-export').onclick = () => {
    const { from, to } = activeRange();
    const query = new URLSearchParams({ from, to });
    if ($('#admin-att-employee').value) query.set('user_id', $('#admin-att-employee').value);
    if ($('#admin-att-department').value) query.set('department', $('#admin-att-department').value);
    window.open(`/api/attendance/export.csv?${query.toString()}`, '_blank');
  };
  renderRows();
}

// ================= MODAL DIALOG OPERATIONS CONTEXTS =================
function showSelfPasswordModal(forced = false) {
  if (forced && forcedPasswordModalOpen) return;
  forcedPasswordModalOpen = forced;
  showModal(`
    <h3>${forced ? 'Set a new password to continue' : 'Change password'}</h3>
    ${forced ? '<p>Your password must be changed before you can use TaskFlow.</p>' : ''}
    <input id="self-current-password" type="password" placeholder="Current password" autocomplete="current-password">
    <input id="self-new-password" type="password" minlength="10" placeholder="New password (minimum 10 characters)" autocomplete="new-password">
    <div id="self-password-error" class="form-error"></div>
    <div class="modal-actions">${forced ? '<button class="btn btn-secondary" id="self-password-cancel">Sign out</button>' : '<button class="btn btn-secondary" id="self-password-cancel">Cancel</button>'}<button class="btn btn-primary" id="self-password-save">Update password</button></div>`);
  $('#self-password-cancel').onclick = async () => {
    if (!forced) return closeModal();
    try {
      await unregisterPushToken();
      try { await stopNativeShiftTracking(); } catch (error) { console.warn('Unable to stop native shift tracking before logout:', error.message); }
      clearNativeDashboardCache();
      await api('/auth/logout', { method: 'POST' });
      ME = null;
      location.reload();
    } catch (err) { $('#self-password-error').textContent = err.message; }
  };
  $('#self-password-save').onclick = async () => {
    const error = $('#self-password-error');
    try {
      await api('/auth/change-password', { method: 'POST', body: {
        current_password: $('#self-current-password').value,
        new_password: $('#self-new-password').value
      }});
      if (forced) {
        ME = await api('/auth/me');
        closeModal();
        enterApp();
      } else {
        closeModal();
        reloadWithActionMessage(currentViewName(), 'Password changed successfully.');
      }
    } catch (err) { error.textContent = err.message; }
  };
}

function adminEditUser(user, departments) {
  const userId = Number(user.id || user.ID);
  const isSelf = userId === Number(ME.id);
  const department = user.department || user.DEPARTMENT || '';
  const role = user.role || user.ROLE || 'employee';
  const active = Number(user.active ?? user.ACTIVE) === 1;
  showModal(`
    <div class="user-edit-dialog">
      <h3>Edit employee</h3>
      <div class="user-edit-fields">
        <label class="user-edit-field">Employee name<input id="admin-edit-name" value="${escapeHtml(user.name || user.NAME || '')}" autocomplete="name"></label>
        <label class="user-edit-field">Email address<input id="admin-edit-email" type="email" required value="${escapeHtml(user.email || '')}" autocomplete="email"></label>
        <label class="user-edit-field">Date of birth<input id="admin-edit-date-of-birth" type="date" value="${escapeHtml(user.date_of_birth || '')}"></label>
        <label class="user-edit-field">Phone number<input id="admin-edit-phone" type="tel" value="${escapeHtml(user.phone || '')}" autocomplete="tel"></label>
        <label class="user-edit-field">Department<select id="admin-edit-department"><option value="">No department</option>${departments.map(item => {
        const name = item.name || item.NAME || '';
        return `<option value="${escapeHtml(name)}" ${name === department ? 'selected' : ''}>${escapeHtml(name)}</option>`;
      }).join('')}</select></label>
        <label class="user-edit-field">Role<select id="admin-edit-role" ${isSelf ? 'disabled' : ''}><option value="employee" ${role === 'employee' ? 'selected' : ''}>Employee</option><option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
        <label class="user-edit-field">Account status<select id="admin-edit-active" ${isSelf ? 'disabled' : ''}><option value="1" ${active ? 'selected' : ''}>Active</option><option value="0" ${!active ? 'selected' : ''}>Disabled</option></select></label>
        <label class="user-edit-field">New password<input id="admin-edit-password" type="password" minlength="10" placeholder="Leave blank to keep current password; 10 characters minimum" autocomplete="new-password"></label>
      </div>
      <div id="admin-edit-error" class="form-error"></div>
      <div class="modal-actions user-edit-actions">
        ${!isSelf && active ? '<button class="btn btn-danger" id="admin-edit-remove" type="button">Remove user</button>' : ''}
        <button class="btn btn-secondary" id="admin-edit-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="admin-edit-save" type="button">Save changes</button>
      </div>
    </div>`);
  $('#admin-edit-cancel').onclick = closeModal;
  $('#admin-edit-save').onclick = async () => {
    const error = $('#admin-edit-error');
    const password = $('#admin-edit-password').value;
    const body = {
      name: $('#admin-edit-name').value.trim(),
      email: $('#admin-edit-email').value.trim(),
      department: $('#admin-edit-department').value,
      role: isSelf ? role : $('#admin-edit-role').value,
      active: $('#admin-edit-active').value === '1'
    };
    const dateOfBirth = $('#admin-edit-date-of-birth').value;
    const phone = $('#admin-edit-phone').value.trim();
    if (dateOfBirth) body.date_of_birth = dateOfBirth;
    if (phone) body.phone = phone;
    error.textContent = '';
    if (!body.name || !body.email) { error.textContent = 'Employee name and email are required.'; return; }
    if (password && password.length < 10) { error.textContent = 'Password must be at least 10 characters long.'; return; }
    if (password) body.password = password;
    try {
      const result = await api(`/auth/users/${userId}`, { method: 'PUT', body });
      closeModal();
      showAppNotification(result.emailVerificationSent === false
        ? (result.emailVerificationError || 'Email address saved but not verified; send a verification link.')
        : result.emailVerificationSent === true
          ? 'Employee details updated. Email verification link sent.'
          : 'Employee details updated.');
      await renderAdmin();
    } catch (err) { error.textContent = err.message; }
  };
  $('#admin-edit-remove')?.addEventListener('click', () => adminRemoveUser(userId, user.name || user.NAME || user.username || user.USERNAME));
}

async function adminChangePassword(userId, userName) {
  showModal(`
    <h3>Modify Credentials for ${escapeHtml(userName)}</h3>
    <div style="margin: 15px 0;">
      <label style="display:block; margin-bottom:5px; font-weight:bold;">New Password</label>
      <input id="adm-new-pass" type="password" minlength="10" placeholder="Enter new password (min 10 characters)" autofocus style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
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

    if (!password || password.length < 10) {
      if (errorEl) errorEl.textContent = 'Password must be at least 10 characters long.';
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
    `Remove ${userName}'s access? Their attendance and task history will be preserved.`,
    'Remove User',
    true
  );
  
  if (!confirmed) return;

  try {
    await api(`/auth/users/${userId}`, { method: 'DELETE' });
    closeModal();
    showAppNotification('User access removed; historical records were preserved.');
    await renderAdmin();
  } catch (err) {
    showAppNotification(err.message);
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' });
      await registration.update();
    } catch (error) {
      console.warn('Service worker update failed:', error);
    }
  });
}
