import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { brandsService } from './brands.service';
import { brandOperatorService } from './brandOperator.service';
import { brandPayoutsService } from './brandPayouts.service';
import { brandInviteService } from './brandInvite.service';
import { brandMembershipService } from './brandMembership.service';
import { BrandSplitModel } from './brandSplit.model';
import { BrandModel } from './brands.model';
import { UserModel } from '../identity/identity.model';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 0 admin routes. ═══
 *
 * Admin-only in Phase 0. Phase 3 adds self-service invite flows at `/brands/me/*` for the
 * signed-in owner.
 */

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

const IdParam = z.object({ id: z.string().length(24) }).strict();

const CreateBrandBody = z
  .object({
    name: z.string().min(1).max(160),
    ownerUserId: z.string().min(1).max(80),
    logoUrl: z.string().url().max(2048).nullable().optional(),
    coverPhotoUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict();

const AttachBusinessBody = z
  .object({
    businessId: z.string().length(24),
  })
  .strict();

// ─── Public: trucks of a brand for the profile sheet ──────────────────────────────────────
export const brandsPublicRouter = Router();

const BusinessIdParam = z.object({ businessId: z.string().length(24) }).strict();
brandsPublicRouter.get(
  '/businesses/:businessId/trucks',
  rateLimit('read'),
  validate({ params: BusinessIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await brandOperatorService.publicTrucksForBusiness(
      params<z.infer<typeof BusinessIdParam>>(req).businessId,
    );
    ok(res, result ?? { brand: null, trucks: [] });
  }),
);

export const brandsAdminRouter = Router();

brandsAdminRouter.get(
  '/brands',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await brandsService.list());
  }),
);

brandsAdminRouter.get(
  '/brands/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await brandsService.get(params<z.infer<typeof IdParam>>(req).id));
  }),
);

brandsAdminRouter.post(
  '/brands',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ body: CreateBrandBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await brandsService.create(principal(req), body<z.infer<typeof CreateBrandBody>>(req)),
    );
  }),
);

brandsAdminRouter.post(
  '/brands/:id/businesses',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam, body: AttachBusinessBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandsService.attachBusiness(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        body<z.infer<typeof AttachBusinessBody>>(req).businessId,
      ),
    );
  }),
);

// ─── Phase 5 — convert single-owner business to brand ──────────────────────────────────────
const BusinessIdParamAdmin = z.object({ businessId: z.string().length(24) }).strict();
const ConvertBody = z
  .object({
    brandName: z.string().min(1).max(160).optional(),
    seedOperators: z
      .array(
        z
          .object({
            userId: z.string().min(1).max(80),
            displayName: z.string().min(1).max(80),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

brandsAdminRouter.post(
  '/businesses/:businessId/convert-to-brand',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: BusinessIdParamAdmin, body: ConvertBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await brandsService.convertBusinessToBrand(
        principal(req),
        params<z.infer<typeof BusinessIdParamAdmin>>(req).businessId,
        body<z.infer<typeof ConvertBody>>(req),
      ),
    );
  }),
);

// ─── Phase 5 — short-lived brand-owner impersonation grant ─────────────────────────────────
const ImpersonateBody = z.object({ reason: z.string().min(3).max(500) }).strict();
brandsAdminRouter.post(
  '/brands/:id/impersonate',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam, body: ImpersonateBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await brandsService.grantImpersonation(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        body<z.infer<typeof ImpersonateBody>>(req).reason,
      ),
    );
  }),
);

// ─── Phase 1 — brand operators (per-truck live-map actors) ─────────────────────────────────
const CreateOperatorBody = z
  .object({
    businessId: z.string().length(24),
    userId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
  })
  .strict();

brandsAdminRouter.get(
  '/brands/:id/operators',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await brandOperatorService.listForBrand(params<z.infer<typeof IdParam>>(req).id));
  }),
);

brandsAdminRouter.post(
  '/brands/:id/operators',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam, body: CreateOperatorBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const dto = body<z.infer<typeof CreateOperatorBody>>(req);
    created(
      res,
      await brandOperatorService.create(principal(req), {
        brandId: params<z.infer<typeof IdParam>>(req).id,
        businessId: dto.businessId,
        userId: dto.userId,
        displayName: dto.displayName,
      }),
    );
  }),
);

