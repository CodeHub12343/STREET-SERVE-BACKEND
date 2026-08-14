import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { vendorsService } from '../vendors/vendors.service';
import { GiveawayClaimModel, GiveawayModel } from './growth.model';

function nextUtcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export const giveawaysService = {
  async create(
    principal: Principal,
    businessId: string,
    input: { productName: string; dailyQuantityCap: number },
  ) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId)
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    const g = await GiveawayModel.create({
      business_id: businessId,
      product_name: input.productName,
      daily_quantity_cap: input.dailyQuantityCap,
      reset_at: nextUtcMidnight(),
    });
    return {
      id: String(g._id),
      productName: g.product_name,
      dailyQuantityCap: g.daily_quantity_cap,
    };
  },

  /** Claim a free unit — atomic cap guard + one claim per user per day (FR-6.2). */
  async claim(principal: Principal, giveawayId: string) {
    // Atomically consume a unit only if under the daily cap.
    const consumed = await GiveawayModel.findOneAndUpdate(
      {
        _id: giveawayId,
        active: true,
        $expr: { $lt: ['$quantity_claimed_today', '$daily_quantity_cap'] },
      },
      { $inc: { quantity_claimed_today: 1 } },
      { new: true },
    ).exec();
    if (!consumed) {
      const exists = await GiveawayModel.exists({ _id: giveawayId });
      if (!exists) throw NotFoundError('Giveaway not found');
      throw BusinessRuleError(
        ERROR_CODES.GIVEAWAY_CAP_REACHED,
        "Today's giveaway limit has been reached",
      );
    }
    try {
      await GiveawayClaimModel.create({
        giveaway_id: giveawayId,
        user_id: principal.userId,
        day_key: dayKey(),
      });
    } catch (err) {
      // Already claimed today → refund the consumed unit.
      await GiveawayModel.updateOne(
        { _id: giveawayId },
        { $inc: { quantity_claimed_today: -1 } },
      ).exec();
      if ((err as { code?: number }).code === 11000) {
        throw ConflictError(ERROR_CODES.DUPLICATE, 'You already claimed this giveaway today');
      }
      throw err;
    }
    return {
      giveawayId,
      productName: consumed.product_name,
      remainingToday: consumed.daily_quantity_cap - consumed.quantity_claimed_today,
    };
  },

  /** Daily reset sweep. */
  async resetDaily(): Promise<number> {
    const res = await GiveawayModel.updateMany(
      { reset_at: { $lte: new Date() } },
      { $set: { quantity_claimed_today: 0, reset_at: nextUtcMidnight() } },
    ).exec();
    return res.modifiedCount;
  },
};
