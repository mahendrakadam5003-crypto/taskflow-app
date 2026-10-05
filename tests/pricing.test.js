'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateInvoiceAmounts, calculateYearlyPricePaise, parsePercentageTenths } = require('../lib/pricing');

test('yearly price uses integer paise and rounds half up', () => {
  assert.equal(calculateYearlyPricePaise(19900, 100), 214920);
  assert.equal(calculateYearlyPricePaise(1, 500), 6);
  assert.equal(calculateYearlyPricePaise(19900, 0), 238800);
});

test('percentage parsing allows at most one decimal place and validates bounds', () => {
  assert.equal(parsePercentageTenths('12.5'), 125);
  assert.equal(parsePercentageTenths(18), 180);
  assert.equal(parsePercentageTenths('12.55'), null);
  assert.equal(parsePercentageTenths('101'), null);
  assert.equal(parsePercentageTenths('-1'), null);
});

test('invoice totals use paise, integer seats, and inclusive or exclusive tax', () => {
  assert.deepEqual(calculateInvoiceAmounts({ unitPricePaise: 19900, seats: 12, taxPctTenths: 180 }), {
    subtotalPaise: 238800,
    discountPaise: 0,
    taxPaise: 42984,
    totalPaise: 281784
  });
  assert.deepEqual(calculateInvoiceAmounts({
    unitPricePaise: 238800,
    seats: 1,
    discountPctTenths: 100,
    taxPctTenths: 180,
    taxInclusive: true
  }), {
    subtotalPaise: 238800,
    discountPaise: 23880,
    taxPaise: 32784,
    totalPaise: 214920
  });
  assert.throws(() => calculateInvoiceAmounts({ unitPricePaise: 19900.5, seats: 1 }), /integer number of paise/);
  assert.throws(() => calculateInvoiceAmounts({ unitPricePaise: 19900, seats: 0 }), /positive integer/);
});