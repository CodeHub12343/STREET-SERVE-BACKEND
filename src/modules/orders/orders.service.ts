import type { z } from 'zod';

import { env } from '../../config/env';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { UserModel } from '../identity/identity.model';
import { BusinessModel } from '../vendors/vendors.model';
import { livemapService } from '../livemap/livemap.service';
import { notificationsService } from '../notifications/notifications.service';
import { feeService } from '../payments/fees';
import { paymentsService } from '../payments/payments.service';
import { queueService } from '../queue/queue.service';
import { vendorsService } from '../vendors/vendors.service';
import { computeOrderBreakdown, type OrderBreakdown } from './pricing';
import { queuePositionDiscount, resolveDiscount, type ResolvedDiscount } from './discounts';
import { promotionsService } from '../promotions/promotions.service';
import { payforwardService } from '../payforward/payforward.service';
import { resolvePickupSlot } from './scheduling';
import type { DeliveryDestination } from './orders.schema';
import { loyaltyService } from '../loyalty/loyalty.service';
import { referralsService } from '../loyalty/referrals.service';
import { applyPercent } from '../../shared/money';
import { OrderModel } from './orders.model';

type DeliveryDestinationInput = z.infer<typeof DeliveryDestination>;
import { ordersRepository as repo } from './orders.repository';

interface ResolvedLine {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

async function assertBusinessOwner(principal: Principal, businessId: string): Promise<string> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId)
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  return owner;
}

/** Resolve requested items against the live menu (server-authoritative prices + availability). */
async function resolveLines(
  businessId: string,
  items: { menuItemId: string; quantity: number }[],
): Promise<ResolvedLine[]> {
  const menu = await vendorsService.getMenuItemsByIds(
    businessId,
    items.map((i) => i.menuItemId),
  );
  const menuById = new Map(menu.map((m) => [m.id, m]));
  return items.map((i) => {
    const m = menuById.get(i.menuItemId);
    if (!m) throw NotFoundError(`Menu item ${i.menuItemId} not found`);
    if (!m.isAvailable)
      throw BusinessRuleError(ERROR_CODES.ITEM_UNAVAILABLE, `${m.name} is unavailable`);
    return {
      menu_item_id: m.id,
      name: m.name,
      quantity: i.quantity,
      unit_price_cents: m.priceCents,
    };
  });
}

/**
 * The one pricing path shared by quote (preview) and place (charge) so preview == charge (R9/B1).
 * Discount is derived server-side — never client-supplied.
 *
 * 7.6: two discount sources now exist — the customer's locked queue position and any live flash
 * sale — and they go through **one contest** (A-7, `discounts.ts`), which picks the single best.
 * They do not stack: 20% for being second in line plus a 30%-off flash sale would compound to 44%,
 * and nobody authored that number. Best-wins is what a customer expects and what a vendor can
 * reason about.
 */
async function priceOrder(
  businessId: string,
  userId: string,
  lines: ResolvedLine[],
  tipCents: number,
  roundUpCents: number,
): Promise<{ breakdown: OrderBreakdown; discount: ResolvedDiscount }> {
  const subtotal = lines.reduce((s, li) => s + li.unit_price_cents * li.quantity, 0);

  const [queuePercent, flashCandidates] = await Promise.all([
    queueService.lockedDiscountFor('business', businessId, userId),
    promotionsService.candidatesFor(
      businessId,
      lines.map((li) => String(li.menu_item_id)),
    ),
  ]);

  const discount = resolveDiscount([
    ...(queuePercent > 0
      ? [
          queuePositionDiscount({
            ownerType: 'business' as const,
            ownerId: businessId,
            position: 0, // the position itself is already reflected in the locked percent
            percent: queuePercent,
          }),
        ]
      : []),
    ...flashCandidates,
  ]);
  const discountPercent = discount.percent;
  const discountedSubtotal = subtotal - applyPercent(subtotal, discountPercent);
  // Customer-facing fee rates (R8/R10) + the informational vendor platform fee — all resolved
  // SERVER-SIDE from the registry (never client-supplied, S7).
  const [rates, platformFeeCents] = await Promise.all([
    feeService.resolveOrderFeeRates(),
    feeService.resolveFee('marketplace', discountedSubtotal),
  ]);
  return {
    breakdown: computeOrderBreakdown({
      subtotalCents: subtotal,
      discountPercent,
      tipCents,
      roundUpCents,
      platformFeeCents,
      rates,
    }),
    discount,
  };
}

