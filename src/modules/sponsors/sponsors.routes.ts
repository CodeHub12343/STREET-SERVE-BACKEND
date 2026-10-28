import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { SPONSOR_PROGRAMS } from '../../config/constants';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { sponsorsService } from './sponsors.service';

const ProgramQuery = z
  .object({ program: z.enum(SPONSOR_PROGRAMS).optional() })
  .strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

// Public: logo placement + impression + pre-registration.
export const sponsorsPublicRouter = Router();

sponsorsPublicRouter.get(
  '/',
  rateLimit('read'),
  validate({ query: ProgramQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as z.infer<typeof ProgramQuery>;
    ok(res, await sponsorsService.listActive(q.program ?? null));
  }),
);

const ImpressionBody = z.object({ utmCode: z.string().min(1).max(64) }).strict();
sponsorsPublicRouter.post(
  '/impression',
  rateLimit('read'),
  validate({ body: ImpressionBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await sponsorsService.recordImpression(body<z.infer<typeof ImpressionBody>>(req).utmCode),
    );
  }),
);

/**
 * The public rate card. Priced in code, so a sponsor and the server never disagree on the price.
 * Program-aware: `?program=ice_cream_giveaway` returns the Great Ice Cream Giveaway packages;
 * no param returns the platform tiers (default).
 */
sponsorsPublicRouter.get(
  '/tiers',
  rateLimit('read'),
  validate({ query: ProgramQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as z.infer<typeof ProgramQuery>;
    ok(res, sponsorsService.listTiers(q.program ?? null));
  }),
);

/**
 * The signed-in sponsor's reach + attribution — the figures the campaign dashboard shows next to
 * fulfilment counts. Separate from `/me/fulfillment` because the fulfilment tracker only exists
 * for approved sponsors with countable deliverables, whereas reach stats apply to EVERY active
 * sponsorship (including platform logo-only placements).
 */
sponsorsPublicRouter.get(
  '/me/stats',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const stats = await sponsorsService.getOwnStats(principal(req));
    ok(res, stats ?? { empty: true });
  }),
);

/**
 * Owner self-service — the fields a sponsor can change about their own public profile. Narrow
 * on purpose: tier, logo, slug, and status stay admin-controlled.
 */
const OwnProfileBody = z
  .object({
    websiteUrl: z.string().url().max(2048).nullable().optional(),
    about: z.string().max(500).nullable().optional(),
  })
  .strict();
sponsorsPublicRouter.patch(
  '/me/profile',
  rateLimit('write'),
  authenticate,
  validate({ body: OwnProfileBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await sponsorsService.updateOwnProfile(
        principal(req),
        body<z.infer<typeof OwnProfileBody>>(req),
      ),
    );
  }),
);

/**
 * Public sponsor profile — resolved by slug or UTM code. The service hard-gates on tier, so a
 * Silver sponsor's URL returns 404 even if they set profile fields. Placed AFTER `/tiers`,
 * `/me/*`, and `/impression` so it does not shadow them.
 */
const SlugParam = z.object({ slug: z.string().min(1).max(80) }).strict();

/**
 * Buy a placement. Opens a Stripe charge and returns its client secret — it publishes NOTHING.
 *
 * Authenticated on purpose: a sponsorship has an owner who must be told when it goes live, when it
 * is refused, and when the term ends, and an anonymous buyer can be told none of those things.
 */
const PurchaseBody = z
  .object({
    name: z.string().min(1).max(160),
    tier: z.string().min(1).max(40),
    /**
     * Platform sponsorships are priced monthly, so a term is required; giveaway packages are a
     * one-time price with a fixed 90-day window, so any value is accepted and ignored by the
     * server. The schema stays permissive here and the service picks the right branch.
     */
    termMonths: z.number().int().min(1).max(24),
    logoUrl: z.string().url().max(2048).optional(),
    contactEmail: z.string().email(),
    launchCitySlug: z.string().max(64).optional(),
    program: z.enum(SPONSOR_PROGRAMS).optional(),
  })
  .strict();
sponsorsPublicRouter.post(
  '/purchase',
  rateLimit('write'),
  authenticate,
  idempotency,
  validate({ body: PurchaseBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await sponsorsService.purchase(
        principal(req),
        body<z.infer<typeof PurchaseBody>>(req),
        req.header('Idempotency-Key') ?? '',
      ),
    );
  }),
);

/**
 * Mounted last on the public router so it does NOT shadow `/tiers`, `/me/stats`, `/me/profile`,
 * `/me/fulfillment`, `/impression`, or `/purchase` above.
 */
