import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { deliveryController } from './delivery.controller';
import {
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

/**
 * Delivery Assist Network (ADR-004). Mounted at `/delivery` and `/drivers`.
 *
 * **Nothing here is public.** Unlike Pay It Forward and Boost, none of this is discovery
 * information: an offer, a position, and an address are all things exactly one or two people are
 * entitled to see, and every read goes through `viewFor`, which stages the address by who is asking.
 */
export const driversRouter = Router();

driversRouter.get(
  '/me',
  rateLimit('read'),
  authenticate,
  asyncHandler(deliveryController.myDriverProfile),
);

driversRouter.post(
  '/apply',
  rateLimit('write'),
  authenticate,
  validate({ body: ApplyToDriveBody }),
  asyncHandler(deliveryController.apply),
);

/** Re-attest after a lapse. Only a DATE suspension lifts itself — see the service. */
driversRouter.post(
  '/me/attestation',
  rateLimit('write'),
  authenticate,
  validate({ body: RenewAttestationBody }),
  asyncHandler(deliveryController.renew),
);

driversRouter.get(
  '/me/eligibility',
  rateLimit('read'),
  authenticate,
  asyncHandler(deliveryController.eligibility),
);

/** Ops records the background-check outcome and approves or refuses. */
driversRouter.post(
  '/:userId/decision',
  rateLimit('write'),
  authenticate,
  requirePermission('driver:administer'),
  validate({ params: DriverUserIdParam, body: DriverDecisionBody }),
  asyncHandler(deliveryController.decideDriver),
);

export const deliveryRouter = Router();

/** The vendor asks for help. */
deliveryRouter.post(
  '/',
  rateLimit('write'),
  authenticate,
  requirePermission('delivery:request'),
  validate({ body: RequestDeliveryBody }),
  asyncHandler(deliveryController.request),
);

/** A driver's live offers — coarse destinations only, until one is accepted. */
deliveryRouter.get(
  '/offers',
  rateLimit('read'),
  authenticate,
  requirePermission('delivery:drive'),
  asyncHandler(deliveryController.offers),
);

/** Must be declared before `/:deliveryId`, or "mine" is parsed as an id. */
deliveryRouter.get(
  '/mine',
  rateLimit('read'),
  authenticate,
  requirePermission('delivery:drive'),
  asyncHandler(deliveryController.active),
);

deliveryRouter.get(
  '/:deliveryId',
  rateLimit('read'),
  authenticate,
  validate({ params: DeliveryIdParam }),
  asyncHandler(deliveryController.get),
);

deliveryRouter.post(
  '/:deliveryId/accept',
  rateLimit('write'),
  authenticate,
  requirePermission('delivery:drive'),
  validate({ params: DeliveryIdParam }),
  asyncHandler(deliveryController.accept),
);

deliveryRouter.post(
  '/:deliveryId/pick-up',
  rateLimit('write'),
  authenticate,
  requirePermission('delivery:drive'),
  validate({ params: DeliveryIdParam }),
  asyncHandler(deliveryController.pickUp),
);

deliveryRouter.post(
  '/:deliveryId/complete',
  rateLimit('write'),
  authenticate,
  requirePermission('delivery:drive'),
  validate({ params: DeliveryIdParam, body: CompleteDeliveryBody }),
  asyncHandler(deliveryController.complete),
);

deliveryRouter.post(
  '/:deliveryId/undeliverable',
  rateLimit('write'),
  authenticate,
  requirePermission('delivery:drive'),
  validate({ params: DeliveryIdParam, body: UndeliverableBody }),
  asyncHandler(deliveryController.undeliverable),
);

/** Either side may pull out before hand-off; the service works out which one is asking. */
deliveryRouter.post(
  '/:deliveryId/cancel',
  rateLimit('write'),
  authenticate,
  validate({ params: DeliveryIdParam, body: CancelDeliveryBody }),
  asyncHandler(deliveryController.cancel),
);

/**
 * Courier position. `write` rather than a looser tier because this is the platform's first sustained
 * write path — the service also applies its own per-delivery interval ceiling.
 */
deliveryRouter.post(
  '/:deliveryId/position',
  rateLimit('write'),
  authenticate,
  requirePermission('delivery:drive'),
  validate({ params: DeliveryIdParam, body: PositionBody }),
  asyncHandler(deliveryController.position),
);

/** A-14 — any party to the delivery may report an incident. */
deliveryRouter.post(
  '/:deliveryId/incidents',
  rateLimit('write'),
  authenticate,
  validate({ params: DeliveryIdParam, body: IncidentBody }),
  asyncHandler(deliveryController.reportIncident),
);

deliveryRouter.post(
  '/incidents/:incidentId/review',
  rateLimit('write'),
  authenticate,
  requirePermission('driver:administer'),
  validate({ params: IncidentIdParam }),
  asyncHandler(deliveryController.reviewIncident),
);
