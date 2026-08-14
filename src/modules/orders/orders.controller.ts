import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { PaginationQuery } from '../../shared/pagination';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  BusinessIdParam,
  CancelOrderBody,
  OrderIdParam,
  PlaceOrderBody,
  QuoteOrderBody,
  RemoveItemBody,
} from './orders.schema';
import { ordersService } from './orders.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const ordersController = {
  place: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof PlaceOrderBody>>(req);
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) throw ValidationError('Idempotency-Key header is required');
    created(res, await ordersService.place(principal(req), input, idempotencyKey));
  },
  quote: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof QuoteOrderBody>>(req);
    ok(res, await ordersService.quote(principal(req), input));
  },
  listMine: async (req: Request, res: Response): Promise<void> => {
    const q = PaginationQuery.parse(req.query);
    ok(res, await ordersService.listMine(principal(req).userId, q.limit));
  },
  accept: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof OrderIdParam>>(req);
    ok(res, await ordersService.accept(principal(req), id));
  },
  ready: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof OrderIdParam>>(req);
    ok(res, await ordersService.ready(principal(req), id));
  },
  complete: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof OrderIdParam>>(req);
    ok(res, await ordersService.complete(principal(req), id));
  },
  cancel: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof OrderIdParam>>(req);
    const { reason } = body<z.infer<typeof CancelOrderBody>>(req);
    ok(res, await ordersService.cancel(principal(req), id, reason));
  },
  refundPreview: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof OrderIdParam>>(req);
    ok(res, await ordersService.refundPreview(principal(req), id));
  },
  removeItem: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof OrderIdParam>>(req);
    const { menuItemId } = body<z.infer<typeof RemoveItemBody>>(req);
    ok(res, await ordersService.removeLineItem(principal(req), id, menuItemId));
  },
  listForBusiness: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof BusinessIdParam>>(req);
    ok(res, await ordersService.listForBusiness(principal(req), id, null, 100));
  },
};
