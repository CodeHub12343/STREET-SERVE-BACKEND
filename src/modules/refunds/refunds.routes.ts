import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { body, params, validate } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { REFUND_REASONS } from './refunds.model';
import { refundsService } from './refunds.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

const SalePaymentIdParam = z.object({ id: z.string().length(24) }).strict();
const HubIdParam = z.object({ id: z.string().length(24) }).strict();
const PayTokenParam = z.object({ token: z.string().length(32) }).strict();

const RefundBody = z
  .object({
    /** Omit for a full refund of whatever remains. */
    amountCents: z.number().int().min(1).max(100_000_000).optional(),
    reason: z.enum(REFUND_REASONS),
    restock: z.boolean().optional(),
  })
  .strict();

const RequestRefundBody = z.object({ reason: z.enum(REFUND_REASONS) }).strict();

/** Seller/hub-facing refund actions. */
export const refundsRouter = Router();

refundsRouter.post(
  '/sales/:id/refund',
  rateLimit('money'),
  authenticate,
  requirePermission('sale:refund'),
  // 6.3: same defect as the sale intent — the key was honoured, the body was not compared, so a
  // retry with a corrected `amountCents` silently replayed the first refund.
  idempotency,
  validate({ params: SalePaymentIdParam, body: RefundBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof SalePaymentIdParam>>(req);
    const input = body<z.infer<typeof RefundBody>>(req);
    const key = req.header('Idempotency-Key');
    if (!key) throw ValidationError('Idempotency-Key header is required');
    created(res, await refundsService.refundSale(principal(req), id, { ...input, idempotencyKey: key }));
  }),
);

refundsRouter.get(
  '/sales/:id/refunds',
  rateLimit('read'),
  authenticate,
  requirePermission('sale:refund'),
  validate({ params: SalePaymentIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof SalePaymentIdParam>>(req);
    ok(res, await refundsService.listForSale(principal(req), id));
  }),
);

refundsRouter.get(
  '/hubs/:id/refunds',
  rateLimit('read'),
  authenticate,
  requirePermission('hub:manage'),
  validate({ params: HubIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<z.infer<typeof HubIdParam>>(req);
    ok(res, await refundsService.listForHub(principal(req), id));
  }),
);

/**
 * PUBLIC customer refund request, from the receipt link. Deliberately a REQUEST, not a refund:
 * anyone holding a receipt URL could otherwise drain a seller. A participant decides.
 */
export const publicRefundRouter = Router();

publicRefundRouter.post(
  '/:token/refund-request',
  rateLimit('write'),
  validate({ params: PayTokenParam, body: RequestRefundBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = params<z.infer<typeof PayTokenParam>>(req);
    const input = body<z.infer<typeof RequestRefundBody>>(req);
    ok(res, await refundsService.requestFromReceipt(token, input.reason));
  }),
);
