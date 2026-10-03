const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseMoneyAmount, parsePaymentAmounts } = require('../lib/money');

test('money parsing rejects negative reimbursement amounts and excess precision', () => {
  assert.equal(parseMoneyAmount(-1, { allowZero: false }), null);
  assert.equal(parseMoneyAmount('0', { allowZero: false }), null);
  assert.equal(parseMoneyAmount('12.34', { allowZero: false }), 12.34);
  assert.equal(parseMoneyAmount('12.345', { allowZero: false }), null);
  assert.equal(parseMoneyAmount(0.1 + 0.2), 0.3);
});

test('received payments cannot exceed the invoice total', () => {
  assert.deepEqual(parsePaymentAmounts('100.00', '100.00'), { totalAmount: 100, receivedAmount: 100 });
  assert.equal(parsePaymentAmounts('100.00', '100.01'), null);
  assert.equal(parsePaymentAmounts('100.00', '-1'), null);
});
