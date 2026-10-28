import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { requireModule } from '../../middleware/requireModule';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { payforwardController } from './payforward.controller';
import { payforwardItemsService } from './payforwardItems.service';
import {
  BusinessIdParam,
  ContributeBody,
  ContributionIdParam,
  FundSettingsBody,
} from './payforward.schema';

/**
 * Pay It Forward (ADR-005). Mounted at `/pay-it-forward`.
 *
 * Reads are public on purpose: "this business has a community fund" is discovery information, and
 * hiding it behind a login would defeat the point of putting it on the map. Nothing here exposes who
 * gave (unless they asked to be named) or who received (never).
 */
export const payforwardRouter = Router();

/**
 * The caller's own gifts. **Declared before `/:businessId`**, which would otherwise match `mine` as
 * a business id and hand back a fund for a business that does not exist.
 *
 * Authenticated and self-scoped — it is the only view in this module that shows a contribution
 * which did not settle, and the only one that could ever tie a gift to the person who gave it.
 */
payforwardRouter.get(
  '/contributions/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('payforward:contribute'),
  asyncHandler(payforwardController.mine),
);

/**
 * ADR-005 §7 — the change-of-mind window. Money-path, so idempotency-keyed: a double tap must not
 * attempt two refunds against the same gift.
 */
payforwardRouter.post(
  '/contributions/:contributionId/refund',
  rateLimit('money'),
  authenticate,
  requirePermission('payforward:contribute'),
  idempotency,
  validate({ params: ContributionIdParam }),
  asyncHandler(payforwardController.refundContribution),
);

payforwardRouter.get(
  '/:businessId',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(payforwardController.getFund),
);

payforwardRouter.get(
  '/:businessId/impact',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(payforwardController.impact),
);

payforwardRouter.get(
  '/:businessId/contributions',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(payforwardController.recent),
);

/**
 * Money in. `money` rate limit + idempotency, like every other charge path — a double-tapped
 * donation is a double charge for something the giver receives nothing back from.
 */
payforwardRouter.post(
  '/:businessId/contributions',
  rateLimit('money'),
  authenticate,
  requirePermission('payforward:contribute'),
  requireModule('pay_it_forward', (req) => req.params.businessId),
  idempotency,
  validate({ params: BusinessIdParam, body: ContributeBody }),
  asyncHandler(payforwardController.contribute),
);

/** Vendor settings. Ownership is checked in the service, where the business is loaded. */
payforwardRouter.patch(
  '/:businessId/settings',
  rateLimit('write'),
  authenticate,
  requirePermission('payforward:manage'),
  validate({ params: BusinessIdParam, body: FundSettingsBody }),
  asyncHandler(payforwardController.updateSettings),
);

// ─── PIF-II — specific-item ("suspended coffee") routes ────────────────────────────────────
function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

const ItemContributeBody = z
  .object({
    menuItemId: z.string().length(24),
    anonymous: z.boolean().optional(),
    displayName: z.string().min(1).max(80).optional(),
    note: z.string().max(280).optional(),
  })
  .strict();
const ItemRefundIdParam = z.object({ id: z.string().length(24) }).strict();

/**
 * Public: what items are currently claimable at this business. No PII beyond opt-in display
 * names. Oldest-first (FIFO), capped at 50 to keep response size predictable.
 */
payforwardRouter.get(
  '/:businessId/items',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await payforwardItemsService.listClaimable(
        params<z.infer<typeof BusinessIdParam>>(req).businessId,
      ),
    );
  }),
);

/**
 * Authenticated: pre-buy a specific menu item. Same rate limit / idempotency / module gate as
 * the pool contribution path — a double-tapped buy is a double charge for an item nobody
 * receives back.
 */
payforwardRouter.post(
  '/:businessId/items/contribute',
  rateLimit('money'),
  authenticate,
  requirePermission('payforward:contribute'),
  requireModule('pay_it_forward', (req) => req.params.businessId),
  idempotency,
  validate({ params: BusinessIdParam, body: ItemContributeBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const dto = body<z.infer<typeof ItemContributeBody>>(req);
    created(
      res,
      await payforwardItemsService.contribute(
        principal(req),
        {
          businessId: params<z.infer<typeof BusinessIdParam>>(req).businessId,
          menuItemId: dto.menuItemId,
          anonymous: dto.anonymous,
          displayName: dto.displayName,
          note: dto.note,
        },
        req.header('Idempotency-Key') ?? '',
      ),
    );
  }),
);

/**
 * Giver change-of-mind refund — 24h window, giver-only, funded rows only. Keeps the item
 * route surface symmetric with the pool's existing `/contributions/:id` refund path.
 */
payforwardRouter.post(
  '/items/:id/refund',
  rateLimit('money'),
  authenticate,
  validate({ params: ItemRefundIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await payforwardItemsService.refundByGiver(
        principal(req),
        params<z.infer<typeof ItemRefundIdParam>>(req).id,
      ),
    );
  }),
);
