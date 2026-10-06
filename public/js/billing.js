'use strict';

let billingData = null;

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

function findTier(pricing, seats) {
  return (pricing.tiers || []).find(tier => seats >= tier.minSeats
    && (tier.maxSeats == null || seats <= tier.maxSeats)) || null;
}

function roundHalfUp(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function renderTierTable(pricing) {
  const currency = pricing.currencySymbol || pricing.currency;
  const tiers = pricing.tiers?.length ? pricing.tiers : [{
    name: 'Standard', minSeats: 1, maxSeats: null,
    monthlyPricePaise: pricing.monthlyPricePaise,
    yearlyPricePaise: pricing.yearlyPricePaise
  }];
  document.getElementById('pricing-tier-rows').innerHTML = tiers.map(tier => `<tr>
    <td>${escapeHtml(tier.name)}</td>
    <td>${tier.minSeats}${tier.maxSeats == null ? '+' : `-${tier.maxSeats}`}</td>
    <td>${escapeHtml(formatMoney(tier.monthlyPricePaise, currency))}</td>
    <td>${escapeHtml(formatMoney(tier.yearlyPricePaise, currency))}</td>
  </tr>`).join('');
}

function renderQuote() {
  const data = billingData;
  if (!data) return;
  const seatsValue = document.getElementById('requested-seats').value;
  const seats = Number(seatsValue);
  const cycle = document.getElementById('requested-cycle').value;
  const error = document.getElementById('quote-error');
  const note = document.getElementById('tier-change-note');
  error.classList.add('hidden');
  note.classList.add('hidden');
  if (!Number.isSafeInteger(seats) || seats < 1 || !['monthly', 'yearly'].includes(cycle)) {
    error.textContent = 'Enter a whole-number seat count of at least one to see the quote.';
    error.classList.remove('hidden');
    return;
  }

  const pricing = data.pricing;
  const tier = findTier(pricing, seats);
  if ((pricing.tiers || []).length && !tier) {
    error.textContent = 'No pricing tier is available for this seat count.';
    error.classList.remove('hidden');
    return;
  }
  const monthlyPrice = BigInt(tier?.monthlyPricePaise ?? pricing.monthlyPricePaise);
  const yearlyPrice = BigInt(tier?.yearlyPricePaise ?? pricing.yearlyPricePaise);
  const unitPrice = cycle === 'yearly' ? yearlyPrice : monthlyPrice;
  const subtotal = unitPrice * BigInt(seats);
  const taxRate = BigInt(Math.round(Number(pricing.taxPct) * 10));
  const tax = pricing.taxInclusive
    ? roundHalfUp(subtotal * taxRate, 1000n + taxRate)
    : roundHalfUp(subtotal * taxRate, 1000n);
  const total = pricing.taxInclusive ? subtotal : subtotal + tax;
  const saving = (monthlyPrice * 12n - yearlyPrice) * BigInt(seats);
  const amounts = [unitPrice, subtotal, tax, total, saving];
  if (amounts.some(amount => amount > BigInt(Number.MAX_SAFE_INTEGER)
    || amount < BigInt(Number.MIN_SAFE_INTEGER))) {
    error.textContent = 'This quote exceeds the supported amount range.';
    error.classList.remove('hidden');
    return;
  }

  const currency = pricing.currencySymbol || pricing.currency;
  const selectedTierName = tier?.name || 'Standard';
  document.getElementById('quote-tier').textContent = selectedTierName;
  document.getElementById('quote-rate').textContent = `${formatMoney(Number(unitPrice), currency)} / seat / ${cycle === 'yearly' ? 'year' : 'month'}`;
  document.getElementById('quote-subtotal').textContent = formatMoney(Number(subtotal), currency);
  document.getElementById('quote-tax-label').textContent = pricing.taxInclusive
    ? `GST included (${pricing.taxPct}%)` : `GST (${pricing.taxPct}%)`;
  document.getElementById('quote-tax').textContent = formatMoney(Number(tax), currency);
  document.getElementById('quote-total').textContent = formatMoney(Number(total), currency);
  document.getElementById('quote-saving').textContent = formatMoney(Number(saving), currency);

  const currentSeats = Number(data.subscription?.seats);
  const currentTier = Number.isSafeInteger(currentSeats) ? findTier(pricing, currentSeats) : null;
  if (data.subscription && currentTier && tier && currentTier !== tier) {
    const tiers = pricing.tiers;
    const currentIndex = tiers.indexOf(currentTier);
    const selectedIndex = tiers.indexOf(tier);
    const boundary = selectedIndex > currentIndex ? tier.minSeats : currentTier.minSeats - 1;
    note.textContent = `Your rate changes to ${formatMoney(tier.monthlyPricePaise, currency)} per seat at ${boundary} seats`;
    note.classList.remove('hidden');
  }
}

function renderBilling(data) {
  billingData = data;
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
  const currency = data.pricing.currencySymbol || data.pricing.currency;
  const currentSeats = Number(subscription?.seats || usage.activeUsers || 1);
  const currentTier = findTier(data.pricing, currentSeats);
  const currentRate = subscription?.unit_price_paise
    ?? (subscription?.billing_cycle === 'yearly'
      ? currentTier?.yearlyPricePaise ?? data.pricing.yearlyPricePaise
      : currentTier?.monthlyPricePaise ?? data.pricing.monthlyPricePaise);
  document.getElementById('current-tier').textContent = currentTier?.name || 'Standard';
  document.getElementById('current-rate').textContent = `${formatMoney(currentRate, currency)} / seat / ${subscription?.billing_cycle === 'yearly' ? 'year' : 'month'}`;
  document.getElementById('current-seats').textContent = `${currentSeats} ${currentSeats === 1 ? 'seat' : 'seats'}`;
  document.getElementById('next-renewal').textContent = subscription?.current_period_end
    ? formatDate(subscription.current_period_end) : 'Not scheduled';
  renderTierTable(data.pricing);
  const seatsInput = document.getElementById('requested-seats');
  seatsInput.min = String(Math.max(1, Number(data.billingRules?.minSeats || 1)));
  if (data.billingRules?.maxSeats != null) seatsInput.max = String(data.billingRules.maxSeats);
  if (!seatsInput.value) seatsInput.value = String(subscription?.seats || usage.activeUsers || 1);
  if (subscription) document.getElementById('requested-cycle').value = subscription.billing_cycle;
  renderQuote();
  document.getElementById('billing-updated').textContent = `Live usage refreshed ${new Date().toLocaleString()}.`;
  const rows = document.getElementById('invoice-rows');
  rows.innerHTML = data.invoices.map(invoice => `<tr>
    <td>${escapeHtml(invoice.number)}</td>
    <td>${escapeHtml(formatDate(invoice.period_start))} – ${escapeHtml(formatDate(invoice.period_end))}</td>
    <td>${Number(invoice.seats)}</td>
    <td>${escapeHtml(formatMoney(invoice.total_paise, invoice.currency))}</td>
    <td class="status status-${escapeHtml(invoice.status)}">${escapeHtml(invoice.status)}</td>
    <td>${escapeHtml(formatDate(invoice.paid_at))}</td>
    <td>${invoice.status === 'paid' ? `<a href="/api/billing/invoices/${encodeURIComponent(invoice.id)}/receipt">Download receipt</a>` : '—'}</td>
  </tr>`).join('');
  document.getElementById('invoice-empty').classList.toggle('hidden', data.invoices.length > 0);
  document.getElementById('billing-request-rows').innerHTML = data.billingRequests.map(request => `<tr>
    <td>#${Number(request.id)}</td>
    <td>${Number(request.requested_seats)}</td>
    <td>${escapeHtml(request.requested_billing_cycle)}</td>
    <td>${escapeHtml(request.status)}${request.invoice_id ? ` · invoice #${Number(request.invoice_id)}` : ''}</td>
    <td>${escapeHtml(formatDate(request.created_at))}</td>
  </tr>`).join('');
  document.getElementById('billing-content').classList.remove('hidden');
}

async function loadBilling() {
  const error = document.getElementById('billing-error');
  try {
    const response = await fetch('/api/billing/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to load billing details.');
    error.classList.add('hidden');
    renderBilling(result);
  } catch (reason) {
    error.textContent = reason.message;
    error.classList.remove('hidden');
  }
}

document.getElementById('print-button').addEventListener('click', () => window.print());
document.getElementById('refresh-button').addEventListener('click', loadBilling);
document.getElementById('requested-seats').addEventListener('input', renderQuote);
document.getElementById('requested-cycle').addEventListener('change', renderQuote);
document.getElementById('billing-change-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('billing-request-submit');
  const message = document.getElementById('billing-request-message');
  message.classList.add('hidden');
  button.disabled = true;
  try {
    const response = await fetch('/api/billing/requests', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seats: Number(document.getElementById('requested-seats').value),
        billingCycle: document.getElementById('requested-cycle').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to submit the billing request.');
    message.textContent = 'Request submitted for administrator review. No payment has been taken.';
    message.classList.add('success');
    message.classList.remove('hidden');
    await loadBilling();
  } catch (error) {
    message.textContent = error.message;
    message.classList.remove('success');
    message.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
});
loadBilling();
