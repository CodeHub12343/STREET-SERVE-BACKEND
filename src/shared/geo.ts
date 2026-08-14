import { z } from 'zod';

/**
 * GeoJSON helpers. Coordinates are ALWAYS [lng, lat] (GeoJSON order), matching Mongo's
 * 2dsphere expectation. See DATABASE_SCHEMA_PLAN.md §0 and PROJECT_STRUCTURE.md §4.
 */
export const Longitude = z.number().min(-180).max(180);
export const Latitude = z.number().min(-90).max(90);

export const GeoPoint = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([Longitude, Latitude]),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export function point(lng: number, lat: number): GeoPoint {
  return { type: 'Point', coordinates: [lng, lat] };
}

/** Haversine distance in metres between two [lng, lat] points. */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Encode [lng, lat] to a geohash. Used for bucketed live-pin subscriptions and the Block Party
 * detection sweep (REALTIME_ARCHITECTURE.md §2, BACKEND_ARCHITECTURE.md §3.2).
 */
export function geohashEncode(lng: number, lat: number, precision = 6): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bits = 0;
  let bit = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        bit = (bit << 1) + 1;
        lngMin = mid;
      } else {
        bit = bit << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bit = (bit << 1) + 1;
        latMin = mid;
      } else {
        bit = bit << 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[bit];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}
