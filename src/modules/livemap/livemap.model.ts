import { Schema, type InferSchemaType } from 'mongoose';

import { LIVE_STATUSES, LOCATION_RETENTION_DAYS } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * Live-map domain. The Mongo `live_sessions` row is the durable/auditable last-known snapshot
 * (throttled to the FR-1.2 cadence); a Redis hot mirror is the low-latency broadcast source.
 * Pop-Up is an event on a driving→parked transition, not a status. See DATABASE_SCHEMA_PLAN.md §3.
 */

// ─── live_sessions ─────────────────────────────────────────────────────────────────────────
const LiveSessionSchema = new Schema(
  {
    /**
     * `driver` (Phase 5) reuses this collection rather than getting its own: an on-shift driver
     * inherits the 2dsphere index, the Redis hot mirror, TTL expiry, the stale-session sweep, and
     * cell-based broadcast diffing for free. A parallel presence system would duplicate all of it
     * and then drift.
     *
     * **Drivers are excluded from customer-facing map queries at the repository layer** — see
     * `nearby()`. A driver is not a vendor; rendering idle drivers as discoverable pins would be
     * both a privacy problem and a confusing map.
     */
    actor_type: { type: String, enum: ['business', 'seller', 'driver'], required: true },
    actor_id: { type: String, required: true },
    current_location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    status: { type: String, enum: LIVE_STATUSES, required: true, default: 'parked' },
    geohash: { type: String, required: true, index: true },
    fuzz_radius_m: { type: Number, default: 0 }, // public pin fuzzing (Security §2)
    wave_sla_sec: { type: Number, default: null }, // owner-configured wave-down SLA
    started_at: { type: Date, default: () => new Date() },
    last_ping_at: { type: Date, default: () => new Date() },
    ended_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'live_sessions',
  },
);
LiveSessionSchema.index({ current_location: '2dsphere' });
LiveSessionSchema.index({ status: 1, last_ping_at: 1 });
LiveSessionSchema.index({ actor_type: 1, actor_id: 1 });

export type LiveSessionDoc = InferSchemaType<typeof LiveSessionSchema>;
export const LiveSessionModel = defineModel('LiveSession', LiveSessionSchema);

// ─── location_pings (high-write history, 30-day TTL — Q7) ──────────────────────────────────
const LocationPingSchema = new Schema(
  {
    session_id: { type: Schema.Types.ObjectId, ref: 'LiveSession', required: true },
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },
    recorded_at: { type: Date, default: () => new Date() },
  },
  { collection: 'location_pings' },
);
LocationPingSchema.index(
  { recorded_at: 1 },
  { expireAfterSeconds: LOCATION_RETENTION_DAYS * 24 * 60 * 60 },
);

export type LocationPingDoc = InferSchemaType<typeof LocationPingSchema>;
export const LocationPingModel = defineModel('LocationPing', LocationPingSchema);

// ─── follows (persistent) ──────────────────────────────────────────────────────────────────
const FollowSchema = new Schema(
  {
    follower_user_id: { type: String, required: true },
    business_id: { type: String, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'follows' },
);
FollowSchema.index({ follower_user_id: 1, business_id: 1 }, { unique: true });
FollowSchema.index({ business_id: 1 });

export type FollowDoc = InferSchemaType<typeof FollowSchema>;
export const FollowModel = defineModel('Follow', FollowSchema);

// ─── notify_me_requests (one-off) ──────────────────────────────────────────────────────────
const NotifyMeSchema = new Schema(
  {
    user_id: { type: String, required: true },
    business_id: { type: String, required: true },
    status: { type: String, enum: ['pending', 'fulfilled', 'expired'], default: 'pending' },
    fulfilled_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'notify_me_requests' },
);
NotifyMeSchema.index({ business_id: 1, status: 1 });

export type NotifyMeDoc = InferSchemaType<typeof NotifyMeSchema>;
export const NotifyMeModel = defineModel('NotifyMe', NotifyMeSchema);
