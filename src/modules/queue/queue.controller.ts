import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError, ValidationError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  AcceptWaveBody,
  CheckoutBody,
  CreateWaveDownBody,
  DeclineWaveBody,
  DiscountScheduleBody,
  OwnerParams,
  WaveIdParam,
} from './queue.schema';
import { queueService } from './queue.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const queueController = {
  setDiscountSchedule: async (req: Request, res: Response): Promise<void> => {
    const { ownerType, ownerId } = params<z.infer<typeof OwnerParams>>(req);
    const input = body<z.infer<typeof DiscountScheduleBody>>(req);
    ok(
      res,
      await queueService.setDiscountSchedule(
        principal(req),
        ownerType,
        ownerId,
        input.tiers,
        input.capPercent,
      ),
    );
  },

  getQueue: async (req: Request, res: Response): Promise<void> => {
    const { ownerType, ownerId } = params<z.infer<typeof OwnerParams>>(req);
    ok(res, await queueService.getQueueState(ownerType, ownerId));
  },

  join: async (req: Request, res: Response): Promise<void> => {
    const { ownerType, ownerId } = params<z.infer<typeof OwnerParams>>(req);
    created(res, await queueService.joinQueue(principal(req), ownerType, ownerId));
  },

  getMembership: async (req: Request, res: Response): Promise<void> => {
    const { ownerType, ownerId } = params<z.infer<typeof OwnerParams>>(req);
    ok(res, await queueService.getMembership(principal(req).userId, ownerType, ownerId));
  },

  // The vendor's queue-management view: GET /businesses/:id/queue (ownership enforced by route).
  getManageView: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<{ id: string }>(req);
    ok(res, await queueService.getManageView(id));
  },

  // Serve the front of the line: POST /businesses/:id/queue/serve-next.
  serveNext: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<{ id: string }>(req);
    ok(res, await queueService.serveNext(principal(req), id));
  },

  leave: async (req: Request, res: Response): Promise<void> => {
    const { ownerType, ownerId } = params<z.infer<typeof OwnerParams>>(req);
    ok(res, await queueService.leaveQueue(principal(req), ownerType, ownerId));
  },

  checkout: async (req: Request, res: Response): Promise<void> => {
    const { ownerType, ownerId } = params<z.infer<typeof OwnerParams>>(req);
    const input = body<z.infer<typeof CheckoutBody>>(req);
    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey) throw ValidationError('Idempotency-Key header is required');
    created(
      res,
      await queueService.checkout(principal(req), ownerType, ownerId, { ...input, idempotencyKey }),
    );
  },

  createWaveDown: async (req: Request, res: Response): Promise<void> => {
    const input = body<z.infer<typeof CreateWaveDownBody>>(req);
    created(res, await queueService.createWaveDown(principal(req), input));
  },

  acceptWaveDown: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof WaveIdParam>>(req);
    const { etaSeconds } = body<z.infer<typeof AcceptWaveBody>>(req);
    ok(res, await queueService.acceptWaveDown(principal(req), id, etaSeconds));
  },

  declineWaveDown: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof WaveIdParam>>(req);
    const { reason } = body<z.infer<typeof DeclineWaveBody>>(req);
    ok(res, await queueService.declineWaveDown(principal(req), id, reason));
  },

  getWaveDown: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof WaveIdParam>>(req);
    ok(res, await queueService.getWaveDown(principal(req), id));
  },

  // The customer's own wave-down history: GET /wave-downs/mine.
  listMyWaveDowns: async (req: Request, res: Response): Promise<void> => {
    ok(res, await queueService.listMyWaveDowns(principal(req).userId));
  },

  // The vendor's incoming-wave inbox (V-03): GET /businesses/:id/wave-downs.
  listIncomingWaveDowns: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<{ id: string }>(req);
    ok(res, await queueService.listIncomingWaveDowns(principal(req), id));
  },

  cancelWaveDown: async (req: Request, res: Response): Promise<void> => {
    const { id } = params<z.infer<typeof WaveIdParam>>(req);
    ok(res, await queueService.cancelWaveDown(principal(req), id));
  },
};
