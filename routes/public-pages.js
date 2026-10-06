'use strict';

const express = require('express');
const path = require('node:path');

const APP_SHELL_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';

function createAppShellSetHeaders(publicDirectory) {
  const noCacheFiles = new Set(['index.html', 'service-worker.js', 'manifest.webmanifest']);
  return (res, filePath) => {
    const relativePath = path.relative(publicDirectory, filePath).replace(/\\/g, '/');
    if (noCacheFiles.has(relativePath) || relativePath.startsWith('js/') || relativePath.startsWith('css/')) {
      res.setHeader('Cache-Control', APP_SHELL_CACHE_CONTROL);
    }
  };
}

function createPublicPagesRouter(publicDirectory) {
  const router = express.Router();
  router.get('/', (req, res) => res.sendFile(path.join(publicDirectory, 'landing.html')));
  router.get('/app', (req, res) => {
    res.setHeader('Cache-Control', APP_SHELL_CACHE_CONTROL);
    res.sendFile(path.join(publicDirectory, 'index.html'));
  });
  router.get('/employee-data-notice', (req, res) => res.sendFile(path.join(publicDirectory, 'employee-data-notice.html')));
  return router;
}

module.exports = { createAppShellSetHeaders, createPublicPagesRouter };
