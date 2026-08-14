import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { paymentsController } from './payments.controller';
import { CreateTransactionBody, TransactionIdParam } from './payments.schema';

export const paymentsRouter = Router();

// Seller/vendor/hub links a payout account (Stripe Connect hosted onboarding).
paymentsRouter.post(
  '/connect/onboard',
  rateLimit('money'),
  authenticate,
  requirePermission('payments:onboard_self'),
  asyncHandler(paymentsController.onboardSelf),
);
paymentsRouter.get(
  '/connect/status',
  rateLimit('read'),
  authenticate,
  requirePermission('payments:onboard_self'),
  asyncHandler(paymentsController.myPayoutStatus),
);

/**
 * A-2: "why is my money held?" — the seller-facing explainer behind the tiered payout hold.
 * Read-only and scoped to the caller; a seller only ever sees their own funds.
 */
paymentsRouter.get(
  '/funds-availability',
  rateLimit('read'),
  authenticate,
  requirePermission('payments:onboard_self'),
  asyncHandler(paymentsController.myFundsAvailability),
);

export const transactionsRouter = Router();

transactionsRouter.post(
  '/',
  rateLimit('money'),
  authenticate,
  requirePermission('transaction:create'),
  idempotency,
  validate({ body: CreateTransactionBody }),
  asyncHandler(paymentsController.createTransaction),
);

transactionsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('transaction:read_own'),
  asyncHandler(paymentsController.listMine),
);

transactionsRouter.post(
  '/:id/refund',
  rateLimit('money'),
  authenticate,
  requirePermission('transaction:refund'),
  validate({ params: TransactionIdParam }),
  asyncHandler(paymentsController.refund),
);
