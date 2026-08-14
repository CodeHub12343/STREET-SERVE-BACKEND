import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params, query } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type { CancelBody, EntitlementsQuery, PlanParam, SubscribeBody } from './subscriptions.schema';
import { subscriptionsService } from './subscriptions.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const subscriptionsController = {
  plans: (_req: Request, res: Response): Promise<void> => {
    ok(res, subscriptionsService.plans());
    return Promise.resolve();
  },
  entitlements: async (req: Request, res: Response): Promise<void> => {
    const { businessId } = query<z.infer<typeof EntitlementsQuery>>(req);
    ok(res, await subscriptionsService.entitlementsFor(principal(req), businessId));
  },
  subscribe: async (req: Request, res: Response): Promise<void> => {
    const { plan, businessId } = body<z.infer<typeof SubscribeBody>>(req);
    const idem = req.header('idempotency-key');
    if (!idem) throw ValidationError('Idempotency-Key header is required');
    created(res, await subscriptionsService.subscribe(principal(req), plan, businessId, idem));
  },
  confirm: async (req: Request, res: Response): Promise<void> => {
    const { plan } = params<z.infer<typeof PlanParam>>(req);
    const { businessId } = body<z.infer<typeof CancelBody>>(req);
    ok(res, await subscriptionsService.confirm(principal(req), plan, businessId));
  },
  cancel: async (req: Request, res: Response): Promise<void> => {
    const { plan } = params<z.infer<typeof PlanParam>>(req);
    const { businessId } = body<z.infer<typeof CancelBody>>(req);
    ok(res, await subscriptionsService.cancel(principal(req), plan, businessId));
  },
};
