import {
  GEOHASH_PRECISION,
  LIVE_SESSION_TTL_SEC,
  NEARBY_MAX_RADIUS_M,
  PROXIMITY_ALERT_THROTTLE_SEC,
  PROXIMITY_HOME_RADIUS_M,
  TRENDING_DEMAND_REF_QUEUE,
  TRENDING_DISCOUNT_REF_PERCENT,
  TRENDING_MAX_CANDIDATES,
  TRENDING_PROX_MAX_M,
  TRENDING_RECENCY_HALFLIFE_MIN,
  TRENDING_WEIGHTS,
  WAVE_DOWN_SLA_MAX_SEC,
  WAVE_DOWN_SLA_MIN_SEC,
} from '../../config/constants';
import { SWEEP_BATCH_LIMIT, reportSweepBatch } from '../../jobs/sweepBatch';
import { publish } from '../../events/bus';
import { realtime } from '../../realtime/hub';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import { distanceMeters, geohashEncode } from '../../shared/geo';
import { kv } from '../../shared/kv';
import type { Principal } from '../../shared/types/principal';
import { agreementsService } from '../agreements/agreements.service';
import { CategoryModel } from '../catalog/catalog.model';
import { UserModel } from '../identity/identity.model';
import { notificationsService } from '../notifications/notifications.service';
import { corridorsService } from './corridors.service';
import { queueService } from '../queue/queue.service';
import { resolveModulesFrom } from '../vendors/modules.service';
import { promotionsService } from '../promotions/promotions.service';
import { BusinessModel } from '../vendors/vendors.model';
import { vendorsService } from '../vendors/vendors.service';
import { liveStore } from './liveStore';
import { livemapRepository as repo } from './livemap.repository';

type ActorType = 'business' | 'seller' | 'driver';
type LiveStatus = 'driving' | 'parked' | 'away_closed';

/** A session shape usable from both hydrated docs and lean results. */
interface SessionLike {
  _id: unknown;
  actor_type: string;
  actor_id: string;
  status: string;
  geohash?: string;
  fuzz_radius_m?: number;
  current_location?: { coordinates?: number[] } | null;
}

function coordsOf(s: { current_location?: { coordinates?: number[] } | null }): [number, number] {
  const c = s.current_location?.coordinates ?? [0, 0];
  return [c[0] ?? 0, c[1] ?? 0];
}

/** Deterministic public-location fuzzing for sellers who reduce precision (Security §2). */
function applyFuzz(lng: number, lat: number, radiusM: number, seed: string): [number, number] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619;
  const angle = ((h >>> 0) % 360) * (Math.PI / 180);
  const latDeg = radiusM / 111320;
  const lngDeg = radiusM / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  return [lng + Math.cos(angle) * lngDeg, lat + Math.sin(angle) * latDeg];
}

/**
 * Assert the principal controls this actor: the business's owner, the seller themselves, or the
 * driver themselves.
 *
 * A driver going on shift is broadcasting their OWN position and nobody else's — which is also why
 * the role check matters here rather than only at the route: a session started under `actor_type:
 * 'driver'` by someone who is not one would put a non-driver's live position into dispatch.
 */
async function assertActorControl(
  principal: Principal,
  actorType: ActorType,
  actorId: string,
): Promise<void> {
  if (actorType === 'business') {
    const owner = await vendorsService.getBusinessOwner(actorId);
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
    }
    return;
  }
  const role = actorType === 'driver' ? 'driver' : 'seller';
  if (actorId !== principal.userId || !principal.roles.includes(role)) {
    throw ForbiddenError(`You cannot broadcast for this ${role}`, ERROR_CODES.NOT_OWNER);
  }
}

