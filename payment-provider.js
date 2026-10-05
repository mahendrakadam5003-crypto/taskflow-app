'use strict';

const manualAdapter = Object.freeze({
  name: 'manual',
  async createCheckout() {
    return { provider: 'manual', status: 'manual', checkoutUrl: null };
  },
  async verifyWebhook() {
    return { verified: false, event: null };
  }
});

function createPaymentProvider(adapter = manualAdapter) {
  for (const method of ['createCheckout', 'verifyWebhook']) {
    if (typeof adapter?.[method] !== 'function') throw new TypeError(`Payment provider must implement ${method}().`);
  }
  return Object.freeze({
    name: adapter.name || 'custom',
    createCheckout: (...args) => adapter.createCheckout(...args),
    verifyWebhook: (...args) => adapter.verifyWebhook(...args)
  });
}

module.exports = { ...createPaymentProvider(), createPaymentProvider };