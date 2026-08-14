import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { SELLER_SKILLS, SELLER_TRANSPORT, SELLER_VENUES } from '../../config/constants';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { body, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { sellersService } from './sellers.service';

export const sellersRouter = Router();

const ProfileBody = z
  .object({
    skills: z.array(z.enum(SELLER_SKILLS)).max(SELLER_SKILLS.length).optional(),
    venues: z.array(z.enum(SELLER_VENUES)).max(SELLER_VENUES.length).optional(),
    transport: z.enum(SELLER_TRANSPORT).nullable().optional(),
    availableHours: z.array(z.number().int().min(0).max(23)).max(24).optional(),
    bio: z.string().max(400).nullable().optional(),
  })
  .strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/**
 * D-2 — the seller profile. Self-only: there is no route to read someone else's, because the venue
 * and availability fields describe where a person physically is and when.
 */
sellersRouter.get(
  '/me/profile',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = principal(req).userId;
    // Refresh the inferred half on read — cheap (one seller's own history) and it means a new
    // seller's first week of evidence is visible immediately rather than after a nightly job.
    await sellersService.recomputeInferred(userId);
    ok(res, await sellersService.getMine(userId));
  }),
);

sellersRouter.patch(
  '/me/profile',
  rateLimit('write'),
  authenticate,
  validate({ body: ProfileBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sellersService.updateMine(principal(req), body<z.infer<typeof ProfileBody>>(req)));
  }),
);

/** The vocabulary, served rather than hardcoded client-side — same rule as A-5's job types. */
sellersRouter.get('/profile-options', rateLimit('read'), (_req: Request, res: Response) => {
  ok(res, {
    skills: SELLER_SKILLS,
    venues: SELLER_VENUES,
    transport: SELLER_TRANSPORT,
  });
});
