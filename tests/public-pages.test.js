'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { after, before, test } = require('node:test');
const path = require('node:path');
const { createAppShellSetHeaders, createPublicPagesRouter } = require('../routes/public-pages');

let server;
let baseUrl;

before(async () => {
  const app = express();
  const publicDirectory = path.join(__dirname, '..', 'public');
  app.use(createPublicPagesRouter(publicDirectory));
  app.use(express.static(publicDirectory, { setHeaders: createAppShellSetHeaders(publicDirectory) }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('public root serves landing page and /app preserves the workspace login', async () => {
  const landing = await fetch(baseUrl);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /TaskFlow \| Team work, in sync/);
  assert.match(landingHtml, /rel="canonical"/);
  assert.match(landingHtml, /id="site-navigation"/);
  assert.match(landingHtml, /id="faq"/);
  assert.match(landingHtml, /id="price-cards"/);
  assert.match(landingHtml, /id="demo-plan-interest"/);

  const workspace = await fetch(`${baseUrl}/app`);
  assert.equal(workspace.status, 200);
  assert.match(workspace.headers.get('cache-control'), /no-store/);
  assert.match(await workspace.text(), /id="login-screen"/);

  const appScript = await fetch(`${baseUrl}/js/app.js`);
  assert.equal(appScript.status, 200);
  assert.match(appScript.headers.get('cache-control'), /no-store/);

  const privacy = await fetch(`${baseUrl}/privacy.html`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Demo request privacy notice/);

  const employeeNotice = await fetch(`${baseUrl}/employee-data-notice`);
  assert.equal(employeeNotice.status, 200);
  const employeeNoticeHtml = await employeeNotice.text();
  assert.match(employeeNoticeHtml, /Employee Attendance and Data Notice/);
  assert.match(employeeNoticeHtml, /Turso, Telegram, OpenStreetMap Nominatim/);
  assert.match(employeeNoticeHtml, /No automatic deletion by default/);

  const verifyPage = await fetch(`${baseUrl}/verify-email.html`);
  assert.equal(verifyPage.status, 200);
  assert.match(await verifyPage.text(), /noindex,nofollow/);

  const resetPage = await fetch(`${baseUrl}/password-reset.html`);
  assert.equal(resetPage.status, 200);
  assert.match(await resetPage.text(), /id="password-reset-form"/);

  const robots = await (await fetch(`${baseUrl}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Disallow: \/superadmin/);

  const manifest = await (await fetch(`${baseUrl}/manifest.webmanifest`)).json();
  assert.equal(manifest.start_url, '/app');
});