const OperatorIdParam = z.object({ operatorId: z.string().length(24) }).strict();
brandsAdminRouter.post(
  '/brand-operators/:operatorId/retire',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: OperatorIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandOperatorService.retire(
        principal(req),
        params<z.infer<typeof OperatorIdParam>>(req).operatorId,
      ),
    );
  }),
);

// ─── Phase 2 — payout policy ────────────────────────────────────────────────────────────────
const PolicyBody = z
  .object({
    mode: z.enum(['pooled', 'per_operator']),
    splits: z
      .array(
        z
          .object({
            operatorId: z.string().length(24),
            shareBps: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

brandsAdminRouter.get(
  '/brands/:id/payout-policy',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await brandPayoutsService.getPolicy(params<z.infer<typeof IdParam>>(req).id));
  }),
);

brandsAdminRouter.put(
  '/brands/:id/payout-policy',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam, body: PolicyBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandPayoutsService.setPolicy(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        body<z.infer<typeof PolicyBody>>(req),
      ),
    );
  }),
);

/**
 * Earnings surface — one query reads the last N splits for a brand and aggregates per-operator
 * paid/fallback totals. Admin-only in Phase 2; Phase 3 adds a brand-owner self-service view.
 */
brandsAdminRouter.get(
  '/brands/:id/earnings',
  rateLimit('read'),
  authenticate,
  requirePermission('admin:manage_businesses'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const brandId = params<z.infer<typeof IdParam>>(req).id;
    const legs = await BrandSplitModel.find({ brand_id: brandId })
      .sort({ created_at: -1 })
      .limit(500)
      .lean()
      .exec();
    /** Aggregate per operator — paid + fallback separately, so operations can see what the
     *  brand owner still owes a mis-approved operator. */
    const perOperator = new Map<
      string,
      { operatorId: string; paidCents: number; fallbackCents: number; reversedCents: number }
    >();
    for (const leg of legs) {
      const key = String(leg.operator_id);
      const row =
        perOperator.get(key) ??
        { operatorId: key, paidCents: 0, fallbackCents: 0, reversedCents: 0 };
      if (leg.status === 'paid') row.paidCents += leg.net_cents;
      else if (leg.status === 'fallback_to_owner') row.fallbackCents += leg.net_cents;
      else if (leg.status === 'reversed') row.reversedCents += leg.net_cents;
      perOperator.set(key, row);
    }
    const totalPaid = legs
      .filter((l) => l.status === 'paid')
      .reduce((s, l) => s + l.net_cents, 0);
    const totalFallback = legs
      .filter((l) => l.status === 'fallback_to_owner')
      .reduce((s, l) => s + l.net_cents, 0);
    const totalReversed = legs
      .filter((l) => l.status === 'reversed')
      .reduce((s, l) => s + l.net_cents, 0);
    ok(res, {
      brandId,
      totals: {
        paidCents: totalPaid,
        fallbackCents: totalFallback,
        reversedCents: totalReversed,
      },
      perOperator: [...perOperator.values()],
      recentLegs: legs.slice(0, 50).map((l) => ({
        id: String(l._id),
        transactionId: l.transaction_id,
        operatorId: String(l.operator_id),
        shareBps: l.share_bps,
        netCents: l.net_cents,
        status: l.status,
        fallbackReason: l.fallback_reason ?? null,
        createdAt: l.created_at ?? null,
      })),
    });
  }),
);

// ─── Phase 2 — operator-side & owner-side payout flows ────────────────────────────────────
/**
 * Signed-in operator starts Stripe-Connect onboarding for their truck. The service checks the
 * operator row belongs to this user before creating the onboarding link.
 */
const StripeOnboardBody = z
  .object({ email: z.string().email().optional() })
  .strict();

/** Operator-initiated: the operator's own self-service onboarding. Not admin-scoped. */
export const brandOperatorPrivateRouter = Router();
brandOperatorPrivateRouter.post(
  '/brand-operators/:operatorId/stripe-onboard',
  rateLimit('write'),
  authenticate,
  validate({ params: OperatorIdParam, body: StripeOnboardBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandOperatorService.startOperatorOnboarding(
        principal(req),
        params<z.infer<typeof OperatorIdParam>>(req).operatorId,
        body<z.infer<typeof StripeOnboardBody>>(req).email,
      ),
    );
  }),
);

