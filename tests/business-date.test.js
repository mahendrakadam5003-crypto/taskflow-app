const assert = require('node:assert/strict');
const { test } = require('node:test');
const { businessDate } = require('../lib/business-date');

test('business date follows Asia/Kolkata across the post-midnight UTC boundary', () => {
  assert.equal(businessDate(new Date('2026-10-02T20:00:00.000Z')), '2026-10-03');
  assert.equal(businessDate(new Date('2026-10-03T00:00:00.000Z')), '2026-10-03');
  assert.equal(businessDate(new Date('2026-10-03T19:00:00.000Z')), '2026-10-04');
});
