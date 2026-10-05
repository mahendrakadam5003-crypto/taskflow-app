'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createStorageProvider } = require('../storage-provider');
const { createPaymentProvider } = require('../payment-provider');
const { createMailer } = require('../mailer');

test('storage provider delegates the stable upload, stream, and delete contract', async () => {
  const calls = [];
  const provider = createStorageProvider({
    name: 'test',
    isConfigured: () => true,
    async upload(file, options) { calls.push(['upload', file, options]); return { fileId: 'object-key' }; },
    async stream(fileId, res, metadata) { calls.push(['stream', fileId, res, metadata]); },
    async delete(reference) { calls.push(['delete', reference]); }
  });
  const response = {};

  assert.equal(provider.name, 'test');
  assert.equal(provider.isConfigured(), true);
  assert.deepEqual(await provider.upload('file', { companyId: 12 }), { fileId: 'object-key' });
  await provider.stream('object-key', response, { disposition: 'attachment' });
  await provider.delete({ fileId: 'object-key' });
  assert.deepEqual(calls, [
    ['upload', 'file', { companyId: 12 }],
    ['stream', 'object-key', response, { disposition: 'attachment' }],
    ['delete', { fileId: 'object-key' }]
  ]);
});

test('manual payment provider reports manual handling and rejects webhook verification', async () => {
  const provider = createPaymentProvider();
  assert.equal(provider.name, 'manual');
  assert.deepEqual(await provider.createCheckout({ companyId: 12, amount: 1000, currency: 'INR' }), {
    provider: 'manual', status: 'manual', checkoutUrl: null
  });
  assert.deepEqual(await provider.verifyWebhook({ body: {} }), { verified: false, event: null });
});

test('console mailer logs recipient metadata but never message contents', async () => {
  const logs = [];
  const mailer = createMailer({ logger: entry => logs.push(entry) });
  const result = await mailer.send({
    to: 'person@example.test',
    subject: 'Password reset',
    text: 'reset_token=private password=private'
  });

  assert.deepEqual(result, { accepted: false, previewed: true });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /person@example\.test/);
  assert.doesNotMatch(logs[0], /reset_token|password=private/);
});