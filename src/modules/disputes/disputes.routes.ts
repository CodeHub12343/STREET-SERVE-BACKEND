import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { disputesService } from './disputes.service';

export const disputesRouter = Router();

const OpenDisputeBody = z
  .object({
    subjectType: z.enum(['seller', 'business', 'hub']),
    subjectId: z.string().min(1).max(64),
    refType: z.enum(['checkout', 'transaction', 'spot_me']),
    refId: z.string().min(1).max(64),
    note: z.string().max(1000).optional(),
  })
  .strict();
const IdParam = z.object({ id: z.string().length(24) }).strict();
const EvidenceBody = z
  .object({ url: z.string().url().max(2048).optional(), note: z.string().max(1000).optional() })
  .strict();
const ResolveBody = z
  .object({
    outcome: z.enum(['upheld', 'dismissed']),
    resolution: z.string().min(1).max(2000),
    clawbackTransactionId: z.string().length(24).optional(),
  })
  .strict();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

disputesRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('dispute:open'),
  validate({ body: OpenDisputeBody }),
  asyncHandler(async (req: Request, res: Response) => {
    created(
      res,
      await disputesService.open(principal(req), body<z.infer<typeof OpenDisputeBody>>(req)),
    );
  }),
);
disputesRouter.get(
  '/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('dispute:participate'),
  validate({ params: IdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await disputesService.get(principal(req), params<z.infer<typeof IdParam>>(req).id));
  }),
);
disputesRouter.post(
  '/:id/evidence',
  rateLimit('write'),
  authenticate,
  requirePermission('dispute:participate'),
  validate({ params: IdParam, body: EvidenceBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    ok(
      res,
      await disputesService.addEvidence(
        principal(req),
        id,
        body<z.infer<typeof EvidenceBody>>(req),
      ),
    );
  }),
);
disputesRouter.post(
  '/:id/resolve',
  rateLimit('write'),
  authenticate,
  requirePermission('dispute:resolve'),
  validate({ params: IdParam, body: ResolveBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof IdParam>>(req);
    ok(
      res,
      await disputesService.resolve(principal(req), id, body<z.infer<typeof ResolveBody>>(req)),
    );
  }),
);
