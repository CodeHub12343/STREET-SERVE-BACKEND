import { env } from '../../config/env';
import {
  PAY_FORWARD_DEFAULT_EXPIRY_DAYS,
  PAY_FORWARD_EXPIRY_NOTICE_DAYS,
  PAY_FORWARD_MAX_CONTRIBUTION_CENTS,
  PAY_FORWARD_MIN_CONTRIBUTION_CENTS,
  PAY_FORWARD_REDEEM_MIN_TIER,
  TIER_RANK,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import { applyPercent, formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';
import { reportSweepBatch, SWEEP_BATCH_LIMIT } from '../../jobs/sweepBatch';
import { cachedAggregate, invalidateAggregate } from '../../shared/cachedAggregate';
import { communityFundLedger } from '../ledger/communityFund';
import { notificationsService } from '../notifications/notifications.service';
import { feeService } from '../payments/fees';
import { paymentsService } from '../payments/payments.service';
import { resolveModules } from '../vendors/modules.service';
import { vendorsService } from '../vendors/vendors.service';
import {
  CommunityContributionModel,
  CommunityFundModel,
  CommunityRedemptionModel,
} from './payforward.model';

/**
 * ═══ PAY IT FORWARD (ADR-005) ═══
 *
 * Contribution is intent → webhook → credit, copied from `PingBudgetTopup` because the alternative
 * has already been shipped once here and was wrong: a balance that rises before the money lands
 * pays out capital nobody has.
 *
 * Redemption is two-phase — reserve, then apply once the customer's payment actually settles. The
 * naive order (spend the pool, then charge the card) leaves the vendor short on every declined card,
 * and there is no way to un-eat the meal.
 *
 * Caps, the daily limit, and the tier gate are ALL enforced here and never in the client. The one
 * that matters most is enforced by a unique index rather than by code, because two concurrent taps
 * would both pass a read-then-write.
 */

/** UTC day. The one-per-day rule needs a stable key both sides of midnight in any timezone. */
export function dayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function shapeFund(doc: {
  business_id: string;
  balance_cents?: number;
  accepting?: boolean;
  max_per_redemption_cents?: number | null;
  max_percent_of_order?: number;
  max_per_day_cents?: number | null;
  expiry_days?: number;
}) {
  return {
    businessId: doc.business_id,
    balanceCents: doc.balance_cents ?? 0,
    accepting: doc.accepting ?? true,
    maxPerRedemptionCents: doc.max_per_redemption_cents ?? null,
    maxPercentOfOrder: doc.max_percent_of_order ?? 100,
    maxPerDayCents: doc.max_per_day_cents ?? null,
    expiryDays: doc.expiry_days ?? PAY_FORWARD_DEFAULT_EXPIRY_DAYS,
  };
}

/**
 * Public view of a contribution. Anonymity is applied HERE, at serialisation, so no read path can
 * forget it — the flag is honoured once rather than at every call site that renders a name.
 */
function shapeContribution(doc: {
  _id: unknown;
  amount_cents: number;
  anonymous?: boolean;
  display_name?: string | null;
  note?: string | null;
  created_at?: Date;
}) {
  return {
    id: String(doc._id),
    amountCents: doc.amount_cents,
    // Never the contributor's user id, and never a name they did not volunteer.
    givenBy: doc.anonymous === false ? (doc.display_name ?? null) : null,
    note: doc.note ?? null,
    createdAt: doc.created_at,
  };
}

async function ensureOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) {
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  }
}

async function getOrCreateFund(businessId: string) {
  return CommunityFundModel.findOneAndUpdate(
    { business_id: businessId },
    { $setOnInsert: { business_id: businessId } },
    { upsert: true, new: true },
  ).exec();
}

