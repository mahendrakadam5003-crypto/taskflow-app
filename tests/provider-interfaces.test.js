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

test('SMTP mailer sends configured messages without logging recipients or message contents', async () => {
  const logs = [];
  const messages = [];
  const mailer = createMailer({
    environment: {
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
      SMTP_USER: 'smtp-user',
      SMTP_PASSWORD: 'smtp-secret',
      SMTP_FROM: 'TaskFlow <noreply@example.test>'
    },
    logger: entry => logs.push(entry),
    createTransport: options => {
      assert.equal(options.requireTLS, true);
      assert.equal(options.tls.rejectUnauthorized, true);
      return { async sendMail(message) { messages.push(message); return { accepted: [message.to] }; } };
    }
  });
  const result = await mailer.send({
    to: 'person@example.test',
    subject: 'Password reset',
    text: 'reset_token=private'
  });

  assert.deepEqual(result, { accepted: true, previewed: false });
  assert.equal(mailer.isConfigured(), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'person@example.test');
  assert.doesNotMatch(JSON.stringify(logs), /person@example\.test|reset_token|smtp-secret/);
  await assert.rejects(createMailer({ environment: {} }).send({
    to: 'person@example.test', subject: 'Reset', text: 'token'
  }), /SMTP email delivery is not configured/);
});

test('Resend mailer sends through HTTPS without creating an SMTP transport', async () => {
  const requests = [];
  const mailer = createMailer({
    environment: {
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_secret',
      RESEND_FROM: 'TaskFlow <noreply@example.test>'
    },
    createTransport() {
      assert.fail('Resend delivery must not initialize SMTP.');
    },
    async fetchImpl(url, options) {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    }
  });

  assert.equal(mailer.name, 'resend');
  assert.equal(mailer.isConfigured(), true);
  assert.deepEqual(await mailer.send({
    to: 'person@example.test',
    subject: 'Password reset',
    text: 'reset_token=private'
  }), { accepted: true, previewed: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer re_test_secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    from: 'TaskFlow <noreply@example.test>',
    to: ['person@example.test'],
    subject: 'Password reset',
    text: 'reset_token=private'
  });
});

test('Resend mailer reports API failures without logging message data or credentials', async () => {
  const logs = [];
  const mailer = createMailer({
    environment: {
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_secret',
      RESEND_FROM: 'noreply@example.test'
    },
    logger: entry => logs.push(entry),
    async fetchImpl() { return { ok: false, status: 403 }; }
  });

  await assert.rejects(mailer.send({
    to: 'person@example.test',
    subject: 'Password reset',
    text: 'reset_token=private'
  }), /Resend email API returned HTTP 403/);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /person@example\.test|reset_token|re_test_secret/);
});

test('Resend mailer requires an API key and verified sender configuration', () => {
  assert.throws(() => createMailer({
    environment: { MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_secret' }
  }), /RESEND_API_KEY and RESEND_FROM are required/);
  assert.throws(() => createMailer({
    environment: { MAIL_PROVIDER: 'invalid' }
  }), /MAIL_PROVIDER must be smtp, resend, or gmail/);
});

test('Gmail mailer refreshes OAuth credentials and sends encoded MIME through HTTPS', async () => {
  const requests = [];
  const mailer = createMailer({
    environment: {
      MAIL_PROVIDER: 'gmail',
      GMAIL_CLIENT_ID: 'client-id',
      GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_REFRESH_TOKEN: 'refresh-token',
      GMAIL_FROM: 'sender@gmail.com'
    },
    createTransport() {
      assert.fail('Gmail API delivery must not initialize SMTP.');
    },
    async fetchImpl(url, options) {
      requests.push({ url, options });
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, status: 200, async json() { return { access_token: 'access-token' }; } };
      }
      return { ok: true, status: 200 };
    }
  });

  assert.equal(mailer.name, 'gmail');
  assert.equal(mailer.isConfigured(), true);
  assert.deepEqual(await mailer.send({
    to: 'person@example.test',
    subject: 'Reset your password',
    text: 'reset_token=private',
    html: '<p>reset_token=private</p>'
  }), { accepted: true, previewed: false });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].options.body)), {
    client_id: 'client-id',
    client_secret: 'client-secret',
    refresh_token: 'refresh-token',
    grant_type: 'refresh_token'
  });
  assert.equal(requests[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer access-token');
  const raw = JSON.parse(requests[1].options.body).raw;
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4), 'base64').toString('utf8');
  assert.match(mime, /From: sender@gmail\.com/);
  assert.match(mime, /To: person@example\.test/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /cmVzZXRfdG9rZW49cHJpdmF0ZQ==/);
});

test('Gmail mailer logs only a safe event when Google rejects a message', async () => {
  const logs = [];
  const mailer = createMailer({
    environment: {
      MAIL_PROVIDER: 'gmail',
      GMAIL_CLIENT_ID: 'client-id',
      GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_REFRESH_TOKEN: 'refresh-token',
      GMAIL_FROM: 'sender@gmail.com'
    },
    logger: entry => logs.push(entry),
    async fetchImpl(url) {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok: true, status: 200, async json() { return { access_token: 'access-token' }; } };
      }
      return { ok: false, status: 403 };
    }
  });

  await assert.rejects(mailer.send({
    to: 'person@example.test',
    subject: 'Password reset',
    text: 'reset_token=private'
  }), /Gmail API returned HTTP 403/);
  assert.deepEqual(logs, ['{"event":"gmail_delivery_failed"}']);
  assert.doesNotMatch(JSON.stringify(logs), /person@example\.test|reset_token|client-secret|refresh-token/);
});

test('Gmail mailer requires complete OAuth credentials and a valid sender', () => {
  assert.throws(() => createMailer({
    environment: { MAIL_PROVIDER: 'gmail' }
  }), /GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, and a valid GMAIL_FROM/);
  assert.throws(() => createMailer({
    environment: {
      MAIL_PROVIDER: 'gmail',
      GMAIL_CLIENT_ID: 'client-id',
      GMAIL_CLIENT_SECRET: 'client-secret',
      GMAIL_REFRESH_TOKEN: 'refresh-token',
      GMAIL_FROM: 'not-an-email'
    }
  }), /GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, and a valid GMAIL_FROM/);
});
