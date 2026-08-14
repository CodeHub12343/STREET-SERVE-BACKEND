import { Router, type Request, type Response } from 'express';

import { authenticate } from '../../middleware/auth';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { subscriptionsController } from './subscriptions.controller';
import { CancelBody, EntitlementsQuery, PlanParam, SubscribeBody } from './subscriptions.schema';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/plans', rateLimit('read'), asyncHandler(subscriptionsController.plans));

subscriptionsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('subscription:read'),
  validate({ query: EntitlementsQuery }),
  asyncHandler(subscriptionsController.entitlements),
);

subscriptionsRouter.post(
  '/',
  rateLimit('money'),
  authenticate,
  requirePermission('subscription:manage'),
  idempotency,
  validate({ body: SubscribeBody }),
  asyncHandler(subscriptionsController.subscribe),
);

/**
 * Settles a subscription after the client confirms its first payment. Deliberately takes no status
 * from the caller — the server re-reads Stripe, so claiming to have paid achieves nothing.
 */
subscriptionsRouter.post(
  '/:plan/confirm',
  rateLimit('write'),
  authenticate,
  requirePermission('subscription:manage'),
  validate({ params: PlanParam, body: CancelBody }),
  asyncHandler(subscriptionsController.confirm),
);

subscriptionsRouter.post(
  '/:plan/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('subscription:manage'),
  validate({ params: PlanParam, body: CancelBody }),
  asyncHandler(subscriptionsController.cancel),
);

/**
 * F-4 — Stock Protection status.
 *
 * The SAME computation the liability path enforces, so a seller can never be told they're covered
 * by a screen that disagrees with the code that decides.
 */
subscriptionsRouter.get(
  '/waiver/status',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { waiverService } = await import('./waiver.service');
    ok(res, await waiverService.status(req.principal.userId));
  }),
);

/** The seller's own write-off history. */
subscriptionsRouter.get(
  '/waiver/history',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { waiverService } = await import('./waiver.service');
    ok(res, await waiverService.history(req.principal.userId));
  }),
);
