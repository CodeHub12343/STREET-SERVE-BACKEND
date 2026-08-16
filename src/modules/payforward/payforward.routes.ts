import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { requireModule } from '../../middleware/requireModule';
import { validate } from '../../middleware/validate';
import { payforwardController } from './payforward.controller';
import { BusinessIdParam, ContributeBody, FundSettingsBody } from './payforward.schema';

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
