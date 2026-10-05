'use strict';

function parsePercentageTenths(value, { min = 0, max = 100 } = {}) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value ?? '').trim();
  const match = /^(\d{1,3})(?:\.(\d))?$/.exec(text);
  if (!match) return null;
  const whole = Number(match[1]);
  const tenths = whole * 10 + Number(match[2] || 0);
  if (tenths < min * 10 || tenths > max * 10) return null;
  return tenths;
}

function requireSafePaise(value, name = 'Money amount') {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError(`${name} must be a non-negative integer number of paise.`);
  return BigInt(amount);
}

function roundHalfUp(numerator, denominator) {
  return (numerator * 2n + denominator) / (2n * denominator);
}

function calculateYearlyPricePaise(monthlyPricePaise, discountTenths) {
  const monthly = requireSafePaise(monthlyPricePaise, 'Monthly price');
  const discount = Number(discountTenths);
  if (!Number.isSafeInteger(discount) || discount < 0 || discount > 1000) {
    throw new TypeError('Yearly discount must be between 0 and 100 percent in tenths.');
  }
  const annual = monthly * 12n;
  const yearly = roundHalfUp(annual * BigInt(1000 - discount), 1000n);
  if (yearly > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Yearly price exceeds the supported paise range.');
  return Number(yearly);
}

function calculateInvoiceAmounts({
  unitPricePaise,
  seats,
  discountPctTenths = 0,
  taxPctTenths = 180,
  taxInclusive = false
}) {
  const unitPrice = requireSafePaise(unitPricePaise, 'Unit price');
  if (!Number.isSafeInteger(seats) || seats < 1) throw new TypeError('Seats must be a positive integer.');
  if (!Number.isSafeInteger(discountPctTenths) || discountPctTenths < 0 || discountPctTenths > 1000) {
    throw new TypeError('Discount must be between 0 and 100 percent in tenths.');
  }
  if (!Number.isSafeInteger(taxPctTenths) || taxPctTenths < 0 || taxPctTenths > 1000) {
    throw new TypeError('Tax must be between 0 and 100 percent in tenths.');
  }

  const subtotal = unitPrice * BigInt(seats);
  const discount = roundHalfUp(subtotal * BigInt(discountPctTenths), 1000n);
  const taxableAmount = subtotal - discount;
  const tax = taxInclusive
    ? roundHalfUp(taxableAmount * BigInt(taxPctTenths), 1000n + BigInt(taxPctTenths))
    : roundHalfUp(taxableAmount * BigInt(taxPctTenths), 1000n);
  const total = taxInclusive ? taxableAmount : taxableAmount + tax;
  for (const amount of [subtotal, discount, tax, total]) {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Invoice total exceeds the supported paise range.');
  }
  return {
    subtotalPaise: Number(subtotal),
    discountPaise: Number(discount),
    taxPaise: Number(tax),
    totalPaise: Number(total)
  };
}

function validateTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 5) {
    throw new TypeError('Pricing must contain between 1 and 5 tiers.');
  }
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
      throw new TypeError(`Pricing tier ${index + 1} must be an object.`);
    }
    if (!Number.isSafeInteger(tier.minSeats) || tier.minSeats < 1
      || (index === 0 ? tier.minSeats !== 1 : tier.minSeats !== tiers[index - 1].maxSeats + 1)) {
      throw new RangeError('Pricing tiers must start at one seat and have contiguous, non-overlapping ranges.');
    }
    if (!Number.isSafeInteger(tier.monthlyPricePaise) || tier.monthlyPricePaise < 0
      || !Number.isSafeInteger(tier.yearlyPricePaise) || tier.yearlyPricePaise < 0) {
      throw new TypeError('Tier prices must be non-negative integer amounts in paise.');
    }
    if (index < tiers.length - 1) {
      if (!Number.isSafeInteger(tier.maxSeats) || tier.maxSeats < tier.minSeats
        || tier.minSeats > Number.MAX_SAFE_INTEGER - 1
        || tiers[index + 1]?.minSeats !== tier.maxSeats + 1) {
        throw new RangeError('Only the last pricing tier may be unlimited; tier ranges must be contiguous.');
      }
    } else if (tier.maxSeats !== null) {
      throw new RangeError('The last pricing tier must have no maximum seat count.');
    }
  }
  return true;
}

function resolveTierForSeats(tiers, seats) {
  validateTiers(tiers);
  if (!Number.isSafeInteger(seats) || seats < 1) throw new TypeError('Seats must be a positive integer.');
  const tier = tiers.find(item => seats >= item.minSeats && (item.maxSeats === null || seats <= item.maxSeats));
  if (!tier) throw new RangeError('No pricing tier is configured for this seat count.');
  return tier;
}

function calculateTierQuote({ tiers, seats, cycle, taxPctTenths = 180, taxInclusive = false }) {
  if (!['monthly', 'yearly'].includes(cycle)) throw new TypeError('Billing cycle must be monthly or yearly.');
  const tier = resolveTierForSeats(tiers, seats);
  const unitPricePaise = cycle === 'yearly' ? tier.yearlyPricePaise : tier.monthlyPricePaise;
  const amounts = calculateInvoiceAmounts({ unitPricePaise, seats, taxPctTenths, taxInclusive });
  let monthlyEquivalentPaise = null;
  let yearlySavingsPaise = null;
  if (cycle === 'yearly') {
    const monthlyEquivalent = roundHalfUp(BigInt(unitPricePaise), 12n);
    const yearlyWithoutDiscount = BigInt(tier.monthlyPricePaise) * 12n * BigInt(seats);
    const yearlySavings = yearlyWithoutDiscount - BigInt(amounts.subtotalPaise);
    if (monthlyEquivalent > BigInt(Number.MAX_SAFE_INTEGER)
      || yearlySavings > BigInt(Number.MAX_SAFE_INTEGER)
      || yearlySavings < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError('Yearly quote exceeds the supported paise range.');
    }
    monthlyEquivalentPaise = Number(monthlyEquivalent);
    yearlySavingsPaise = Number(yearlySavings);
  }
  return { tier, unitPricePaise, ...amounts, monthlyEquivalentPaise, yearlySavingsPaise };
}

module.exports = {
  calculateInvoiceAmounts,
  calculateTierQuote,
  calculateYearlyPricePaise,
  parsePercentageTenths,
  resolveTierForSeats,
  validateTiers
};