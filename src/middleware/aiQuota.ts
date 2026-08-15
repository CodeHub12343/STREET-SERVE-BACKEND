import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { logger } from '../config/logger';
import { aiQuotaService } from '../modules/ai/aiQuota.service';
import { UnauthenticatedError } from '../shared/errors/AppError';
import { asyncHandler } from './asyncHandler';

/**
 * Meters an AI route against the caller's free monthly allowance, or lets a subscriber through.
 *
 * Applied per route rather than to the whole `aiRouter`, because the router carries endpoints that
 * must NOT be metered — accepting a recommendation you were already shown, and the dataset
 * diagnostic. Gating the router would be the shorter line and the wrong behaviour.
 *
 * Placed AFTER `authenticate` and `requirePermission` in the chain: someone who is not allowed to
 * use a feature at all should be told that, not charged an allowance for the attempt.
 */
export const requireAiQuota: RequestHandler = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.principal) throw UnauthenticatedError('Authentication required');
    const userId = req.principal.userId;

    const quota = await aiQuotaService.consume(userId);

    /**
     * The allowance is reserved before the handler runs and returned if the request does not
     * succeed. A seller must not lose one of five free suggestions to our timeout, our bug, or
     * their own malformed request — and a client retrying a failure would otherwise burn the
     * remainder of the month in a loop.
     *
     * `finish` rather than `close`: the status code is only meaningful once the response has been
     * written, and a client that hangs up mid-flight still received the work we did.
     */
    if (!quota.unlimited) {
      res.on('finish', () => {
        if (res.statusCode >= 400) {
          void aiQuotaService.release(userId).catch((err: unknown) => {
            // Losing a refund is bad but not corrupting; never let it take down the response.
            logger.error({ err, userId }, 'failed to return a reserved AI allowance');
          });
        }
      });
    }

    /**
     * Surfaced on every metered response, not only the refusal. A seller deciding whether the plan
     * is worth $19.99 needs to see the allowance running down while they use it; a counter that
     * only appears at zero reads as the product breaking rather than as a limit they were told
     * about.
     */
    res.setHeader('X-AI-Quota-Limit', String(quota.limit));
    res.setHeader('X-AI-Quota-Remaining', quota.unlimited ? 'unlimited' : String(quota.remaining));

    next();
  },
);
