import { Router } from 'express';

import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { queueController } from './queue.controller';
import {
  AcceptWaveBody,
  CheckoutBody,
  CreateWaveDownBody,
  DeclineWaveBody,
  DiscountScheduleBody,
  OwnerParams,
  WaveIdParam,
} from './queue.schema';

// ─── /queues/:ownerType/:ownerId ────────────────────────────────────────────────────────────
export const queuesRouter = Router();

queuesRouter.put(
  '/:ownerType/:ownerId/discount-schedule',
  rateLimit('write'),
  authenticate,
  requirePermission('discount:manage'),
  validate({ params: OwnerParams, body: DiscountScheduleBody }),
  asyncHandler(queueController.setDiscountSchedule),
);

queuesRouter.get(
  '/:ownerType/:ownerId',
  rateLimit('read'),
  optionalAuth,
  validate({ params: OwnerParams }),
  asyncHandler(queueController.getQueue),
);

// The caller's own place in this line (or null if not joined). Distinct path from the state GET.
queuesRouter.get(
  '/:ownerType/:ownerId/me',
  rateLimit('read'),
  authenticate,
  requirePermission('queue:join'),
  validate({ params: OwnerParams }),
  asyncHandler(queueController.getMembership),
);

queuesRouter.post(
  '/:ownerType/:ownerId/join',
  rateLimit('write'),
  authenticate,
  requirePermission('queue:join'),
  validate({ params: OwnerParams }),
  asyncHandler(queueController.join),
);

queuesRouter.delete(
  '/:ownerType/:ownerId/leave',
  rateLimit('write'),
  authenticate,
  requirePermission('queue:join'),
  validate({ params: OwnerParams }),
  asyncHandler(queueController.leave),
);

queuesRouter.post(
  '/:ownerType/:ownerId/checkout',
  rateLimit('money'),
  authenticate,
  requirePermission('queue:checkout'),
  idempotency,
  validate({ params: OwnerParams, body: CheckoutBody }),
  asyncHandler(queueController.checkout),
);

// ─── /wave-downs ──────────────────────────────────────────────────────────────────────────
export const waveDownsRouter = Router();

waveDownsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('wave:create'),
  validate({ body: CreateWaveDownBody }),
  asyncHandler(queueController.createWaveDown),
);

waveDownsRouter.post(
  '/:id/accept',
  rateLimit('write'),
  authenticate,
  requirePermission('wave:respond'),
  validate({ params: WaveIdParam, body: AcceptWaveBody }),
  asyncHandler(queueController.acceptWaveDown),
);

waveDownsRouter.post(
  '/:id/decline',
  rateLimit('write'),
  authenticate,
  requirePermission('wave:respond'),
  validate({ params: WaveIdParam, body: DeclineWaveBody }),
  asyncHandler(queueController.declineWaveDown),
);

// The customer's own wave-down history. MUST precede `/:id` so "mine" isn't matched as an id.
waveDownsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('wave:create'),
  asyncHandler(queueController.listMyWaveDowns),
);

// Fetch a single wave-down (customer who raised it, or the target owner — authorized in the service).
waveDownsRouter.get(
  '/:id',
  rateLimit('read'),
  authenticate,
  validate({ params: WaveIdParam }),
  asyncHandler(queueController.getWaveDown),
);

// Customer cancels their own still-pending wave-down.
waveDownsRouter.delete(
  '/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('wave:create'),
  validate({ params: WaveIdParam }),
  asyncHandler(queueController.cancelWaveDown),
);
