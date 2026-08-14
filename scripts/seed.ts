/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'node:fs';
import path from 'node:path';

import { connectMongo, disconnectMongo, mongoose } from '../src/config/db';
import { logger } from '../src/config/logger';

/**
 * Dev convenience: apply the reference-data seed migrations against the configured database.
 * In CI/prod, `npm run migrate:up` runs the same migrations as part of the release, before rollout.
 *
 * Applies every `*-seed-*` migration in filename order (they are idempotent upserts), so adding a
 * new seed migration needs no change here. Index migrations are deliberately NOT run: in dev
 * Mongoose autoIndex has usually already built equivalent indexes under different names, which
 * makes `migrate:up` fail on a conflict — use `migrate:up` against a clean/CI database.
 */
async function run(): Promise<void> {
  await connectMongo();
  const db = mongoose.connection.db;
  if (!db) throw new Error('no active mongo connection');

  const dir = path.join(__dirname, '..', 'migrations');
  const seeds = fs
    .readdirSync(dir)
    .filter((f) => f.includes('-seed-') && f.endsWith('.js'))
    .sort();

  if (seeds.length === 0) throw new Error('no seed migrations found');

  for (const file of seeds) {
    const seed = require(path.join(dir, file)) as { up: (db: unknown) => Promise<void> };
    await seed.up(db);
    logger.info({ file }, 'seed migration applied');
  }

  logger.info({ count: seeds.length }, 'reference data seeded');
  await disconnectMongo();
}

run().catch((err) => {
  logger.error({ err }, 'seed failed');
  process.exit(1);
});
