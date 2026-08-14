import { FollowModel, LiveSessionModel, LocationPingModel, NotifyMeModel } from './livemap.model';

interface SessionPatch {
  current_location?: { type: 'Point'; coordinates: [number, number] };
  status?: 'driving' | 'parked' | 'away_closed';
  geohash?: string;
  last_ping_at?: Date;
  ended_at?: Date | null;
}

export const livemapRepository = {
  findActiveByActor(actorType: 'business' | 'seller' | 'driver', actorId: string) {
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
    actor_type: 'business' | 'seller' | 'driver';
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
  createFollow(followerUserId: string, businessId: string) {
    return FollowModel.updateOne(
      { follower_user_id: followerUserId, business_id: businessId },
      { $setOnInsert: { follower_user_id: followerUserId, business_id: businessId } },
      { upsert: true },
    ).exec();
  },
  removeFollow(followerUserId: string, businessId: string) {
    return FollowModel.deleteOne({
      follower_user_id: followerUserId,
      business_id: businessId,
    }).exec();
  },
  listFollows(followerUserId: string) {
    return FollowModel.find({ follower_user_id: followerUserId }).lean().exec();
  },
  listFollowersOf(businessId: string) {
    return FollowModel.find({ business_id: businessId }).lean().exec();
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
