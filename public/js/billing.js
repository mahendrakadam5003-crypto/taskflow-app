'use strict';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString([], { dateStyle: 'medium' });
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return '—';
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  const paise = BigInt(value);
  const rupees = paise / 100n;
  const fraction = String(paise % 100n).padStart(2, '0');
  return `${currency} ${new Intl.NumberFormat('en-IN').format(Number(rupees))}.${fraction}`;
}

function renderBilling(data) {
  const usage = data.usage?.usage || {};
  const plan = data.usage?.plan || {};
  const subscription = data.subscription;
  document.getElementById('company-name').textContent = `${data.company.name} · ${data.company.code}`;
  document.getElementById('company-status').textContent = data.company.status;
  document.getElementById('trial-date').textContent = data.company.trialEndsAt
    ? `Trial ends ${formatDate(data.company.trialEndsAt)}` : '';
  document.getElementById('plan-name').textContent = plan.name || 'No plan assigned';
  document.getElementById('subscription-detail').textContent = subscription
    ? `${subscription.billing_cycle} · ${subscription.status} · renews ${formatDate(subscription.current_period_end)}`
    : 'No paid subscription';
  const allowedSeats = subscription?.seats ?? plan.maxUsers;
  document.getElementById('seat-usage').textContent =
    `${Number(usage.activeUsers || 0)} / ${allowedSeats == null ? 'Unlimited' : Number(allowedSeats)}`;
  const limitBytes = plan.storageLimitBytes;
  const storageBytes = Number(usage.storageBytes || 0);
  const remainingBytes = limitBytes == null ? null : Math.max(0, Number(limitBytes) - storageBytes);
  document.getElementById('storage-usage').textContent = `${formatBytes(storageBytes)} used`;
  document.getElementById('storage-detail').textContent = limitBytes == null
    ? `${storageBytes.toLocaleString()} B used · Unlimited allocation · ${Number(usage.databaseBytes || 0).toLocaleString()} B database · ${Number(usage.fileBytes || 0).toLocaleString()} B files`
    : `${storageBytes.toLocaleString()} B used · ${Number(limitBytes).toLocaleString()} B allocated · ${remainingBytes.toLocaleString()} B remaining · ${Number(usage.databaseBytes || 0).toLocaleString()} B database · ${Number(usage.fileBytes || 0).toLocaleString()} B files`;
  document.getElementById('trial-notice').classList.toggle('hidden', data.company.status !== 'trial');
  const monthly = formatMoney(data.pricing.monthlyPricePaise, data.pricing.currency);
  const yearly = formatMoney(data.pricing.yearlyPricePaise, data.pricing.currency);
  const taxLabel = data.pricing.taxInclusive
    ? `tax-inclusive at ${data.pricing.taxPct}%`
    : `plus ${data.pricing.taxPct}% applicable tax`;
  document.getElementById('price-summary').textContent =
    `${monthly} per seat monthly, or ${yearly} per seat yearly (${data.pricing.yearlyDiscountPct}% discount), ${taxLabel}.`;
  document.getElementById('billing-updated').textContent = `Live usage refreshed ${new Date().toLocaleString()}.`;
  const rows = document.getElementById('invoice-rows');
  rows.innerHTML = data.invoices.map(invoice => `<tr>
    <td>${escapeHtml(invoice.number)}</td>
    <td>${escapeHtml(formatDate(invoice.period_start))} – ${escapeHtml(formatDate(invoice.period_end))}</td>
    <td>${Number(invoice.seats)}</td>
    <td>${escapeHtml(formatMoney(invoice.total_paise, invoice.currency))}</td>
    <td class="status status-${escapeHtml(invoice.status)}">${escapeHtml(invoice.status)}</td>
    <td>${escapeHtml(formatDate(invoice.paid_at))}</td>
  </tr>`).join('');
  document.getElementById('invoice-empty').classList.toggle('hidden', data.invoices.length > 0);
  document.getElementById('billing-content').classList.remove('hidden');
}

async function loadBilling() {
  const error = document.getElementById('billing-error');
  try {
    const response = await fetch('/api/billing/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to load billing details.');
    renderBilling(result);
  } catch (reason) {
    error.textContent = reason.message;
    error.classList.remove('hidden');
  }
}

document.getElementById('print-button').addEventListener('click', () => window.print());
document.getElementById('refresh-button').addEventListener('click', loadBilling);
loadBilling();
