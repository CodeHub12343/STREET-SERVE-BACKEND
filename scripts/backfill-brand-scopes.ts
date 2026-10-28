/* eslint-disable no-console */
/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 4 follows + reviews backfill. ═══
 *
 * Idempotent AND reversible. Walks every follow + review that references a business belonging
 * to a brand, and sets `brand_id` on it. Follows that resolve to the same `(follower, brand)`
 * pair after backfill are collapsed to one row — the brand-level follow is the Phase-4 model.
 *
 * Usage:
 *   npx ts-node scripts/backfill-brand-scopes.ts
 *   npx ts-node scripts/backfill-brand-scopes.ts --dry
 *   npx ts-node scripts/backfill-brand-scopes.ts --rollback   # unsets brand_id on both
 *
 * Reversibility: `--rollback` clears `brand_id` on both collections (follow deduping is NOT
 * undone — a follow that was already de-duplicated stays single). Reversible rollback is for
 * emergency unwinding of the field, not for recovering collapsed duplicates.
 */
import { connectMongo, disconnectMongo } from '../src/config/db';
import { logger } from '../src/config/logger';
import { BrandModel } from '../src/modules/brands/brands.model';
import { BusinessModel } from '../src/modules/vendors/vendors.model';
import { FollowModel } from '../src/modules/livemap/livemap.model';
import { ReviewModel } from '../src/modules/reviews/reviews.model';

async function buildBusinessToBrandMap() {
  const businesses = await BusinessModel.find({ brand_id: { $ne: null } })
    .select('_id brand_id')
    .lean()
    .exec();
  return new Map(
    businesses.map((b) => [String(b._id), String(b.brand_id)]),
  );
}

async function backfillFollows(businessToBrand: Map<string, string>, dry: boolean) {
  const follows = await FollowModel.find({ brand_id: null }).lean().exec();
  console.log(`Follows without brand_id: ${follows.length}`);
  if (dry) return { migrated: 0, collapsed: 0, skipped: follows.length };

  let migrated = 0;
  let collapsed = 0;
  let skipped = 0;
  for (const f of follows) {
    const brandId = businessToBrand.get(String(f.business_id));
    if (!brandId) {
      /** Business has no brand — this row stays legacy, which is still a valid shape. */
      skipped += 1;
      continue;
    }
    /**
     * A row with the same (follower, brand) pair may already exist (the user followed two
     * trucks of the same brand). Collapse: delete this row, leave the existing one.
     */
    const already = await FollowModel.findOne({
      follower_user_id: f.follower_user_id,
      brand_id: brandId,
    })
      .lean()
      .exec();
    if (already) {
      await FollowModel.deleteOne({ _id: f._id }).exec();
      collapsed += 1;
      continue;
    }
    await FollowModel.updateOne({ _id: f._id }, { $set: { brand_id: brandId } }).exec();
    migrated += 1;
  }
  console.log(`Follows: migrated=${migrated} collapsed=${collapsed} skipped=${skipped}`);
  return { migrated, collapsed, skipped };
}

async function backfillReviews(businessToBrand: Map<string, string>, dry: boolean) {
  const reviews = await ReviewModel.find({
    subject_type: 'business',
    brand_id: null,
  })
    .select('_id subject_id')
    .lean()
    .exec();
  console.log(`Reviews without brand_id: ${reviews.length}`);
  if (dry) return { migrated: 0, skipped: reviews.length };

  let migrated = 0;
  let skipped = 0;
  for (const r of reviews) {
    const brandId = businessToBrand.get(String(r.subject_id));
    if (!brandId) {
      skipped += 1;
      continue;
    }
    await ReviewModel.updateOne({ _id: r._id }, { $set: { brand_id: brandId } }).exec();
    migrated += 1;
  }
  console.log(`Reviews: migrated=${migrated} skipped=${skipped}`);
  return { migrated, skipped };
}

async function rollback() {
  const followUnset = await FollowModel.updateMany(
    { brand_id: { $ne: null } },
    { $set: { brand_id: null } },
  ).exec();
  const reviewUnset = await ReviewModel.updateMany(
    { brand_id: { $ne: null } },
    { $set: { brand_id: null } },
  ).exec();
  console.log(
    `Rollback: cleared brand_id on ${followUnset.modifiedCount} follows, ${reviewUnset.modifiedCount} reviews. Note: previously collapsed follows are NOT restored.`,
  );
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isRollback = args.has('--rollback');
  const isDry = args.has('--dry');
  if (isRollback && isDry) {
    throw new Error('--rollback and --dry cannot be combined');
  }
  console.log(
    `backfill-brand-scopes.ts: mode=${isRollback ? 'rollback' : isDry ? 'dry-run' : 'migrate'}`,
  );
  await connectMongo();
  try {
    if (isRollback) {
      await rollback();
    } else {
      /**
       * Build the business → brand map once. Brands are a few hundred rows at most; businesses
       * with a non-null brand_id are the subset of them. Both fit comfortably in memory even at
       * the scale this phase expects.
       */
      void (await BrandModel.estimatedDocumentCount().exec()); // smoke-check the collection exists
      const map = await buildBusinessToBrandMap();
      console.log(`Businesses with a brand: ${map.size}`);
      await backfillFollows(map, isDry);
      await backfillReviews(map, isDry);
    }
  } finally {
    await disconnectMongo();
  }
}

main().catch((err) => {
  logger.error({ err }, 'backfill-brand-scopes failed');
  process.exitCode = 1;
});
