'use strict';

const { randomBytes } = require('node:crypto');
const nodemailer = require('nodemailer');

function smtpConfiguration(environment) {
  const host = String(environment.SMTP_HOST || '').trim();
  const portValue = String(environment.SMTP_PORT || '').trim();
  const username = String(environment.SMTP_USER || '').trim();
  const password = String(environment.SMTP_PASSWORD || '');
  const from = String(environment.SMTP_FROM || '').trim();
  const configured = Boolean(host || portValue || username || password || from);
  if (!configured) return null;

  const port = /^\d+$/.test(portValue) ? Number(portValue) : NaN;
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !from
    || Boolean(username) !== Boolean(password)) {
    throw new TypeError('SMTP_HOST, SMTP_PORT, SMTP_FROM, and both SMTP_USER/SMTP_PASSWORD when authenticated are required.');
  }
  const secureValue = String(environment.SMTP_SECURE || '').trim().toLowerCase();
  if (secureValue && !['true', 'false'].includes(secureValue)) {
    throw new TypeError('SMTP_SECURE must be true or false.');
  }
  return {
    host,
    port,
    secure: secureValue ? secureValue === 'true' : port === 465,
    auth: username ? { user: username, pass: password } : undefined,
    from
  };
}

function resendConfiguration(environment) {
  const apiKey = String(environment.RESEND_API_KEY || '').trim();
  const from = String(environment.RESEND_FROM || '').trim();
  if (!apiKey || !from) {
    throw new TypeError('RESEND_API_KEY and RESEND_FROM are required when MAIL_PROVIDER=resend.');
  }
  return { apiKey, from };
}

function gmailConfiguration(environment) {
  const clientId = String(environment.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(environment.GMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = String(environment.GMAIL_REFRESH_TOKEN || '').trim();
  const from = String(environment.GMAIL_FROM || '').trim();
  if (!clientId || !clientSecret || !refreshToken || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new TypeError('GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, and a valid GMAIL_FROM are required when MAIL_PROVIDER=gmail.');
  }
  return { clientId, clientSecret, refreshToken, from };
}

function encodeMimeBody(value) {
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  return base64.match(/.{1,76}/g)?.join('\r\n') || '';
}

function gmailRawMessage({ from, to, subject, text, html }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0'
  ];
  let body;
  if (typeof text === 'string' && typeof html === 'string') {
    const boundary = `taskflow-${randomBytes(18).toString('hex')}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeMimeBody(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeMimeBody(html),
      `--${boundary}--`,
      ''
    ].join('\r\n');
  } else {
    const content = typeof text === 'string' ? text : html;
    headers.push(`Content-Type: ${typeof text === 'string' ? 'text/plain' : 'text/html'}; charset=UTF-8`);
    headers.push('Content-Transfer-Encoding: base64');
    body = encodeMimeBody(content);
  }
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64');
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createMailer({
  environment = process.env,
  createTransport = nodemailer.createTransport,
  fetchImpl = globalThis.fetch,
  logger = console.warn
} = {}) {
  if (!environment || typeof environment !== 'object') throw new TypeError('Mailer environment must be an object.');
  if (typeof createTransport !== 'function') throw new TypeError('SMTP transport factory must be a function.');
  if (typeof fetchImpl !== 'function') throw new TypeError('Email API fetch implementation must be a function.');
  if (typeof logger !== 'function') throw new TypeError('Mailer logger must be a function.');
  const requestedProvider = String(environment.MAIL_PROVIDER || '').trim().toLowerCase();
  if (requestedProvider && !['smtp', 'resend', 'gmail'].includes(requestedProvider)) {
    throw new TypeError('MAIL_PROVIDER must be smtp, resend, or gmail.');
  }
  const provider = requestedProvider || (environment.GMAIL_CLIENT_ID
    ? 'gmail'
    : environment.RESEND_API_KEY ? 'resend' : 'smtp');
  const config = provider === 'gmail'
    ? gmailConfiguration(environment)
    : provider === 'resend' ? resendConfiguration(environment) : smtpConfiguration(environment);
  const transport = provider === 'smtp' && config ? createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    tls: { rejectUnauthorized: true },
    ...(config.auth ? { auth: config.auth } : {})
  }) : null;

  return Object.freeze({
    name: provider,
    isConfigured: () => Boolean(config),
    async send(message) {
      const recipient = typeof message?.to === 'string' ? message.to.trim().slice(0, 254) : '';
      const subject = typeof message?.subject === 'string' ? message.subject.trim() : '';
      if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
        || !subject || /[\r\n]/.test(subject)
        || (typeof message?.text !== 'string' && typeof message?.html !== 'string')) {
        throw new TypeError('Mail requires a valid recipient, subject, and text or HTML content.');
      }
      if (!config || (provider === 'smtp' && !transport)) {
        throw new Error(`${provider.toUpperCase()} email delivery is not configured.`);
      }
      try {
        if (provider === 'resend') {
          const response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: config.from,
              to: [recipient],
              subject,
              ...(typeof message.text === 'string' ? { text: message.text } : {}),
              ...(typeof message.html === 'string' ? { html: message.html } : {})
            }),
            signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) throw new Error(`Resend email API returned HTTP ${response.status}.`);
        } else if (provider === 'gmail') {
          const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: config.refreshToken,
              grant_type: 'refresh_token'
            }),
            signal: AbortSignal.timeout(10000)
          });
          if (!tokenResponse.ok) throw new Error(`Google OAuth token endpoint returned HTTP ${tokenResponse.status}.`);
          const token = await tokenResponse.json();
          if (typeof token.access_token !== 'string' || !token.access_token) {
            throw new Error('Google OAuth token endpoint returned no access token.');
          }
          const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token.access_token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              raw: gmailRawMessage({
                from: config.from,
                to: recipient,
                subject,
                text: message.text,
                html: message.html
              })
            }),
            signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) throw new Error(`Gmail API returned HTTP ${response.status}.`);
        } else {
          const result = await transport.sendMail({
            from: config.from,
            to: recipient,
            subject,
            ...(typeof message.text === 'string' ? { text: message.text } : {}),
            ...(typeof message.html === 'string' ? { html: message.html } : {})
          });
          if (!Array.isArray(result.accepted) || result.accepted.length === 0) {
            throw new Error('SMTP server did not accept the message.');
          }
        }
        return { accepted: true, previewed: false };
      } catch (error) {
        logger(JSON.stringify({ event: `${provider}_delivery_failed` }));
        throw error;
      }
    }
  });
}

module.exports = { ...createMailer(), createMailer };