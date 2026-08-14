import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { MAX_DISCOUNT_PERCENT } from '../orders/discounts';
import { promotionsService } from './promotions.service';

/**
 * 7.6 / P-15 — flash sales.
 *
 * Reads are public (a customer must be able to see a live sale before signing in); writes are
 * owner-gated through `menu:manage_own`, because a flash sale changes what customers pay for that
 * business's items and is therefore the same authority as editing the menu.
 */
export const promotionsRouter = Router();

const objectId = z.string().length(24);
const BusinessIdParam = z.object({ id: objectId }).strict();
const SaleIdParam = z.object({ saleId: objectId }).strict();

const CreateFlashSaleBody = z
  .object({
    menuItemId: objectId.optional(),
    percent: z.number().int().min(1).max(MAX_DISCOUNT_PERCENT),
    label: z.string().min(1).max(80).optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .strict();

/** Public: what is on sale right now. */
promotionsRouter.get(
  '/businesses/:id/flash-sales',
  rateLimit('read'),
  optionalAuth,
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await promotionsService.listLive(id));
  }),
);

/** Owner: every sale, including finished and cancelled ones. */
promotionsRouter.get(
  '/businesses/:id/flash-sales/all',
  rateLimit('read'),
  authenticate,
  requirePermission('menu:manage_own'),
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await promotionsService.listForBusiness(req.principal, id));
  }),
);

promotionsRouter.post(
  '/businesses/:id/flash-sales',
  rateLimit('write'),
  authenticate,
  requirePermission('menu:manage_own'),
  validate({ params: BusinessIdParam, body: CreateFlashSaleBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    const input = body<z.infer<typeof CreateFlashSaleBody>>(req);
    created(res, await promotionsService.create(req.principal, { ...input, businessId: id }));
  }),
);

promotionsRouter.post(
  '/flash-sales/:saleId/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('menu:manage_own'),
  validate({ params: SaleIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { saleId } = params<z.infer<typeof SaleIdParam>>(req);
    ok(res, await promotionsService.cancel(req.principal, saleId));
  }),
);
