'use strict';

const telegramStorage = require('./telegram-storage');

const telegramAdapter = {
  name: 'telegram',
  isConfigured: () => typeof telegramStorage.isConfigured === 'function'
    ? telegramStorage.isConfigured()
    : Boolean(process.env.TELEGRAM_BOT_TOKEN),
  upload: (file, options) => telegramStorage.uploadToTelegram(file, options),
  stream: (fileId, res, metadata) => telegramStorage.streamFromTelegram(fileId, res, metadata),
  delete: reference => telegramStorage.deleteTelegramMessage(reference.messageId)
};

function createStorageProvider(adapter = telegramAdapter) {
  for (const method of ['isConfigured', 'upload', 'stream', 'delete']) {
    if (typeof adapter?.[method] !== 'function') throw new TypeError(`Storage provider must implement ${method}().`);
  }
  return Object.freeze({
    name: adapter.name || 'custom',
    isConfigured: (...args) => adapter.isConfigured(...args),
    upload: (...args) => adapter.upload(...args),
    stream: (...args) => adapter.stream(...args),
    delete: (...args) => adapter.delete(...args)
  });
}

module.exports = { ...createStorageProvider(), createStorageProvider };