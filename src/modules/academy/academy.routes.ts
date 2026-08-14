import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { body, params, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { academyService } from './academy.service';

export const academyRouter = Router();

const SlugParam = z.object({ slug: z.string().min(1).max(60) }).strict();
const SubmitBody = z
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
      .max(200),
  })
  .strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

/**
 * D-3/D-4 — the Academy. Authenticated throughout because every response folds in the caller's own
 * progress; there is no anonymous view of a course, only of the marketing page that links here.
 */
academyRouter.get(
  '/courses',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await academyService.listCourses(principal(req).userId));
  }),
);

/** D-4 — badges + certifications. Declared before `/courses/:slug` can't shadow it (different path). */
academyRouter.get(
  '/me/credentials',
  rateLimit('read'),
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await academyService.credentials(principal(req).userId));
  }),
);

academyRouter.get(
  '/courses/:slug',
  rateLimit('read'),
  authenticate,
  validate({ params: SlugParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = params<z.infer<typeof SlugParam>>(req);
    ok(res, await academyService.getCourse(principal(req).userId, slug));
  }),
);

/**
 * F-5 — buy a paid course. The MATERIAL is free to read regardless; this buys the assessment and
 * the credential, which is the only part that has to be gated for the price to mean anything.
 */
academyRouter.post(
  '/courses/:slug/purchase',
  rateLimit('money'),
  authenticate,
  validate({ params: SlugParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = params<z.infer<typeof SlugParam>>(req);
    const ref = req.header('Idempotency-Key') ?? undefined;
    ok(res, await academyService.purchase(principal(req), slug, ref));
  }),
);

academyRouter.post(
  '/courses/:slug/submit',
  rateLimit('write'),
  authenticate,
  validate({ params: SlugParam, body: SubmitBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = params<z.infer<typeof SlugParam>>(req);
    const { answers } = body<z.infer<typeof SubmitBody>>(req);
    ok(res, await academyService.submit(principal(req), slug, answers));
  }),
);