/**
 * Brand owner approves (or revokes) an operator's connected account for routing. Lives on the
 * authenticated private router rather than admin — the brand owner is normally not a platform
 * admin.
 */
const ApprovalBody = z.object({ approved: z.boolean() }).strict();
brandOperatorPrivateRouter.post(
  '/brand-operators/:operatorId/payout-approval',
  rateLimit('write'),
  authenticate,
  validate({ params: OperatorIdParam, body: ApprovalBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandOperatorService.setOwnerApproval(
        principal(req),
        params<z.infer<typeof OperatorIdParam>>(req).operatorId,
        body<z.infer<typeof ApprovalBody>>(req).approved,
      ),
    );
  }),
);

// Suppress unused imports when BrandModel isn't referenced in this file path.
void BrandModel;

// ─── Phase 3 — invites, memberships, and the brand overview ────────────────────────────────
const InviteBody = z
  .object({
    inviteeEmail: z.string().email().max(160),
    role: z.enum(['manager', 'operator']),
    scopedBusinessIds: z.array(z.string().length(24)).max(50).optional(),
    seatOperator: z
      .object({
        businessId: z.string().length(24),
        displayName: z.string().min(1).max(80),
      })
      .strict()
      .optional(),
  })
  .strict();

const InviteIdParam = z.object({ inviteId: z.string().length(24) }).strict();
const TokenParam = z.object({ token: z.string().min(10).max(128) }).strict();
const RevokeBody = z.object({ reason: z.string().max(300).optional() }).strict();

/**
 * Owner / manager routes for a brand — not admin-scoped, since the brand owner is normally
 * not a platform admin. All of these resolve the acting principal through the service's own
 * `assertCanInvite` or membership-level guards.
 */
brandOperatorPrivateRouter.post(
  '/brands/:id/invites',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam, body: InviteBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await brandInviteService.create(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
        body<z.infer<typeof InviteBody>>(req),
      ),
    );
  }),
);

brandOperatorPrivateRouter.get(
  '/brands/:id/invites',
  rateLimit('read'),
  authenticate,
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandInviteService.listForBrand(
        principal(req),
        params<z.infer<typeof IdParam>>(req).id,
      ),
    );
  }),
);

brandOperatorPrivateRouter.post(
  '/brand-invites/:inviteId/revoke',
  rateLimit('write'),
  authenticate,
  validate({ params: InviteIdParam, body: RevokeBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandInviteService.revoke(
        principal(req),
        params<z.infer<typeof InviteIdParam>>(req).inviteId,
        body<z.infer<typeof RevokeBody>>(req).reason,
      ),
    );
  }),
);

/**
 * The brand overview — the one screen a franchise owner opens when they want to know what's
 * happening across their trucks right now. Owner or manager only.
 */
brandOperatorPrivateRouter.get(
  '/brands/:id/overview',
  rateLimit('read'),
  authenticate,
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const brandId = params<z.infer<typeof IdParam>>(req).id;
    await brandMembershipService.requireOwnerOrManager(principal(req).userId, brandId);
    ok(res, await brandMembershipService.overview(brandId));
  }),
);

/**
 * Signed-in user's brand memberships — drives the role switcher's brand entries + the brand
 * selector in the dashboard shell.
 */
brandOperatorPrivateRouter.get(
  '/me/brand-memberships',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await brandMembershipService.listForUser(principal(req)));
  }),
);

