'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEntitlementMiddleware, getCompanyAccessState } = require('../entitlements');

const company = { id: 12, code: 'trial-co', status: 'trial', trial_ends_at: '2026-10-06', trial_policy_version: 1 };
const fixedNow = value => new Date(value);

test('legacy and active companies without subscription rows keep full access', () => {
  assert.equal(getCompanyAccessState({ id: 'legacy' }).state, 'full');
  assert.equal(getCompanyAccessState({ id: 12, status: 'active' }).state, 'full');
  assert.equal(getCompanyAccessState(null).state, 'locked');
});

test('trial remains full-access through its end date and locks afterward', () => {
  const inTrial = getCompanyAccessState(company, { now: fixedNow('2026-10-06T23:59:59.999Z') });
  assert.equal(inTrial.state, 'full');
  assert.match(inTrial.message, /Automatic workspace deletion is disabled/);
  const ended = getCompanyAccessState(company, { now: fixedNow('2026-10-07T00:00:00.000Z') });
  assert.equal(ended.state, 'locked');
  assert.deepEqual(ended.reasons, ['trial_ended']);
});

test('an unpaid invoice does not extend a trial or start payment grace before the paid period', () => {
  const subscription = { status: 'past_due', current_period_end: '2026-11-06T12:00:00.000Z' };
  assert.equal(getCompanyAccessState(company, {
    subscription,
    now: fixedNow('2026-10-06T12:00:00.000Z')
  }).state, 'full');
  const endedTrial = getCompanyAccessState(company, {
    subscription,
    now: fixedNow('2026-10-07T00:00:00.000Z')
  });
  assert.equal(endedTrial.state, 'locked');
  assert.deepEqual(endedTrial.reasons, ['trial_ended']);
});

test('suspension locks access regardless of subscription state', () => {
  assert.equal(getCompanyAccessState({ ...company, status: 'suspended' }, {
    subscription: { status: 'active', current_period_end: '2027-01-01T00:00:00Z' },
    now: fixedNow('2026-10-01T00:00:00Z')
  }).state, 'locked');
});

test('past-due subscriptions move from grace to read-only and then locked', () => {
  const options = {
    subscription: { status: 'past_due', current_period_end: '2026-10-01T00:00:00Z' },
    settings: { grace_period_days: 3, read_only_period_days: 7 }
  };
  assert.equal(getCompanyAccessState({ ...company, status: 'active' }, { ...options, now: fixedNow('2026-10-04T00:00:00Z') }).state, 'grace');
  assert.equal(getCompanyAccessState({ ...company, status: 'active' }, { ...options, now: fixedNow('2026-10-05T00:00:00Z') }).state, 'read_only');
  assert.equal(getCompanyAccessState({ ...company, status: 'active' }, { ...options, now: fixedNow('2026-10-12T00:00:00Z') }).state, 'locked');
});

test('cancelled subscriptions are read-only only through their paid period', () => {
  const options = { subscription: { status: 'cancelled', current_period_end: '2026-10-10T00:00:00Z' } };
  assert.equal(getCompanyAccessState({ ...company, status: 'active' }, { ...options, now: fixedNow('2026-10-09T00:00:00Z') }).state, 'read_only');
  assert.equal(getCompanyAccessState({ ...company, status: 'active' }, { ...options, now: fixedNow('2026-10-11T00:00:00Z') }).state, 'locked');
});

function callMiddleware(middleware, request) {
  return new Promise(resolve => {
    const response = {
      headers: {},
      locals: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body, headers: this.headers }); }
    };
    middleware(request, response, () => resolve({ next: true, headers: response.headers }));
  });
}

test('read-only blocks writes, while locked access is limited to admin billing routes', async () => {
  const state = { state: 'read_only', reasons: ['payment_overdue'], message: 'Read-only.' };
  let result = await callMiddleware(createEntitlementMiddleware({ getCompanyAccessState: async () => state }), {
    path: '/api/tasks', method: 'GET', companyTenantId: 12, session: { role: 'employee' }
  });
  assert.equal(result.next, true);
  assert.equal(result.headers['X-Company-Access-State'], 'read_only');

  result = await callMiddleware(createEntitlementMiddleware({ getCompanyAccessState: async () => state }), {
    path: '/api/tasks', method: 'POST', companyTenantId: 12, session: { role: 'admin' }
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.read_only, true);

  const locked = { state: 'locked', reasons: ['trial_ended'], message: 'Trial ended.' };
  const lockedMiddleware = createEntitlementMiddleware({ getCompanyAccessState: async () => locked });
  result = await callMiddleware(lockedMiddleware, {
    path: '/api/auth/billing', method: 'GET', companyTenantId: 12, session: { role: 'admin' }
  });
  assert.equal(result.next, true);
  result = await callMiddleware(lockedMiddleware, {
    path: '/api/auth/me', method: 'GET', companyTenantId: 12, session: { role: 'employee' }
  });
  assert.equal(result.statusCode, 402);
  assert.equal(result.body.billing_required, true);
});

test('unmarked pre-existing trials are grandfathered and are not subject to the new trial expiry', () => {
  assert.equal(getCompanyAccessState({ ...company, trial_policy_version: null }, {
    now: fixedNow('2030-01-01T00:00:00Z')
  }).state, 'full');
});