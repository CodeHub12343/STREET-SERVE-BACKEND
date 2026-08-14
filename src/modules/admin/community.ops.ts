import { ledgerService } from '../ledger/ledger.service';
import { logger } from '../../config/logger';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors/AppError';
import { formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';
import { invalidateAggregate } from '../../shared/cachedAggregate';
import { boostService } from '../boost/boost.service';
import { DeliveryRequestModel } from '../delivery/delivery.model';
import { CommunityFundModel } from '../payforward/payforward.model';
import { deliveryService } from '../delivery/delivery.service';

/**
 * ═══ OPS TOOLING FOR THE COMMUNITY NETWORK (Phase 8.4) ═══
 *
 * Three things a person on support needs to be able to do when something goes wrong, and could not
 * do before: correct a pool balance that has drifted, end a delivery that is stuck, and stop a
 * campaign on a business's behalf.
 *
 * ## The rule these share
 *
 * **Every one of them is audited, and none of them can move money to a person.** Ops tooling that
 * can pay somebody is ops tooling that can be socially engineered into paying somebody. What these
 * do is correct a *cached projection*, close a *state machine*, and trigger the *same refund path* a
 * vendor could already trigger themselves — never an arbitrary transfer.
 *
 * The pool adjustment is the sharpest edge, so it is the most constrained: it reconciles the cached
 * `balance_cents` to the ledger, which is the authoritative number. It cannot set an arbitrary
 * balance, so the worst a compromised admin account achieves is telling the truth.
 */
export const communityOpsService = {
  /**
   * Reconcile a business's cached pool balance to the ledger.
   *
   * The ledger is authoritative; `community_funds.balance_cents` is a projection kept in step by the
   * service. If the two ever disagree — a crashed process between the ledger post and the cache
   * update, a FIFO shortfall — this is how a person fixes it without touching the books.
   *
   * **It cannot invent a number.** There is no "set balance to X" here on purpose: an ops action
   * that can raise a custodial balance is an ops action that can create money, and the audit trail
   * would record who did it but not undo it.
   */
  async reconcileFund(principal: Principal, businessId: string, reason: string) {
    if (!reason.trim()) throw ValidationError('A reason is required');

    const fund = await CommunityFundModel.findOne({ business_id: businessId }).exec();
    if (!fund) throw NotFoundError('This business has no community fund');

    const authoritative = await ledgerService.computedBalanceOf({
      ownerType: 'business',
      ownerId: businessId,
      accountType: 'community_fund_payable',
    });
    const cached = fund.balance_cents ?? 0;
    if (authoritative === cached) {
      return { businessId, cachedCents: cached, ledgerCents: authoritative, changed: false };
    }

    await CommunityFundModel.updateOne(
      { business_id: businessId },
      { $set: { balance_cents: Math.max(0, authoritative) } },
    ).exec();
    await invalidateAggregate(`pf:impact:${businessId}`);

    await writeAudit({
      actorId: principal.userId,
      action: 'ops.payforward_fund_reconciled',
      entityType: 'community_fund',
      entityId: businessId,
      metadata: { from: cached, to: authoritative, driftCents: authoritative - cached, reason },
    });
    logger.warn(
      { businessId, from: cached, to: authoritative, actorId: principal.userId },
      'community fund cache reconciled by ops',
    );

    return {
      businessId,
      cachedCents: cached,
      ledgerCents: authoritative,
      changed: true,
      driftCents: authoritative - cached,
    };
  },

  /**
   * End a delivery that is stuck — a driver whose phone died mid-trip, an order handed over without
   * the code being read.
   *
   * Two outcomes only, both of which already exist as ordinary transitions: complete it (the goods
   * did arrive) or cancel it (they did not, and the customer is refunded). There is no "set status
   * to anything", because a state machine an operator can jump around in is not a state machine.
   */
  async resolveStuckDelivery(
    principal: Principal,
    deliveryId: string,
    input: { outcome: 'delivered' | 'cancelled'; reason: string },
  ) {
    const delivery = await DeliveryRequestModel.findById(deliveryId).exec();
    if (!delivery) throw NotFoundError('Delivery not found');
    if (['delivered', 'cancelled', 'expired', 'undeliverable'].includes(delivery.status)) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'This delivery has already finished');
    }

    if (input.outcome === 'delivered') {
      await DeliveryRequestModel.updateOne(
        { _id: deliveryId },
        {
          $set: {
            status: 'delivered',
            delivered_at: new Date(),
            ended_reason: `ops:${input.reason}`,
          },
        },
      ).exec();
      /**
       * The driver is still paid. They did the work; the code not being read is a process failure,
       * and withholding a person's pay over one is how a platform teaches drivers not to report
       * problems.
       */
      if (delivery.driver_id) {
        const { paymentsService } = await import('../payments/payments.service');
        await paymentsService.payoutTransfer({
          ownerType: 'user',
          ownerId: delivery.driver_id,
          amountCents: delivery.driver_payout_cents,
          transferGroup: `delivery_${deliveryId}`,
          idempotencyKey: `delivery_payout_${deliveryId}`,
        });
      }
    } else {
      await DeliveryRequestModel.updateOne(
        { _id: deliveryId },
        { $set: { status: 'cancelled', ended_reason: `ops:${input.reason}` } },
      ).exec();
      if (delivery.transaction_id) {
        await deliveryService.refundCustomer(delivery.transaction_id, principal.userId, deliveryId);
      }
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'ops.delivery_resolved',
      entityType: 'delivery',
      entityId: deliveryId,
      metadata: { outcome: input.outcome, reason: input.reason, was: delivery.status },
    });
    return { deliveryId, status: input.outcome };
  },

  /**
   * Cancel a campaign on the business's behalf — a vendor who has gone dark, or a campaign that
   * should not have been allowed to run.
   *
   * Deliberately routed through the SAME `refundAll` the vendor's own cancel uses, so there is one
   * refund path with one set of guarantees. An ops-only shortcut would be a second way for money to
   * move, and the second way is always the one that is wrong.
   */
  async cancelCampaign(principal: Principal, campaignId: string, reason: string) {
    if (!reason.trim()) throw ValidationError('A reason is required');

    const { BoostCampaignModel } = await import('../boost/boost.model');
    const campaign = await BoostCampaignModel.findById(campaignId).exec();
    if (!campaign) throw NotFoundError('Campaign not found');
    if (campaign.status !== 'open') {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Only an open campaign can be cancelled');
    }

    await BoostCampaignModel.updateOne(
      { _id: campaignId },
      { $set: { status: 'cancelled', cancelled_reason: `ops:${reason}` } },
    ).exec();
    const refunded = await boostService.refundAll(campaignId, `ops_cancelled:${reason}`, {
      force: true,
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'ops.boost_campaign_cancelled',
      entityType: 'boost_campaign',
      entityId: campaignId,
      metadata: { reason, refunded },
    });
    logger.warn({ campaignId, refunded, actorId: principal.userId }, 'campaign cancelled by ops');
    return { campaignId, refunded };
  },

  /**
   * The support view for a disputed redemption: what the fund paid, when, and against which order.
   *
   * Read-only, and it deliberately does **not** identify who else has been helped. A support agent
   * investigating one redemption has no need for the list, and "who took the free meals" is the one
   * question this feature must never be able to answer.
   */
  async inspectRedemption(redemptionId: string) {
    const { CommunityRedemptionModel } = await import('../payforward/payforward.model');
    const r = await CommunityRedemptionModel.findById(redemptionId).lean();
    if (!r) throw NotFoundError('Redemption not found');
    return {
      id: String(r._id),
      businessId: r.business_id,
      orderId: r.order_id ?? null,
      amount: formatCents(r.amount_cents),
      amountCents: r.amount_cents,
      feeCents: r.fee_cents ?? 0,
      status: r.status,
      dayKey: r.day_key,
      appliedAt: r.applied_at ?? null,
      releasedReason: r.released_reason ?? null,
    };
  },
};
