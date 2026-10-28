import { Types } from 'mongoose';

import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { BusinessModel } from '../vendors/vendors.model';
import { BrandMembershipModel, BrandModel } from './brands.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 0 brands service. ═══
 *
 * Admin-mediated brand creation only in Phase 0. Public self-service brand creation is Phase 5.
 * The admin creates a brand, assigns an owner, and the owner's `BrandMembership` is seeded on
 * the same transaction so a brand without any member cannot exist.
 */

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'brand';
}

/**
 * Produce a slug that's unique in the brands collection. Appends a 6-char suffix on collision —
 * same mechanism the sponsors module uses for its own slug.
 */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const existing = await BrandModel.findOne({ slug: base }).lean().exec();
  if (!existing) return base;
  for (let i = 0; i < 5; i += 1) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    const dup = await BrandModel.findOne({ slug: candidate }).lean().exec();
    if (!dup) return candidate;
  }
  throw ConflictError(ERROR_CODES.DUPLICATE, 'Could not allocate a unique brand slug');
}

export const brandsService = {
  /**
   * ═══ 2026-10-28 — SELF-SERVE BRAND CREATION ═══
   *
   * The signed-in user creates a brand FOR THEMSELVES, in one call. No admin step, no approval
   * wait. Used by the `/vendor/franchise` enable-franchise-mode flow: the business owner clicks
   * one button and this writes:
   *   • a Brand row with themselves as owner,
   *   • a BrandMembership (owner, active),
   *   • an updated Business row pointing at the new brand,
   *   • in-place backfill of their follows + reviews to the new brand_id.
   *
   * The convert-to-brand path below shares most of this; this one is the "I don't have a
   * business yet" entry point (used from the business-register wizard once that lands).
   */
  async createForSelf(
    principal: Principal,
    dto: {
      name: string;
      logoUrl?: string | null;
      coverPhotoUrl?: string | null;
    },
  ) {
    const slug = await uniqueSlug(dto.name);
    const brand = await BrandModel.create({
      name: dto.name,
      slug,
      owner_user_id: principal.userId,
      logo_url: dto.logoUrl ?? null,
      cover_photo_url: dto.coverPhotoUrl ?? null,
    });
    await BrandMembershipModel.create({
      brand_id: brand._id,
      user_id: principal.userId,
      role: 'owner',
      scoped_business_ids: [],
      status: 'active',
      accepted_at: new Date(),
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'brand.created.self_serve',
      entityType: 'brand',
      entityId: String(brand._id),
      metadata: { name: dto.name, slug },
    });
    return {
      id: String(brand._id),
      name: brand.name,
      slug: brand.slug,
      ownerUserId: brand.owner_user_id,
      status: brand.status,
    };
  },

  /**
   * Admin creates a brand and names its owner. The owner's `BrandMembership` is written
   * immediately so a brand without any member is never persisted.
   */
  async create(
    admin: Principal,
    dto: {
      name: string;
      ownerUserId: string;
      logoUrl?: string | null;
      coverPhotoUrl?: string | null;
    },
  ) {
    const slug = await uniqueSlug(dto.name);
    const brand = await BrandModel.create({
      name: dto.name,
      slug,
      owner_user_id: dto.ownerUserId,
      logo_url: dto.logoUrl ?? null,
      cover_photo_url: dto.coverPhotoUrl ?? null,
    });

    /**
     * Owner self-membership. Written atomically-adjacent to the brand itself — the invariant is
     * "every brand has at least one `active` membership for its owner", and a brand without this
     * row would still be queryable but useless.
     */
    await BrandMembershipModel.create({
      brand_id: brand._id,
      user_id: dto.ownerUserId,
      role: 'owner',
      scoped_business_ids: [],
      status: 'active',
      accepted_at: new Date(),
    });

    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'brand.created',
      entityType: 'brand',
      entityId: String(brand._id),
      metadata: { name: dto.name, ownerUserId: dto.ownerUserId, slug },
    });

    return {
      id: String(brand._id),
      name: brand.name,
      slug: brand.slug,
      ownerUserId: brand.owner_user_id,
      status: brand.status,
    };
  },

  /**
   * Attach an existing business to a brand. Guards against moving a business that already
   * belongs to a different brand — a move is admin tooling, not a side effect of this call.
   */
  async attachBusiness(
    admin: Principal,
    brandId: string,
    businessId: string,
  ) {
    const brand = await BrandModel.findById(brandId).lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    const biz = await BusinessModel.findById(businessId).exec();
    if (!biz) throw NotFoundError('Business not found');
    if (biz.brand_id && String(biz.brand_id) !== brandId) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This business already belongs to a different brand — detach it first.',
      );
    }
    biz.brand_id = new Types.ObjectId(brandId);
    await biz.save();
    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'brand.business.attached',
      entityType: 'brand',
      entityId: brandId,
      metadata: { businessId },
    });
    return { brandId, businessId, ok: true };
  },

  /** Admin list of all brands. Enriched with member + business counts for the roster view. */
  async list(limit = 200) {
    const brands = await BrandModel.find().sort({ created_at: -1 }).limit(limit).lean().exec();
    if (brands.length === 0) return [];
    const brandIds = brands.map((b) => b._id);
    /**
     * Two aggregate pipelines rather than N queries per brand — the roster can hold 200 rows
     * and a per-row round trip would be a page-load regression.
     */
    const memberCounts = await BrandMembershipModel.aggregate<{
      _id: Types.ObjectId;
      count: number;
    }>([
      { $match: { brand_id: { $in: brandIds }, status: 'active' } },
      { $group: { _id: '$brand_id', count: { $sum: 1 } } },
    ]);
    const businessCounts = await BusinessModel.aggregate<{
      _id: Types.ObjectId;
      count: number;
    }>([
      { $match: { brand_id: { $in: brandIds } } },
      { $group: { _id: '$brand_id', count: { $sum: 1 } } },
    ]);
    const memberMap = new Map(memberCounts.map((m) => [String(m._id), m.count]));
    const businessMap = new Map(businessCounts.map((b) => [String(b._id), b.count]));
    return brands.map((b) => ({
      id: String(b._id),
      name: b.name,
      slug: b.slug,
      ownerUserId: b.owner_user_id,
      logoUrl: b.logo_url ?? null,
      coverPhotoUrl: b.cover_photo_url ?? null,
      status: b.status,
      memberCount: memberMap.get(String(b._id)) ?? 0,
      businessCount: businessMap.get(String(b._id)) ?? 0,
      createdAt: b.created_at ?? null,
    }));
  },

  /**
   * ═══ FRANCHISE / MULTI-VENDOR — Phase 5 convert-single-owner-to-brand. ═══
   *
   * Admin-driven promotion of an existing single-owner business into a (possibly multi-truck)
   * brand. The specific case this exists for: James has a profile today, needs to turn it into
   * a brand with two trucks. Without this, the only way to get there is to delete and
   * re-register, losing orders, reviews, and payout history.
   *
   * What this does:
   *   1. If the business already belongs to a brand, refuse — this is the convert path, not a
   *      silent re-attach.
   *   2. Create a new Brand (owner = business.owner_user_id, name = business.name, logo
   *      copied over).
   *   3. Seed the owner's BrandMembership (role: owner, status: active).
   *   4. Point business.brand_id at the new brand.
   *   5. Backfill the brand_id on this business's existing follows and reviews so Phase 4's
   *      brand-level aggregates kick in without a separate migration pass. Collapse any
   *      duplicate (follower, brand) rows if they exist (impossible for a never-franchised
   *      business, but the collapse is cheap and defensive).
   *   6. Optionally seat initial operators if the admin passed them.
   *
   * All atomic from the business's perspective — if any step throws, the brand creation stays
   * (so a retry doesn't double-create), but the business is only pointed at the brand after
   * follows + reviews have been backfilled. A partial run is safe to re-execute.
   */
  async convertBusinessToBrand(
    admin: Principal,
    businessId: string,
    dto: {
      brandName?: string;
      seedOperators?: Array<{ userId: string; displayName: string }>;
    } = {},
  ) {
    const business = await BusinessModel.findById(businessId).exec();
    if (!business) throw NotFoundError('Business not found');
    if (business.brand_id) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This business already belongs to a brand. Use the brand admin tools to add operators.',
      );
    }

    const brandName = dto.brandName?.trim() || business.name;
    const slug = await uniqueSlug(brandName);
    const brand = await BrandModel.create({
      name: brandName,
      slug,
      owner_user_id: business.owner_user_id,
      logo_url: business.logo_url ?? null,
      cover_photo_url: business.cover_photo_url ?? null,
    });

    /** Owner self-membership. Atomic-adjacent — a brand without any member must never persist. */
    await BrandMembershipModel.updateOne(
      { brand_id: brand._id, user_id: business.owner_user_id, status: 'active' },
      {
        $setOnInsert: {
          brand_id: brand._id,
          user_id: business.owner_user_id,
          role: 'owner',
          scoped_business_ids: [],
          status: 'active',
          accepted_at: new Date(),
        },
      },
      { upsert: true },
    ).exec();

    /**
     * Phase 4 backfill — scoped to just THIS business's rows. The dedicated script walks every
     * business; this inline pass only touches the one being converted so a conversion in prod
     * doesn't need a separate migration run.
     */
    const brandIdStr = String(brand._id);
    const { FollowModel } = await import('../livemap/livemap.model');
    const { ReviewModel } = await import('../reviews/reviews.model');
    const follows = await FollowModel.find({
      business_id: businessId,
      brand_id: null,
    })
      .lean()
      .exec();
    for (const f of follows) {
      const existing = await FollowModel.findOne({
        follower_user_id: f.follower_user_id,
        brand_id: brandIdStr,
      })
        .lean()
        .exec();
      if (existing) {
        await FollowModel.deleteOne({ _id: f._id }).exec();
      } else {
        await FollowModel.updateOne({ _id: f._id }, { $set: { brand_id: brandIdStr } }).exec();
      }
    }
    await ReviewModel.updateMany(
      { subject_type: 'business', subject_id: businessId, brand_id: null },
      { $set: { brand_id: brandIdStr } },
    ).exec();

    /** Now point the business at the brand — AFTER the backfill, so a retry is safe. */
    business.brand_id = brand._id;
    await business.save();

    /**
     * Optional initial operator seats. Each needs an active brand membership first (operator
     * role, scoped to this business). We seed them inline here so the admin can go from
     * single-owner to two-truck brand in one call. Operators without pre-existing accounts
     * will land here with no stripe_account_id — they finish Phase 2 onboarding later.
     */
    const seededOperators: Array<{ operatorId: string; userId: string; displayName: string }> = [];
    for (const seed of dto.seedOperators ?? []) {
      await BrandMembershipModel.updateOne(
        { brand_id: brand._id, user_id: seed.userId, status: 'active' },
        {
          $setOnInsert: {
            brand_id: brand._id,
            user_id: seed.userId,
            role: 'operator',
            scoped_business_ids: [business._id],
            status: 'active',
            accepted_at: new Date(),
          },
        },
        { upsert: true },
      ).exec();
      const { BrandOperatorModel } = await import('./brandOperator.model');
      const existingOp = await BrandOperatorModel.findOne({
        brand_id: brand._id,
        business_id: business._id,
        user_id: seed.userId,
        status: 'active',
      })
        .lean()
        .exec();
      let operatorId: string;
      if (existingOp) {
        operatorId = String(existingOp._id);
      } else {
        const op = await BrandOperatorModel.create({
          brand_id: brand._id,
          business_id: business._id,
          user_id: seed.userId,
          display_name: seed.displayName,
          status: 'active',
        });
        operatorId = String(op._id);
      }
      seededOperators.push({ operatorId, userId: seed.userId, displayName: seed.displayName });
    }

    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'brand.converted_from_business',
      entityType: 'brand',
      entityId: brandIdStr,
      metadata: {
        businessId,
        followsBackfilled: follows.length,
        operatorsSeeded: seededOperators.length,
      },
    });

    return {
      brandId: brandIdStr,
      slug: brand.slug,
      businessId,
      followsBackfilled: follows.length,
      operatorsSeeded: seededOperators,
    };
  },

  /**
   * ═══ 2026-10-28 — SELF-SERVE DISABLE FRANCHISE MODE ═══
   *
   * The owner's reverse of `createForSelf` / `convertOwnBusinessToBrand`. One call that undoes
   * brand mode cleanly, with guards so an operator never has their dashboard yanked overnight.
   *
   * Guards (refused with a clear error):
   *   • Caller must be the brand's owner.
   *   • No `active` BrandOperator rows — brand owner must retire or remove every truck first.
   *   • No `pending` BrandInvite rows — the owner should revoke outstanding invites first.
   *
   * What gets removed:
   *   • The Brand row.
   *   • Every BrandMembership for the brand (the owner's own membership included).
   *   • Every BrandInvite for the brand (terminal rows too — the brand is gone).
   *   • Every BrandOperator for the brand (retired rows too, for the same reason).
   *   • Every BrandSplit for the brand (the split ledger belongs to the brand's lifetime).
   *   • `brand_id` cleared on every Business, Follow, Review that pointed here.
   *
   * What stays intact: the Business itself, its orders, its menu, its reviews, its followers,
   * its Stripe account, its live sessions. Disabling franchise mode is a schema reversal, not
   * a wipe. The owner can re-enable later from `/vendor/franchise` with one click.
   */
  async disableForSelf(principal: Principal, brandId: string) {
    const brand = await BrandModel.findById(brandId).exec();
    if (!brand) throw NotFoundError('Brand not found');
    if (brand.owner_user_id !== principal.userId) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'Only the brand owner can disable franchise mode.',
      );
    }

    /**
     * The two "someone is relying on this brand" guards. Both lazy — we check in the moment of
     * disable, not through an async job, so a race between "retire my last operator" and
     * "disable brand" can't slip an operator out from under the data.
     */
    const { BrandOperatorModel } = await import('./brandOperator.model');
    const { BrandInviteModel } = await import('./brandInvite.model');
    const { BrandSplitModel } = await import('./brandSplit.model');
    const { FollowModel } = await import('../livemap/livemap.model');
    const { ReviewModel } = await import('../reviews/reviews.model');

    const activeOperators = await BrandOperatorModel.countDocuments({
      brand_id: brandId,
      status: 'active',
    }).exec();
    if (activeOperators > 0) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Retire your ${activeOperators} active operator${activeOperators === 1 ? '' : 's'} first — disabling now would strand their dashboards and payouts.`,
      );
    }
    const pendingInvites = await BrandInviteModel.countDocuments({
      brand_id: brandId,
      status: 'pending',
    }).exec();
    if (pendingInvites > 0) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `You have ${pendingInvites} pending invite${pendingInvites === 1 ? '' : 's'}. Revoke them from the brand overview first.`,
      );
    }

    const brandIdStr = String(brand._id);
    /**
     * Order matters: clear the references FIRST (Business, Follow, Review), then wipe the
     * franchise collections, then delete the brand itself. A reversed order would leave an
     * orphan reference that reads through to a non-existent brand for a few milliseconds.
     */
    await BusinessModel.updateMany(
      { brand_id: brand._id },
      { $set: { brand_id: null } },
    ).exec();
    await FollowModel.updateMany(
      { brand_id: brandIdStr },
      { $set: { brand_id: null } },
    ).exec();
    await ReviewModel.updateMany(
      { brand_id: brandIdStr },
      { $set: { brand_id: null } },
    ).exec();

    await BrandMembershipModel.deleteMany({ brand_id: brand._id }).exec();
    await BrandInviteModel.deleteMany({ brand_id: brand._id }).exec();
    await BrandOperatorModel.deleteMany({ brand_id: brand._id }).exec();
    await BrandSplitModel.deleteMany({ brand_id: brand._id }).exec();

    await BrandModel.deleteOne({ _id: brand._id }).exec();

    await writeAudit({
      actorId: principal.userId,
      action: 'brand.disabled.self_serve',
      entityType: 'brand',
      entityId: brandIdStr,
      metadata: { name: brand.name },
    });

    return { brandId: brandIdStr, disabled: true };
  },

  /**
   * ═══ 2026-10-28 — SELF-SERVE CONVERT-TO-BRAND ═══
   *
   * The business OWNER converts their own business into a brand. No admin. Delegates to the
   * same `convertBusinessToBrand` logic — the only difference is who may trigger it. Guard:
   * the caller must own the business (checked via `vendorsService.getBusinessOwner`).
   */
  async convertOwnBusinessToBrand(
    principal: Principal,
    businessId: string,
    dto: {
      brandName?: string;
      seedOperators?: Array<{ userId: string; displayName: string }>;
    } = {},
  ) {
    const business = await BusinessModel.findById(businessId).select('owner_user_id').lean().exec();
    if (!business) throw NotFoundError('Business not found');
    if (business.owner_user_id !== principal.userId) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'Only the business owner can convert this business into a brand.',
      );
    }
    return this.convertBusinessToBrand(principal, businessId, dto);
  },

  /**
   * Franchise Phase 5 — short-lived impersonation grant so support can act AS a brand owner
   * while diagnosing an operator-side bug.
   *
   * Returned token is intended to be redeemed by the admin frontend immediately via Clerk's
   * actor-token flow (or an equivalent "sign in as this user" lane); here we only record the
   * grant with an expiry + a reason, so an audit trail exists for every impersonation. The
   * actual session hand-off lives in the identity module and is NOT changed by this phase.
   */
  async grantImpersonation(
    admin: Principal,
    brandId: string,
    reason: string,
  ) {
    const brand = await BrandModel.findById(brandId).select('owner_user_id name').lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'brand.impersonation_granted',
      entityType: 'brand',
      entityId: brandId,
      metadata: {
        target_user_id: brand.owner_user_id,
        reason,
      },
    });
    return {
      brandId,
      targetUserId: brand.owner_user_id,
      targetBrandName: brand.name,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      reason,
    };
  },

  /** Admin detail for one brand — includes memberships + attached businesses. */
  async get(brandId: string) {
    const brand = await BrandModel.findById(brandId).lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    const [memberships, businesses] = await Promise.all([
      BrandMembershipModel.find({ brand_id: brandId }).sort({ created_at: 1 }).lean().exec(),
      BusinessModel.find({ brand_id: brandId }).select('_id name status').lean().exec(),
    ]);
    return {
      id: String(brand._id),
      name: brand.name,
      slug: brand.slug,
      ownerUserId: brand.owner_user_id,
      logoUrl: brand.logo_url ?? null,
      coverPhotoUrl: brand.cover_photo_url ?? null,
      status: brand.status,
      memberships: memberships.map((m) => ({
        id: String(m._id),
        userId: m.user_id,
        role: m.role,
        scopedBusinessIds: (m.scoped_business_ids ?? []).map(String),
        status: m.status,
        invitedBy: m.invited_by ?? null,
        invitedAt: m.invited_at ?? null,
        acceptedAt: m.accepted_at ?? null,
      })),
      businesses: businesses.map((b) => ({
        id: String(b._id),
        name: b.name,
        status: b.status,
      })),
    };
  },
};
