'use strict';

const pricingStatus = document.getElementById('pricing-status');
const pricingContent = document.getElementById('pricing-content');
const estimateForm = document.getElementById('estimate-form');
const estimateSeats = document.getElementById('estimate-seats');
const estimateCycle = document.getElementById('estimate-cycle');
const estimateTotal = document.getElementById('estimate-total');
const estimateNote = document.getElementById('estimate-note');
const demoForm = document.getElementById('demo-form');
const demoStatus = document.getElementById('demo-status');
let currentPricing = null;

function currencyFormatter(currency) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  });
}

function formatPaise(amountPaise, currency) {
  return currencyFormatter(currency).format(amountPaise / 100);
}

function calculateDisplayedTotal(unitPricePaise, seats, taxPctTenths, taxInclusive) {
  const subtotal = BigInt(unitPricePaise) * BigInt(seats);
  const taxRate = BigInt(taxPctTenths);
  const denominator = taxInclusive ? 1000n + taxRate : 1000n;
  const tax = (subtotal * taxRate * 2n + denominator) / (2n * denominator);
  return {
    total: taxInclusive ? subtotal : subtotal + tax,
    tax
  };
}

function updateEstimate() {
  if (!currentPricing) return;
  const seats = Number(estimateSeats.value);
  const minimum = currentPricing.minSeats || 1;
  const maximum = currentPricing.maxSeats || 100000;
  if (!Number.isSafeInteger(seats) || seats < minimum || seats > maximum) {
    estimateTotal.textContent = 'Enter a valid seat count';
    estimateNote.textContent = `Choose between ${minimum} and ${maximum.toLocaleString('en-IN')} seats.`;
    return;
  }
  const yearly = estimateCycle.value === 'yearly';
  const unitPrice = yearly ? currentPricing.yearlyPricePaise : currentPricing.monthlyPricePaise;
  const result = calculateDisplayedTotal(unitPrice, seats, Math.round(currentPricing.taxPct * 10), currentPricing.taxInclusive);
  const totalPaise = Number(result.total);
  const taxPaise = Number(result.tax);
  if (!Number.isSafeInteger(totalPaise) || !Number.isSafeInteger(taxPaise)) {
    estimateTotal.textContent = 'Estimate exceeds the supported amount';
    estimateNote.textContent = 'Contact TaskFlow for a custom estimate.';
    return;
  }
  estimateTotal.textContent = formatPaise(totalPaise, currentPricing.currency);
  const frequency = yearly ? 'year' : 'month';
  estimateNote.textContent = `${seats} seat${seats === 1 ? '' : 's'} per ${frequency}${currentPricing.taxInclusive
    ? `; includes ${formatPaise(taxPaise, currentPricing.currency)} tax.`
    : `; plus ${formatPaise(taxPaise, currentPricing.currency)} tax.`}`;
}

async function loadPricing() {
  try {
    const response = await fetch('/api/public/pricing', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Current pricing is temporarily unavailable.');
    let pricing;
    try {
      pricing = await response.json();
    } catch {
      throw new Error('Current pricing could not be displayed.');
    }
    if (!Number.isSafeInteger(pricing.monthlyPricePaise) || !Number.isSafeInteger(pricing.yearlyPricePaise)
      || !Number.isFinite(pricing.taxPct) || !/^[A-Z]{3}$/.test(pricing.currency)) {
      throw new Error('Current pricing could not be displayed.');
    }
    currentPricing = pricing;
    document.getElementById('monthly-price').textContent = formatPaise(pricing.monthlyPricePaise, pricing.currency);
    document.getElementById('yearly-price').textContent = formatPaise(pricing.yearlyPricePaise, pricing.currency);
    const taxDescription = pricing.taxInclusive
      ? `Includes ${pricing.taxPct}% tax`
      : `Excludes ${pricing.taxPct}% tax`;
    document.getElementById('monthly-tax').textContent = `${taxDescription} · ${pricing.currency}`;
    document.getElementById('yearly-tax').textContent = `${taxDescription} · ${pricing.currency}`;
    estimateSeats.min = String(pricing.minSeats || 1);
    estimateSeats.max = String(pricing.maxSeats || 100000);
    if (Number(estimateSeats.value) < Number(estimateSeats.min)) estimateSeats.value = estimateSeats.min;
    pricingStatus.classList.add('hidden');
    pricingContent.classList.remove('hidden');
    updateEstimate();
  } catch (error) {
    pricingStatus.textContent = error.message;
    pricingStatus.classList.add('error');
  }
}

estimateForm.addEventListener('input', updateEstimate);
estimateForm.addEventListener('change', updateEstimate);
loadPricing();

demoForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!demoForm.reportValidity()) return;
  const submitButton = demoForm.querySelector('button[type="submit"]');
  const formData = new FormData(demoForm);
  const request = Object.fromEntries(formData.entries());
  request.teamSize = Number(request.teamSize);
  request.consent = formData.get('consent') === 'on';
  demoStatus.textContent = 'Sending your request…';
  demoStatus.classList.remove('error');
  submitButton.disabled = true;
  try {
    const response = await fetch('/api/public/demo-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request)
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('We could not read the server response. Please try again.');
    }
    if (!response.ok) throw new Error(result.error || 'We could not submit your request. Please try again.');
    demoForm.reset();
    demoStatus.textContent = 'Thanks — your request is queued for manual review. It does not create an account or trial.';
  } catch (error) {
    demoStatus.textContent = error.message;
    demoStatus.classList.add('error');
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('copyright-year').textContent = String(new Date().getFullYear());
