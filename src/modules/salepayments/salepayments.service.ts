import { randomUUID } from 'node:crypto';
import { applyPercent } from '../../shared/money';

import { env } from '../../config/env';
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
import { consignmentRepository as consignmentRepo } from '../consignment/consignment.repository';
import { consignmentService } from '../consignment/consignment.service';
import { ledgerService } from '../ledger/ledger.service';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsService } from '../payments/payments.service';
import { feeService } from '../payments/fees';
import { debtService } from '../debt/debt.service';
import { taxService } from '../tax/tax.service';
import { BusinessModel } from '../vendors/vendors.model';
import { salePaymentsRepository as repo } from './salepayments.repository';

/**
 * The digital rail (Phase 2). A customer pays by card; the money lands on the PLATFORM balance and
 * is then split three ways — platform fee, seller share, hub share — inside one transfer_group.
 *
 * Two rules protect correctness:
 *   1. Units are reserved when the intent is created, not when payment lands. Otherwise two
 *      customers can pay for the same last item.
 *   2. Only the Stripe webhook may mark a payment succeeded. The client cannot be trusted to report
 *      that money arrived.
 */

/** How long a customer has to complete payment before the held units are released. */
const PAYMENT_WINDOW_MS = 15 * 60 * 1000;

export const salePaymentsService = {
  /**
   * Seller starts a sale: price it server-side, hold the stock, and open a Stripe PaymentIntent.
   * The amount NEVER comes from the client — it is derived from the checkout's snapshotted terms.
   */
  async createIntent(
    principal: Principal,
    input: {
      checkoutId: string;
      quantity: number;
      unitPriceCents?: number;
      customerEmail?: string;
      customerPhone?: string;
      idempotencyKey: string;
    },
  ) {
    const existing = await repo.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.intentView(existing);

    const checkout = await consignmentRepo.findCheckoutById(input.checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    if (checkout.seller_id !== principal.userId) {
      throw ForbiddenError('Not your checkout', ERROR_CODES.NOT_OWNER);
    }
    if (checkout.status !== 'active') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `Checkout is ${checkout.status} — only active inventory can be sold`,
      );
    }

    // Price server-side from the snapshot; an explicit price is allowed but must respect the
    // owner's floor and the seller's permissions (R18).
    const snapshotUnitPrice = checkout.current_unit_price_cents ?? checkout.unit_value_cents ?? 0;
    const unitPrice = input.unitPriceCents ?? snapshotUnitPrice;
    const min = checkout.minimum_authorized_price_cents;
    if (min != null && unitPrice < min && !checkout.seller_permissions?.may_sell_below_min) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Price is below the owner's minimum authorized price (${formatCents(min)})`,
      );
    }
    if (unitPrice <= 0) throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Price must be positive');

    // Reserve the units up-front — the same oversell guard the cash rail uses.
    const reserved = await consignmentRepo.reserveSaleUnits(input.checkoutId, input.quantity);
    if (!reserved) {
      throw ConflictError(
        ERROR_CODES.OVERSELL,
        'Not enough unsold units remain on this checkout',
      );
    }

    const amountCents = unitPrice * input.quantity;
    const payToken = randomUUID().replace(/-/g, '');
    const transferGroup = `sale_${payToken}`;

    /**
     * Sales tax is charged ON TOP of the sale price (Phase 5). The platform is the marketplace
     * facilitator, so it collects and remits — the customer pays `amount + tax`, while the
     * seller/hub/platform split still applies only to `amount`.
     */
    const hubForTax = await consignmentRepo.findHubById(checkout.hub_id);
    const tax = await taxService.quote(hubForTax?.city_slug ?? null, amountCents);
    const totalCharged = amountCents + tax.taxCents;

    let payment;
    try {
      payment = await repo.create({
        checkout_id: input.checkoutId,
        seller_id: principal.userId,
        hub_id: checkout.hub_id,
        product_id: checkout.product_id,
        pay_token: payToken,
        quantity: input.quantity,
        unit_price_cents: unitPrice,
        amount_cents: amountCents,
        tax_cents: tax.taxCents,
        tax_rate_bps: tax.rateBps,
        tax_jurisdiction: tax.jurisdiction,
        tax_city_slug: tax.citySlug,
        total_charged_cents: totalCharged,
        currency: env.PLATFORM_CURRENCY.toUpperCase(),
        transfer_group: transferGroup,
        customer_email: input.customerEmail ?? null,
        customer_phone: input.customerPhone ?? null,
        idempotency_key: input.idempotencyKey,
        expires_at: new Date(Date.now() + PAYMENT_WINDOW_MS),
      });

      const intent = await paymentsService.chargeToPlatform({
        // The customer is charged the sale price PLUS tax.
        amountCents: totalCharged,
        transferGroup,
        metadata: {
          checkoutId: input.checkoutId,
          sellerId: principal.userId,
          hubId: checkout.hub_id,
          payToken,
        },
        idempotencyKey: `salepay_${payToken}`,
        receiptEmail: input.customerEmail,
      });
      const updated = await repo.attachIntent(payment._id, intent.paymentIntentId, intent.clientSecret);
      return this.intentView(updated ?? payment);
    } catch (err) {
      // Never strand held stock because Stripe failed — release it before surfacing the error.
      await consignmentRepo.releaseSaleUnits(input.checkoutId, input.quantity);
      if (payment) await repo.markFailed(payment._id, 'intent_creation_failed');
      logger.error({ err, checkoutId: input.checkoutId }, 'sale payment intent creation failed');
      throw err;
    }
  },

  /** Public payment page data — no auth, so it exposes only what a customer needs to see. */
  async publicView(payToken: string) {
    const payment = await repo.findByToken(payToken);
    if (!payment) throw NotFoundError('Payment not found');

    const hub = await consignmentRepo.findHubById(payment.hub_id);
    const business = hub
      ? await BusinessModel.findById(hub.business_id, { name: 1 }).lean().exec()
      : null;
    const product = await consignmentRepo.findProductById(payment.product_id);

    return {
      payToken,
      businessName: business?.name ?? 'StreetServe seller',
      productName: product?.name ?? 'Item',
      quantity: payment.quantity,
      unitPriceCents: payment.unit_price_cents,
      amountCents: payment.amount_cents,
      // Itemised for the customer — tax must be visible, not folded into the price.
      taxCents: payment.tax_cents ?? 0,
      totalCents: payment.total_charged_cents || payment.amount_cents,
      currency: payment.currency,
      status: payment.status,
      clientSecret: payment.status === 'pending' ? payment.stripe_client_secret : null,
      expiresAt: payment.expires_at,
      expired: payment.status === 'pending' && payment.expires_at.getTime() < Date.now(),
    };
  },

  /** Polled by the seller's device while the customer pays. */
  async status(principal: Principal, id: string) {
    const payment = await repo.findById(id);
    if (!payment) throw NotFoundError('Payment not found');
    if (payment.seller_id !== principal.userId) {
      throw ForbiddenError('Not your payment', ERROR_CODES.NOT_OWNER);
    }
    return {
      id: String(payment._id),
      status: payment.status,
      amountCents: payment.amount_cents,
      paidAt: payment.paid_at,
      expiresAt: payment.expires_at,
    };
  },

  async cancel(principal: Principal, id: string) {
    const payment = await repo.findById(id);
    if (!payment) throw NotFoundError('Payment not found');
    if (payment.seller_id !== principal.userId) {
      throw ForbiddenError('Not your payment', ERROR_CODES.NOT_OWNER);
    }
    const cancelled = await repo.markCancelled(payment._id);
    if (!cancelled) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, `Payment is ${payment.status}`);
    }
    await consignmentRepo.releaseSaleUnits(payment.checkout_id, payment.quantity);
    return { id, status: 'cancelled' as const };
  },

  /**
   * THE money-arrived path. Called only from the Stripe webhook.
   *
   * Records the sale, posts the balanced ledger entries, then splits the collected funds to the
   * seller and hub. Idempotent at every step: Stripe delivers webhooks more than once.
   */
  async onPaymentSucceeded(paymentIntentId: string) {
    const payment = await repo.findByIntent(paymentIntentId);
    if (!payment) {
      logger.warn({ paymentIntentId }, 'payment_intent.succeeded for unknown sale payment');
      return { handled: false };
    }
    if (payment.status === 'succeeded') return { handled: true, duplicate: true };

    const checkout = await consignmentRepo.findCheckoutById(payment.checkout_id);
    if (!checkout) throw NotFoundError('Checkout not found');

    // Record the inventory movement. Units were already reserved at intent creation, so this
    // records the sale without decrementing again.
    const sale = await consignmentRepo.createSale({
      checkout_id: payment.checkout_id,
      quantity_sold: payment.quantity,
      sale_amount_cents: payment.amount_cents,
      proof_photo_url: null,
      logged_via: 'qr_scan',
      payment_rail: 'digital',
    });

    const claimed = await repo.markSucceeded(payment._id, String(sale._id));
    if (!claimed) return { handled: true, duplicate: true }; // lost the race to a duplicate webhook

    const gross = payment.amount_cents;
    const platformFee = await feeService.resolveFee('consignment_digital', gross);
    const distributable = gross - platformFee;
    const sellerNet = applyPercent(distributable, checkout.consignment_split_percent);
    const hubShare = distributable - sellerNet;

    const hub = await consignmentRepo.findHubById(payment.hub_id);

    // Sales tax was charged on top and is the state's money — record it as a liability, never as
    // revenue and never in the split.
    const taxCents = payment.tax_cents ?? 0;
    if (taxCents > 0 && payment.tax_jurisdiction) {
      await taxService.recordCollection({
        salePaymentId: String(payment._id),
        checkoutId: payment.checkout_id,
        jurisdiction: payment.tax_jurisdiction,
        citySlug: payment.tax_city_slug ?? null,
        taxableAmountCents: gross,
        rateBps: payment.tax_rate_bps ?? 0,
        taxCents,
        source: 'rate_table',
      });
    }

    // Money in: the platform holds the gross (split three ways) plus any tax (held for the state).
    await ledgerService.post({
      transactionId: `sale_${String(payment._id)}`,
      refType: 'sale',
      refId: String(sale._id),
      memo: `Digital sale ${formatCents(gross)}${taxCents > 0 ? ` + ${formatCents(taxCents)} tax` : ''}`,
      entries: [
        { ownerType: 'platform', accountType: 'cash', direction: 'debit', amountCents: gross + taxCents, entryType: 'sale_capture' },
        ...(taxCents > 0
          ? [{ ownerType: 'platform' as const, accountType: 'tax_payable' as const, direction: 'credit' as const, amountCents: taxCents, entryType: 'tax_collected' as const }]
          : []),
        { ownerType: 'user', ownerId: payment.seller_id, accountType: 'payable', direction: 'credit', amountCents: sellerNet, entryType: 'seller_share' },
        ...(hub
          ? [{ ownerType: 'business' as const, ownerId: hub.business_id, accountType: 'payable' as const, direction: 'credit' as const, amountCents: hubShare, entryType: 'hub_share' as const }]
          : []),
        { ownerType: 'platform', accountType: 'fee_revenue', direction: 'credit', amountCents: platformFee, entryType: 'platform_fee' },
      ],
    });

    /**
     * DEBT NETTING (Phase 3). Before paying the seller, recover anything they owe from earlier CASH
     * sales. This is the humane recovery path: rather than chasing someone for money, their next
     * card sale simply pays out less until the balance clears — and it quietly rewards the digital
     * rail without any policing.
     */
    const { nettedCents, remainingCents } = await debtService.netAgainstPayout(
      payment.seller_id,
      sellerNet,
      String(payment._id),
    );
    const sellerPayable = remainingCents;

    // Money out: split to the seller and hub in one transfer group.
    const legs = await paymentsService.splitTransfer({
      transferGroup: payment.transfer_group,
      legs: [
        {
          key: 'seller',
          ownerType: 'user' as const,
          ownerId: payment.seller_id,
          amountCents: sellerPayable,
          idempotencyKey: `split_seller_${String(payment._id)}`,
          // B-3: a resident with no bank account is paid into their shelter's custody instead of
          // having this leg stranded as `no_account` forever.
          custodySource: { type: 'sale_payment' as const, refId: String(payment._id) },
        },
        ...(hub
          ? [{ key: 'hub', ownerType: 'business' as const, ownerId: hub.business_id, amountCents: hubShare, idempotencyKey: `split_hub_${String(payment._id)}` }]
          : []),
      ],
    });

    // Only entries for legs that actually moved; an unpaid leg stays a payable, which is exactly
    // what the retry job later discharges.
    const paidLegs = legs.filter((l) => l.status === 'paid' && l.amountCents > 0);
    if (paidLegs.length > 0) {
      await ledgerService.post({
        transactionId: `payout_${String(payment._id)}`,
        refType: 'sale',
        refId: String(sale._id),
        memo: 'Split payout',
        entries: [
          ...paidLegs.map((l) =>
            l.key === 'seller'
              ? { ownerType: 'user' as const, ownerId: payment.seller_id, accountType: 'payable' as const, direction: 'debit' as const, amountCents: l.amountCents, entryType: 'payout' as const }
              : { ownerType: 'business' as const, ownerId: hub!.business_id, accountType: 'payable' as const, direction: 'debit' as const, amountCents: l.amountCents, entryType: 'payout' as const },
          ),
          {
            ownerType: 'platform',
            accountType: 'cash',
            direction: 'credit',
            amountCents: paidLegs.reduce((s, l) => s + l.amountCents, 0),
            entryType: 'payout',
          },
        ],
      });
    }

    // Record the split exactly as executed — a refund must know what to reverse, from whom, and
    // how much never left the platform because it was netted against debt.
    await repo.recordSplit(payment._id, {
      platform_fee_cents: platformFee,
      seller_net_cents: sellerNet,
      hub_share_cents: hubShare,
      seller_transfer_id: legs.find((l) => l.key === 'seller')?.transferId ?? null,
      hub_transfer_id: legs.find((l) => l.key === 'hub')?.transferId ?? null,
      seller_netted_cents: nettedCents,
    });

    await publish('sale.paid', {
      saleId: String(sale._id),
      checkoutId: payment.checkout_id,
      sellerId: payment.seller_id,
      amountCents: gross,
    });

    const sellerLeg = legs.find((l) => l.key === 'seller');
    const nettedNote =
      nettedCents > 0 ? ` (${formatCents(nettedCents)} cleared what you owed from cash sales)` : '';
    notificationsService.notify(payment.seller_id, {
      category: 'payments',
      title: 'Payment received',
      body:
        sellerLeg?.status === 'paid'
          ? `${formatCents(gross)} paid — ${formatCents(sellerPayable)} is on its way to you${nettedNote}.`
          : `${formatCents(gross)} paid — your ${formatCents(sellerPayable)} is waiting on a payout account${nettedNote}.`,
      data: {
        saleId: String(sale._id),
        grossCents: gross,
        sellerNetCents: sellerNet,
        nettedCents,
        paidOutCents: sellerPayable,
      },
    });
    if (hub) {
      notificationsService.notify(hub.owner_user_id, {
        category: 'payments',
        title: 'Your stock sold',
        body: `${payment.quantity} × sold for ${formatCents(gross)} — your share is ${formatCents(hubShare)}.`,
        data: { audience: 'hub', saleId: String(sale._id), hubShareCents: hubShare },
      });
    }

    await writeAudit({
      actorId: payment.seller_id,
      action: 'sale.paid',
      entityType: 'sale',
      entityId: String(sale._id),
      metadata: { gross, platformFee, sellerNet, hubShare, nettedCents, rail: 'digital' },
    });

    /**
     * Sold out → write the reconciliation record, exactly as the cash rail does on its final sale.
     * Without this a card sale never produced a settlement, so it was invisible on the hub's
     * settlements page even though the money had genuinely been transferred. `settle` disburses
     * nothing for a digital checkout (the split already happened above) — it records what moved,
     * and it is idempotent, so a redelivered webhook cannot write twice.
     */
    const settledCheckout = await consignmentRepo.findCheckoutById(payment.checkout_id);
    if (settledCheckout && (settledCheckout.quantity_sold ?? 0) >= settledCheckout.quantity) {
      await consignmentService.settle(settledCheckout);
    }

    return {
      handled: true,
      saleId: String(sale._id),
      gross,
      platformFee,
      sellerNet,
      hubShare,
      nettedCents,
      paidOutCents: sellerPayable,
    };
  },

  /**
   * A chargeback landed (Phase 4). The platform is merchant of record, so it eats the loss up front
   * — the only defence is to stop further money leaving that seller until it's resolved.
   */
  async onChargeDisputed(paymentIntentId: string, reason: string) {
    const payment = await repo.findByIntent(paymentIntentId);
    if (!payment) return { handled: false };

    await paymentsService.setPayoutFreeze('user', payment.seller_id, true, `chargeback:${reason}`);
    await publish('payouts.frozen', {
      ownerType: 'user',
      ownerId: payment.seller_id,
      reason: `chargeback:${reason}`,
    });
    notificationsService.notify(payment.seller_id, {
      category: 'payments',
      title: 'Payouts paused — card dispute',
      body: `A customer disputed a ${formatCents(payment.amount_cents)} payment. Payouts are paused while it's reviewed.`,
      data: { salePaymentId: String(payment._id), reason },
    });
    await writeAudit({
      actorId: 'stripe',
      action: 'payouts.frozen',
      entityType: 'sale_payment',
      entityId: String(payment._id),
      metadata: { reason, sellerId: payment.seller_id },
    });
    return { handled: true };
  },

  async onChargeDisputeClosed(paymentIntentId: string, status: string) {
    const payment = await repo.findByIntent(paymentIntentId);
    if (!payment) return { handled: false };
    // `won` means the charge stands; anything else means the money is gone and stays accounted for
    // as a loss/clawback. Either way the freeze lifts — it was a hold, not a punishment.
    await paymentsService.setPayoutFreeze('user', payment.seller_id, false, null);
    notificationsService.notify(payment.seller_id, {
      category: 'payments',
      title: status === 'won' ? 'Dispute resolved in your favour' : 'Dispute closed',
      body:
        status === 'won'
          ? 'Payouts have resumed.'
          : 'The disputed amount was returned to the customer. Payouts have resumed.',
      data: { salePaymentId: String(payment._id), status },
    });
    return { handled: true };
  },

  async onPaymentFailed(paymentIntentId: string, reason: string) {
    const payment = await repo.findByIntent(paymentIntentId);
    if (!payment || payment.status !== 'pending') return { handled: false };
    await repo.markFailed(payment._id, reason);
    // Release the hold so the units are sellable again.
    await consignmentRepo.releaseSaleUnits(payment.checkout_id, payment.quantity);
    return { handled: true };
  },

  /** Sweep: release units held by intents the customer never paid. */
  async expireStalePayments(): Promise<number> {
    const stale = await repo.findExpired(new Date());
    let released = 0;
    for (const p of stale) {
      const expired = await repo.markExpired(p._id);
      if (!expired) continue;
      await consignmentRepo.releaseSaleUnits(p.checkout_id, p.quantity);
      released += 1;
    }
    if (released > 0) logger.info({ released }, 'expired unpaid sale payments — units released');
    return released;
  },

  async listForCheckout(principal: Principal, checkoutId: string) {
    const checkout = await consignmentRepo.findCheckoutById(checkoutId);
    if (!checkout) throw NotFoundError('Checkout not found');
    const hub = await consignmentRepo.findHubById(checkout.hub_id);
    const isSeller = checkout.seller_id === principal.userId;
    const isHubOwner = hub?.owner_user_id === principal.userId;
    if (!isSeller && !isHubOwner) {
      throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);
    }
    const rows = await repo.listByCheckout(checkoutId);
    return rows.map((p) => ({
      id: String(p._id),
      quantity: p.quantity,
      amountCents: p.amount_cents,
      status: p.status,
      rail: p.rail,
      paidAt: p.paid_at ?? null,
      createdAt: p.created_at,
    }));
  },

  intentView(payment: {
    _id: unknown;
    pay_token: string;
    amount_cents: number;
    currency: string;
    quantity: number;
    unit_price_cents: number;
    status: string;
    stripe_client_secret?: string | null;
    expires_at: Date;
  }) {
    return {
      id: String(payment._id),
      payToken: payment.pay_token,
      payUrl: `${env.APP_BASE_URL}/pay/${payment.pay_token}`,
      amountCents: payment.amount_cents,
      currency: payment.currency,
      quantity: payment.quantity,
      unitPriceCents: payment.unit_price_cents,
      status: payment.status,
      clientSecret: payment.stripe_client_secret ?? null,
      expiresAt: payment.expires_at,
    };
  },
};
