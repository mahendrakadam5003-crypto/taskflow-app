'use strict';

const { closeControlDatabase, getControlDatabase } = require('../control-db');

getControlDatabase()
  .then(() => {
    console.log('Control database schema is up to date.');
  })
  .catch(() => {
    console.error('Control database migration failed.');
    process.exitCode = 1;
  })
  .finally(closeControlDatabase);
