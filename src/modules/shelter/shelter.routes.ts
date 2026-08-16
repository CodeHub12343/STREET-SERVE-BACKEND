import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { Latitude, Longitude } from '../../shared/geo';
import { PositiveCents } from '../../shared/money';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { shelterService } from './shelter.service';

export const shelterRouter = Router();

const RegisterPartnerBody = z
  .object({
    organizationName: z.string().min(2).max(200),
    ownerUserId: z.string().length(24),
    // B-2: coordinates enable the hub-proximity guard. Optional — a partner without them still
    // works, they simply get no distance check.
    lng: Longitude.optional(),
    lat: Latitude.optional(),
  })
  .strict();
const PartnerIdParam = z.object({ id: z.string().length(24) }).strict();
const CustodyIdParams = z
  .object({ id: z.string().length(24), custodyId: z.string().length(24) })
  .strict();

/**
 * B-1: `residentUserId` is OPTIONAL now. Requiring it forced staff to walk the resident through
 * account creation first — in another session, often on a device the resident doesn't own — and
 * then copy a 24-character id back into this form. Omit it and the response carries a claim code.
 */
const EnrollBody = z
  .object({
    residentUserId: z.string().length(24).optional(),
    cosignedAllocationCents: PositiveCents,
    staffVerifierName: z.string().min(1).max(160),
  })
  .strict();

/** Suspend or reinstate. A reason is optional but audited — "why" outlives whoever clicked it. */
const PartnerStatusBody = z
  .object({
    status: z.enum(['verified', 'suspended']),
    reason: z.string().max(280).optional(),
  })
  .strict();

const ClaimBody = z.object({ code: z.string().min(4).max(16) }).strict();
const CustodyBody = z
  .object({ enabled: z.boolean(), collectionNote: z.string().max(300).optional() })
  .strict();
const DisburseBody = z
  .object({
    method: z.enum(['cash', 'in_kind', 'stored']),
    note: z.string().max(500).optional(),
  })
  .strict();
const CustodyQuery = z.object({ status: z.enum(['held', 'disbursed']).optional() }).strict();
const ExitBody = z
  .object({ enrollmentId: z.string().length(24), reason: z.string().max(300).optional() })
  .strict();
const TrainingBody = z
  .object({
    answers: z
      .array(
        z
          .object({
            moduleSlug: z.string().min(1).max(60),
            questionId: z.string().min(1).max(20),
            answerIndex: z.number().int().min(0).max(9),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

// ─── Admin: the programme roster ────────────────────────────────────────────────────────────
/**
 * Who is actually partnered, how many residents each holds, and how much of other people's money is
 * sitting in their custody. There was no such endpoint, so the admin screen rendered a hardcoded
 * fixture instead — on the production URL, in both demo and live mode.
 */
shelterRouter.get(
  '/',
  rateLimit('read'),
  authenticate,
  requirePermission('shelter:register_partner'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await shelterService.listPartners());
  }),
);

/**
 * Suspend or reinstate a partner. `suspended` was in the model and reachable by nothing, so a
 * partner mishandling resident money could not be stopped without editing the database.
 */
shelterRouter.patch(
  '/:id/status',
  rateLimit('write'),
  authenticate,
  requirePermission('shelter:register_partner'),
  validate({ params: PartnerIdParam, body: PartnerStatusBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PartnerIdParam>>(req);
    const input = body<z.infer<typeof PartnerStatusBody>>(req);
    ok(res, await shelterService.setPartnerStatus(principal(req), id, input.status, input.reason));
  }),
);

// ─── Admin: partner registration ────────────────────────────────────────────────────────────
/**
 * The shelter this staff member runs. Without it the console had no way to learn its own partner
 * id, so `/shelter` showed "No shelter linked to this account" to every shelter admin ever
 * registered.
 *
 * Declared BEFORE `/:id` routes: Express matches in order, and `/mine` would otherwise be captured
 * as an id and fail validation.
 */
shelterRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await shelterService.myPartner(principal(req)));
  }),
);

shelterRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('shelter:register_partner'),
  validate({ body: RegisterPartnerBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await shelterService.registerPartner(
        principal(req),
        body<z.infer<typeof RegisterPartnerBody>>(req),
      ),
    );
  }),
);

