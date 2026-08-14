import { Schema, type InferSchemaType } from 'mongoose';

import {
  WAIVER_COVER_CAP_CENTS,
  WAIVER_DAMAGED_RATE,
  WAIVER_PERIOD_CAP_CENTS,
  WAIVER_PERIOD_DAYS,
  WAIVER_WAITING_PERIOD_HOURS,
} from '../../config/constants';
import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { defineModel } from '../../shared/defineModel';
import { formatCents } from '../../shared/money';
import { notificationsService } from '../notifications/notifications.service';
import { subscriptionsRepository } from './subscriptions.repository';

/**
 * A single exercise of the waiver — one incident where the platform declined to collect a debt it
 * would otherwise have been owed.
 *
 * Kept as its own ledger rather than inferred from debts, because the interesting question is the
 * one a debt row cannot answer: *what did we choose not to charge?* That number is the product's
 * cost of goods, and it is what tells us whether the price is right.
 */
const WaiverUseSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    checkout_id: { type: String, required: true, unique: true },
    /** What the seller would have owed without the waiver. */
    liability_cents: { type: Number, required: true },
    /** What we actually waived — capped, so this can be less than the liability. */
    waived_cents: { type: Number, required: true },
    /** Any remainder above the cap, which the seller still owes. */
    remaining_cents: { type: Number, default: 0 },
    kind: { type: String, enum: ['lost_inventory', 'damaged_inventory'], required: true },
    occurred_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'waiver_uses' },
);
WaiverUseSchema.index({ user_id: 1, occurred_at: -1 });

export type WaiverUseDoc = InferSchemaType<typeof WaiverUseSchema>;
export const WaiverUseModel = defineModel('WaiverUse', WaiverUseSchema);

export interface WaiverStatus {
  active: boolean;
  /** Present but not yet effective — see `WAIVER_WAITING_PERIOD_HOURS`. */
  waiting: boolean;
  activeFrom: Date | null;
  perIncidentCapCents: number;
  periodCapCents: number;
  periodDays: number;
  usedThisPeriodCents: number;
  remainingThisPeriodCents: number;
  reason: string | null;
}

/**
 * ═══ F-4 — STOCK PROTECTION ═══
 *
 * ⚠ This is a CONTRACTUAL WAIVER, not insurance. See the `WAIVER_*` block in `constants.ts` for the
 * full reasoning; the short version is that we are declining to collect a debt WE are owed, not
 * indemnifying anyone against third-party risk. Nothing here may pay money to a seller, and no
 * user-facing string here may say "insurance", "policy", "premium" or "claim".
 */
