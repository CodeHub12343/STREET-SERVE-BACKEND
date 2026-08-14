import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { params, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { ownsBusiness } from '../vendors/vendors.controller';
import { dashboardService } from './dashboard.service';

// Mounted at /businesses — GET /businesses/:id/dashboard.
export const dashboardRouter = Router();

const BusinessIdParam = z.object({ id: z.string().length(24) }).strict();

dashboardRouter.get(
  '/:id/dashboard',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('dashboard:view', ownsBusiness),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await dashboardService.getVendorDashboard(req.principal, id));
  }),
);

// V-11 analytics — sales/orders/queue metrics computed from the business's own activity.
dashboardRouter.get(
  '/:id/analytics',
  rateLimit('read'),
  authenticate,
  validate({ params: BusinessIdParam }),
  requirePermission('dashboard:view', ownsBusiness),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await dashboardService.getVendorAnalytics(req.principal, id));
  }),
);