// ─── Staff: enrollment ──────────────────────────────────────────────────────────────────────
shelterRouter.post(
  '/:id/enrollments',
  rateLimit('write'),
  authenticate,
  requirePermission('shelter:enroll'),
  validate({ params: PartnerIdParam, body: EnrollBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PartnerIdParam>>(req);
    created(
      res,
      await shelterService.enroll(principal(req), id, body<z.infer<typeof EnrollBody>>(req)),
    );
  }),
);

shelterRouter.post(
  '/:id/enrollments/exit',
  rateLimit('write'),
  authenticate,
  requirePermission('shelter:enroll'),
  validate({ params: PartnerIdParam, body: ExitBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PartnerIdParam>>(req);
    const input = body<z.infer<typeof ExitBody>>(req);
    ok(res, await shelterService.exitResident(principal(req), id, input.enrollmentId, input.reason));
  }),
);

// ─── Staff: custody (B-3) ───────────────────────────────────────────────────────────────────
shelterRouter.patch(
  '/:id/custody',
  rateLimit('write'),
  authenticate,
  requirePermission('shelter:enroll'),
  validate({ params: PartnerIdParam, body: CustodyBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PartnerIdParam>>(req);
    ok(res, await shelterService.setCustody(principal(req), id, body<z.infer<typeof CustodyBody>>(req)));
  }),
);

shelterRouter.get(
  '/:id/custody',
  rateLimit('read'),
  authenticate,
  requirePermission('shelter:report'),
  validate({ params: PartnerIdParam, query: CustodyQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof PartnerIdParam>>(req);
    const q = query<z.infer<typeof CustodyQuery>>(req);
    ok(res, await shelterService.custodyLedger(principal(req), id, q.status));
  }),
);

shelterRouter.post(
  '/:id/custody/:custodyId/disburse',
  rateLimit('money'),
  authenticate,
  requirePermission('shelter:enroll'),
  validate({ params: CustodyIdParams, body: DisburseBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, custodyId } = params<z.infer<typeof CustodyIdParams>>(req);
    ok(
      res,
      await shelterService.disburseCustody(
        principal(req),
        id,
        custodyId,
        body<z.infer<typeof DisburseBody>>(req),
      ),
    );
  }),
);

shelterRouter.get(
  '/:id/reporting',
  rateLimit('read'),
  authenticate,
  requirePermission('shelter:report'),
  validate({ params: PartnerIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await shelterService.report(principal(req), params<z.infer<typeof PartnerIdParam>>(req).id),
    );
  }),
);

/**
 * ─── Resident-facing (B-1/B-5/B-3) ─────────────────────────────────────────────────────────
 *
 * Mounted separately at `/residents` because these are the ONLY shelter endpoints a resident
 * touches, and none of them require the `shelter_admin` permission that guards everything above.
 * Keeping them on the partner router would mean a resident needing staff permissions to see their
 * own money.
 */
export const residentRouter = Router();

/** Claim an invite code. Any signed-in user — this is the moment they become a seller. */
residentRouter.post(
  '/claim',
  rateLimit('write'),
  authenticate,
  validate({ body: ClaimBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await shelterService.claim(principal(req), body<z.infer<typeof ClaimBody>>(req).code));
  }),
);

/** The caller's own capabilities, or null if they aren't an enrolled resident. */
residentRouter.get(
  '/me',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await shelterService.residentCapabilities(principal(req).userId));
  }),
);

// ── Training (B-5) ──
residentRouter.get(
  '/training/course',
  rateLimit('read'),
  authenticate,
  // Served straight from the versioned content module — no database work, so no asyncHandler.
  (_req: Request, res: Response) => {
    ok(res, shelterService.course());
  },
);

residentRouter.get(
  '/training/status',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await shelterService.trainingStatus(principal(req).userId));
  }),
);

residentRouter.post(
  '/training/submit',
  rateLimit('write'),
  authenticate,
  validate({ body: TrainingBody }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(
      res,
      await shelterService.submitTraining(
        principal(req),
        body<z.infer<typeof TrainingBody>>(req).answers,
      ),
    );
  }),
);

// ── Custody, resident side (B-3) ──
residentRouter.get(
  '/custody',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await shelterService.myCustody(principal(req).userId));
  }),
);

residentRouter.post(
  '/custody/:custodyId/acknowledge',
  rateLimit('write'),
  authenticate,
  validate({ params: z.object({ custodyId: z.string().length(24) }).strict() }),
  asyncHandler(async (req: Request, res: Response) => {
    const { custodyId } = params<{ custodyId: string }>(req);
    ok(res, await shelterService.acknowledgeCustody(principal(req), custodyId));
  }),
);
