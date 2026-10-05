'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { after, before, test } = require('node:test');
const path = require('node:path');
const { createPublicPagesRouter } = require('../routes/public-pages');

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(createPublicPagesRouter(path.join(__dirname, '..', 'public')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
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
  assert.match(await landing.text(), /TaskFlow \| Team work, in sync/);

  const workspace = await fetch(`${baseUrl}/app`);
  assert.equal(workspace.status, 200);
  assert.match(await workspace.text(), /id="login-screen"/);

  const privacy = await fetch(`${baseUrl}/privacy.html`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Demo request privacy notice/);

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
