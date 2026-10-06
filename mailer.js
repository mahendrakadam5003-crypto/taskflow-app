'use strict';

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
  if (requestedProvider && !['smtp', 'resend'].includes(requestedProvider)) {
    throw new TypeError('MAIL_PROVIDER must be smtp or resend.');
  }
  const provider = requestedProvider || (environment.RESEND_API_KEY ? 'resend' : 'smtp');
  const config = provider === 'resend' ? resendConfiguration(environment) : smtpConfiguration(environment);
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
      if (!config || (provider === 'smtp' && !transport)) throw new Error('SMTP email delivery is not configured.');
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