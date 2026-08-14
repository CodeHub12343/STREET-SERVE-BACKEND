import { createHash } from 'node:crypto';

import {
  NEW_ACCOUNT_WINDOW_DAYS,
  PING_DAILY_CAP,
  PING_QUALIFY_WINDOW_HOURS,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { bizMetrics } from '../../observability/bizMetrics';
import { raiseFraudFlag } from '../../shared/fraud';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { env } from '../../config/env';
import { stripe } from '../../integrations/stripe';
import { formatCents } from '../../shared/money';
import { identityService } from '../identity/identity.service';
import { ledgerService } from '../ledger/ledger.service';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import { PingBudgetModel, PingBudgetTopupModel, PingModel } from './growth.model';

function hashContact(contact: string): string {
  return createHash('sha256').update(contact.trim().toLowerCase()).digest('hex');
}
function startOfUtcDay(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export const pingService = {
  /**
   * Vendor tops up the paid-sharing balance. This is a REAL prepayment: it opens a card charge and
   * returns the client secret to confirm. The balance is credited only by `creditTopup` when the
   * payment succeeds — crediting on request would hand out tips funded by nothing (the platform
   * would be paying sharers from its own capital, the same solvency hole settlements once had).
   *
   * The per-share tip is applied immediately: it's configuration, not money.
   */
  async fundBudget(
    principal: Principal,
    businessId: string,
    input: { reloadCents: number; perShareTipCents: number },
  ) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId)
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);

    const budget = await PingBudgetModel.findOneAndUpdate(
      { business_id: businessId },
      {
        $set: { per_share_tip_cents: input.perShareTipCents, status: 'active' },
        $setOnInsert: { business_id: businessId },
      },
      { upsert: true, new: true },
    ).exec();

    if (input.reloadCents <= 0) {
      return {
        businessId,
        balanceCents: budget.balance_cents,
        perShareTipCents: budget.per_share_tip_cents,
        status: budget.status,
        clientSecret: null,
        topupId: null,
      };
    }

    const charge = await stripe().createPlatformCharge({
      amountCents: input.reloadCents,
      currency: env.PLATFORM_CURRENCY,
      transferGroup: `ping_budget_${businessId}`,
      metadata: { kind: 'ping_budget_topup', businessId },
      idempotencyKey: `ping_topup_${businessId}_${Date.now()}`,
      ...(principal.email ? { receiptEmail: principal.email } : {}),
    });
    const topup = await PingBudgetTopupModel.create({
      business_id: businessId,
      amount_cents: input.reloadCents,
      per_share_tip_cents: input.perShareTipCents,
      stripe_payment_intent_id: charge.paymentIntentId,
    });

    return {
      businessId,
      balanceCents: budget.balance_cents, // unchanged until the charge settles
      perShareTipCents: budget.per_share_tip_cents,
      status: budget.status,
      clientSecret: charge.clientSecret,
      topupId: String(topup._id),
    };
  },

  /**
   * The top-up charge settled — now the money genuinely exists, so credit the budget and record it.
   * Idempotent: a redelivered webhook finds the row already `succeeded` and does nothing.
   */
  async creditTopup(paymentIntentId: string): Promise<{ handled: boolean }> {
    const topup = await PingBudgetTopupModel.findOne({
      stripe_payment_intent_id: paymentIntentId,
    }).exec();
    if (!topup) return { handled: false }; // not a ping top-up — let other handlers try
    if (topup.status === 'succeeded') return { handled: true };

    const claimed = await PingBudgetTopupModel.findOneAndUpdate(
      { _id: topup._id, status: 'pending' },
      { $set: { status: 'succeeded', credited_at: new Date() } },
    ).exec();
    if (!claimed) return { handled: true }; // lost the race to a duplicate webhook

    await PingBudgetModel.updateOne(
      { business_id: topup.business_id },
      { $inc: { balance_cents: topup.amount_cents }, $set: { status: 'active' } },
      { upsert: true },
    ).exec();

    // Money in, held against the tips this budget will fund.
    await ledgerService.post({
      transactionId: `ping_topup_${String(topup._id)}`,
      refType: 'ping_budget',
      refId: String(topup._id),
      memo: `Ping budget top-up ${formatCents(topup.amount_cents)}`,
      entries: [
        { ownerType: 'platform', accountType: 'cash', direction: 'debit', amountCents: topup.amount_cents, entryType: 'sale_capture' },
        { ownerType: 'business', ownerId: topup.business_id, accountType: 'payable', direction: 'credit', amountCents: topup.amount_cents, entryType: 'adjustment' },
      ],
    });

    await writeAudit({
      actorId: topup.business_id,
      action: 'ping_budget.funded',
      entityType: 'ping_budget',
      entityId: topup.business_id,
      metadata: { amountCents: topup.amount_cents, paymentIntentId },
    });
    return { handled: true };
  },

  /**
   * The vendor's current budget — balance, per-share tip, status, plus share/conversion counts.
   * The dashboard previously rendered demo figures because there was no read endpoint at all.
   */
  async getBudget(principal: Principal, businessId: string) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId)
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);

    const budget = await PingBudgetModel.findOne({ business_id: businessId }).lean().exec();
    const [shares, conversions, funded] = await Promise.all([
      PingModel.countDocuments({ business_id: businessId }).exec(),
      PingModel.countDocuments({ business_id: businessId, tip_paid_at: { $ne: null } }).exec(),
      PingBudgetTopupModel.aggregate<{ _id: null; total: number }>([
        { $match: { business_id: businessId, status: 'succeeded' } },
        { $group: { _id: null, total: { $sum: '$amount_cents' } } },
      ]).exec(),
    ]);
    const fundedCents = funded[0]?.total ?? 0;
    const balanceCents = budget?.balance_cents ?? 0;
    return {
      businessId,
      balanceCents,
      /** Lifetime funded and spent — the progress bar needs both, not just what's left. */
      fundedCents,
      spentCents: Math.max(0, fundedCents - balanceCents),
      perShareTipCents: budget?.per_share_tip_cents ?? 0,
      status: budget?.status ?? 'active',
      shares,
      conversions,
    };
  },

  async setBudgetStatus(principal: Principal, businessId: string, status: 'active' | 'paused') {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (owner !== principal.userId)
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    const budget = await PingBudgetModel.findOneAndUpdate(
      { business_id: businessId },
      { $set: { status } },
      { new: true },
    ).exec();
    if (!budget) throw NotFoundError('No ping budget');
    return { businessId, status: budget.status, balanceCents: budget.balance_cents };
  },

  /**
   * Log a share. Determines paid vs free eligibility at creation time against every fraud gate:
   * budget solvency, per-sender daily cap, one-paid-per-recipient-per-vendor, and device dedupe.
   * A share always works; only its TIP eligibility is gated (FR-5.4).
   */
  async share(
    principal: Principal,
    input: { businessId: string; recipientContact: string; deviceFingerprint?: string },
  ) {
    const recipientHash = hashContact(input.recipientContact);
    const budget = await PingBudgetModel.findOne({ business_id: input.businessId }).exec();

    let paid = true;
    let reason = 'paid';

    if (
      !budget ||
      budget.status !== 'active' ||
      budget.per_share_tip_cents <= 0 ||
      budget.balance_cents < budget.per_share_tip_cents
    ) {
      paid = false;
      reason = 'budget_unavailable';
    }

    if (paid) {
      const paidToday = await PingModel.countDocuments({
        sender_user_id: principal.userId,
        is_paid: true,
        created_at: { $gte: startOfUtcDay() },
      }).exec();
      if (paidToday >= PING_DAILY_CAP) {
        paid = false;
        reason = 'daily_cap';
      }
    }

    if (paid) {
      const already = await PingModel.exists({
        business_id: input.businessId,
        recipient_contact_hash: recipientHash,
        is_paid: true,
      });
      if (already) {
        paid = false;
        reason = 'recipient_already_shared';
      }
    }

    if (paid && input.deviceFingerprint) {
      const deviceUsed = await PingModel.exists({
        business_id: input.businessId,
        device_fingerprint: input.deviceFingerprint,
        is_paid: true,
      });
      if (deviceUsed) {
        paid = false;
        reason = 'device_reuse';
        await raiseFraudFlag({
          type: 'ping',
          subjectId: principal.userId,
          signals: {
            businessId: input.businessId,
            deviceFingerprint: input.deviceFingerprint,
            reason: 'device_reuse',
          },
        });
      }
    }

    const ping = await PingModel.create({
      sender_user_id: principal.userId,
      recipient_contact_hash: recipientHash,
      business_id: input.businessId,
      is_paid: paid,
      tip_amount_cents: paid ? (budget?.per_share_tip_cents ?? 0) : 0,
      device_fingerprint: input.deviceFingerprint ?? null,
    });
    await publish('ping.logged', {
      pingId: String(ping._id),
      businessId: input.businessId,
      isPaid: paid,
    });
    return { pingId: String(ping._id), isPaid: paid, label: paid ? 'paid' : 'free', reason };
  },

  /**
   * The recipient completes a qualifying action. A tip is paid ONLY if the recipient is new (or
   * dormant), acts within the window, is not the sender, is not on the sender's device, and has
   * not already earned a tip for this vendor. Everything else is flagged, not paid (the exit goal).
   */
  async qualify(principal: Principal, pingId: string, input: { deviceFingerprint?: string }) {
    const ping = await PingModel.findById(pingId).exec();
    if (!ping) throw NotFoundError('Ping not found');
    if (!ping.is_paid || ping.tip_paid_at) {
      return { qualified: false, reason: 'not_tip_eligible' };
    }

    const withinWindow =
      Date.now() - (ping.created_at as Date).getTime() <=
      PING_QUALIFY_WINDOW_HOURS * 60 * 60 * 1000;
    if (!withinWindow) return { qualified: false, reason: 'window_expired' };

    // Self-referral.
    if (principal.userId === ping.sender_user_id) {
      await raiseFraudFlag({
        type: 'ping',
        subjectId: principal.userId,
        signals: { pingId, reason: 'self_referral' },
      });
      return { qualified: false, reason: 'self_referral' };
    }
    // Same device as the sender's ping.
    if (
      input.deviceFingerprint &&
      ping.device_fingerprint &&
      input.deviceFingerprint === ping.device_fingerprint
    ) {
      await raiseFraudFlag({
        type: 'ping',
        subjectId: principal.userId,
        signals: { pingId, reason: 'device_match' },
      });
      return { qualified: false, reason: 'device_match' };
    }
    // Recipient must be a new (or dormant) account.
    const ageDays = await identityService.getAccountAgeDays(principal.userId);
    if (ageDays > NEW_ACCOUNT_WINDOW_DAYS) {
      return { qualified: false, reason: 'recipient_already_active' };
    }

    // Pay the tip: atomically debit the budget (solvency guard).
    const tip = ping.tip_amount_cents;
    const debited = await PingBudgetModel.findOneAndUpdate(
      { business_id: ping.business_id, status: 'active', balance_cents: { $gte: tip } },
      { $inc: { balance_cents: -tip } },
      { new: true },
    ).exec();
    if (!debited) return { qualified: false, reason: 'budget_depleted' };

    try {
      // Stamp qualification — the unique (business, qualifying_user_id) index enforces one tip per
      // recipient per vendor, ever.
      await PingModel.updateOne(
        { _id: pingId, tip_paid_at: null },
        {
          $set: {
            qualifying_action_completed_at: new Date(),
            qualifying_user_id: principal.userId,
            tip_paid_at: new Date(),
          },
        },
      ).exec();
    } catch (err) {
      // Duplicate qualifying user for this vendor → refund the budget debit, no tip.
      await PingBudgetModel.updateOne(
        { business_id: ping.business_id },
        { $inc: { balance_cents: tip } },
      ).exec();
      if ((err as { code?: number }).code === 11000) {
        return { qualified: false, reason: 'already_qualified' };
      }
      throw err;
    }

    /**
     * Move the money (BACKGROUND_JOBS.md `pay-ping-tip`). The budget debit above is only a counter;
     * without this the vendor's prepayment was consumed and the sharer received nothing.
     *
     * The tip moves out of the business's prepaid budget into the sharer's payable, then out to
     * their connected account. No account yet → it STAYS a payable, so the money is owed and
     * visible rather than lost, and can be disbursed once they onboard.
     */
    await ledgerService.post({
      transactionId: `ping_tip_${pingId}`,
      refType: 'ping',
      refId: pingId,
      memo: `Ping tip ${formatCents(tip)}`,
      entries: [
        { ownerType: 'business', ownerId: ping.business_id, accountType: 'payable', direction: 'debit', amountCents: tip, entryType: 'adjustment' },
        { ownerType: 'user', ownerId: ping.sender_user_id, accountType: 'payable', direction: 'credit', amountCents: tip, entryType: 'adjustment' },
      ],
    });

    const transfer = await paymentsService.payoutTransfer({
      ownerType: 'user',
      ownerId: ping.sender_user_id,
      amountCents: tip,
      transferGroup: `ping_${pingId}`,
      idempotencyKey: `ping_tip_${pingId}`,
    });
    if (transfer) {
      await ledgerService.post({
        transactionId: `ping_tip_payout_${pingId}`,
        refType: 'ping',
        refId: pingId,
        memo: 'Ping tip payout',
        entries: [
          { ownerType: 'user', ownerId: ping.sender_user_id, accountType: 'payable', direction: 'debit', amountCents: tip, entryType: 'payout' },
          { ownerType: 'platform', accountType: 'cash', direction: 'credit', amountCents: tip, entryType: 'payout' },
        ],
      });
    }
    notificationsService.notify(ping.sender_user_id, {
      category: 'payments',
      title: 'You earned a share tip',
      body: transfer
        ? `${formatCents(tip)} is on its way to your account — thanks for the share.`
        : `${formatCents(tip)} is yours. Connect payouts to receive it.`,
      data: { audience: 'seller', pingId, tipCents: tip, paidOut: Boolean(transfer) },
    });

    await writeAudit({
      actorId: ping.sender_user_id,
      action: 'ping.tip_paid',
      entityType: 'ping',
      entityId: pingId,
      metadata: { tipCents: tip, qualifyingUser: principal.userId, businessId: ping.business_id, transferred: Boolean(transfer) },
    });
    bizMetrics.pingTipsPaid.inc();
    await publish('ping.qualified', { pingId, businessId: ping.business_id, tipCents: tip });
    return { qualified: true, tipCents: tip, forwarderId: ping.sender_user_id };
  },

  async listMine(senderId: string, limit: number) {
    const pings = await PingModel.find({ sender_user_id: senderId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
    return pings.map((p) => ({
      id: String(p._id),
      businessId: p.business_id,
      isPaid: p.is_paid,
      tipAmountCents: p.tip_amount_cents,
      tipPaidAt: p.tip_paid_at,
    }));
  },
};
