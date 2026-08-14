import {
  FEATURED_TRENDING_BOOST,
  PRO_MARKETPLACE_DISCOUNT_BPS,
  SUBSCRIPTION_PLAN_DEFS,
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
} from '../../config/constants';
import { stripe } from '../../integrations/stripe';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { vendorsService } from '../vendors/vendors.service';
import { ENTITLED_STATUSES, subscriptionsRepository as repo } from './subscriptions.repository';

/**
 * Monetization subscriptions (R29/R30): purchase/cancel a plan and read entitlements. Four plans over
 * existing hooks — Pro (lower marketplace fee), Featured (Trending boost), Verified badge, AI assistant.
 * Business plans require the caller to own the business; the user plan is self-scoped.
 */
async function resolveSubscriber(
  principal: Principal,
  plan: SubscriptionPlan,
  businessId?: string,
): Promise<{ subscriberId: string; subscriberType: 'business' | 'user' }> {
  const def = SUBSCRIPTION_PLAN_DEFS[plan];
  if (def.scope === 'user') return { subscriberId: principal.userId, subscriberType: 'user' };
  if (!businessId) {
    throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, `The ${def.name} plan is for a business`);
  }
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  return { subscriberId: businessId, subscriberType: 'business' };
}

export const subscriptionsService = {
  plans() {
    return SUBSCRIPTION_PLANS.map((p) => SUBSCRIPTION_PLAN_DEFS[p]);
  },

  async subscribe(principal: Principal, plan: SubscriptionPlan, businessId: string | undefined, idempotencyKey: string) {
    const def = SUBSCRIPTION_PLAN_DEFS[plan];
    const { subscriberId, subscriberType } = await resolveSubscriber(principal, plan, businessId);

    const existing = await repo.find(subscriberId, plan);
    if (existing && ENTITLED_STATUSES.includes(existing.status as (typeof ENTITLED_STATUSES)[number])) {
      return { ...this.view(existing), clientSecret: null };
    }

    const sub = await stripe().createSubscription({
      customerRef: subscriberId,
      plan,
      planName: def.name,
      priceCents: def.priceCents,
      idempotencyKey: `sub_${subscriberId}_${plan}_${idempotencyKey}`,
    });
    const record = await repo.upsert({
      subscriber_id: subscriberId,
      subscriber_type: subscriberType,
      plan,
      status: sub.status,
      stripe_subscription_id: sub.subscriptionId,
      current_period_end: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null,
    });

    /**
     * Audited as "started" only when it genuinely started. A subscription awaiting its first payment
     * is a real event too, but recording it under the same action would overstate revenue.
     */
    await writeAudit({
      actorId: principal.userId,
      action: sub.status === 'active' || sub.status === 'trialing' ? 'subscription.started' : 'subscription.pending_payment',
      entityType: 'subscription',
      entityId: `${subscriberId}:${plan}`,
      metadata: { plan, priceCents: def.priceCents, status: sub.status },
    });
    return { ...this.view(record!), clientSecret: sub.clientSecret };
  },

  /**
   * Settles the record after the client confirms the first payment. The status is re-read from
   * Stripe rather than taken from the caller — a client that says "I paid" is a claim, not proof.
   */
  async confirm(principal: Principal, plan: SubscriptionPlan, businessId: string | undefined) {
    const { subscriberId } = await resolveSubscriber(principal, plan, businessId);
    const record = await repo.find(subscriberId, plan);
    if (!record?.stripe_subscription_id) throw NotFoundError('No subscription to confirm');

    const live = await stripe().getSubscription(record.stripe_subscription_id);
    const updated = await repo.upsert({
      subscriber_id: subscriberId,
      subscriber_type: record.subscriber_type as 'business' | 'user',
      plan,
      status: live.status,
      stripe_subscription_id: record.stripe_subscription_id,
      current_period_end: live.currentPeriodEnd ? new Date(live.currentPeriodEnd * 1000) : null,
    });
    if (live.status === 'active' || live.status === 'trialing') {
      await writeAudit({
        actorId: principal.userId,
        action: 'subscription.started',
        entityType: 'subscription',
        entityId: `${subscriberId}:${plan}`,
        metadata: { plan, status: live.status },
      });
    }
    return this.view(updated!);
  },

  async cancel(principal: Principal, plan: SubscriptionPlan, businessId: string | undefined) {
    const { subscriberId } = await resolveSubscriber(principal, plan, businessId);
    const record = await repo.find(subscriberId, plan);
    if (!record || record.status !== 'active') throw NotFoundError('No active subscription');
    if (record.stripe_subscription_id) {
      await stripe().cancelSubscription({ subscriptionId: record.stripe_subscription_id, atPeriodEnd: false });
    }
    const updated = await repo.setStatus(subscriberId, plan, 'canceled', false);
    await writeAudit({
      actorId: principal.userId,
      action: 'subscription.canceled',
      entityType: 'subscription',
      entityId: `${subscriberId}:${plan}`,
    });
    return this.view(updated!);
  },

  hasActive(subscriberId: string, plan: SubscriptionPlan): Promise<boolean> {
    return repo.isActive(subscriberId, plan);
  },

  /** Entitlements the caller has: business plans keyed by the given business; the user plan self-scoped. */
  async entitlementsFor(principal: Principal, businessId?: string) {
    const [pro, featured, verifiedBadge, aiAssistant, sellerPlus, stockWaiver] = await Promise.all([
      businessId ? repo.isActive(businessId, 'pro') : Promise.resolve(false),
      businessId ? repo.isActive(businessId, 'featured') : Promise.resolve(false),
      businessId ? repo.isActive(businessId, 'verified_badge') : Promise.resolve(false),
      repo.isActive(principal.userId, 'ai_assistant'),
      // F-2/F-4: seller-scoped, so they key on the user rather than a business.
      repo.isActive(principal.userId, 'seller_plus'),
      repo.isActive(principal.userId, 'stock_waiver'),
    ]);
    return { pro, featured, verifiedBadge, aiAssistant, sellerPlus, stockWaiver };
  },

  /** F-2: is this seller on Seller Plus? The checkout ceiling and settlement fee both read this. */
  async hasSellerPlus(userId: string): Promise<boolean> {
    return repo.isActive(userId, 'seller_plus');
  },

  /** Pro membership entitlement: the marketplace-fee discount, in bps (0 if not subscribed). */
  async marketplaceDiscountBps(businessId: string): Promise<number> {
    return (await repo.isActive(businessId, 'pro')) ? PRO_MARKETPLACE_DISCOUNT_BPS : 0;
  },

  /** Featured entitlement: which of these businesses get the Trending boost. */
  /**
   * P-19 — which of these businesses hold the paid Verified Badge. Batched for the map/list page:
   * the badge is rendered per pin, and a query per pin would make it the most expensive thing on
   * the busiest read in the product.
   */
  async activeVerifiedSet(businessIds: string[]): Promise<Set<string>> {
    if (businessIds.length === 0) return new Set();
    const rows = await repo.activeByPlan('verified_badge', businessIds);
    return new Set(rows.map((r) => r.subscriber_id));
  },

  async activeFeaturedSet(businessIds: string[]): Promise<Set<string>> {
    if (businessIds.length === 0) return new Set();
    const rows = await repo.activeByPlan('featured', businessIds);
    return new Set(rows.map((r) => r.subscriber_id));
  },
  featuredBoost(): number {
    return FEATURED_TRENDING_BOOST;
  },

  view(s: {
    subscriber_id: string;
    subscriber_type?: string;
    plan: string;
    status: string;
    current_period_end?: Date | null;
    cancel_at_period_end?: boolean;
  }) {
    return {
      subscriberId: s.subscriber_id,
      plan: s.plan,
      status: s.status,
      currentPeriodEnd: s.current_period_end ?? null,
      cancelAtPeriodEnd: s.cancel_at_period_end ?? false,
    };
  },
};