sponsorsPublicRouter.get(
  '/:slug',
  rateLimit('read'),
  validate({ params: SlugParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await sponsorsService.getPublicProfile(params<z.infer<typeof SlugParam>>(req).slug),
    );
  }),
);

export const preregistrationsRouter = Router();
const PreregisterBody = z
  .object({
    fullName: z.string().min(1).max(160),
    email: z.string().email(),
    phone: z.string().max(40).optional(),
    intendedRole: z.enum(['customer', 'seller', 'vendor', 'hub', 'sponsor']).optional(),
    citySlug: z.string().max(64).optional(),
    utmCode: z.string().max(64).optional(),
  })
  .strict();
preregistrationsRouter.post(
  '/',
  rateLimit('write'),
  validate({ body: PreregisterBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await sponsorsService.preregister(body<z.infer<typeof PreregisterBody>>(req)));
  }),
);

// Public waitlist count for the landing page metrics strip (no PII).
preregistrationsRouter.get(
  '/count',
  rateLimit('read'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await sponsorsService.preregistrationCount());
  }),
);

// Admin: manage sponsors + reporting.
export const sponsorsAdminRouter = Router();
const CreateSponsorBody = z
  .object({
    name: z.string().min(1).max(160),
    utmCode: z.string().min(1).max(64),
    logoUrl: z.string().url().max(2048).optional(),
    tier: z.string().max(40).optional(),
    program: z.enum(SPONSOR_PROGRAMS).optional(),
    launchCitySlug: z.string().max(64).optional(),
    /** Recorded by hand. Nothing is collected — see the model. */
    contractedCents: z.number().int().min(0).max(100_000_000).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
const UpdateSponsorBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    logoUrl: z.string().url().max(2048).nullable().optional(),
    tier: z.string().max(40).optional(),
    program: z.enum(SPONSOR_PROGRAMS).optional(),
    launchCitySlug: z.string().max(64).nullable().optional(),
    contractedCents: z.number().int().min(0).max(100_000_000).optional(),
    note: z.string().max(500).nullable().optional(),
    /** False ends the sponsorship: the logo comes down and the UTM stops attributing. */
    active: z.boolean().optional(),
  })
  .strict();
const IdParam = z.object({ id: z.string().length(24) }).strict();

sponsorsAdminRouter.post(
  '/sponsors',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ body: CreateSponsorBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await sponsorsService.create(principal(req), body<z.infer<typeof CreateSponsorBody>>(req)),
    );
  }),
);

/**
 * The roster. This did not exist, so the admin screen requested it, got a 404, and sat on its
 * loading skeleton for ever — a page that could only ever be blank.
 */
sponsorsAdminRouter.get(
  '/sponsors',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ query: ProgramQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as z.infer<typeof ProgramQuery>;
    ok(res, await sponsorsService.listAll(q.program ? { program: q.program } : {}));
  }),
);

/** Edit a sponsorship, including ending one — `active` was previously reachable by nothing. */
sponsorsAdminRouter.patch(
  '/sponsors/:id',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ params: IdParam, body: UpdateSponsorBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await sponsorsService.update(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        body<z.infer<typeof UpdateSponsorBody>>(req),
      ),
    );
  }),
);

/**
 * Approve a paid placement. THIS is what puts a logo on the landing page — not the payment.
 * Publishing on payment alone would let anyone with a card put an arbitrary image on the site.
 */
sponsorsAdminRouter.post(
  '/sponsors/:id/approve',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sponsorsService.approve(principal(req), params<z.infer<typeof IdParam>>(req).id));
  }),
);

/** Refuse a placement, refunding it. A reason is REQUIRED — the sponsor is told what it was. */
const RejectBody = z.object({ reason: z.string().min(3).max(300) }).strict();
sponsorsAdminRouter.post(
  '/sponsors/:id/reject',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ params: IdParam, body: RejectBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await sponsorsService.reject(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        body<z.infer<typeof RejectBody>>(req).reason,
      ),
    );
  }),
);

/**
 * The waitlist. It was writable by the public and readable by nothing — the only endpoint was a
 * bare count — so every lead the landing page collected, including would-be sponsors, landed in a
 * collection no screen exposed.
 */
const PreregQuery = z.object({ intendedRole: z.string().max(32).optional() }).strict();
sponsorsAdminRouter.get(
  '/preregistrations',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ query: PreregQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as z.infer<typeof PreregQuery>;
    ok(res, await sponsorsService.listPreregistrations(q.intendedRole ? { intendedRole: q.intendedRole } : {}));
  }),
);

sponsorsAdminRouter.get(
  '/sponsors/:id/report',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_sponsors'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await sponsorsService.report(principal(req), params<z.infer<typeof IdParam>>(req).id));
  }),
);
