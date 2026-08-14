import {
  EVENT_ALERT_LEAD_HOURS,
  EVENT_ALERT_MIN_ATTENDANCE,
  EVENT_ATTENDANCE_REF,
  EVENT_NEARBY_RADIUS_M,
  type EventSource,
} from '../../config/constants';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { distanceMeters } from '../../shared/geo';
import { NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { LiveSessionModel } from '../livemap/livemap.model';
import { notificationsService } from '../notifications/notifications.service';
import { EventAlertModel, EventModel } from './events.model';

interface NearbyEvent {
  id: string;
  name: string;
  venue: string | null;
  lngLat: [number, number];
  startsAt: Date;
  endsAt: Date | null;
  expectedAttendance: number | null;
  category: string | null;
  distanceM: number;
  url: string | null;
}

/**
 * ═══ E-4/E-5 — EVENTS ═══
 *
 * Ingestion is provider-based with manual admin entry as the always-available path — the same shape
 * as weather and Gemini. Manual entry is not a fallback here so much as the primary source for the
 * pilot: a local farmers market is not in Ticketmaster's index, and it is exactly the event a street
 * seller most wants to know about.
 */
export const eventsService = {
  /** Admin/manual creation. Trusted by definition — a human typed it. */
  async create(
    principal: Principal,
    input: {
      name: string;
      venue?: string;
      lng: number;
      lat: number;
      startsAt: string;
      endsAt?: string;
      expectedAttendance?: number;
      category?: string;
      url?: string;
    },
  ) {
    const doc = await EventModel.create({
      name: input.name,
      venue: input.venue ?? null,
      location: { type: 'Point', coordinates: [input.lng, input.lat] },
      starts_at: new Date(input.startsAt),
      ends_at: input.endsAt ? new Date(input.endsAt) : null,
      expected_attendance: input.expectedAttendance ?? null,
      category: input.category ?? null,
      source: 'manual',
      url: input.url ?? null,
      verified: true,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'event.created',
      entityType: 'event',
      entityId: String(doc._id),
      metadata: { name: input.name, source: 'manual' },
    });
    return this.view({ ...doc.toObject(), location: { coordinates: [input.lng, input.lat] } });
  },

  async cancel(principal: Principal, id: string) {
    const updated = await EventModel.findByIdAndUpdate(
      id,
      { $set: { cancelled: true } },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Event not found');
    await writeAudit({
      actorId: principal.userId,
      action: 'event.cancelled',
      entityType: 'event',
      entityId: id,
    });
    return { id, cancelled: true };
  },

  /**
   * Events near a point in the next `withinHours`. The primary read for the map layer, the seller's
   * event list, and the forecaster's event signal.
   */
  /**
   * 7.9 / P-21 — the festivals directory.
   *
   * A directory VIEW over `events`, not a second collection. Festivals are events; a parallel table
   * would need its own ingestion, its own geo index, and its own cancellation semantics, and would
   * drift from the events feed that already drives the AI demand signals.
   *
   * What makes it a directory rather than "nearby with a filter":
   *   - It reaches **further out and further ahead** than the nearby feed, because deciding whether
   *     to work a festival in three weeks is a planning decision, not a "where do I go now" one.
   *   - It groups by **date**, which is the axis a seller plans on.
   *   - It shows expected attendance where known and says nothing where it is not — a fabricated
   *     crowd size is how someone drives two hours to an empty field.
   */
  async festivals(input: {
    lng: number;
    lat: number;
    radiusM?: number;
    withinDays?: number;
    limit?: number;
  }) {
    const radius = input.radiusM ?? 80_000; // a seller will travel for a festival
    const horizon = new Date(Date.now() + (input.withinDays ?? 60) * 86_400_000);

    const rows = await EventModel.find({
      cancelled: false,
      starts_at: { $lte: horizon },
      $or: [{ ends_at: null }, { ends_at: { $gte: new Date() } }],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [input.lng, input.lat] },
          $maxDistance: radius,
        },
      },
    })
      .limit(input.limit ?? 100)
      .lean()
      .exec();

    const byDate = new Map<string, unknown[]>();
    for (const row of rows) {
      const date = new Date(row.starts_at).toISOString().slice(0, 10);
      const list = byDate.get(date) ?? [];
      list.push({
        id: String(row._id),
        name: row.name,
        venue: row.venue,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        category: row.category,
        // Null stays null. A fabricated crowd size is how someone drives two hours to an empty field.
        expectedAttendance: row.expected_attendance ?? null,
        url: row.url,
        /** Ingested events are shown but flagged — the seller decides how much to trust the feed. */
        verified: row.verified,
        location: row.location,
      });
      byDate.set(date, list);
    }

    return {
      radiusM: radius,
      withinDays: input.withinDays ?? 60,
      dates: [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, events]) => ({ date, events })),
      total: rows.length,
    };
  },

  async nearby(input: {
    lng: number;
    lat: number;
    radiusM?: number;
    withinHours?: number;
    limit?: number;
  }): Promise<NearbyEvent[]> {
    const radius = input.radiusM ?? EVENT_NEARBY_RADIUS_M;
    const horizon = new Date(Date.now() + (input.withinHours ?? 72) * 3_600_000);

    const rows = await EventModel.find({
      cancelled: false,
      // Include events already under way — a festival that started an hour ago is the single best
      // place to be right now, and excluding it would be perverse.
      starts_at: { $lte: horizon },
      $or: [{ ends_at: null }, { ends_at: { $gte: new Date() } }],
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [input.lng, input.lat] },
          $maxDistance: radius,
        },
      },
    })
      .limit(input.limit ?? 25)
      .lean()
      .exec();

    return rows
      .filter((r) => {
        // Drop events that ended, without relying on ends_at being present.
        if (r.ends_at) return new Date(r.ends_at) >= new Date();
        return new Date(r.starts_at) >= new Date(Date.now() - 6 * 3_600_000);
      })
      .map((r) => {
        const coords = (r.location?.coordinates ?? [0, 0]) as [number, number];
        return {
          id: String(r._id),
          name: r.name,
          venue: r.venue ?? null,
          lngLat: coords,
          startsAt: r.starts_at,
          endsAt: r.ends_at ?? null,
          expectedAttendance: r.expected_attendance ?? null,
          category: r.category ?? null,
          distanceM: Math.round(distanceMeters([input.lng, input.lat], coords)),
          url: r.url ?? null,
        };
      });
  },

  /**
   * The forecaster's event signal, 0–1.
   *
   * Unknown attendance contributes a small non-zero amount rather than either 0 or a guess: an event
   * is happening, which is worth something, but we cannot claim to know how much.
   */
  async eventSignal(lng: number, lat: number, at: Date = new Date()): Promise<{
    signal: number;
    attendance: number;
    top: NearbyEvent | null;
  }> {
    const events = await this.nearby({ lng, lat, withinHours: 8, limit: 10 });
    const live = events.filter(
      (e) => new Date(e.startsAt).getTime() <= at.getTime() + 8 * 3_600_000,
    );
    if (live.length === 0) return { signal: 0, attendance: 0, top: null };

    const best = live.reduce((a, b) =>
      (b.expectedAttendance ?? 0) > (a.expectedAttendance ?? 0) ? b : a,
    );
    const attendance = best.expectedAttendance ?? 0;
    const signal =
      best.expectedAttendance === null
        ? 0.2 // something is on, magnitude unknown
        : Math.min(1, attendance / EVENT_ATTENDANCE_REF);
    return { signal, attendance, top: best };
  },

  /**
   * E-5 — alert sellers to a big event near them.
   *
   * Runs as a sweep. Deliberately narrow: only events above `EVENT_ALERT_MIN_ATTENDANCE`, only
   * within the lead window, and only once per seller per event. An alert channel is trust that
   * spends down every time it fires on something the recipient didn't need.
   */
  async sweepEventAlerts(): Promise<number> {
    const now = Date.now();
    const upcoming = await EventModel.find({
      cancelled: false,
      starts_at: {
        $gte: new Date(now),
        $lte: new Date(now + EVENT_ALERT_LEAD_HOURS * 3_600_000),
      },
      expected_attendance: { $gte: EVENT_ALERT_MIN_ATTENDANCE },
    })
      .limit(50)
      .lean()
      .exec();
    if (upcoming.length === 0) return 0;

    let sent = 0;
    for (const ev of upcoming) {
      const coords = (ev.location?.coordinates ?? [0, 0]) as [number, number];
      // Sellers currently live near the venue — the ones who could actually act on this.
      const sessions = await LiveSessionModel.find({
        actor_type: 'seller',
        ended_at: null,
        current_location: {
          $near: {
            $geometry: { type: 'Point', coordinates: coords },
            $maxDistance: EVENT_NEARBY_RADIUS_M * 3,
          },
        },
      })
        .limit(200)
        .lean()
        .exec();

      for (const s of sessions) {
        try {
          // The unique index is the idempotency guard — insert first, notify only if we won.
          await EventAlertModel.create({ event_id: String(ev._id), user_id: s.actor_id });
        } catch {
          continue; // already alerted
        }
        const hours = Math.max(
          1,
          Math.round((new Date(ev.starts_at).getTime() - now) / 3_600_000),
        );
        notificationsService.notify(s.actor_id, {
          category: 'ai',
          title: `${ev.expected_attendance} people expected nearby`,
          body: `${ev.name} starts in about ${hours}h${ev.venue ? ` at ${ev.venue}` : ''}. Worth stocking up.`,
          data: { eventId: String(ev._id), expectedAttendance: ev.expected_attendance },
        });
        sent += 1;
      }
      await publish('event.alerted', { eventId: String(ev._id), notified: sessions.length });
    }
    if (sent > 0) logger.info({ sent, events: upcoming.length }, 'event alert sweep');
    return sent;
  },

  /**
   * E-4 ingestion from Ticketmaster's Discovery API. Upserts on `source_ref`, so re-running is
   * safe and updates rather than duplicates. Returns 0 without a key rather than failing — manual
   * entry is the pilot's real source.
   */
  async ingestTicketmaster(input: { lng: number; lat: number; radiusKm?: number }): Promise<number> {
    if (!env.TICKETMASTER_API_KEY) return 0;
    try {
      const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
      url.searchParams.set('apikey', env.TICKETMASTER_API_KEY);
      url.searchParams.set('latlong', `${input.lat},${input.lng}`);
      url.searchParams.set('radius', String(input.radiusKm ?? 30));
      url.searchParams.set('unit', 'km');
      url.searchParams.set('size', '100');

      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'ticketmaster ingestion returned non-OK');
        return 0;
      }
      const body = (await res.json()) as {
        _embedded?: { events?: Array<Record<string, unknown>> };
      };
      const events = body._embedded?.events ?? [];

      let upserted = 0;
      for (const raw of events) {
        const e = raw as {
          id?: string;
          name?: string;
          url?: string;
          dates?: { start?: { dateTime?: string } };
          _embedded?: {
            venues?: Array<{
              name?: string;
              location?: { longitude?: string; latitude?: string };
            }>;
          };
          classifications?: Array<{ segment?: { name?: string } }>;
        };
        const venue = e._embedded?.venues?.[0];
        const lng = Number(venue?.location?.longitude);
        const lat = Number(venue?.location?.latitude);
        const startsAt = e.dates?.start?.dateTime;
        if (!e.id || !e.name || !startsAt || !Number.isFinite(lng) || !Number.isFinite(lat)) {
          continue; // an event we can't place or time is useless to a seller
        }

        await EventModel.updateOne(
          { source: 'ticketmaster', source_ref: e.id },
          {
            $set: {
              name: e.name,
              venue: venue?.name ?? null,
              location: { type: 'Point', coordinates: [lng, lat] },
              starts_at: new Date(startsAt),
              category: e.classifications?.[0]?.segment?.name ?? null,
              url: e.url ?? null,
              // Ingested rows are NOT auto-verified: attendance is unknown and the feed is noisy.
              verified: false,
            },
          },
          { upsert: true },
        ).exec();
        upserted += 1;
      }
      logger.info({ upserted }, 'ticketmaster ingestion complete');
      return upserted;
    } catch (err) {
      logger.warn({ err }, 'ticketmaster ingestion failed');
      return 0;
    }
  },

  view(e: {
    _id: unknown;
    name: string;
    venue?: string | null;
    location: { coordinates: number[] };
    starts_at: Date;
    ends_at?: Date | null;
    expected_attendance?: number | null;
    category?: string | null;
    source?: string;
    url?: string | null;
    verified?: boolean;
  }) {
    return {
      id: String(e._id),
      name: e.name,
      venue: e.venue ?? null,
      lngLat: e.location.coordinates as [number, number],
      startsAt: e.starts_at,
      endsAt: e.ends_at ?? null,
      expectedAttendance: e.expected_attendance ?? null,
      category: e.category ?? null,
      source: (e.source ?? 'manual') as EventSource,
      url: e.url ?? null,
      verified: e.verified === true,
    };
  },
};
