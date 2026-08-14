import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError } from '../../shared/errors/AppError';
import { distanceMeters } from '../../shared/geo';
import type { Principal } from '../../shared/types/principal';
import { vendorsService } from '../vendors/vendors.service';
import { LiveSessionModel, LocationPingModel } from './livemap.model';

/**
 * 7.7 / M-24 — mileage, derived from GPS tracks the platform already collects.
 *
 * ## Why this is worth building and a manual mileage log is not
 *
 * Business mileage is deductible, and for a mobile vendor it is often the largest deduction they
 * have. It is also the one they lose, because logging it means remembering at the end of a
 * fourteen-hour day. The platform is already recording the track for the live map; turning that
 * into a mileage figure costs the vendor nothing and is worth real money to them.
 *
 * ## Three honesty constraints
 *
 * 1. **It is an ESTIMATE and says so.** Straight-line distance between pings under-counts a route
 *    that follows roads. Presenting it as an exact figure would be inviting someone to file it, and
 *    the response includes the caveat rather than leaving the UI to remember.
 * 2. **Only 30 days exist.** `location_pings` carries a 30-day TTL (Q7, a privacy decision, not an
 *    oversight). A vendor asking for last quarter gets an explicit "we do not have that" rather
 *    than a quietly truncated number — a silently short total is worse than no total, because it
 *    looks like an answer.
 * 3. **Implausible jumps are dropped.** A GPS fix that teleports 40km in 30 seconds is an error,
 *    not a drive. Including it inflates a tax figure, which is the wrong direction to be wrong in.
 */

/** Above this speed between two pings, the fix is an error rather than a journey. */
const MAX_PLAUSIBLE_KPH = 160;
/** Pings closer together than this are noise around a stationary vehicle, not movement. */
const MIN_SEGMENT_METERS = 25;
/** The retention window — the honest limit of what can be answered. */
export const MILEAGE_HISTORY_DAYS = 30;

const METERS_PER_MILE = 1609.344;

export interface MileageDay {
  date: string;
  meters: number;
  miles: number;
  sessions: number;
}

export const mileageService = {
  /**
   * Mileage for an actor over a window, bucketed by day.
   *
   * Day buckets rather than a single total because that is the shape a mileage log takes: a tax
   * return wants dates, and a vendor checking the figure wants to recognise the day.
   */
  async summary(
    principal: Principal,
    actorType: 'business' | 'seller',
    actorId: string,
    opts: { days?: number } = {},
  ) {
    // Only the actor sees their own track. A mileage log is a movement history, and a movement
    // history is among the most sensitive things this platform holds.
    if (actorType === 'business') {
      const owner = await vendorsService.getBusinessOwner(actorId);
      if (owner !== principal.userId) {
        throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
      }
    } else if (actorId !== principal.userId) {
      throw ForbiddenError('Not your track', ERROR_CODES.NOT_OWNER);
    }

    const requestedDays = Math.max(1, Math.min(opts.days ?? MILEAGE_HISTORY_DAYS, 366));
    const days = Math.min(requestedDays, MILEAGE_HISTORY_DAYS);
    const since = new Date(Date.now() - days * 86_400_000);

    const sessions = await LiveSessionModel.find({
      actor_type: actorType,
      actor_id: actorId,
      created_at: { $gte: since },
    })
      .select('_id')
      .limit(500)
      .lean();

    const byDay = new Map<string, { meters: number; sessions: Set<string> }>();
    let discardedJumps = 0;

    for (const session of sessions) {
      const pings = await LocationPingModel.find({ session_id: session._id })
        .sort({ recorded_at: 1 })
        .select('location recorded_at')
        .lean();

      for (let i = 1; i < pings.length; i++) {
        const prev = pings[i - 1]!;
        const curr = pings[i]!;
        const from = prev.location?.coordinates as [number, number] | undefined;
        const to = curr.location?.coordinates as [number, number] | undefined;
        if (!from || !to) continue; // a ping with no fix is not a segment
        const meters = distanceMeters(from, to);
        if (meters < MIN_SEGMENT_METERS) continue; // stationary noise

        const seconds = (curr.recorded_at.getTime() - prev.recorded_at.getTime()) / 1000;
        if (seconds > 0) {
          const kph = (meters / 1000) / (seconds / 3600);
          if (kph > MAX_PLAUSIBLE_KPH) {
            // A GPS fix that teleports is an error, not a drive. Inflating a tax figure is the
            // wrong direction to be wrong in.
            discardedJumps += 1;
            continue;
          }
        }

        const date = curr.recorded_at.toISOString().slice(0, 10);
        const bucket = byDay.get(date) ?? { meters: 0, sessions: new Set<string>() };
        bucket.meters += meters;
        bucket.sessions.add(String(session._id));
        byDay.set(date, bucket);
      }
    }

    const daysOut: MileageDay[] = [...byDay.entries()]
      .map(([date, b]) => ({
        date,
        meters: Math.round(b.meters),
        miles: Number((b.meters / METERS_PER_MILE).toFixed(1)),
        sessions: b.sessions.size,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const totalMeters = daysOut.reduce((sum, d) => sum + d.meters, 0);

    return {
      actorType,
      actorId,
      from: since.toISOString(),
      days: daysOut,
      totalMeters,
      totalMiles: Number((totalMeters / METERS_PER_MILE).toFixed(1)),
      discardedJumps,
      /**
       * Stated in the payload, not left to the UI. Someone may put this number on a tax return, and
       * the caveat has to travel with it.
       */
      disclosure:
        'Estimated from GPS points recorded while you were live. It is a straight-line estimate between points, so it will usually be LOWER than the distance you actually drove. Check it against your own records before relying on it.',
      ...(requestedDays > MILEAGE_HISTORY_DAYS
        ? {
            truncated: true,
            truncationNotice: `Location history is kept for ${MILEAGE_HISTORY_DAYS} days, so earlier days are not available. This total covers the last ${MILEAGE_HISTORY_DAYS} days only.`,
          }
        : {}),
    };
  },
};
