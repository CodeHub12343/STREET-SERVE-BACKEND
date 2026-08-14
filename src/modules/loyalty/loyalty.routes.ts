import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { loyaltyService } from './loyalty.service';
import { referralsService } from './referrals.service';

/**
 * 7.3 / 7.4 — loyalty stamps and referrals.
 *
 * Programme configuration and redemption are gated on `menu:manage_own`: both decide what a
 * business gives away at its own counter, which is the same authority as setting its prices.
 */
export const loyaltyRouter = Router();

const objectId = z.string().length(24);
const BusinessIdParam = z.object({ id: objectId }).strict();

const SetProgramBody = z
  .object({
    // Bounded deliberately: a 2-stamp card is a discount pretending to be loyalty, and a 100-stamp
    // card is a promise nobody will ever collect on.
    stampsRequired: z.number().int().min(3).max(20),
    rewardDescription: z.string().min(3).max(120),
    active: z.boolean().optional(),
  })
  .strict();
const RedeemBody = z.object({ code: z.string().min(4).max(16) }).strict();
const ClaimBody = z.object({ code: z.string().min(4).max(16) }).strict();

// ─── Loyalty ───────────────────────────────────────────────────────────────────────────────

/** Public: the card a customer is being asked to fill. */
loyaltyRouter.get(
  '/businesses/:id/loyalty',
  rateLimit('read'),
  optionalAuth,
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await loyaltyService.getProgram(id));
  }),
);

loyaltyRouter.put(
  '/businesses/:id/loyalty',
  rateLimit('write'),
  authenticate,
  requirePermission('menu:manage_own'),
  validate({ params: BusinessIdParam, body: SetProgramBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof SetProgramBody>>(req);
    ok(res, await loyaltyService.setProgram(req.principal, id, input));
  }),
);

/** Vendor: honour a reward at the counter. */
loyaltyRouter.post(
  '/businesses/:id/loyalty/redeem',
  rateLimit('write'),
  authenticate,
  requirePermission('menu:manage_own'),
  validate({ params: BusinessIdParam, body: RedeemBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const { code } = body<z.infer<typeof RedeemBody>>(req);
    ok(res, await loyaltyService.redeem(req.principal, id, code));
  }),
);

loyaltyRouter.get(
  '/me/loyalty/cards',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await loyaltyService.myCards(req.principal));
  }),
);

loyaltyRouter.get(
  '/me/loyalty/rewards',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await loyaltyService.myRewards(req.principal));
  }),
);

// ─── Referrals ─────────────────────────────────────────────────────────────────────────────

loyaltyRouter.get(
  '/me/referrals',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await referralsService.myReferrals(req.principal));
  }),
);

loyaltyRouter.post(
  '/me/referrals/code',
  rateLimit('write'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    ok(res, await referralsService.myCode(req.principal));
  }),
);

loyaltyRouter.post(
  '/me/referrals/claim',
  rateLimit('write'),
  authenticate,
  validate({ body: ClaimBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { code } = body<z.infer<typeof ClaimBody>>(req);
    created(res, await referralsService.claim(req.principal, code));
  }),
);
