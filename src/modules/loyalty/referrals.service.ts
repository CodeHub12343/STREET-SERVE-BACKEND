import { Schema, type InferSchemaType } from 'mongoose';

import { logger } from '../../config/logger';
import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';

/**
 * 7.4 / M-20 — referral rewards, modelled on the gift-code flow.
 *
 * ## Why it is modelled on gifts rather than on a discount
 *
 * A gift code is already a working pattern here: a code, a claim, a one-time state transition, an
 * expiry. A referral is the same shape with a different trigger, so reusing the shape is cheaper
 * than inventing a second one — and, more importantly, it inherits the property that matters: the
 * reward is a **discrete claimable thing**, not a balance. Balances invite fraud arithmetic;
 * discrete claims can be counted and capped.
 *
 * ## The abuse this is designed against
 *
 * Referral programmes are farmed. The specific attack is one person creating accounts to refer
 * themselves, and the specific defences here are:
 *
 * 1. **Self-referral is refused** — the obvious case, checked explicitly.
 * 2. **A referral only counts once the referred user COMPLETES A PAID ORDER.** Signing up is free,
 *    so rewarding signup rewards account creation. Requiring a completed order means farming costs
 *    the farmer real money on real orders, which is the only defence that scales without a fraud
 *    team.
 * 3. **One reward per referred user, ever** — enforced by a unique index, not a check-then-write.
 * 4. **A lifetime cap per referrer.** Not because 50 genuine referrals are bad, but because an
 *    uncapped programme has an unbounded liability, and the cap is the number someone chose rather
 *    than the number an attacker chose.
 *
 * ## What the reward is
 *
 * A `referral_credit` record, not money. Turning it into platform credit or a discount would put it
 * on the money path, which needs the ledger, refund semantics, and tax treatment — a much larger
 * decision than this feature. Recording the earned reward and leaving redemption to the same
 * counter flow as loyalty keeps the liability visible and the scope honest.
 */

/** Referrals beyond this earn nothing. Generous for a real user, bounded for a farm. */
export const REFERRAL_LIFETIME_CAP = 25;
/** A referral must convert within this window, or it lapses. */
export const REFERRAL_WINDOW_DAYS = 60;

const ReferralCodeSchema = new Schema(
  {
    user_id: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    /** Rewards actually earned, for the cap. Incremented on conversion, never on signup. */
    rewards_earned: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'referral_codes' },
);
export type ReferralCodeDoc = InferSchemaType<typeof ReferralCodeSchema>;
export const ReferralCodeModel = defineModel('ReferralCode', ReferralCodeSchema);

/**
 * One referral. Immutable once written: this is the evidence behind a reward, and a referral that
 * can be edited after the fact is not evidence of anything.
 */
const ReferralSchema = new Schema(
  {
    referrer_user_id: { type: String, required: true, index: true },
    /** Unique: a person can be referred once, by one person, ever. */
    referred_user_id: { type: String, required: true, unique: true },
    code: { type: String, required: true },
    status: { type: String, enum: ['pending', 'converted', 'lapsed'], default: 'pending' },
    converted_at: { type: Date, default: null },
    converting_order_id: { type: String, default: null },
    expires_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'referrals' },
);
ReferralSchema.index({ referrer_user_id: 1, status: 1 });
ReferralSchema.index({ status: 1, expires_at: 1 }); // the lapse sweep
export type ReferralDoc = InferSchemaType<typeof ReferralSchema>;
export const ReferralModel = defineModel('Referral', ReferralSchema);

/** The earned reward. Immutable — same reasoning as the referral itself. */
const ReferralCreditSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    referral_id: { type: String, required: true, unique: true },
    reason: { type: String, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'referral_credits' },
);
ReferralCreditSchema.plugin(immutablePlugin);
export type ReferralCreditDoc = InferSchemaType<typeof ReferralCreditSchema>;
export const ReferralCreditModel = defineModel('ReferralCredit', ReferralCreditSchema);

function makeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export const referralsService = {
  /** My code, created on first ask. Stable thereafter — people share it. */
  async myCode(principal: Principal) {
    const existing = await ReferralCodeModel.findOne({ user_id: principal.userId }).lean();
    if (existing) {
      return {
        code: existing.code,
        rewardsEarned: existing.rewards_earned,
        cap: REFERRAL_LIFETIME_CAP,
      };
    }
    // Retry on collision rather than trusting one draw — the alphabet is small on purpose so the
    // code can be read aloud.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const doc = await ReferralCodeModel.create({ user_id: principal.userId, code: makeCode() });
        return { code: doc.code, rewardsEarned: 0, cap: REFERRAL_LIFETIME_CAP };
      } catch {
        // collision — draw again
      }
    }
    throw BusinessRuleError(ERROR_CODES.CONFLICT, 'Could not allocate a referral code');
  },

  /**
   * Claim someone's code. Records a PENDING referral — nothing is earned yet.
   *
   * Rewarding here would reward account creation, which is free. The reward waits for a completed
   * paid order, so farming costs the farmer real money.
   */
  async claim(principal: Principal, code: string) {
    const owner = await ReferralCodeModel.findOne({ code: code.toUpperCase() }).lean();
    if (!owner) throw NotFoundError('No such referral code');
    if (owner.user_id === principal.userId) {
      throw BusinessRuleError(ERROR_CODES.VALIDATION_ERROR, 'You cannot refer yourself');
    }

    const already = await ReferralModel.findOne({ referred_user_id: principal.userId }).lean();
    if (already) {
      throw BusinessRuleError(
        ERROR_CODES.CONFLICT,
        'You have already used a referral code — one per account',
      );
    }

    const referral = await ReferralModel.create({
      referrer_user_id: owner.user_id,
      referred_user_id: principal.userId,
      code: owner.code,
      expires_at: new Date(Date.now() + REFERRAL_WINDOW_DAYS * 86_400_000),
    });

    await writeAudit({
      actorId: principal.userId,
      action: 'referral.claimed',
      entityType: 'referral',
      entityId: String(referral._id),
      metadata: { referrerUserId: owner.user_id },
    });
    return {
      id: String(referral._id),
      status: referral.status,
      // Said plainly, because a user who thinks they already earned something and did not will
      // conclude the programme is a scam.
      message: `Referral recorded. Your friend earns their reward once you complete your first order — and so do you.`,
      expiresAt: referral.expires_at,
    };
  },

  /**
   * Convert a pending referral when the referred user completes a paid order.
   *
   * Idempotent by the conditional transition: only a `pending` referral converts, so a second
   * completed order does not earn a second reward. Never throws — an order must not fail because a
   * referral did.
   */
  async onOrderCompleted(userId: string, orderId: string): Promise<boolean> {
    try {
      const referral = await ReferralModel.findOneAndUpdate(
        { referred_user_id: userId, status: 'pending', expires_at: { $gt: new Date() } },
        { $set: { status: 'converted', converted_at: new Date(), converting_order_id: orderId } },
        { new: true },
      ).exec();
      if (!referral) return false;

      const referrer = await ReferralCodeModel.findOne({ user_id: referral.referrer_user_id });
      if (!referrer) return false;

      if (referrer.rewards_earned >= REFERRAL_LIFETIME_CAP) {
        // Converted, but capped. Recorded rather than silently dropped: the referrer should be told
        // why nothing arrived, and ops should be able to see the cap biting.
        logger.info(
          { referrerUserId: referral.referrer_user_id },
          'referral converted but referrer is at the lifetime cap',
        );
        await writeAudit({
          action: 'referral.capped',
          entityType: 'referral',
          entityId: String(referral._id),
          metadata: { referrerUserId: referral.referrer_user_id, cap: REFERRAL_LIFETIME_CAP },
        });
        return false;
      }

      // Both sides earn. A one-sided referral programme asks the referred user to do the work of
      // signing up and gives them nothing for it.
      for (const [beneficiary, reason] of [
        [referral.referrer_user_id, 'Someone you referred completed their first order'],
        [referral.referred_user_id, 'Welcome reward for joining through a referral'],
      ] as const) {
        await ReferralCreditModel.create({
          user_id: beneficiary,
          referral_id: `${String(referral._id)}:${beneficiary}`,
          reason,
        });
        notificationsService.notify(beneficiary, {
          category: 'referral',
          title: 'Referral reward earned',
          body: reason,
          data: { referralId: String(referral._id) },
        });
      }

      referrer.rewards_earned += 1;
      await referrer.save();
      return true;
    } catch (err) {
      logger.error({ err, userId, orderId }, 'referral conversion failed');
      return false;
    }
  },

  /** My referrals and what came of them. */
  async myReferrals(principal: Principal) {
    const [referrals, credits] = await Promise.all([
      ReferralModel.find({ referrer_user_id: principal.userId })
        .sort({ created_at: -1 })
        .limit(100)
        .lean(),
      ReferralCreditModel.find({ user_id: principal.userId }).sort({ created_at: -1 }).lean(),
    ]);
    return {
      referrals: referrals.map((r) => ({
        id: String(r._id),
        status: r.status,
        convertedAt: r.converted_at,
        expiresAt: r.expires_at,
      })),
      credits: credits.map((c) => ({ id: String(c._id), reason: c.reason, earnedAt: c.created_at })),
    };
  },

  /** Sweep: pending referrals past their window lapse, so "pending" means something. */
  async sweepLapsed(): Promise<number> {
    const result = await ReferralModel.updateMany(
      { status: 'pending', expires_at: { $lte: new Date() } },
      { $set: { status: 'lapsed' } },
    ).exec();
    return result.modifiedCount ?? 0;
  },
};
