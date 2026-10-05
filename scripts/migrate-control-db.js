'use strict';

const { closeControlDatabase, getControlDatabase } = require('../control-db');

getControlDatabase()
  .then(() => {
    console.log('Control database schema is up to date.');
  })
  .catch(error => {
    console.error(`Control database migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closeControlDatabase);
