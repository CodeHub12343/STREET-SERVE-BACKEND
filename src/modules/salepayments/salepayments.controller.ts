import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import {
  CheckoutIdParam,
  CreateIntentBody,
  PayTokenParam,
  SalePaymentIdParam,
} from './salepayments.schema';
import { salePaymentsService } from './salepayments.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const salePaymentsController = {
  createIntent: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CreateIntentBody>>(req);
    // Money path: the caller must supply an idempotency key so a retried tap can't double-charge.
    const key = req.header('Idempotency-Key');
    if (!key) throw ValidationError('Idempotency-Key header is required');
    created(res, await salePaymentsService.createIntent(principal(req), { ...input, idempotencyKey: key }));
  },

  /** Public — the customer has no account. Exposes only what's needed to pay. */
  publicView: async (req: Request, res: Response): Promise<void> => {
    const { token } = params<z.infer<typeof PayTokenParam>>(req);
    ok(res, await salePaymentsService.publicView(token));
  },

  status: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SalePaymentIdParam>>(req);
    ok(res, await salePaymentsService.status(principal(req), id));
  },

  cancel: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof SalePaymentIdParam>>(req);
    ok(res, await salePaymentsService.cancel(principal(req), id));
  },

  listForCheckout: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof CheckoutIdParam>>(req);
    ok(res, await salePaymentsService.listForCheckout(principal(req), id));
  },
};
