import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { FULFILLMENT_DELIVERABLE_TYPES } from './sponsorFulfillment.model';
import { sponsorFulfillmentService } from './sponsorFulfillment.service';

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

const IdParam = z.object({ id: z.string().length(24) }).strict();
const LogBody = z
  .object({
    deliverableType: z.enum(FULFILLMENT_DELIVERABLE_TYPES),
    /** Signed integer; 0 is rejected server-side. Negative = correction of a prior over-log. */
    count: z.number().int().min(-10_000).max(10_000),
    proofUrl: z.string().url().max(2048).optional(),
    note: z.string().max(500).optional(),
    deliveredAt: z.string().datetime().optional(),
  })
  .strict();

// ─── Admin — read fulfilment, log a delivery ───────────────────────────────
export const sponsorFulfillmentAdminRouter = Router();

sponsorFulfillmentAdminRouter.get(
  '/sponsors/:id/fulfillment',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const row = await sponsorFulfillmentService.getForSponsor(
      params<z.infer<typeof IdParam>>(req).id,
    );
    ok(res, row ?? { empty: true });
  }),
);

sponsorFulfillmentAdminRouter.post(
  '/sponsors/:id/fulfillment/log',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ params: IdParam, body: LogBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = body<z.infer<typeof LogBody>>(req);
    created(
      res,
      await sponsorFulfillmentService.logDelivery(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        {
          deliverableType: parsed.deliverableType,
          count: parsed.count,
          proofUrl: parsed.proofUrl,
          note: parsed.note,
          deliveredAt: parsed.deliveredAt ? new Date(parsed.deliveredAt) : undefined,
        },
      ),
    );
  }),
);

// ─── Sponsor-facing — the owner's own campaign only ────────────────────────
export const sponsorFulfillmentPublicRouter = Router();

sponsorFulfillmentPublicRouter.get(
  '/me/fulfillment',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const row = await sponsorFulfillmentService.getForOwner(principal(req).userId);
    ok(res, row ?? { empty: true });
  }),
);
