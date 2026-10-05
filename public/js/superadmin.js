'use strict';

const loginView = document.getElementById('login-view');
const overviewView = document.getElementById('overview-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const overviewError = document.getElementById('overview-error');
const logoutButton = document.getElementById('logout-button');

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
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function renderSummary(summary) {
  const cards = [
    { label: 'Registered companies', value: summary.companyCount, caption: 'In the control database' },
    { label: 'Active companies', value: summary.activeCount, caption: `${summary.trialCount} currently in trial` },
    { label: 'Recorded users', value: summary.totalUsers.toLocaleString(), caption: 'Latest available snapshots' },
    { label: 'Recorded storage', value: formatBytes(summary.totalStorageBytes), caption: 'Database and uploaded files' }
  ];
  document.getElementById('summary-cards').innerHTML = cards.map(card => `
    <article class="summary-card">
      <div class="summary-label">${escapeHtml(card.label)}</div>
      <div class="summary-value">${escapeHtml(card.value)}</div>
      <div class="summary-caption">${escapeHtml(card.caption)}</div>
    </article>`).join('');
}

function renderCompanies(companies) {
  const emptyState = document.getElementById('empty-state');
  const table = document.getElementById('company-table-wrap');
  document.getElementById('company-total').textContent = `${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`;
  emptyState.classList.toggle('hidden', companies.length !== 0);
  table.classList.toggle('hidden', companies.length === 0);
  document.getElementById('company-rows').innerHTML = companies.map(company => {
    const usageAvailable = company.userCount !== null;
    const storage = usageAvailable ? formatBytes(company.dbBytes + company.filesBytes) : '—';
    return `<tr>
      <td><div class="company-name">${escapeHtml(company.name)}</div><div class="company-code">${escapeHtml(company.code)}</div></td>
      <td><span class="status status-${escapeHtml(company.status)}">${escapeHtml(company.status)}</span></td>
      <td>${escapeHtml(company.planName || '—')}</td>
      <td>${usageAvailable ? escapeHtml(company.userCount.toLocaleString()) : '—'}</td>
      <td>${escapeHtml(storage)}</td>
    </tr>`;
  }).join('');
}

async function loadOverview() {
  try {
    const data = await request('overview');
    document.getElementById('admin-name').textContent = data.admin.name;
    renderSummary(data.summary);
    renderCompanies(data.companies);
    overviewError.classList.add('hidden');
    showOverview();
  } catch (error) {
    if (error.status === 401) return showLogin();
    overviewError.textContent = error.message;
    overviewError.classList.remove('hidden');
    showOverview();
  }
}

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
        email: formData.get('email'),
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
