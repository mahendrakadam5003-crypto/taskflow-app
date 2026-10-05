'use strict';

const express = require('express');
const path = require('node:path');

function createPublicPagesRouter(publicDirectory) {
  const router = express.Router();
  router.get('/', (req, res) => res.sendFile(path.join(publicDirectory, 'landing.html')));
  router.get('/app', (req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));
  router.get('/employee-data-notice', (req, res) => res.sendFile(path.join(publicDirectory, 'employee-data-notice.html')));
  return router;
}

module.exports = { createPublicPagesRouter };
