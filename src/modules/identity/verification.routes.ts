import { Router, type Request, type Response } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import { verificationService } from './verification.service';

/**
 * KYC verification endpoints. Submissions are async: they return `pending`; a provider webhook
 * resolves status server-side. See API_SPECIFICATION.md §1/§17.
 */
export const verificationRouter = Router();

function principal(req: Request) {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

verificationRouter.post(
  '/id-document',
  rateLimit('auth'),
  authenticate,
  requirePermission('verification:manage_self'),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await verificationService.startIdVerification(principal(req));
    ok(res, result);
  }),
);

// Stripe Identity's document session covers selfie liveness; this returns the current status.
verificationRouter.post(
  '/selfie-liveness',
  rateLimit('auth'),
  authenticate,
  requirePermission('verification:manage_self'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = await verificationService.getStatus(principal(req));
    ok(res, status);
  }),
);

verificationRouter.post(
  '/bank-account',
  rateLimit('money'),
  authenticate,
  requirePermission('verification:manage_self'),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await verificationService.linkBankAccount(principal(req));
    ok(res, result);
  }),
);

verificationRouter.get(
  '/status',
  rateLimit('read'),
  authenticate,
  requirePermission('verification:manage_self'),
  asyncHandler(async (req: Request, res: Response) => {
    const status = await verificationService.getStatus(principal(req));
    ok(res, status);
  }),
);