// ─── 2026-10-28 — self-serve brand creation + convert ────────────────────────────────────
const CreateBrandSelfBody = z
  .object({
    name: z.string().min(1).max(160),
    logoUrl: z.string().url().max(2048).nullable().optional(),
    coverPhotoUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict();

brandOperatorPrivateRouter.post(
  '/me/brands',
  rateLimit('write'),
  authenticate,
  validate({ body: CreateBrandSelfBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await brandsService.createForSelf(
        principal(req),
        body<z.infer<typeof CreateBrandSelfBody>>(req),
      ),
    );
  }),
);

const BusinessIdPathParam = z.object({ businessId: z.string().length(24) }).strict();
const ConvertSelfBody = z
  .object({
    brandName: z.string().min(1).max(160).optional(),
    seedOperators: z
      .array(
        z
          .object({
            userId: z.string().min(1).max(80),
            displayName: z.string().min(1).max(80),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

brandOperatorPrivateRouter.post(
  '/me/businesses/:businessId/convert-to-brand',
  rateLimit('write'),
  authenticate,
  validate({ params: BusinessIdPathParam, body: ConvertSelfBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await brandsService.convertOwnBusinessToBrand(
        principal(req),
        params<z.infer<typeof BusinessIdPathParam>>(req).businessId,
        body<z.infer<typeof ConvertSelfBody>>(req),
      ),
    );
  }),
);

/**
 * Owner-self-serve set payout policy. Delegates to the same service as the admin route; the
 * service checks the actor is permitted via the Brand owner/membership check.
 */
brandOperatorPrivateRouter.put(
  '/me/brands/:id/payout-policy',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam, body: PolicyBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const brandId = params<z.infer<typeof IdParam>>(req).id;
    /** Guard: only the brand owner may change their own policy. */
    const { BrandModel } = await import('./brands.model');
    const brand = await BrandModel.findById(brandId).select('owner_user_id').lean().exec();
    if (!brand || brand.owner_user_id !== principal(req).userId) {
      // 404 not 403 — don't advertise brand existence to someone unauthorized.
      throw new (await import('../../shared/errors/AppError')).AppError({
        code: 'NOT_FOUND' as never,
        message: 'Brand not found',
        httpStatus: 404,
      });
    }
    ok(
      res,
      await brandPayoutsService.setPolicy(
        principal(req),
        brandId,
        body<z.infer<typeof PolicyBody>>(req),
      ),
    );
  }),
);

/** Owner self-serve retire — the operator route the admin had, now owner-callable. */
brandOperatorPrivateRouter.post(
  '/me/brand-operators/:operatorId/retire',
  rateLimit('write'),
  authenticate,
  validate({ params: OperatorIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await brandOperatorService.retire(
        principal(req),
        params<z.infer<typeof OperatorIdParam>>(req).operatorId,
      ),
    );
  }),
);

/** Owner self-serve add-operator (seat a new truck). Mirrors the admin create. */
const SelfSeatOperatorBody = z
  .object({
    businessId: z.string().length(24),
    userId: z.string().min(1).max(80),
    displayName: z.string().min(1).max(80),
  })
  .strict();
brandOperatorPrivateRouter.post(
  '/me/brands/:id/operators',
  rateLimit('write'),
  authenticate,
  validate({ params: IdParam, body: SelfSeatOperatorBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const brandId = params<z.infer<typeof IdParam>>(req).id;
    const { BrandModel } = await import('./brands.model');
    const brand = await BrandModel.findById(brandId).select('owner_user_id').lean().exec();
    if (!brand || brand.owner_user_id !== principal(req).userId) {
      throw new (await import('../../shared/errors/AppError')).AppError({
        code: 'NOT_FOUND' as never,
        message: 'Brand not found',
        httpStatus: 404,
      });
    }
    const dto = body<z.infer<typeof SelfSeatOperatorBody>>(req);
    created(
      res,
      await brandOperatorService.create(principal(req), {
        brandId,
        businessId: dto.businessId,
        userId: dto.userId,
        displayName: dto.displayName,
      }),
    );
  }),
);

/**
 * Public invite preview — no auth required. Lets the accept page render the invite content
 * (brand name, role, truck display name) before the user signs in or creates an account. The
 * payload deliberately omits the inviter's user id and any other PII.
 */
export const brandInvitePublicRouter = Router();
brandInvitePublicRouter.get(
  '/brand-invites/:token',
  rateLimit('read'),
  validate({ params: TokenParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await brandInviteService.preview(params<z.infer<typeof TokenParam>>(req).token));
  }),
);

/**
 * Accept — authenticated. Resolves the signed-in user's email from the identity service and
 * matches it against the invite's `invitee_email`.
 */
brandOperatorPrivateRouter.post(
  '/brand-invites/:token/accept',
  rateLimit('write'),
  authenticate,
  validate({ params: TokenParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const user = await UserModel.findById(principal(req).userId).select('email').lean().exec();
    const email = user?.email ?? '';
    ok(
      res,
      await brandInviteService.accept(
        principal(req),
        email,
        params<z.infer<typeof TokenParam>>(req).token,
      ),
    );
  }),
);
