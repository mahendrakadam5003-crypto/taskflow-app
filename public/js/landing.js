'use strict';

const pricingStatus = document.getElementById('pricing-status');
const pricingContent = document.getElementById('pricing-content');
const priceCards = document.getElementById('price-cards');
const planComparison = document.getElementById('plan-comparison');
const estimateForm = document.getElementById('estimate-form');
const estimateSeats = document.getElementById('estimate-seats');
const estimateCycle = document.getElementById('estimate-cycle');
const estimateTotal = document.getElementById('estimate-total');
const estimateNote = document.getElementById('estimate-note');
const boundaryWarning = document.getElementById('boundary-warning');
const demoForm = document.getElementById('demo-form');
const demoStatus = document.getElementById('demo-status');
const demoPlanInterest = document.getElementById('demo-plan-interest');
const demoTeamSize = document.getElementById('demo-team-size');
const menuToggle = document.getElementById('menu-toggle');
const siteNavigation = document.getElementById('site-navigation');
let currentPricing = null;
let pricingTiers = [];

function formatPaise(amountPaise, currency = currentPricing?.currency) {
  if (!(typeof amountPaise === 'bigint' || Number.isSafeInteger(amountPaise)) || !/^[A-Z]{3}$/.test(currency || '')) {
    throw new Error('A displayed price is not valid.');
  }
  const paise = BigInt(amountPaise);
  const whole = (paise / 100n).toLocaleString('en-IN');
  const fraction = String(paise % 100n).padStart(2, '0');
  const symbol = currentPricing?.currencySymbol || currency;
  return `${symbol} ${whole}.${fraction}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function roundedDivide(numerator, denominator) {
  return (numerator * 2n + denominator) / (2n * denominator);
}

function yearlyDiscountTenths(tier) {
  const monthlyForYear = BigInt(tier.monthlyPricePaise) * 12n;
  const discount = monthlyForYear - BigInt(tier.yearlyPricePaise);
  return discount > 0n ? roundedDivide(discount * 1000n, monthlyForYear) : 0n;
}

function calculateTaxAndTotal(subtotalPaise) {
  const taxRateTenths = BigInt(Math.round(currentPricing.taxPct * 10));
  const denominator = currentPricing.taxInclusive ? 1000n + taxRateTenths : 1000n;
  const taxPaise = roundedDivide(subtotalPaise * taxRateTenths, denominator);
  return {
    taxPaise,
    totalPaise: currentPricing.taxInclusive ? subtotalPaise : subtotalPaise + taxPaise
  };
}

function taxLabel() {
  if (currentPricing.taxInclusive) return `GST inclusive (${currentPricing.taxPct}%)`;
  return `Plus ${currentPricing.taxPct}% GST`;
}

function setBillingCycle(cycle) {
  estimateCycle.value = cycle;
  document.querySelectorAll('.billing-toggle button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.cycle === cycle));
  });
  renderPricingCards();
  updateEstimate();
}

function getTierForSeats(seats) {
  return pricingTiers.find(tier => seats >= tier.minSeats && (tier.maxSeats === null || seats <= tier.maxSeats));
}

function renderPricingCards() {
  if (!currentPricing) return;
  const yearly = estimateCycle.value === 'yearly';
  priceCards.replaceChildren();

  pricingTiers.forEach(tier => {
    const card = element('article', `price-card${tier.name.toLowerCase() === 'enterprise' ? ' price-card-featured' : ''}`);
    if (tier.name.toLowerCase() === 'enterprise') card.append(element('p', 'popular-badge', 'VOLUME RATE'));
    card.append(element('p', 'plan-label', tier.name.toUpperCase()));
    if (tier.tagline) card.append(element('p', 'tier-tagline', tier.tagline));
    const priceHeading = element('h3', 'tier-price');
    priceHeading.append(element('span', '', formatPaise(yearly ? tier.yearlyMonthlyEquivalentPaise : tier.monthlyPricePaise)));
    priceHeading.append(element('small', '', ' / seat / month'));
    card.append(priceHeading);

    if (yearly) {
      const bill = element('p', 'price-detail', `Billed ${formatPaise(tier.yearlyPricePaise)} per seat per year`);
      card.append(bill);
      const discountTenths = yearlyDiscountTenths(tier);
      if (discountTenths > 0n) {
        const badge = element('p', 'price-saving', `You save ${(Number(discountTenths) / 10).toLocaleString('en-IN')}% yearly`);
        card.append(badge);
      }
    } else {
      card.append(element('p', 'price-detail', 'Billed monthly'));
    }
    card.append(element('p', 'price-tax', taxLabel()));
    card.append(element('p', 'seat-range', tier.maxSeats === null
      ? `${tier.minSeats.toLocaleString('en-IN')} or more seats`
      : `${tier.minSeats.toLocaleString('en-IN')}–${tier.maxSeats.toLocaleString('en-IN')} seats`));

    if (tier.highlights.length) {
      const highlights = element('ul', 'tier-highlights');
      tier.highlights.forEach(highlight => highlights.append(element('li', '', highlight)));
      card.append(highlights);
    }
    const button = element('button', 'button button-secondary plan-interest-button', 'Discuss this plan');
    button.type = 'button';
    button.dataset.planInterest = tier.name;
    button.dataset.minSeats = String(tier.minSeats);
    card.append(button);
    priceCards.append(card);
  });

  renderPlanComparison();
  updateHeroPrice();
}

function renderPlanComparison() {
  planComparison.replaceChildren();
  const featureSets = pricingTiers.map(tier => tier.highlights);
  const allFeatures = [...new Set(featureSets.flat())];
  if (pricingTiers.length < 2 || !allFeatures.length) {
    planComparison.append(element('p', 'comparison-note', 'Plan features are configurable. Contact us to discuss which setup fits your team.'));
    return;
  }
  const sameFeatures = featureSets.every(features => features.length === featureSets[0].length
    && features.every(feature => featureSets[0].includes(feature)));
  if (sameFeatures) {
    planComparison.append(element('p', 'comparison-note', 'Every listed tier includes the same configured features. Choose based on your seat count.'));
    return;
  }

  const table = element('table', 'comparison-table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.append(element('th', '', 'Included feature'));
  pricingTiers.forEach(tier => headerRow.append(element('th', '', tier.name)));
  head.append(headerRow);
  table.append(head);
  const body = document.createElement('tbody');
  allFeatures.forEach(feature => {
    const row = document.createElement('tr');
    row.append(element('th', '', feature));
    pricingTiers.forEach(tier => {
      const cell = document.createElement('td');
      const included = tier.highlights.includes(feature);
      cell.textContent = included ? 'Included' : '—';
      cell.setAttribute('aria-label', `${tier.name}: ${included ? 'included' : 'not included'}`);
      row.append(cell);
    });
    body.append(row);
  });
  table.append(body);
  planComparison.append(table);
}

function updateHeroPrice() {
  const price = document.getElementById('hero-price');
  if (!pricingTiers.length) return;
  const lowestPriceTier = pricingTiers.reduce((lowest, tier) =>
    tier.monthlyPricePaise < lowest.monthlyPricePaise ? tier : lowest);
  const message = `From ${formatPaise(lowestPriceTier.monthlyPricePaise)} / user / month`;
  const tenths = yearlyDiscountTenths(lowestPriceTier);
  if (tenths > 0n) {
    price.textContent = `${message} · ${Number(tenths) / 10}% off yearly`;
  } else {
    price.textContent = message;
  }
}

function updateEstimate() {
  if (!currentPricing || !pricingTiers.length) return;
  const seats = Number(estimateSeats.value);
  const minimum = currentPricing.minSeats || 1;
  const maximum = currentPricing.maxSeats || 100000;
  if (!Number.isSafeInteger(seats) || seats < minimum || seats > maximum) {
    estimateTotal.textContent = 'Enter a valid seat count';
    estimateNote.textContent = `Choose between ${minimum} and ${maximum.toLocaleString('en-IN')} seats.`;
    boundaryWarning.classList.add('hidden');
    return;
  }
  const tier = getTierForSeats(seats);
  if (!tier) {
    estimateTotal.textContent = 'No published tier covers this seat count';
    estimateNote.textContent = 'Contact TaskFlow for a quote.';
    boundaryWarning.classList.add('hidden');
    return;
  }

  const yearly = estimateCycle.value === 'yearly';
  const unitPrice = BigInt(yearly ? tier.yearlyPricePaise : tier.monthlyPricePaise);
  const subtotal = unitPrice * BigInt(seats);
  const { taxPaise, totalPaise } = calculateTaxAndTotal(subtotal);
  document.getElementById('estimate-rate').textContent = `${formatPaise(Number(unitPrice))} / seat / ${yearly ? 'year' : 'month'}`;
  document.getElementById('estimate-plan').textContent = tier.name;
  document.getElementById('estimate-subtotal').textContent = formatPaise(subtotal);
  document.getElementById('estimate-tax').textContent = `${formatPaise(taxPaise)} (${taxLabel()})`;
  estimateTotal.textContent = formatPaise(totalPaise);
  estimateNote.textContent = currentPricing.taxInclusive
    ? `Tax is included in the estimated total. Final invoice details are confirmed during onboarding.`
    : `Tax is added to the subtotal. Final invoice details are confirmed during onboarding.`;

  const savingRow = document.getElementById('estimate-saving-row');
  if (yearly) {
    const monthlySubtotal = BigInt(tier.monthlyPricePaise) * BigInt(seats) * 12n;
    const savings = monthlySubtotal - subtotal;
    if (savings > 0n) {
      document.getElementById('estimate-saving').textContent = formatPaise(savings);
      savingRow.classList.remove('hidden');
    } else {
      savingRow.classList.add('hidden');
    }
  } else {
    savingRow.classList.add('hidden');
  }

  boundaryWarning.classList.add('hidden');
  const nextTier = pricingTiers.find(candidate => candidate.minSeats > seats);
  if (nextTier && nextTier.minSeats - seats <= 3) {
    const nextUnitPrice = BigInt(yearly ? nextTier.yearlyPricePaise : nextTier.monthlyPricePaise);
    const nextTierSubtotal = nextUnitPrice * BigInt(nextTier.minSeats);
    const nextTierTotal = calculateTaxAndTotal(nextTierSubtotal).totalPaise;
    if (nextTierTotal < totalPaise) {
      boundaryWarning.textContent = `${nextTier.minSeats} seats would cost less (${formatPaise(nextTierTotal)}). You can choose ${nextTier.minSeats} seats to use the lower per-seat tier rate.`;
      boundaryWarning.classList.remove('hidden');
    }
  }
}

function renderDemoPlanOptions() {
  const previousValue = demoPlanInterest.value;
  const options = [element('option', '', 'Not sure yet')];
  options[0].value = '';
  const names = [...new Set([...pricingTiers.map(tier => tier.name), 'Custom'])];
  names.forEach(name => {
    const option = element('option', '', name);
    option.value = name;
    options.push(option);
  });
  demoPlanInterest.replaceChildren(...options);
  if (names.includes(previousValue)) demoPlanInterest.value = previousValue;
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
      || !Number.isFinite(pricing.taxPct) || !/^[A-Z]{3}$/.test(pricing.currency)
      || !Array.isArray(pricing.tiers) || !pricing.tiers.length) {
      throw new Error('Current pricing could not be displayed.');
    }
    const tiers = pricing.tiers.map(tier => ({
      ...tier,
      highlights: Array.isArray(tier.highlights) ? tier.highlights.filter(value => typeof value === 'string') : []
    }));
    if (tiers.some(tier => !Number.isSafeInteger(tier.monthlyPricePaise)
      || !Number.isSafeInteger(tier.yearlyPricePaise)
      || !Number.isSafeInteger(tier.yearlyMonthlyEquivalentPaise)
      || !Number.isSafeInteger(tier.minSeats) || tier.minSeats < 1
      || (tier.maxSeats !== null && !Number.isSafeInteger(tier.maxSeats)))) {
      throw new Error('Current pricing could not be displayed.');
    }
    currentPricing = pricing;
    pricingTiers = tiers;
    renderDemoPlanOptions();
    estimateSeats.min = String(pricing.minSeats || tiers[0].minSeats);
    estimateSeats.max = String(pricing.maxSeats || tiers[tiers.length - 1].maxSeats || 100000);
    if (Number(estimateSeats.value) < Number(estimateSeats.min)) estimateSeats.value = estimateSeats.min;
    const yearlyBadge = document.getElementById('yearly-saving-badge');
    const yearlyDiscounts = tiers.map(yearlyDiscountTenths);
    const sameDiscount = yearlyDiscounts.every(discount => discount === yearlyDiscounts[0]);
    yearlyBadge.textContent = sameDiscount && yearlyDiscounts[0] > 0n
      ? `Save ${Number(yearlyDiscounts[0]) / 10}%`
      : 'Yearly rates';
    pricingStatus.classList.add('hidden');
    pricingContent.classList.remove('hidden');
    renderPricingCards();
    updateEstimate();
  } catch (error) {
    pricingStatus.textContent = error.message;
    pricingStatus.classList.add('error');
  }
}

estimateForm.addEventListener('input', updateEstimate);
estimateForm.addEventListener('change', event => {
  if (event.target === estimateCycle) {
    document.querySelectorAll('.billing-toggle button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.cycle === estimateCycle.value));
    });
    renderPricingCards();
  }
  updateEstimate();
});
document.querySelectorAll('.billing-toggle button').forEach(button => {
  button.addEventListener('click', () => setBillingCycle(button.dataset.cycle));
});
priceCards.addEventListener('click', event => {
  const button = event.target.closest('[data-plan-interest]');
  if (button) selectPlanInterest(button.dataset.planInterest, Number(button.dataset.minSeats) || 1);
});
document.querySelectorAll('.custom-plan [data-plan-interest]').forEach(button => {
  button.addEventListener('click', () => selectPlanInterest(button.dataset.planInterest, null));
});

function selectPlanInterest(name, minSeats) {
  if (![...demoPlanInterest.options].some(option => option.value === name)) {
    const option = element('option', '', name);
    option.value = name;
    demoPlanInterest.append(option);
  }
  demoPlanInterest.value = name;
  if (minSeats) demoTeamSize.value = String(minSeats);
  document.getElementById('demo').scrollIntoView({ behavior: 'smooth' });
  demoPlanInterest.focus({ preventScroll: true });
}

menuToggle.addEventListener('click', () => {
  const isExpanded = menuToggle.getAttribute('aria-expanded') === 'true';
  menuToggle.setAttribute('aria-expanded', String(!isExpanded));
  menuToggle.querySelector('.menu-toggle-label').textContent = isExpanded ? 'Menu' : 'Close';
  siteNavigation.classList.toggle('is-open', !isExpanded);
});
document.getElementById('site-nav-links').addEventListener('click', event => {
  if (!event.target.closest('a')) return;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.querySelector('.menu-toggle-label').textContent = 'Menu';
  siteNavigation.classList.remove('is-open');
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || menuToggle.getAttribute('aria-expanded') !== 'true') return;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.querySelector('.menu-toggle-label').textContent = 'Menu';
  siteNavigation.classList.remove('is-open');
  menuToggle.focus();
});

demoForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!demoForm.reportValidity()) return;
  const submitButton = demoForm.querySelector('button[type="submit"]');
  const formData = new FormData(demoForm);
  const request = Object.fromEntries(formData.entries());
  const planInterest = String(request.planInterest || '').trim();
  const message = String(request.message || '').trim();
  const combinedMessage = [planInterest ? `Plan interest: ${planInterest}` : '', message].filter(Boolean).join('\n');
  if (combinedMessage.length > 2000) {
    demoStatus.textContent = 'Shorten your message so it fits the request form.';
    demoStatus.classList.add('error');
    return;
  }
  request.teamSize = Number(request.teamSize);
  request.consent = formData.get('consent') === 'on';
  request.message = combinedMessage;
  delete request.planInterest;
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

loadPricing();
document.getElementById('copyright-year').textContent = String(new Date().getFullYear());
