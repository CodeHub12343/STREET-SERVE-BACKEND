import { env } from '../../config/env';
import {
  PAY_FORWARD_DEFAULT_EXPIRY_DAYS,
  PAY_FORWARD_EXPIRY_NOTICE_DAYS,
  PAY_FORWARD_MAX_CONTRIBUTION_CENTS,
  PAY_FORWARD_ABANDON_AFTER_MS,
  PAY_FORWARD_MIN_CONTRIBUTION_CENTS,
  PAY_FORWARD_RECONCILE_AFTER_MS,
  PAY_FORWARD_REFUND_WINDOW_MS,
  PAY_FORWARD_REDEEM_MIN_TIER,
  TIER_RANK,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { stripe } from '../../integrations/stripe';
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

/**
 * How much of a gift could be taken back right now (ADR-005 §7): the unspent remainder, and only
 * inside the window. Zero once any of those stops being true — the caller then simply does not
 * offer it, and `refundContribution` re-checks with the reasons.
 */
function refundableNow(creditedAt: Date | null | undefined, remainingCents: number): number {
  if (!creditedAt || remainingCents <= 0) return 0;
  const open = Date.now() <= creditedAt.getTime() + PAY_FORWARD_REFUND_WINDOW_MS;
  return open ? remainingCents : 0;
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
    if (!res) return { handled: false };

    /**
     * Tell the giver. Recording the failure in the database was only half the job: a person who
     * meant to help someone and whose card was declined heard nothing at all, and had no way to
     * discover it — a contribution is the one payment in this platform that sends back no receipt,
     * no order, and no goods, so silence is indistinguishable from success.
     *
     * Deliberately does not restate the decline reason from Stripe: the giver needs to know it did
     * not go through and that they can try again, not the processor's error taxonomy.
     */
    notificationsService.notify(res.contributor_id, {
      category: 'generosity',
      title: 'Your gift didn’t go through',
      body: `Your ${formatCents(res.amount_cents)} Pay It Forward gift couldn’t be taken from your card, so nothing was charged. You can try again whenever you like.`,
      data: { businessId: res.business_id, contributionId: String(res._id) },
    });
    return { handled: true };
  },

  /**
   * ═══ Rescue contributions whose webhook never arrived. ═══
   *
   * A webhook is a delivery PROMISE, not a guarantee: the endpoint 500s, the forwarder is down,
   * Stripe's retries lapse. When one is missed here the money HAS been taken and the pool is never
   * credited — the giver is charged, no one is ever helped by it, and nothing in the system knows.
   * Of all the places to lose a webhook this is the worst, because there is no order to chase and
   * no goods to be missing: the contribution simply sits `pending` and no party has a reason to
   * look.
   *
   * The ads module carries this same rescue for exactly this reason, after two real placements were
   * charged and stayed pending. This is the same pattern: **Stripe is authoritative**, we ask it
   * what actually happened rather than trusting our own row, and we only ever move a contribution
   * forward when Stripe says the money is there. Idempotent by construction — it reuses
   * `creditContribution`/`failContribution`, which no-op on anything not still pending.
   */
  async reconcilePendingContributions(limit = SWEEP_BATCH_LIMIT): Promise<{
    checked: number;
    credited: number;
    failed: number;
  }> {
    /**
     * A grace period, so this never races the webhook it is backstopping. An intent created seconds
     * ago is not late, it is in flight — and crediting it here would only duplicate work the
     * webhook is about to do (harmlessly, but noisily).
     */
    const cutoff = new Date(Date.now() - PAY_FORWARD_RECONCILE_AFTER_MS);
    const pending = await CommunityContributionModel.find({
      status: 'pending',
      stripe_payment_intent_id: { $ne: null },
      created_at: { $lte: cutoff },
    })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    let credited = 0;
    let failed = 0;
    for (const c of pending) {
      const pi = String(c.stripe_payment_intent_id);
      try {
        const intent = await stripe().retrievePaymentIntent(pi);
        if (intent.status === 'succeeded') {
          const res = await this.creditContribution(pi);
          if (res.handled) {
            credited += 1;
            logger.warn(
              { contributionId: String(c._id), paymentIntentId: pi },
              'credited a paid Pay It Forward contribution whose webhook never arrived — check webhook delivery',
            );
          }
        } else if (intent.status === 'canceled') {
          /**
           * A dead intent must not linger as pending for ever. Left alone it is indistinguishable
           * from one still in flight, both to the giver and to this sweep on every future run.
           */
          await this.failContribution(pi, 'payment_canceled');
          failed += 1;
        }
      } catch (err) {
        // One unreadable intent must not stop the others from being rescued.
        logger.error(
          { err, contributionId: String(c._id) },
          'could not reconcile a Pay It Forward contribution',
        );
      }
    }

    reportSweepBatch('payforward-reconcile', pending.length);
    return { checked: pending.length, credited, failed };
  },

  /**
   * ═══ ADR-005 §7 — take a gift back, within 24 hours, unspent part only. ═══
   *
   * The window existed on paper and nowhere else: the ledger leg was written and correct, but only
   * Boost ever called it, so a Pay It Forward gift was final the instant it settled. Someone who
   * mistyped $200 for $20 had no way back except a support ticket.
   *
   * **Only `remaining_cents` is refundable, and that is the whole design.** Money that has already
   * covered an order is gone in the only sense that matters — a person ate. Returning it would mean
   * either asking them to give the meal back, or making the platform absorb a loss that anyone
   * could trigger deliberately by giving, waiting for a redemption, and reversing.
   *
   * The vendor is not told. They were notified when it arrived; a reversal notice would invite them
   * to treat a custodial pool as revenue being taken away, which it never was.
   */
  async refundContribution(principal: Principal, contributionId: string) {
    const contribution = await CommunityContributionModel.findById(contributionId).exec();
    if (!contribution) throw NotFoundError('Contribution not found');
    if (contribution.contributor_id !== principal.userId) {
      throw ForbiddenError('Not your contribution', ERROR_CODES.NOT_OWNER);
    }
    if (contribution.status !== 'succeeded') {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        contribution.status === 'pending'
          ? 'This gift has not been charged yet. Nothing has left your account.'
          : 'This gift never went through, so there is nothing to return.',
      );
    }

    /**
     * The window runs from when the money actually ARRIVED, not from when the gift was requested —
     * a card that took ten minutes to clear must not eat ten minutes of the giver's 24 hours. The
     * fallbacks only matter for rows written before `credited_at` existed.
     */
    const creditedAt = contribution.credited_at ?? contribution.created_at ?? new Date();
    const deadline = new Date(creditedAt.getTime() + PAY_FORWARD_REFUND_WINDOW_MS);
    if (Date.now() > deadline.getTime()) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'The 24-hour window for taking this gift back has passed. It is waiting for someone who needs it.',
      );
    }

    const refundable = contribution.remaining_cents;
    if (refundable <= 0) {
      /**
       * Named precisely rather than "cannot refund". The giver's money did exactly what they
       * intended — telling them it "failed" would be both wrong and unkind.
       */
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This gift has already gone to someone, so there is nothing left to return.',
      );
    }

    /**
     * Take it out of the pool FIRST, guarded, and only then move real money. The other order would
     * refund a card and then discover the pool had been drawn down in the meantime — leaving the
     * platform short by an amount it had already paid out.
     */
    const debited = await CommunityFundModel.findOneAndUpdate(
      { business_id: contribution.business_id, balance_cents: { $gte: refundable } },
      { $inc: { balance_cents: -refundable } },
      { new: true },
    ).exec();
    if (!debited) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Someone is using this fund right now. Try again in a moment.',
      );
    }

    // Claim the gift's unspent balance so a concurrent redemption cannot also draw on it.
    const claimed = await CommunityContributionModel.findOneAndUpdate(
      { _id: contribution._id, remaining_cents: { $gte: refundable } },
      { $inc: { remaining_cents: -refundable } },
    ).exec();
    if (!claimed) {
      await CommunityFundModel.updateOne(
        { business_id: contribution.business_id },
        { $inc: { balance_cents: refundable } },
      ).exec();
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Part of this gift was just used. Reload to see what is left.',
      );
    }

    let refundId: string;
    try {
      const res = await stripe().createRefund({
        paymentIntentId: contribution.stripe_payment_intent_id,
        amountCents: refundable,
        idempotencyKey: `pf_refund_${contributionId}`,
      });
      refundId = res.refundId;
    } catch (err) {
      // The money never left. Put the pool and the gift back exactly as they were.
      await CommunityFundModel.updateOne(
        { business_id: contribution.business_id },
        { $inc: { balance_cents: refundable } },
      ).exec();
      await CommunityContributionModel.updateOne(
        { _id: contribution._id },
        { $inc: { remaining_cents: refundable } },
      ).exec();
      logger.error({ err, contributionId }, 'Pay It Forward refund failed at the processor');
      throw err;
    }

    await CommunityContributionModel.updateOne(
      { _id: contribution._id },
      {
        $set: { refunded_at: new Date(), stripe_refund_id: refundId },
        $inc: { refunded_cents: refundable },
      },
    ).exec();

    await communityFundLedger.refund({
      fund: { businessId: contribution.business_id },
      amountCents: refundable,
      refundId: String(contribution._id),
      memo: `Giver took back ${formatCents(refundable)} within the 24-hour window`,
    });

    await invalidateAggregate(`pf:impact:${contribution.business_id}`);
    await writeAudit({
      actorId: principal.userId,
      action: 'payforward.contribution_refunded',
      entityType: 'community_fund',
      entityId: contribution.business_id,
      metadata: { contributionId, refundedCents: refundable, refundId },
    });

    return {
      contributionId,
      refundedCents: refundable,
      /** What stayed spent, so the screen can say it rather than implying a partial failure. */
      keptCents: contribution.amount_cents - refundable,
    };
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
   * ═══ The order was cancelled. Give the community its money back. ═══
   *
   * `cancel` refunded the customer's card and stopped there, so the community's share of a
   * cancelled order simply evaporated: the pool had been debited, the FIFO contributions consumed,
   * the ledger posted — and then the meal never happened. Nobody was fed and the money was gone.
   * On a fully-covered order the customer's refund is £0, so there was no trace of the loss on any
   * screen at all.
   *
   * Returned to the POOL, not to the giver. The gift was made to the fund rather than to a
   * particular order, so the right destination is the fund, ready for the next person — refunding
   * the original card would undo a gift its giver never withdrew.
   *
   * The day-slot is deliberately NOT freed. The redemption is reversed for accounting, but the
   * `{business, user, day}` row stays `refunded` so it still occupies the unique index: releasing
   * it would let someone order, cancel, and re-draw the fund repeatedly within a day, which is the
   * cheapest possible way to drain a pool. A person genuinely affected by this waits until
   * tomorrow, which is the same rule everyone else is under.
   */
  async refundRedemptionForOrder(
    orderId: string,
    opts: { freeDailySlot?: boolean; reason?: string } = {},
  ): Promise<number> {
    /**
     * `refunded` keeps the person's daily slot; `released` frees it. The difference is whether the
     * redemption HAPPENED. A cancelled order did happen and was unwound, so the slot stays used —
     * otherwise order-cancel-redraw is the cheapest way to drain a pool. An ABANDONED checkout
     * never happened at all: nobody was fed, and blocking someone's whole day because their
     * connection dropped mid-payment is punishing them for our timeout.
     */
    const status = opts.freeDailySlot ? 'released' : 'refunded';
    const redemption = await CommunityRedemptionModel.findOneAndUpdate(
      { order_id: orderId, status: 'applied' },
      {
        $set: {
          status,
          refunded_at: new Date(),
          ...(opts.reason ? { released_reason: opts.reason } : {}),
        },
      },
      { new: true },
    ).exec();
    if (!redemption) return 0; // no community money in this order, or already reversed

    const amount = redemption.amount_cents;
    await CommunityFundModel.updateOne(
      { business_id: redemption.business_id },
      { $inc: { balance_cents: amount } },
    ).exec();

    /**
     * Put the money back on the contributions it came off, newest-consumed first, so FIFO ordering
     * survives the round trip: a reversal that restored the OLDEST contributions would quietly
     * reset the expiry clock on money that was about to lapse.
     */
    await this.restoreFifo(redemption.business_id, amount);

    /**
     * The INVERSE of the redeem posting, not a contributor refund: nothing leaves the platform, the
     * community is simply owed its money again. The fee reversed is the one actually taken at
     * redeem time, read off the row rather than recomputed — a fee-rule change between the order
     * and its cancellation must not alter what is given back.
     */
    await communityFundLedger.reverseRedemption({
      fund: { businessId: redemption.business_id },
      amountCents: amount,
      feeCents: redemption.fee_cents ?? 0,
      redemptionId: String(redemption._id),
      memo: `Order ${orderId} cancelled — returned to the fund`,
    });

    await invalidateAggregate(`pf:impact:${redemption.business_id}`);
    await writeAudit({
      action: 'payforward.redemption_refunded',
      entityType: 'community_fund',
      entityId: redemption.business_id,
      metadata: { orderId, amountCents: amount, redemptionId: String(redemption._id) },
    });
    return amount;
  },

  /**
   * ═══ Release community money held by a checkout nobody ever paid for. ═══
   *
   * The fund is committed when an order is PLACED — deliberately, so a declined card cannot leave
   * the vendor short. But `release` only fires when the charge THROWS, and a customer who simply
   * closes the payment sheet throws nothing. That order sits `pending` for ever, its transaction
   * sits `pending` for ever, and the community money it reserved is consumed permanently: on a
   * fully covered order no card was even charged, so there is nothing to decline and nothing to
   * notice. A small pool could be emptied by people who wandered off.
   *
   * Bounded, idempotent, and deliberately conservative — it only touches orders still `pending`
   * whose transaction has NOT completed. A paid order is never unwound by a timeout.
   */
  async releaseAbandonedCheckouts(limit = SWEEP_BATCH_LIMIT): Promise<{
    checked: number;
    released: number;
  }> {
    const cutoff = new Date(Date.now() - PAY_FORWARD_ABANDON_AFTER_MS);
    const { OrderModel } = await import('../orders/orders.model');
    const { TransactionModel } = await import('../payments/payments.model');

    const stale = await OrderModel.find({
      status: 'pending',
      pay_it_forward_cents: { $gt: 0 },
      created_at: { $lte: cutoff },
    })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean()
      .exec();

    let released = 0;
    for (const order of stale) {
      const orderId = String(order._id);
      try {
        /**
         * A partly covered order has a card charge. If it actually SETTLED, the customer paid and
         * this is a live order the vendor simply has not accepted yet — never unwind that.
         */
        if (order.transaction_id) {
          const txn = await TransactionModel.findById(order.transaction_id).lean().exec();
          if (txn && txn.status !== 'pending') continue;
        }

        const amount = await this.refundRedemptionForOrder(orderId, {
          freeDailySlot: true,
          reason: 'checkout_abandoned',
        });
        if (!amount) continue;

        /**
         * Close the order too. Leaving it `pending` for ever would keep it on the vendor's screen
         * as work to do, and on the customer's as an order that might still arrive.
         */
        await OrderModel.updateOne(
          { _id: order._id, status: 'pending' },
          { $set: { status: 'cancelled', cancelled_reason: 'Payment was not completed' } },
        ).exec();

        released += 1;
        logger.info(
          { orderId, amountCents: amount },
          'released community money from an abandoned checkout',
        );
      } catch (err) {
        // One bad order must not stop the rest of the pool being freed.
        logger.error({ err, orderId }, 'could not release an abandoned Pay It Forward checkout');
      }
    }

    reportSweepBatch('payforward-abandoned', stale.length);
    return { checked: stale.length, released };
  },

  /**
   * The inverse of `consumeFifo`: give the money back to the most-recently-drawn contributions
   * first, so the oldest money stays spent-first and its expiry clock is not rewound.
   */
  async restoreFifo(businessId: string, amountCents: number): Promise<void> {
    let left = amountCents;
    const consumed = await CommunityContributionModel.find({
      business_id: businessId,
      status: 'succeeded',
      expired_at: null,
      $expr: { $lt: ['$remaining_cents', '$amount_cents'] },
    })
      .sort({ created_at: -1 })
      .exec();

    for (const c of consumed) {
      if (left <= 0) break;
      const room = c.amount_cents - c.remaining_cents;
      const give = Math.min(left, room);
      if (give <= 0) continue;
      const ok = await CommunityContributionModel.updateOne(
        // Guarded so a concurrent redemption cannot push `remaining` above what was given.
        { _id: c._id, remaining_cents: { $lte: c.amount_cents - give } },
        { $inc: { remaining_cents: give } },
      ).exec();
      if (ok.modifiedCount > 0) left -= give;
    }

    if (left > 0) {
      /**
       * The pool balance is correct (it was incremented directly) but the contribution rows could
       * not absorb the reversal — every contribution it came from has since expired. Visible rather
       * than absorbed: this is drift between the pool and its backing rows, and the FIFO sweep is
       * the only thing that can explain it later.
       */
      logger.error(
        { businessId, amountCents, shortfallCents: left },
        'payforward FIFO could not fully restore a refunded redemption',
      );
    }
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
            /**
             * Net of anything taken back in the §7 window. A gift of $20 whose giver reclaimed $14
             * contributed $6 — the meal that $6 bought genuinely happened, so the row is not
             * erased, but claiming the full $20 as community generosity would overstate it.
             */
            total: { $sum: { $subtract: ['$amount_cents', { $ifNull: ['$refunded_cents', 0] }] } },
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

  /**
   * ═══ A giver's own gifts, with their real status. ═══
   *
   * The one payment in this platform that returns nothing: no order, no goods, no receipt screen.
   * There was no way to answer "did my gift actually go through?" — the public wall shows only
   * `succeeded` contributions and shows them anonymously, so a giver could not even find their own,
   * and a card that failed left no trace they could see.
   *
   * Deliberately shows `pending` and `failed` too. This is the one view where a contribution that
   * did not land is the most important row on the screen.
   */
  async myContributions(userId: string, limit = 20) {
    const rows = await CommunityContributionModel.find({ contributor_id: userId })
      .sort({ created_at: -1 })
      .limit(Math.min(limit, 50))
      .lean()
      .exec();

    const businessIds = [...new Set(rows.map((r) => r.business_id))];
    const { BusinessModel } = await import('../vendors/vendors.model');
    const businesses = await BusinessModel.find({ _id: { $in: businessIds } })
      .select('name')
      .lean()
      .exec();
    const nameById = new Map(businesses.map((b) => [String(b._id), b.name]));

    return rows.map((r) => ({
      id: String(r._id),
      businessId: r.business_id,
      businessName: nameById.get(r.business_id) ?? null,
      amountCents: r.amount_cents,
      status: r.status,
      /**
       * How much of THIS gift is still waiting for someone. The giver gave it; they are entitled to
       * know whether it has done anything yet, and it is the only honest way to show impact per
       * gift without ever naming who was helped.
       */
      remainingCents: r.status === 'succeeded' ? r.remaining_cents : 0,
      note: r.note ?? null,
      anonymous: r.anonymous !== false,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? null,
      expiredAt: r.expired_at ?? null,
      /**
       * ADR-005 §7, answered HERE rather than re-derived on the screen. Whether a gift can still be
       * taken back depends on when the money arrived and how much of it has since fed somebody —
       * both facts the client cannot know, and a second copy of a money rule is how the two stop
       * agreeing. The button is shown when this is positive, and the server re-checks anyway.
       */
      refundableCents:
        r.status === 'succeeded' && !r.expired_at ? refundableNow(r.credited_at, r.remaining_cents) : 0,
      refundableUntil:
        r.status === 'succeeded' && r.credited_at
          ? new Date(r.credited_at.getTime() + PAY_FORWARD_REFUND_WINDOW_MS)
          : null,
      refundedCents: r.refunded_cents ?? 0,
    }));
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
