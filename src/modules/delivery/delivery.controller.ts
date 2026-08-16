import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type {
  ApplyToDriveBody,
  CancelDeliveryBody,
  CompleteDeliveryBody,
  DeliveryIdParam,
  DriverDecisionBody,
  DriverUserIdParam,
  IncidentBody,
  IncidentIdParam,
  PositionBody,
  RenewAttestationBody,
  RequestDeliveryBody,
  UndeliverableBody,
} from './delivery.schema';
import { deliveryService } from './delivery.service';
import { driverService } from './driver.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const deliveryController = {
  // ─── driver ─────────────────────────────────────────────────────────────────────────────
  myDriverProfile: async (req: Request, res: Response): Promise<void> => {
    ok(res, await driverService.getProfile(principal(req).userId));
  },
  apply: async (req: Request, res: Response): Promise<void> => {
    created(
      res,
      await driverService.apply(principal(req), body<z.infer<typeof ApplyToDriveBody>>(req)),
    );
  },
  renew: async (req: Request, res: Response): Promise<void> => {
    ok(
      res,
      await driverService.renewAttestation(
        principal(req),
        body<z.infer<typeof RenewAttestationBody>>(req),
      ),
    );
  },
  eligibility: async (req: Request, res: Response): Promise<void> => {
    ok(res, await driverService.eligibility(principal(req).userId));
  },
  decideDriver: async (req: Request, res: Response): Promise<void> => {
    const { userId } = params<z.infer<typeof DriverUserIdParam>>(req);
    ok(
      res,
      await driverService.decide(
        principal(req),
        userId,
        body<z.infer<typeof DriverDecisionBody>>(req),
      ),
    );
  },

  // ─── dispatch ───────────────────────────────────────────────────────────────────────────
  /** What this delivery would pay, from the distance it actually covers. Read-only. */
  quote: async (req: Request, res: Response): Promise<void> => {
    ok(res, await deliveryService.quote(principal(req), String(req.params.orderId)));
  },

  request: async (req: Request, res: Response): Promise<void> => {
    created(
      res,
      await deliveryService.request(principal(req), body<z.infer<typeof RequestDeliveryBody>>(req)),
    );
  },
  offers: async (req: Request, res: Response): Promise<void> => {
    ok(res, await deliveryService.offersFor(principal(req)));
  },
  /** The delivery this driver is currently on, so a reload does not strand them. */
  active: async (req: Request, res: Response): Promise<void> => {
    ok(res, await deliveryService.activeFor(principal(req)));
  },
  get: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    ok(res, await deliveryService.viewFor(principal(req), deliveryId));
  },
  accept: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    ok(res, await deliveryService.accept(principal(req), deliveryId));
  },
  pickUp: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    ok(res, await deliveryService.markPickedUp(principal(req), deliveryId));
  },
  complete: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    const { code } = body<z.infer<typeof CompleteDeliveryBody>>(req);
    ok(res, await deliveryService.complete(principal(req), deliveryId, code));
  },
  undeliverable: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    const { reason } = body<z.infer<typeof UndeliverableBody>>(req);
    ok(res, await deliveryService.markUndeliverable(principal(req), deliveryId, reason));
  },
  cancel: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    const { reason } = body<z.infer<typeof CancelDeliveryBody>>(req);
    ok(res, await deliveryService.cancel(principal(req), deliveryId, reason));
  },
  position: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    const { lng, lat } = body<z.infer<typeof PositionBody>>(req);
    ok(res, await deliveryService.reportPosition(principal(req), deliveryId, lng, lat));
  },

  // ─── safety ─────────────────────────────────────────────────────────────────────────────
  reportIncident: async (req: Request, res: Response): Promise<void> => {
    const { deliveryId } = params<z.infer<typeof DeliveryIdParam>>(req);
    created(
      res,
      await deliveryService.reportIncident(
        principal(req),
        deliveryId,
        body<z.infer<typeof IncidentBody>>(req),
      ),
    );
  },
  reviewIncident: async (req: Request, res: Response): Promise<void> => {
    const { incidentId } = params<z.infer<typeof IncidentIdParam>>(req);
    ok(res, await deliveryService.reviewIncident(principal(req), incidentId));
  },
};