export const payforwardService = {
  // ─── Fund + settings ──────────────────────────────────────────────────────────────────────
  async getFund(businessId: string) {
    const fund = await getOrCreateFund(businessId);
    return shapeFund(fund);
  },

  async updateSettings(
    principal: Principal,
    businessId: string,
    patch: {
      accepting?: boolean;
      maxPerRedemptionCents?: number | null;
      maxPercentOfOrder?: number;
      maxPerDayCents?: number | null;
      expiryDays?: number;
    },
  ) {
    await ensureOwner(principal, businessId);
    const $set: Record<string, unknown> = {};
    if (patch.accepting !== undefined) $set.accepting = patch.accepting;
    if (patch.maxPerRedemptionCents !== undefined)
      $set.max_per_redemption_cents = patch.maxPerRedemptionCents;
    if (patch.maxPercentOfOrder !== undefined) $set.max_percent_of_order = patch.maxPercentOfOrder;
    if (patch.maxPerDayCents !== undefined) $set.max_per_day_cents = patch.maxPerDayCents;
    /**
     * Changing the expiry window applies to money given from now on. Contributions already in the
     * pool keep the `expires_at` they were given under: a vendor must not be able to shorten the
     * life of a gift somebody has already made.
     */
    if (patch.expiryDays !== undefined) $set.expiry_days = patch.expiryDays;

    const fund = await CommunityFundModel.findOneAndUpdate(
      { business_id: businessId },
      { $set, $setOnInsert: { business_id: businessId } },
      { upsert: true, new: true },
    ).exec();

    await writeAudit({
      actorId: principal.userId,
      action: 'payforward.settings_updated',
      entityType: 'community_fund',
      entityId: businessId,
      metadata: patch as Record<string, unknown>,
    });
    return shapeFund(fund);
  },

  // ─── Contribution (money in) ──────────────────────────────────────────────────────────────
  /**
   * Opens a real card charge to the PLATFORM (the money is custodial, not the vendor's) and records
   * a pending contribution. The pool is untouched until `creditContribution` runs from the webhook.
   *
   * No platform fee is taken (ADR-005 §4): taking a cut of a gift is indefensible.
   */
  async contribute(
    principal: Principal,
    businessId: string,
    input: { amountCents: number; anonymous?: boolean; displayName?: string; note?: string },
    idempotencyKey: string,
  ) {
    if (
      input.amountCents < PAY_FORWARD_MIN_CONTRIBUTION_CENTS ||
      input.amountCents > PAY_FORWARD_MAX_CONTRIBUTION_CENTS
    ) {
      throw ValidationError(
        `A contribution must be between ${formatCents(PAY_FORWARD_MIN_CONTRIBUTION_CENTS)} and ${formatCents(PAY_FORWARD_MAX_CONTRIBUTION_CENTS)}`,
      );
    }

    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');

    const { enabled } = await resolveModules(businessId);
    if (!enabled.includes('pay_it_forward')) {
      throw BusinessRuleError(
        ERROR_CODES.MODULE_DISABLED,
        'This business does not have Pay It Forward switched on',
      );
    }

    const fund = await getOrCreateFund(businessId);
    if (!fund.accepting) {
      throw BusinessRuleError(
        ERROR_CODES.PAY_FORWARD_NOT_ACCEPTING,
        'This business is not accepting contributions right now',
      );
    }

    const charge = await paymentsService.chargeToPlatform({
      amountCents: input.amountCents,
      transferGroup: `payforward_${businessId}`,
      metadata: { kind: 'payforward_contribution', businessId },
      idempotencyKey: `pf_contrib_${idempotencyKey}`,
      ...(principal.email ? { receiptEmail: principal.email } : {}),
    });

    const contribution = await CommunityContributionModel.create({
      business_id: businessId,
      contributor_id: principal.userId,
      amount_cents: input.amountCents,
      remaining_cents: input.amountCents,
      stripe_payment_intent_id: charge.paymentIntentId,
      // Anonymous unless the giver actively said otherwise, and a name only if they supplied one.
      anonymous: input.anonymous !== false,
      display_name: input.anonymous === false ? (input.displayName ?? null) : null,
      note: input.note ?? null,
    });

    return {
      contributionId: String(contribution._id),
      businessId,
      amountCents: input.amountCents,
      // Unchanged: the money has not arrived yet, and saying otherwise would be the whole defect.
      balanceCents: fund.balance_cents,
      clientSecret: charge.clientSecret,
    };
  },

  /**
   * The charge settled — the money now genuinely exists, so credit the pool and post the ledger.
   * Idempotent: a redelivered webhook finds the row already `succeeded` and does nothing.
   */
  async creditContribution(paymentIntentId: string): Promise<{ handled: boolean }> {
    const contribution = await CommunityContributionModel.findOne({
      stripe_payment_intent_id: paymentIntentId,
    }).exec();
    if (!contribution) return { handled: false }; // not ours — let the next handler try
    if (contribution.status === 'succeeded') return { handled: true };

    const fund = await getOrCreateFund(contribution.business_id);
    const expiresAt = new Date(
      Date.now() + (fund.expiry_days ?? PAY_FORWARD_DEFAULT_EXPIRY_DAYS) * 86_400_000,
    );

    // Claim the row. A duplicate webhook loses this race and does nothing.
    const claimed = await CommunityContributionModel.findOneAndUpdate(
      { _id: contribution._id, status: 'pending' },
      { $set: { status: 'succeeded', credited_at: new Date(), expires_at: expiresAt } },
    ).exec();
    if (!claimed) return { handled: true };

    await CommunityFundModel.updateOne(
      { business_id: contribution.business_id },
      { $inc: { balance_cents: contribution.amount_cents } },
      { upsert: true },
    ).exec();

    await communityFundLedger.contribute({
      fund: { businessId: contribution.business_id },
      amountCents: contribution.amount_cents,
      contributionId: String(contribution._id),
      memo: `Pay It Forward contribution ${formatCents(contribution.amount_cents)}`,
    });

    const owner = await vendorsService.getBusinessOwner(contribution.business_id);
    if (owner) {
      notificationsService.notify(owner, {
        category: 'generosity',
        title: 'Someone paid it forward',
        body: `${formatCents(contribution.amount_cents)} is waiting for your next customer who needs it.`,
        data: { businessId: contribution.business_id, audience: 'vendor' },
      });
    }

    await invalidateAggregate(`pf:impact:${contribution.business_id}`);
    await writeAudit({
      actorId: contribution.contributor_id,
      action: 'payforward.contributed',
      entityType: 'community_fund',
      entityId: contribution.business_id,
      metadata: { amountCents: contribution.amount_cents, paymentIntentId },
    });
    return { handled: true };
  },

  /**
   * The charge failed. Recording it matters: a contribution stuck at `pending` forever is
   * indistinguishable from one still in flight, and the giver has no way to tell that their gesture
   * did not land. (`PingBudgetTopup.status.failed` is on the known-unwritten list for exactly this
   * reason — this module does not repeat it.)
   */
  async failContribution(paymentIntentId: string, reason: string): Promise<{ handled: boolean }> {
    const res = await CommunityContributionModel.findOneAndUpdate(
      { stripe_payment_intent_id: paymentIntentId, status: 'pending' },
      { $set: { status: 'failed', failure_reason: reason } },
    ).exec();
    return { handled: Boolean(res) };
  },

  // ─── Redemption (money out) ───────────────────────────────────────────────────────────────
  /**
   * How much the fund WOULD cover for this person on this order, with no side effects. Used by the
   * quote path so the customer sees the offer before committing to anything.
   *
   * `coverableCents` excludes tip and round-up on purpose: the community pays for the meal, the
   * customer pays their own tip. Funding someone else's gratuity is not what anyone gave for.
   */
  async quoteRedemption(input: {
    businessId: string;
    userId: string;
    userTier: string;
    coverableCents: number;
  }): Promise<{ availableCents: number; reason: string | null }> {
    if (input.coverableCents <= 0) return { availableCents: 0, reason: null };

    const { enabled } = await resolveModules(input.businessId);
    if (!enabled.includes('pay_it_forward')) return { availableCents: 0, reason: null };

    const fund = await CommunityFundModel.findOne({ business_id: input.businessId }).lean().exec();
    if (!fund || fund.balance_cents <= 0) return { availableCents: 0, reason: null };

    if (
      TIER_RANK[input.userTier as keyof typeof TIER_RANK] < TIER_RANK[PAY_FORWARD_REDEEM_MIN_TIER]
    ) {
      return { availableCents: 0, reason: 'verification_required' };
    }

    const today = dayKey();
    const already = await CommunityRedemptionModel.findOne({
      business_id: input.businessId,
      user_id: input.userId,
      day_key: today,
      status: { $in: ['reserved', 'applied'] },
    })
      .lean()
      .exec();
    if (already) return { availableCents: 0, reason: 'daily_limit' };

    const available = await this.computeCoverage(fund, input.businessId, input.coverableCents);
    return { availableCents: available, reason: available > 0 ? null : 'exhausted' };
  },

  /**
   * The caps, in one place, applied in order. Every one of them is a floor on the same number, so
   * the answer is simply the smallest — which is also why partial payment (PIF-6) needs no code of
   * its own: it is what this returns whenever the fund cannot cover the whole order.
   */
  async computeCoverage(
    fund: {
      balance_cents: number;
      max_per_redemption_cents?: number | null;
      max_percent_of_order?: number;
      max_per_day_cents?: number | null;
    },
    businessId: string,
    coverableCents: number,
  ): Promise<number> {
    const caps = [coverableCents, fund.balance_cents];

    if (fund.max_per_redemption_cents != null) caps.push(fund.max_per_redemption_cents);

    const percent = fund.max_percent_of_order ?? 100;
    if (percent < 100) caps.push(applyPercent(coverableCents, percent));

    if (fund.max_per_day_cents != null) {
      const spentToday = await CommunityRedemptionModel.aggregate<{ total: number }>([
        {
          $match: {
            business_id: businessId,
            day_key: dayKey(),
            status: { $in: ['reserved', 'applied'] },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount_cents' } } },
      ]).exec();
      const used = spentToday[0]?.total ?? 0;
      caps.push(Math.max(0, fund.max_per_day_cents - used));
    }

    return Math.max(0, Math.min(...caps));
  },

  /**
   * Commit the fund to an order, before the customer's payment is attempted.
   *
   * Two guards do the real work, and both are atomic because a read-then-write would let two
   * concurrent taps through:
   *
   *  1. `$inc` with a `$gte` balance guard — the pool cannot go negative, ever.
   *  2. The unique index on `{business_id, user_id, day_key}` — one redemption per person per
   *     business per day, decided by the database.
   *
   * If the second fails the first is compensated immediately, so a person who has already been
   * helped today does not silently drain the pool.
   */
  async reserve(input: {
    businessId: string;
    userId: string;
    userTier: string;
    coverableCents: number;
  }): Promise<
    | { redemptionId: string; amountCents: number; reason: null }
    | { redemptionId: null; amountCents: 0; reason: string }
  > {
    const quote = await this.quoteRedemption(input);
    if (quote.availableCents <= 0) {
      /**
       * The customer asked for help and there is none. The order still goes through at full price —
       * refusing to sell someone lunch because a gift was unavailable would be a strange way to run
       * a generosity feature — but the caller MUST be told, so the receipt can say why rather than
       * silently charging what the customer did not expect.
       */
      return { redemptionId: null, amountCents: 0, reason: quote.reason ?? 'exhausted' };
    }
    const amountCents = quote.availableCents;

    const reserved = await CommunityFundModel.findOneAndUpdate(
      { business_id: input.businessId, balance_cents: { $gte: amountCents } },
      { $inc: { balance_cents: -amountCents } },
      { new: true },
    ).exec();
    // Someone else got there first. The order proceeds unfunded rather than failing.
    if (!reserved) return { redemptionId: null, amountCents: 0, reason: 'exhausted' };

    try {
      const redemption = await CommunityRedemptionModel.create({
        business_id: input.businessId,
        user_id: input.userId,
        amount_cents: amountCents,
        day_key: dayKey(),
        status: 'reserved',
      });
      return { redemptionId: String(redemption._id), amountCents, reason: null };
    } catch (err) {
      // Duplicate key = already helped today. Give the money straight back to the pool.
      await CommunityFundModel.updateOne(
        { business_id: input.businessId },
        { $inc: { balance_cents: amountCents } },
      ).exec();
      // Already helped today. Not an error the customer should be blocked by — they still want
      // their lunch — but it must be reported rather than swallowed.
      if ((err as { code?: number }).code === 11000) {
        return { redemptionId: null, amountCents: 0, reason: 'daily_limit' };
      }
      throw err;
    }
  },

  /**
   * The customer's payment went through (or there was nothing left to pay). Consume the money FIFO,
   * post the ledger, and tell the customer what happened.
   */
  async apply(input: { redemptionId: string; orderId: string; customerId: string }): Promise<void> {
    const redemption = await CommunityRedemptionModel.findOneAndUpdate(
      { _id: input.redemptionId, status: 'reserved' },
      { $set: { status: 'applied', applied_at: new Date(), order_id: input.orderId } },
      { new: true },
    ).exec();
    if (!redemption) return;

    // ADR-005 §4 — an ordinary sale, so the ordinary marketplace fee applies.
    const feeCents = await feeService.resolveFee('marketplace', redemption.amount_cents);
    await CommunityRedemptionModel.updateOne(
      { _id: redemption._id },
      { $set: { fee_cents: feeCents } },
    ).exec();

    await this.consumeFifo(redemption.business_id, redemption.amount_cents);

    await communityFundLedger.redeem({
      fund: { businessId: redemption.business_id },
      amountCents: redemption.amount_cents,
      feeCents,
      redemptionId: String(redemption._id),
      memo: `Pay It Forward covered ${formatCents(redemption.amount_cents)}`,
    });

    await invalidateAggregate(`pf:impact:${redemption.business_id}`);
    notificationsService.notify(input.customerId, {
      category: 'generosity',
      title: 'Someone paid it forward for you',
      body: `${formatCents(redemption.amount_cents)} of your order was covered by the community.`,
      data: { businessId: redemption.business_id, orderId: input.orderId },
    });
  },

  /** The payment failed, so the fund was never spent. Put it back and free the person's daily slot. */
  async release(redemptionId: string, reason: string): Promise<void> {
    const redemption = await CommunityRedemptionModel.findOneAndUpdate(
      { _id: redemptionId, status: 'reserved' },
      { $set: { status: 'released', released_reason: reason } },
      { new: true },
    ).exec();
    if (!redemption) return;

    await CommunityFundModel.updateOne(
      { business_id: redemption.business_id },
      { $inc: { balance_cents: redemption.amount_cents } },
    ).exec();
  },

  /**
   * Draw down the oldest live contributions first. FIFO is what makes expiry meaningful: without it
   * the sweep could not say which dollars had been sitting unused, and the newest gift would age at
   * the same rate as the oldest.
   */
  async consumeFifo(businessId: string, amountCents: number): Promise<void> {
    let left = amountCents;
    const live = await CommunityContributionModel.find({
      business_id: businessId,
      status: 'succeeded',
      remaining_cents: { $gt: 0 },
    })
      .sort({ created_at: 1 })
      .exec();

    for (const c of live) {
      if (left <= 0) break;
      const take = Math.min(left, c.remaining_cents);
      const ok = await CommunityContributionModel.updateOne(
        { _id: c._id, remaining_cents: { $gte: take } },
        { $inc: { remaining_cents: -take } },
      ).exec();
      if (ok.modifiedCount > 0) left -= take;
    }

    if (left > 0) {
      // The pool balance and the contribution rows disagree. The ledger is unaffected (it was posted
      // from the redemption), so this is a projection bug rather than lost money — but it is exactly
      // the kind of drift that must be visible rather than absorbed.
      logger.error(
        { businessId, amountCents, shortfallCents: left },
        'payforward FIFO could not fully allocate a redemption',
      );
    }
  },

  // ─── Impact (PIF-11) ──────────────────────────────────────────────────────────────────────
  /**
   * Every figure is computed from immutable rows, never from a running counter. A counter drifts
   * under refunds, releases, and expiry — and a published "meals given" number that is wrong is a
   * credibility problem rather than a rounding error.
   */
  async impact(businessId: string) {
    /**
     * Cached for 60s (D-9 / Phase 6.3). This endpoint is PUBLIC and runs two unbounded `$group`
     * aggregations over every contribution and redemption the business has ever had — a full scan
     * per viewer, on a page whose whole purpose is to be shown to lots of people.
     *
     * Still derived from immutable rows, never a counter: the cache shortens how often the sum is
     * recomputed, it does not become the source of truth. It is dropped on every contribution and
     * redemption, so the only staleness a real user sees is from somebody else's activity.
     */
    return cachedAggregate(`pf:impact:${businessId}`, 60, () => this.computeImpact(businessId));
  },

  async computeImpact(businessId: string) {
    const [contributed, redeemed, fund] = await Promise.all([
      CommunityContributionModel.aggregate<{ total: number; count: number; max: number }>([
        { $match: { business_id: businessId, status: 'succeeded' } },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount_cents' },
            count: { $sum: 1 },
            max: { $max: '$amount_cents' },
          },
        },
      ]).exec(),
      CommunityRedemptionModel.aggregate<{ total: number; count: number; people: string[] }>([
        { $match: { business_id: businessId, status: 'applied' } },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount_cents' },
            count: { $sum: 1 },
            people: { $addToSet: '$user_id' },
          },
        },
      ]).exec(),
      CommunityFundModel.findOne({ business_id: businessId }).lean().exec(),
    ]);

    const gave = contributed[0];
    const got = redeemed[0];
    return {
      businessId,
      availableCents: fund?.balance_cents ?? 0,
      contributedCents: gave?.total ?? 0,
      contributionCount: gave?.count ?? 0,
      largestContributionCents: gave?.max ?? 0,
      averageContributionCents: gave?.count ? Math.round(gave.total / gave.count) : 0,
      redeemedCents: got?.total ?? 0,
      redemptionCount: got?.count ?? 0,
      /** Distinct accounts helped. Never a list — who accepted help is not the vendor's to publish. */
      peopleHelped: got?.people?.length ?? 0,
    };
  },

  /** Recent gifts for the business's wall, anonymity applied at serialisation. */
  async recentContributions(businessId: string, limit = 20) {
    const rows = await CommunityContributionModel.find({
      business_id: businessId,
      status: 'succeeded',
    })
      .sort({ created_at: -1 })
      .limit(Math.min(limit, 50))
      .lean()
      .exec();
    return rows.map(shapeContribution);
  },

  // ─── Expiry sweep (PIF-24 / ADR-005 §6) ───────────────────────────────────────────────────
  /**
   * Retire money nobody used, oldest first, into the platform's city fund.
   *
   * It does not go to the vendor. That exclusion is the entire point: a vendor who kept unredeemed
   * money would profit from suppressing redemption, and the vendor controls the caps, the settings,
   * and the prompt at checkout.
   */
  async expireStale(): Promise<number> {
    const due = await CommunityContributionModel.find({
      status: 'succeeded',
      remaining_cents: { $gt: 0 },
      expires_at: { $lte: new Date() },
      expired_at: null,
    })
      .sort({ expires_at: 1 })
      .limit(SWEEP_BATCH_LIMIT)
      .exec();

    let expired = 0;
    for (const c of due) {
      const claimed = await CommunityContributionModel.findOneAndUpdate(
        { _id: c._id, expired_at: null, remaining_cents: { $gt: 0 } },
        { $set: { expired_at: new Date(), remaining_cents: 0 } },
      ).exec();
      if (!claimed) continue;
      const amount = claimed.remaining_cents;

      await CommunityFundModel.updateOne(
        { business_id: c.business_id, balance_cents: { $gte: amount } },
        { $inc: { balance_cents: -amount } },
      ).exec();

      await communityFundLedger.expire({
        fund: { businessId: c.business_id },
        amountCents: amount,
        citySlug: env.DEFAULT_CITY,
        expiryId: String(c._id),
        memo: `Unredeemed after ${String(c.expires_at)}`,
      });
      expired += 1;
    }

    reportSweepBatch('payforward-expiry', due.length);
    return expired;
  },

  /**
   * Warn the vendor before money in their pool goes stale, so it can be spent on someone. Sent once
   * per contribution — the notice is useful, a weekly reminder about the same $20 is nagging.
   */
  async sendExpiryNotices(): Promise<number> {
    const horizon = new Date(Date.now() + PAY_FORWARD_EXPIRY_NOTICE_DAYS * 86_400_000);
    const soon = await CommunityContributionModel.find({
      status: 'succeeded',
      remaining_cents: { $gt: 0 },
      expired_at: null,
      expiry_notice_sent: { $ne: true },
      expires_at: { $lte: horizon, $gt: new Date() },
    })
      .limit(SWEEP_BATCH_LIMIT)
      .exec();

    const byBusiness = new Map<string, number>();
    for (const c of soon) {
      byBusiness.set(c.business_id, (byBusiness.get(c.business_id) ?? 0) + c.remaining_cents);
      await CommunityContributionModel.updateOne(
        { _id: c._id },
        { $set: { expiry_notice_sent: true } },
      ).exec();
    }

    let sent = 0;
    for (const [businessId, cents] of byBusiness) {
      const owner = await vendorsService.getBusinessOwner(businessId);
      if (!owner) continue;
      notificationsService.notify(owner, {
        category: 'generosity',
        title: 'Community money is going unused',
        body: `${formatCents(cents)} in your Pay It Forward pool expires soon. Offer it to a customer who needs it.`,
        data: { businessId, audience: 'vendor' },
      });
      sent += 1;
    }
    return sent;
  },
};
