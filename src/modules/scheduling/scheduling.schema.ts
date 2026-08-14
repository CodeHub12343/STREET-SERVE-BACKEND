import { z } from 'zod';

import { NonNegativeCents } from '../../shared/money';

const objectId = z.string().length(24);

export const BusinessIdParam = z.object({ id: objectId }).strict();
export const BookingIdParam = z.object({ id: objectId }).strict();

export const CreateServiceBody = z
  .object({
    name: z.string().min(1).max(160),
    durationMin: z.number().int().min(5).max(480),
    priceCents: NonNegativeCents,
    photoUrl: z.string().url().max(2048).optional(),
    cutoffMin: z.number().int().min(0).max(10080).optional(),
  })
  .strict();

export const UpdateServiceBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    durationMin: z.number().int().min(5).max(480).optional(),
    priceCents: NonNegativeCents.optional(),
    // `null` removes the photo; omitted leaves it untouched (mirrors UpdateMenuItemBody).
    photoUrl: z.string().url().max(2048).nullable().optional(),
    cutoffMin: z.number().int().min(0).max(10080).nullable().optional(),
  })
  .strict();

export const ServiceParams = z
  .object({ id: z.string().length(24), serviceId: z.string().length(24) })
  .strict();

export const SetAvailabilityBody = z
  .object({
    windows: z
      .array(
        z
          .object({
            dayOfWeek: z.number().int().min(0).max(6),
            startMin: z.number().int().min(0).max(1440),
            endMin: z.number().int().min(0).max(1440),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const AvailabilityQuery = z
  .object({ serviceId: objectId, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();

export const CreateBookingBody = z
  .object({
    businessId: objectId,
    serviceId: objectId,
    scheduledAt: z.string().datetime(),
    recurrenceRule: z.string().max(200).optional(),
  })
  .strict();

export const RescheduleBody = z.object({ scheduledAt: z.string().datetime() }).strict();
export const CancelBookingBody = z.object({ reason: z.string().max(280).optional() }).strict();
