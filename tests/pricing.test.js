'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  calculateInvoiceAmounts,
  calculateTierQuote,
  calculateYearlyPricePaise,
  parsePercentageTenths,
  resolveTierForSeats,
  validateTiers
} = require('../lib/pricing');

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

test('tier validation requires contiguous ranges from one through an unlimited final tier', () => {
  const tiers = [
    { key: 'team', name: 'Team', minSeats: 1, maxSeats: 10, monthlyPricePaise: 29900, yearlyPricePaise: 322920 },
    { key: 'enterprise', name: 'Enterprise', minSeats: 11, maxSeats: null, monthlyPricePaise: 19900, yearlyPricePaise: 214920 }
  ];
  assert.equal(validateTiers(tiers), true);
  assert.equal(resolveTierForSeats(tiers, 10), tiers[0]);
  assert.equal(resolveTierForSeats(tiers, 11), tiers[1]);
  for (const seats of [0, -1, 1.5, 'abc']) {
    assert.throws(() => resolveTierForSeats(tiers, seats), /positive integer/);
  }
  assert.throws(() => validateTiers([
    tiers[0],
    { ...tiers[1], minSeats: 12 }
  ]), /contiguous/);
  assert.throws(() => validateTiers([
    tiers[0],
    { ...tiers[1], minSeats: 10 }
  ]), /contiguous/);
  assert.throws(() => validateTiers([
    { ...tiers[0], maxSeats: null },
    tiers[1]
  ]), /unlimited|contiguous/);
  assert.throws(() => validateTiers([
    { ...tiers[0], maxSeats: 9 },
    { ...tiers[1], minSeats: 10, maxSeats: 100 }
  ]), /last pricing tier/);
});

test('tier quotes select volume rates and calculate yearly tax and savings in paise', () => {
  const tiers = [
    { key: 'team', name: 'Team', minSeats: 1, maxSeats: 10, monthlyPricePaise: 29900, yearlyPricePaise: 322920 },
    { key: 'enterprise', name: 'Enterprise', minSeats: 11, maxSeats: null, monthlyPricePaise: 19900, yearlyPricePaise: 214920 }
  ];
  const ten = calculateTierQuote({ tiers, seats: 10, cycle: 'monthly', taxPctTenths: 180 });
  assert.deepEqual(
    [ten.tier.name, ten.unitPricePaise, ten.subtotalPaise, ten.taxPaise, ten.totalPaise],
    ['Team', 29900, 299000, 53820, 352820]
  );
  const eleven = calculateTierQuote({ tiers, seats: 11, cycle: 'monthly', taxPctTenths: 180 });
  assert.deepEqual(
    [eleven.tier.name, eleven.unitPricePaise, eleven.subtotalPaise, eleven.taxPaise, eleven.totalPaise],
    ['Enterprise', 19900, 218900, 39402, 258302]
  );
  const yearly = calculateTierQuote({ tiers, seats: 11, cycle: 'yearly', taxPctTenths: 180 });
  assert.deepEqual(
    [yearly.unitPricePaise, yearly.subtotalPaise, yearly.taxPaise, yearly.totalPaise,
      yearly.monthlyEquivalentPaise, yearly.yearlySavingsPaise],
    [214920, 2364120, 425542, 2789662, 17910, 262680]
  );
});