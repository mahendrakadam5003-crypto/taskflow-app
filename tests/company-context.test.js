'use strict';

const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const session = require('express-session');
const { test } = require('node:test');
const {
  COMPANY_CONTEXT_COOKIE,
  createCompanyContextMiddleware,
  setCompanyContextCookie,
  signCompanyCode
} = require('../company-context');

const sessionSecret = 'company-context-test-secret-with-at-least-32-characters';

function getCookies(response) {
  return String(response.headers.get('set-cookie') || '')
    .split(/, (?=[^;,]+=)/)
    .map(cookie => cookie.split(';', 1)[0]);
}

test('legacy and registered-company sign-in preserve existing credentials and isolate company sessions', async () => {
  const companyContext = new AsyncLocalStorage();
  const existingWorkspace = new Map([['old-user', { password: 'old-password', marker: 'existing workspace data' }]]);
  const secondWorkspace = new Map([['new-user', { password: 'new-password', marker: 'second workspace data' }]]);
  const tenantWorkspaces = new Map([
    ['legacy', existingWorkspace],
    [101, existingWorkspace],
    [202, secondWorkspace]
  ]);
  const manager = {
    getCurrentTenantId: () => companyContext.getStore(),
    runWithTenant: (tenantId, callback) => companyContext.run(tenantId, callback)
  };
  const companies = new Map([
    ['existing-company', { id: 101, code: 'existing-company', name: 'Existing company', status: 'active' }],
    ['second-company', { id: 202, code: 'second-company', name: 'Second company', status: 'trial' }],
    ['suspended-company', { id: 303, code: 'suspended-company', name: 'Suspended company', status: 'suspended' }]
  ]);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: sessionSecret, resave: false, saveUninitialized: false }));
  app.use(createCompanyContextMiddleware({
    runWithTenant: manager.runWithTenant,
    secret: sessionSecret,
    getDatabase: async () => ({
      execute: async ({ args }) => {
        const company = typeof args[0] === 'number'
          ? [...companies.values()].find(candidate => candidate.id === args[0])
          : companies.get(args[0]);
        return { rows: company ? [company] : [] };
      }
    }),
    environment: { TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'test-token' }
  }));
  app.post('/api/auth/login', (req, res) => {
    const workspace = tenantWorkspaces.get(manager.getCurrentTenantId());
    const user = workspace?.get(req.body.username);
    if (!user || user.password !== req.body.password) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId = req.body.username;
    req.session.companyId = req.companyTenantId;
    if (req.companyCode) setCompanyContextCookie(res, req.companyCode, { secret: sessionSecret });
    return res.json({ user: req.body.username, marker: user.marker });
  });
  app.get('/api/context', (req, res) => {
    res.json({ tenantId: manager.getCurrentTenantId(), companyStatus: req.companyStatus || null });
  });
  app.post('/api/context', (req, res) => {
    res.json({ tenantId: manager.getCurrentTenantId(), companyStatus: req.companyStatus || null });
  });
  app.get('/api/probe', (req, res) => {
    if (req.companyStatus && !['trial', 'active'].includes(req.companyStatus)) {
      return res.status(403).json({ error: 'This company workspace is not active.' });
    }
    if (!req.session.userId || String(req.session.companyId) !== String(req.companyTenantId)) {
      return res.status(401).json({ error: 'Session does not belong to this company' });
    }
    const user = tenantWorkspaces.get(manager.getCurrentTenantId())?.get(req.session.userId);
    return res.json({ marker: user?.marker || null });
  });

  const server = await new Promise(resolve => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const legacyLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'old-user', password: 'old-password', company_code: '' })
    });
    assert.equal(legacyLogin.status, 200);
    assert.deepEqual(await legacyLogin.json(), { user: 'old-user', marker: 'existing workspace data' });
    const legacyLoginCookies = getCookies(legacyLogin);
    const legacySessionCookie = legacyLoginCookies.find(cookie => cookie.startsWith('connect.sid='));
    const defaultCompanyCookie = legacyLoginCookies.find(cookie => cookie.startsWith(`${COMPANY_CONTEXT_COOKIE}=`));
    assert.ok(legacySessionCookie);
    assert.ok(defaultCompanyCookie, legacyLogin.headers.get('set-cookie'));
    const legacyProbe = await fetch(`${baseUrl}/api/probe`, {
      headers: { Cookie: `${legacySessionCookie}; ${defaultCompanyCookie}` }
    });
    assert.deepEqual(await legacyProbe.json(), { marker: 'existing workspace data' });

    const existingLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'old-user',
        password: 'old-password',
        company_code: 'existing-company'
      })
    });
    assert.equal(existingLogin.status, 200);
    assert.deepEqual(await existingLogin.json(), { user: 'old-user', marker: 'existing workspace data' });
    const existingCookies = getCookies(existingLogin);
    const existingSessionCookie = existingCookies.find(cookie => cookie.startsWith('connect.sid='));
    const companyCookie = existingCookies.find(cookie => cookie.startsWith(`${COMPANY_CONTEXT_COOKIE}=`));
    assert.ok(existingSessionCookie);
    assert.ok(companyCookie);
    const existingProbe = await fetch(`${baseUrl}/api/probe`, {
      headers: { Cookie: `${existingSessionCookie}; ${companyCookie}` }
    });
    assert.deepEqual(await existingProbe.json(), { marker: 'existing workspace data' });

    companies.get('existing-company').status = 'suspended';
    const suspendedExistingProbe = await fetch(`${baseUrl}/api/probe`, {
      headers: { Cookie: `${existingSessionCookie}; ${companyCookie}` }
    });
    assert.equal(suspendedExistingProbe.status, 403);
    const suspendedDefaultLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'old-user', password: 'old-password', company_code: '' })
    });
    assert.equal(suspendedDefaultLogin.status, 200);
    companies.get('existing-company').status = 'active';

    const wrongCompanyLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'old-user',
        password: 'old-password',
        company_code: 'second-company'
      })
    });
    assert.equal(wrongCompanyLogin.status, 401);

    const secondLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'new-user',
        password: 'new-password',
        company_code: 'second-company'
      })
    });
    assert.equal(secondLogin.status, 200);
    assert.deepEqual(await secondLogin.json(), { user: 'new-user', marker: 'second workspace data' });
    const secondCookies = getCookies(secondLogin);
    const secondSessionCookie = secondCookies.find(cookie => cookie.startsWith('connect.sid='));
    const secondCompanyCookie = secondCookies.find(cookie => cookie.startsWith(`${COMPANY_CONTEXT_COOKIE}=`));
    const crossTenantProbe = await fetch(`${baseUrl}/api/probe`, {
      headers: { Cookie: `${secondSessionCookie}; ${companyCookie}` }
    });
    assert.equal(crossTenantProbe.status, 200);
    assert.deepEqual(await crossTenantProbe.json(), { marker: 'second workspace data' });
    const mismatchedCompanyCookieProbe = await fetch(`${baseUrl}/api/probe`, {
      headers: { Cookie: `${existingSessionCookie}; ${secondCompanyCookie}` }
    });
    assert.equal(mismatchedCompanyCookieProbe.status, 200);
    assert.deepEqual(await mismatchedCompanyCookieProbe.json(), { marker: 'existing workspace data' });
    const ignoredClientCompanyCode = await fetch(`${baseUrl}/api/context`, {
      method: 'POST',
      headers: {
        Cookie: `${secondSessionCookie}; ${companyCookie}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ company_code: 'existing-company' })
    });
    assert.deepEqual(await ignoredClientCompanyCode.json(), { tenantId: 202, companyStatus: 'trial' });

    const tamperedCookie = companyCookie.replace(/.$/, companyCookie.endsWith('a') ? 'b' : 'a');
    const tamperedContext = await fetch(`${baseUrl}/api/context`, {
      headers: { Cookie: tamperedCookie }
    });
    assert.deepEqual(await tamperedContext.json(), { tenantId: 'legacy', companyStatus: null });
    assert.equal(tamperedContext.headers.get('set-cookie'), null);

    const unknownCompanyLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'old-user',
        password: 'old-password',
        company_code: 'not-registered'
      })
    });
    assert.equal(unknownCompanyLogin.status, 401);

    const invalidTypeCompanyLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'old-user',
        password: 'old-password',
        company_code: 123
      })
    });
    assert.equal(invalidTypeCompanyLogin.status, 401);

    const suspendedContext = await fetch(`${baseUrl}/api/context`, {
      headers: { Cookie: `${COMPANY_CONTEXT_COOKIE}=${signCompanyCode('suspended-company', sessionSecret)}` }
    });
    assert.deepEqual(await suspendedContext.json(), { tenantId: 'legacy', companyStatus: null });
    assert.equal(suspendedContext.headers.get('set-cookie'), null);

    companies.get('second-company').status = 'cancelled';
    const cancelledSessionRequest = await fetch(`${baseUrl}/api/context`, {
      headers: { Cookie: secondSessionCookie }
    });
    assert.equal(cancelledSessionRequest.status, 200);
    assert.deepEqual(await cancelledSessionRequest.json(), { tenantId: 202, companyStatus: 'cancelled' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
