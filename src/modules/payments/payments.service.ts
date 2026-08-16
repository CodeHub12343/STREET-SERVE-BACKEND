import { randomUUID } from 'node:crypto';

import { PAYOUT_DELAY_DAYS_BY_TIER, TIER_RANK, type FeeType, type Tier } from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { stripe } from '../../integrations/stripe';
import { writeAudit } from '../../shared/audit';
import { bizMetrics } from '../../observability/bizMetrics';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors/AppError';
// Repositories only — the identity/vendor SERVICES import this module, so service-level imports
// here would close a require cycle.
import { identityRepository as identityRepo } from '../identity/identity.repository';
import { BusinessModel } from '../vendors/vendors.model';
import { feeService } from './fees';
import { computeRefund } from './refundPolicy';
import { paymentsRepository as repo } from './payments.repository';

type OwnerType = 'user' | 'business';

/**
 * B-3: the payout-enabled Connect account for a shelter partner, or null if it can't receive money
 * yet. Model-level import (not the shelter SERVICE) to keep this side of the dependency acyclic.
 */
async function shelterPartnerAccount(
  partnerId: string,
): Promise<{ stripeAccountId: string } | null> {
  const { ShelterPartnerModel } = await import('../shelter/shelter.model');
  const partner = await ShelterPartnerModel.findById(partnerId).lean().exec();
  if (!partner) return null;
  const account = await repo.findAccountByOwner('user', partner.owner_user_id);
  if (!account || !account.payouts_enabled || account.payouts_frozen) return null;
  return { stripeAccountId: account.stripe_account_id };
}