/**
 * P-11 — a rough arrival estimate for a business that is on the move.
 *
 * Deliberately crude: straight-line distance at an urban average speed, not a routed ETA. A vendor
 * driving to a pitch is not following a route we know, and a precise-looking number derived from a
 * guess is worse than an obviously approximate one — it invites a complaint when the truck is five
 * minutes late. Only ever shown for `driving`: a parked vendor is already there, and an "away"
 * one is not coming.
 */
const URBAN_AVG_SPEED_M_PER_MIN = 350; // ~21 km/h — city driving with stops

function etaMinutesFor(
  status: string,
  coords: [number, number],
  viewerLng?: number,
  viewerLat?: number,
): number | null {
  if (status !== 'driving' || viewerLng === undefined || viewerLat === undefined) return null;
  const metres = distanceMeters([viewerLng, viewerLat], coords);
  // Under a couple of minutes there is nothing useful to say; "1 min" from a straight-line guess
  // is a promise the vendor did not make.
  return Math.max(2, Math.round(metres / URBAN_AVG_SPEED_M_PER_MIN));
}

async function resolveCategoryIds(category: string): Promise<string[]> {
  const cats = await CategoryModel.find({
    $or: [{ slug: category }, { top_level_tab: category }],
  })
    .select('_id')
    .lean()
    .exec();
  return cats.map((c) => String(c._id));
}

