'use strict';

const loginView = document.getElementById('login-view');
const overviewView = document.getElementById('overview-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const overviewError = document.getElementById('overview-error');
const managementMessage = document.getElementById('management-message');
const logoutButton = document.getElementById('logout-button');
const companyForm = document.getElementById('company-form');
const companyFormError = document.getElementById('company-form-error');
const createdCompanyDetails = document.getElementById('created-company-details');
let overviewData = null;
let activeCompanyDetail = null;
let planRecords = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

async function request(path, options) {
  const response = await fetch(`/api/superadmin/${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options
  });
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (response.ok) throw new Error('The server returned an invalid response.');
    result = {};
  }
  if (!response.ok) {
    const error = new Error(result.error || 'Unable to complete the request.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function showLogin(message = '') {
  loginView.classList.remove('hidden');
  overviewView.classList.add('hidden');
  logoutButton.classList.add('hidden');
  loginError.textContent = message;
  loginError.classList.toggle('hidden', !message);
}

function showOverview() {
  loginView.classList.add('hidden');
  overviewView.classList.remove('hidden');
  logoutButton.classList.remove('hidden');
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}

function renderSummary(summary) {
  const cards = [
    { label: 'Registered companies', value: summary.companyCount, caption: 'In the control database' },
    { label: 'Trials running', value: summary.trialCount, caption: `${summary.trialEndingSoonCount} ending within 2 days` },
    { label: 'Active paid', value: summary.activePaidCount, caption: `${summary.paidSeats.toLocaleString()} paid seats` },
    { label: 'Suspended', value: summary.suspendedCount, caption: 'Company workspaces' },
    { label: 'Cancelled', value: summary.cancelledCount, caption: 'Company workspaces' },
    { label: 'MRR', value: formatPaise(summary.monthlyRecurringRevenuePaise, 'INR'), caption: 'From active subscriptions' },
    { label: 'ARR', value: formatPaise(summary.annualRecurringRevenuePaise, 'INR'), caption: 'Monthly recurring revenue × 12' },
    {
      label: 'Storage used / allocated',
      value: `${formatBytes(summary.totalStorageBytes)} / ${summary.allocatedStorageBytes == null ? 'Unlimited' : formatBytes(summary.allocatedStorageBytes)}`,
      caption: `${summary.totalUsers.toLocaleString()} recorded active users · latest snapshots`
    }
  ];
  document.getElementById('summary-cards').innerHTML = cards.map(card => `
    <article class="summary-card">
      <div class="summary-label">${escapeHtml(card.label)}</div>
      <div class="summary-value">${escapeHtml(card.value)}</div>
      <div class="summary-caption">${escapeHtml(card.caption)}</div>
    </article>`).join('');
}

function renderUserErrors(result) {
  document.getElementById('user-error-count').textContent = `${result.pendingCount} open`;
  const list = document.getElementById('user-error-list');
  list.innerHTML = result.errors.length
    ? result.errors.map(error => {
      const company = error.companyName || error.companyCode || (error.companyId ? `Company #${error.companyId}` : 'Unknown company');
      const event = error.event.replace(/[_-]+/g, ' ');
      return `<article class="record-row user-error-row">
        <div><strong>${escapeHtml(company)} · ${escapeHtml(event)}</strong>
          <small>${escapeHtml(error.method)} ${escapeHtml(error.route)} · HTTP ${escapeHtml(error.statusCode)} · ${escapeHtml(formatDate(error.createdAt))}</small>
          <small>Request <code>${escapeHtml(error.requestId)}</code>${error.actorUserId ? ` · User #${escapeHtml(error.actorUserId)}` : ''}</small>
        </div>
        ${error.resolvedAt ? `<span>Resolved ${escapeHtml(formatDate(error.resolvedAt))}</span>` : `<button class="button button-quiet" type="button" data-error-resolve="${error.id}">Resolve</button>`}
      </article>`;
    }).join('')
    : '<p class="user-error-empty">No open user errors.</p>';
}

async function loadUserErrors(status = 'open') {
  const errorTarget = document.getElementById('user-error-load-error');
  errorTarget.classList.add('hidden');
  try {
    renderUserErrors(await request(`user-errors?status=${status}`));
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.classList.remove('hidden');
  }
}

function renderCompanies(companies, plans) {
  overviewData = overviewData || { companies, plans };
  const planSelect = document.getElementById('new-company-plan');
  const currentPlanId = planSelect.value;
  planSelect.innerHTML = plans.map(plan =>
    `<option value="${plan.id}">${escapeHtml(plan.name)}${plan.maxUsers === null ? ' — unlimited users' : ` — ${plan.maxUsers} users`}</option>`
  ).join('');
  if (plans.some(plan => String(plan.id) === currentPlanId)) planSelect.value = currentPlanId;
  getFilteredCompanies();
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: value.includes(':') ? 'short' : undefined });
}

function showControlPage(page) {
  document.getElementById('control-overview-page').classList.toggle('hidden', page !== 'overview');
  document.getElementById('plans-page').classList.toggle('hidden', page !== 'plans');
  document.getElementById('company-detail-page').classList.toggle('hidden', page !== 'detail');
  document.querySelectorAll('[data-admin-page]').forEach(button => {
    button.classList.toggle('active', button.dataset.adminPage === page || (page === 'detail' && button.dataset.adminPage === 'overview'));
  });
}

function getFilteredCompanies() {
  if (!overviewData) return [];
  const search = document.getElementById('company-search').value.trim().toLowerCase();
  const status = document.getElementById('company-status-filter').value;
  const companies = overviewData.companies.filter(company => {
    const matchesSearch = !search || `${company.name} ${company.code} ${company.ownerName || ''}`.toLowerCase().includes(search);
    return matchesSearch && (!status || company.status === status);
  });
  const empty = document.getElementById('empty-state');
  const table = document.getElementById('company-table-wrap');
  document.getElementById('company-total').textContent = `${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`;
  empty.classList.toggle('hidden', companies.length !== 0 || overviewData.companies.length === 0);
  table.classList.toggle('hidden', companies.length === 0);
  if (companies.length === 0) {
    empty.classList.remove('hidden');
    const hasFilters = Boolean(search || status);
    empty.querySelector('h3').textContent = hasFilters ? 'No matching companies' : 'No companies registered yet';
    empty.querySelector('p').textContent = hasFilters
      ? 'Adjust the search or status filter to see more companies.'
      : 'Your existing company appears here once its workspace is registered in the control database.';
  }
  renderCompanyRows(companies);
  return companies;
}

function renderCompanyRows(companies) {
  const rows = document.getElementById('company-rows');
  rows.innerHTML = companies.map(company => {
    const usageAvailable = company.userCount !== null;
    const storage = usageAvailable ? formatBytes(company.dbBytes + company.filesBytes) : '—';
    const userLimit = company.maxUsers === null ? 'unlimited' : company.maxUsers.toLocaleString();
    const storageLimit = company.storageLimitMb === null ? 'unlimited' : formatBytes(company.storageLimitMb * 1024 * 1024);
    return `<tr>
      <td><div class="company-name">${escapeHtml(company.name)}</div><div class="company-code">${escapeHtml(company.code)}</div></td>
      <td>${escapeHtml(company.planName || 'No plan')}</td>
      <td><span class="status status-${escapeHtml(company.status)}">${escapeHtml(company.status)}</span></td>
      <td>${usageAvailable ? `${escapeHtml(company.userCount.toLocaleString())} / ${escapeHtml(userLimit)}` : '—'}</td>
      <td>${escapeHtml(storage)} / ${escapeHtml(storageLimit)}</td>
      <td>${escapeHtml(formatDate(company.trialEndsAt))}</td>
      <td>${escapeHtml(formatDate(company.lastLoginAt))}</td>
      <td><button class="button button-quiet company-open" type="button" data-company-open="${company.id}" aria-label="Open ${escapeHtml(company.name)}">Manage</button></td>
    </tr>`;
  }).join('');
}

function renderPlanRows() {
  document.getElementById('plan-rows').innerHTML = planRecords.map(plan => `
    <article class="plan-row">
      <div><h3>${escapeHtml(plan.name)}${plan.isActive ? '' : ' <span class="status status-cancelled">Inactive</span>'}</h3>
        <p>${plan.maxUsers === null ? 'Unlimited users' : `${plan.maxUsers} users`} · ${plan.storageLimitMb === null ? 'Unlimited storage' : `${formatBytes(plan.storageLimitMb * 1024 * 1024)} storage`}</p>
        <p>${escapeHtml(plan.priceNote || 'No price note')}</p>
        <p class="plan-feature-list">${PLAN_FEATURE_NAMES.filter(name => plan.features[name]).map(escapeHtml).join(' · ') || 'No included features'}</p>
      </div>
      <button class="button button-quiet" type="button" data-plan-edit="${plan.id}">Edit</button>
    </article>`).join('');
}

const PLAN_FEATURE_NAMES = ['attendance', 'reimbursements', 'export'];

async function loadPlans() {
  const result = await request('plans');
  planRecords = result.plans;
  renderPlanRows();
}

function formatPaise(value, currency) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) return '—';
  const paise = BigInt(value);
  const whole = paise / 100n;
  const fraction = String(paise % 100n).padStart(2, '0');
  return `${currency} ${new Intl.NumberFormat('en-IN').format(Number(whole))}.${fraction}`;
}

function getPricingFormData() {
  const form = document.getElementById('pricing-form');
  const data = Object.fromEntries(new FormData(form));
  data.yearlyPriceOverride = '';
  data.taxInclusive = document.getElementById('pricing-tax-inclusive').checked;
  data.prorateSeats = document.getElementById('pricing-prorate').checked;
  return data;
}

function populatePricingForm(pricing) {
  const monthlyPaise = BigInt(pricing.monthlyPricePaise);
  const monthlyPrice = `${monthlyPaise / 100n}.${String(monthlyPaise % 100n).padStart(2, '0')}`;
  const values = {
    'pricing-monthly': monthlyPrice,
    'pricing-yearly-discount': pricing.yearlyDiscountPct,
    'pricing-tax': pricing.taxPct,
    'pricing-currency': pricing.currency,
    'pricing-symbol': pricing.currencySymbol,
    'pricing-trial-days': pricing.trialDays,
    'pricing-trial-users': pricing.trialMaxUsers,
    'pricing-trial-storage': pricing.trialStorageLimitMb,
    'pricing-grace-days': pricing.gracePeriodDays,
    'pricing-readonly-days': pricing.readOnlyPeriodDays,
    'pricing-min-seats': pricing.minSeats,
    'pricing-max-seats': pricing.maxSeats ?? '',
    'pricing-storage-per-seat': pricing.defaultStoragePerSeatMb ?? '',
    'pricing-seat-billing': pricing.seatAdditionBilling,
    'pricing-price-scope': pricing.priceChangeScope,
    'pricing-trial-approval': pricing.trialApprovalMode
  };
  for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
  document.getElementById('pricing-tax-inclusive').checked = pricing.taxInclusive;
  document.getElementById('pricing-prorate').checked = pricing.prorateSeats;
}

function renderPricingPreview(result) {
  const currency = document.getElementById('pricing-currency').value.trim().toUpperCase();
  document.getElementById('pricing-preview-results').innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Users</th><th>Monthly total</th><th>Yearly total</th></tr></thead>
      <tbody>${result.preview.map(row => `<tr>
        <td>${row.seats}</td>
        <td>${formatPaise(row.monthly.totalPaise, currency)}</td>
        <td>${formatPaise(row.yearly.totalPaise, currency)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  document.getElementById('pricing-affected-count').textContent =
    `${result.affectedExistingSubscriptions} active or past-due subscription(s) exist. Existing prices stay locked unless next-renewal pricing is selected.`;
}

async function previewPricing() {
  const errorTarget = document.getElementById('pricing-preview-error');
  errorTarget.classList.add('hidden');
  try {
    const result = await request('pricing/preview', {
      method: 'POST',
      body: JSON.stringify(getPricingFormData())
    });
    renderPricingPreview(result);
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.classList.remove('hidden');
  }
}

async function loadPricing() {
  const result = await request('pricing');
  populatePricingForm(result.pricing);
  renderPricingPreview({
    preview: result.preview,
    affectedExistingSubscriptions: result.affectedExistingSubscriptions
  });
}

function resetPlanForm() {
  document.getElementById('plan-form').reset();
  document.getElementById('plan-id').value = '';
  document.getElementById('plan-active').checked = true;
  document.getElementById('plan-form-heading').textContent = 'Create plan';
  document.getElementById('plan-cancel').classList.add('hidden');
}

function renderUsageHistory(history) {
  const canvas = document.getElementById('usage-history-chart');
  const empty = document.getElementById('usage-history-empty');
  empty.classList.toggle('hidden', history.length > 0);
  canvas.classList.toggle('hidden', history.length === 0);
  if (!history.length) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, canvas.clientWidth);
  const height = 180;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const padding = { top: 15, right: 16, bottom: 28, left: 16 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxUsers = Math.max(1, ...history.map(item => item.userCount));
  const maxStorage = Math.max(1, ...history.map(item => item.dbBytes + item.filesBytes));
  const drawLine = (values, maximum, color) => {
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 2;
    values.forEach((value, index) => {
      const x = padding.left + (history.length === 1 ? plotWidth / 2 : index * plotWidth / (history.length - 1));
      const y = padding.top + plotHeight - (value / maximum) * plotHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };
  drawLine(history.map(item => item.userCount), maxUsers, '#f4b942');
  drawLine(history.map(item => item.dbBytes + item.filesBytes), maxStorage, '#45d6c4');
  context.fillStyle = '#91a0b4';
  context.font = '11px Inter, sans-serif';
  const firstDate = new Date(history[0].takenAt).toLocaleDateString();
  const lastDate = new Date(history.at(-1).takenAt).toLocaleDateString();
  context.fillText(firstDate, padding.left, height - 7);
  context.textAlign = 'right';
  context.fillText(lastDate, width - padding.right, height - 7);
}

function renderLiveStorage(storage) {
  const target = document.getElementById('company-storage-usage');
  const usedBytes = Number(storage.usedBytes);
  const allocatedBytes = storage.allocatedBytes == null ? null : Number(storage.allocatedBytes);
  const percent = storage.percentUsed == null ? null : Number(storage.percentUsed);
  const tone = percent == null ? 'unlimited' : percent > 95 ? 'high' : percent >= 80 ? 'warning' : 'normal';
  const barWidth = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  target.innerHTML = `
    <div class="storage-usage-grid">
      <div><span>Allocated</span><strong>${allocatedBytes == null ? 'Unlimited' : `${formatBytes(allocatedBytes)} (${allocatedBytes.toLocaleString()} bytes)`}</strong></div>
      <div><span>Used</span><strong>${formatBytes(usedBytes)} (${usedBytes.toLocaleString()} bytes)</strong><small>${Number(storage.databaseBytes).toLocaleString()} B database · ${Number(storage.fileBytes).toLocaleString()} B files</small></div>
      <div><span>Remaining</span><strong>${storage.remainingBytes == null ? 'Unlimited' : `${formatBytes(Number(storage.remainingBytes))} (${Number(storage.remainingBytes).toLocaleString()} bytes)`}</strong></div>
      <div><span>Used</span><strong>${percent == null ? 'Unlimited' : `${percent.toFixed(1)}%`}</strong><small>Updated ${escapeHtml(formatDate(storage.updatedAt))}</small></div>
    </div>
    ${percent == null ? '<p class="storage-unlimited-note">This company has no storage limit.</p>' : `<div class="storage-progress ${tone}" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.max(0, percent))}"><span style="width:${barWidth}%"></span></div>`}`;
}

function renderCompanyStorage(detail) {
  const latest = detail.usageHistory.at(-1);
  const storageLimitBytes = detail.company.effectiveStorageLimitMb == null
    ? null : detail.company.effectiveStorageLimitMb * 1024 * 1024;
  if (!latest) {
    document.getElementById('company-storage-usage').innerHTML =
      '<p class="muted">No usage snapshot is available. Refresh now to measure live storage.</p>';
    return;
  }
  const usedBytes = latest.dbBytes + latest.filesBytes;
  renderLiveStorage({
    allocatedBytes: storageLimitBytes,
    databaseBytes: latest.dbBytes,
    fileBytes: latest.filesBytes,
    usedBytes,
    remainingBytes: storageLimitBytes == null ? null : Math.max(0, storageLimitBytes - usedBytes),
    percentUsed: storageLimitBytes == null ? null
      : storageLimitBytes === 0 ? (usedBytes === 0 ? 0 : 100)
        : Number(((usedBytes / storageLimitBytes) * 100).toFixed(1)),
    updatedAt: latest.takenAt
  });
}

async function refreshCompanyStorage(companyId) {
  const button = document.getElementById('storage-refresh');
  button.disabled = true;
  try {
    const result = await request(`companies/${encodeURIComponent(companyId)}/storage/refresh`, { method: 'POST' });
    renderLiveStorage(result);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
}

function renderCompanyRecords(detail) {
  document.getElementById('backup-list').innerHTML = detail.backups.length
    ? detail.backups.map(backup => `<div class="record-row"><div><strong>${escapeHtml(backup.kind || backup.type)} · ${escapeHtml(backup.key || '')}</strong><small>${escapeHtml(backup.location)} · ${escapeHtml(formatBytes(backup.sizeBytes))} · ${Object.keys(backup.rowCounts || {}).length} tables</small></div><span>${escapeHtml(formatDate(backup.createdAt))} · ${escapeHtml(backup.status)}</span><div class="record-actions">${backup.status === 'complete'
      ? `<a class="button button-quiet" href="/api/superadmin/companies/${detail.company.id}/backups/${backup.id}/download" download>Download</a><button class="button button-quiet" type="button" data-backup-restore="${backup.id}">Restore to new DB</button>`
      : ''}</div></div>`).join('')
    : '<p class="muted">No backups have been recorded.</p>';
  document.getElementById('restore-candidate-list').innerHTML = detail.restoreCandidates.length
    ? detail.restoreCandidates.map(candidate => {
      const totalRows = Object.values(candidate.rowCounts || {}).reduce((total, count) => total + Number(count || 0), 0);
      return `<div class="record-row"><div><strong>${escapeHtml(candidate.databaseName)} · ${escapeHtml(candidate.status)}</strong><small>Backup #${candidate.backupId} · ${Object.keys(candidate.rowCounts || {}).length} tables · ${totalRows.toLocaleString()} rows · staged ${escapeHtml(formatDate(candidate.createdAt))}${candidate.previousDatabaseName ? ` · previous DB ${escapeHtml(candidate.previousDatabaseName)}` : ''}</small></div>${candidate.status === 'ready'
        ? `<div class="record-actions"><button class="button button-primary" type="button" data-restore-activate="${candidate.id}">Switch company to this DB</button><button class="button button-quiet" type="button" data-restore-discard="${candidate.id}">Discard</button></div>`
        : candidate.status === 'activated' ? `<div class="record-actions"><button class="button button-quiet" type="button" data-restore-revert="${candidate.id}">Revert to previous DB</button></div>`
        : candidate.activatedAt ? `<span>Switched ${escapeHtml(formatDate(candidate.activatedAt))}</span>` : ''}</div>`;
    }).join('')
    : '<p class="muted">No restore candidates. Restores are created separately and do not replace the live database until activated.</p>';
  document.getElementById('restore-test-list').innerHTML = detail.restoreTests.length
    ? detail.restoreTests.map(item => `<div class="record-row"><div><strong>${escapeHtml(item.month)} restore test · ${escapeHtml(item.status)}</strong><small>${escapeHtml(item.details)}</small></div><span>${escapeHtml(formatDate(item.createdAt))}</span></div>`).join('')
    : '<p class="muted">No monthly restore tests recorded.</p>';
  document.getElementById('billing-list').innerHTML = detail.billingNotes.length
    ? detail.billingNotes.map(note => `<div class="record-row"><div><strong>${escapeHtml(note.amountText || 'Amount not specified')}</strong><small>${escapeHtml(note.note)}</small></div>${note.markedPaidAt
      ? `<span>Paid ${escapeHtml(formatDate(note.markedPaidAt))}</span>`
      : `<button class="button button-quiet" type="button" data-billing-paid="${note.id}">Mark as paid</button>`}</div>`).join('')
    : '<p class="muted">No billing notes recorded.</p>';
}

async function loadCompanyDetail(companyId) {
  document.getElementById('company-detail-error').classList.add('hidden');
  try {
    if (!planRecords.length) await loadPlans();
    const detail = await request(`companies/${encodeURIComponent(companyId)}`);
    activeCompanyDetail = detail;
    const company = detail.company;
    document.getElementById('company-detail-heading').textContent = company.name;
    document.getElementById('company-detail-meta').textContent =
      `${company.code} · ${company.ownerEmail || 'No owner email'} · Trial ends ${formatDate(company.trialEndsAt)} · Last login ${formatDate(company.lastLoginAt)} · Automatic deletion disabled`;
    const statusSelect = document.getElementById('detail-status');
    statusSelect.innerHTML = ['trial', 'active', 'suspended', 'cancelled'].map(status =>
      `<option value="${status}"${company.status === status ? ' selected' : ''}>${status[0].toUpperCase()}${status.slice(1)}</option>`).join('');
    const planSelect = document.getElementById('detail-plan');
    const selectablePlans = planRecords.filter(plan => plan.isActive || plan.id === company.planId);
    planSelect.innerHTML = `<option value="">No plan</option>${selectablePlans.map(plan =>
      `<option value="${plan.id}"${company.planId === plan.id ? ' selected' : ''}>${escapeHtml(plan.name)}</option>`).join('')}`;
    document.getElementById('detail-users-override').value = company.maxUsersOverride ?? '';
    document.getElementById('detail-storage-override').value = company.storageLimitMbOverride ?? '';
    document.getElementById('detail-notes').value = company.notes || '';
    renderUsageHistory(detail.usageHistory);
    renderCompanyStorage(detail);
    renderCompanyRecords(detail);
    showControlPage('detail');
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  }
}

async function loadOverview() {
  try {
    const data = await request('overview');
    overviewData = data;
    document.getElementById('admin-name').textContent = data.admin.name;
    renderSummary(data.summary);
    renderCompanies(data.companies, data.plans);
    overviewError.classList.add('hidden');
    showOverview();
    loadUserErrors();
  } catch (error) {
    if (error.status === 401) return showLogin();
    overviewError.textContent = error.message;
    overviewError.classList.remove('hidden');
    showOverview();
  }
}

document.querySelectorAll('[data-admin-page]').forEach(button => {
  button.addEventListener('click', async () => {
    if (button.dataset.adminPage === 'plans') {
      showControlPage('plans');
      try { await Promise.all([loadPlans(), loadPricing()]); } catch (error) {
        overviewError.textContent = error.message;
        overviewError.classList.remove('hidden');
      }
      return;
    }
    showControlPage('overview');
    document.getElementById('company-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
});

document.getElementById('company-search').addEventListener('input', getFilteredCompanies);
document.getElementById('company-status-filter').addEventListener('change', getFilteredCompanies);
document.getElementById('user-error-refresh').addEventListener('click', () => loadUserErrors());
document.getElementById('user-error-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-error-resolve]');
  if (!button) return;
  button.disabled = true;
  try {
    await request(`user-errors/${encodeURIComponent(button.dataset.errorResolve)}/resolve`, { method: 'POST' });
    await loadUserErrors();
  } catch (error) {
    const target = document.getElementById('user-error-load-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
    button.disabled = false;
  }
});

document.getElementById('company-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-company-open]');
  if (button) loadCompanyDetail(Number(button.dataset.companyOpen));
});

document.getElementById('company-detail-back').addEventListener('click', () => {
  showControlPage('overview');
  document.getElementById('company-search').focus();
});

document.getElementById('storage-refresh').addEventListener('click', () => {
  if (activeCompanyDetail) refreshCompanyStorage(activeCompanyDetail.company.id);
});

document.getElementById('plan-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-plan-edit]');
  if (!button) return;
  const plan = planRecords.find(item => item.id === Number(button.dataset.planEdit));
  if (!plan) return;
  document.getElementById('plan-id').value = plan.id;
  document.getElementById('plan-name').value = plan.name;
  document.getElementById('plan-users').value = plan.maxUsers ?? '';
  document.getElementById('plan-storage').value = plan.storageLimitMb ?? '';
  document.getElementById('plan-attendance').checked = plan.features.attendance === true;
  document.getElementById('plan-reimbursements').checked = plan.features.reimbursements === true;
  document.getElementById('plan-export').checked = plan.features.export === true;
  document.getElementById('plan-price-note').value = plan.priceNote || '';
  document.getElementById('plan-active').checked = plan.isActive;
  document.getElementById('plan-form-heading').textContent = `Edit ${plan.name}`;
  document.getElementById('plan-cancel').classList.remove('hidden');
  document.getElementById('plan-name').focus();
});

document.getElementById('plan-cancel').addEventListener('click', resetPlanForm);

document.getElementById('plan-form').addEventListener('submit', async event => {
  event.preventDefault();
  const planId = document.getElementById('plan-id').value;
  const body = {
    name: document.getElementById('plan-name').value,
    maxUsers: document.getElementById('plan-users').value || null,
    storageLimitMb: document.getElementById('plan-storage').value || null,
    features: {
      attendance: document.getElementById('plan-attendance').checked,
      reimbursements: document.getElementById('plan-reimbursements').checked,
      export: document.getElementById('plan-export').checked
    },
    priceNote: document.getElementById('plan-price-note').value,
    isActive: document.getElementById('plan-active').checked
  };
  const errorTarget = document.getElementById('plan-form-error');
  errorTarget.classList.add('hidden');
  try {
    await request(planId ? `plans/${encodeURIComponent(planId)}` : 'plans', {
      method: planId ? 'PUT' : 'POST', body: JSON.stringify(body)
    });
    resetPlanForm();
    await Promise.all([loadPlans(), loadOverview()]);
    showControlPage('plans');
    managementMessage.textContent = 'Plan saved.';
    managementMessage.classList.remove('hidden');
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.classList.remove('hidden');
  }
});

document.getElementById('pricing-preview-button').addEventListener('click', previewPricing);
document.getElementById('pricing-form').addEventListener('change', event => {
  if (event.target.id !== 'pricing-current-password') previewPricing();
});
document.getElementById('pricing-form').addEventListener('submit', async event => {
  event.preventDefault();
  const errorTarget = document.getElementById('pricing-form-error');
  const successTarget = document.getElementById('pricing-form-success');
  errorTarget.classList.add('hidden');
  successTarget.classList.add('hidden');
  try {
    await request('pricing', {
      method: 'POST',
      body: JSON.stringify(getPricingFormData())
    });
    document.getElementById('pricing-current-password').value = '';
    successTarget.textContent = 'A new pricing version has been saved.';
    successTarget.classList.remove('hidden');
    await loadPricing();
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.classList.remove('hidden');
  }
});

document.getElementById('company-detail-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeCompanyDetail) return;
  const company = activeCompanyDetail.company;
  const status = document.getElementById('detail-status').value;
  const confirmation = status === 'cancelled'
    ? `Cancel ${company.name}? Sign-in stops immediately; a final backup and permanent database/file deletion are scheduled after 30 days.`
    : `Change ${company.name} to ${status}?`;
  if (['suspended', 'cancelled'].includes(status) && status !== company.status && !window.confirm(confirmation)) return;
  const parseLimit = value => value === '' ? null : Number(value);
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await request(`companies/${company.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        status,
        planId: document.getElementById('detail-plan').value ? Number(document.getElementById('detail-plan').value) : null,
        maxUsersOverride: parseLimit(document.getElementById('detail-users-override').value),
        storageLimitMbOverride: parseLimit(document.getElementById('detail-storage-override').value),
        notes: document.getElementById('detail-notes').value
      })
    });
    managementMessage.textContent = 'Company settings saved.';
    managementMessage.classList.remove('hidden');
    await Promise.all([loadOverview(), loadCompanyDetail(company.id)]);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('company-reset-admin').addEventListener('click', async () => {
  if (!activeCompanyDetail || !window.confirm('Reset the company admin password? The current admin sessions will be signed out.')) return;
  const button = document.getElementById('company-reset-admin');
  button.disabled = true;
  try {
    const result = await request(`companies/${activeCompanyDetail.company.id}/reset-admin-password`, { method: 'POST' });
    const target = document.getElementById('company-one-time-password');
    target.innerHTML = `<strong>One-time admin login</strong><p>Username: <code>${escapeHtml(result.username)}</code></p><p>Password: <code>${escapeHtml(result.oneTimePassword)}</code></p><p>The administrator must change this password after signing in.</p><button class="button button-quiet" type="button" id="dismiss-reset-password">I have saved these details</button>`;
    target.classList.remove('hidden');
    document.getElementById('dismiss-reset-password').addEventListener('click', () => {
      target.replaceChildren();
      target.classList.add('hidden');
    }, { once: true });
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('company-support-mode').addEventListener('click', async event => {
  if (!activeCompanyDetail || !window.confirm(`Start a 30-minute support session for ${activeCompanyDetail.company.name}?`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request(`companies/${activeCompanyDetail.company.id}/support-mode`, { method: 'POST' });
    window.location.assign('/');
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
    button.disabled = false;
  }
});

document.getElementById('company-backup-now').addEventListener('click', async event => {
  if (!activeCompanyDetail || !window.confirm(`Create a backup for ${activeCompanyDetail.company.name}?`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request(`companies/${activeCompanyDetail.company.id}/backups`, { method: 'POST' });
    await loadCompanyDetail(activeCompanyDetail.company.id);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('backup-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-backup-restore]');
  if (!button || !activeCompanyDetail) return;
  const company = activeCompanyDetail.company;
  if (!window.confirm(`Create a restore candidate for ${company.name}? The live database will remain unchanged until you activate the candidate.`)) return;
  button.disabled = true;
  try {
    const staged = await request(`companies/${company.id}/backups/${button.dataset.backupRestore}/restore`, { method: 'POST' });
    managementMessage.textContent = `Restore candidate ${staged.databaseName} is ready. Review its table and row counts before switching.`;
    managementMessage.classList.remove('hidden');
    await loadCompanyDetail(company.id);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('restore-candidate-list').addEventListener('click', async event => {
  const activateButton = event.target.closest('[data-restore-activate]');
  const discardButton = event.target.closest('[data-restore-discard]');
  const revertButton = event.target.closest('[data-restore-revert]');
  if ((!activateButton && !discardButton && !revertButton) || !activeCompanyDetail) return;
  const button = activateButton || discardButton || revertButton;
  const company = activeCompanyDetail.company;
  const restoreId = button.dataset.restoreActivate || button.dataset.restoreDiscard || button.dataset.restoreRevert;
  const activate = Boolean(activateButton);
  const revert = Boolean(revertButton);
  const prompt = activate
    ? `Switch ${company.name} to this restored database? A fresh backup of the current database will be created first.`
    : revert
      ? `Revert ${company.name} to the database that was active before this restore? A fresh backup of the current database will be created first.`
      : 'Permanently delete this staged restore database?';
  if (!window.confirm(prompt)) return;
  button.disabled = true;
  try {
    await request(`companies/${company.id}/restores/${restoreId}${activate ? '/activate' : revert ? '/revert' : ''}`, {
      method: activate || revert ? 'POST' : 'DELETE'
    });
    managementMessage.textContent = activate ? 'Company now uses the restored database.' : revert ? 'Company reverted to the previous database.' : 'Staged restore database discarded.';
    managementMessage.classList.remove('hidden');
    await Promise.all([loadOverview(), loadCompanyDetail(company.id)]);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('billing-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeCompanyDetail) return;
  try {
    await request(`companies/${activeCompanyDetail.company.id}/billing`, {
      method: 'POST',
      body: JSON.stringify({
        amountText: document.getElementById('billing-amount').value,
        note: document.getElementById('billing-note').value
      })
    });
    event.currentTarget.reset();
    await loadCompanyDetail(activeCompanyDetail.company.id);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  }
});

document.getElementById('billing-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-billing-paid]');
  if (!button || !activeCompanyDetail) return;
  button.disabled = true;
  try {
    await request(`companies/${activeCompanyDetail.company.id}/billing/${button.dataset.billingPaid}/paid`, { method: 'POST' });
    await loadCompanyDetail(activeCompanyDetail.company.id);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  }
});

document.getElementById('company-rows').addEventListener('click', async event => {
  const button = event.target.closest('[data-company-save]');
  if (!button) return;
  const companyId = button.dataset.companySave;
  const statusSelect = document.querySelector(`[data-company-status="${companyId}"]`);
  const planSelect = document.querySelector(`[data-company-plan="${companyId}"]`);
  if (!statusSelect || !planSelect) return;
  if (['suspended', 'cancelled'].includes(statusSelect.value)
    && !window.confirm(`Change this company to ${statusSelect.value}? Company-code sign-in will be blocked.`)) return;

  button.disabled = true;
  overviewError.classList.add('hidden');
  managementMessage.classList.add('hidden');
  try {
    await request(`companies/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: statusSelect.value,
        planId: planSelect.value ? Number(planSelect.value) : null
      })
    });
    managementMessage.textContent = 'Company settings saved.';
    managementMessage.classList.remove('hidden');
    await loadOverview();
  } catch (error) {
    overviewError.textContent = error.message;
    overviewError.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

companyForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('create-company-button');
  const formData = new FormData(companyForm);
  button.disabled = true;
  companyFormError.classList.add('hidden');
  createdCompanyDetails.classList.add('hidden');
  managementMessage.classList.add('hidden');
  try {
    const result = await request('companies', {
      method: 'POST',
      body: JSON.stringify({
        name: formData.get('name'),
        code: formData.get('code'),
        ownerEmail: formData.get('ownerEmail'),
        adminName: formData.get('adminName'),
        adminUsername: formData.get('adminUsername'),
        planId: Number(formData.get('planId'))
      })
    });
    const fields = [
      ['Company', result.company.name],
      ['Company code', result.company.code],
      ['Company admin username', result.admin.username],
      ['One-time password', result.admin.oneTimePassword],
      ['Trial ends', result.company.trialEndsAt]
    ];
    createdCompanyDetails.innerHTML = `<h3>Company created — save these login details now</h3>
      <p>Share the credentials securely with the company admin. The password is shown only in this response.</p>
      ${fields.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> <code>${escapeHtml(value)}</code></p>`).join('')}
      <button class="button button-quiet" id="dismiss-created-details" type="button">I have saved these details</button>`;
    createdCompanyDetails.classList.remove('hidden');
    document.getElementById('dismiss-created-details').addEventListener('click', () => {
      createdCompanyDetails.replaceChildren();
      createdCompanyDetails.classList.add('hidden');
    }, { once: true });
    companyForm.reset();
    managementMessage.textContent = 'New company provisioned with its own database and 90-day trial.';
    managementMessage.classList.remove('hidden');
    await loadOverview();
  } catch (error) {
    companyFormError.textContent = error.message;
    companyFormError.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = loginForm.querySelector('button[type="submit"]');
  const formData = new FormData(loginForm);
  button.disabled = true;
  loginError.classList.add('hidden');
  try {
    await request('login', {
      method: 'POST',
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password')
      })
    });
    loginForm.reset();
    await loadOverview();
  } catch (error) {
    loginError.textContent = error.message;
    loginError.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await request('logout', { method: 'POST' });
    showLogin();
  } catch (error) {
    overviewError.textContent = error.message;
    overviewError.classList.remove('hidden');
  } finally {
    logoutButton.disabled = false;
  }
});

request('session')
  .then(() => loadOverview())
  .catch(error => {
    if (error.status === 401) return showLogin();
    showLogin(error.message);
  });
