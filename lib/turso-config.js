function getConfiguredTursoDatabaseName(value = process.env.TURSO_DATABASE) {
  const databaseName = typeof value === 'string' ? value.trim() : '';
  if (!databaseName) throw new Error('TURSO_DATABASE must identify the Turso database.');
  return databaseName;
}

module.exports = { getConfiguredTursoDatabaseName };
