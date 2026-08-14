import { Schema, type InferSchemaType } from 'mongoose';

import { logger } from '../../config/logger';
import { defineModel } from '../../shared/defineModel';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { vendorsService } from '../vendors/vendors.service';

/**
 * 7.3 / M-17 — loyalty stamps.
 *
 * The paper punch card, kept deliberately close to the paper version: **buy N, get a reward**. Not
 * points, not tiers, not a currency.
 *
 * ## Why stamps and not points
 *
 * A points system needs an exchange rate, and an exchange rate is a liability the vendor carries on
 * a balance sheet they do not keep. Worse, it invites the question "what is a point worth?", which
 * has no honest answer that survives a price change. A stamp card says one thing — nine coffees,
 * the tenth is free — and both parties can hold the whole rule in their head.
 *
 * ## The three rules, and why each is enforced server-side
 *
 * 1. **One stamp per order, not per item.** Ten coffees on one receipt is one visit. Stamping per
 *    item turns a catering order into a free month and makes the card meaningless for the customer
 *    it was meant for.
 * 2. **Stamps come from COMPLETED orders only.** A stamp on payment would be reversible by
 *    cancelling, which is a free-reward machine.
 * 3. **A reward is redeemed once.** The redemption is an immutable row, and the stamps that earned
 *    it are consumed — a card cannot be spent twice by two devices racing.
 *
 * ## What this deliberately does not do
 *
 * It does not discount anything automatically. A reward is a token the vendor honours at the
 * counter, and the vendor marks it used. Wiring it into checkout pricing would put the platform in
 * the position of deciding what a free item is worth, which is the points problem wearing a
 * different hat.
 */

/** A vendor's card configuration. `null` for a business that has not set one up. */
const LoyaltyProgramSchema = new Schema(
  {
    business_id: { type: String, required: true, unique: true },
    /** Stamps needed for one reward. Bounded: a 2-stamp card is a discount, a 100-stamp card is a lie. */
    stamps_required: { type: Number, required: true, min: 3, max: 20 },
    /** What the customer gets, in the vendor's own words. Shown verbatim on the card. */
    reward_description: { type: String, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'loyalty_programs' },
);
export type LoyaltyProgramDoc = InferSchemaType<typeof LoyaltyProgramSchema>;
export const LoyaltyProgramModel = defineModel('LoyaltyProgram', LoyaltyProgramSchema);

/** One customer's card at one business. */
const LoyaltyCardSchema = new Schema(
  {
    business_id: { type: String, required: true },
    user_id: { type: String, required: true },
    /** Stamps not yet spent on a reward. */
    stamps: { type: Number, default: 0, min: 0 },
    /** Lifetime, for the vendor's own read on repeat custom. Never decremented. */
    lifetime_stamps: { type: Number, default: 0 },
    last_stamped_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'loyalty_cards' },
);
LoyaltyCardSchema.index({ business_id: 1, user_id: 1 }, { unique: true });
export type LoyaltyCardDoc = InferSchemaType<typeof LoyaltyCardSchema>;
export const LoyaltyCardModel = defineModel('LoyaltyCard', LoyaltyCardSchema);

/**
 * An earned reward. Immutable: this is the record the customer shows and the vendor honours, and
 * an editable one is worth nothing to either of them.
 */
const LoyaltyRewardSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true, index: true },
    reward_description: { type: String, required: true },
    stamps_spent: { type: Number, required: true },
    /** Short code the customer reads out. Not a secret — the vendor confirms who is standing there. */
    code: { type: String, required: true, unique: true },
    redeemed_at: { type: Date, default: null },
    redeemed_by: { type: String, default: null },
    /** The order that completed the card, so a dispute can be traced back. */
    earned_from_order_id: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'loyalty_rewards' },
);
LoyaltyRewardSchema.index({ user_id: 1, redeemed_at: 1 });
// Not immutable as a whole — redemption mutates it — but the earning facts never change, and the
// unique code prevents a second reward being minted for the same card.
export type LoyaltyRewardDoc = InferSchemaType<typeof LoyaltyRewardSchema>;
export const LoyaltyRewardModel = defineModel('LoyaltyReward', LoyaltyRewardSchema);

function rewardCode(): string {
  // Human-readable at a counter: no ambiguous characters, spoken in two chunks.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function assertOwner(principal: Principal, businessId: string): Promise<void> {
  const owner = await vendorsService.getBusinessOwner(businessId);
  if (!owner) throw NotFoundError('Business not found');
  if (owner !== principal.userId) {
    throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
  }
}

