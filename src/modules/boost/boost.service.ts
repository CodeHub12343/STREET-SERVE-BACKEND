import {
  BOOST_MAX_CONTRIBUTION_CENTS,
  BOOST_MAX_DEADLINE_DAYS,
  BOOST_MAX_GOAL_CENTS,
  BOOST_MIN_CONTRIBUTION_CENTS,
  BOOST_MIN_GOAL_CENTS,
  BOOST_ROLLOVER_GRACE_DAYS,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { stripe } from '../../integrations/stripe';
import { reportSweepBatch, SWEEP_BATCH_LIMIT } from '../../jobs/sweepBatch';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/AppError';
import { formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';
import { communityFundLedger } from '../ledger/communityFund';
import { assertAdvance, type FulfilmentStage } from '../fulfilment/fulfilment';
import { notificationsService } from '../notifications/notifications.service';
import { feeService } from '../payments/fees';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import { BoostCampaignModel, BoostContributionModel } from './boost.model';
import { resolveMailingRate } from './mailingRate';

/**
 * ═══ BOOST MY MARKETING (ADR-006) ═══
 *
 * Three rules do most of the work here, and all three exist because the LIKELY outcome of a
 * crowdfunding campaign is that it misses its goal:
 *
 *  1. **Every campaign has a hard deadline.** Money is never held open-ended.
 *  2. **A missed goal refunds everybody automatically**, in full, without being asked. The platform
 *     absorbs the processor's refund cost — refunding a generous person 97% of their money is the
 *     single most damaging thing this product could do to its own premise.
 *  3. **Roll-forward is opt-in and itself time-boxed.** Otherwise "put it toward the next one"
 *     becomes an indefinite hold on money for a campaign that may never be created.
 *
 * `raised` is always summed from succeeded rows. There is a cached copy for list views, and it is
 * never the number a decision is made on.
 */

async function shapeCampaign(
  c: {
    _id: unknown;
    business_id: string;
    title: string;
    goal_cents: number;
    deadline_at: Date;
    status: string;
    funded_at?: Date | null;
    service_fee_cents?: number;
    mail_date?: Date | null;
    mailing_status?: string | null;
    raised_cents_cached?: number;
  },
  raisedCents: number,
) {
  const remaining = Math.max(0, c.goal_cents - raisedCents);
  /**
   * ADR-006 §6 requires the service fee to be "disclosed on the campaign page before anyone
   * gives", and the contribution sheet's fine print promises a fee "shown on the campaign page".
   * `service_fee_cents` only exists AFTER funding, so the RATE has to be exposed too — otherwise
   * that promise is unkeepable for every campaign that has not funded yet, which is all of the
   * ones where the disclosure actually matters.
   */
  const rule = await feeService.resolveFeeRule('campaign_service');
  return {
    serviceFeeBps: rule?.rate_bps ?? 0,
    id: String(c._id),
    businessId: c.business_id,
    title: c.title,
    goalCents: c.goal_cents,
    raisedCents,
    remainingCents: remaining,
    percentFunded:
      c.goal_cents > 0 ? Math.min(100, Math.floor((raisedCents / c.goal_cents) * 100)) : 0,
    deadlineAt: c.deadline_at,
    status: c.status,
    fundedAt: c.funded_at ?? null,
    serviceFeeCents: c.service_fee_cents ?? 0,
    mailDate: c.mail_date ?? null,
    mailingStatus: c.mailing_status ?? null,
  };
}

/** Anonymity applied once, at serialisation — the same discipline as Pay It Forward. */
function shapeContribution(doc: {
  _id: unknown;
  amount_cents: number;
  anonymous?: boolean;
  display_name?: string | null;
  created_at?: Date;
}) {
  return {
    id: String(doc._id),
    amountCents: doc.amount_cents,
    givenBy: doc.anonymous === false ? (doc.display_name ?? null) : null,
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

export const boostService = {
  /** Authoritative raised total: summed from succeeded rows, never read off a counter. */
  async raisedFor(campaignId: string): Promise<number> {
    const rows = await BoostContributionModel.aggregate<{ total: number }>([
      { $match: { campaign_id: campaignId, status: { $in: ['succeeded', 'rolled_forward'] } } },
      { $group: { _id: null, total: { $sum: '$amount_cents' } } },
    ]).exec();
    return rows[0]?.total ?? 0;
  },

  /**
   * MB-4 — how many postcards a sum actually buys.
   *
   * Still returns `null` rather than guessing when the rate cannot be established. MB-8 is resolved
   * and the rate now comes from the vendor (`mailingRate.ts`), but the honesty property is
   * unchanged: no rate, no number.
   *
   * **The service fee is subtracted before dividing.** ADR-006 §6 takes `campaign_service` out of
   * the raised total the moment a campaign funds, so dividing the gross by the unit cost would tell
   * a contributor their $100 buys ~11% more postcards than it will. The fee is disclosed, so the
   * estimate has to reflect it — an estimate that quietly ignores a fee it knows about is the same
   * credibility problem as a wrong "raised so far" (D-9).
   */
  async postcardEstimate(cents: number): Promise<{
    postcards: number | null;
    unitCostCents: number;
    serviceFeeCents: number;
    mailableCents: number;
  }> {
    const rate = await resolveMailingRate();
    const serviceFeeCents = await feeService.resolveFee('campaign_service', Math.max(0, cents));
    const mailableCents = Math.max(0, cents - serviceFeeCents);

    if (!rate) {
      return { postcards: null, unitCostCents: 0, serviceFeeCents, mailableCents };
    }
    return {
      postcards: Math.floor(mailableCents / rate.unitCostCents),
      unitCostCents: rate.unitCostCents,
      serviceFeeCents,
      mailableCents,
    };
  },

  // ─── Campaign lifecycle ───────────────────────────────────────────────────────────────────
  async create(
    principal: Principal,
    businessId: string,
    input: { title: string; goalCents: number; deadlineDays: number },
  ) {
    await ensureOwner(principal, businessId);

    if (input.goalCents < BOOST_MIN_GOAL_CENTS || input.goalCents > BOOST_MAX_GOAL_CENTS) {
      throw ValidationError(
        `A goal must be between ${formatCents(BOOST_MIN_GOAL_CENTS)} and ${formatCents(BOOST_MAX_GOAL_CENTS)}`,
      );
    }
    if (input.deadlineDays < 1 || input.deadlineDays > BOOST_MAX_DEADLINE_DAYS) {
      throw ValidationError(`A campaign can run for at most ${BOOST_MAX_DEADLINE_DAYS} days`);
    }

    // One at a time. Two open campaigns for one business split the same goodwill in half and leave a
    // contributor guessing which one their money helps.
    const existing = await BoostCampaignModel.findOne({
      business_id: businessId,
      status: 'open',
    }).lean();
    if (existing) {
      throw ConflictError(
        ERROR_CODES.BUSINESS_RULE,
        'This business already has a campaign running. Close it before starting another.',
      );
    }

    const campaign = await BoostCampaignModel.create({
      business_id: businessId,
      created_by: principal.userId,
      title: input.title,
      goal_cents: input.goalCents,
      deadline_at: new Date(Date.now() + input.deadlineDays * 86_400_000),
    });

    // ADR-006 §5 — money a previous campaign's contributors asked to roll forward has been waiting
    // for exactly this. Adopt it now, so it counts toward the new goal from day one.
    await this.adoptRolledForward(businessId, String(campaign._id));

    await writeAudit({
      actorId: principal.userId,
      action: 'boost.campaign_created',
      entityType: 'boost_campaign',
      entityId: String(campaign._id),
      metadata: { goalCents: input.goalCents, deadlineDays: input.deadlineDays },
    });

    return await shapeCampaign(campaign, await this.raisedFor(String(campaign._id)));
  },

  async get(campaignId: string) {
    const campaign = await BoostCampaignModel.findById(campaignId).lean();
    if (!campaign) throw NotFoundError('Campaign not found');
    return await shapeCampaign(campaign, await this.raisedFor(campaignId));
  },

  /** The business's current campaign, or null. Public — a campaign nobody can see raises nothing. */
  async currentFor(businessId: string) {
    const campaign = await BoostCampaignModel.findOne({ business_id: businessId, status: 'open' })
      .sort({ created_at: -1 })
      .lean();
    if (!campaign) return null;
    return await shapeCampaign(campaign, await this.raisedFor(String(campaign._id)));
  },

  async contributions(campaignId: string, limit = 20) {
    const rows = await BoostContributionModel.find({
      campaign_id: campaignId,
      status: { $in: ['succeeded', 'rolled_forward'] },
    })
      .sort({ created_at: -1 })
      .limit(Math.min(limit, 50))
      .lean();
    return rows.map(shapeContribution);
  },

  // ─── Contribution (money in) ──────────────────────────────────────────────────────────────
  /**
   * Captured on contribution into the campaign's custodial account. No platform fee is taken from a
   * contribution (ADR-006 §6) — the service fee comes out of a campaign that FUNDS.
   */
  async contribute(
    principal: Principal,
    campaignId: string,
    input: {
      amountCents: number;
      anonymous?: boolean;
      displayName?: string;
      onUnmet?: 'refund' | 'roll_forward';
    },
    idempotencyKey: string,
  ) {
    if (
      input.amountCents < BOOST_MIN_CONTRIBUTION_CENTS ||
      input.amountCents > BOOST_MAX_CONTRIBUTION_CENTS
    ) {
      throw ValidationError(
        `A contribution must be between ${formatCents(BOOST_MIN_CONTRIBUTION_CENTS)} and ${formatCents(BOOST_MAX_CONTRIBUTION_CENTS)}`,
      );
    }

    const campaign = await BoostCampaignModel.findById(campaignId);
    if (!campaign) throw NotFoundError('Campaign not found');
    if (campaign.status !== 'open') {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This campaign is no longer taking contributions',
      );
    }
    if (campaign.deadline_at.getTime() <= Date.now()) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This campaign has closed');
    }

    const charge = await paymentsService.chargeToPlatform({
      amountCents: input.amountCents,
      transferGroup: `boost_${campaignId}`,
      metadata: { kind: 'boost_contribution', campaignId, businessId: campaign.business_id },
      idempotencyKey: `boost_contrib_${idempotencyKey}`,
      ...(principal.email ? { receiptEmail: principal.email } : {}),
    });

    const contribution = await BoostContributionModel.create({
      campaign_id: campaignId,
      business_id: campaign.business_id,
      contributor_id: principal.userId,
      amount_cents: input.amountCents,
      stripe_payment_intent_id: charge.paymentIntentId,
      anonymous: input.anonymous !== false,
      display_name: input.anonymous === false ? (input.displayName ?? null) : null,
      on_unmet: input.onUnmet ?? 'refund',
    });

    return {
      contributionId: String(contribution._id),
      campaignId,
      amountCents: input.amountCents,
      // Unchanged until the charge settles. The goal must never appear closer than the money is.
      raisedCents: await this.raisedFor(campaignId),
      clientSecret: charge.clientSecret,
    };
  },

  /** The charge settled. Credit the campaign's escrow and check whether the goal is now met. */
  async creditContribution(paymentIntentId: string): Promise<{ handled: boolean }> {
    const contribution = await BoostContributionModel.findOne({
      stripe_payment_intent_id: paymentIntentId,
    }).exec();
    if (!contribution) return { handled: false };
    if (contribution.status !== 'pending') return { handled: true };

    const claimed = await BoostContributionModel.findOneAndUpdate(
      { _id: contribution._id, status: 'pending' },
      { $set: { status: 'succeeded', credited_at: new Date() } },
    ).exec();
    if (!claimed) return { handled: true };

    await communityFundLedger.contribute({
      fund: { businessId: contribution.business_id, campaignId: contribution.campaign_id },
      amountCents: contribution.amount_cents,
      contributionId: String(contribution._id),
      memo: `Boost contribution ${formatCents(contribution.amount_cents)}`,
    });

    const raised = await this.raisedFor(contribution.campaign_id);
    await BoostCampaignModel.updateOne(
      { _id: contribution.campaign_id },
      { $set: { raised_cents_cached: raised } },
    ).exec();

    await this.checkGoal(contribution.campaign_id, raised);
    return { handled: true };
  },

  async failContribution(paymentIntentId: string, reason: string): Promise<{ handled: boolean }> {
    const res = await BoostContributionModel.findOneAndUpdate(
      { stripe_payment_intent_id: paymentIntentId, status: 'pending' },
      { $set: { status: 'failed', failure_reason: reason } },
    ).exec();
    return { handled: Boolean(res) };
  },

  /**
   * MB-5 — the goal is met. A campaign moves to `funded` ONLY when captured contributions reach it,
   * which is the same solvency rule the ad placements and the consignment rail already follow:
   * never deliver against money that has not arrived.
   */
  async checkGoal(campaignId: string, raisedCents: number): Promise<void> {
    const funded = await BoostCampaignModel.findOneAndUpdate(
      { _id: campaignId, status: 'open', goal_cents: { $lte: raisedCents } },
      { $set: { status: 'funded', funded_at: new Date() } },
      { new: true },
    ).exec();
    if (!funded) return;

    // ADR-006 §6 — the service fee is taken from the RAISED TOTAL, once, now. Never from a
    // contribution, and disclosed on the campaign page before anyone gave.
    const serviceFee = await feeService.resolveFee('campaign_service', raisedCents);
    await BoostCampaignModel.updateOne(
      { _id: campaignId },
      { $set: { service_fee_cents: serviceFee } },
    ).exec();

    const owner = await vendorsService.getBusinessOwner(funded.business_id);
    if (owner) {
      notificationsService.notify(owner, {
        category: 'campaign',
        title: 'Your campaign reached its goal',
        body: `${formatCents(raisedCents)} raised. Confirm when you'd like the mailing to go out.`,
        data: { campaignId, audience: 'vendor' },
      });
    }

    // Everyone who chipped in hears that it worked.
    const backers = await BoostContributionModel.find({
      campaign_id: campaignId,
      status: 'succeeded',
    })
      .select('contributor_id')
      .lean();
    for (const b of new Set(backers.map((x) => x.contributor_id))) {
      notificationsService.notify(b, {
        category: 'campaign',
        title: 'A campaign you backed reached its goal',
        body: 'The mailing is going ahead. Thanks for chipping in.',
        data: { campaignId },
      });
    }

    await writeAudit({
      action: 'boost.campaign_funded',
      entityType: 'boost_campaign',
      entityId: campaignId,
      metadata: { raisedCents, serviceFeeCents: serviceFee },
    });
  },

  /**
   * ADR-006 §4 — the owner makes up a shortfall themselves. **Before the deadline only.** After it,
   * the money has already gone back to the contributors, and reopening would mean re-charging people
   * who have been refunded.
   */
  async topUp(principal: Principal, campaignId: string, idempotencyKey: string) {
    const campaign = await BoostCampaignModel.findById(campaignId);
    if (!campaign) throw NotFoundError('Campaign not found');
    await ensureOwner(principal, campaign.business_id);

    if (campaign.status !== 'open') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This campaign is no longer open');
    }
    if (campaign.deadline_at.getTime() <= Date.now()) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'The deadline has passed and contributors have been refunded',
      );
    }

    const raised = await this.raisedFor(campaignId);
    const shortfall = campaign.goal_cents - raised;
    if (shortfall <= 0) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This campaign has already reached its goal',
      );
    }

    // The owner's own money goes in as an ordinary contribution — same rail, same ledger, and it
    // shows on the campaign like any other. A separate "owner top-up" concept would be a second way
    // for money to enter, and a second thing to get right at refund time.
    return this.contribute(
      principal,
      campaignId,
      { amountCents: shortfall, anonymous: false, displayName: 'The business', onUnmet: 'refund' },
      idempotencyKey,
    );
  },

  // ─── Mailing pipeline (MB-6 / MB-9) ───────────────────────────────────────────────────────
  async confirmMailDate(principal: Principal, campaignId: string, mailDate: Date) {
    const campaign = await BoostCampaignModel.findById(campaignId);
    if (!campaign) throw NotFoundError('Campaign not found');
    await ensureOwner(principal, campaign.business_id);
    if (campaign.status !== 'funded') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Only a funded campaign can be scheduled');
    }
    if (mailDate.getTime() <= Date.now()) {
      throw ValidationError('Pick a mailing date in the future');
    }

    const updated = await BoostCampaignModel.findOneAndUpdate(
      { _id: campaignId, status: 'funded' },
      { $set: { mail_date: mailDate, mailing_status: 'preparing', mailing_status_at: new Date() } },
      { new: true },
    ).exec();
    return await shapeCampaign(updated!, await this.raisedFor(campaignId));
  },

  /**
   * Advance the print/mail pipeline. Ops-driven today because **no print vendor is contracted**
   * (MB-8): until one is, a person moves this as the job progresses. When a vendor is integrated its
   * webhook calls exactly this, and nothing else has to change.
   *
   * There is no `delivered` — see the model comment. The platform does not report what it cannot see.
   */
  async advanceMailing(campaignId: string, status: FulfilmentStage) {
    const campaign = await BoostCampaignModel.findById(campaignId);
    if (!campaign) throw NotFoundError('Campaign not found');
    if (campaign.status !== 'funded') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Only a funded campaign has a mailing');
    }

    /**
     * Phase 6 (TD-6): the ordering rule now comes from the shared pipeline rather than being absent.
     *
     * This used to be an unguarded `$set`, so an admin could move a campaign from `mailed` back to
     * `preparing` — telling everyone who funded it that their mailing had been un-sent. Extracting
     * the machine to `modules/fulfilment` is what surfaced it, which is the argument for extracting
     * rather than copying in one line.
     */
    assertAdvance(campaign.mailing_status as FulfilmentStage | null, status);

    const updated = await BoostCampaignModel.findOneAndUpdate(
      { _id: campaignId },
      { $set: { mailing_status: status, mailing_status_at: new Date() } },
      { new: true },
    ).exec();

    if (status === 'mailed') {
      const backers = await BoostContributionModel.find({
        campaign_id: campaignId,
        status: { $in: ['succeeded', 'rolled_forward'] },
      })
        .select('contributor_id')
        .lean();
      for (const b of new Set(backers.map((x) => x.contributor_id))) {
        notificationsService.notify(b, {
          category: 'campaign',
          title: 'The mailing you funded is out',
          body: 'The postcards you helped pay for have been sent.',
          data: { campaignId },
        });
      }
    }
    return await shapeCampaign(updated!, await this.raisedFor(campaignId));
  },

  // ─── Failure paths (MB-10) ────────────────────────────────────────────────────────────────
  /**
   * The owner calls it off. Everybody is refunded, whatever they chose for the unmet case — a
   * cancellation is not the campaign failing to reach its goal, it is the thing they funded no
   * longer existing, so there is nothing to roll forward into.
   */
  async cancel(principal: Principal, campaignId: string, reason?: string) {
    const campaign = await BoostCampaignModel.findById(campaignId);
    if (!campaign) throw NotFoundError('Campaign not found');
    await ensureOwner(principal, campaign.business_id);
    if (campaign.status !== 'open') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Only an open campaign can be cancelled');
    }

    await BoostCampaignModel.updateOne(
      { _id: campaignId },
      { $set: { status: 'cancelled', cancelled_reason: reason ?? null } },
    ).exec();
    const refunded = await this.refundAll(campaignId, 'campaign_cancelled', { force: true });

    await writeAudit({
      actorId: principal.userId,
      action: 'boost.campaign_cancelled',
      entityType: 'boost_campaign',
      entityId: campaignId,
      metadata: { refunded, reason: reason ?? null },
    });
    return { campaignId, refunded };
  },

  /**
   * Refund every live contribution on a campaign, in full.
   *
   * The platform absorbs the processor's refund cost rather than netting it off — a contributor is
   * never refunded less than they gave (ADR-006 §3). That cost is a platform expense on Stripe's own
   * rail, not a movement of the community's money, so it is not modelled in the community ledger.
   *
   * `force` skips the contributor's roll-forward preference: used on cancellation, where there is
   * nothing to roll into.
   */
  async refundAll(
    campaignId: string,
    reason: string,
    opts: { force?: boolean } = {},
  ): Promise<number> {
    const live = await BoostContributionModel.find({
      campaign_id: campaignId,
      status: 'succeeded',
    }).exec();

    let refunded = 0;
    for (const c of live) {
      if (!opts.force && c.on_unmet === 'roll_forward') continue;

      const claimed = await BoostContributionModel.findOneAndUpdate(
        { _id: c._id, status: 'succeeded' },
        { $set: { status: 'refunded', refunded_at: new Date() } },
      ).exec();
      if (!claimed) continue;

      try {
        const res = await stripe().createRefund({
          paymentIntentId: c.stripe_payment_intent_id,
          amountCents: c.amount_cents,
          idempotencyKey: `boost_refund_${String(c._id)}`,
        });
        await BoostContributionModel.updateOne(
          { _id: c._id },
          { $set: { stripe_refund_id: res.refundId } },
        ).exec();
      } catch (err) {
        // The row is already marked refunded, so the ledger and the money can disagree until this is
        // retried. Loud, because a contributor believing they were refunded when they were not is
        // the worst failure this feature has.
        logger.error(
          { campaignId, contributionId: String(c._id), err },
          'boost refund failed at the processor',
        );
      }

      await communityFundLedger.refund({
        fund: { businessId: c.business_id, campaignId },
        amountCents: c.amount_cents,
        refundId: String(c._id),
        memo: `Boost refund — ${reason}`,
      });

      notificationsService.notify(c.contributor_id, {
        category: 'campaign',
        title: 'Your contribution has been refunded',
        body: `${formatCents(c.amount_cents)} is on its way back to you in full.`,
        data: { campaignId },
      });
      refunded += 1;
    }
    return refunded;
  },

  /**
   * ADR-006 §2/§3 — the deadline sweep. Every open campaign past its deadline expires, and every
   * contributor is refunded automatically. Nobody has to ask.
   */
  async sweepDeadlines(): Promise<{ expired: number; refunded: number }> {
    const due = await BoostCampaignModel.find({
      status: 'open',
      deadline_at: { $lte: new Date() },
    })
      .limit(SWEEP_BATCH_LIMIT)
      .exec();

    let expired = 0;
    let refunded = 0;
    for (const campaign of due) {
      const id = String(campaign._id);
      const raised = await this.raisedFor(id);

      // A campaign that quietly hit its goal between the last webhook and now still funds.
      if (raised >= campaign.goal_cents) {
        await this.checkGoal(id, raised);
        continue;
      }

      const claimed = await BoostCampaignModel.findOneAndUpdate(
        { _id: id, status: 'open' },
        { $set: { status: 'expired' } },
      ).exec();
      if (!claimed) continue;
      expired += 1;

      refunded += await this.refundAll(id, 'goal_not_reached');

      // Whoever asked to roll forward now waits for a next campaign — but not forever.
      await BoostContributionModel.updateMany(
        { campaign_id: id, status: 'succeeded', on_unmet: 'roll_forward' },
        {
          $set: {
            rollover_expires_at: new Date(Date.now() + BOOST_ROLLOVER_GRACE_DAYS * 86_400_000),
          },
        },
      ).exec();

      const owner = await vendorsService.getBusinessOwner(campaign.business_id);
      if (owner) {
        notificationsService.notify(owner, {
          category: 'campaign',
          title: 'Your campaign didn’t reach its goal',
          body: 'Everyone who chipped in has been refunded in full, automatically.',
          data: { campaignId: id, audience: 'vendor' },
        });
      }
    }

    reportSweepBatch('boost-deadline', due.length);
    return { expired, refunded };
  },

  /**
   * Money whose contributor chose "put it toward the next campaign", claimed by a new campaign. The
   * ledger moves it from the old campaign's escrow to the new one's — both legs are
   * `community_fund_payable`, so the liability changes hands rather than being discharged.
   */
  async adoptRolledForward(businessId: string, newCampaignId: string): Promise<number> {
    const waiting = await BoostContributionModel.find({
      business_id: businessId,
      status: 'succeeded',
      on_unmet: 'roll_forward',
      rolled_to_campaign_id: null,
      rollover_expires_at: { $ne: null },
    }).exec();

    let moved = 0;
    for (const c of waiting) {
      const claimed = await BoostContributionModel.findOneAndUpdate(
        { _id: c._id, rolled_to_campaign_id: null },
        {
          $set: {
            status: 'rolled_forward',
            rolled_to_campaign_id: newCampaignId,
            campaign_id: newCampaignId,
            rollover_expires_at: null,
          },
        },
      ).exec();
      if (!claimed) continue;

      await communityFundLedger.transferBetweenFunds({
        from: { businessId, campaignId: c.campaign_id },
        to: { businessId, campaignId: newCampaignId },
        amountCents: c.amount_cents,
        transferId: `rollfwd_${String(c._id)}`,
        memo: 'Rolled forward to the next campaign, as the contributor chose',
      });

      notificationsService.notify(c.contributor_id, {
        category: 'campaign',
        title: 'Your contribution moved to a new campaign',
        body: `${formatCents(c.amount_cents)} is now backing this business's next mailing, as you chose.`,
        data: { campaignId: newCampaignId },
      });
      moved += 1;
    }
    return moved;
  },

  /**
   * Roll-forward money that waited and waited. Refunded, because "the next campaign" that never
   * arrives is exactly the indefinite hold the deadline exists to prevent.
   */
  async sweepRollovers(): Promise<number> {
    const stale = await BoostContributionModel.find({
      status: 'succeeded',
      on_unmet: 'roll_forward',
      rolled_to_campaign_id: null,
      rollover_expires_at: { $lte: new Date() },
    })
      .limit(SWEEP_BATCH_LIMIT)
      .exec();

    let refunded = 0;
    for (const c of stale) {
      const claimed = await BoostContributionModel.findOneAndUpdate(
        { _id: c._id, status: 'succeeded' },
        { $set: { status: 'refunded', refunded_at: new Date() } },
      ).exec();
      if (!claimed) continue;

      try {
        const res = await stripe().createRefund({
          paymentIntentId: c.stripe_payment_intent_id,
          amountCents: c.amount_cents,
          idempotencyKey: `boost_refund_${String(c._id)}`,
        });
        await BoostContributionModel.updateOne(
          { _id: c._id },
          { $set: { stripe_refund_id: res.refundId } },
        ).exec();
      } catch (err) {
        logger.error({ contributionId: String(c._id), err }, 'boost rollover refund failed');
      }

      await communityFundLedger.refund({
        fund: { businessId: c.business_id, campaignId: c.campaign_id },
        amountCents: c.amount_cents,
        refundId: String(c._id),
        memo: 'Rolled-forward contribution expired without a new campaign',
      });

      notificationsService.notify(c.contributor_id, {
        category: 'campaign',
        title: 'Your contribution has been refunded',
        body: `No new campaign was started, so ${formatCents(c.amount_cents)} is on its way back to you.`,
        data: { campaignId: c.campaign_id },
      });
      refunded += 1;
    }

    reportSweepBatch('boost-rollover', stale.length);
    return refunded;
  },
};