export const waiverService = {
  /**
   * Whether a seller's waiver would apply right now, and how much headroom is left.
   *
   * Also the read behind the seller-facing screen — so what they're shown and what the liability
   * path enforces are the same computation, and a seller can never be told they're covered by a
   * screen that disagrees with the code.
   */
  async status(userId: string): Promise<WaiverStatus> {
    const base: WaiverStatus = {
      active: false,
      waiting: false,
      activeFrom: null,
      perIncidentCapCents: WAIVER_COVER_CAP_CENTS,
      periodCapCents: WAIVER_PERIOD_CAP_CENTS,
      periodDays: WAIVER_PERIOD_DAYS,
      usedThisPeriodCents: 0,
      remainingThisPeriodCents: 0,
      reason: null,
    };

    const sub = await subscriptionsRepository.find(userId, 'stock_waiver');
    if (!sub || sub.status !== 'active') {
      return { ...base, reason: 'No Stock Protection on this account.' };
    }

    /**
     * The waiting period is what stops this becoming a way to convert an existing debt into $2.99.
     * Without it, someone loses stock on Monday, subscribes on Tuesday, and the platform absorbs a
     * loss it was never paid to take — adverse selection in its purest form.
     */
    const startedAt = sub.activated_at ?? sub.created_at ?? new Date();
    const activeFrom = new Date(startedAt.getTime() + WAIVER_WAITING_PERIOD_HOURS * 3_600_000);
    if (activeFrom.getTime() > Date.now()) {
      return {
        ...base,
        waiting: true,
        activeFrom,
        reason: `Cover starts ${activeFrom.toISOString().slice(0, 10)} — there's a short waiting period on new cover.`,
      };
    }

    const since = new Date(Date.now() - WAIVER_PERIOD_DAYS * 86_400_000);
    const used = await WaiverUseModel.aggregate<{ _id: null; total: number }>([
      { $match: { user_id: userId, occurred_at: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$waived_cents' } } },
    ]).exec();
    const usedCents = used[0]?.total ?? 0;
    const remaining = Math.max(0, WAIVER_PERIOD_CAP_CENTS - usedCents);

    return {
      ...base,
      active: remaining > 0,
      activeFrom,
      usedThisPeriodCents: usedCents,
      remainingThisPeriodCents: remaining,
      reason:
        remaining > 0
          ? null
          : `You've used your ${formatCents(WAIVER_PERIOD_CAP_CENTS)} of cover for this ${WAIVER_PERIOD_DAYS}-day period.`,
    };
  },

  /**
   * Apply the waiver to a loss/damage liability.
   *
   * Returns what the seller still owes after the waiver — so the caller charges that instead of the
   * full amount. Returns the full liability unchanged when no waiver applies, which means the
   * calling code is identical whether or not the product exists.
   *
   * The hub is NOT affected: it is still made whole from platform funds. That is precisely the cost
   * of this product, and why the caps are low.
   */
  async applyTo(input: {
    userId: string;
    checkoutId: string;
    liabilityCents: number;
    kind: 'lost_inventory' | 'damaged_inventory';
  }): Promise<{ waivedCents: number; remainingCents: number }> {
    const none = { waivedCents: 0, remainingCents: input.liabilityCents };
    if (input.liabilityCents <= 0) return none;

    const status = await this.status(input.userId);
    if (!status.active) return none;

    // Damaged goods retain value, so the waiver covers the same proportion the liability charges.
    const eligible =
      input.kind === 'damaged_inventory'
        ? Math.round(input.liabilityCents * WAIVER_DAMAGED_RATE)
        : input.liabilityCents;

    const waived = Math.min(
      eligible,
      WAIVER_COVER_CAP_CENTS,
      status.remainingThisPeriodCents,
    );
    if (waived <= 0) return none;

    const remaining = Math.max(0, input.liabilityCents - waived);

    try {
      await WaiverUseModel.create({
        user_id: input.userId,
        checkout_id: input.checkoutId,
        liability_cents: input.liabilityCents,
        waived_cents: waived,
        remaining_cents: remaining,
        kind: input.kind,
      });
    } catch (err) {
      // Unique on checkout_id — a retry must not waive twice. Treat a duplicate as already applied.
      if ((err as { code?: number }).code === 11000) return none;
      throw err;
    }

    await writeAudit({
      actorId: input.userId,
      action: 'waiver.applied',
      entityType: 'checkout',
      entityId: input.checkoutId,
      metadata: { liabilityCents: input.liabilityCents, waivedCents: waived, kind: input.kind },
    });
    await publish('waiver.applied', {
      userId: input.userId,
      checkoutId: input.checkoutId,
      waivedCents: waived,
    });

    notificationsService.notify(input.userId, {
      category: 'payments',
      title: `${formatCents(waived)} written off`,
      body:
        remaining > 0
          ? `Your Stock Protection covered ${formatCents(waived)} of this. ${formatCents(remaining)} is above your cover limit and still comes out of your next sale.`
          : 'Your Stock Protection covered this in full — you owe nothing for it.',
      data: { checkoutId: input.checkoutId, waivedCents: waived, remainingCents: remaining },
    });

    logger.info(
      { userId: input.userId, checkoutId: input.checkoutId, waived, remaining },
      'stock protection waiver applied',
    );
    return { waivedCents: waived, remainingCents: remaining };
  },

  /** The seller's own history of write-offs — their record, readable by them. */
  async history(userId: string) {
    const rows = await WaiverUseModel.find({ user_id: userId })
      .sort({ occurred_at: -1 })
      .limit(50)
      .lean()
      .exec();
    return rows.map((r) => ({
      id: String(r._id),
      checkoutId: r.checkout_id,
      liabilityCents: r.liability_cents,
      waivedCents: r.waived_cents,
      remainingCents: r.remaining_cents,
      kind: r.kind,
      occurredAt: r.occurred_at,
    }));
  },
};
