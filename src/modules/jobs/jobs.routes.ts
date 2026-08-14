import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';

import { JOB_TYPE_LABELS, JOB_TYPES } from '../../config/constants';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { jobsService } from './jobs.service';
import {
  CancelJobBody,
  CheckInBody,
  JobDetailQuery,
  JobIdParam,
  MyJobsQuery,
  NearbyJobsQuery,
  PostJobBody,
} from './jobs.schema';

export const jobsRouter = Router();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/** Optional viewer coords, shared by the `mine` and detail reads. */
function viewerCoords(q: { lat?: number; lng?: number }) {
  return q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
}

jobsRouter.get(
  '/nearby',
  rateLimit('read'),
  authenticate,
  requirePermission('job:read'),
  validate({ query: NearbyJobsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof NearbyJobsQuery>>(req);
    ok(
      res,
      await jobsService.nearby({
        lat: q.lat,
        lng: q.lng,
        radiusM: q.radius,
        limit: q.limit,
        jobTypes: q.jobType,
      }),
    );
  }),
);

/**
 * A-5: the filter vocabulary, served rather than hardcoded in the client. A client shipping its own
 * copy of this list is a client that silently stops offering a type the day one is added.
 * Static path — must precede `/:id`.
 */
jobsRouter.get('/types', rateLimit('read'), (_req: Request, res: Response) => {
  // Served straight from the constant — no await, so no asyncHandler wrapper (cf. /healthz).
  ok(
    res,
    JOB_TYPES.map((key) => ({ key, label: JOB_TYPE_LABELS[key] })),
  );
});

// Registered before `/:id` so the literal segment isn't swallowed by the id param (which would
// then 400 on the 24-char length check).
jobsRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('job:read'),
  validate({ query: MyJobsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof MyJobsQuery>>(req);
    ok(res, await jobsService.mine(principal(req), viewerCoords(q)));
  }),
);

// The employer's own postings, with applicant counts. Static path — must precede `/:id`.
jobsRouter.get(
  '/posted',
  rateLimit('read'),
  authenticate,
  requirePermission('job:post'),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await jobsService.postedByMe(principal(req)));
  }),
);

jobsRouter.get(
  '/:id/applicants',
  rateLimit('read'),
  authenticate,
  requirePermission('job:post'),
  validate({ params: JobIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await jobsService.applicants(principal(req), params<z.infer<typeof JobIdParam>>(req).id));
  }),
);

// The rotating on-site check-in code. Poster-only — seeing it authorises a check-in.
jobsRouter.get(
  '/:id/qr',
  rateLimit('read'),
  authenticate,
  requirePermission('job:post'),
  validate({ params: JobIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await jobsService.checkInToken(principal(req), params<z.infer<typeof JobIdParam>>(req).id));
  }),
);

// The worker never turned up — reopens the shift so it isn't stranded as `filled`.
jobsRouter.post(
  '/:id/no-show',
  rateLimit('write'),
  authenticate,
  requirePermission('job:post'),
  validate({ params: JobIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await jobsService.markNoShow(principal(req), params<z.infer<typeof JobIdParam>>(req).id));
  }),
);

jobsRouter.get(
  '/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('job:read'),
  validate({ params: JobIdParam, query: JobDetailQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof JobDetailQuery>>(req);
    ok(
      res,
      await jobsService.getById(
        principal(req),
        params<z.infer<typeof JobIdParam>>(req).id,
        viewerCoords(q),
      ),
    );
  }),
);

jobsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('job:post'),
  validate({ body: PostJobBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(res, await jobsService.post(principal(req), body<z.infer<typeof PostJobBody>>(req)));
  }),
);

jobsRouter.post(
  '/:id/apply',
  rateLimit('write'),
  authenticate,
  requirePermission('job:apply'),
  validate({ params: JobIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await jobsService.apply(principal(req), params<z.infer<typeof JobIdParam>>(req).id));
  }),
);

jobsRouter.post(
  '/:id/check-in',
  rateLimit('write'),
  authenticate,
  requirePermission('job:manage_application'),
  validate({ params: JobIdParam, body: CheckInBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof JobIdParam>>(req);
    const b = body<z.infer<typeof CheckInBody>>(req);
    ok(res, await jobsService.checkIn(principal(req), id, { lat: b.lat, lng: b.lng, qrToken: b.qrToken }));
  }),
);

jobsRouter.post(
  '/:id/check-out',
  rateLimit('money'),
  authenticate,
  requirePermission('job:manage_application'),
  idempotency,
  validate({ params: JobIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await jobsService.checkOut(principal(req), params<z.infer<typeof JobIdParam>>(req).id));
  }),
);

jobsRouter.post(
  '/:id/cancel',
  rateLimit('write'),
  authenticate,
  requirePermission('job:post'),
  validate({ params: JobIdParam, body: CancelJobBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof JobIdParam>>(req);
    const b = body<z.infer<typeof CancelJobBody>>(req);
    ok(res, await jobsService.cancel(principal(req), id, b.reason));
  }),
);
