import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { consignmentService } from '../consignment/consignment.service';
import { trustService } from '../trust/trust.service';
import { subscriptionsService } from '../subscriptions/subscriptions.service';
import { debtService } from './debt.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

const DebtIdParam = z.object({ id: z.string().length(24) }).strict();
const RepayBody = z.object({ amountCents: z.number().int().min(1).max(100_000_000) }).strict();

/** Seller-facing balance surface. A seller only ever sees their own. */
export const debtsRouter = Router();

debtsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('debt:read_own'),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await debtService.listMine(principal(req)));
  }),
);

/** Powers "how much stock can I take?" and gates checkout server-side. */
debtsRouter.get(
  '/credit',
  rateLimit('read'),
  authenticate,
  requirePermission('debt:read_own'),
  asyncHandler(async (req: Request, res: Response) => {
    const p = principal(req);
    // A-3: pass the Trust Score so this surface reports the SAME ceiling the checkout guard
    // enforces. Reading a tier-only limit here while checkout applied a band-scaled one is exactly
    // the kind of drift that makes a seller think the app is lying to them.
    const [held, { score }, sellerPlus] = await Promise.all([
      consignmentService.activeInventoryValue(p.userId),
      trustService.getScore('seller', p.userId),
      // F-2: same reason as A-3 — this surface must report the ceiling checkout will enforce.
      subscriptionsService.hasSellerPlus(p.userId),
    ]);
    ok(
      res,
      await debtService.creditStatus(p.userId, p.verificationTier, held, score, undefined, sellerPlus),
    );
  }),
);

debtsRouter.post(
  '/:id/repay',
  rateLimit('money'),
  authenticate,
  requirePermission('debt:repay_own'),
  validate({ params: DebtIdParam, body: RepayBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof DebtIdParam>>(req);
    const input = body<z.infer<typeof RepayBody>>(req);
    const ref = req.header('Idempotency-Key') ?? `manual_${Date.now()}`;
    ok(res, await debtService.repay(principal(req), id, input.amountCents, ref));
  }),
);
