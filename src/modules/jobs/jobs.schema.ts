import { z } from 'zod';

import { JOB_TYPES } from '../../config/constants';
import { Latitude, Longitude } from '../../shared/geo';
import { NonNegativeCents } from '../../shared/money';

export const PostJobBody = z
  .object({
    title: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    lng: Longitude,
    lat: Latitude,
    payCents: NonNegativeCents,
    payUnit: z.enum(['flat', 'hourly']).optional(),
    // A-5: optional so existing clients keep working; omitted posts default to `sell`.
    jobType: z.enum(JOB_TYPES).optional(),
    startsAt: z.string().datetime().optional(),
    durationHrs: z.number().min(0.5).max(24).optional(),
    businessId: z.string().length(24).optional(),
  })
  .strict();

export const NearbyJobsQuery = z
  .object({
    // Query params arrive as strings — coerce.
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radius: z.coerce.number().int().min(100).max(40000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /**
     * A-5 filter. Repeatable (`?jobType=sell&jobType=delivery`) and also accepts a comma-separated
     * list, because both forms turn up in the wild and neither should 400 someone out of the gig
     * board. Omitted = every type.
     */
    jobType: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        const raw = (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(','));
        const cleaned = raw.map((s) => s.trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned : undefined;
      })
      .pipe(z.array(z.enum(JOB_TYPES)).min(1).max(JOB_TYPES.length).optional()),
  })
  .strict();

export const JobIdParam = z.object({ id: z.string().length(24) }).strict();

/**
 * Check-in coordinates are REQUIRED, not optional. The design spec makes geofence confirmation the
 * integrity boundary for same-day gig payouts ("not a manual 'I'm here' toggle a worker could
 * trigger from anywhere") — leaving coords optional let any caller skip the proximity check by
 * simply omitting them, which defeats the control entirely.
 */
/**
 * Check in with EITHER proof of presence: inside the geofence, or a scan of the on-site QR.
 * Requiring coords outright stranded workers wherever GPS is unreliable (indoors, loading bays,
 * under awnings) — precisely where a lot of this work happens.
 */
export const CheckInBody = z
  .object({
    lat: Latitude.optional(),
    lng: Longitude.optional(),
    qrToken: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (b) => Boolean(b.qrToken) || (b.lat !== undefined && b.lng !== undefined),
    { message: 'Provide your location or scan the on-site code' },
  );

export const CancelJobBody = z.object({ reason: z.string().max(500).optional() }).strict();

/** Optional viewer coords so `mine` can report how far away each gig still is. */
export const MyJobsQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
  })
  .strict();

export const JobDetailQuery = MyJobsQuery;
