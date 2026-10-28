import { Types } from 'mongoose';

import {
  PAY_FORWARD_DEFAULT_EXPIRY_DAYS,
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
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsService } from '../payments/payments.service';
import { MenuItemModel } from '../vendors/vendors.model';
import {
  CommunityFundModel,
  CommunityItemContributionModel,
  CommunityRedemptionModel,
} from './payforward.model';

/**
 * ═══ PAY IT FORWARD — SPECIFIC-ITEM CONTRIBUTIONS ("suspended coffee"). ═══
 *
 * The parallel path to the pool. A contributor pre-buys a specific menu item; the business
 * queue holds it until the next eligible redeemer picks it off and spends it on their order.
 *
 * This file owns the lifecycle:
 *
 *   contribute()  → `pending` row + Stripe payment intent on the platform balance.
 *   onFunded()    → webhook claims the intent, flips to `funded`.
 *   listClaimable() → public read of what's currently claimable at a business.
 *   reserve()     → redeemer picks one; row flips to `reserved`, scoped to one order.
 *   commitClaim() → called after the order's payment succeeds. Terminal.
 *   releaseClaim()→ called if the order fails. Row flips back to `funded`.
 *   refundByGiver() → change-of-mind within the stated window; refunds the giver's card.
 *   expireAbandoned() → sweep; refunds the giver on expiry.
 *
 * Shares vendor settings with the pool (`CommunityFund`): the business must have
 * `accepting_items: true` to receive new contributions, and `max_items_waiting` caps the
 * queue depth. Redemption inherits the pool's per-customer-per-day cap via
 * `CommunityRedemption` — one claim per customer per business per day across BOTH paths, so
 * the item path can't be used to drain the whole queue.
 */

const REFUND_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h giver change-of-mind window
const DEFAULT_EXPIRY_MS = PAY_FORWARD_DEFAULT_EXPIRY_DAYS * 86_400_000;

