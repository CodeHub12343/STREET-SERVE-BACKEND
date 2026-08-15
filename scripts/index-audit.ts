/**
 * Which schema-declared indexes are missing from the database?
 *
 * Mongoose `autoIndex` used to create these at boot, which hid the fact that the migrations did not
 * cover them. Turning it off (correctly — indexes are migrations, not a boot side effect) made the
 * gap real: `events` lost its 2dsphere index and every `/events/nearby` request began returning 500
 * with "unable to find index for $geoNear query".
 *
 * Read-only. Reports; never creates. Run:
 *   MONGODB_URI=... npx tsx scripts/index-audit.ts
 */
import mongoose from 'mongoose';

// Importing the app registers every module's models on the mongoose singleton.
import './../src/app';

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  /**
   * `autoIndex: false` is load-bearing, not tidiness.
   *
   * Mongoose builds every registered model's indexes on connect by default, so the first run of
   * this "read-only audit" silently CREATED the indexes it was written to report — including the
   * events 2dsphere whose absence was returning 500s. It reported a clean database it had just
   * cleaned itself. An audit that repairs what it measures cannot be trusted to measure anything.
   */
  await mongoose.connect(uri, { autoIndex: false });

  const names = Object.keys(mongoose.models).sort();
  let missingTotal = 0;

  for (const name of names) {
    const model = mongoose.models[name]!;
    let diff: { toDrop: string[]; toCreate: unknown[] };
    try {
      diff = (await model.diffIndexes()) as { toDrop: string[]; toCreate: unknown[] };
    } catch (e) {
      console.log(`${name.padEnd(28)} ERROR ${(e as Error).message}`);
      continue;
    }
    if (diff.toCreate.length === 0) continue;
    missingTotal += diff.toCreate.length;
    console.log(`${name.padEnd(28)} collection=${model.collection.collectionName}`);
    for (const spec of diff.toCreate) {
      console.log(`    MISSING ${JSON.stringify(spec)}`);
    }
  }

  console.log(`\nmodels checked: ${names.length}`);
  console.log(`indexes missing from the database: ${missingTotal}`);

  await mongoose.disconnect();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('FAILED:', (e as Error).message);
    process.exit(1);
  },
);
