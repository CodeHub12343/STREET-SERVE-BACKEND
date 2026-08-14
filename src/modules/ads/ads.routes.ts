import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { AD_DURATION_TIERS, AD_PLACEMENTS } from '../../config/constants';
import { authenticate, optionalAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { body, params, query, validate } from '../../middleware/validate';
import { Latitude, Longitude } from '../../shared/geo';
import { PositiveCents } from '../../shared/money';
import { HttpUrl } from '../../shared/url';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { adsService } from './ads.service';

export const adsRouter = Router();

const PlacementIdParam = z.object({ id: z.string().length(24) }).strict();

const TierDays = z.union(
  AD_DURATION_TIERS.map((t) => z.literal(t.days)) as unknown as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ],
);

/**
 * Exactly one pricing model per purchase (spec §32): a flat tier OR a CPM budget. Enforced here
 * rather than resolved silently — a request carrying both prices is a request whose author does not
 * know what they will be charged, and picking one for them is how the wrong number gets billed.
 */
const oneOfTierOrBudget = (v: { tierDays?: number; budgetCents?: number }) =>
  (v.tierDays === undefined) !== (v.budgetCents === undefined);
const pricingMessage = 'Provide either tierDays (a flat promotion) or budgetCents (a CPM campaign), not both';

const FeatureBody = z
  .object({
    kind: z.enum(['featured_product', 'featured_hub']),
    subjectId: z.string().length(24),
    citySlug: z.string().min(1).max(64).optional(),
    tierDays: TierDays.optional(),
    budgetCents: PositiveCents.optional(),
    endsAt: z.string().datetime().optional(),
  })
  .strict()
  .refine(oneOfTierOrBudget, { message: pricingMessage });

const CampaignBody = z
  .object({
    placement: z.enum(AD_PLACEMENTS),
    headline: z.string().min(2).max(80),
    body: z.string().max(200).optional(),
    /**
     * `HttpUrl`, not `z.string().url()`. The latter delegates to the URL constructor, which accepts
     * `javascript:alert(1)` and `data:text/html,...` — and both of these are rendered by other
     * users' clients (`clickUrl` as an href, `imageUrl` as a background). An advertiser-supplied
     * `javascript:` href served onto strangers' maps is stored XSS, so the scheme is constrained
     * where the value ENTERS rather than hoping every render site remembers to be careful.
     */
    imageUrl: HttpUrl.optional(),
    clickUrl: HttpUrl.optional(),
    tierDays: TierDays.optional(),
    budgetCents: PositiveCents.optional(),
    citySlug: z.string().min(1).max(64).optional(),
    categories: z.array(z.string().max(40)).max(10).optional(),
    lng: Longitude.optional(),
    lat: Latitude.optional(),
    radiusM: z.number().int().min(500).max(80_000).optional(),
    businessId: z.string().length(24).optional(),
    endsAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => (v.lng === undefined) === (v.lat === undefined), {
    message: 'lng and lat must be provided together',
  })
  .refine(oneOfTierOrBudget, { message: pricingMessage });

const ServeQuery = z
  .object({
    placement: z.enum(AD_PLACEMENTS),
    citySlug: z.string().min(1).max(64).optional(),
    category: z.string().max(40).optional(),
    lng: z.coerce.number().pipe(Longitude).optional(),
    lat: z.coerce.number().pipe(Latitude).optional(),
    feedSize: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/**
 * The price list. Public and unauthenticated: a vendor deciding whether this product is for them
 * should be able to see what it costs before they have an account, and the promote screen must
 * never hardcode a price that could drift from the one actually charged.
 */
adsRouter.get(
  '/pricing',
  rateLimit('read'),
  asyncHandler((_req: Request, res: Response) => {
    ok(res, adsService.pricing());
    return Promise.resolve();
  }),
);

/** F-1 — buy featured placement for a product or hub you own. */
adsRouter.post(
  '/featured',
  rateLimit('money'),
  authenticate,
  validate({ body: FeatureBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await adsService.feature(principal(req), body<z.infer<typeof FeatureBody>>(req)));
  }),
);

/** F-3 — create a CPM campaign. Budget is prepaid and spent down. */
adsRouter.post(
  '/campaigns',
  rateLimit('money'),
  authenticate,
  validate({ body: CampaignBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await adsService.createCampaign(principal(req), body<z.infer<typeof CampaignBody>>(req)),
    );
  }),
);

/** The advertiser's own placements with real delivery numbers — replaces manual reporting. */
adsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const businessId = (req.query as { businessId?: string }).businessId;
    ok(res, await adsService.mine(principal(req), businessId));
  }),
);

/**
 * Resume an abandoned checkout — returns the client secret for a placement that was created but
 * never paid for. `money` rate limit because it opens a charge, even though Stripe's idempotency
 * means it re-opens the SAME one rather than a second.
 */
adsRouter.post(
  '/:id/pay',
  rateLimit('money'),
  authenticate,
  validate({ params: PlacementIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PlacementIdParam>>(req);
    ok(res, await adsService.resumePayment(principal(req), id));
  }),
);

adsRouter.post(
  '/:id/pause',
  rateLimit('write'),
  authenticate,
  validate({ params: PlacementIdParam, body: z.object({ paused: z.boolean() }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PlacementIdParam>>(req);
    const { paused } = body<{ paused: boolean }>(req);
    ok(res, await adsService.pause(principal(req), id, paused));
  }),
);

/**
 * Serve ads for a surface. `optionalAuth` because ad-supported surfaces include public discovery —
 * and every returned ad carries its `label`, which the client must render.
 */
adsRouter.get(
  '/serve',
  rateLimit('read'),
  optionalAuth,
  validate({ query: ServeQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await adsService.serve(query<z.infer<typeof ServeQuery>>(req)));
  }),
);

adsRouter.post(
  '/:id/click',
  rateLimit('write'),
  optionalAuth,
  validate({ params: PlacementIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await adsService.recordClick(params<z.infer<typeof PlacementIdParam>>(req).id));
  }),
);
