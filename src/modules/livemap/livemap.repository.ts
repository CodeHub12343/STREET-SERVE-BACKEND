import { FollowModel, LiveSessionModel, LocationPingModel, NotifyMeModel } from './livemap.model';

interface SessionPatch {
  current_location?: { type: 'Point'; coordinates: [number, number] };
  status?: 'driving' | 'parked' | 'away_closed';
  geohash?: string;
  last_ping_at?: Date;
  ended_at?: Date | null;
}

export const livemapRepository = {
  findActiveByActor(actorType: 'business' | 'seller' | 'driver' | 'operator', actorId: string) {
    return LiveSessionModel.findOne({
      actor_type: actorType,
      actor_id: actorId,
      ended_at: null,
    }).exec();
  },
  findSessionById(id: string) {
    return LiveSessionModel.findById(id).exec();
  },
  createSession(data: {
    actor_type: 'business' | 'seller' | 'driver' | 'operator';
    actor_id: string;
    current_location: { type: 'Point'; coordinates: [number, number] };
    status: 'driving' | 'parked' | 'away_closed';
    geohash: string;
    fuzz_radius_m: number;
    wave_sla_sec: number | null;
  }) {
    return LiveSessionModel.create(data);
  },
  updateSession(id: string, patch: SessionPatch) {
    return LiveSessionModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },
  appendPing(sessionId: string, location: { type: 'Point'; coordinates: [number, number] }) {
    return LocationPingModel.create({ session_id: sessionId, location });
  },
  /**
   * The customer-facing map. **Drivers are excluded here, at the repository, rather than in each
   * caller** (A-5): an exclusion that every call site has to remember is one that a new call site
   * will forget, and the failure mode is a worker's live position on a public map.
   *
   * `includeDrivers` exists only for dispatch, which needs exactly the sessions this hides.
   */
  nearby(input: {
    lng: number;
    lat: number;
    radiusM: number;
    statuses: string[];
    limit: number;
    includeDrivers?: boolean;
  }) {
    return LiveSessionModel.find({
      status: { $in: input.statuses },
      ended_at: null,
      ...(input.includeDrivers ? {} : { actor_type: { $ne: 'driver' } }),
      current_location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [input.lng, input.lat] },
          $maxDistance: input.radiusM,
        },
      },
    })
      .limit(input.limit)
      .lean()
      .exec();
  },
  staleSessions(threshold: Date, limit: number) {
    return LiveSessionModel.find({
      ended_at: null,
      status: { $in: ['driving', 'parked'] },
      last_ping_at: { $lt: threshold },
    })
      .limit(limit)
      .exec();
  },
  activeSessions(limit: number) {
    return LiveSessionModel.find({ ended_at: null, status: { $in: ['driving', 'parked'] } })
      .limit(limit)
      .lean()
      .exec();
  },

  // ─── Follows ──────────────────────────────────────────────────────────────────────────────
  /**
   * Create or re-anchor a follow row.
   *
   * Franchise Phase 4: when the business belongs to a brand, we upsert a row keyed on
   * `(follower, brand)` and record `business_id` as the truck that triggered the follow (used
   * only for analytics; the uniqueness invariant is brand-level). For brand-less businesses
   * this is backwards-compatible — the brand_id stays null and the legacy `(follower, business)`
   * unique index wins.
   */
  async createFollow(followerUserId: string, businessId: string, brandId?: string | null) {
    if (brandId) {
      return FollowModel.updateOne(
        { follower_user_id: followerUserId, brand_id: brandId },
        {
          $setOnInsert: {
            follower_user_id: followerUserId,
            business_id: businessId,
            brand_id: brandId,
          },
        },
        { upsert: true },
      ).exec();
    }
    return FollowModel.updateOne(
      { follower_user_id: followerUserId, business_id: businessId },
      { $setOnInsert: { follower_user_id: followerUserId, business_id: businessId } },
      { upsert: true },
    ).exec();
  },
  async removeFollow(followerUserId: string, businessId: string, brandId?: string | null) {
    /**
     * Removing a follow by brand kills the brand-scoped row; removing by business kills the
     * legacy row. For a brand follow, the user is unfollowing the WHOLE brand (both trucks) —
     * that's the sensible mental model given the follow was keyed on the brand all along.
     */
    if (brandId) {
      return FollowModel.deleteOne({
        follower_user_id: followerUserId,
        brand_id: brandId,
      }).exec();
    }
    return FollowModel.deleteOne({
      follower_user_id: followerUserId,
      business_id: businessId,
    }).exec();
  },
  listFollows(followerUserId: string) {
    return FollowModel.find({ follower_user_id: followerUserId }).lean().exec();
  },
  /**
   * Followers to notify when THIS business becomes active. Returns both:
   *   • Legacy rows keyed to this business id (no brand).
   *   • Brand-scoped rows if this business belongs to a brand (so a follower of the brand hears
   *     whenever ANY of its trucks goes live).
   */
  async listFollowersOf(businessId: string, brandId?: string | null) {
    const query = brandId
      ? { $or: [{ business_id: businessId }, { brand_id: brandId }] }
      : { business_id: businessId };
    return FollowModel.find(query).lean().exec();
  },

  // ─── Notify-Me ────────────────────────────────────────────────────────────────────────────
  createNotifyMe(userId: string, businessId: string) {
    return NotifyMeModel.create({ user_id: userId, business_id: businessId });
  },
  pendingNotifyMe(businessId: string) {
    return NotifyMeModel.find({ business_id: businessId, status: 'pending' }).lean().exec();
  },
  fulfillNotifyMe(businessId: string) {
    return NotifyMeModel.updateMany(
      { business_id: businessId, status: 'pending' },
      { $set: { status: 'fulfilled', fulfilled_at: new Date() } },
    ).exec();
  },
};
