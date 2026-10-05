function getConfiguredTursoDatabaseName(value = process.env.TURSO_DATABASE) {
  const databaseName = typeof value === 'string' ? value.trim() : '';
  if (databaseName) return databaseName;

  const databaseUrl = process.env.TURSO_DATABASE_URL;
  if (databaseUrl) {
    let databaseHost;
    try {
      databaseHost = new URL(databaseUrl).hostname;
    } catch (error) {
      throw new Error('TURSO_DATABASE_URL must be a valid URL.', { cause: error });
    }
    if (databaseHost) return databaseHost;
  }

  throw new Error('TURSO_DATABASE or a valid TURSO_DATABASE_URL must identify the Turso database.');
}

module.exports = { getConfiguredTursoDatabaseName };