/**
 * What a community fund may pay for: everything except the tip and the round-up.
 *
 * Those two are the customer's own gestures. Funding someone else's gratuity out of money given for
 * meals is not what any contributor had in mind, and a round-up is itself a donation — paying for a
 * donation with a donation is circular.
 */
function coverableOf(breakdown: OrderBreakdown): number {
  return Math.max(0, breakdown.totalCents - breakdown.tipCents - breakdown.roundUpCents);
}

export const ordersService = {
  /**
   * Server-authoritative price preview (R9): the exact itemized breakdown the customer will be
   * charged, computed from the live menu + their locked queue discount. No side effects, no charge —
   * the frontend renders these lines pre-confirmation, and `place()` re-derives the same total.
   */
  async quote(
    principal: Principal,
    input: {
      businessId: string;
      items: { menuItemId: string; quantity: number }[];
      tipCents?: number;
      roundUpCents?: number;
    },
  ) {
    const owner = await vendorsService.getBusinessOwner(input.businessId);
    if (!owner) throw NotFoundError('Business not found');
    const status = await livemapService.getActiveStatus('business', input.businessId);
    const lines = await resolveLines(input.businessId, input.items);
    const { breakdown, discount } = await priceOrder(
      input.businessId,
      principal.userId,
      lines,
      input.tipCents ?? 0,
      input.roundUpCents ?? 0,
    );
    return {
      businessId: input.businessId,
      openForOrders: status === 'parked',
      items: lines.map((li) => ({
        menuItemId: li.menu_item_id,
        name: li.name,
        quantity: li.quantity,
        unitPriceCents: li.unit_price_cents,
      })),
      breakdown,
      /**
       * PIF-4 — the offer, shown BEFORE the customer commits to anything. No side effects: this is
       * what the fund *would* cover, and reserving it here would let a browsing customer hold money
       * out of the pool indefinitely.
       */
      payItForward: await payforwardService.quoteRedemption({
        businessId: input.businessId,
        userId: principal.userId,
        userTier: principal.verificationTier,
        coverableCents: coverableOf(breakdown),
      }),
      /**
       * 7.6 — WHY this price. A receipt line reading "-20%" tells a customer nothing; "20% off for
       * being #2 in line" is a reason they can check. `considered` lists the discounts that were in
       * force and lost, so a customer who came for a flash sale and got a bigger queue discount can
       * see that nothing was taken away from them.
       */
      discount: {
        percent: discount.percent,
        label: discount.label || null,
        source: discount.source,
        alsoAvailable: discount.considered
          .filter((c) => c.source !== discount.source)
          .map((c) => ({ source: c.source, percent: c.percent, label: c.label })),
      },
    };
  },

  /**
   * Place a direct order for pickup. Allowed only while the business is Parked (open); totals are
   * computed server-side from the menu; the charge is taken immediately via Stripe Connect. Uses the
   * same `priceOrder` path as `quote()`, so the charge equals the preview the customer confirmed.
   */
  async place(
    principal: Principal,
    input: {
      businessId: string;
      items: { menuItemId: string; quantity: number }[];
      tipCents?: number;
      roundUpCents?: number;
      /** 7.5 — when present, this is a scheduled pickup rather than a now order. */
      scheduledFor?: string;
      /** DAN-10 — when present, this is a delivery rather than a collection. */
      destination?: DeliveryDestinationInput;
      /** PIF-4 — opt in to the community fund covering part or all of this order. */
      usePayItForward?: boolean;
    },
    idempotencyKey: string,
  ) {
    const owner = await vendorsService.getBusinessOwner(input.businessId);
    if (!owner) throw NotFoundError('Business not found');

    /**
     * DAN-10 — delivery is gated per city, **default-deny**.
     *
     * `isFeatureExplicitlyEnabled` rather than `isFeatureEnabled`, matching the food-gating
     * precedent: a city nobody has reviewed must not be treated as cleared. Delivery has a legal
     * precondition that is not a code change — ADR-004 requires insurance to be bound before the
     * first real delivery — so an unconfigured city defaulting to "yes" would be the single most
     * expensive default in the system.
     *
     * Scoped to the platform's default city because a Business carries no `city_slug` today (a Hub
     * does). Delivery is the first feature that needs one per-business; adding it belongs with the
     * dispatch work in Phase 5, and until then the flag is all-or-nothing for the pilot city, which
     * is exactly how the pilot should run anyway.
     */
    const destination = input.destination ?? null;
    if (destination) {
      const { platformService } = await import('../platform/platform.service');
      if (!(await platformService.isFeatureExplicitlyEnabled(env.DEFAULT_CITY, 'delivery'))) {
        throw ForbiddenError(
          'Delivery is not available here yet — this order can be placed for pickup instead.',
          ERROR_CODES.FEATURE_DISABLED,
        );
      }
    }

    /**
     * 7.5 / P-14 — the Parked requirement applies to `pickup_now` ONLY.
     *
     * You cannot collect from a truck that is driving, so a now-order needs the business parked. A
     * scheduled order is the opposite case: the vendor is on the road at 10am *in order to* be at
     * the pitch at noon, and requiring them to already be parked would make ordering ahead useless
     * to the vendors it exists for. What replaces the check is the vendor's own opt-in and notice
     * period — a promise they made, not a state we inferred.
     */
    let scheduledFor: Date | null = null;
    if (input.scheduledFor) {
      const business = await BusinessModel.findById(input.businessId)
        .select('scheduled_pickup')
        .lean();
      scheduledFor = resolvePickupSlot(new Date(input.scheduledFor), business?.scheduled_pickup);
    } else {
      /**
       * Away/Closed (or not live) → ordering is disabled (Flow 2d). This covers `delivery` as well
       * as `pickup_now`: a delivery is dispatched FROM the vendor's pitch while they keep serving,
       * which is the whole premise of the feature ("sell more without leaving your location"). A
       * vendor who is not parked has nothing to hand a driver.
       */
      const status = await livemapService.getActiveStatus('business', input.businessId);
      if (status !== 'parked') {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_AWAY,
          destination
            ? 'This business is not currently open for delivery orders'
            : 'This business is not currently open for pickup orders',
        );
      }
    }

    const tip = input.tipCents ?? 0;
    const roundUp = input.roundUpCents ?? 0;
    const lineItems = await resolveLines(input.businessId, input.items);
    const { breakdown } = await priceOrder(
      input.businessId,
      principal.userId,
      lineItems,
      tip,
      roundUp,
    );

    /**
     * PIF-4 — commit the community fund BEFORE the card is charged, and hand it back if the charge
     * fails. The other order (spend the pool, then charge) leaves the vendor short on every declined
     * card, and there is no way to un-eat the meal.
     *
     * Applied AFTER the discount, deliberately: the fund covers what the customer would actually
     * have paid. Applying it first would spend community money on the vendor's own promotion.
     */
    const reservation = input.usePayItForward
      ? await payforwardService.reserve({
          businessId: input.businessId,
          userId: principal.userId,
          userTier: principal.verificationTier,
          coverableCents: coverableOf(breakdown),
        })
      : null;
    const payItForwardCents = reservation?.amountCents ?? 0;
    const payItForwardReason = reservation?.reason ?? null;
    const amountDueCents = breakdown.totalCents - payItForwardCents;

    let charge: { transactionId: string } | null = null;
    try {
      /**
       * A fully covered order takes no card at all — which is the moment the whole feature exists
       * for. Charging $0 to satisfy a data model would fail at the processor anyway.
       */
      if (amountDueCents > 0) {
        charge = await paymentsService.charge({
          customerId: principal.userId,
          counterpartyType: 'business',
          counterpartyId: input.businessId,
          amountCents: amountDueCents,
          discountAppliedCents: breakdown.discountCents,
          tipCents: tip,
          roundUpCents: roundUp,
          // The customer-facing fees inside the total, so a later refund knows which parts of the
          // charge come back on their own terms (spec §58 / refundPolicy.ts).
          serviceFeeCents: breakdown.serviceFeeCents,
          processingFeeCents: breakdown.processingFeeCents,
          idempotencyKey,
        });
      }
    } catch (err) {
      if (reservation?.redemptionId)
        await payforwardService.release(reservation.redemptionId, 'payment_failed');
      throw err;
    }

    const order = await repo.createOrder({
      customer_id: principal.userId,
      business_id: input.businessId,
      fulfillment_type: destination ? 'delivery' : scheduledFor ? 'pickup_scheduled' : 'pickup_now',
      scheduled_for: scheduledFor,
      destination: destination
        ? {
            line1: destination.line1,
            line2: destination.line2 ?? null,
            city: destination.city,
            region: destination.region ?? null,
            postal_code: destination.postalCode ?? null,
            location: { type: 'Point' as const, coordinates: [destination.lng, destination.lat] },
            notes: destination.notes ?? null,
            contact_phone: destination.contactPhone ?? null,
          }
        : null,
      items: lineItems,
      subtotal_cents: breakdown.subtotalCents,
      discount_percent: breakdown.discountPercent,
      discount_applied_cents: breakdown.discountCents,
      tax_cents: breakdown.taxCents,
      delivery_cents: breakdown.deliveryCents,
      service_fee_cents: breakdown.serviceFeeCents,
      processing_fee_cents: breakdown.processingFeeCents,
      tip_cents: tip,
      round_up_cents: roundUp,
      /**
       * The order's total is what the MEAL cost, not what the customer's card was charged. The
       * receipt then reads honestly — "$16.45, community fund −$16.45, you paid $0" — and refunds,
       * disputes, and impact figures all have the real sale value to work from.
       */
      total_cents: breakdown.totalCents,
      pay_it_forward_cents: payItForwardCents,
      transaction_id: charge?.transactionId ?? null,
    });

    // The payment has settled (or there was none to take), so the fund is genuinely spent now.
    if (reservation?.redemptionId) {
      await payforwardService.apply({
        redemptionId: reservation.redemptionId,
        orderId: String(order._id),
        customerId: principal.userId,
      });
    }

    notificationsService.notify(owner, {
      category: 'order',
      title: 'New order',
      body: `${lineItems.length} item(s) for pickup`,
      // `audience: 'vendor'` routes this to the vendor's order queue; customer order updates omit it.
      data: { orderId: String(order._id), audience: 'vendor' },
    });
    await publish('order.placed', {
      orderId: String(order._id),
      businessId: input.businessId,
      customerId: principal.userId,
    });
    return {
      ...this.view(order),
      payment: charge,
      /**
       * Reported even when it did not apply. A customer who asked for help and was charged in full
       * is owed the reason — silence here is the difference between "the fund was empty" and "you
       * were quietly charged $20 you were not expecting".
       */
      payItForward: { appliedCents: payItForwardCents, reason: payItForwardReason },
    };
  },

  async accept(principal: Principal, orderId: string) {
    const order = await repo.findById(orderId);
    if (!order) throw NotFoundError('Order not found');
    await assertBusinessOwner(principal, order.business_id);
    const updated = await repo.transition(orderId, 'pending', { status: 'accepted' });
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Order is not pending');
    this.notifyCustomer(order.customer_id, orderId, 'accepted', 'Your order was accepted');
    await publish('order.status_changed', { orderId, status: 'accepted' });
    return this.view(updated);
  },

  /** Mark ready — blocked while the business is Away/Closed (the away_closed interlock). */
  async ready(principal: Principal, orderId: string) {
    const order = await repo.findById(orderId);
    if (!order) throw NotFoundError('Order not found');
    await assertBusinessOwner(principal, order.business_id);
    const status = await livemapService.getActiveStatus('business', order.business_id);
    if (status === 'away_closed' || status === null) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_AWAY, 'Cannot mark ready while Away/Closed');
    }
    const updated = await repo.transition(orderId, 'accepted', {
      status: 'ready',
      ready_at: new Date(),
    });
    if (!updated)
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Order is not accepted');
    this.notifyCustomer(order.customer_id, orderId, 'ready', 'Your order is ready for pickup');
    await publish('order.status_changed', { orderId, status: 'ready' });
    return this.view(updated);
  },

  async complete(principal: Principal, orderId: string) {
    const order = await repo.findById(orderId);
    if (!order) throw NotFoundError('Order not found');
    await assertBusinessOwner(principal, order.business_id);
    const updated = await repo.transition(orderId, 'ready', { status: 'completed' });
    if (!updated) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Order is not ready');
    // Fulfilling the order finalizes the sale — settle its transaction so the customer can review
    // and the vendor's earnings reflect it, without depending on the payment webhook.
    if (order.transaction_id) await paymentsService.completeForOrder(order.transaction_id);

    /**
     * 7.3 — one stamp per COMPLETED order. Not per item (ten coffees on one receipt is one visit),
     * and not on payment (a stamp a cancellation could not reverse is a free-reward machine).
     * Fire-and-forget: handing over the food must not fail because a loyalty card did.
     */
    void loyaltyService.awardStampForOrder({
      businessId: order.business_id,
      userId: order.customer_id,
      orderId,
    });

    /**
     * 7.4 — a referral converts on the referred user's first COMPLETED order, not on signup.
     * Signing up is free, so rewarding it rewards account creation; requiring a real completed
     * order means farming the programme costs the farmer real money.
     */
    void referralsService.onOrderCompleted(order.customer_id, orderId);

    await publish('order.status_changed', { orderId, status: 'completed' });
    return this.view(updated);
  },

  async cancel(principal: Principal, orderId: string, reason?: string) {
    const order = await repo.findById(orderId);
    if (!order) throw NotFoundError('Order not found');
    const owner = await vendorsService.getBusinessOwner(order.business_id);
    const isCustomer = order.customer_id === principal.userId;
    const isOwner = owner === principal.userId;
    if (!isCustomer && !isOwner)
      throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);

    const updated = await repo.transition(orderId, ['pending', 'accepted'], {
      status: 'cancelled',
      cancelled_reason: reason ?? null,
    });
    if (!updated)
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Order cannot be cancelled');

    // Cancellation is pre-fulfillment (only pending/accepted reach here), so the full R13 policy
    // applies: the customer gets everything back and the platform fee is returned.
    let refund;
    if (order.transaction_id) {
      try {
        const r = await paymentsService.refund(order.transaction_id, principal.userId, {
          fulfilled: false,
        });
        refund = r.refund;
      } catch {
        // Not yet captured/settled — the pending PaymentIntent will not be completed; safe to ignore.
      }
    }

    /**
     * PIF-4 — and give the community its money back.
     *
     * Cancelling refunded the customer's card and stopped there, so the community's share of a
     * cancelled order evaporated: the pool had been debited, the contributions consumed and the
     * ledger posted, and then the meal never happened. On a fully covered order the customer's own
     * refund is $0, so nothing on any screen showed the loss at all — the pool just quietly got
     * smaller. Reversed here rather than inside the refund block above, because a fully covered
     * order has no `transaction_id` to refund and is exactly the case that loses the most.
     */
    if ((order.pay_it_forward_cents ?? 0) > 0) {
      await payforwardService.refundRedemptionForOrder(orderId);
    }

    const notifyUser = isCustomer ? owner : order.customer_id;
    if (notifyUser)
      this.notifyCustomer(notifyUser, orderId, 'cancelled', reason ?? 'Order cancelled');
    await publish('order.status_changed', { orderId, status: 'cancelled' });
    return { ...this.view(updated), refund };
  },

  /**
   * Read-only refund disclosure (R13/U6) for the cancel/refund confirmation UX — what the customer
   * gets back if they cancel now, computed from the order's state + transaction. No side effects.
   */
  async refundPreview(principal: Principal, orderId: string) {
    const order = await repo.findById(orderId);
    if (!order) throw NotFoundError('Order not found');
    const owner = await vendorsService.getBusinessOwner(order.business_id);
    const isParticipant = order.customer_id === principal.userId || owner === principal.userId;
    if (!isParticipant) throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);

    if (!order.transaction_id) {
      return {
        scenario: 'full_pre_fulfillment' as const,
        refundedCents: 0,
        goodsCents: 0,
        tipCents: 0,
        marketplaceFeeReturnedCents: 0,
        processingRetainedCents: 0,
        reverseTransfer: false,
        refundApplicationFee: false,
        disclosure: 'Nothing has been charged yet — cancelling costs you nothing.',
      };
    }
    return paymentsService.refundPreview(order.transaction_id, {
      fulfilled: order.status === 'completed',
    });
  },

  /**
   * Partial fulfilment: a line item is out of stock → remove it, refund its cost, recompute totals.
   * Never a silent substitution (Flow 2d error state). If nothing remains, the order is cancelled.
   */
  async removeLineItem(principal: Principal, orderId: string, menuItemId: string) {
    const order = await repo.findById(orderId);
    if (!order) throw NotFoundError('Order not found');
    await assertBusinessOwner(principal, order.business_id);
    if (!['pending', 'accepted'].includes(order.status)) {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Order cannot be adjusted');
    }
    const item = order.items.find((li) => li.menu_item_id === menuItemId);
    if (!item) throw NotFoundError('Line item not found on this order');

    const refundCents = (item.unit_price_cents ?? 0) * (item.quantity ?? 0);
    const remaining = order.items.filter((li) => li.menu_item_id !== menuItemId);

    if (order.transaction_id && refundCents > 0) {
      await paymentsService.refundAmount(order.transaction_id, refundCents, principal.userId);
    }

    if (remaining.length === 0) {
      const cancelled = await repo.update(orderId, {
        status: 'cancelled',
        cancelled_reason: 'out_of_stock',
      });
      this.notifyCustomer(
        order.customer_id,
        orderId,
        'cancelled',
        'Order cancelled — item out of stock',
      );
      return { ...this.view(cancelled!), refundedCents: refundCents };
    }

    const newSubtotal = remaining.reduce(
      (s, li) => s + (li.unit_price_cents ?? 0) * (li.quantity ?? 0),
      0,
    );
    // Re-itemize from the same pricing path so the adjusted order stays internally consistent.
    // The live rates must be passed: falling back to the MVP zeroes would wipe the service and
    // processing fees off an order that was actually charged them.
    const bd = computeOrderBreakdown({
      subtotalCents: newSubtotal,
      discountPercent: order.discount_percent ?? 0,
      tipCents: order.tip_cents ?? 0,
      roundUpCents: order.round_up_cents ?? 0,
      rates: await feeService.resolveOrderFeeRates(),
    });
    const updated = await repo.update(orderId, {
      items: remaining,
      subtotal_cents: bd.subtotalCents,
      discount_applied_cents: bd.discountCents,
      tax_cents: bd.taxCents,
      delivery_cents: bd.deliveryCents,
      service_fee_cents: bd.serviceFeeCents,
      processing_fee_cents: bd.processingFeeCents,
      total_cents: bd.totalCents,
    });
    this.notifyCustomer(
      order.customer_id,
      orderId,
      'adjusted',
      `${item.name ?? 'An item'} was removed and refunded`,
    );
    await writeAudit({
      actorId: principal.userId,
      action: 'order.partial_fulfil',
      entityType: 'order',
      entityId: orderId,
      metadata: { removed: menuItemId, refundCents },
    });
    return { ...this.view(updated!), refundedCents: refundCents };
  },

  async listMine(customerId: string, limit: number) {
    const orders = await repo.listForCustomer(customerId, limit);
    // The customer's order history + tracker show which business each order is with — resolve names
    // in one read (the order document only carries a business id).
    const bizIds = [...new Set(orders.map((o) => o.business_id))];
    const bizzes = await BusinessModel.find({ _id: { $in: bizIds } }, { name: 1 })
      .lean()
      .exec();
    const nameById = new Map(bizzes.map((b) => [String(b._id), b.name]));
    return orders.map((o) => ({
      ...this.view(o),
      businessName: nameById.get(o.business_id) ?? 'Business',
    }));
  },

  /** Orders placed with this business since `from`, excluding cancelled ones (V-11 analytics). */
  async countSince(businessId: string, from: Date): Promise<number> {
    return OrderModel.countDocuments({
      business_id: businessId,
      created_at: { $gte: from },
      status: { $ne: 'cancelled' },
    }).exec();
  },

  async listForBusiness(
    principal: Principal,
    businessId: string,
    statuses: string[] | null,
    limit: number,
  ) {
    await assertBusinessOwner(principal, businessId);
    const orders = await repo.listForBusiness(businessId, statuses, limit);
    // The vendor's board shows who each ticket is for — resolve names in one read, not per order.
    const ids = [...new Set(orders.map((o) => o.customer_id))];
    const users = await UserModel.find({ _id: { $in: ids } }, { display_name: 1 })
      .lean()
      .exec();
    const nameById = new Map(users.map((u) => [String(u._id), u.display_name]));
    return orders.map((o) => ({
      ...this.view(o),
      customerName: nameById.get(o.customer_id) || 'A customer',
    }));
  },

  notifyCustomer(userId: string, orderId: string, status: string, body: string) {
    notificationsService.notify(userId, {
      category: 'order',
      title: 'Order update',
      body,
      data: { orderId, status },
    });
  },

  view(o: {
    _id: unknown;
    customer_id: string;
    business_id: string;
    status: string;
    items: {
      menu_item_id?: string | null;
      name?: string | null;
      quantity?: number | null;
      unit_price_cents?: number | null;
    }[];
    subtotal_cents: number;
    discount_percent?: number | null;
    discount_applied_cents?: number | null;
    tax_cents?: number | null;
    delivery_cents?: number | null;
    service_fee_cents?: number | null;
    processing_fee_cents?: number | null;
    tip_cents?: number | null;
    round_up_cents?: number | null;
    total_cents: number;
    transaction_id?: string | null;
    fulfillment_type?: string | null;
    created_at?: Date;
  }) {
    // Full server-authoritative breakdown (R9) — the receipt/preview render these values directly.
    const breakdown: OrderBreakdown = {
      subtotalCents: o.subtotal_cents,
      discountPercent: o.discount_percent ?? 0,
      discountCents: o.discount_applied_cents ?? 0,
      taxCents: o.tax_cents ?? 0,
      deliveryCents: o.delivery_cents ?? 0,
      serviceFeeCents: o.service_fee_cents ?? 0,
      processingFeeCents: o.processing_fee_cents ?? 0,
      tipCents: o.tip_cents ?? 0,
      roundUpCents: o.round_up_cents ?? 0,
      totalCents: o.total_cents,
      platformFeeCents: 0, // informational; not persisted, not customer-charged
    };
    return {
      id: String(o._id),
      customerId: o.customer_id,
      businessId: o.business_id,
      status: o.status,
      items: o.items.map((li) => ({
        menuItemId: li.menu_item_id,
        name: li.name,
        quantity: li.quantity,
        unitPriceCents: li.unit_price_cents,
      })),
      subtotalCents: o.subtotal_cents,
      tipCents: o.tip_cents ?? 0,
      totalCents: o.total_cents,
      breakdown,
      transactionId: o.transaction_id ?? null,
      /**
       * Exposed so a client can tell a collection from a delivery.
       *
       * Without it the vendor board offered "Need delivery? Ask driver" on every ticket, including
       * `pickup_now` orders that delivery.service.ts refuses outright with "This order is not a
       * delivery". The UI cannot avoid offering an impossible action if the read model never says
       * which kind of order it is.
       */
      fulfillmentType: o.fulfillment_type ?? 'pickup_now',
      createdAt: o.created_at ?? null,
    };
  },
};
