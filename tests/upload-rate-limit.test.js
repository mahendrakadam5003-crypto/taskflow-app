'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const uploadRateLimit = require('../upload-rate-limit');

let server;

before(async () => {
  const app = express();
  app.post('/comments', uploadRateLimit, (req, res) => res.sendStatus(204));
  app.post('/receipts', uploadRateLimit, (req, res) => res.sendStatus(204));
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('upload rate limit is shared across upload routes', async () => {
  const { port } = server.address();
  const statuses = [];
  for (let index = 0; index < 21; index++) {
    const route = index % 2 === 0 ? 'comments' : 'receipts';
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method: 'POST' });
    statuses.push(response.status);
  }

  assert.ok(statuses.slice(0, 20).every(status => status === 204));
  assert.equal(statuses[20], 429);
});