export const livemapService = {
  /** Vendor/seller goes live. Business go-live is blocked until license requirements are met. */
  async startSession(
    principal: Principal,
    input: {
      actorType: ActorType;
      actorId: string;
      lng: number;
      lat: number;
      status?: LiveStatus;
      waveSlaSec?: number;
    },
  ) {
    await assertActorControl(principal, input.actorType, input.actorId);

    if (input.actorType === 'business') {
      const licensed = await vendorsService.isBusinessLicensedForLiveOps(input.actorId);
      if (!licensed) {
        throw BusinessRuleError(
          ERROR_CODES.LICENSE_REQUIRED,
          'This category requires an approved license before going live',
        );
      }
      // Vendor Terms of Sale must be accepted once before selling (R28). Checked after license so a
      // regulated vendor still sees LICENSE_REQUIRED first (unchanged behavior).
      await agreementsService.assertAccepted(principal.userId, 'regular_sale');
    }
    if (
      input.waveSlaSec !== undefined &&
      (input.waveSlaSec < WAVE_DOWN_SLA_MIN_SEC || input.waveSlaSec > WAVE_DOWN_SLA_MAX_SEC)
    ) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'Wave-down SLA must be 120–900 seconds');
    }

    // Fuzzing: businesses show exact by default; sellers honor their precision preference.
    let fuzz = 0;
    if (input.actorType === 'seller') {
      const user = await UserModel.findById(input.actorId).lean().exec();
      if (user?.location_precision === 'fuzzed') fuzz = user.fuzz_radius_m ?? 0;
    }

    const status: LiveStatus = input.status ?? 'parked';
    const geohash = geohashEncode(input.lng, input.lat, GEOHASH_PRECISION);
    const location = {
      type: 'Point' as const,
      coordinates: [input.lng, input.lat] as [number, number],
    };

    const existing = await repo.findActiveByActor(input.actorType, input.actorId);
    const session = existing
      ? await repo.updateSession(String(existing._id), {
          current_location: location,
          status,
          geohash,
          last_ping_at: new Date(),
        })
      : await repo.createSession({
          actor_type: input.actorType,
          actor_id: input.actorId,
          current_location: location,
          status,
          geohash,
          fuzz_radius_m: fuzz,
          wave_sla_sec: input.waveSlaSec ?? null,
        });
    if (!session) throw NotFoundError('Session not found');

    const sessionId = String(session._id);
    await liveStore.upsert(sessionId, { cell: geohash, lng: input.lng, lat: input.lat, status });
    if (status !== 'away_closed') realtime.pinUpdate(geohash, this.pinPayload(session, fuzz));
    await publish('live_session.started', {
      sessionId,
      actorType: input.actorType,
      actorId: input.actorId,
    });
    return this.sessionView(session);
  },

  /** Location tick — durable snapshot + ping history + hot mirror + broadcast (with cell diff). */
  async updateLocation(principal: Principal, sessionId: string, lng: number, lat: number) {
    const session = await repo.findSessionById(sessionId);
    if (!session || session.ended_at) throw NotFoundError('No active session');
    await assertActorControl(principal, session.actor_type, session.actor_id);

    const geohash = geohashEncode(lng, lat, GEOHASH_PRECISION);
    const location = { type: 'Point' as const, coordinates: [lng, lat] as [number, number] };
    const updated = await repo.updateSession(sessionId, {
      current_location: location,
      geohash,
      last_ping_at: new Date(),
    });
    await repo.appendPing(sessionId, location);

    const prev = await liveStore.upsert(sessionId, {
      cell: geohash,
      lng,
      lat,
      status: session.status,
    });
    // Cell change → remove the pin from the old cell room.
    if (prev && prev.cell !== geohash) realtime.pinRemove(prev.cell, sessionId);
    if (session.status !== 'away_closed' && updated) {
      realtime.pinUpdate(geohash, this.pinPayload(updated, session.fuzz_radius_m));
    }
    return { ok: true };
  },

  async setStatus(principal: Principal, sessionId: string, status: LiveStatus) {
    const session = await repo.findSessionById(sessionId);
    if (!session || session.ended_at) throw NotFoundError('No active session');
    await assertActorControl(principal, session.actor_type, session.actor_id);

    const prevStatus = session.status;
    const updated = await repo.updateSession(sessionId, { status, last_ping_at: new Date() });
    const [sLng, sLat] = coordsOf(session);
    await liveStore.upsert(sessionId, { cell: session.geohash, lng: sLng, lat: sLat, status });

    if (status === 'away_closed') {
      realtime.pinRemove(session.geohash, sessionId);
    } else if (updated) {
      realtime.pinUpdate(session.geohash, this.pinPayload(updated, session.fuzz_radius_m));
    }

    // Away/Closed → active again: fulfill Notify-Me and alert followers (business actors).
    if (
      session.actor_type === 'business' &&
      prevStatus === 'away_closed' &&
      status !== 'away_closed'
    ) {
      await this.onBusinessBecameActive(session.actor_id, status);
    }
    // Pop-Up Mode: a driving→parked transition with an active queue notifies waiting customers.
    // A driver has no queue and no customers waiting on their pitch, so this never applies to one.
    if (prevStatus === 'driving' && status === 'parked' && session.actor_type !== 'driver') {
      await queueService.notifyActiveQueueDelay(session.actor_type, session.actor_id, 'popup');
    }
    await publish('live_session.status_changed', { sessionId, status });
    return this.sessionView(updated ?? session);
  },

  /** Explicit Pop-Up trigger (same effect as the driving→parked-with-queue transition). */
  async triggerPopUp(principal: Principal, sessionId: string) {
    const session = await repo.findSessionById(sessionId);
    if (!session || session.ended_at) throw NotFoundError('No active session');
    await assertActorControl(principal, session.actor_type, session.actor_id);
    if (session.actor_type === 'driver') {
      // Pop-Up is a vendor mechanic — it tells a queue their truck has arrived. A driver has neither.
      throw ForbiddenError('Pop-Up is for vendors', ERROR_CODES.NOT_OWNER);
    }
    const notified = await queueService.notifyActiveQueueDelay(
      session.actor_type,
      session.actor_id,
      'popup',
    );
    return { notified };
  },

  /**
   * Keep-alive from an open vendor surface (the dashboard, which unlike the map sends no location
   * pings). Bumps `last_ping_at` so an active vendor survives the stale-session sweep; when the tab
   * closes the pings stop and the session is reaped after LIVE_SESSION_TTL_SEC.
   */
  async heartbeat(principal: Principal, sessionId: string) {
    const session = await repo.findSessionById(sessionId);
    if (!session || session.ended_at) throw NotFoundError('No active session');
    await assertActorControl(principal, session.actor_type, session.actor_id);
    await repo.updateSession(sessionId, { last_ping_at: new Date() });
    return { ok: true };
  },

  async stopSession(principal: Principal, sessionId: string) {
    const session = await repo.findSessionById(sessionId);
    if (!session || session.ended_at) throw NotFoundError('No active session');
    await assertActorControl(principal, session.actor_type, session.actor_id);
    await repo.updateSession(sessionId, { status: 'away_closed', ended_at: new Date() });
    await liveStore.remove(sessionId);
    realtime.pinRemove(session.geohash, sessionId);
    await publish('live_session.stopped', { sessionId });
    return { ok: true };
  },

  /** Current live status for an actor (used by orders' open/away interlock and the dashboard). */
  async getActiveStatus(actorType: ActorType, actorId: string): Promise<LiveStatus | null> {
    const s = await repo.findActiveByActor(actorType, actorId);
    return s ? (s.status as LiveStatus) : null;
  },

  /**
   * The actor's current live session view, or null. The vendor dashboard reads this on load so its
   * live/offline state survives a reload — otherwise the client cache is the only record of "live",
   * and a refresh shows "offline" while the session (and the map pin everyone else sees) is still up.
   */
  async getCurrentSession(principal: Principal, actorType: ActorType, actorId: string) {
    await assertActorControl(principal, actorType, actorId);
    const session = await repo.findActiveByActor(actorType, actorId);
    return session ? this.sessionView(session) : null;
  },

  /** All currently-active sessions (Block Party cluster scan input). */
  async listActiveSessions(): Promise<
    { actorType: string; actorId: string; coordinates: [number, number] }[]
  > {
    const sessions = await repo.activeSessions(5000);
    return sessions
      .filter((s) => s.current_location?.coordinates?.length === 2)
      .map((s) => ({
        actorType: s.actor_type,
        actorId: s.actor_id,
        coordinates: s.current_location!.coordinates as [number, number],
      }));
  },

  async nearby(input: {
    lat: number;
    lng: number;
    radiusM: number;
    category?: string;
    search?: string;
    limit: number;
  }) {
    const radius = Math.min(input.radiusM, NEARBY_MAX_RADIUS_M);
    const sessions = await repo.nearby({
      lng: input.lng,
      lat: input.lat,
      radiusM: radius,
      statuses: ['driving', 'parked'],
      limit: input.limit,
    });

    const businessIds = sessions.filter((s) => s.actor_type === 'business').map((s) => s.actor_id);
    const businesses = await BusinessModel.find({ _id: { $in: businessIds }, status: 'active' })
      .lean()
      .exec();

    // A pin originates in live_sessions, which carries no reference to the owning account. Without
    // this join a suspended/deleted owner keeps rendering — and taking bookings — until their
    // session happens to expire, because nothing cascades from users to live_sessions.
    const sellerIds = sessions.filter((s) => s.actor_type === 'seller').map((s) => s.actor_id);
    const actorUserIds = [...new Set([...businesses.map((b) => b.owner_user_id), ...sellerIds])];
    const blockedUserIds = new Set(
      (
        await UserModel.find({ _id: { $in: actorUserIds }, status: { $ne: 'active' } }, { _id: 1 })
          .lean()
          .exec()
      ).map((u) => String(u._id)),
    );

    /**
     * ═══ A seller pin needs a NAME. ═══
     *
     * A seller has no business behind them, so `name` was left null on their pin and shipped that
     * way to the client. Nothing had ever noticed, because until street sellers could go live no
     * seller pin could exist — the moment they could, `Avatar` called `.trim()` on null during
     * render and React escalated it to the route boundary, taking out the whole /map page.
     *
     * `Avatar` is hardened separately, because a missing name must never be a page-level crash. But
     * the real fix is here: send the name we have.
     */
    const sellerNames = new Map<string, { name: string | null; photoUrl: string | null }>();
    if (sellerIds.length > 0) {
      const sellerUsers = await UserModel.find(
        { _id: { $in: sellerIds } },
        { display_name: 1, photo_url: 1 },
      )
        .lean()
        .exec();
      for (const u of sellerUsers) {
        sellerNames.set(String(u._id), {
          name: u.display_name ?? null,
          photoUrl: u.photo_url ?? null,
        });
      }
    }

    /**
     * ═══ A seller pin needs a NAME. ═══
     *
     * A seller has no business behind them, so `name` was left null on their pin and sent that way.
     * Nothing had ever noticed, because until street sellers could go live no seller pin could
     * exist — the moment they could, `Avatar` called `.trim()` on null DURING RENDER and React
     * escalated it to the route boundary, taking out the whole /map page.
     *
     * `Avatar` is hardened separately, because a missing name must never be a page-level crash. The
     * real fix is here: send the name we actually have.
     */
    const sellerNames = new Map<string, { name: string | null; photoUrl: string | null }>();
    if (sellerIds.length > 0) {
      const sellerUsers = await UserModel.find(
        { _id: { $in: sellerIds } },
        { display_name: 1, photo_url: 1 },
      )
        .lean()
        .exec();
      for (const u of sellerUsers) {
        sellerNames.set(String(u._id), {
          name: u.display_name ?? null,
          photoUrl: u.photo_url ?? null,
        });
      }
    }

    const bmap = new Map(
      businesses.filter((b) => !blockedUserIds.has(b.owner_user_id)).map((b) => [String(b._id), b]),
    );
    const categoryIds = input.category ? await resolveCategoryIds(input.category) : null;
    const searchLc = input.search?.toLowerCase();

    // Resolve each pin's modules so the list/map can offer what the business actually does. One
    // batched category read for the whole page — resolveModulesFrom is pure, so this stays O(1)
    // queries rather than the two-per-business resolveModules would cost.
    const cats = await CategoryModel.find({ _id: { $in: businesses.map((b) => b.category_id) } })
      .lean()
      .exec();
    const catMap = new Map(cats.map((c) => [String(c._id), c]));

    /**
     * P-19 — the paid Verified Badge. A subscription nobody can see is one nobody renews, and the
     * badge was purchasable with no surface that rendered it. Batched: one read for the page.
     */
    const { subscriptionsService } = await import('../subscriptions/subscriptions.service');
    const verifiedSet = await subscriptionsService.activeVerifiedSet(
      businesses.map((b) => String(b._id)),
    );

    /**
     * 7.6 — a live flash sale, on the pin.
     *
     * The discount already reached the price at checkout, but nothing on any customer surface said
     * a sale was running: the buyer found out by noticing the total was lower than expected. That
     * is the wrong half of a marketing instrument to ship — a discount nobody can see attracts
     * nobody and simply reduces what the customers you already had are charged.
     *
     * One query for the whole viewport, not one per pin.
     */
    const discountByBusiness = await promotionsService.liveDiscountByBusiness(
      businesses.map((b) => String(b._id)),
    );

    const pins = [];
    for (const s of sessions) {
      let name: string | null = null;
      let logoUrl: string | null = null;
      let categoryId: string | null = null;
      let modules: string[] | null = null;
      if (s.actor_type === 'business') {
        const b = bmap.get(s.actor_id);
        if (!b) continue;
        categoryId = String(b.category_id);
        if (categoryIds && !categoryIds.includes(categoryId)) continue;
        if (searchLc && !b.name.toLowerCase().includes(searchLc)) continue;
        name = b.name;
        logoUrl = b.logo_url ?? null;
        modules = resolveModulesFrom({
          business: b,
          category: catMap.get(categoryId) ?? null,
        }).enabled;
      } else if (blockedUserIds.has(s.actor_id)) {
        continue; // seller pin whose own account is suspended or deleted
      } else if (categoryIds || searchLc) {
        continue; // sellers have no business/category to match a filter against
      } else {
        // A street seller. Named from their own profile; "Street seller" when they have set no
        // display name, because a pin a customer cannot refer to is barely a pin at all.
        const u = sellerNames.get(s.actor_id);
        name = u?.name ?? 'Street seller';
        logoUrl = u?.photoUrl ?? null;
      }
      const [lng, lat] = coordsOf(s);
      const coords =
        s.fuzz_radius_m > 0 ? applyFuzz(lng, lat, s.fuzz_radius_m, String(s._id)) : [lng, lat];
      pins.push({
        sessionId: String(s._id),
        actorType: s.actor_type,
        actorId: s.actor_id,
        name,
        logoUrl,
        categoryId,
        modules,
        status: s.status,
        /** P-19 — rendered on the pin and the profile; false for sellers, who have no plan. */
        verified: s.actor_type === 'business' && verifiedSet.has(s.actor_id),
        /**
         * P-11 — a live arrival estimate for a business on the move. A customer watching a truck
         * drive toward them had no idea when it would get there: the ETA only existed once a
         * wave-down had been accepted, which is exactly the decision they had not made yet.
         */
        etaMinutes: etaMinutesFor(s.status, coords as [number, number], input.lng, input.lat),
        /**
         * Business-wide flash sale percent, or 0. Sellers have no menu and therefore no sale.
         * Item-scoped sales are deliberately excluded upstream — see liveDiscountByBusiness.
         */
        discountPercent:
          s.actor_type === 'business' ? (discountByBusiness.get(s.actor_id) ?? 0) : 0,
        location: { type: 'Point', coordinates: coords },
      });
    }
    return pins;
  },

  /**
   * Trending (R1b): rank currently-live businesses by an explainable weighted score —
   * **discount boost** + live demand (line length) + recency (fresh ping) + proximity.
   *
   * The discount is the single largest weight, so a discounting vendor measurably outranks an
   * otherwise-identical one — the visible payoff the vendor UX promises. It is a boost, not a gate:
   * a vendor with no schedule still ranks on the other three signals. Mirrors the rule-based AI
   * engine's shape (normalized signals × weights + per-result `factors`).
   */
  async trending(input: { lat?: number; lng?: number; limit: number }) {
    const sessions = await repo.activeSessions(TRENDING_MAX_CANDIDATES);
    const live = sessions.filter((s) => s.actor_type === 'business' && s.status !== 'away_closed');
    if (live.length === 0) return [];

    const businessIds = [...new Set(live.map((s) => s.actor_id))];
    const { subscriptionsService } = await import('../subscriptions/subscriptions.service');
    const [businesses, signals, featured] = await Promise.all([
      BusinessModel.find({ _id: { $in: businessIds } })
        .lean()
        .exec(),
      queueService.trendingSignals('business', businessIds),
      subscriptionsService.activeFeaturedSet(businessIds),
    ]);
    const bmap = new Map(businesses.map((b) => [String(b._id), b]));
    const now = Date.now();

    const scored = live.flatMap((s) => {
      const b = bmap.get(s.actor_id);
      if (!b) return [];
      const sig = signals.get(s.actor_id) ?? { discountPercent: 0, queueCount: 0 };

      const discount = Math.min(1, sig.discountPercent / TRENDING_DISCOUNT_REF_PERCENT);
      const demand = Math.min(1, sig.queueCount / TRENDING_DEMAND_REF_QUEUE);
      const ageMin = Math.max(0, (now - new Date(s.last_ping_at).getTime()) / 60_000);
      const recency = Math.pow(0.5, ageMin / TRENDING_RECENCY_HALFLIFE_MIN);
      let proximity = 0;
      if (input.lat !== undefined && input.lng !== undefined) {
        const [lng, lat] = coordsOf(s);
        proximity = Math.max(
          0,
          1 - distanceMeters([input.lng, input.lat], [lng, lat]) / TRENDING_PROX_MAX_M,
        );
      }

      // Featured placement (R30): a paid boost on top of the organic signals.
      const isFeatured = featured.has(s.actor_id);
      const score =
        TRENDING_WEIGHTS.discount * discount +
        TRENDING_WEIGHTS.demand * demand +
        TRENDING_WEIGHTS.recency * recency +
        TRENDING_WEIGHTS.proximity * proximity +
        (isFeatured ? subscriptionsService.featuredBoost() : 0);

      const factors: string[] = [];
      if (isFeatured) factors.push('featured');
      if (discount > 0) factors.push(`up to ${sig.discountPercent}% off in line`);
      if (sig.queueCount > 0) factors.push(`${sig.queueCount} in line right now`);
      if (recency > 0.5) factors.push('just updated their spot');
      if (proximity > 0.1) factors.push('close to you');

      const [plng, plat] = coordsOf(s);
      const coords =
        s.fuzz_radius_m > 0 ? applyFuzz(plng, plat, s.fuzz_radius_m, String(s._id)) : [plng, plat];
      return [
        {
          businessId: s.actor_id,
          sessionId: String(s._id),
          name: b.name,
          logoUrl: b.logo_url ?? null,
          categoryId: String(b.category_id),
          status: s.status,
          featured: isFeatured,
          discountPercent: sig.discountPercent,
          queueCount: sig.queueCount,
          score: Math.round(score * 1000) / 1000,
          factors,
          reasonSummary: factors.length
            ? `Trending because: ${factors.join('; ')}.`
            : 'Trending among vendors live near you.',
          location: { type: 'Point', coordinates: coords },
        },
      ];
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, input.limit);
  },

  // ─── Follow / Notify-Me ─────────────────────────────────────────────────────────────────
  async follow(principal: Principal, businessId: string) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    await repo.createFollow(principal.userId, businessId);
    return { following: true };
  },
  async unfollow(principal: Principal, businessId: string) {
    await repo.removeFollow(principal.userId, businessId);
    return { following: false };
  },
  async listFavorites(principal: Principal) {
    const follows = await repo.listFollows(principal.userId);
    const ids = follows.map((f) => f.business_id);
    const sessions = await Promise.all(ids.map((id) => repo.findActiveByActor('business', id)));
    const statusById = new Map(sessions.filter(Boolean).map((s) => [s!.actor_id, s!.status]));
    const businesses = await BusinessModel.find({ _id: { $in: ids } })
      .lean()
      .exec();
    return businesses.map((b) => ({
      businessId: String(b._id),
      name: b.name,
      logoUrl: b.logo_url,
      status: statusById.get(String(b._id)) ?? 'away_closed',
    }));
  },
  async notifyMe(principal: Principal, businessId: string) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    await repo.createNotifyMe(principal.userId, businessId);
    return { registered: true };
  },

  // ─── Sweeps ───────────────────────────────────────────────────────────────────────────────
  async expireStaleSessions(): Promise<number> {
    const threshold = new Date(Date.now() - LIVE_SESSION_TTL_SEC * 1000);
    const stale = await repo.staleSessions(threshold, SWEEP_BATCH_LIMIT);
    for (const s of stale) {
      await repo.updateSession(String(s._id), { status: 'away_closed', ended_at: new Date() });
      await liveStore.remove(String(s._id));
      realtime.pinRemove(s.geohash, String(s._id));
    }
    return reportSweepBatch('stale-session', stale.length);
  },

  /**
   * Proximity alerts (FR-1.4): for each active business, alert followers whose home area is within
   * range, throttled to 1 per (vendor,user) per 2h. Fulfills any Notify-Me for that business.
   */
  async evaluateProximityAlerts(): Promise<number> {
    const active = await repo.activeSessions(SWEEP_BATCH_LIMIT);
    let sent = 0;
    for (const s of active) {
      if (s.actor_type !== 'business') continue;
      const [lng, lat] = coordsOf(s);
      const followers = await repo.listFollowersOf(s.actor_id);
      const notifyMe = await repo.pendingNotifyMe(s.actor_id);
      const candidateIds = new Set([
        ...followers.map((f) => f.follower_user_id),
        ...notifyMe.map((n) => n.user_id),
      ]);
      if (candidateIds.size === 0) continue;

      const nearbyUsers = await UserModel.find({
        _id: { $in: [...candidateIds] },
        home_location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: PROXIMITY_HOME_RADIUS_M,
          },
        },
      })
        .select('_id')
        .lean()
        .exec();

      for (const u of nearbyUsers) {
        const userId = String(u._id);
        const throttleKey = `prox:${s.actor_id}:${userId}`;
        const first = await kv().setNx(throttleKey, '1', PROXIMITY_ALERT_THROTTLE_SEC);
        if (!first) continue;
        notificationsService.notify(userId, {
          category: 'proximity',
          title: 'A followed vendor is nearby',
          body: `${s.status === 'driving' ? 'Driving' : 'Parked'} near your area`,
          data: { businessId: s.actor_id, sessionId: String(s._id) },
        });
        sent += 1;
      }
      if (notifyMe.length) await repo.fulfillNotifyMe(s.actor_id);
    }
    // Note the label: `sent` counts NOTIFICATIONS, so saturation is reported against the number of
    // SESSIONS scanned — that is the quantity the batch limit actually bounds.
    reportSweepBatch('proximity-alert-eval', active.length);
    return sent;
  },

  // ─── Helpers ────────────────────────────────────────────────────────────────────────────
  async onBusinessBecameActive(businessId: string, status: LiveStatus) {
    /**
     * 7.8 / P-12 — corridor alerts, fired on the event rather than by a sweep. The event already
     * knows which vendor changed; sweeping would re-test every corridor against every live vendor
     * every minute to rediscover it.
     */
    void (async () => {
      const session = await repo.findActiveByActor('business', businessId);
      if (!session) return;
      const business = await BusinessModel.findById(businessId).select('name category_id').lean();
      const category = business?.category_id ? String(business.category_id) : null;
      await corridorsService.onVendorLive({
        businessId,
        businessName: business?.name ?? 'A vendor',
        category,
        lngLat: coordsOf(session),
        status,
      });
    })();

    const followers = await repo.listFollowersOf(businessId);
    for (const f of followers) {
      notificationsService.notify(f.follower_user_id, {
        category: 'follow_status',
        title: 'A followed business is now active',
        body: status === 'driving' ? 'Now Driving nearby' : 'Now Parked and open',
        data: { businessId },
      });
    }
    await repo.fulfillNotifyMe(businessId);
    await writeAudit({
      action: 'live_session.reactivated',
      entityType: 'business',
      entityId: businessId,
      metadata: { status },
    });
  },

  pinPayload(session: SessionLike, fuzz: number) {
    const [lng, lat] = coordsOf(session);
    const coords = fuzz > 0 ? applyFuzz(lng, lat, fuzz, String(session._id)) : [lng, lat];
    return {
      sessionId: String(session._id),
      actorType: session.actor_type,
      actorId: session.actor_id,
      status: session.status,
      location: { type: 'Point', coordinates: coords },
    };
  },

  sessionView(session: SessionLike) {
    return {
      id: String(session._id),
      actorType: session.actor_type,
      actorId: session.actor_id,
      status: session.status,
      geohash: session.geohash ?? '',
      location: { type: 'Point', coordinates: coordsOf(session) },
      ttlSeconds: LIVE_SESSION_TTL_SEC,
    };
  },
};
