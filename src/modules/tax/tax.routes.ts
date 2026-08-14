import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, query, validate } from '../../middleware/validate';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { taxService } from './tax.service';
import { taxStatementsService } from './taxStatements.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

const currentYear = new Date().getUTCFullYear();
const StatementQuery = z
  .object({ year: z.coerce.number().int().min(2020).max(currentYear).default(currentYear) })
  .strict();
const RemittanceQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    includeRemitted: z.coerce.boolean().optional(),
  })
  .strict();
const RemitBody = z
  .object({
    jurisdiction: z.string().min(2).max(10),
    reference: z.string().min(1).max(80),
    upTo: z.coerce.date().optional(),
  })
  .strict();
const HubIdParam = z.object({ id: z.string().length(24) }).strict();

export const taxRouter = Router();

/** A seller's own annual statement. */
taxRouter.get(
  '/statements/seller',
  rateLimit('read'),
  authenticate,
  requirePermission('tax:read_own'),
  validate({ query: StatementQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof StatementQuery>>(req);
    ok(res, await taxStatementsService.sellerStatement(principal(req), q.year));
  }),
);

taxRouter.get(
  '/statements/hub/:id',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam, query: StatementQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    const q = query<z.infer<typeof StatementQuery>>(req);
    ok(res, await taxStatementsService.hubStatement(principal(req), id, q.year));
  }),
);

/**
 * Marketplace-facilitator remittance. Finance-only: this is the number filed with a state, and
 * recording a remittance discharges a real liability.
 */
taxRouter.get(
  '/remittance',
  rateLimit('read'),
  authenticate,
  requirePermission('finance:read_reconciliation'),
  validate({ query: RemittanceQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof RemittanceQuery>>(req);
    ok(res, await taxService.remittanceReport(q));
  }),
);

taxRouter.post(
  '/remittance',
  rateLimit('money'),
  authenticate,
  requirePermission('finance:read_reconciliation'),
  validate({ body: RemitBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<z.infer<typeof RemitBody>>(req);
    ok(res, await taxService.recordRemittance(principal(req), input));
  }),
);
