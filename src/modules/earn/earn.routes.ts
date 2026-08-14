import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { EARN_DEFAULT_LIMIT } from '../../config/constants';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { query, validate } from '../../middleware/validate';
import { Latitude, Longitude } from '../../shared/geo';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { earnService } from './earn.service';

export const earnRouter = Router();

/** Location is optional: without it gigs drop out (their feed is proximity-ranked) but stock doesn't. */
const EarnQuery = z
  .object({
    lat: z.coerce.number().pipe(Latitude).optional(),
    lng: z.coerce.number().pipe(Longitude).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(EARN_DEFAULT_LIMIT),
  })
  .strict()
  .refine((v) => (v.lng === undefined) === (v.lat === undefined), {
    message: 'lng and lat must be provided together',
  });

/**
 * D-1 — every way to earn today, in one ranked list. See `earn.service` for why ranking is two-axis
 * (payout AND time-to-payout) rather than payout alone.
 */
earnRouter.get(
  '/',
  rateLimit('read'),
  authenticate,
  validate({ query: EarnQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const q = query<z.infer<typeof EarnQuery>>(req);
    ok(res, await earnService.opportunities(req.principal, q));
  }),
);
