import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { boostController } from './boost.controller';
import {
  BusinessIdParam,
  CampaignIdParam,
  CancelBody,
  ContributeBody,
  CreateCampaignBody,
  EstimateQuery,
  MailDateBody,
  MailingStatusBody,
} from './boost.schema';

/**
 * Boost My Marketing (ADR-006). Mounted at `/boost`.
 *
 * Reads are public for the same reason Pay It Forward's are: a campaign nobody can see raises
 * nothing. Nothing public exposes who gave, unless they asked to be named.
 */
export const boostRouter = Router();

boostRouter.get(
  '/estimate',
  rateLimit('read'),
  validate({ query: EstimateQuery }),
  // Now async: the rate is read from the print vendor (cached), not a configured constant.
  asyncHandler(boostController.estimate),
);

boostRouter.get(
  '/business/:businessId/current',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(boostController.current),
);

boostRouter.post(
  '/business/:businessId/campaigns',
  rateLimit('write'),
  authenticate,
  requirePermission('boost:manage'),
  validate({ params: BusinessIdParam, body: CreateCampaignBody }),
  asyncHandler(boostController.create),
);

boostRouter.get(
  '/campaigns/:campaignId',
  rateLimit('read'),
  validate({ params: CampaignIdParam }),
  asyncHandler(boostController.get),
);

boostRouter.get(
  '/campaigns/:campaignId/contributions',
  rateLimit('read'),
  validate({ params: CampaignIdParam }),
  asyncHandler(boostController.contributions),
);

/** Money in. `money` rate limit + idempotency, as on every charge path. */
boostRouter.post(
  '/campaigns/:campaignId/contributions',
  rateLimit('money'),
  authenticate,
  requirePermission('boost:contribute'),
  idempotency,
  validate({ params: CampaignIdParam, body: ContributeBody }),
  asyncHandler(boostController.contribute),
);

/** The owner covering their own shortfall — before the deadline only (ADR-006 §4). */
boostRouter.post(
  '/campaigns/:campaignId/top-up',
  rateLimit('money'),
  authenticate,
  requirePermission('boost:manage'),
  idempotency,
  validate({ params: CampaignIdParam }),
  asyncHandler(boostController.topUp),
);

boostRouter.post(
  '/campaigns/:campaignId/mail-date',
  rateLimit('write'),
  authenticate,
  requirePermission('boost:manage'),
  validate({ params: CampaignIdParam, body: MailDateBody }),
  asyncHandler(boostController.confirmMailDate),
);

boostRouter.post(
  '/campaigns/:campaignId/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('boost:manage'),
  validate({ params: CampaignIdParam, body: CancelBody }),
  asyncHandler(boostController.cancel),
);

/**
 * Ops-driven mailing pipeline. Admin-only because no print vendor is contracted yet (MB-8) — when
 * one is, its webhook calls this same transition and nothing else changes.
 */
boostRouter.post(
  '/campaigns/:campaignId/mailing-status',
  rateLimit('write'),
  authenticate,
  requirePermission('boost:administer'),
  validate({ params: CampaignIdParam, body: MailingStatusBody }),
  asyncHandler(boostController.advanceMailing),
);
