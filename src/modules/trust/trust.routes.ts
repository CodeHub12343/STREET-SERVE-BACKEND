import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { params, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { trustService } from './trust.service';

/**
 * Trust scores are public + explainable (FR-10.1) — the current score plus the formula version
 * and the inputs that produced it.
 */
export const trustRouter = Router();

const SubjectParams = z
  .object({
    subjectType: z.enum(['seller', 'business', 'hub']),
    subjectId: z.string().min(1).max(64),
  })
  .strict();

/**
 * A-3: the seller's own score AND what it currently earns them. Declared before the `:subjectType`
 * route so `me` is never swallowed by the wildcard.
 */
trustRouter.get(
  '/me/benefits',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await trustService.benefits(req.principal.userId));
  }),
);

trustRouter.get(
  '/:subjectType/:subjectId',
  rateLimit('read'),
  validate({ params: SubjectParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const { subjectType, subjectId } = params<z.infer<typeof SubjectParams>>(req);
    ok(res, await trustService.getScore(subjectType, subjectId));
  }),
);
