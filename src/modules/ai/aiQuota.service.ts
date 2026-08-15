import { AI_FREE_REQUESTS_PER_MONTH } from '../../config/constants';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError } from '../../shared/errors/AppError';
import { subscriptionsService } from '../subscriptions/subscriptions.service';
import { AiUsageModel } from './ai.model';

/**
 * The paywall for AI advice.
 *
 * The AI Marketing Assistant plan sold "unlimited AI coaching, pricing and marketing copy" for
 * $19.99/month and NOTHING read the entitlement — every AI route was open to everyone, so a
 * subscriber received exactly what a non-subscriber already had. This module is what makes the plan
 * a product rather than a donation.
 *
 * A free allowance rather than a hard wall: a seller who has never seen the coach will not pay for
 * it, so the first few answers have to be free or the plan cannot be sold at all.
 */

/** UTC calendar month, `YYYY-MM`. The reset is the absence of a document, not a job. */
function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface AiQuotaStatus {
  /** True when an active plan makes the allowance irrelevant. */
  unlimited: boolean;
  /** Free calls used this month. Always 0 for a subscriber — their calls are not counted. */
  used: number;
  limit: number;
  remaining: number;
  /** `YYYY-MM`, so a client can say when the allowance returns without guessing the rule. */
  period: string;
}

export const aiQuotaService = {
  /**
   * What the caller has left, without spending anything.
   *
   * The dashboard needs to say "2 of your 5 free left" BEFORE the seller asks for advice — a
   * paywall that only announces itself at the moment of refusal reads as the product breaking.
   */
  async status(userId: string): Promise<AiQuotaStatus> {
    const period = currentPeriod();
    if (await subscriptionsService.hasActive(userId, 'ai_assistant')) {
      return {
        unlimited: true,
        used: 0,
        limit: AI_FREE_REQUESTS_PER_MONTH,
        remaining: AI_FREE_REQUESTS_PER_MONTH,
        period,
      };
    }
    const row = await AiUsageModel.findOne({ user_id: userId, period }).lean().exec();
    const used = row?.count ?? 0;
    return {
      unlimited: false,
      used,
      limit: AI_FREE_REQUESTS_PER_MONTH,
      remaining: Math.max(0, AI_FREE_REQUESTS_PER_MONTH - used),
      period,
    };
  },

  /**
   * Spend one free call, or pass straight through for a subscriber.
   *
   * The increment happens BEFORE the work, atomically, and is given back if the work fails. The
   * other order — count on the way out — lets two concurrent requests both read 4, both proceed,
   * and both write 5, which hands out an extra call under exactly the load that makes a quota worth
   * enforcing. Reserving first cannot be raced; `$inc` on a uniquely-indexed upsert is a single
   * document operation.
   *
   * Throws AI_QUOTA_EXCEEDED, its own code rather than FEATURE_DISABLED, because the client has to
   * tell "you may not have this" apart from "you have used your free ones" — only the second has an
   * upgrade offer attached to it.
   */
  async consume(userId: string): Promise<AiQuotaStatus> {
    const period = currentPeriod();
    if (await subscriptionsService.hasActive(userId, 'ai_assistant')) {
      return {
        unlimited: true,
        used: 0,
        limit: AI_FREE_REQUESTS_PER_MONTH,
        remaining: AI_FREE_REQUESTS_PER_MONTH,
        period,
      };
    }

    const row = await AiUsageModel.findOneAndUpdate(
      { user_id: userId, period },
      { $inc: { count: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).exec();
    const used = row?.count ?? 1;

    if (used > AI_FREE_REQUESTS_PER_MONTH) {
      // Hand the reservation back: a refused request must not also consume the allowance, or a
      // client retrying a 403 would drive the counter up forever.
      await this.release(userId);
      throw ForbiddenError(
        `You have used your ${AI_FREE_REQUESTS_PER_MONTH} free AI suggestions this month. ` +
          'The AI Marketing Assistant plan makes them unlimited.',
        ERROR_CODES.AI_QUOTA_EXCEEDED,
      );
    }

    return {
      unlimited: false,
      used,
      limit: AI_FREE_REQUESTS_PER_MONTH,
      remaining: Math.max(0, AI_FREE_REQUESTS_PER_MONTH - used),
      period,
    };
  },

  /**
   * Return a reserved call.
   *
   * Used when the work fails after the reservation — the model timed out, the request was malformed,
   * we threw. A seller must not lose one of five free suggestions to our own error, and floors at
   * zero so a double release cannot mint allowance.
   */
  async release(userId: string): Promise<void> {
    await AiUsageModel.updateOne(
      { user_id: userId, period: currentPeriod(), count: { $gt: 0 } },
      { $inc: { count: -1 } },
    ).exec();
  },
};
