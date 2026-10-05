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
let demoRequests = [];
let livePricing = null;
let companyQuickFilter = 'all';
let companySort = { key: 'name', direction: 1 };

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
  const formatCurrencyAmounts = amounts => Object.keys(amounts || {}).sort()
    .map(currency => formatPaise(amounts[currency], currency)).join(' · ') || formatPaise(0, 'INR');
  const cards = [
    { label: 'Registered companies', value: summary.companyCount, caption: 'In the control database' },
    { label: 'Active companies', value: summary.activeCount, caption: 'Company workspaces' },
    { label: 'Trials', value: summary.trialCount, caption: `${summary.trialsEndingIn7DaysCount} ending in the next 7 days` },
    { label: 'Active paid', value: summary.activePaidCount, caption: `${summary.paidSeats.toLocaleString()} paid seats` },
    { label: 'Suspended', value: summary.suspendedCount, caption: 'Company workspaces' },
    { label: 'Cancelled', value: summary.cancelledCount, caption: 'Company workspaces' },
    { label: 'Estimated MRR', value: formatPaise(summary.monthlyRecurringRevenuePaise, 'INR'), caption: 'Active subscriptions · tax excluded' },
    { label: 'ARR', value: formatPaise(summary.annualRecurringRevenuePaise, 'INR'), caption: 'Monthly recurring revenue × 12' },
    { label: 'Trials ending soon', value: summary.trialsEndingIn7DaysCount, caption: 'Within the next 7 days' },
    { label: 'Open invoices', value: `${summary.openInvoiceCount} · ${formatCurrencyAmounts(summary.openInvoiceAmountsPaise)}`, caption: 'Not yet overdue · total due' },
    { label: 'Overdue invoices', value: `${summary.overdueInvoiceCount} · ${formatCurrencyAmounts(summary.overdueInvoiceAmountsPaise)}`, caption: 'Past due date · total due' },
    { label: 'New demo requests', value: summary.newDemoRequestCount, caption: 'Awaiting review' },
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
  const tabCount = document.getElementById('user-error-tab-count');
  tabCount.textContent = String(result.pendingCount);
  tabCount.classList.toggle('hidden', result.pendingCount < 1);
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
  planRecords = plans;
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
  const tabPage = page === 'detail' ? 'companies' : page;
  const pages = {
    overview: 'control-overview-page',
    companies: 'companies-page',
    requests: 'requests-page',
    plans: 'plans-page',
    billing: 'billing-page',
    activity: 'activity-page'
  };
  Object.entries(pages).forEach(([name, id]) => {
    document.getElementById(id).classList.toggle('hidden', name !== tabPage || page === 'detail');
  });
  document.getElementById('company-detail-page').classList.toggle('hidden', page !== 'detail');
  document.querySelectorAll('[data-admin-page]').forEach(button => {
    const selected = button.dataset.adminPage === tabPage;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}

function currentPageFromHash() {
  const page = window.location.hash.slice(1);
  return ['overview', 'companies', 'requests', 'plans', 'billing', 'activity'].includes(page)
    ? page
    : 'overview';
}

async function activateControlPage(page, { updateHash = true } = {}) {
  showControlPage(page);
  if (updateHash && window.location.hash !== `#${page}`) {
    window.history.pushState(null, '', `#${page}`);
  }
  try {
    if (page === 'plans') await Promise.all([loadPlans(), loadPricing()]);
    if (page === 'requests') await loadDemoRequests();
    if (page === 'activity') await loadUserErrors();
  } catch (error) {
    overviewError.textContent = error.message;
    overviewError.classList.remove('hidden');
  }
}

function getCompanyDisplayStatus(company) {
  if (company.subscriptionStatus === 'past_due' && !['suspended', 'cancelled'].includes(company.status)) return 'past_due';
  return company.status;
}

function getCompanyDate(value) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isCompanyEndingTrialSoon(company) {
  if (company.status !== 'trial') return false;
  const trialEnd = getCompanyDate(company.trialEndsAt);
  const now = Date.now();
  return trialEnd !== null && trialEnd >= now && trialEnd <= now + 7 * 24 * 60 * 60 * 1000;
}

function needsCompanyAttention(company) {
  if (getCompanyDisplayStatus(company) === 'past_due' || isCompanyEndingTrialSoon(company)) return true;
  if (company.maxUsers !== null && company.userCount !== null && company.userCount >= company.maxUsers) return true;
  if (company.storageLimitMb !== null && company.dbBytes !== null && company.filesBytes !== null) {
    const usedBytes = company.dbBytes + company.filesBytes;
    const limitBytes = company.storageLimitMb * 1024 * 1024;
    if (limitBytes >= 0 && usedBytes > limitBytes * 0.9) return true;
  }
  return false;
}

function compareCompanyValues(left, right, key, direction) {
  if (key === 'name') return String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base' }) * direction;
  if (key === 'status') return getCompanyDisplayStatus(left).localeCompare(getCompanyDisplayStatus(right)) * direction;
  const valueFor = company => {
    if (key === 'seats') return company.userCount;
    if (key === 'trialEnd') return getCompanyDate(company.trialEndsAt);
    return getCompanyDate(company.lastLoginAt);
  };
  const leftValue = valueFor(left);
  const rightValue = valueFor(right);
  if (leftValue == null) return rightValue == null ? 0 : 1;
  if (rightValue == null) return -1;
  return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * direction;
}

function getFilteredCompanies() {
  if (!overviewData) return [];
  const search = document.getElementById('company-search').value.trim().toLowerCase();
  const status = document.getElementById('company-status-filter').value;
  const companies = overviewData.companies.filter(company => {
    const matchesSearch = !search || `${company.name} ${company.code} ${company.ownerName || ''}`.toLowerCase().includes(search);
    return matchesSearch && (!status || getCompanyDisplayStatus(company) === status)
      && (companyQuickFilter !== 'attention' || needsCompanyAttention(company));
  }).sort((left, right) => {
    const compared = compareCompanyValues(left, right, companySort.key, companySort.direction);
    return compared || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  document.querySelectorAll('[data-sort-header]').forEach(header => {
    header.setAttribute('aria-sort', header.dataset.sortHeader === companySort.key
      ? (companySort.direction === 1 ? 'ascending' : 'descending') : 'none');
  });
  document.querySelectorAll('[data-company-quick-filter]').forEach(button => {
    const selected = button.dataset.companyQuickFilter === companyQuickFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  const empty = document.getElementById('empty-state');
  const table = document.getElementById('company-table-wrap');
  document.getElementById('company-total').textContent = `${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`;
  empty.classList.toggle('hidden', companies.length !== 0 || overviewData.companies.length === 0);
  table.classList.toggle('hidden', companies.length === 0);
  if (companies.length === 0) {
    empty.classList.remove('hidden');
    const hasFilters = Boolean(search || status || companyQuickFilter !== 'all');
    empty.querySelector('h3').textContent = hasFilters ? 'No matching companies' : 'No companies registered yet';
    empty.querySelector('p').textContent = hasFilters
      ? 'Adjust the search, status, or quick filter to see more companies.'
      : 'Your existing company appears here once its workspace is registered in the control database.';
  }
  renderCompanyRows(companies);
  return companies;
}

function renderSeatUsage(company) {
  if (company.userCount === null) {
    return `— / ${company.maxUsers === null ? 'Unlimited' : company.maxUsers.toLocaleString()}`;
  }
  if (company.maxUsers === null) return `${company.userCount.toLocaleString()} / Unlimited`;
  const percentage = company.maxUsers === 0 ? 100 : Math.min(100, Math.round(company.userCount / company.maxUsers * 100));
  const severity = percentage >= 100 ? 'danger' : percentage >= 90 ? 'warning' : '';
  const used = company.userCount.toLocaleString();
  const allowed = company.maxUsers.toLocaleString();
  return `<div class="seat-usage"><span>${escapeHtml(used)} / ${escapeHtml(allowed)}</span>
    <div class="seat-progress ${severity}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}" aria-label="${escapeHtml(used)} of ${escapeHtml(allowed)} seats used"><span style="width: ${percentage}%"></span></div></div>`;
}

function renderCompanyRows(companies) {
  const rows = document.getElementById('company-rows');
  rows.innerHTML = companies.map(company => {
    const usageAvailable = company.userCount !== null && company.dbBytes !== null && company.filesBytes !== null;
    const storage = usageAvailable ? formatBytes(company.dbBytes + company.filesBytes) : '—';
    const storageLimit = company.storageLimitMb === null ? 'unlimited' : formatBytes(company.storageLimitMb * 1024 * 1024);
    const status = getCompanyDisplayStatus(company);
    const statusLabel = status === 'past_due' ? 'Past due' : status;
    return `<tr>
      <td><div class="company-name">${escapeHtml(company.name)}</div><div class="company-code">${escapeHtml(company.code)}</div></td>
      <td>${escapeHtml(company.planName || 'No plan')}</td>
      <td><span class="status status-${escapeHtml(status.replace(/_/g, '-'))}">${escapeHtml(statusLabel)}</span></td>
      <td>${renderSeatUsage(company)}</td>
      <td>${escapeHtml(storage)} / ${escapeHtml(storageLimit)}</td>
      <td>${escapeHtml(company.billingCycle || '—')}</td>
      <td>${escapeHtml(company.renewsAt ? formatDate(company.renewsAt) : '—')}</td>
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

function parsePricePaise(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null;
}

function parseDiscountTenths(value) {
  const match = /^(\d{1,3})(?:\.(\d))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const tenths = Number(match[1]) * 10 + Number(match[2] || 0);
  return tenths <= 1000 ? tenths : null;
}

function formatPriceInput(paise) {
  const amount = BigInt(paise);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

function normalizeTierKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function defaultPricingTiers() {
  return [
    { key: 'team', name: 'Team', tagline: '', highlights: [], minSeats: 1, maxSeats: 10, monthlyPricePaise: 29900 },
    { key: 'enterprise', name: 'Enterprise', tagline: '', highlights: [], minSeats: 11, maxSeats: null, monthlyPricePaise: 19900 }
  ];
}

function collectPricingTiers() {
  return [...document.querySelectorAll('#pricing-tier-rows tr')].map((row, index) => ({
    key: normalizeTierKey(row.querySelector('[data-tier-name]').value) || `tier-${index + 1}`,
    name: row.querySelector('[data-tier-name]').value.trim(),
    minSeats: row.querySelector('[data-tier-min]').value,
    maxSeats: row.querySelector('[data-tier-max]').value,
    monthlyPrice: row.querySelector('[data-tier-monthly]').value.trim(),
    yearlyPriceOverride: row.querySelector('[data-tier-yearly-override]').value.trim(),
    tagline: row.querySelector('[data-tier-tagline]').value.trim(),
    highlights: row.querySelector('[data-tier-highlights]').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
  }));
}

function validatePricingTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 5) return 'Pricing needs between 1 and 5 tiers.';
  const keys = new Set();
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    const minSeats = Number(tier.minSeats);
    const maxSeats = tier.maxSeats === '' ? null : Number(tier.maxSeats);
    const monthlyPricePaise = parsePricePaise(tier.monthlyPrice);
    const name = tier.name.trim();
    if (!name || name.length > 60 || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(tier.key)
      || keys.has(tier.key) || tier.tagline.length > 160
      || !Number.isSafeInteger(minSeats) || minSeats < 1
      || (index === 0 ? minSeats !== 1 : minSeats !== Number(tiers[index - 1].maxSeats) + 1)
      || (index < tiers.length - 1
        ? !Number.isSafeInteger(maxSeats) || maxSeats < minSeats
        : maxSeats !== null)
      || monthlyPricePaise === null) {
      return 'Check tier names, prices, and contiguous seat ranges. The first tier must start at 1 and the last tier must be unlimited.';
    }
    if (tier.yearlyPriceOverride && parsePricePaise(tier.yearlyPriceOverride) === null) {
      return `Enter a valid yearly override for the ${name} tier, or leave it blank.`;
    }
    if (tier.highlights.length > 8 || tier.highlights.some(item => item.length > 90 || /<\/?[a-z][^>]*>/i.test(item))) {
      return `The ${name} tier can have up to 8 plain-text highlights, each no longer than 90 characters.`;
    }
    keys.add(tier.key);
  }
  return null;
}

function calculateTierYearlyPaise(tier, discountTenths, { useOverride = true } = {}) {
  const monthly = parsePricePaise(tier.monthlyPrice);
  if (monthly === null) return null;
  if (useOverride && tier.yearlyPriceOverride) return parsePricePaise(tier.yearlyPriceOverride);
  if (discountTenths === null) return null;
  const annual = BigInt(monthly) * 12n * BigInt(1000 - discountTenths);
  const yearly = (annual * 2n + 1000n) / 2000n;
  return yearly <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(yearly) : null;
}

function createTierRow(tier = {}, index = 0, count = 1) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input data-tier-name maxlength="60" required aria-label="Tier ${index + 1} name" value="${escapeHtml(tier.name || '')}"></td>
    <td><input data-tier-min type="number" min="1" step="1" readonly aria-label="Tier ${index + 1} starts at seat" value="${index === 0 ? 1 : escapeHtml(tier.minSeats || '')}"></td>
    <td><input data-tier-max type="number" min="1" step="1" aria-label="Tier ${index + 1} ends at seat; blank means unlimited" value="${tier.maxSeats == null ? '' : escapeHtml(tier.maxSeats)}"></td>
    <td><input data-tier-monthly inputmode="decimal" required aria-label="Tier ${index + 1} monthly price per seat" value="${tier.monthlyPricePaise == null ? escapeHtml(tier.monthlyPrice || '') : formatPriceInput(tier.monthlyPricePaise)}"></td>
    <td><input data-tier-yearly-computed readonly aria-label="Tier ${index + 1} computed yearly price per seat"></td>
    <td><input data-tier-yearly-override inputmode="decimal" aria-label="Tier ${index + 1} optional yearly price override" value="${escapeHtml(tier.yearlyPriceOverride || '')}"></td>
    <td><input data-tier-tagline maxlength="160" aria-label="Tier ${index + 1} tagline" value="${escapeHtml(tier.tagline || '')}"></td>
    <td><textarea data-tier-highlights rows="3" aria-label="Tier ${index + 1} highlights, one per line">${escapeHtml((tier.highlights || []).join('\n'))}</textarea></td>
    <td><button class="button button-quiet tier-remove-button" type="button" aria-label="Remove tier ${index + 1}" ${count <= 1 ? 'disabled' : ''}>Remove</button></td>`;
  return row;
}

function renderTierRows(tiers) {
  const tbody = document.getElementById('pricing-tier-rows');
  tbody.replaceChildren(...tiers.map((tier, index) => createTierRow(tier, index, tiers.length)));
  updateTierDerivedFields();
  updateLandingPricingPreview();
}

function updateTierDerivedFields() {
  const rows = [...document.querySelectorAll('#pricing-tier-rows tr')];
  rows.forEach((row, index) => {
    const minInput = row.querySelector('[data-tier-min]');
    if (index === 0) minInput.value = '1';
    else {
      const previousMax = rows[index - 1].querySelector('[data-tier-max]').value;
      const parsedPreviousMax = Number(previousMax);
      minInput.value = previousMax && Number.isSafeInteger(parsedPreviousMax)
        && parsedPreviousMax < Number.MAX_SAFE_INTEGER
        ? String(parsedPreviousMax + 1)
        : '';
    }
    const yearly = calculateTierYearlyPaise({
      monthlyPrice: row.querySelector('[data-tier-monthly]').value,
      yearlyPriceOverride: row.querySelector('[data-tier-yearly-override]').value
    }, parseDiscountTenths(document.getElementById('pricing-yearly-discount').value), { useOverride: false });
    row.querySelector('[data-tier-yearly-computed]').value = yearly === null
      ? ''
      : formatPriceInput(yearly);
    row.querySelector('.tier-remove-button').disabled = rows.length <= 1;
  });
}

function getPricingFormData({ includePassword = false } = {}) {
  const form = document.getElementById('pricing-form');
  const data = Object.fromEntries(new FormData(form));
  if (!includePassword) delete data.currentPassword;
  data.tiers = collectPricingTiers();
  data.taxInclusive = document.getElementById('pricing-tax-inclusive').checked;
  data.prorateSeats = document.getElementById('pricing-prorate').checked;
  return data;
}

function populatePricingForm(pricing) {
  const isBackfilledStandard = pricing.tiers?.length === 1 && pricing.tiers[0].key === 'standard';
  const useDefaults = !pricing.tiers?.length || isBackfilledStandard;
  const tiers = useDefaults ? defaultPricingTiers() : pricing.tiers.map(tier => {
    const expectedYearly = calculateTierYearlyPaise({
      monthlyPrice: formatPriceInput(tier.monthlyPricePaise)
    }, parseDiscountTenths(String(pricing.yearlyDiscountPct)));
    return {
      ...tier,
      yearlyPriceOverride: expectedYearly === tier.yearlyPricePaise ? '' : formatPriceInput(tier.yearlyPricePaise)
    };
  });
  const values = {
    'pricing-yearly-discount': useDefaults ? 10 : pricing.yearlyDiscountPct,
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
  renderTierRows(tiers);
}

function renderPricingPreview(result) {
  const currency = document.getElementById('pricing-currency').value.trim().toUpperCase();
  const warnings = result.warnings || [];
  document.getElementById('pricing-tax-preview-note').textContent = result.taxInclusive
    ? 'GST is included in each total.'
    : 'GST is added to each subtotal.';
  document.getElementById('pricing-preview-results').innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Seats</th><th>Tier</th><th>Monthly / seat</th><th>Monthly subtotal</th><th>GST</th><th>Monthly total</th><th>Yearly / seat</th><th>Yearly subtotal</th><th>GST</th><th>Yearly total</th></tr></thead>
      <tbody>${result.preview.map(row => `<tr>
        <td>${row.seats}</td>
        <td>${escapeHtml(row.monthly.tierName)}</td>
        <td>${formatPaise(row.monthly.unitPricePaise, currency)}</td>
        <td>${formatPaise(row.monthly.subtotalPaise, currency)}</td>
        <td>${formatPaise(row.monthly.taxPaise, currency)}</td>
        <td>${formatPaise(row.monthly.totalPaise, currency)}</td>
        <td>${formatPaise(row.yearly.unitPricePaise, currency)}</td>
        <td>${formatPaise(row.yearly.subtotalPaise, currency)}</td>
        <td>${formatPaise(row.yearly.taxPaise, currency)}</td>
        <td>${formatPaise(row.yearly.totalPaise, currency)}</td>
      </tr>`).join('')}
      ${warnings.map(warning => `<tr class="pricing-warning-row"><td colspan="10">${escapeHtml(warning.cycle)}: ${warning.higherSeats} seats cost ${formatPaise(warning.higherTotalPaise, currency)}, less than ${warning.lowerSeats} seats at ${formatPaise(warning.lowerTotalPaise, currency)}. This is valid volume pricing.</td></tr>`).join('')}
      </tbody>
    </table></div>`;
  document.getElementById('pricing-affected-count').textContent =
    `${result.affectedExistingSubscriptions} active or past-due subscription(s) keep their locked price unless next-renewal pricing is selected.`;
}

function updateLandingPricingPreview() {
  const target = document.getElementById('pricing-live-preview');
  if (!target) return;
  const currency = document.getElementById('pricing-symbol').value.trim() || 'Rs.';
  const discountTenths = parseDiscountTenths(document.getElementById('pricing-yearly-discount').value);
  const tiers = collectPricingTiers();
  const taxPct = document.getElementById('pricing-tax').value.trim();
  const taxText = document.getElementById('pricing-tax-inclusive').checked
    ? `Prices include ${escapeHtml(taxPct)}% GST`
    : `+ ${escapeHtml(taxPct)}% GST`;
  target.innerHTML = `<div class="landing-preview-cards">${tiers.map((tier, index) => {
    const yearlyPaise = calculateTierYearlyPaise(tier, discountTenths);
    const monthlyPaise = parsePricePaise(tier.monthlyPrice);
    const yearlyMonthlyPaise = yearlyPaise === null ? null : Number((BigInt(yearlyPaise) * 2n + 12n) / 24n);
    const range = `${escapeHtml(tier.minSeats || (index === 0 ? 1 : '—'))}${tier.maxSeats ? `–${escapeHtml(tier.maxSeats)}` : '+'} seats`;
    const highlights = tier.highlights.length
      ? `<ul>${tier.highlights.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="muted">No highlights configured.</p>';
    return `<article class="landing-preview-card">
      ${index === 1 ? '<span class="preview-plan-badge">Best value for growing teams</span>' : ''}
      <h5>${escapeHtml(tier.name || `Tier ${index + 1}`)}</h5>
      <p>${range}</p>
      ${tier.tagline ? `<p>${escapeHtml(tier.tagline)}</p>` : ''}
      <strong>${monthlyPaise === null ? '—' : formatPaise(monthlyPaise, currency)} <small>/ seat / month</small></strong>
      <span>${yearlyMonthlyPaise === null ? 'Yearly price unavailable' : `${formatPaise(yearlyMonthlyPaise, currency)} / seat / month billed yearly`}</span>
      <small>${taxText}</small>${highlights}</article>`;
  }).join('')}</div>`;
}

async function previewPricing() {
  const errorTarget = document.getElementById('pricing-preview-error');
  errorTarget.classList.add('hidden');
  try {
    const body = getPricingFormData();
    const tierError = validatePricingTiers(body.tiers);
    if (tierError) throw new Error(tierError);
    const result = await request('pricing/preview', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    renderPricingPreview(result);
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.classList.remove('hidden');
  }
}

async function loadPricing() {
  const result = await request('pricing');
  livePricing = result.pricing;
  populatePricingForm(result.pricing);
  renderPricingPreview({
    preview: result.preview,
    warnings: result.warnings,
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
  document.getElementById('billing-request-list').innerHTML = detail.billingRequests.length
    ? detail.billingRequests.map(item => `<div class="record-row"><div><strong>${Number(item.seats)} seats · ${escapeHtml(item.billingCycle)}</strong><small>Request #${item.id} · submitted ${escapeHtml(formatDate(item.createdAt))}${item.invoiceId ? ` · invoice #${item.invoiceId}` : ''}</small></div><span>${escapeHtml(item.status)}</span>${item.status === 'pending'
      ? `<div class="record-actions"><button class="button button-primary" type="button" data-request-invoice="${item.id}">Issue invoice</button><button class="button button-quiet" type="button" data-request-reject="${item.id}">Reject</button></div>`
      : ''}</div>`).join('')
    : '<p class="muted">No billing change requests recorded.</p>';
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

function roundHalfUp(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function getDemoRequestPricingSuggestion(item) {
  if (!livePricing || !Array.isArray(livePricing.tiers) || !livePricing.tiers.length) return null;
  const teamSize = Number(item.teamSize);
  if (!Number.isSafeInteger(teamSize) || teamSize < 1) return null;
  const expectedTierName = teamSize <= 10 ? 'team' : 'enterprise';
  const coversTeamSize = tier => teamSize >= tier.minSeats && (tier.maxSeats === null || teamSize <= tier.maxSeats);
  const tier = livePricing.tiers.find(candidate => candidate.name.trim().toLowerCase() === expectedTierName && coversTeamSize(candidate))
    || livePricing.tiers.find(coversTeamSize);
  if (!tier || !Number.isSafeInteger(tier.monthlyPricePaise) || tier.monthlyPricePaise < 0) return null;
  const subtotal = BigInt(tier.monthlyPricePaise) * BigInt(teamSize);
  const taxTenths = BigInt(Math.round(Number(livePricing.taxPct) * 10));
  const taxDenominator = livePricing.taxInclusive ? 1000n + taxTenths : 1000n;
  const tax = roundHalfUp(subtotal * taxTenths, taxDenominator);
  const total = livePricing.taxInclusive ? subtotal : subtotal + tax;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    tier,
    teamSize,
    monthlyTotalPaise: Number(total),
    currency: livePricing.currency,
    taxInclusive: livePricing.taxInclusive
  };
}

function renderDemoRequests() {
  const newCount = demoRequests.filter(item => item.status === 'new').length;
  document.getElementById('demo-request-count').textContent = `${newCount} new`;
  const tabCount = document.getElementById('demo-request-tab-count');
  tabCount.textContent = String(newCount);
  tabCount.classList.toggle('hidden', newCount < 1);
  document.getElementById('demo-request-list').innerHTML = demoRequests.length
    ? demoRequests.map(item => {
      const suggestion = getDemoRequestPricingSuggestion(item);
      const suggestionText = suggestion
        ? `<small>Estimated monthly total at ${suggestion.teamSize} seats: ${formatPaise(suggestion.monthlyTotalPaise, suggestion.currency)} (${suggestion.taxInclusive ? 'GST included' : 'GST added'}).</small>`
        : '<small>Live pricing estimate unavailable; check Plans &amp; Pricing before quoting.</small>';
      return `<article class="record-row"><div>
        <strong>${escapeHtml(item.companyName)} · ${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.email)}${item.phone ? ` · ${escapeHtml(item.phone)}` : ''} · team ${Number(item.teamSize)}</small>
        <small><strong>SUGGESTED PLAN: ${escapeHtml(suggestion?.tier.name || 'Unavailable')}</strong></small>
        ${suggestionText}
        ${item.message ? `<small>${escapeHtml(item.message)}</small>` : ''}
        <small>Request #${item.id} · ${escapeHtml(formatDate(item.createdAt))} · ${escapeHtml(item.status)}</small>
      </div><div class="record-actions">${item.status === 'new'
        ? `<button class="button button-primary" type="button" data-demo-approve="${item.id}">Approve</button><button class="button button-quiet" type="button" data-demo-reject="${item.id}">Reject</button>`
        : `<button class="button button-primary" type="button" data-demo-provision="${item.id}">Create trial</button>`}</div></article>`;
    }).join('')
    : '<p class="muted">No demo requests are awaiting action.</p>';
}

async function loadDemoRequests() {
  const errorTarget = document.getElementById('demo-request-load-error');
  errorTarget.classList.add('hidden');
  const pricingLoad = livePricing
    ? Promise.resolve(null)
    : loadPricing().then(() => null).catch(error => error);
  try {
    const [result, pricingError] = await Promise.all([request('demo-requests'), pricingLoad]);
    demoRequests = result.requests || [];
    renderDemoRequests();
    if (pricingError) {
      errorTarget.textContent = `Live pricing could not be loaded, so request estimates are unavailable. ${pricingError.message}`;
      errorTarget.classList.remove('hidden');
    }
  } catch (error) {
    await pricingLoad;
    errorTarget.textContent = error.message;
    errorTarget.classList.remove('hidden');
  }
}

function prefillDemoRequest(item) {
  const code = item.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 61) || `trial-${item.id}`;
  let username = (item.email.split('@')[0] || 'admin').replace(/[^a-z0-9._-]/g, '-').slice(0, 64);
  if (!/^[a-z0-9]/.test(username)) username = `admin-${username}`.slice(0, 64);
  document.getElementById('new-company-name').value = item.companyName;
  document.getElementById('new-company-code').value = code;
  document.getElementById('new-company-email').value = item.email;
  document.getElementById('new-admin-name').value = item.name;
  document.getElementById('new-admin-username').value = username;
  document.getElementById('demo-request-id').value = String(item.id);
  const trialPlan = planRecords.find(plan => plan.name.toLowerCase() === 'trial');
  if (trialPlan) document.getElementById('new-company-plan').value = String(trialPlan.id);
  const suggestion = getDemoRequestPricingSuggestion(item);
  const suggestionTarget = document.getElementById('company-pricing-suggestion');
  suggestionTarget.textContent = suggestion
    ? `Suggested pricing tier: ${suggestion.tier.name} for ${suggestion.teamSize} seats; estimated monthly total ${formatPaise(suggestion.monthlyTotalPaise, suggestion.currency)} (${suggestion.taxInclusive ? 'GST included' : 'GST added'}). The Trial entitlement remains selected; pricing and feature access are separate.`
    : 'Live pricing suggestion unavailable. The Trial entitlement remains selected; check Plans & Pricing before quoting.';
  suggestionTarget.classList.remove('hidden');
  activateControlPage('companies');
  document.getElementById('company-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
  document.getElementById('new-company-code').focus();
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
    if (!['overview', 'companies', 'requests', 'plans', 'billing', 'activity'].includes(window.location.hash.slice(1))) {
      window.history.replaceState(null, '', '#overview');
    }
    const initialPage = currentPageFromHash();
    showControlPage(initialPage);
    if (initialPage === 'plans') activateControlPage('plans', { updateHash: false });
    loadUserErrors();
    loadDemoRequests();
  } catch (error) {
    if (error.status === 401) return showLogin();
    overviewError.textContent = error.message;
    overviewError.classList.remove('hidden');
    showOverview();
  }
}

document.querySelectorAll('[data-admin-page]').forEach(button => {
  button.addEventListener('click', () => {
    activateControlPage(button.dataset.adminPage);
  });
  button.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-admin-page]')];
    const index = tabs.indexOf(button);
    const nextIndex = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    tabs[nextIndex].focus();
    activateControlPage(tabs[nextIndex].dataset.adminPage);
  });
});

window.addEventListener('hashchange', () => {
  const page = currentPageFromHash();
  if (window.location.hash !== `#${page}`) window.history.replaceState(null, '', `#${page}`);
  activateControlPage(page, { updateHash: false });
});

document.getElementById('company-search').addEventListener('input', getFilteredCompanies);
document.getElementById('company-status-filter').addEventListener('change', getFilteredCompanies);
document.getElementById('company-quick-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-company-quick-filter]');
  if (!button) return;
  companyQuickFilter = button.dataset.companyQuickFilter;
  getFilteredCompanies();
});
document.getElementById('company-table-wrap').addEventListener('click', event => {
  const button = event.target.closest('[data-company-sort]');
  if (!button) return;
  const key = button.dataset.companySort;
  companySort = {
    key,
    direction: companySort.key === key ? -companySort.direction : 1
  };
  getFilteredCompanies();
});
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

document.getElementById('demo-request-refresh').addEventListener('click', loadDemoRequests);
document.getElementById('demo-request-list').addEventListener('click', async event => {
  const approveButton = event.target.closest('[data-demo-approve]');
  const rejectButton = event.target.closest('[data-demo-reject]');
  const provisionButton = event.target.closest('[data-demo-provision]');
  const button = approveButton || rejectButton || provisionButton;
  if (!button) return;
  const item = demoRequests.find(requestItem => requestItem.id === Number(button.dataset.demoApprove
    || button.dataset.demoReject || button.dataset.demoProvision));
  if (!item) return;
  if (provisionButton) return prefillDemoRequest(item);
  if (rejectButton && !window.confirm(`Reject the demo request from ${item.companyName}?`)) return;
  button.disabled = true;
  try {
    await request(`demo-requests/${item.id}/${approveButton ? 'approve' : 'reject'}`, { method: 'POST' });
    if (approveButton) {
      item.status = 'approved';
      renderDemoRequests();
      prefillDemoRequest(item);
    } else {
      await loadDemoRequests();
    }
  } catch (error) {
    const target = document.getElementById('demo-request-load-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('company-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-company-open]');
  if (button) loadCompanyDetail(Number(button.dataset.companyOpen));
});

document.getElementById('company-detail-back').addEventListener('click', () => {
  showControlPage('companies');
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
document.getElementById('pricing-add-tier').addEventListener('click', () => {
  const tierError = document.getElementById('pricing-tier-error');
  const tiers = collectPricingTiers();
  if (tiers.length >= 5) {
    tierError.textContent = 'Pricing supports up to 5 tiers.';
    tierError.classList.remove('hidden');
    return;
  }
  const lastMax = tiers.at(-1)?.maxSeats;
  if (!lastMax || !Number.isSafeInteger(Number(lastMax)) || Number(lastMax) >= Number.MAX_SAFE_INTEGER) {
    tierError.textContent = 'Set a “To seats” limit for the current final tier before adding another tier.';
    tierError.classList.remove('hidden');
    return;
  }
  tiers.push({ name: '', tagline: '', highlights: [], minSeats: Number(lastMax) + 1, maxSeats: null });
  tierError.classList.add('hidden');
  renderTierRows(tiers);
  document.querySelector('#pricing-tier-rows tr:last-child [data-tier-name]')?.focus();
});
document.getElementById('pricing-tier-rows').addEventListener('click', event => {
  const button = event.target.closest('.tier-remove-button');
  if (!button) return;
  const rows = collectPricingTiers();
  const index = [...document.querySelectorAll('#pricing-tier-rows tr')].indexOf(button.closest('tr'));
  if (index < 0 || rows.length <= 1) return;
  rows.splice(index, 1);
  if (index === rows.length) rows.at(-1).maxSeats = null;
  document.getElementById('pricing-tier-error').classList.add('hidden');
  renderTierRows(rows);
});
document.getElementById('pricing-tier-rows').addEventListener('input', () => {
  updateTierDerivedFields();
  updateLandingPricingPreview();
  const error = validatePricingTiers(collectPricingTiers());
  const errorTarget = document.getElementById('pricing-tier-error');
  errorTarget.textContent = error || '';
  errorTarget.classList.toggle('hidden', !error);
});
document.getElementById('pricing-form').addEventListener('input', event => {
  if (event.target.matches('#pricing-yearly-discount, #pricing-tax, #pricing-symbol')) {
    updateTierDerivedFields();
    updateLandingPricingPreview();
  }
});
document.getElementById('pricing-form').addEventListener('change', event => {
  if (event.target.id !== 'pricing-current-password') {
    updateLandingPricingPreview();
    previewPricing();
  }
});
document.getElementById('pricing-form').addEventListener('submit', async event => {
  event.preventDefault();
  const errorTarget = document.getElementById('pricing-form-error');
  const successTarget = document.getElementById('pricing-form-success');
  errorTarget.classList.add('hidden');
  successTarget.classList.add('hidden');
  try {
    const body = getPricingFormData({ includePassword: true });
    const tierError = validatePricingTiers(body.tiers);
    if (tierError) throw new Error(tierError);
    await request('pricing', {
      method: 'POST',
      body: JSON.stringify(body)
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
    window.location.assign('/app');
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

document.getElementById('billing-request-list').addEventListener('click', async event => {
  const invoiceButton = event.target.closest('[data-request-invoice]');
  const rejectButton = event.target.closest('[data-request-reject]');
  const button = invoiceButton || rejectButton;
  if (!button || !activeCompanyDetail) return;
  const companyId = activeCompanyDetail.company.id;
  const requestId = button.dataset.requestInvoice || button.dataset.requestReject;
  const action = invoiceButton ? 'invoice' : 'reject';
  if (invoiceButton && !window.confirm('Issue an open invoice using this company’s locked subscription price? No payment will be taken automatically.')) return;
  button.disabled = true;
  try {
    await request(`companies/${companyId}/billing-requests/${requestId}/${action}`, { method: 'POST' });
    await loadCompanyDetail(companyId);
  } catch (error) {
    const target = document.getElementById('company-detail-error');
    target.textContent = error.message;
    target.classList.remove('hidden');
  } finally {
    button.disabled = false;
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
        planId: Number(formData.get('planId')),
        ...(document.getElementById('demo-request-id').value
          ? { demoRequestId: Number(document.getElementById('demo-request-id').value) } : {})
      })
    });
    const fields = [
      ['Company', result.company.name],
      ['Company code', result.company.code],
      ['Administrator', result.admin.name],
      ['Administrator email', result.admin.email],
      ['Trial ends', result.company.trialEndsAt]
    ];
    createdCompanyDetails.innerHTML = `<h3>Company created — invitation sent</h3>
      <p>An invitation has been sent to the administrator email. They must verify it, then sign in using an email code or Google.</p>
      ${fields.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> <code>${escapeHtml(value)}</code></p>`).join('')}
      <button class="button button-quiet" id="dismiss-created-details" type="button">I have saved these details</button>`;
    createdCompanyDetails.classList.remove('hidden');
    document.getElementById('dismiss-created-details').addEventListener('click', () => {
      createdCompanyDetails.replaceChildren();
      createdCompanyDetails.classList.add('hidden');
    }, { once: true });
    companyForm.reset();
    document.getElementById('demo-request-id').value = '';
    document.getElementById('company-pricing-suggestion').replaceChildren();
    document.getElementById('company-pricing-suggestion').classList.add('hidden');
    managementMessage.textContent = `New company provisioned with its own database and a trial through ${formatDate(result.company.trialEndsAt)}.`;
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