export const loyaltyService = {
  /** Vendor: create or update the card. */
  async setProgram(
    principal: Principal,
    businessId: string,
    input: { stampsRequired: number; rewardDescription: string; active?: boolean },
  ) {
    await assertOwner(principal, businessId);
    const program = await LoyaltyProgramModel.findOneAndUpdate(
      { business_id: businessId },
      {
        $set: {
          stamps_required: input.stampsRequired,
          reward_description: input.rewardDescription,
          active: input.active ?? true,
        },
      },
      { upsert: true, new: true },
    ).exec();

    await writeAudit({
      actorId: principal.userId,
      action: 'loyalty.program_set',
      entityType: 'business',
      entityId: businessId,
      metadata: { stampsRequired: input.stampsRequired, active: program.active },
    });
    return {
      businessId,
      stampsRequired: program.stamps_required,
      rewardDescription: program.reward_description,
      active: program.active,
    };
  },

  async getProgram(businessId: string) {
    const program = await LoyaltyProgramModel.findOne({ business_id: businessId }).lean();
    if (!program) return null;
    return {
      businessId,
      stampsRequired: program.stamps_required,
      rewardDescription: program.reward_description,
      active: program.active,
    };
  },

  /**
   * Award one stamp for a completed order.
   *
   * **One stamp per order, not per item** — ten coffees on one receipt is one visit. Called from
   * order completion, never from payment: a stamp that a cancellation could not reverse would be a
   * free-reward machine.
   *
   * Never throws. A vendor handing over food must not see an error because a loyalty card failed.
   */
  async awardStampForOrder(input: {
    businessId: string;
    userId: string;
    orderId: string;
  }): Promise<{ stamped: boolean; rewardEarned: boolean }> {
    try {
      const program = await LoyaltyProgramModel.findOne({
        business_id: input.businessId,
        active: true,
      }).lean();
      if (!program) return { stamped: false, rewardEarned: false };

      const card = await LoyaltyCardModel.findOneAndUpdate(
        { business_id: input.businessId, user_id: input.userId },
        { $inc: { stamps: 1, lifetime_stamps: 1 }, $set: { last_stamped_at: new Date() } },
        { upsert: true, new: true },
      ).exec();

      if ((card?.stamps ?? 0) < program.stamps_required) {
        notificationsService.notify(input.userId, {
          category: 'loyalty',
          title: 'Stamp earned',
          body: `${card.stamps} of ${program.stamps_required} towards ${program.reward_description}.`,
          data: { businessId: input.businessId, stamps: card.stamps, required: program.stamps_required },
        });
        return { stamped: true, rewardEarned: false };
      }

      // Card complete. Consume the stamps atomically and mint the reward — the conditional decrement
      // is what stops two concurrent completions minting two rewards from one full card.
      const consumed = await LoyaltyCardModel.findOneAndUpdate(
        { _id: card._id, stamps: { $gte: program.stamps_required } },
        { $inc: { stamps: -program.stamps_required } },
        { new: true },
      ).exec();
      if (!consumed) return { stamped: true, rewardEarned: false };

      const reward = await LoyaltyRewardModel.create({
        business_id: input.businessId,
        user_id: input.userId,
        reward_description: program.reward_description,
        stamps_spent: program.stamps_required,
        code: rewardCode(),
        earned_from_order_id: input.orderId,
      });

      notificationsService.notify(input.userId, {
        category: 'loyalty',
        title: 'Reward earned 🎉',
        body: `${program.reward_description} — show code ${reward.code} on your next visit.`,
        data: { businessId: input.businessId, rewardId: String(reward._id), code: reward.code },
      });
      return { stamped: true, rewardEarned: true };
    } catch (err) {
      logger.error({ err, ...input }, 'loyalty stamp failed');
      return { stamped: false, rewardEarned: false };
    }
  },

  /** Customer: my cards, with progress. */
  async myCards(principal: Principal) {
    const cards = await LoyaltyCardModel.find({ user_id: principal.userId })
      .sort({ last_stamped_at: -1 })
      .limit(100)
      .lean();
    if (cards.length === 0) return [];

    const programs = await LoyaltyProgramModel.find({
      business_id: { $in: cards.map((c) => c.business_id) },
    }).lean();
    const byBusiness = new Map(programs.map((p) => [p.business_id, p]));

    return cards.map((card) => {
      const program = byBusiness.get(card.business_id);
      return {
        businessId: card.business_id,
        stamps: card.stamps,
        stampsRequired: program?.stamps_required ?? null,
        rewardDescription: program?.reward_description ?? null,
        // Null when the vendor has ended the programme — the card is history, not progress.
        active: program?.active ?? false,
        lifetimeStamps: card.lifetime_stamps,
      };
    });
  },

  /** Customer: rewards I hold and have not spent. */
  async myRewards(principal: Principal) {
    const rewards = await LoyaltyRewardModel.find({
      user_id: principal.userId,
      redeemed_at: null,
    })
      .sort({ created_at: -1 })
      .lean();
    return rewards.map((r) => ({
      id: String(r._id),
      businessId: r.business_id,
      description: r.reward_description,
      code: r.code,
      earnedAt: r.created_at,
    }));
  },

  /**
   * Vendor: honour a reward at the counter.
   *
   * Conditional on `redeemed_at: null`, so two staff scanning the same code cannot both give it
   * away. A second attempt gets a clear conflict rather than a silent no-op — the person at the
   * counter needs to know which it was.
   */
  async redeem(principal: Principal, businessId: string, code: string) {
    await assertOwner(principal, businessId);
    const reward = await LoyaltyRewardModel.findOneAndUpdate(
      { code: code.toUpperCase(), business_id: businessId, redeemed_at: null },
      { $set: { redeemed_at: new Date(), redeemed_by: principal.userId } },
      { new: true },
    ).exec();

    if (!reward) {
      const exists = await LoyaltyRewardModel.findOne({
        code: code.toUpperCase(),
        business_id: businessId,
      }).lean();
      if (exists?.redeemed_at) {
        throw BusinessRuleError(
          ERROR_CODES.CONFLICT,
          `This reward was already redeemed on ${exists.redeemed_at.toISOString().slice(0, 10)}`,
        );
      }
      throw NotFoundError('No such reward for this business');
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'loyalty.reward_redeemed',
      entityType: 'business',
      entityId: businessId,
      metadata: { rewardId: String(reward._id), customerId: reward.user_id },
    });
    notificationsService.notify(reward.user_id, {
      category: 'loyalty',
      title: 'Reward redeemed',
      body: `Enjoy your ${reward.reward_description}.`,
      data: { businessId, rewardId: String(reward._id) },
    });

    return {
      id: String(reward._id),
      description: reward.reward_description,
      redeemedAt: reward.redeemed_at,
    };
  },
};
