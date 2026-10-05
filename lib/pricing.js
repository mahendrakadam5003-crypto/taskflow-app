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

module.exports = { calculateInvoiceAmounts, calculateYearlyPricePaise, parsePercentageTenths };