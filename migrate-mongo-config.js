/* eslint-env node */
// migrate-mongo configuration. Migrations own indexes + seed data as reviewable, environment-
// promotable scripts (MongoDB is schemaless at the engine level). See DEPLOYMENT_STRATEGY.md §7.
require('dotenv').config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  // eslint-disable-next-line no-console
  console.error('MONGODB_URI is required for migrations');
  process.exit(1);
}

// Derive the database name from the URI path.
let databaseName;
try {
  const parsed = new URL(uri);
  databaseName = parsed.pathname.replace(/^\//, '') || 'streetserve';
} catch {
  databaseName = 'streetserve';
}

module.exports = {
  mongodb: {
    url: uri,
    databaseName,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'migrations_changelog',
  migrationFileExtension: '.js',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