export const paymentsService = {
  /** Idempotently ensure a Stripe Connect account exists for a payout owner. */
  async ensureConnectedAccount(ownerType: OwnerType, ownerId: string, email?: string) {
    const existing = await repo.findAccountByOwner(ownerType, ownerId);
    if (existing) return existing;
    const { accountId } = await stripe().createConnectedAccount({
      email,
      country: env.STRIPE_CONNECT_COUNTRY,
      metadata: { ownerType, ownerId },
    });
    return repo.createAccount({
      owner_type: ownerType,
      owner_id: ownerId,
      stripe_account_id: accountId,
    });
  },

  async createOnboardingLink(ownerType: OwnerType, ownerId: string, email?: string) {
    const account = await this.ensureConnectedAccount(ownerType, ownerId, email);
    const { url } = await stripe().createOnboardingLink({
      accountId: account.stripe_account_id,
      refreshUrl: env.CONNECT_REFRESH_URL,
      returnUrl: env.CONNECT_RETURN_URL,
    });
    return { url, stripeAccountId: account.stripe_account_id };
  },

  /** Pull the latest account status from Stripe (called on account.updated webhook). */
  async refreshAccountStatus(stripeAccountId: string) {
    const status = await stripe().getAccount(stripeAccountId);
    const updated = await repo.updateAccountStatus(stripeAccountId, {
      charges_enabled: status.chargesEnabled,
      payouts_enabled: status.payoutsEnabled,
      details_submitted: status.detailsSubmitted,
    });
    if (updated) {
      /**
       * Apply the tier payout hold NOW that the account exists. `syncPayoutHold` runs at
       * verification time, but people verify BEFORE they onboard Stripe — so it found no account
       * and silently no-opped, and nothing ever revisited it. The result was that every account
       * stayed on Stripe's default schedule and the tiered hold never actually applied to anyone.
       * Onboarding completion is the first moment the schedule can be set, so set it here.
       */
      if (status.payoutsEnabled) {
        try {
          await this.applyTierSchedule(updated.owner_type, updated.owner_id);
        } catch (err) {
          // Never fail the webhook over payout timing — the retry/sweep paths still work.
          logger.error({ err, stripeAccountId }, 'could not apply tier payout schedule');
        }
      }
      await publish('connected_account.updated', {
        ownerType: updated.owner_type,
        ownerId: updated.owner_id,
        payoutsEnabled: status.payoutsEnabled,
      });
    }
    return updated;
  },

  /**
   * Resolve an owner's effective verification tier and push the matching payout delay to Stripe.
   * A business inherits its owner's tier — the payout risk follows the human behind it.
   */
  async applyTierSchedule(ownerType: 'user' | 'business', ownerId: string) {
    let userId = ownerId;
    if (ownerType === 'business') {
      const business = await BusinessModel.findById(ownerId, { owner_user_id: 1 }).lean().exec();
      if (!business?.owner_user_id) return null;
      userId = String(business.owner_user_id);
    }
    const approved = await identityRepo.approvedVerifications(userId);
    const tier = approved.reduce<Tier>(
      (best, rec) => (TIER_RANK[rec.tier] > TIER_RANK[best] ? (rec.tier) : best),
      'tier0',
    );
    const account = await repo.findAccountByOwner(ownerType, ownerId);
    if (!account) return null;
    /**
     * Push unconditionally rather than via `syncPayoutHold`. That helper skips when the stored
     * `payout_tier` already equals the target — but the column DEFAULTS to 'tier0' and the schedule
     * was never sent to Stripe, so a tier0 account looked "already correct" while actually sitting
     * on Stripe's default. That silently voided the longest hold, on exactly the least-verified
     * accounts. Onboarding is a reconciliation point: state what the schedule must be.
     */
    await this.setPayoutTier(account.stripe_account_id, tier);
    return account;
  },

  /**
   * Enforce the tiered payout HOLD for an owner (Phase 3). The UI has long claimed "Bronze —
   * payout held 3 days" while nothing applied it: `setPayoutTier` existed but was reachable from
   * only one narrow verification path, so most accounts paid out on Stripe's default schedule.
   *
   * The hold is a genuine risk control — it funds the refund/chargeback window — so it is applied
   * whenever an account is connected or a tier changes. Safe to call repeatedly.
   */
  /** Freeze/unfreeze payouts for a party while a chargeback or dispute is live (Phase 4). */
  async setPayoutFreeze(
    ownerType: 'user' | 'business',
    ownerId: string,
    frozen: boolean,
    reason: string | null,
  ) {
    const account = await repo.findAccountByOwner(ownerType, ownerId);
    if (!account) return null;
    await repo.updateAccountStatus(account.stripe_account_id, {
      payouts_frozen: frozen,
      frozen_reason: frozen ? reason : null,
    });
    logger.warn({ ownerType, ownerId, frozen, reason }, 'payout freeze changed');
    return account;
  },

  async syncPayoutHold(ownerType: 'user' | 'business', ownerId: string, tier: Tier) {
    const account = await repo.findAccountByOwner(ownerType, ownerId);
    if (!account) return null;
    if (account.payout_tier === tier) return account; // already correct
    await this.setPayoutTier(account.stripe_account_id, tier);
    return account;
  },

  /** Apply tiered payout timing (FR-11.2) by adjusting the Stripe payout schedule. */
  async setPayoutTier(stripeAccountId: string, tier: Tier) {
    await stripe().setPayoutSchedule({
      accountId: stripeAccountId,
      delayDays: PAYOUT_DELAY_DAYS_BY_TIER[tier],
    });
    await repo.updateAccountStatus(stripeAccountId, { payout_tier: tier });
  },

  /**
   * Charge a customer and split the money in one destination charge: the platform application fee
   * is retained and the net is routed to the counterparty's connected account. Tips and round-up
   * are 100% to the counterparty (no platform cut — FR-6.4).
   */
  async charge(input: {
    customerId: string;
    counterpartyType: 'business' | 'seller';
    counterpartyId: string;
    amountCents: number;
    discountAppliedCents?: number;
    tipCents?: number;
    roundUpCents?: number;
    /**
     * Customer-paid fee components already folded into `amountCents` (R8/R10). Passed through so
     * the transaction records which parts of the total are refundable on their own terms — see
     * refundPolicy.ts. Omit for charges that carry no customer-facing fees.
     */
    serviceFeeCents?: number;
    processingFeeCents?: number;
    /** Which registry fee-type applies. Defaults to `marketplace` (regular + wave sales, R7). */
    feeType?: FeeType;
    idempotencyKey: string;

    /**
     * ═══ Stored credentials, for charges that recur. ═══
     *
     * Set `savePaymentMethod` on the FIRST, on-session charge of an agreement to keep the card;
     * pass `paymentMethodId` + `offSession` on every scheduled one after it. Without this pair a
     * scheduled charge opens an intent that waits for a human who is not there — which is why a
     * Rent-to-Own instalment could never actually collect.
     *
     * `customerEmail` is only used when the Stripe Customer is created, so a saved card has a
     * receipt address attached to it rather than being an anonymous token.
     */
    savePaymentMethod?: boolean;
    paymentMethodId?: string;
    offSession?: boolean;
    customerEmail?: string;
  }) {
    const existing = await repo.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return {
        transactionId: String(existing._id),
        paymentIntentRef: existing.payment_intent_ref,
        status: existing.status,
        replay: true,
      };
    }

    const accountOwnerType: OwnerType = input.counterpartyType === 'business' ? 'business' : 'user';
    const account = await repo.findAccountByOwner(accountOwnerType, input.counterpartyId);
    if (!account) throw NotFoundError('Counterparty has no payout account');
    if (!account.charges_enabled) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'Counterparty is not yet able to accept charges (onboarding incomplete)',
      );
    }

    const tip = input.tipCents ?? 0;
    const roundUp = input.roundUpCents ?? 0;
    const serviceFee = input.serviceFeeCents ?? 0;
    const processingFee = input.processingFeeCents ?? 0;
    // Fee applies to the goods portion only. Tips + round-up pass through in full, and the
    // service/processing fees are themselves platform and processor charges — levying the
    // marketplace fee on top of them would be charging a fee on a fee.
    const feeBase = Math.max(0, input.amountCents - tip - roundUp - serviceFee - processingFee);
    const feeType: FeeType = input.feeType ?? 'marketplace';
    let platformFee = await feeService.resolveFee(feeType, feeBase);
    // Pro membership (R29): a subscribed business gets a marketplace-fee discount on every sale.
    if (feeType === 'marketplace' && input.counterpartyType === 'business') {
      const { subscriptionsService } = await import('../subscriptions/subscriptions.service');
      const discountBps = await subscriptionsService.marketplaceDiscountBps(input.counterpartyId);
      if (discountBps > 0) {
        platformFee = Math.max(0, platformFee - Math.floor((feeBase * discountBps) / 10000));
      }
    }
    const counterpartyNet = input.amountCents - platformFee;

    const txn = await repo.createTransaction({
      customer_id: input.customerId,
      counterparty_type: input.counterpartyType,
      counterparty_id: input.counterpartyId,
      connected_account_id: account.stripe_account_id,
      amount_cents: input.amountCents,
      discount_applied_cents: input.discountAppliedCents ?? 0,
      tip_cents: tip,
      round_up_cents: roundUp,
      fee_type: feeType,
      platform_fee_cents: platformFee,
      service_fee_cents: serviceFee,
      processing_fee_cents: processingFee,
      currency: env.PLATFORM_CURRENCY,
      fee_breakdown: { platform_cents: platformFee, counterparty_net_cents: counterpartyNet },
      status: 'pending',
      idempotency_key: input.idempotencyKey,
      transfer_group: randomUUID(),
    });

    const txnId = String(txn._id);
    const charge = await stripe().createDestinationCharge({
      amountCents: input.amountCents,
      currency: env.PLATFORM_CURRENCY,
      destinationAccountId: account.stripe_account_id,
      applicationFeeCents: platformFee,
      transferGroup: txn.transfer_group,
      metadata: { transactionId: txnId, counterpartyId: input.counterpartyId },
      idempotencyKey: input.idempotencyKey,
      automaticTax: env.STRIPE_TAX_ENABLED,
      /**
       * The customer is attached whenever we intend to keep the card OR are spending one already
       * kept — Stripe requires a Customer for both halves of a stored credential.
       */
      ...(input.savePaymentMethod || input.offSession ? { customerRef: input.customerId } : {}),
      ...(input.savePaymentMethod ? { savePaymentMethod: true } : {}),
      ...(input.paymentMethodId ? { paymentMethodId: input.paymentMethodId } : {}),
      ...(input.offSession ? { offSession: true } : {}),
    });

    await repo.setPaymentIntentRef(txnId, charge.paymentIntentId);

    return {
      transactionId: txnId,
      paymentIntentRef: charge.paymentIntentId,
      clientSecret: charge.clientSecret,
      /**
       * Terminal for an off-session charge (`succeeded`, `requires_action`, or a decline via a
       * thrown error); `requires_payment_method` for an ordinary on-session one. Callers that
       * schedule payments MUST read this — `requires_action` is a bank asking the customer to
       * authenticate, not a refusal, and treating it as a failure would push someone into
       * delinquency for their bank's security policy.
       */
      status: charge.status,
      /** The card Stripe used. Captured by recurring callers so the next instalment can reuse it. */
      paymentMethodRef: charge.paymentMethodId ?? null,
      platformFeeCents: platformFee,
      counterpartyNetCents: counterpartyNet,
      replay: false,
    };
  },

  /**
   * The transaction behind a PaymentIntent, for callers settling their own domain off the webhook.
   *
   * A module crediting on `payment_intent.succeeded` needs two facts this row already holds — the
   * transaction id to reference from its own ledger, and the platform fee that was actually taken —
   * and neither is available from the Stripe event. Reading them back is strictly better than
   * re-deriving the fee at settle time, which would silently drift the moment a fee rule changed
   * between the charge and the card being confirmed.
   */
  findTransactionByPaymentIntent(paymentIntentRef: string) {
    return repo.findTransactionByPaymentIntent(paymentIntentRef);
  },

  /**
   * The client secret for an intent that already exists, so a stuck payment can be finished rather
   * than duplicated. Used where a charge needs the customer to come back and act on it — an SCA
   * challenge on a scheduled instalment being the case that matters. Opening a fresh charge there
   * would take the money twice if the original later confirms.
   */
  async clientSecretFor(paymentIntentRef: string): Promise<string | null> {
    const intent = await stripe().retrievePaymentIntent(paymentIntentRef);
    return intent.clientSecret ?? null;
  },

  /** Webhook-driven completion: pending → completed (immutable thereafter). */
  async completeByPaymentIntent(paymentIntentRef: string) {
    const txn = await repo.completePendingByPaymentIntent(paymentIntentRef);
    if (!txn) return; // already completed or unknown — idempotent
    await writeAudit({
      action: 'transaction.completed',
      entityType: 'transaction',
      entityId: String(txn._id),
      metadata: { amount_cents: txn.amount_cents, platform_fee_cents: txn.platform_fee_cents },
    });
    await publish('transaction.completed', {
      transactionId: String(txn._id),
      counterpartyId: txn.counterparty_id,
      amountCents: txn.amount_cents,
    });
  },

  async failByPaymentIntent(paymentIntentRef: string) {
    await repo.failPendingByPaymentIntent(paymentIntentRef);
  },

  /**
   * Read pending charges back from Stripe and settle them to match reality. The webhook is the
   * primary path; this is the safety net for environments where it isn't wired (local dev) or where
   * an event was dropped — otherwise a genuinely-paid sale sits as `pending` forever, invisible in
   * the vendor's earnings while its money sits in their Stripe balance.
   *
   * Bounded per call and idempotent: the transitions are guarded to pending-only, so a webhook that
   * arrives later is a harmless no-op.
   */
  async reconcilePendingCharges(counterpartyId: string, limit = 10) {
    const pending = await repo.listPendingByCounterparty(counterpartyId, limit);
    let settled = 0;
    for (const t of pending) {
      const ref = t.payment_intent_ref;
      if (!ref) continue;
      try {
        const intent = await stripe().retrievePaymentIntent(ref);
        if (intent.status === 'succeeded') {
          await this.completeByPaymentIntent(ref);
          settled += 1;
        } else if (intent.status === 'canceled') {
          // A dead intent should not linger as pending and skew "still settling" forever.
          await this.failByPaymentIntent(ref);
        }
      } catch {
        // A single unreadable intent must not break the payouts screen — leave it pending.
      }
    }
    return settled;
  },

  /**
   * Settle a transaction because its order was fulfilled. Order-ahead is capture-at-placement, so by
   * pickup the charge has long succeeded — this finalizes the ledger record without waiting on the
   * async `payment_intent.succeeded` webhook (which isn't wired in every environment, so reviews and
   * earnings would otherwise never unlock). Idempotent + guarded: only a PENDING txn transitions, so
   * a later webhook is a no-op and a failed charge is never flipped to completed.
   */
  async completeForOrder(transactionId: string) {
    const txn = await repo.completePendingById(transactionId);
    if (!txn) return; // already completed / failed / unknown — idempotent
    await writeAudit({
      action: 'transaction.completed',
      entityType: 'transaction',
      entityId: String(txn._id),
      reason: 'order_fulfilled',
      metadata: { amount_cents: txn.amount_cents, platform_fee_cents: txn.platform_fee_cents },
    });
    await publish('transaction.completed', {
      transactionId: String(txn._id),
      counterpartyId: txn.counterparty_id,
      amountCents: txn.amount_cents,
    });
  },

  /**
   * Read-only refund preview (R13/U6): the disclosed breakdown of what a refund would return, so the
   * customer/vendor sees it before confirming. No Stripe call, no state change.
   */
  async refundPreview(transactionId: string, opts: { fulfilled: boolean; partialCents?: number }) {
    const txn = await repo.findTransactionById(transactionId);
    if (!txn) throw NotFoundError('Transaction not found');
    return computeRefund(txn, opts);
  },

  /**
   * Refund a transaction per the R13 fee policy: `fulfilled` decides whether the marketplace fee +
   * tip come back (pre-fulfillment) or are retained (completed service). The computed policy drives
   * both the amount refunded to the customer and the Stripe reverse-transfer / application-fee flags,
   * and the disclosed breakdown is audit-logged.
   */
  async refund(transactionId: string, actorId: string, opts?: { fulfilled?: boolean }) {
    const txn = await repo.findTransactionById(transactionId);
    if (!txn) throw NotFoundError('Transaction not found');
    if (txn.status !== 'completed') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Only completed transactions can be refunded',
      );
    }
    if (!txn.payment_intent_ref) throw NotFoundError('Transaction has no payment intent');

    const quote = computeRefund(txn, { fulfilled: opts?.fulfilled ?? false });
    const { refundId } = await stripe().createRefund({
      paymentIntentId: txn.payment_intent_ref,
      amountCents: quote.refundedCents,
      reverseTransfer: quote.reverseTransfer,
      refundApplicationFee: quote.refundApplicationFee,
      idempotencyKey: `refund_${transactionId}`,
    });
    const updated = await repo.markRefunded(transactionId, refundId);
    await writeAudit({
      actorId,
      action: 'transaction.refunded',
      entityType: 'transaction',
      entityId: transactionId,
      reason: quote.scenario,
      metadata: {
        refund_ref: refundId,
        refunded_cents: quote.refundedCents,
        marketplace_fee_returned_cents: quote.marketplaceFeeReturnedCents,
        tip_returned_cents: quote.tipCents,
        disclosure: quote.disclosure,
      },
    });
    await publish('transaction.refunded', { transactionId });
    return { id: transactionId, status: updated?.status, refundRef: refundId, refund: quote };
  },

  async listMine(customerId: string, limit: number) {
    return repo.listByCustomer(customerId, limit);
  },

  listForCounterparty(counterpartyId: string, limit: number) {
    return repo.listByCounterparty(counterpartyId, limit);
  },

  /**
   * The vendor payouts screen (V-12): real connection status, real Stripe balance, and the real
   * earnings ledger — replacing the placeholder that always read "Stripe account active".
   *
   * Status is re-fetched live from Stripe, not just read from our store: the `account.updated`
   * webhook may not be wired in every environment (local dev), so reading through keeps the
   * "can you actually get paid?" answer honest right after onboarding.
   */
  async getBusinessPayouts(businessId: string) {
    const account = await repo.findAccountByOwner('business', businessId);

    let status = { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    let balance: { availableCents: number; pendingCents: number; currency: string } | null = null;
    if (account) {
      const live = await stripe().getAccount(account.stripe_account_id);
      status = {
        chargesEnabled: live.chargesEnabled,
        payoutsEnabled: live.payoutsEnabled,
        detailsSubmitted: live.detailsSubmitted,
      };
      // Keep our store in sync so downstream gates (go-live, charge) see the fresh state too.
      await repo.updateAccountStatus(account.stripe_account_id, {
        charges_enabled: live.chargesEnabled,
        payouts_enabled: live.payoutsEnabled,
        details_submitted: live.detailsSubmitted,
      });
      balance = await stripe().getBalance(account.stripe_account_id);
    }

    // Settle any charge that actually succeeded at Stripe but that our ledger still calls pending.
    // Without this the vendor's "earned" silently understates real revenue (and never matches the
    // Stripe balance) whenever a `payment_intent.succeeded` webhook was missed.
    await this.reconcilePendingCharges(businessId);

    const sales = await repo.listByCounterparty(businessId, 20);
    const earnings = sales.map((t) => ({
      transactionId: String(t._id),
      grossCents: t.amount_cents,
      netCents: t.fee_breakdown?.counterparty_net_cents ?? t.amount_cents - t.platform_fee_cents,
      status: t.status,
      createdAt: t.created_at,
    }));
    const completed = sales.filter((t) => t.status === 'completed');

    return {
      account: {
        connected: Boolean(account),
        ...status,
        payoutTier: account?.payout_tier ?? 'tier0',
      },
      balance,
      earnings,
      summary: {
        salesCount: completed.length,
        netEarnedCents: completed.reduce(
          (s, t) => s + (t.fee_breakdown?.counterparty_net_cents ?? t.amount_cents - t.platform_fee_cents),
          0,
        ),
      },
    };
  },

  /**
   * A seller's own payout readiness (S-13). Mirrors getBusinessPayouts: reads the live Stripe state
   * and syncs our copy, so a completed onboarding is reflected even when the `account.updated`
   * webhook never arrived — without this, a seller who finished Connect still can't be paid.
   */
  async getMyPayoutStatus(userId: string) {
    const account = await repo.findAccountByOwner('user', userId);
    if (!account) {
      return {
        connected: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        balance: null,
      };
    }
    const live = await stripe().getAccount(account.stripe_account_id);
    await repo.updateAccountStatus(account.stripe_account_id, {
      charges_enabled: live.chargesEnabled,
      payouts_enabled: live.payoutsEnabled,
      details_submitted: live.detailsSubmitted,
    });
    return {
      connected: true,
      chargesEnabled: live.chargesEnabled,
      payoutsEnabled: live.payoutsEnabled,
      detailsSubmitted: live.detailsSubmitted,
      balance: await stripe().getBalance(account.stripe_account_id),
    };
  },

  /**
   * A-2. WHY IS MY MONEY HELD?
   *
   * The product has always promised "instant payouts" while the system deliberately does the
   * opposite: `PAYOUT_DELAY_DAYS_BY_TIER` holds funds by verification tier, cash sales never reach
   * the platform at all, a missing Connect account strands a funded payout, and an open dispute
   * freezes everything. Every one of those is the right call — and until now the seller was told
   * none of them. They just saw "settled" and no money.
   *
   * This assembles the complete, honest answer in one read: what is moving, what is stuck, WHY, and
   * what (if anything) the seller can do about it. Each bucket names its own cause, because "your
   * payout is pending" is the answer that generates the support ticket rather than preventing it.
   */
  async fundsAvailability(userId: string, tier: Tier) {
    const holdDays = PAYOUT_DELAY_DAYS_BY_TIER[tier];
    const account = await repo.findAccountByOwner('user', userId);

    // Dynamic import: consignment.service imports THIS module, so a static import would close a
    // require cycle. Same pattern the settlement path uses for subscriptions.
    const { consignmentService } = await import('../consignment/consignment.service');
    const earnings = await consignmentService.sellerEarnings(userId);
    const t = earnings.totals;

    const connected = Boolean(account);
    const payoutsEnabled = account?.payouts_enabled === true;
    const frozen = account?.payouts_frozen === true;

    /**
     * One bucket per REASON money isn't in the seller's hand, each with the specific remedy. Empty
     * buckets are dropped — a list of zeroes explaining problems you don't have is noise.
     */
    const buckets = [
      {
        key: 'on_the_way' as const,
        label: 'On the way to your bank',
        amountCents: t.paidNetCents,
        blocked: false,
        reason:
          holdDays === 0
            ? 'Sent to your bank as soon as it settles — your verification level has no hold.'
            : `Held ${holdDays} day${holdDays === 1 ? '' : 's'} before it reaches your bank. This is your ${tier} verification level, not a delay on our side.`,
        remedy:
          holdDays === 0 || tier === 'gold'
            ? null
            : 'Finish verifying your identity to shorten or remove this hold.',
      },
      {
        key: 'cash_sales' as const,
        label: 'Earned from cash sales',
        amountCents: t.awaitingFundsCents,
        blocked: true,
        reason:
          'The customer paid you in cash, so this money never came through StreetServe — we can’t pay out what we never collected. It’s recorded as yours and settled against what you owe the hub.',
        remedy: 'Take card payments in-app and your share is paid out automatically.',
      },
      {
        key: 'no_payout_account' as const,
        label: 'Waiting on your payout account',
        amountCents: t.noAccountCents,
        blocked: true,
        reason:
          'This money was collected and is yours, but there’s no payout account to send it to yet.',
        remedy: 'Connect a payout account — this releases automatically once you do.',
      },
      {
        key: 'not_settled' as const,
        label: 'Sold, not settled yet',
        amountCents: t.pendingGrossCents,
        blocked: false,
        reason: `${t.pendingCheckoutCount} checkout${t.pendingCheckoutCount === 1 ? '' : 's'} still open. Your share is calculated when you return the unsold stock, or when everything sells.`,
        remedy: t.pendingCheckoutCount > 0 ? 'Return unsold stock to settle sooner.' : null,
      },
    ].filter((b) => b.amountCents > 0);

    /**
     * The single most useful next action, chosen by what unblocks the most money. Ordered by how
     * much of the seller's balance each one frees, not by how easy it is for us to ask.
     */
    const nextStep = frozen
      ? {
          action: 'await_dispute' as const,
          label: 'Payouts are paused while a dispute is open',
          detail: 'They resume automatically once it’s resolved. Nothing is lost.',
        }
      : !connected || !payoutsEnabled
        ? {
            action: 'connect_payout_account' as const,
            label: connected ? 'Finish setting up your payout account' : 'Connect a payout account',
            detail: 'Until this is done, collected money has nowhere to go.',
          }
        : tier !== 'gold' && holdDays > 0
          ? {
              action: 'verify_identity' as const,
              label: 'Verify your identity to shorten the hold',
              detail: `You're at ${tier} — payouts are held ${holdDays} day${holdDays === 1 ? '' : 's'}. Verified sellers wait less.`,
            }
          : null;

    return {
      tier,
      holdDays,
      connected,
      payoutsEnabled,
      detailsSubmitted: account?.details_submitted === true,
      /** Frozen is not the same as delayed: it means an active dispute, and no hold clock is running. */
      frozen,
      buckets,
      totals: {
        movingCents: buckets.filter((b) => !b.blocked).reduce((s, b) => s + b.amountCents, 0),
        blockedCents: buckets.filter((b) => b.blocked).reduce((s, b) => s + b.amountCents, 0),
      },
      nextStep,
    };
  },

  /**
   * SEPARATE CHARGES AND TRANSFERS (Phase 2). Charge the customer onto the PLATFORM balance with no
   * destination, so settlement can later split the proceeds three ways (platform fee / seller / hub).
   * A destination charge cannot do this — it pays exactly one connected account.
   *
   * The platform is merchant of record for these charges, which is a deliberate trade-off: it
   * carries chargeback liability and marketplace-facilitator tax duties in exchange for actually
   * controlling the money. See docs/consignment/RECOMMENDED_BUSINESS_MODEL.md.
   */
  async chargeToPlatform(input: {
    amountCents: number;
    transferGroup: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
    receiptEmail?: string;
  }): Promise<{ paymentIntentId: string; clientSecret: string | null; status: string }> {
    if (input.amountCents <= 0) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Charge amount must be positive');
    }
    return stripe().createPlatformCharge({
      amountCents: input.amountCents,
      currency: env.PLATFORM_CURRENCY,
      transferGroup: input.transferGroup,
      metadata: input.metadata,
      idempotencyKey: input.idempotencyKey,
      receiptEmail: input.receiptEmail,
    });
  },

  /**
   * Split collected funds to several connected accounts inside one `transfer_group`, so Stripe
   * reports the whole sale as a single economic event. Each leg is independently idempotent and
   * independently reported: one payee lacking an enabled account must not block the other.
   */
  async splitTransfer(input: {
    transferGroup: string;
    legs: Array<{
      key: string;
      ownerType: 'user' | 'business';
      ownerId: string;
      amountCents: number;
      idempotencyKey: string;
      /** B-3: set on the seller leg so a resident's share can route to shelter custody. */
      custodySource?: {
        type: 'consignment_settlement' | 'sale_payment' | 'job_payout';
        refId: string;
      };
    }>;
  }): Promise<
    Array<{
      key: string;
      amountCents: number;
      transferId: string | null;
      status: 'paid' | 'no_account' | 'not_applicable' | 'custody';
    }>
  > {
    const results: Array<{
      key: string;
      amountCents: number;
      transferId: string | null;
      status: 'paid' | 'no_account' | 'not_applicable' | 'custody';
    }> = [];
    for (const leg of input.legs) {
      if (leg.amountCents <= 0) {
        results.push({ key: leg.key, amountCents: leg.amountCents, transferId: null, status: 'not_applicable' });
        continue;
      }
      const payout = await this.payoutTransfer({
        ownerType: leg.ownerType,
        ownerId: leg.ownerId,
        amountCents: leg.amountCents,
        transferGroup: input.transferGroup,
        idempotencyKey: leg.idempotencyKey,
        custodySource: leg.custodySource,
      });
      results.push({
        key: leg.key,
        amountCents: leg.amountCents,
        transferId: payout?.transferId ?? null,
        /**
         * `custody` is reported distinctly from `paid`. The money moved, but it did NOT reach the
         * seller's own hands — collapsing the two would tell a resident they'd been paid while
         * their cash is still on a shelf at the front desk.
         */
        status: payout ? (payout.custodyPartnerId ? 'custody' : 'paid') : 'no_account',
      });
    }
    return results;
  },

  /**
   * Settlement payout: a direct transfer from the platform balance to a payout owner's connected
   * account (consignment seller_net / hub_share). Tiered timing is governed by the account's payout
   * schedule (set at verification). Returns null if the owner has no enabled account.
   */
  async payoutTransfer(input: {
    ownerType: 'user' | 'business';
    ownerId: string;
    amountCents: number;
    transferGroup: string;
    idempotencyKey: string;
    /** Set by callers that can record custody (B-3). Omitted → custody is skipped, not silently used. */
    custodySource?: {
      type: 'consignment_settlement' | 'sale_payment' | 'job_payout';
      refId: string;
    };
  }): Promise<{ transferId: string; destinationAccountId: string; custodyPartnerId?: string } | null> {
    if (input.amountCents <= 0) return null;
    const account = await repo.findAccountByOwner(input.ownerType, input.ownerId);

    /**
     * ═══ B-3: SHELTER CUSTODY ═══
     *
     * A resident with no bank account can never satisfy `payouts_enabled`, so their settled money
     * was stranded as `no_account` forever — the single hardest blocker in the shelter program, and
     * the reason someone could complete the whole funnel and still not get paid.
     *
     * When the seller is an active resident of a partner that has ACCEPTED the custody duty, the
     * transfer is redirected to the shelter's connected account and earmarked to that resident.
     * The shelter then hands it over as cash or in kind and marks it disbursed.
     *
     * The platform ledger is deliberately unchanged by this: the money genuinely left, and our
     * payable to the resident is genuinely discharged. What custody records is the duty that then
     * exists OFF-platform, so it stays reconcilable and disputable.
     *
     * Their OWN account always wins — a resident who has since opened one is paid directly, with no
     * intermediary. Custody is a fallback for people the banking system won't serve, never a
     * default for people it will.
     */
    if (input.ownerType === 'user' && (!account || !account.payouts_enabled) && input.custodySource) {
      const custodied = await this.tryCustodyPayout(input);
      if (custodied) return custodied;
    }

    if (!account || !account.payouts_enabled) return null;
    // A frozen account still ACCRUES what it is owed (the payable stays on the books) — the money
    // simply doesn't move until the dispute clears.
    if (account.payouts_frozen) {
      logger.warn(
        { ownerType: input.ownerType, ownerId: input.ownerId, amountCents: input.amountCents },
        'payout withheld — account frozen pending dispute',
      );
      return null;
    }
    const { transferId } = await stripe().createTransfer({
      amountCents: input.amountCents,
      currency: env.PLATFORM_CURRENCY,
      destinationAccountId: account.stripe_account_id,
      transferGroup: input.transferGroup,
      metadata: { ownerType: input.ownerType, ownerId: input.ownerId },
      idempotencyKey: input.idempotencyKey,
    });
    bizMetrics.payouts.inc({ kind: 'transfer', result: 'ok' });
    return { transferId, destinationAccountId: account.stripe_account_id };
  },

  /**
   * B-3 helper. Resolve the resident's shelter, transfer to ITS connected account, and earmark the
   * amount to the resident. Returns null whenever custody doesn't apply, so the caller falls
   * through to the ordinary `no_account` outcome — custody must never swallow a failure and report
   * success, because that would look identical to being paid.
   */
  async tryCustodyPayout(input: {
    ownerId: string;
    amountCents: number;
    transferGroup: string;
    idempotencyKey: string;
    custodySource?: {
      type: 'consignment_settlement' | 'sale_payment' | 'job_payout';
      refId: string;
    };
  }): Promise<{ transferId: string; destinationAccountId: string; custodyPartnerId: string } | null> {
    if (!input.custodySource) return null;
    // Dynamic import: the shelter service reaches back into payments, so a static import here would
    // close a require cycle.
    const { shelterService } = await import('../shelter/shelter.service');
    const caps = await shelterService.residentCapabilities(input.ownerId);
    if (!caps || !caps.custodyEnabled) return null;

    // The shelter's payout account. The partner is a verified org with its own Connect account —
    // if they haven't finished onboarding, custody genuinely isn't available yet.
    const partner = await shelterPartnerAccount(caps.partnerId);
    if (!partner) {
      logger.warn(
        { partnerId: caps.partnerId, residentUserId: input.ownerId },
        'custody enabled but shelter has no payout-enabled account — resident funds withheld',
      );
      return null;
    }

    const { transferId } = await stripe().createTransfer({
      amountCents: input.amountCents,
      currency: env.PLATFORM_CURRENCY,
      destinationAccountId: partner.stripeAccountId,
      transferGroup: input.transferGroup,
      metadata: {
        custody: 'shelter',
        shelterPartnerId: caps.partnerId,
        residentUserId: input.ownerId,
      },
      idempotencyKey: input.idempotencyKey,
    });

    await shelterService.recordCustody({
      partnerId: caps.partnerId,
      residentUserId: input.ownerId,
      amountCents: input.amountCents,
      sourceType: input.custodySource.type,
      sourceRefId: input.custodySource.refId,
      transferId,
    });

    bizMetrics.payouts.inc({ kind: 'transfer', result: 'ok' });
    logger.info(
      { residentUserId: input.ownerId, partnerId: caps.partnerId, amountCents: input.amountCents },
      'resident payout routed to shelter custody',
    );
    return {
      transferId,
      destinationAccountId: partner.stripeAccountId,
      custodyPartnerId: caps.partnerId,
    };
  },

  /**
   * Partial refund (e.g. an out-of-stock order line) — issues a refund for part of the charge
   * without flipping the transaction to `refunded` (it remains a completed, partially-refunded sale).
   */
  async refundAmount(transactionId: string, amountCents: number, actorId: string) {
    const txn = await repo.findTransactionById(transactionId);
    if (!txn) throw NotFoundError('Transaction not found');
    if (txn.status !== 'completed') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Only completed transactions can be refunded',
      );
    }
    if (!txn.payment_intent_ref) throw NotFoundError('Transaction has no payment intent');
    if (amountCents <= 0 || amountCents > txn.amount_cents) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Invalid partial refund amount');
    }
    // Partial policy (R13): fee reduced proportionally, tip untouched — same computation the preview
    // discloses. Drives the Stripe reverse-transfer / application-fee flags.
    const quote = computeRefund(txn, { fulfilled: true, partialCents: amountCents });
    const { refundId } = await stripe().createRefund({
      paymentIntentId: txn.payment_intent_ref,
      amountCents: quote.refundedCents,
      reverseTransfer: quote.reverseTransfer,
      refundApplicationFee: quote.refundApplicationFee,
      idempotencyKey: `prefund_${transactionId}_${amountCents}`,
    });
    await writeAudit({
      actorId,
      action: 'transaction.partial_refund',
      entityType: 'transaction',
      entityId: transactionId,
      reason: quote.scenario,
      metadata: {
        amountCents,
        refund_ref: refundId,
        marketplace_fee_returned_cents: quote.marketplaceFeeReturnedCents,
        disclosure: quote.disclosure,
      },
    });
    return { refundRef: refundId, amountCents, refund: quote };
  },

  /**
   * Reconciliation: compare our completed-charge ledger against Stripe's balance transactions.
   * Drift is surfaced for ops review (BACKGROUND_JOBS.md §4, SECURITY_GUIDELINES.md §2).
   */
  async reconcile() {
    const [ourAgg, balanceTxns] = await Promise.all([
      repo.sumCompletedNet(),
      stripe().listBalanceTransactions({ limit: 100 }),
    ]);
    const ourTotal = ourAgg[0]?.total ?? 0;
    const stripeCharges = balanceTxns.filter((t) => t.type === 'charge' || t.type === 'payment');
    const stripeTotal = stripeCharges.reduce((sum, t) => sum + t.amountCents, 0);
    const drift = ourTotal - stripeTotal;
    bizMetrics.reconciliationDrift.set(drift);
    if (drift !== 0) {
      await writeAudit({
        action: 'reconciliation.drift',
        entityType: 'reconciliation',
        reason: 'ledger vs stripe mismatch',
        metadata: { ourTotal, stripeTotal, drift },
      });
    }
    return { ourTotal, stripeTotal, drift, clean: drift === 0 };
  },
};
