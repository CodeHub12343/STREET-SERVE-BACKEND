import { Types } from 'mongoose';

import { writeAudit } from '../../shared/audit';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import type { Principal } from '../../shared/types/principal';
import { BusinessModel } from '../vendors/vendors.model';
import { BrandMembershipModel, BrandModel } from './brands.model';
import { BrandOperatorModel, type BrandOperatorDoc } from './brandOperator.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 1 BrandOperator service. ═══
 *
 * Admin creates/retires operators in Phase 1 (Phase 3 widens this with a self-service invite
 * flow). Every create validates:
 *   • the brand exists;
 *   • the business belongs to that brand (brand_id matches);
 *   • the user has an `active` `BrandMembership` on the brand (membership is the authorization
 *     anchor — a user who isn't a brand member cannot be made an operator).
 */

export interface ResolvedOperator {
  operatorId: string;
  brandId: string;
  brandName: string;
  brandLogoUrl: string | null;
  businessId: string;
  userId: string;
  displayName: string;
}

export const brandOperatorService = {
  async create(
    admin: Principal,
    dto: {
      brandId: string;
      businessId: string;
      userId: string;
      displayName: string;
    },
  ) {
    const brand = await BrandModel.findById(dto.brandId).lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    const business = await BusinessModel.findById(dto.businessId).lean().exec();
    if (!business) throw NotFoundError('Business not found');
    if (!business.brand_id || String(business.brand_id) !== dto.brandId) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'That business does not belong to this brand — attach it to the brand first.',
      );
    }
    const membership = await BrandMembershipModel.findOne({
      brand_id: dto.brandId,
      user_id: dto.userId,
      status: 'active',
    })
      .lean()
      .exec();
    if (!membership) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'That user is not an active member of this brand — invite them first.',
      );
    }
    const op = await BrandOperatorModel.create({
      brand_id: new Types.ObjectId(dto.brandId),
      business_id: new Types.ObjectId(dto.businessId),
      user_id: dto.userId,
      display_name: dto.displayName,
      status: 'active',
    });
    await writeAudit({
      actorId: admin.userId,
      actorRole: 'admin',
      action: 'brand.operator.created',
      entityType: 'brand_operator',
      entityId: String(op._id),
      metadata: {
        brandId: dto.brandId,
        businessId: dto.businessId,
        userId: dto.userId,
      },
    });
    return {
      id: String(op._id),
      brandId: dto.brandId,
      businessId: dto.businessId,
      userId: dto.userId,
      displayName: dto.displayName,
    };
  },

  async retire(actor: Principal, operatorId: string) {
    const op = await BrandOperatorModel.findById(operatorId).exec();
    if (!op) throw NotFoundError('Operator not found');
    /**
     * 2026-10-28 — owner-self-serve. The retire route is now reachable by the brand owner
     * directly (not only admin). We check the actor is EITHER the brand owner OR has an
     * owner/manager membership on the brand. The operator themselves cannot retire themselves
     * because that would strand their orders; they can leave the brand instead.
     */
    const { BrandModel: Bm, BrandMembershipModel: Bmm } = await import('./brands.model');
    const brand = await Bm.findById(op.brand_id).select('owner_user_id').lean().exec();
    const isBrandOwner = brand?.owner_user_id === actor.userId;
    const isManager = isBrandOwner
      ? true
      : Boolean(
          await Bmm.findOne({
            brand_id: op.brand_id,
            user_id: actor.userId,
            status: 'active',
            role: { $in: ['owner', 'manager'] },
          })
            .lean()
            .exec(),
        );
    if (!isBrandOwner && !isManager) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'Only the brand owner or a manager can retire an operator.',
      );
    }
    op.status = 'retired';
    await op.save();
    await writeAudit({
      actorId: actor.userId,
      action: 'brand.operator.retired',
      entityType: 'brand_operator',
      entityId: operatorId,
    });
    return { id: operatorId, status: 'retired' as const };
  },

  /** Admin list — one brand's operators. Used by the brand detail roster. */
  async listForBrand(brandId: string) {
    const ops = await BrandOperatorModel.find({ brand_id: brandId })
      .sort({ created_at: 1 })
      .lean()
      .exec();
    return ops.map((o) => ({
      id: String(o._id),
      brandId: String(o.brand_id),
      businessId: String(o.business_id),
      userId: o.user_id,
      displayName: o.display_name,
      status: o.status,
      createdAt: o.created_at ?? null,
    }));
  },

  /**
   * Resolve one operator for live-map rendering. Returns `null` for retired rows so a retired
   * operator is treated like a deleted one at render time — its pin disappears, no error.
   */
  async resolveForPin(operatorId: string): Promise<ResolvedOperator | null> {
    const op = await BrandOperatorModel.findById(operatorId).lean().exec();
    if (!op || op.status !== 'active') return null;
    const brand = await BrandModel.findById(op.brand_id).lean().exec();
    if (!brand || brand.status !== 'active') return null;
    return {
      operatorId: String(op._id),
      brandId: String(brand._id),
      brandName: brand.name,
      brandLogoUrl: brand.logo_url ?? null,
      businessId: String(op.business_id),
      userId: op.user_id,
      displayName: op.display_name,
    };
  },

  /**
   * Bulk variant — one `$in` query per collection, used by `livemap.nearby()` so a map viewport
   * with N operator pins does not fire 3N round trips. The hottest path in Phase 1.
   */
  async resolveBulkForPins(operatorIds: string[]): Promise<Map<string, ResolvedOperator>> {
    if (operatorIds.length === 0) return new Map();
    const uniq = [...new Set(operatorIds)];
    const ops = await BrandOperatorModel.find({ _id: { $in: uniq }, status: 'active' }).lean().exec();
    if (ops.length === 0) return new Map();
    const brandIds = [...new Set(ops.map((o) => String(o.brand_id)))];
    const brands = await BrandModel.find({ _id: { $in: brandIds }, status: 'active' })
      .lean()
      .exec();
    const brandMap = new Map(brands.map((b) => [String(b._id), b]));
    const out = new Map<string, ResolvedOperator>();
    for (const o of ops) {
      const brand = brandMap.get(String(o.brand_id));
      if (!brand) continue;
      out.set(String(o._id), {
        operatorId: String(o._id),
        brandId: String(brand._id),
        brandName: brand.name,
        brandLogoUrl: brand.logo_url ?? null,
        businessId: String(o.business_id),
        userId: o.user_id,
        displayName: o.display_name,
      });
    }
    return out;
  },

  /**
   * Public: operators of the brand that owns this business, with their current live status.
   * Used by the map profile sheet to render "truck 1 / truck 2" under one brand lockup.
   *
   * Returns `null` for a business that has no brand (shouldn't happen after Phase 0 backfill,
   * but the shape stays stable so the frontend doesn't branch on migration state).
   */
  async publicTrucksForBusiness(
    businessId: string,
  ): Promise<{
    brand: { id: string; name: string; logoUrl: string | null; slug: string } | null;
    trucks: {
      operatorId: string;
      displayName: string;
      businessId: string;
      /** 'driving' | 'parked' | 'away_closed' | null when offline. */
      liveStatus: string | null;
    }[];
  } | null> {
    const business = await BusinessModel.findById(businessId).lean().exec();
    if (!business) return null;
    if (!business.brand_id) {
      return { brand: null, trucks: [] };
    }
    const brand = await BrandModel.findById(business.brand_id).lean().exec();
    if (!brand) return { brand: null, trucks: [] };

    const operators = await BrandOperatorModel.find({
      brand_id: business.brand_id,
      status: 'active',
    })
      .lean()
      .exec();
    if (operators.length === 0) {
      return {
        brand: { id: String(brand._id), name: brand.name, logoUrl: brand.logo_url ?? null, slug: brand.slug },
        trucks: [],
      };
    }
    /** One query for live status across all operators — N+1 would be the obvious wrong pattern. */
    const operatorIds = operators.map((o) => String(o._id));
    const { LiveSessionModel } = await import('../livemap/livemap.model');
    const liveSessions = await LiveSessionModel.find({
      actor_type: 'operator',
      actor_id: { $in: operatorIds },
      ended_at: null,
    })
      .select('actor_id status')
      .lean()
      .exec();
    const liveStatusByOperator = new Map(
      liveSessions.map((s) => [String(s.actor_id), s.status as string]),
    );
    return {
      brand: {
        id: String(brand._id),
        name: brand.name,
        logoUrl: brand.logo_url ?? null,
        slug: brand.slug,
      },
      trucks: operators.map((o) => ({
        operatorId: String(o._id),
        displayName: o.display_name,
        businessId: String(o.business_id),
        liveStatus: liveStatusByOperator.get(String(o._id)) ?? null,
      })),
    };
  },

  /**
   * ═══ FRANCHISE / MULTI-VENDOR — Phase 2 operator Stripe onboarding. ═══
   *
   * The operator (not the brand owner) initiates onboarding. Reuses the user-level Connect
   * account path — one Stripe account per user, shared across any franchise work they do under
   * their account. Writing `stripe_account_id` on the `BrandOperator` row is a convenience
   * projection: at settlement time we look up the fresh `payouts_enabled` state via the user
   * account record, same source of truth every other payout path uses.
   *
   * ═══ 2026-10-28 — AUTO-APPROVAL ═══
   *
   * `approved_at_by_owner` is set HERE, on behalf of the brand owner, the moment the operator
   * finishes Stripe onboarding. The reasoning: the owner already trusted this operator enough
   * to invite them by email AND seat them at a specific business. Making the owner approve a
   * SECOND time adds no safety — the owner isn't going to inspect raw Stripe account ids — and
   * it adds a delay that is the thing the owner specifically does not want. The owner can
   * still cut off payouts at any moment by retiring the operator; that's the real control.
   */
  async startOperatorOnboarding(principal: Principal, operatorId: string, email?: string) {
    const op = await BrandOperatorModel.findById(operatorId).exec();
    if (!op || op.status !== 'active') throw NotFoundError('Operator not found');
    if (op.user_id !== principal.userId) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'Only the operator themselves can start payouts onboarding for this truck.',
      );
    }
    const { paymentsService } = await import('../payments/payments.service');
    const link = await paymentsService.createOnboardingLink('user', principal.userId, email);
    op.stripe_account_id = link.stripeAccountId;
    /**
     * `payouts_enabled` is NOT flipped here — Stripe decides that after the operator finishes
     * KYC. The `account.updated` webhook (`refreshAccountStatus`) populates the authoritative
     * state on the user account record; `syncOperatorPayoutState` below mirrors it onto the
     * operator row.
     *
     * `approved_at_by_owner` IS set here (self-approval under the no-delay rule above). Once
     * Stripe says `payouts_enabled`, routing happens immediately on the next sale.
     */
    op.approved_at_by_owner = new Date();
    op.approved_by = 'auto';
    await op.save();
    await writeAudit({
      actorId: principal.userId,
      action: 'brand.operator.onboarding_started',
      entityType: 'brand_operator',
      entityId: operatorId,
      metadata: { stripeAccountId: link.stripeAccountId },
    });
    return { url: link.url, stripeAccountId: link.stripeAccountId };
  },

  /**
   * Mirror the user's connected-account state onto an operator row. Called lazily from the
   * admin earnings surface so the "ready to pay" column reflects reality, and defensively
   * before each settlement attempt in case the webhook missed.
   */
  async syncOperatorPayoutState(operatorId: string) {
    const op = await BrandOperatorModel.findById(operatorId).exec();
    if (!op || !op.stripe_account_id) return null;
    const { paymentsService } = await import('../payments/payments.service');
    const synced = await paymentsService.syncAccountFromStripe('user', op.user_id);
    if (!synced) return null;
    op.payouts_enabled = synced.payouts_enabled === true;
    await op.save();
    return { stripeAccountId: op.stripe_account_id, payoutsEnabled: op.payouts_enabled };
  },

  /**
   * Brand owner approves (or revokes) an operator's connected account for payouts. The guard
   * against an operator connecting the wrong account — payment flows refuse to route to an
   * un-approved account even if Stripe says it's good.
   */
  async setOwnerApproval(
    principal: Principal,
    operatorId: string,
    approved: boolean,
  ) {
    const op = await BrandOperatorModel.findById(operatorId).exec();
    if (!op) throw NotFoundError('Operator not found');
    const brand = await BrandModel.findById(op.brand_id).lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    if (brand.owner_user_id !== principal.userId) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'Only the brand owner can approve or revoke an operator payout account.',
      );
    }
    if (approved) {
      if (!op.stripe_account_id) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'The operator has not connected a Stripe account yet.',
        );
      }
      op.approved_at_by_owner = new Date();
      op.approved_by = principal.userId;
    } else {
      op.approved_at_by_owner = null;
      op.approved_by = null;
    }
    await op.save();
    await writeAudit({
      actorId: principal.userId,
      action: approved ? 'brand.operator.payout_approved' : 'brand.operator.payout_revoked',
      entityType: 'brand_operator',
      entityId: operatorId,
      metadata: { stripeAccountId: op.stripe_account_id ?? null },
    });
    return {
      id: operatorId,
      approved: Boolean(op.approved_at_by_owner),
      approvedAt: op.approved_at_by_owner,
    };
  },

  /**
   * Does this user control this operator? Used by the live-map session guard.
   */
  async assertControl(userId: string, operatorId: string): Promise<BrandOperatorDoc> {
    const op = await BrandOperatorModel.findById(operatorId).exec();
    if (!op || op.status !== 'active') {
      throw NotFoundError('Operator not found');
    }
    if (op.user_id !== userId) {
      throw BusinessRuleError(
        ERROR_CODES.NOT_OWNER,
        'You are not the operator of this truck.',
      );
    }
    return op;
  },
};
