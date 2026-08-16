import { Schema, type InferSchemaType } from 'mongoose';

import {
  PAY_FORWARD_DEFAULT_EXPIRY_DAYS,
  PAY_FORWARD_EXPIRY_DAY_OPTIONS,
} from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * ═══ PAY IT FORWARD — customer-funded community pools (ADR-005) ═══
 *
 * A customer contributes money to a business's pool; a later customer's order is paid from it. The
 * giver and the receiver never know each other, which is what separates this from `gifts` (directed,
 * with a redemption code) and from `giveaways` (the vendor donating their own stock).
 *
 * The money is CUSTODIAL. It is held by the platform, is never the vendor's, and is never
 * withdrawable — see `ledger/communityFund.ts`, which is the only thing that may move it. The
 * balance here is a cached projection of that ledger account, exactly like `ledger_accounts`:
 * convenient to read, never authoritative.
 */

// ─── community_funds — one pool + its settings per business ─────────────────────────────────
const CommunityFundSchema = new Schema(
  {
    business_id: { type: String, required: true, unique: true },
    /**
     * CACHED PROJECTION of `community_fund_payable` for this business. Truth is the ledger; this
     * exists so the map, the profile, and checkout can read a balance without aggregating entries.
     * Reconciliation recomputes the ledger side nightly and any disagreement is a bug worth paging on.
     */
    balance_cents: { type: Number, default: 0, min: 0 },

    // ── Vendor settings (PIF-9). Every one of these is enforced server-side at redemption. ──
    /** Off = no new contributions. Existing balance stays redeemable: money already given is not the vendor's to refuse. */
    accepting: { type: Boolean, default: true },
    /** Ceiling on a single redemption. Null = no ceiling beyond the balance itself. */
    max_per_redemption_cents: { type: Number, default: null },
    /**
     * Ceiling on how much of ONE order the fund may cover, as a percentage. 100 = the fund can cover
     * the whole thing. Below 100 it becomes a discount rather than a gift, which some vendors want
     * (the brief's "10% or 20% of cost" note) and which is honest as long as it is disclosed.
     */
    max_percent_of_order: { type: Number, default: 100, min: 1, max: 100 },
    /** Ceiling on total redemptions per calendar day across all customers. Null = uncapped. */
    max_per_day_cents: { type: Number, default: null },
    /**
     * How long a contribution stays redeemable (ADR-005 §6). "Never" is deliberately NOT an option:
     * an unbounded liability is one the platform cannot close its books against, and several US
     * states treat long-dormant prepaid balances as unclaimed property.
     */
    expiry_days: {
      type: Number,
      enum: PAY_FORWARD_EXPIRY_DAY_OPTIONS,
      default: PAY_FORWARD_DEFAULT_EXPIRY_DAYS,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'community_funds',
  },
);
/** The discovery query: "businesses near me with money in the pot" (PIF-13). */
CommunityFundSchema.index({ balance_cents: -1 });

export type CommunityFundDoc = InferSchemaType<typeof CommunityFundSchema>;
export const CommunityFundModel = defineModel('CommunityFund', CommunityFundSchema);

// ─── community_contributions — money in ─────────────────────────────────────────────────────
/**
 * Modelled field-for-field on `PingBudgetTopup`, and for the same reason its own comment gives: a
 * balance that rises before the money arrives spends capital nobody has. The row is created
 * `pending` with a payment-intent id, and ONLY the webhook moves it to `succeeded` and credits the
 * pool.
 */
const CommunityContributionSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    contributor_id: { type: String, required: true, index: true },
    amount_cents: { type: Number, required: true, min: 1 },
    /**
     * How much of this contribution is still available. Redemption consumes FIFO across
     * contributions, so expiry can retire the OLDEST money first — which is both what a contributor
     * would expect and what keeps the expiry sweep from having to guess which dollars are stale.
     */
    remaining_cents: { type: Number, required: true, min: 0 },
    stripe_payment_intent_id: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
    failure_reason: { type: String, default: null },
    /**
     * Anonymity is the DEFAULT and is enforced at serialisation, never in the UI. Recognition is
     * opt-in: naming a giver who did not ask to be named is a privacy incident, and the recipient is
     * never nameable at all.
     */
    anonymous: { type: Boolean, default: true },
    display_name: { type: String, default: null },
    note: { type: String, default: null },
    credited_at: { type: Date, default: null },
    /** Set when credited, from the fund's `expiry_days` at that moment. */
    expires_at: { type: Date, default: null },
    expired_at: { type: Date, default: null },
    /** One warning per contribution, not a weekly reminder about the same $20. */
    expiry_notice_sent: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'community_contributions',
  },
);
/** FIFO consumption + the expiry sweep both walk oldest-first over live money. */
CommunityContributionSchema.index({ business_id: 1, status: 1, expires_at: 1 });
/** The impact dashboard's "who gave, most recent first". */
CommunityContributionSchema.index({ business_id: 1, created_at: -1 });

export type CommunityContributionDoc = InferSchemaType<typeof CommunityContributionSchema>;
export const CommunityContributionModel = defineModel(
  'CommunityContribution',
  CommunityContributionSchema,
);

// ─── community_redemptions — money out ──────────────────────────────────────────────────────
/**
 * Two-phase, mirroring how consignment holds inventory: `reserved` when the fund is committed to an
 * order, `applied` once that order's payment has actually gone through, `released` if it did not.
 *
 * The alternative — spend the fund and then charge the card — leaves the vendor short whenever a
 * card declines, and there is no way to un-eat the meal.
 */
const CommunityRedemptionSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true },
    order_id: { type: String, default: null },
    amount_cents: { type: Number, required: true, min: 1 },
    /** The platform's ordinary marketplace fee on this sale (ADR-005 §4). */
    fee_cents: { type: Number, default: 0 },
    /** UTC YYYY-MM-DD. Carries the one-per-day rule into an index rather than a race-prone read. */
    day_key: { type: String, required: true },
    /**
     * `refunded` is distinct from `released`, and the difference is load-bearing for the daily
     * limit. A `released` redemption never happened (the card failed before the order existed), so
     * it must not consume the person's one slot. A `refunded` one DID happen and was then unwound —
     * it stays inside the unique index's partial filter, because freeing the slot would let someone
     * order, cancel, and re-draw the pool repeatedly within a day.
     */
    status: {
      type: String,
      enum: ['reserved', 'applied', 'released', 'refunded'],
      default: 'reserved',
    },
    released_reason: { type: String, default: null },
    applied_at: { type: Date, default: null },
    refunded_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'community_redemptions',
  },
);
/**
 * THE fraud floor (PIF-10a). One redemption per account per business per day, enforced by the
 * database rather than by a read-then-write that two concurrent taps would both pass.
 *
 * Partial on live rows: a `released` redemption did not happen, so it must not consume the person's
 * one slot for the day. Copied from `GiveawayClaimSchema`, which solved exactly this.
 */
CommunityRedemptionSchema.index(
  { business_id: 1, user_id: 1, day_key: 1 },
  // `refunded` is included deliberately — see the status comment above. A cancelled order does not
  // hand the person a fresh draw on the pool.
  { unique: true, partialFilterExpression: { status: { $in: ['reserved', 'applied', 'refunded'] } } },
);
/** The daily-budget check, and the impact dashboard's date ranges. */
CommunityRedemptionSchema.index({ business_id: 1, day_key: 1, status: 1 });

export type CommunityRedemptionDoc = InferSchemaType<typeof CommunityRedemptionSchema>;
export const CommunityRedemptionModel = defineModel(
  'CommunityRedemption',
  CommunityRedemptionSchema,
);
