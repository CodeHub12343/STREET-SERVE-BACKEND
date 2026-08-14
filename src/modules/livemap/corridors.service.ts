import { Schema, type InferSchemaType } from 'mongoose';

import { logger } from '../../config/logger';
import { defineModel } from '../../shared/defineModel';
import { distanceMeters } from '../../shared/geo';
import { kv } from '../../shared/kv';
import { NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';

/**
 * 7.8 / P-12 — route / corridor alerts.
 *
 * ## The gap this fills
 *
 * Proximity alerts (FR-1.4) tell you when a vendor you follow is near **your home**. That is one
 * fixed point, and it misses the case people actually ask for: *"tell me when a taco truck is on my
 * commute"*. A corridor is a route the customer draws — home to work, the school run — and an alert
 * fires when any qualifying vendor goes live near it.
 *
 * ## Why a polyline and not a radius
 *
 * A radius big enough to cover a 12km commute also covers half the city, so the alerts become
 * noise and get muted. A corridor is the shape of the thing the customer cares about: distance to a
 * *line*, not to a point.
 *
 * ## Restraint, because an unmuted alert is a deleted app
 *
 * - Per-corridor throttle, keyed by (corridor, business), so one vendor working a pitch on your
 *   route alerts you once, not every minute they are parked there.
 * - A corridor can be paused rather than deleted — a commute is a weekday thing.
 * - Optional category filter: someone wanting coffee on the way in does not want a furniture hub.
 *
 * ## Cost
 *
 * Evaluated on the vendor-goes-live event, not by a sweep. Sweeping would mean re-testing every
 * corridor against every live vendor every minute; the event already knows which vendor changed,
 * and corridors are few per user.
 */

/** How often one corridor may alert about the same business. */
export const CORRIDOR_ALERT_THROTTLE_SEC = 6 * 60 * 60;
/** Default distance from the line that counts as "on my route". */
export const DEFAULT_CORRIDOR_RADIUS_M = 500;
/** Bound on the drawn route — a "corridor" spanning a state is a subscription to everything. */
export const MAX_CORRIDOR_POINTS = 25;

const CorridorSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    label: { type: String, required: true },
    /**
     * Ordered [lng, lat] points describing the route. Typed as a plain array of pairs rather than a
     * nested subdocument array so lean reads give real `number[][]` to the geometry code.
     */
    path: {
      type: [[Number]],
      required: true,
      validate: {
        validator: (v: number[][]) => v.length >= 2 && v.length <= MAX_CORRIDOR_POINTS,
        message: `A corridor needs between 2 and ${MAX_CORRIDOR_POINTS} points`,
      },
    },
    radius_m: { type: Number, default: DEFAULT_CORRIDOR_RADIUS_M, min: 100, max: 2000 },
    /** Empty = any category. */
    categories: { type: [String], default: [] },
    /** Paused rather than deleted — a commute is a weekday thing. */
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'corridors' },
);
CorridorSchema.index({ active: 1 });

export type CorridorDoc = InferSchemaType<typeof CorridorSchema>;
export const CorridorModel = defineModel('Corridor', CorridorSchema);

/**
 * The shape the geometry and the API care about. Declared explicitly rather than derived from the
 * schema: Mongoose types a nested array as a subdocument array, which is not `number[][]` and is
 * not what any consumer wants.
 */
interface CorridorLike {
  _id: unknown;
  user_id: string;
  label: string;
  path: number[][];
  radius_m: number;
  categories: string[];
  active: boolean;
}

function view(doc: CorridorLike) {
  return {
    id: String(doc._id),
    label: doc.label,
    path: doc.path,
    radiusM: doc.radius_m,
    categories: doc.categories,
    active: doc.active,
  };
}

/**
 * Shortest distance from a point to a line segment, in metres.
 *
 * Projection is done in a local planar approximation (metres per degree at this latitude), which is
 * accurate well past the scale of a city commute and far cheaper than a proper geodesic solve. The
 * endpoints fall back to real haversine distance, so the common "near one end of the route" case is
 * exact.
 */
function distanceToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const latRad = (a[1] * Math.PI) / 180;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(latRad);

  const ax = a[0] * mPerDegLng;
  const ay = a[1] * mPerDegLat;
  const bx = b[0] * mPerDegLng;
  const by = b[1] * mPerDegLat;
  const px = p[0] * mPerDegLng;
  const py = p[1] * mPerDegLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distanceMeters(p, a);

  // How far along the segment the closest point is, clamped to the segment itself.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  if (t <= 0) return distanceMeters(p, a);
  if (t >= 1) return distanceMeters(p, b);

  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Shortest distance from a point to a whole corridor. */
export function distanceToCorridor(point: [number, number], path: number[][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i++) {
    const d = distanceToSegment(point, path[i - 1] as [number, number], path[i] as [number, number]);
    if (d < best) best = d;
  }
  return best;
}

export const corridorsService = {
  async create(
    principal: Principal,
    input: { label: string; path: number[][]; radiusM?: number; categories?: string[] },
  ) {
    const doc = await CorridorModel.create({
      user_id: principal.userId,
      label: input.label,
      path: input.path,
      radius_m: input.radiusM ?? DEFAULT_CORRIDOR_RADIUS_M,
      categories: input.categories ?? [],
    });
    return view(doc.toObject() as unknown as CorridorLike);
  },

  async list(principal: Principal) {
    const docs = await CorridorModel.find({ user_id: principal.userId })
      .sort({ created_at: -1 })
      .lean();
    return (docs as unknown as CorridorLike[]).map(view);
  },

  async setActive(principal: Principal, id: string, active: boolean) {
    const doc = await CorridorModel.findOneAndUpdate(
      { _id: id, user_id: principal.userId },
      { $set: { active } },
      { new: true },
    ).lean();
    if (!doc) throw NotFoundError('Corridor not found');
    return view(doc as unknown as CorridorLike);
  },

  async remove(principal: Principal, id: string) {
    const doc = await CorridorModel.findOneAndDelete({ _id: id, user_id: principal.userId }).lean();
    if (!doc) throw NotFoundError('Corridor not found');
    return { removed: true };
  },

  /**
   * A vendor went live (or moved to a new pitch) — alert anyone whose corridor it sits on.
   *
   * Event-driven, not swept: the event knows which vendor changed, so this tests one point against
   * the corridors, rather than a sweep testing every corridor against every live vendor every
   * minute.
   *
   * Never throws. A vendor going live must not fail because someone's alert did.
   */
  async onVendorLive(input: {
    businessId: string;
    businessName: string;
    category?: string | null;
    lngLat: [number, number];
    status: string;
  }): Promise<number> {
    try {
      const corridors = (await CorridorModel.find({ active: true })
        .limit(2000)
        .lean()) as unknown as CorridorLike[];
      let alerted = 0;

      for (const corridor of corridors) {
        if (
          corridor.categories.length > 0 &&
          (!input.category || !corridor.categories.includes(input.category))
        ) {
          continue; // someone wanting coffee on the way in does not want a furniture hub
        }
        const distance = distanceToCorridor(input.lngLat, corridor.path);
        if (distance > corridor.radius_m) continue;

        // One vendor working a pitch on your route should alert you once, not every minute they
        // are parked there.
        const throttleKey = `corridor:${String(corridor._id)}:${input.businessId}`;
        const first = await kv().setNx(throttleKey, '1', CORRIDOR_ALERT_THROTTLE_SEC);
        if (!first) continue;

        notificationsService.notify(corridor.user_id, {
          category: 'proximity',
          title: `${input.businessName} is on your ${corridor.label} route`,
          body:
            input.status === 'driving'
              ? `${input.businessName} is heading along your route right now.`
              : `${input.businessName} is parked about ${Math.round(distance)}m from your route.`,
          data: {
            businessId: input.businessId,
            corridorId: String(corridor._id),
            distanceM: Math.round(distance),
          },
        });
        alerted += 1;
      }
      return alerted;
    } catch (err) {
      logger.error({ err, businessId: input.businessId }, 'corridor alert evaluation failed');
      return 0;
    }
  },
};
