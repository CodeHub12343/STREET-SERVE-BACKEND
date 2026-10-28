/* eslint-disable no-console */
/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 0 brand backfill. ═══
 *
 * Idempotent AND reversible. For every existing business:
 *
 *   1. If `business.brand_id` is already set, SKIP — the business has already been migrated,
 *      possibly to a multi-business brand by a later admin action.
 *   2. Otherwise create a one-business `Brand` with the business's own `owner_user_id` as the
 *      brand owner, set `business.brand_id` to it, and seed a `BrandMembership` with
 *      `role: 'owner', status: 'active'` for the same user.
 *
 * The idempotency key is the `business.brand_id` field itself: a second run sees the field
 * populated and does nothing. The membership `partialFilterExpression` guards against duplicate
 * active rows if the script is interrupted mid-way.
 *
 * Reversibility: `--rollback` unsets `business.brand_id` on every business that still points at
 * a brand *created by this script* (identified by a tag in the brand's metadata), deletes the
 * brand's owner membership, and then the brand itself. A brand that an admin has since widened
 * (second business attached, additional members invited) is REFUSED by rollback and must be
 * handled manually — the whole point of the tag is to make an auto-rollback safe.
 *
 * Usage:
 *   npx ts-node scripts/backfill-brands.ts           # migrate
 *   npx ts-node scripts/backfill-brands.ts --dry     # count what WOULD be migrated, write nothing
 *   npx ts-node scripts/backfill-brands.ts --rollback
 */
import { Types } from 'mongoose';

import { connectMongo, disconnectMongo } from '../src/config/db';
import { logger } from '../src/config/logger';
import { BrandMembershipModel, BrandModel } from '../src/modules/brands/brands.model';
import { BusinessModel } from '../src/modules/vendors/vendors.model';

/**
 * Tag we add to brands this script creates. Rollback REFUSES to touch brands without this tag,
 * so an operator-created brand is never auto-reversed.
 */
const MIGRATION_TAG = 'phase0-backfill';

interface BrandWithMigration {
  _id: Types.ObjectId;
  __migration?: string;
}

function slugify(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'brand';
  return `${base}-${suffix}`;
}

async function migrate(dryRun: boolean) {
  const businesses = await BusinessModel.find({ brand_id: null }).lean().exec();
  console.log(`Businesses without a brand: ${businesses.length}`);
  if (dryRun) {
    console.log(`[dry-run] would create ${businesses.length} brand(s) + membership(s).`);
    return { migrated: 0, skipped: 0, dryRun: businesses.length };
  }
  let migrated = 0;
  let skipped = 0;
  for (const biz of businesses) {
    /**
     * Re-check inside the loop. A concurrent run (or the same script re-invoked) may have
     * backfilled this row since the initial query — if so, we skip rather than create a second
     * brand for the same business.
     */
    const current = await BusinessModel.findById(biz._id).lean().exec();
    if (!current || current.brand_id) {
      skipped += 1;
      continue;
    }
    const suffix = String(biz._id).slice(-6);
    const brand = await BrandModel.create({
      name: biz.name,
      slug: slugify(biz.name, suffix),
      owner_user_id: biz.owner_user_id,
      logo_url: biz.logo_url ?? null,
      cover_photo_url: biz.cover_photo_url ?? null,
      /** Tag so rollback knows which brands it created. See the docblock above. */
      __migration: MIGRATION_TAG,
    } as unknown as Record<string, unknown>);
    await BusinessModel.updateOne({ _id: biz._id }, { $set: { brand_id: brand._id } }).exec();
    /**
     * Membership upsert — on a mid-run crash and re-run, the partial unique index on
     * (brand_id, user_id) with status in [invited, active] prevents a duplicate active row.
     */
    await BrandMembershipModel.updateOne(
      { brand_id: brand._id, user_id: biz.owner_user_id, status: 'active' },
      {
        $setOnInsert: {
          brand_id: brand._id,
          user_id: biz.owner_user_id,
          role: 'owner',
          scoped_business_ids: [],
          status: 'active',
          accepted_at: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    migrated += 1;
    if (migrated % 25 === 0) console.log(`  … ${migrated} migrated`);
  }
  console.log(`Done. migrated=${migrated} skipped=${skipped}`);
  return { migrated, skipped };
}

async function rollback() {
  /**
   * Only rollback brands THIS SCRIPT created (identified by the migration tag). Any brand that
   * post-dates the backfill (admin-created or widened) is left alone, and the operator is told
   * about it so they can act manually.
   */
  const brands = (await BrandModel.find({ __migration: MIGRATION_TAG }).lean().exec()) as
    unknown as BrandWithMigration[];
  console.log(`Phase-0 brands to roll back: ${brands.length}`);
  let reverted = 0;
  let refused = 0;
  for (const brand of brands) {
    /**
     * Count businesses + non-owner memberships. A brand widened beyond its original one-biz
     * / one-member shape is refused — rollback is for the automatic backfill only, not for
     * production state an admin has touched.
     */
    const [bizCount, memberCount] = await Promise.all([
      BusinessModel.countDocuments({ brand_id: brand._id }).exec(),
      BrandMembershipModel.countDocuments({ brand_id: brand._id, status: 'active' }).exec(),
    ]);
    if (bizCount > 1 || memberCount > 1) {
      console.warn(
        `  REFUSED brand=${String(brand._id)} — widened post-backfill (businesses=${bizCount}, members=${memberCount}). Resolve manually.`,
      );
      refused += 1;
      continue;
    }
    await BusinessModel.updateMany(
      { brand_id: brand._id },
      { $set: { brand_id: null } },
    ).exec();
    await BrandMembershipModel.deleteMany({ brand_id: brand._id }).exec();
    await BrandModel.deleteOne({ _id: brand._id }).exec();
    reverted += 1;
  }
  console.log(`Done. reverted=${reverted} refused=${refused}`);
  return { reverted, refused };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isRollback = args.has('--rollback');
  const isDry = args.has('--dry');
  if (isRollback && isDry) {
    throw new Error('--rollback and --dry cannot be combined');
  }

  console.log(
    `backfill-brands.ts: mode=${isRollback ? 'rollback' : isDry ? 'dry-run' : 'migrate'}`,
  );
  await connectMongo();
  try {
    if (isRollback) await rollback();
    else await migrate(isDry);
  } finally {
    await disconnectMongo();
  }
}

main().catch((err) => {
  logger.error({ err }, 'backfill-brands failed');
  process.exitCode = 1;
});
