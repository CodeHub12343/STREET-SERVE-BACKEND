import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ownsBusiness } from '../vendors/vendors.controller';
import { ordersController } from './orders.controller';
import {
  BusinessIdParam,
  CancelOrderBody,
  OrderIdParam,
  PlaceOrderBody,
  QuoteOrderBody,
  RemoveItemBody,
} from './orders.schema';

export const ordersRouter = Router();

ordersRouter.post(
  '/',
  rateLimit('money'),
  authenticate,
  requirePermission('order:create'),
  idempotency,
  validate({ body: PlaceOrderBody }),
  asyncHandler(ordersController.place),
);
// Server-authoritative price preview (R9) — no side effects, so a read-rate limit and no idempotency.
ordersRouter.post(
  '/quote',
  rateLimit('read'),
  authenticate,
  requirePermission('order:create'),
  validate({ body: QuoteOrderBody }),
  asyncHandler(ordersController.quote),
);
ordersRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('order:read_own'),
  asyncHandler(ordersController.listMine),
);
ordersRouter.post(
  '/:id/accept',
  rateLimit('write'),
  authenticate,
  requirePermission('order:manage_business'),
  validate({ params: OrderIdParam }),
  asyncHandler(ordersController.accept),
);
ordersRouter.post(
  '/:id/ready',
  rateLimit('write'),
  authenticate,
  requirePermission('order:manage_business'),
  validate({ params: OrderIdParam }),
  asyncHandler(ordersController.ready),
);
ordersRouter.post(
  '/:id/complete',
  rateLimit('write'),
  authenticate,
  requirePermission('order:manage_business'),
  validate({ params: OrderIdParam }),
  asyncHandler(ordersController.complete),
);
ordersRouter.post(
  '/:id/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('order:cancel'),
  validate({ params: OrderIdParam, body: CancelOrderBody }),
  asyncHandler(ordersController.cancel),
);
// Refund disclosure (R13/U6) — read-only "what you'll get back", for the cancel/refund confirm UX.
ordersRouter.get(
  '/:id/refund-preview',
  rateLimit('read'),
  authenticate,
  requirePermission('order:read_own'),
  validate({ params: OrderIdParam }),
  asyncHandler(ordersController.refundPreview),
);
ordersRouter.post(
  '/:id/remove-item',
  rateLimit('money'),
  authenticate,
  requirePermission('order:manage_business'),
  validate({ params: OrderIdParam, body: RemoveItemBody }),
  asyncHandler(ordersController.removeItem),
);

// Vendor's order queue (mounted at /businesses).
export const businessOrdersRouter = Router();
businessOrdersRouter.get(
  '/:id/orders',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('order:manage_business', ownsBusiness),
  asyncHandler(ordersController.listForBusiness),
);
