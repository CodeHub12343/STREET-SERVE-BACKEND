import { Types } from 'mongoose';

import { NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { BusinessModel } from '../vendors/vendors.model';
import { LiveSessionModel } from '../livemap/livemap.model';
import { BrandMembershipModel, BrandModel } from './brands.model';
import { BrandOperatorModel } from './brandOperator.model';
import { BrandSplitModel } from './brandSplit.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 3 "my brand" + overview service. ═══
 *
 * Two read paths this module owns:
 *
 *   1. `listForUser` — the signed-in user's brand memberships. Drives the role switcher's
 *      brand entries and the Business selector in the dashboard shell: an operator sees only
 *      the brands they belong to.
 *
 *   2. `overview` — the brand owner's / manager's one-screen view of the brand: active trucks
 *      with their live positions, pending invites, policy mode, and the earnings headline
 *      ribbon. One request, one page.
 */

export const brandMembershipService = {
  async listForUser(principal: Principal) {
    const memberships = await BrandMembershipModel.find({
      user_id: principal.userId,
      status: 'active',
    })
      .lean()
      .exec();
    if (memberships.length === 0) return [];

    const brandIds = memberships.map((m) => m.brand_id);
    const brands = await BrandModel.find({ _id: { $in: brandIds }, status: 'active' })
      .select('name slug logo_url owner_user_id')
      .lean()
      .exec();
    const brandMap = new Map(brands.map((b) => [String(b._id), b]));

    /** Which operator rows this user owns under each brand (for the "which truck am I at" link). */
    const operators = await BrandOperatorModel.find({
      user_id: principal.userId,
      status: 'active',
    })
      .lean()
      .exec();
    const operatorsByBrand = new Map<string, typeof operators>();
    for (const op of operators) {
      const key = String(op.brand_id);
      const arr = operatorsByBrand.get(key) ?? [];
      arr.push(op);
      operatorsByBrand.set(key, arr);
    }

    return memberships
      .map((m) => {
        const brand = brandMap.get(String(m.brand_id));
        if (!brand) return null;
        const ops = operatorsByBrand.get(String(m.brand_id)) ?? [];
        return {
          membershipId: String(m._id),
          brandId: String(brand._id),
          brandName: brand.name,
          brandSlug: brand.slug,
          brandLogoUrl: brand.logo_url ?? null,
          role: m.role,
          isOwner: brand.owner_user_id === principal.userId,
          scopedBusinessIds: (m.scoped_business_ids ?? []).map(String),
          operators: ops.map((o) => ({
            operatorId: String(o._id),
            businessId: String(o.business_id),
            displayName: o.display_name,
          })),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  },

  /**
   * Brand owner / manager overview. Guarded at the route (owner-or-manager); this service
   * trusts the caller it was passed. Returns the picture a franchise owner opens the app for:
   *
   *   • The brand's trucks with each truck's live status (if any).
   *   • The policy mode (pooled or per_operator) so the owner knows what settlement will do.
   *   • Pending invites outstanding.
   *   • A rolling 30-day earnings total split by paid-vs-fallback.
   */
  async overview(brandId: string) {
    const brand = await BrandModel.findById(brandId).lean().exec();
    if (!brand) throw NotFoundError('Brand not found');

    const [operators, memberships, businesses] = await Promise.all([
      BrandOperatorModel.find({ brand_id: brandId, status: 'active' }).lean().exec(),
      BrandMembershipModel.find({ brand_id: brandId, status: 'active' }).lean().exec(),
      BusinessModel.find({ brand_id: brandId })
        .select('_id name status')
        .lean()
        .exec(),
    ]);

    /** Live sessions keyed to this brand's operators, resolved in one query. */
    const operatorIds = operators.map((o) => String(o._id));
    const liveSessions =
      operatorIds.length === 0
        ? []
        : await LiveSessionModel.find({
            actor_type: 'operator',
            actor_id: { $in: operatorIds },
            ended_at: null,
          })
            .select('actor_id status current_location last_ping_at')
            .lean()
            .exec();
    const liveByOperator = new Map(
      liveSessions.map((s) => [String(s.actor_id), s]),
    );

    /** 30-day earnings headline. The BrandSplit ledger has one row per leg; aggregate by
     *  status. For pooled brands this returns zeros (no split rows exist). */
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const splits = await BrandSplitModel.find({
      brand_id: brandId,
      created_at: { $gte: thirtyDaysAgo },
    })
      .select('status net_cents operator_id')
      .lean()
      .exec();
    const earnings = {
      windowDays: 30,
      paidCents: 0,
      fallbackCents: 0,
      reversedCents: 0,
      perOperatorCents: new Map<string, number>(),
    };
    for (const leg of splits) {
      const k = String(leg.operator_id);
      if (leg.status === 'paid') {
        earnings.paidCents += leg.net_cents;
        earnings.perOperatorCents.set(k, (earnings.perOperatorCents.get(k) ?? 0) + leg.net_cents);
      } else if (leg.status === 'fallback_to_owner') {
        earnings.fallbackCents += leg.net_cents;
      } else if (leg.status === 'reversed') {
        earnings.reversedCents += leg.net_cents;
      }
    }

    /** Pending invites — the "waiting on" column of the overview. */
    const { BrandInviteModel } = await import('./brandInvite.model');
    const pendingInvites = await BrandInviteModel.find({
      brand_id: brandId,
      status: 'pending',
    })
      .sort({ created_at: -1 })
      .lean()
      .exec();

    const policy = brand.payout_policy;

    return {
      brand: {
        id: String(brand._id),
        name: brand.name,
        slug: brand.slug,
        logoUrl: brand.logo_url ?? null,
        ownerUserId: brand.owner_user_id,
        status: brand.status,
      },
      businesses: businesses.map((b) => ({
        id: String(b._id),
        name: b.name,
        status: b.status,
      })),
      operators: operators.map((o) => {
        const live = liveByOperator.get(String(o._id));
        return {
          operatorId: String(o._id),
          userId: o.user_id,
          businessId: String(o.business_id),
          displayName: o.display_name,
          stripeConnected: Boolean(o.stripe_account_id),
          payoutsEnabled: Boolean(o.payouts_enabled),
          approvedByOwner: Boolean(o.approved_at_by_owner),
          live: live
            ? {
                status: live.status,
                coordinates: live.current_location?.coordinates ?? null,
                lastPingAt: live.last_ping_at ?? null,
              }
            : null,
          earningsCents30d: earnings.perOperatorCents.get(String(o._id)) ?? 0,
        };
      }),
      members: memberships.map((m) => ({
        userId: m.user_id,
        role: m.role,
        scopedBusinessIds: (m.scoped_business_ids ?? []).map(String),
      })),
      pendingInvites: pendingInvites.map((inv) => ({
        id: String(inv._id),
        inviteeEmail: inv.invitee_email,
        role: inv.role,
        expiresAt: inv.expires_at,
      })),
      policy: {
        mode: policy?.mode ?? 'pooled',
        splits: (policy?.splits ?? []).map((s) => ({
          operatorId: String(s.operator_id),
          shareBps: s.share_bps,
        })),
      },
      earnings: {
        windowDays: earnings.windowDays,
        paidCents: earnings.paidCents,
        fallbackCents: earnings.fallbackCents,
        reversedCents: earnings.reversedCents,
      },
    };
  },

  /**
   * Resolve ONE active membership for (user, brand). Used by the overview route to confirm the
   * caller can read a specific brand before `overview()` runs — the service above does not
   * guard, so the route must.
   */
  async requireOwnerOrManager(userId: string, brandId: string): Promise<{
    role: 'owner' | 'manager' | 'operator';
    isOwner: boolean;
  }> {
    const brand = await BrandModel.findById(brandId).select('owner_user_id').lean().exec();
    if (!brand) throw NotFoundError('Brand not found');
    if (brand.owner_user_id === userId) {
      return { role: 'owner', isOwner: true };
    }
    const membership = await BrandMembershipModel.findOne({
      brand_id: new Types.ObjectId(brandId),
      user_id: userId,
      status: 'active',
    })
      .lean()
      .exec();
    if (!membership || !['owner', 'manager'].includes(membership.role)) {
      throw NotFoundError('Brand not found'); // 404 rather than 403 — don't advertise existence
    }
    return {
      role: membership.role as 'owner' | 'manager' | 'operator',
      isOwner: false,
    };
  },
};