function dayKeyFor(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export const payforwardItemsService = {
  /**
   * Pre-buy a specific menu item. Mirrors the pool contribution pattern: `pending` row + a
   * platform charge, flipped to `funded` by the Stripe webhook. The amount charged is
   * `menu_item.price_cents` RE-RESOLVED on the server — a client that could name its own
   * price could suspend a $20 coffee for a cent.
   */
  async contribute(
    principal: Principal,
    dto: {
      businessId: string;
      menuItemId: string;
      anonymous?: boolean;
      displayName?: string;
      note?: string;
    },
    idempotencyKey: string,
  ) {
    /**
     * Fund must exist and be accepting items. We write the fund row lazily (first contribution
     * of EITHER kind) so a business that hasn't configured PIF still works out of the box with
     * sensible defaults.
     */
    const fund = await CommunityFundModel.findOneAndUpdate(
      { business_id: dto.businessId },
      { $setOnInsert: { business_id: dto.businessId } },
      { upsert: true, new: true },
    ).exec();

    if (!fund.accepting_items) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This business is not accepting item contributions right now.',
      );
    }

    /**
     * Queue depth check. Count funded + reserved items (reserved money is still committed) —
     * a cap applies BEFORE the charge opens so a contributor doesn't pay for a slot they
     * can't take.
     */
    if (fund.max_items_waiting != null) {
      const inQueue = await CommunityItemContributionModel.countDocuments({
        business_id: dto.businessId,
        status: { $in: ['funded', 'reserved'] },
      }).exec();
      if (inQueue >= fund.max_items_waiting) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'This business has reached its waiting-items cap. Try again later or contribute to the pool instead.',
        );
      }
    }

    /** Re-resolve the price server-side. Client's price is a hint, never the source of truth. */
    const menuItem = await MenuItemModel.findOne({
      _id: dto.menuItemId,
      business_id: dto.businessId,
      is_available: true,
    })
      .lean()
      .exec();
    if (!menuItem) {
      throw NotFoundError('That menu item is not available at this business.');
    }
    const amountCents = menuItem.price_cents;

    const expiresAt = new Date(Date.now() + (fund.expiry_days ?? PAY_FORWARD_DEFAULT_EXPIRY_DAYS) * 86_400_000);
    const row = await CommunityItemContributionModel.create({
      business_id: dto.businessId,
      menu_item_id: dto.menuItemId,
      menu_item_name_at_purchase: menuItem.name,
      price_cents_at_purchase: amountCents,
      contributor_id: principal.userId,
      anonymous: dto.anonymous !== false, // default true, matches pool
      display_name: dto.anonymous === false ? dto.displayName ?? null : null,
      note: dto.note ?? null,
      status: 'pending',
      stripe_payment_intent_id: `pending_${idempotencyKey}`, // placeholder; replaced below
      expires_at: expiresAt,
    });

    /**
     * Custodial platform charge, same rail as the pool. Metadata links back to the row so the
     * webhook can locate it on `payment_intent.succeeded`.
     */
    const charge = await paymentsService.chargeToPlatform({
      amountCents,
      transferGroup: `pif_item_${String(row._id)}`,
      metadata: {
        kind: 'pif_item_contribution',
        itemContributionId: String(row._id),
        businessId: dto.businessId,
        menuItemId: dto.menuItemId,
      },
      idempotencyKey: `pif_item_${idempotencyKey}`,
    });
    await CommunityItemContributionModel.updateOne(
      { _id: row._id },
      { $set: { stripe_payment_intent_id: charge.paymentIntentId } },
    ).exec();

    return {
      id: String(row._id),
      businessId: dto.businessId,
      menuItemId: dto.menuItemId,
      menuItemName: menuItem.name,
      amountCents,
      clientSecret: charge.clientSecret,
      status: 'pending' as const,
    };
  },

  /**
   * Webhook — the money arrived. Flip `pending` → `funded`. Idempotent on the payment intent
   * id so a duplicate delivery is a no-op.
   */
  async onPaymentSucceeded(paymentIntentId: string): Promise<{ handled: boolean }> {
    const row = await CommunityItemContributionModel.findOneAndUpdate(
      { stripe_payment_intent_id: paymentIntentId, status: 'pending' },
      { $set: { status: 'funded', funded_at: new Date() } },
      { new: true },
    ).exec();
    if (!row) return { handled: false };

    await writeAudit({
      action: 'pif_item.funded',
      entityType: 'community_item_contribution',
      entityId: String(row._id),
      metadata: {
        businessId: row.business_id,
        menuItemId: row.menu_item_id,
        amountCents: row.price_cents_at_purchase,
      },
    });

    /**
     * Thank-you ping to the contributor. Best-effort — a notification failure does not
     * roll the funded status back.
     */
    try {
      notificationsService.notify(row.contributor_id, {
        category: 'system',
        title: 'Thanks for paying it forward',
        body: `Your ${row.menu_item_name_at_purchase} is waiting for the next customer at the business you chose.`,
        data: { itemContributionId: String(row._id) },
      });
    } catch (err) {
      logger.error({ err, rowId: String(row._id) }, 'pif_item funded notification failed');
    }
    return { handled: true };
  },

  /** Webhook — the charge failed. The pending row flips to `refunded` with a zero refund (no money moved). */
  async onPaymentFailed(paymentIntentId: string, reason: string) {
    const row = await CommunityItemContributionModel.findOneAndUpdate(
      { stripe_payment_intent_id: paymentIntentId, status: 'pending' },
      { $set: { status: 'refunded', refunded_at: new Date(), note: reason } },
    ).exec();
    if (!row) return { handled: false };
    return { handled: true };
  },

  /**
   * Public read: what items are currently claimable at this business, oldest-first (FIFO).
   * Returns only data a prospective redeemer needs — no PII beyond the giver's chosen display
   * name, and only when the contributor explicitly opted in to being named.
   */
  async listClaimable(businessId: string, limit = 50) {
    const rows = await CommunityItemContributionModel.find({
      business_id: businessId,
      status: 'funded',
      expires_at: { $gt: new Date() },
    })
      .sort({ funded_at: 1 })
      .limit(limit)
      .lean()
      .exec();
    return rows.map((r) => ({
      id: String(r._id),
      menuItemId: r.menu_item_id,
      menuItemName: r.menu_item_name_at_purchase,
      priceCents: r.price_cents_at_purchase,
      note: r.note ?? null,
      displayName: r.anonymous ? null : r.display_name,
      fundedAt: r.funded_at,
      expiresAt: r.expires_at,
    }));
  },

  /**
   * Reserve one funded item for an order. Mirrors the pool's reserve: picks the oldest
   * matching row that is still `funded`, flips it to `reserved` atomically via
   * `findOneAndUpdate`. The caller passes the orderId once the order exists so a release
   * can refer back.
   *
   * Enforces the per-customer-per-day cap by writing a `CommunityRedemption` row of status
   * `reserved` tied to this item, so the same user can't claim both the pool AND an item on
   * the same day. The redemption row acts as the shared slot — one row per (user, business,
   * day) across both PIF paths.
   */
  async reserve(
    principal: Principal,
    input: { businessId: string; menuItemId: string; orderId: string; userTier?: string },
  ) {
    const tier = (input.userTier ?? 'none').toLowerCase();
    const minTier = PAY_FORWARD_REDEEM_MIN_TIER.toLowerCase();
    if ((TIER_RANK[tier as keyof typeof TIER_RANK] ?? 0) < (TIER_RANK[minTier as keyof typeof TIER_RANK] ?? 0)) {
      throw ForbiddenError(
        'Pay It Forward is available to verified customers only.',
        ERROR_CODES.BUSINESS_RULE,
      );
    }

    /**
     * The per-day shared slot (one claim per customer per business per day, across both paths).
     * We write it FIRST — the unique index refuses a second row for the same (user, business,
     * day), which means a user who already redeemed pool money today can't also claim an item.
     */
    const dayKey = dayKeyFor();
    let redemption;
    try {
      redemption = await CommunityRedemptionModel.create({
        business_id: input.businessId,
        user_id: principal.userId,
        order_id: input.orderId,
        amount_cents: 0, // the item's own price_cents_at_purchase is the authority
        fee_cents: 0,
        day_key: dayKey,
        status: 'reserved',
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          'You have already claimed a Pay It Forward item or credit at this business today.',
        );
      }
      throw err;
    }

    /** Reserve the oldest matching funded row. */
    const now = new Date();
    const row = await CommunityItemContributionModel.findOneAndUpdate(
      {
        business_id: input.businessId,
        menu_item_id: input.menuItemId,
        status: 'funded',
        expires_at: { $gt: now },
      },
      {
        $set: {
          status: 'reserved',
          reserved_by_user_id: principal.userId,
          reserved_order_id: input.orderId,
          reserved_at: now,
        },
      },
      { sort: { funded_at: 1 }, new: true },
    ).exec();

    if (!row) {
      /** No funded item matched — roll back the redemption slot so the user isn't locked out
       *  of pool redemption today for an item that didn't exist. */
      await CommunityRedemptionModel.updateOne(
        { _id: redemption._id },
        { $set: { status: 'released', released_reason: 'no_item_available' } },
      ).exec();
      throw NotFoundError('No pay-it-forward item of that kind is currently available.');
    }

    return {
      reservationId: String(redemption._id),
      itemContributionId: String(row._id),
      coverCents: row.price_cents_at_purchase,
      itemName: row.menu_item_name_at_purchase,
    };
  },

  /**
   * The reserved order's payment went through. Terminal: `reserved` → `claimed`. The matching
   * `CommunityRedemption` row flips to `applied` for day-cap accounting.
   */
  async commitClaim(reservationId: string, itemContributionId: string) {
    const now = new Date();
    const row = await CommunityItemContributionModel.findOneAndUpdate(
      { _id: new Types.ObjectId(itemContributionId), status: 'reserved' },
      { $set: { status: 'claimed', claimed_at: now } },
      { new: true },
    ).exec();
    if (!row) {
      /** Not the row we expected — webhook arrival order anomaly. Log + no-op. */
      logger.warn(
        { itemContributionId },
        'pif_item commitClaim: row not in reserved state (possible duplicate webhook)',
      );
      return { ok: false };
    }
    await CommunityItemContributionModel.updateOne(
      { _id: row._id },
      {
        $set: {
          claimed_by_user_id: row.reserved_by_user_id,
          claimed_order_id: row.reserved_order_id,
        },
      },
    ).exec();
    await CommunityRedemptionModel.updateOne(
      { _id: new Types.ObjectId(reservationId) },
      { $set: { status: 'applied', applied_at: now } },
    ).exec();
    return { ok: true };
  },

  /**
   * The reserved order failed. `reserved` → `funded` so the item re-enters the queue; the
   * `CommunityRedemption` row flips to `released` so the redeemer isn't locked out for the
   * day (same semantics as the pool's reserve-release).
   */
  async releaseClaim(reservationId: string, itemContributionId: string, reason: string) {
    await CommunityItemContributionModel.updateOne(
      { _id: new Types.ObjectId(itemContributionId), status: 'reserved' },
      {
        $set: {
          status: 'funded',
          reserved_by_user_id: null,
          reserved_order_id: null,
          reserved_at: null,
        },
      },
    ).exec();
    await CommunityRedemptionModel.updateOne(
      { _id: new Types.ObjectId(reservationId) },
      { $set: { status: 'released', released_reason: reason } },
    ).exec();
    return { released: true };
  },

  /**
   * Order cancelled AFTER the item was already committed (claimed). The item goes back to the
   * queue so another customer can claim it — the giver's intent was "whoever's next", not
   * "specifically this one person", so a cancellation shouldn't refund them. The shared
   * redemption row flips to `released` so the user's day-slot is freed (matches the pool's
   * cancellation semantics).
   */
  async uncommitForCancellation(reservationId: string, itemContributionId: string, reason: string) {
    await CommunityItemContributionModel.updateOne(
      { _id: new Types.ObjectId(itemContributionId), status: 'claimed' },
      {
        $set: {
          status: 'funded',
          claimed_by_user_id: null,
          claimed_order_id: null,
          claimed_at: null,
          reserved_by_user_id: null,
          reserved_order_id: null,
          reserved_at: null,
        },
      },
    ).exec();
    await CommunityRedemptionModel.updateOne(
      { _id: new Types.ObjectId(reservationId) },
      { $set: { status: 'released', released_reason: reason } },
    ).exec();
    return { restored: true };
  },

  /**
   * Giver change-of-mind within the stated window. Only the contributor themselves may invoke
   * it, only on a `funded` row (reserved money has started being spent on somebody's actual
   * meal), and only before the window closes. Refunds the full amount; terminal.
   */
  async refundByGiver(principal: Principal, itemContributionId: string) {
    const row = await CommunityItemContributionModel.findById(itemContributionId).exec();
    if (!row) throw NotFoundError('Item contribution not found');
    if (row.contributor_id !== principal.userId) {
      throw ForbiddenError('You can only refund your own contributions', ERROR_CODES.NOT_OWNER);
    }
    if (row.status !== 'funded') {
      throw BusinessRuleError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        row.status === 'reserved' || row.status === 'claimed'
          ? 'This item is in the middle of being claimed — too late to refund.'
          : `This contribution is ${row.status}.`,
      );
    }
    const fundedAt = row.funded_at ?? row.created_at ?? new Date();
    if (fundedAt.getTime() + REFUND_WINDOW_MS < Date.now()) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'The 24-hour change-of-mind window has passed.',
      );
    }
    try {
      const refund = await stripe().createRefund({
        paymentIntentId: row.stripe_payment_intent_id,
        amountCents: row.price_cents_at_purchase,
        idempotencyKey: `pif_item_refund_${String(row._id)}`,
      });
      row.status = 'refunded';
      row.refunded_at = new Date();
      row.refunded_cents = row.price_cents_at_purchase;
      row.stripe_refund_id = refund.refundId;
      await row.save();
      return { id: String(row._id), refunded: true, refundId: refund.refundId };
    } catch (err) {
      logger.error({ err, rowId: String(row._id) }, 'pif_item refund failed');
      throw err;
    }
  },

  /**
   * Sweep: expire funded items whose `expires_at` has passed. Refunds the giver per expiry
   * contract (an item nobody claimed is not kept by the vendor; the money goes back). Idempotent
   * batches via the per-row conditional update.
   */
  async expireAbandoned(limit = 50): Promise<{ expired: number }> {
    const now = new Date();
    const due = await CommunityItemContributionModel.find({
      status: 'funded',
      expires_at: { $lte: now },
    })
      .limit(limit)
      .exec();
    let expired = 0;
    for (const row of due) {
      try {
        if (row.stripe_payment_intent_id) {
          const refund = await stripe().createRefund({
            paymentIntentId: row.stripe_payment_intent_id,
            amountCents: row.price_cents_at_purchase,
            idempotencyKey: `pif_item_expire_${String(row._id)}`,
          });
          row.stripe_refund_id = refund.refundId;
          row.refunded_cents = row.price_cents_at_purchase;
        }
        row.status = 'expired';
        row.expired_at = now;
        row.refunded_at = now;
        await row.save();
        try {
          notificationsService.notify(row.contributor_id, {
            category: 'system',
            title: 'Your Pay It Forward item was refunded',
            body: `Your ${row.menu_item_name_at_purchase} wasn't claimed in time, so we've refunded ${
              /* `shared/money` would also format cents; a plain string is fine for an inbox line */ ''
            }your card.`,
            data: { itemContributionId: String(row._id) },
          });
        } catch (err) {
          logger.error({ err, rowId: String(row._id) }, 'pif_item expiry notification failed');
        }
        expired += 1;
      } catch (err) {
        logger.error({ err, rowId: String(row._id) }, 'pif_item expiry refund failed');
      }
    }
    return { expired };
  },
};
