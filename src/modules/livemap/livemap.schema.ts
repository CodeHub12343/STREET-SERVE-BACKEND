import { z } from 'zod';

import {
  LIVE_STATUSES,
  NEARBY_DEFAULT_RADIUS_M,
  NEARBY_MAX_RADIUS_M,
  TRENDING_DEFAULT_LIMIT,
} from '../../config/constants';
import { Latitude, Longitude } from '../../shared/geo';

export const StartSessionBody = z
  .object({
    actorType: z.enum(['business', 'seller', 'driver']),
    actorId: z.string().min(1).max(64),
    lng: Longitude,
    lat: Latitude,
    status: z.enum(LIVE_STATUSES).optional(),
    waveSlaSec: z.number().int().optional(),
  })
  .strict();

// Rehydrates the vendor dashboard's live/offline state after a reload — the session lives on the
// server, not just the client cache, so the dashboard must be able to read it back.
export const CurrentSessionQuery = z
  .object({
    actorType: z.enum(['business', 'seller', 'driver']),
    actorId: z.string().min(1).max(64),
  })
  .strict();

export const LocationBody = z.object({ lng: Longitude, lat: Latitude }).strict();

export const StatusBody = z.object({ status: z.enum(LIVE_STATUSES) }).strict();

export const SessionIdParam = z.object({ id: z.string().length(24) }).strict();

export const NearbyQuery = z
  .object({
    lat: z.coerce.number().pipe(Latitude),
    lng: z.coerce.number().pipe(Longitude),
    radiusM: z.coerce
      .number()
      .int()
      .positive()
      .max(NEARBY_MAX_RADIUS_M)
      .default(NEARBY_DEFAULT_RADIUS_M),
    category: z.string().max(64).optional(),
    search: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

/** Trending (R1b). Location is optional — without it the proximity signal simply scores 0. */
export const TrendingQuery = z
  .object({
    lat: z.coerce.number().pipe(Latitude).optional(),
    lng: z.coerce.number().pipe(Longitude).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(TRENDING_DEFAULT_LIMIT),
  })
  .strict();

export const BusinessIdParam = z.object({ id: z.string().length(24) }).strict();

/**
 * Phase C viewport query. A bounding box rather than centre+radius because these layers are drawn
 * to fill the visible map, not a circle around the user — a radius that covers a wide viewport's
 * corners over-fetches badly on landscape screens.
 *
 * `refine` rejects an inverted box outright instead of silently returning nothing, which is the
 * difference between a caught client bug and a mysteriously empty layer.
 */
export const BBoxQuery = z
  .object({
    swLng: z.coerce.number().pipe(Longitude),
    swLat: z.coerce.number().pipe(Latitude),
    neLng: z.coerce.number().pipe(Longitude),
    neLat: z.coerce.number().pipe(Latitude),
    category: z.string().max(64).optional(),
    windowHours: z.coerce.number().int().min(1).max(72).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((b) => b.neLat > b.swLat, { message: 'neLat must be north of swLat' });
// Longitude is NOT compared: a viewport straddling the antimeridian legitimately has neLng < swLng.
