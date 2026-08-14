import type { Request, Response } from 'express';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { PaginationQuery } from '../../shared/pagination';
import type { CreateTransactionBody } from './payments.schema';
import { paymentsService } from './payments.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const paymentsController = {
  onboardSelf: async (req: Request, res: Response): Promise<void> => {
    const p = principal(req);
    const link = await paymentsService.createOnboardingLink('user', p.userId, p.email);
    ok(res, link);
  },

  // GET /payments/connect/status — the seller's own payout readiness (S-13).
  myPayoutStatus: async (req: Request, res: Response): Promise<void> => {
    ok(res, await paymentsService.getMyPayoutStatus(principal(req).userId));
  },

  // GET /payments/funds-availability — A-2 payout-hold explainer for the caller.
  myFundsAvailability: async (req: Request, res: Response): Promise<void> => {
    const p = principal(req);
    ok(res, await paymentsService.fundsAvailability(p.userId, p.verificationTier));
  },

  // GET /businesses/:id/payouts — the vendor payouts screen's real data (ownership enforced by route).
  businessPayouts: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<{ id: string }>(req);
    ok(res, await paymentsService.getBusinessPayouts(id));
  },

  createTransaction: async (req: Request, res: Response): Promise<void> => {
    const p = principal(req);
    const input = body<CreateTransactionBody>(req);
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) throw ValidationError('Idempotency-Key header is required');

    const result = await paymentsService.charge({
      customerId: p.userId,
      counterpartyType: input.counterpartyType,
      counterpartyId: input.counterpartyId,
      amountCents: input.amountCents,
      discountAppliedCents: input.discountAppliedCents,
      tipCents: input.tipCents,
      roundUpCents: input.roundUpCents,
      idempotencyKey,
    });
    created(res, result);
  },

  listMine: async (req: Request, res: Response): Promise<void> => {
    const p = principal(req);
    const q = PaginationQuery.parse(req.query);
    const items = await paymentsService.listMine(p.userId, q.limit);
    ok(res, items);
  },

  refund: async (req: Request, res: Response): Promise<void> => {
    const p = principal(req);
    const { id } = params<{ id: string }>(req);
    const result = await paymentsService.refund(id, p.userId);
    ok(res, result);
  },
};
