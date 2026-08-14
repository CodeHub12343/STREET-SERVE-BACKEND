import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { growthController } from './growth.controller';
import {
  BudgetStatusBody,
  BusinessIdParam,
  CreateGiftBody,
  CreateGiveawayBody,
  FundBudgetBody,
  GiftCodeParam,
  GiveawayIdParam,
  PingIdParam,
  QualifyBody,
  ShareBody,
  SpotMeDecideBody,
  SpotMeIdParam,
  SpotMeRequestBody,
} from './growth.schema';

// Ping budgets (vendor-owned; service checks ownership).
export const pingBudgetsRouter = Router();
pingBudgetsRouter.get(
  '/:businessId',
  rateLimit('read'),
  authenticate,
  requirePermission('ping:manage_budget'),
  validate({ params: BusinessIdParam }),
  asyncHandler(growthController.getBudget),
);
pingBudgetsRouter.post(
  '/:businessId',
  rateLimit('money'),
  authenticate,
  requirePermission('ping:manage_budget'),
  validate({ params: BusinessIdParam, body: FundBudgetBody }),
  asyncHandler(growthController.fundBudget),
);
pingBudgetsRouter.patch(
  '/:businessId',
  rateLimit('write'),
  authenticate,
  requirePermission('ping:manage_budget'),
  validate({ params: BusinessIdParam, body: BudgetStatusBody }),
  asyncHandler(growthController.setBudgetStatus),
);

// Pings.
export const pingsRouter = Router();
pingsRouter.post(
  '/',
  rateLimit('money'), // strict: the paid-share economy is a fraud surface
  authenticate,
  requirePermission('ping:share'),
  validate({ body: ShareBody }),
  asyncHandler(growthController.share),
);
pingsRouter.post(
  '/:id/qualify',
  rateLimit('money'),
  authenticate,
  requirePermission('ping:qualify'),
  validate({ params: PingIdParam, body: QualifyBody }),
  asyncHandler(growthController.qualify),
);
pingsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('ping:share'),
  asyncHandler(growthController.listMyPings),
);

// Gifts.
export const giftsRouter = Router();
giftsRouter.post(
  '/',
  rateLimit('money'),
  authenticate,
  requirePermission('gift:create'),
  idempotency,
  validate({ body: CreateGiftBody }),
  asyncHandler(growthController.createGift),
);
giftsRouter.post(
  '/:code/redeem',
  rateLimit('write'),
  authenticate,
  requirePermission('gift:redeem'),
  validate({ params: GiftCodeParam }),
  asyncHandler(growthController.redeemGift),
);

// Giveaways.
export const giveawaysRouter = Router();
giveawaysRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('giveaway:manage'),
  validate({ body: CreateGiveawayBody }),
  asyncHandler(growthController.createGiveaway),
);
giveawaysRouter.post(
  '/:id/claim',
  rateLimit('write'),
  authenticate,
  requirePermission('giveaway:claim'),
  validate({ params: GiveawayIdParam }),
  asyncHandler(growthController.claimGiveaway),
);

// Spot Me.
export const spotMeRouter = Router();
// The requester's own obligations — powers the wallet's Spot-Me section (C-35).
spotMeRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('spot_me:request'),
  asyncHandler(growthController.listMySpotMe),
);
spotMeRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('spot_me:request'),
  validate({ body: SpotMeRequestBody }),
  asyncHandler(growthController.requestSpotMe),
);
spotMeRouter.post(
  '/:id/decide',
  rateLimit('write'),
  authenticate,
  requirePermission('spot_me:decide'),
  validate({ params: SpotMeIdParam, body: SpotMeDecideBody }),
  asyncHandler(growthController.decideSpotMe),
);
spotMeRouter.post(
  '/:id/repay',
  rateLimit('write'),
  authenticate,
  requirePermission('spot_me:repay'),
  validate({ params: SpotMeIdParam }),
  asyncHandler(growthController.repaySpotMe),
);
