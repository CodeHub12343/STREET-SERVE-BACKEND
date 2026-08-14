import { z } from 'zod';

import {
  DELIVERY_MAX_PAYOUT_CENTS,
  DELIVERY_MIN_PAYOUT_CENTS,
  DRIVER_VEHICLE_TYPES,
} from '../../config/constants';

const objectId = z.string().length(24);

export const DeliveryIdParam = z.object({ deliveryId: objectId }).strict();
export const IncidentIdParam = z.object({ incidentId: objectId }).strict();
export const DriverUserIdParam = z.object({ userId: objectId }).strict();

export const ApplyToDriveBody = z
  .object({
    vehicleType: z.enum(DRIVER_VEHICLE_TYPES),
    vehicleDescription: z.string().max(120).optional(),
    /**
     * The driver's own attestation. The platform records the date and nothing else — no policy
     * number, no insurer, no assessment of whether the cover permits delivery use (ADR-004 §3a).
     */
    licenceExpiresAt: z.string().datetime(),
    insuranceExpiresAt: z.string().datetime(),
    /** A-14 — absent from the specification, required before anyone is sent to a stranger's address. */
    emergencyContactName: z.string().max(80).optional(),
    emergencyContactPhone: z.string().max(32).optional(),
  })
  .strict();

export const RenewAttestationBody = z
  .object({
    licenceExpiresAt: z.string().datetime(),
    insuranceExpiresAt: z.string().datetime(),
  })
  .strict();

export const DriverDecisionBody = z
  .object({
    backgroundCheck: z.enum(['passed', 'failed']),
    approve: z.boolean(),
    reason: z.string().max(200).optional(),
  })
  .strict();

export const RequestDeliveryBody = z
  .object({
    orderId: objectId,
    /**
     * The VENDOR names the offer, and the driver sees it before accepting. A platform-set rate a
     * driver only learns after taking the job is the kind of control that stops an engagement being
     * one (ADR-004 §2).
     */
    driverPayoutCents: z
      .number()
      .int()
      .min(DELIVERY_MIN_PAYOUT_CENTS)
      .max(DELIVERY_MAX_PAYOUT_CENTS),
  })
  .strict();

export const CompleteDeliveryBody = z
  .object({ code: z.string().regex(/^\d{6}$/, 'Six digits, read out by the customer') })
  .strict();

export const CancelDeliveryBody = z.object({ reason: z.string().max(200).optional() }).strict();

export const UndeliverableBody = z.object({ reason: z.string().min(1).max(200) }).strict();

export const PositionBody = z
  .object({ lng: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) })
  .strict();

export const IncidentBody = z
  .object({
    kind: z.enum(['safety', 'accident', 'harassment', 'goods_damaged', 'other']),
    detail: z.string().max(1000).optional(),
  })
  .strict();
