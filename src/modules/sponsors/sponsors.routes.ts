import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { sponsorsService } from './sponsors.service';

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

// Public: logo placement + impression + pre-registration.
export const sponsorsPublicRouter = Router();

sponsorsPublicRouter.get(
  '/',
  rateLimit('read'),
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, await sponsorsService.listActive());
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
    launchCitySlug: z.string().max(64).optional(),
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
