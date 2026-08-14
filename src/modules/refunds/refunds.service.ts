import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { formatCents } from '../../shared/money';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { stripe } from '../../integrations/stripe';
import { consignmentRepository as consignmentRepo } from '../consignment/consignment.repository';
import { debtService } from '../debt/debt.service';
import { ledgerService } from '../ledger/ledger.service';
import { notificationsService } from '../notifications/notifications.service';
import { salePaymentsRepository as paymentsRepo } from '../salepayments/salepayments.repository';
import { RefundModel, type RefundReason } from './refunds.model';

/**
 * Refunds (Phase 4).
 *
 * The hard part isn't refunding the customer — it's unwinding a three-way split. The money was
 * distributed to the seller and hub the moment the customer paid, so a refund must pull each share
 * back proportionally, and cope with the very likely case that a payee has already spent theirs.
 *
 * Two rules:
 *   1. Never mutate history. The original sale and its ledger entries stand; a refund is a new,
 *      balanced REVERSAL that references them.
 *   2. Never let a shortfall vanish. If a share can't be pulled back, it becomes a clawback debt.
 */
export const refundsService = {
  /**
   * Refund a customer, in full or in part.
   *
   * Proportional reversal: refunding 40% of a sale reverses 40% of the seller's share, 40% of the
   * hub's, and 40% of the platform fee — so the split still reconciles afterwards. Rounding follows
   * the same convention as settlement (floor the seller, hub takes the remainder) so no cent is
   * created or lost.
   */
  async refundSale(
    principal: Principal,
    salePaymentId: string,
    input: {
      amountCents?: number;
      reason: RefundReason;
      restock?: boolean;
      idempotencyKey: string;
    },
  ) {
    const payment = await paymentsRepo.findById(salePaymentId);
    if (!payment) throw NotFoundError('Payment not found');
    if (payment.status !== 'succeeded') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Payment is ${payment.status}`);
    }

    const checkout = await consignmentRepo.findCheckoutById(payment.checkout_id);
    if (!checkout) throw NotFoundError('Checkout not found');
    const hub = await consignmentRepo.findHubById(payment.hub_id);

    // Either party to the sale may refund it, plus admins.
    const isSeller = checkout.seller_id === principal.userId;
    const isHubOwner = hub?.owner_user_id === principal.userId;
    const isAdmin = principal.roles.includes('admin');
    if (!isSeller && !isHubOwner && !isAdmin) {
      throw ForbiddenError('Not a participant in this sale', ERROR_CODES.NOT_PARTICIPANT);
    }

    const alreadyRefunded = payment.refunded_cents ?? 0;
    const refundable = payment.amount_cents - alreadyRefunded;
    if (refundable <= 0) {
      throw ConflictError(ERROR_CODES.DUPLICATE, 'This sale has already been fully refunded');
    }
    const amount = input.amountCents ?? refundable;
    if (amount > refundable) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Only ${formatCents(refundable)} of this sale can still be refunded`,
      );
    }

    // ── Proportional split of the refund across the three parties ──
    const split = payment.split;
    const gross = payment.amount_cents;
    const ratio = amount / gross;
    const reversedSeller = Math.floor((split?.seller_net_cents ?? 0) * ratio);
    const reversedFee = Math.floor((split?.platform_fee_cents ?? 0) * ratio);
    // The hub absorbs the rounding remainder, mirroring settlement.
    const reversedHub = amount - reversedSeller - reversedFee;

    const refund = await RefundModel.create({
      sale_payment_id: salePaymentId,
      sale_id: payment.sale_id,
      checkout_id: payment.checkout_id,
      amount_cents: amount,
      reason: input.reason,
      reversed_seller_cents: reversedSeller,
      reversed_hub_cents: reversedHub,
      reversed_fee_cents: reversedFee,
      created_by: principal.userId,
    });
    const refundId = String(refund._id);

    // ── Pull the split back from each connected account ──
    // A share that was netted against debt never left the platform, so only what was actually
    // transferred can be pulled back; the rest is already in hand.
    const sellerTransferred = Math.max(
      0,
      (split?.seller_net_cents ?? 0) - (split?.seller_netted_cents ?? 0),
    );
    const sellerPullable = Math.min(reversedSeller, sellerTransferred);

    const sellerReversal = await this.tryReverse(
      split?.seller_transfer_id ?? null,
      sellerPullable,
      `refrev_seller_${refundId}`,
    );
    const hubReversal = await this.tryReverse(
      split?.hub_transfer_id ?? null,
      reversedHub,
      `refrev_hub_${refundId}`,
    );

    const recoveredSeller = sellerReversal.ok ? sellerPullable : 0;
    const recoveredHub = hubReversal.ok ? reversedHub : 0;
    // Whatever couldn't be pulled back is money the platform has fronted — it becomes a debt, not
    // a silent loss.
    const sellerShortfall = reversedSeller - recoveredSeller;
    const hubShortfall = reversedHub - recoveredHub;

    // ── Refund the customer from the platform balance ──
    let stripeRefundId: string | null = null;
    if (payment.stripe_payment_intent_id) {
      const res = await stripe().createRefund({
        paymentIntentId: payment.stripe_payment_intent_id,
        amountCents: amount,
        // Separate charges + transfers: legs are reversed explicitly above, not by Stripe.
        reverseTransfer: false,
        refundApplicationFee: false,
        idempotencyKey: `refund_${refundId}`,
      });
      stripeRefundId = res.refundId;
    }

    /**
     * ── Ledger: a balanced reversal, never an edit ──
     *
     *   CR platform cash    the refund paid to the customer
     *   DR platform cash    whatever was successfully pulled back from the payees
     *   DR fee revenue      the platform's fee, returned in proportion
     *   DR receivable       any share that could NOT be pulled back — now owed to us
     *
     * Debits always sum to the refund amount, because seller + hub + fee shares sum to it by
     * construction.
     */
    const entries = [
      { ownerType: 'platform' as const, accountType: 'cash' as const, direction: 'credit' as const, amountCents: amount, entryType: 'refund' as const },
      { ownerType: 'platform' as const, accountType: 'cash' as const, direction: 'debit' as const, amountCents: recoveredSeller + recoveredHub, entryType: 'reversal' as const },
      { ownerType: 'platform' as const, accountType: 'fee_revenue' as const, direction: 'debit' as const, amountCents: reversedFee, entryType: 'reversal' as const },
      { ownerType: 'user' as const, ownerId: payment.seller_id, accountType: 'receivable' as const, direction: 'debit' as const, amountCents: sellerShortfall, entryType: 'reversal' as const },
      ...(hub
        ? [{ ownerType: 'business' as const, ownerId: hub.business_id, accountType: 'receivable' as const, direction: 'debit' as const, amountCents: hubShortfall, entryType: 'reversal' as const }]
        : []),
    ].filter((e) => e.amountCents > 0);

    await ledgerService.post({
      transactionId: `refund_${refundId}`,
      refType: 'refund',
      refId: refundId,
      memo: `Refund ${formatCents(amount)} — ${input.reason}`,
      entries,
    });

    /**
     * POST-SETTLEMENT SHORTFALL. If the seller's share couldn't be pulled back — they've already
     * spent it — the platform has funded the refund out of its own balance. That is recorded as a
     * clawback debt so it is recovered from future earnings rather than quietly written off.
     */
    let clawbackDebtId: string | null = null;
    if (sellerShortfall > 0) {
      // The receivable is already on the books from the ledger entry above; this makes it a
      // trackable, repayable balance the seller can see and clear.
      const debt = await debtService.recordClawback({
        sellerId: payment.seller_id,
        refundId,
        amountCents: sellerShortfall,
      });
      clawbackDebtId = debt ? String(debt._id) : null;
      logger.warn(
        { refundId, sellerId: payment.seller_id, amount: sellerShortfall },
        'seller share could not be reversed — recorded as clawback debt',
      );
    }

    await paymentsRepo.addRefunded(payment._id, amount);

    // Return the goods to sellable stock if they came back.
    let restocked = 0;
    if (input.restock) {
      const units = Math.round(payment.quantity * ratio);
      if (units > 0) {
        await consignmentRepo.releaseSaleUnits(payment.checkout_id, units);
        restocked = units;
      }
    }

    await publish('sale.refunded', {
      saleId: payment.sale_id ?? '',
      refundId,
      amountCents: amount,
      sellerId: payment.seller_id,
    });

    notificationsService.notify(payment.seller_id, {
      category: 'payments',
      title: 'Refund issued',
      body: clawbackDebtId
        ? `${formatCents(amount)} was refunded. ${formatCents(sellerShortfall)} of your share comes out of future sales.`
        : `${formatCents(amount)} was refunded to the customer.`,
      data: { refundId, amountCents: amount },
    });
    if (hub) {
      notificationsService.notify(hub.owner_user_id, {
        category: 'payments',
        title: 'Refund issued',
        body: `${formatCents(amount)} refunded — ${formatCents(reversedHub)} came back from your share.`,
        data: { audience: 'hub', refundId, amountCents: amount },
      });
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'sale.refunded',
      entityType: 'refund',
      entityId: refundId,
      metadata: { amount, reversedSeller, reversedHub, reversedFee, reason: input.reason },
    });

    return {
      id: refundId,
      amountCents: amount,
      reversals: {
        sellerCents: reversedSeller,
        hubCents: reversedHub,
        feeCents: reversedFee,
      },
      sellerReversed: sellerReversal.ok,
      hubReversed: hubReversal.ok,
      clawbackDebtId,
      restockedQuantity: restocked,
      stripeRefundId,
    };
  },

  /**
   * Attempt to pull a transfer back. A failure is expected and survivable — the payee may simply
   * have spent the money — so it is reported rather than thrown.
   */
  async tryReverse(
    transferId: string | null,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<{ ok: boolean; reversalId: string | null }> {
    if (!transferId || amountCents <= 0) return { ok: false, reversalId: null };
    try {
      const res = await stripe().reverseTransfer({ transferId, amountCents, idempotencyKey });
      return { ok: true, reversalId: res.reversalId };
    } catch (err) {
      logger.warn({ err, transferId, amountCents }, 'transfer reversal failed — funds already spent');
      return { ok: false, reversalId: null };
    }
  },

  async listForSale(principal: Principal, salePaymentId: string) {
    const payment = await paymentsRepo.findById(salePaymentId);
    if (!payment) throw NotFoundError('Payment not found');
    const rows = await RefundModel.find({ sale_payment_id: salePaymentId })
      .sort({ created_at: -1 })
      .lean()
      .exec();
    void principal;
    return rows.map((r) => this.view(r));
  },

  /** Every refund touching a hub's stock — the hub's refunds screen. */
  async listForHub(principal: Principal, hubId: string) {
    const hub = await consignmentRepo.findHubById(hubId);
    if (!hub) throw NotFoundError('Hub not found');
    if (hub.owner_user_id !== principal.userId) {
      throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
    }
    const checkouts = await consignmentRepo.listCheckoutsByHub(hubId);
    const ids = checkouts.map((c) => String(c._id));
    const rows = await RefundModel.find({ checkout_id: { $in: ids } })
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    return rows.map((r) => this.view(r));
  },

  /** Customer-facing: look up a refund from the receipt token, no account required. */
  async requestFromReceipt(payToken: string, reason: RefundReason) {
    const payment = await paymentsRepo.findByToken(payToken);
    if (!payment) throw NotFoundError('Payment not found');
    if (payment.status !== 'succeeded') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'This sale was never paid');
    }
    const checkout = await consignmentRepo.findCheckoutById(payment.checkout_id);
    const hub = checkout ? await consignmentRepo.findHubById(checkout.hub_id) : null;

    // A customer REQUESTS; a participant decides. Auto-refunding on an unauthenticated request
    // would let anyone with a receipt link drain a seller.
    notificationsService.notify(payment.seller_id, {
      category: 'payments',
      title: 'Refund requested',
      body: `A customer asked for a refund of ${formatCents(payment.amount_cents)}.`,
      data: { salePaymentId: String(payment._id), reason },
    });
    if (hub) {
      notificationsService.notify(hub.owner_user_id, {
        category: 'payments',
        title: 'Refund requested',
        body: `A customer asked for a refund of ${formatCents(payment.amount_cents)}.`,
        data: { audience: 'hub', salePaymentId: String(payment._id), reason },
      });
    }
    await writeAudit({
      actorId: 'customer',
      action: 'refund.requested',
      entityType: 'sale_payment',
      entityId: String(payment._id),
      metadata: { reason, amountCents: payment.amount_cents },
    });
    return { requested: true, amountCents: payment.amount_cents };
  },

  view(r: {
    _id: unknown;
    sale_payment_id: string;
    checkout_id: string;
    amount_cents: number;
    reason: string;
    reversed_seller_cents: number;
    reversed_hub_cents: number;
    reversed_fee_cents: number;
    seller_clawback_debt_id?: string | null;
    restocked_quantity?: number;
    created_at?: Date;
  }) {
    return {
      id: String(r._id),
      salePaymentId: r.sale_payment_id,
      checkoutId: r.checkout_id,
      amountCents: r.amount_cents,
      reason: r.reason,
      reversedSellerCents: r.reversed_seller_cents,
      reversedHubCents: r.reversed_hub_cents,
      reversedFeeCents: r.reversed_fee_cents,
      clawbackDebtId: r.seller_clawback_debt_id ?? null,
      restockedQuantity: r.restocked_quantity ?? 0,
      createdAt: r.created_at,
    };
  },
};
