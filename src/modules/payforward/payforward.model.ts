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

    /**
     * ═══ PIF-II (ADR-005 §9) — SPECIFIC-ITEM contributions ("suspended coffee"). ═══
     *
     * The pool pays for ANY item a redeemer picks; this flag enables the parallel path where a
     * contributor BUYS a specific menu item in advance and leaves it for the next eligible
     * customer to claim. Separate from `accepting` because a vendor might want pool money (easy
     * to administer) but not specific items (which require real inventory availability at
     * claim time), or vice-versa.
     */
    accepting_items: { type: Boolean, default: true },
    /**
     * Ceiling on how many FUNDED-but-unclaimed items may queue up for this business at once.
     * Null = uncapped. The number matters because an unlimited queue invites a vendor's menu
     * being gamed — a flood of cheap items pre-bought on a sale day costs the vendor the
     * inventory the next customer walks in expecting.
     */
    max_items_waiting: { type: Number, default: null, min: 1 },
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
    /**
     * ADR-005 §7 — the change-of-mind window, and what it actually returned.
     *
     * Deliberately NOT a status. A gift that was $20, of which $6 fed somebody before the giver
     * changed their mind, is still a $6 contribution — flipping it to `refunded` would erase a
     * meal that genuinely happened from every impact figure. The status stays `succeeded` and this
     * records the part that came back, so `contributedCents` can net it out honestly.
     */
    refunded_cents: { type: Number, default: 0 },
    refunded_at: { type: Date, default: null },
    stripe_refund_id: { type: String, default: null },
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

// ─── community_item_contributions — specific item earmarked for the next claimer ────────────
/**
 * ═══ PIF-II SPECIFIC-ITEM CONTRIBUTION ("suspended coffee") ═══
 *
 * The parallel path to the pool: a contributor BUYS a specific menu item in advance
 * (snapshotted name + price at purchase time), the row sits `funded`, and the next eligible
 * customer picks it from the business profile to redeem on their order.
 *
 * Why NOT reuse `CommunityContribution`:
 *
 *   • A pool contribution is cash, FIFO-consumed and partially spendable. An item is one
 *     indivisible claim — a $6 item used on an $8 order does NOT turn into $2 leftover.
 *   • A pool contribution covers any item a redeemer picks; an item contribution covers
 *     exactly the item it names, so the redemption surface is "claim this specific item" not
 *     "credit at checkout".
 *   • Expiry semantics differ. A dormant pool dollar is unclaimed property in some states; a
 *     dormant item is physical inventory the vendor would otherwise have sold, so the vendor
 *     gets to decide (via `expiry_days`) and the money refunds to the giver on expiry rather
 *     than redistributing.
 *
 * **Snapshot pricing is deliberate.** `price_cents_at_purchase` is the price the contributor
 * paid; it does NOT re-resolve to the menu item's current price at claim time. A customer
 * who gave at $5 and comes back to find the item is $7 did not short the next recipient — the
 * contributor pre-paid for a specific instance of that item.
 *
 * Lifecycle:
 *   pending → funded (webhook) → reserved → claimed (order succeeds)
 *                                        → released (card failed; back to funded)
 *                            → refunded (giver change-of-mind, before claim)
 *                            → expired  (sweep; refunded to giver)
 */
const CommunityItemContributionSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    menu_item_id: { type: String, required: true, index: true },
    /** Snapshotted so a later price change doesn't retroactively alter the claim. */
    menu_item_name_at_purchase: { type: String, required: true },
    price_cents_at_purchase: { type: Number, required: true, min: 1 },

    contributor_id: { type: String, required: true, index: true },
    anonymous: { type: Boolean, default: true },
    display_name: { type: String, default: null },
    note: { type: String, default: null, maxlength: 280 },

    stripe_payment_intent_id: { type: String, required: true, unique: true },

    status: {
      type: String,
      enum: ['pending', 'funded', 'reserved', 'claimed', 'released', 'refunded', 'expired'],
      default: 'pending',
      index: true,
    },

    /** Set when the webhook claims the pending intent. Credits the item to the queue. */
    funded_at: { type: Date, default: null },

    /** Set when a redeemer reserves it on an order. The reservation blocks other reservers. */
    reserved_by_user_id: { type: String, default: null },
    reserved_order_id: { type: String, default: null },
    reserved_at: { type: Date, default: null },

    /** Set when the order's payment succeeds. Terminal. */
    claimed_by_user_id: { type: String, default: null },
    claimed_order_id: { type: String, default: null },
    claimed_at: { type: Date, default: null },

    /** Change-of-mind refund (giver, within 24h) or auto-refund on expiry. */
    refunded_at: { type: Date, default: null },
    refunded_cents: { type: Number, default: 0 },
    stripe_refund_id: { type: String, default: null },

    /** Set when the webhook creates the row; expired at this moment if still funded. */
    expires_at: { type: Date, required: true, index: true },
    expired_at: { type: Date, default: null },
    expiry_notice_sent: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'community_item_contributions',
  },
);
/**
 * The hot query: "funded items on this business's queue, oldest first". FIFO so a contributor
 * waiting longest is honoured first and the expiry sweep walks oldest-first.
 */
CommunityItemContributionSchema.index({ business_id: 1, status: 1, funded_at: 1 });
/** Reservation uniqueness: a row can be reserved by at most one order at a time (enforced by
 *  the state transition — only `funded` → `reserved` is allowed — but the index helps the
 *  reserver pick an available row atomically). */
CommunityItemContributionSchema.index({ status: 1, expires_at: 1 });

export type CommunityItemContributionDoc = InferSchemaType<typeof CommunityItemContributionSchema>;
export const CommunityItemContributionModel = defineModel(
  'CommunityItemContribution',
  CommunityItemContributionSchema,
);
