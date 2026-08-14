import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { aiService } from './ai.service';
import {
  CoachPlanBody,
  CoachingBody,
  HubIdParam,
  PricingQuery,
  RecIdParam,
  RecommendQuery,
} from './ai.schema';
import { incomeCoach } from './incomeCoach';
import { outcomesService } from './outcomes.service';

export const aiRouter = Router();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/**
 * E-9 — the Income Coach. "To earn $100 today, sell these 12 items at these locations."
 *
 * A plan is allowed to fall SHORT of the goal (`achievable: false`) rather than being padded to
 * reach it. See `incomeCoach` for why that matters more here than almost anywhere else in the app.
 */
aiRouter.post(
  '/coach/plan',
  rateLimit('ai'),
  authenticate,
  requirePermission('ai:recommend'),
  validate({ body: CoachPlanBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<z.infer<typeof CoachPlanBody>>(req);
    ok(res, await incomeCoach.plan(principal(req), input));
  }),
);

/**
 * E-1 — dataset health. The number to check before switching AI_PROVIDER to `forecast`: a forecast
 * built on a handful of rows is a guess wearing a lab coat.
 */
aiRouter.get(
  '/outcomes/stats',
  rateLimit('read'),
  authenticate,
  // An ops readiness metric, not a seller feature — gated with the other admin overview reads.
  requirePermission('admin:read_overview'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await outcomesService.stats());
  }),
);

/** E-10 — where a hub's stock would sell better than it does here. Owner-gated in the service. */
aiRouter.get(
  '/hubs/:id/reallocation',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    const { consignmentService } = await import('../consignment/consignment.service');
    await consignmentService.assertHubOwnerFor(principal(req), id);
    ok(res, await incomeCoach.reallocationAdvice(id));
  }),
);

aiRouter.get(
  '/recommendations/products',
  rateLimit('ai'),
  authenticate,
  requirePermission('ai:recommend'),
  validate({ query: RecommendQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof RecommendQuery>>(req);
    ok(
      res,
      await aiService.recommendProducts(
        principal(req),
        { lat: q.lat, lng: q.lng, hourUtc: q.hourUtc },
        q.limit,
      ),
    );
  }),
);

aiRouter.get(
  '/recommendations/locations',
  rateLimit('ai'),
  authenticate,
  requirePermission('ai:recommend'),
  validate({ query: RecommendQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof RecommendQuery>>(req);
    ok(
      res,
      await aiService.recommendLocations(
        principal(req),
        { lat: q.lat, lng: q.lng, hourUtc: q.hourUtc },
        q.limit,
      ),
    );
  }),
);

aiRouter.post(
  '/recommendations/:id/accept',
  rateLimit('write'),
  authenticate,
  requirePermission('ai:recommend'),
  validate({ params: RecIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await aiService.accept(principal(req), params<z.infer<typeof RecIdParam>>(req).id));
  }),
);

aiRouter.get(
  '/pricing-suggestion',
  rateLimit('ai'),
  authenticate,
  requirePermission('ai:pricing'),
  validate({ query: PricingQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof PricingQuery>>(req);
    ok(res, await aiService.suggestPricing(principal(req), q.productId));
  }),
);

aiRouter.post(
  '/sales-coaching',
  rateLimit('ai'),
  authenticate,
  requirePermission('ai:coaching'),
  validate({ body: CoachingBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const b = body<z.infer<typeof CoachingBody>>(req);
    ok(res, await aiService.coaching(b.objection, b.context));
  }),
);

aiRouter.get(
  '/hubs/:id/dashboard',
  rateLimit('read'),
  authenticate,
  requirePermission('ai:hub_dashboard'),
  validate({ params: HubIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await aiService.hubDashboard(principal(req), params<z.infer<typeof HubIdParam>>(req).id),
    );
  }),
);
