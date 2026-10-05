'use strict';

function createMailer({ logger = console.log } = {}) {
  if (typeof logger !== 'function') throw new TypeError('Mailer logger must be a function.');
  return Object.freeze({
    name: 'console',
    async send(message) {
      const recipient = typeof message?.to === 'string' ? message.to.trim().slice(0, 254) : '';
      if (!recipient || typeof message?.subject !== 'string' || !message.subject.trim()) {
        throw new TypeError('Mail requires a recipient and subject.');
      }
      logger(JSON.stringify({ event: 'mail_preview', provider: 'console', to: recipient, bodyLogged: false }));
      return { accepted: false, previewed: true };
    }
  });
}

module.exports = { ...createMailer(), createMailer };