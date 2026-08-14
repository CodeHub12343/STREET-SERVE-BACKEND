import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Growth mechanics (FR-4.2, FR-5, FR-6). The ping economy is the fraud-sensitive core.
 * See DATABASE_SCHEMA_PLAN.md §4/§9.
 */

// ─── ping_budgets (vendor-funded paid-sharing balance) ─────────────────────────────────────
const PingBudgetSchema = new Schema(
  {
    business_id: { type: String, required: true, unique: true },
    balance_cents: { type: Number, default: 0 },
    per_share_tip_cents: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'ping_budgets' },
);
export type PingBudgetDoc = InferSchemaType<typeof PingBudgetSchema>;
export const PingBudgetModel = defineModel('PingBudget', PingBudgetSchema);

/**
 * A vendor's prepayment for their ping budget. The budget was previously topped up by simply
 * incrementing a counter — no money was ever collected, so every tip paid out of it would have
 * spent platform capital. The balance is now credited ONLY when this charge succeeds.
 */
const PingBudgetTopupSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    amount_cents: { type: Number, required: true },
    per_share_tip_cents: { type: Number, required: true },
    stripe_payment_intent_id: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
    credited_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'ping_budget_topups',
  },
);
export type PingBudgetTopupDoc = InferSchemaType<typeof PingBudgetTopupSchema>;
export const PingBudgetTopupModel = defineModel('PingBudgetTopup', PingBudgetTopupSchema);

// ─── pings (share events; tip qualification is gated) ──────────────────────────────────────
const PingSchema = new Schema(
  {
    sender_user_id: { type: String, required: true },
    recipient_contact_hash: { type: String, required: true },
    business_id: { type: String, required: true },
    is_paid: { type: Boolean, default: false }, // tip-eligible at creation time
    tip_amount_cents: { type: Number, default: 0 },
    device_fingerprint: { type: String, default: null },
    qualifying_action_completed_at: { type: Date, default: null },
    qualifying_user_id: { type: String, default: null },
    tip_paid_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'pings' },
);
// One tip per unique recipient per vendor, ever (Business Rules §3).
PingSchema.index(
  { business_id: 1, recipient_contact_hash: 1 },
  { unique: true, partialFilterExpression: { is_paid: true } },
);
PingSchema.index({ sender_user_id: 1, created_at: 1 }); // daily cap
PingSchema.index({ device_fingerprint: 1 });
// One tip per qualifying user per vendor (bridges recipient identity at qualify time).
PingSchema.index(
  { business_id: 1, qualifying_user_id: 1 },
  { unique: true, partialFilterExpression: { qualifying_user_id: { $type: 'string' } } },
);
export type PingDoc = InferSchemaType<typeof PingSchema>;
export const PingModel = defineModel('Ping', PingSchema);

// ─── gifts ───────────────────────────────────────────────────────────────────────────────
const GiftSchema = new Schema(
  {
    sender_id: { type: String, required: true },
    business_id: { type: String, required: true },
    recipient_contact_hash: { type: String, required: true },
    item_name: { type: String, required: true },
    amount_cents: { type: Number, required: true },
    transaction_id: { type: String, default: null },
    redemption_code: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'redeemed', 'expired'], default: 'pending' },
    expires_at: { type: Date, required: true },
    expiry_notice_sent: { type: Boolean, default: false },
    redeemed_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'gifts' },
);
GiftSchema.index({ status: 1, expires_at: 1 }); // expiry sweep
export type GiftDoc = InferSchemaType<typeof GiftSchema>;
export const GiftModel = defineModel('Gift', GiftSchema);

// ─── giveaways + claims ────────────────────────────────────────────────────────────────────
const GiveawaySchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    product_name: { type: String, required: true },
    daily_quantity_cap: { type: Number, required: true, min: 1 },
    quantity_claimed_today: { type: Number, default: 0 },
    reset_at: { type: Date, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'giveaways' },
);
export type GiveawayDoc = InferSchemaType<typeof GiveawaySchema>;
export const GiveawayModel = defineModel('Giveaway', GiveawaySchema);

const GiveawayClaimSchema = new Schema(
  {
    giveaway_id: { type: String, required: true },
    user_id: { type: String, required: true },
    day_key: { type: String, required: true }, // YYYY-MM-DD, one claim per user per day
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'giveaway_claims' },
);
GiveawayClaimSchema.index({ giveaway_id: 1, user_id: 1, day_key: 1 }, { unique: true });
export type GiveawayClaimDoc = InferSchemaType<typeof GiveawayClaimSchema>;
export const GiveawayClaimModel = defineModel('GiveawayClaim', GiveawayClaimSchema);

// ─── spot_me_requests ──────────────────────────────────────────────────────────────────────
const SpotMeSchema = new Schema(
  {
    requester_id: { type: String, required: true },
    counterparty_type: { type: String, enum: ['vendor', 'peer'], required: true },
    counterparty_id: { type: String, required: true },
    amount_cents: { type: Number, required: true },
    repay_by: { type: Date, required: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'repaid', 'defaulted'],
      default: 'pending',
    },
    decided_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'spot_me_requests',
  },
);
SpotMeSchema.index({ requester_id: 1, status: 1 });
SpotMeSchema.index({ status: 1, repay_by: 1 }); // default sweep
export type SpotMeDoc = InferSchemaType<typeof SpotMeSchema>;
export const SpotMeModel = defineModel('SpotMeRequest', SpotMeSchema);

// ─── block_party_events ────────────────────────────────────────────────────────────────────
const BlockPartyEventSchema = new Schema(
  {
    centroid: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    radius_m: { type: Number, required: true },
    participant_actor_ids: { type: [String], default: [] },
    detected_at: { type: Date, default: () => new Date() },
    broadcast_at: { type: Date, default: null },
    notified_user_count: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'block_party_events' },
);
export type BlockPartyEventDoc = InferSchemaType<typeof BlockPartyEventSchema>;
export const BlockPartyEventModel = defineModel('BlockPartyEvent', BlockPartyEventSchema);
