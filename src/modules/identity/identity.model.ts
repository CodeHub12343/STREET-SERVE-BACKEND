import { Schema, type InferSchemaType } from 'mongoose';

import {
  MUTABLE_NOTIFICATION_CATEGORIES,
  ROLES,
  TIERS,
  USER_STATUSES,
} from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * Identity domain models. Additive multi-role model on ONE identity; verification is portable
 * across roles (Q10). See DATABASE_SCHEMA_PLAN.md §1.
 */

// ─── users ─────────────────────────────────────────────────────────────────────────────────
const UserSchema = new Schema(
  {
    authProviderId: { type: String, required: true, unique: true },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    display_name: { type: String, default: null },
    photo_url: { type: String, default: null },
    home_location: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },
    location_precision: { type: String, enum: ['exact', 'fuzzed'], default: 'exact' },
    fuzz_radius_m: { type: Number, default: 0 },
    /**
     * Per-category notification opt-OUTs. Only the mutable categories are stored; payout/dispute/
     * verification are unmutable by policy and are never persisted as false. Absent = opted in, so
     * existing users need no backfill.
     *
     * Built FROM `MUTABLE_NOTIFICATION_CATEGORIES` rather than listed by
     * hand, because a hand-written list here fails silently in the worst possible way: Mongoose
     * strict mode drops a `$set` on a path the schema does not declare, so adding a category to the
     * constants gave the user a switch that returned 200, reported success, and wrote nothing.
     *
     * That is the same defect the route comment above `PATCH /me/notification-preferences` records
     * — six switches that "read a 404 and wrote to nothing while appearing to work". Deriving the
     * shape is what stops it recurring every time a category is added.
     *
     * Unmutable categories are deliberately absent: `getPreferences` reports them as `true`
     * unconditionally, so storing them would create a second, disagreeing source of truth.
     */
    notification_prefs: Object.fromEntries(
      MUTABLE_NOTIFICATION_CATEGORIES.map((c) => [c, { type: Boolean, default: true }]),
    ) as Record<string, { type: BooleanConstructor; default: boolean }>,
    status: { type: String, enum: USER_STATUSES, default: 'active', index: true },
    schema_version: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'users' },
);
// Partial (not sparse) unique indexes: sparse still indexes explicit null values, which collide
// when multiple users have no email/phone. Partial-on-$type:'string' indexes only real values.
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
UserSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
UserSchema.index({ home_location: '2dsphere' });

export type UserDoc = InferSchemaType<typeof UserSchema>;
export const UserModel = defineModel('User', UserSchema);

// ─── user_roles (grant/revoke history preserved) ───────────────────────────────────────────
const UserRoleSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ROLES, required: true },
    granted_by: { type: String, default: null },
    granted_at: { type: Date, default: () => new Date() },
    revoked_at: { type: Date, default: null },
  },
  { collection: 'user_roles' },
);
// One active grant per (user, role).
UserRoleSchema.index(
  { user_id: 1, role: 1 },
  { unique: true, partialFilterExpression: { revoked_at: null } },
);

export type UserRoleDoc = InferSchemaType<typeof UserRoleSchema>;
export const UserRoleModel = defineModel('UserRole', UserRoleSchema);

// ─── verification_records (portable across roles; effective tier = max approved) ───────────
const VerificationRecordSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tier: { type: String, enum: TIERS, required: true },
    verification_type: {
      type: String,
      enum: ['id_document', 'selfie_liveness', 'bank_account', 'shelter_cosign'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'expired'],
      default: 'pending',
      index: true,
    },
    provider: { type: String, default: null }, // stripe_identity | persona | stripe_connect
    provider_reference: { type: String, default: null }, // never the raw document
    verified_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'verification_records',
  },
);
VerificationRecordSchema.index({ user_id: 1, verification_type: 1 });
// 5.4: the KYC webhook arrives knowing only the provider's own reference, so this lookup runs on
// every callback. Partial, because most records never get one and indexing thousands of nulls buys
// nothing.
VerificationRecordSchema.index(
  { provider_reference: 1 },
  { partialFilterExpression: { provider_reference: { $type: 'string' } } },
);

export type VerificationRecordDoc = InferSchemaType<typeof VerificationRecordSchema>;
export const VerificationRecordModel = defineModel('VerificationRecord', VerificationRecordSchema);
