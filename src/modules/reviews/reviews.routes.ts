import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { MAX_REVIEW_PHOTOS } from '../../config/constants';
import { reviewsService } from './reviews.service';

export const reviewsRouter = Router();

const CreateReviewBody = z
  .object({
    subjectType: z.enum(['business', 'seller']),
    subjectId: z.string().min(1).max(64),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).optional(),
    /** CU-30 — presigned-uploaded photos. */
    photos: z.array(z.string().url().max(2048)).max(MAX_REVIEW_PHOTOS).optional(),
    transactionId: z.string().length(24),
  })
  .strict();

const ListReviewsQuery = z
  .object({
    subjectType: z.enum(['business', 'seller']),
    subjectId: z.string().min(1).max(64),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

reviewsRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('review:create'),
  validate({ body: CreateReviewBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const input = body<z.infer<typeof CreateReviewBody>>(req);
    created(res, await reviewsService.create(req.principal, input));
  }),
);

reviewsRouter.get(
  '/',
  rateLimit('read'),
  validate({ query: ListReviewsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof ListReviewsQuery>>(req);
    ok(res, await reviewsService.listForSubject(q.subjectType, q.subjectId, q.limit));
  }),
);

const ReviewIdParam = z.object({ id: z.string().length(24) }).strict();
const ReportBody = z.object({ reason: z.string().max(500).optional() }).strict();

/**
 * CU-30 — report a review's photos. Any signed-in user: the people who see a bad image first are
 * passers-by, not moderators. Hides the photos only; the rating and the words stay.
 */
reviewsRouter.post(
  '/:id/report-photos',
  rateLimit('write'),
  authenticate,
  requirePermission('review:create'),
  validate({ params: ReviewIdParam, body: ReportBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof ReviewIdParam>>(req);
    const { reason } = body<z.infer<typeof ReportBody>>(req);
    ok(res, await reviewsService.reportPhotos(req.principal, id, reason));
  }),
);

/** Admin override — restore what a report hid, or hide what it missed. */
reviewsRouter.post(
  '/:id/moderate-photos',
  rateLimit('write'),
  authenticate,
  requirePermission('admin:suspend_user'),
  validate({
    params: ReviewIdParam,
    body: z.object({ visible: z.boolean(), reason: z.string().max(500).optional() }).strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.principal) throw UnauthenticatedError();
    const { id } = params<z.infer<typeof ReviewIdParam>>(req);
    const { visible, reason } = body<{ visible: boolean; reason?: string }>(req);
    ok(res, await reviewsService.moderatePhotos(req.principal, id, visible, reason));
  }),
);
