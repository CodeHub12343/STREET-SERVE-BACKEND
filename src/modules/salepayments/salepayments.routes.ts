import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requireFeature } from '../../middleware/requireFeature';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { salePaymentsController } from './salepayments.controller';
import {
  CheckoutIdParam,
  CreateIntentBody,
  PayTokenParam,
  SalePaymentIdParam,
} from './salepayments.schema';

/** Seller-facing: start and manage a customer payment. */
export const salesRouter = Router();

salesRouter.post(
  '/payment-intent',
  rateLimit('money'),
  requireFeature('consignment'),
  authenticate,
  requirePermission('sale:collect_payment'),
  /**
   * 6.3: the service already de-duplicated on `idempotency_key`, but it did NOT compare the request
   * body — so replaying a key with a DIFFERENT quantity returned 201 with the ORIGINAL intent. The
   * caller believes the new amount was applied and the customer is charged the old one, which is a
   * worse outcome than a plain double charge because nothing looks wrong. The shared middleware
   * hashes the body and answers 409 on a mismatch.
   */
  idempotency,
  validate({ body: CreateIntentBody }),
  asyncHandler(salePaymentsController.createIntent),
);

salesRouter.get(
  '/:id/payment-status',
  rateLimit('read'),
  authenticate,
  requirePermission('sale:collect_payment'),
  validate({ params: SalePaymentIdParam }),
  asyncHandler(salePaymentsController.status),
);

salesRouter.post(
  '/:id/cancel-payment',
  rateLimit('write'),
  authenticate,
  requirePermission('sale:collect_payment'),
  validate({ params: SalePaymentIdParam }),
  asyncHandler(salePaymentsController.cancel),
);

salesRouter.get(
  '/for-checkout/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('checkout:manage_own'),
  validate({ params: CheckoutIdParam }),
  asyncHandler(salePaymentsController.listForCheckout),
);

/**
 * PUBLIC customer payment surface — deliberately unauthenticated. A street customer buying a $5
 * item will not create an account first; requiring one would simply lose the sale. The pay token is
 * an unguessable 128-bit value and exposes only the item, seller name and amount.
 */
export const payRouter = Router();

payRouter.get(
  '/:token',
  rateLimit('read'),
  validate({ params: PayTokenParam }),
  asyncHandler(salePaymentsController.publicView),
);
