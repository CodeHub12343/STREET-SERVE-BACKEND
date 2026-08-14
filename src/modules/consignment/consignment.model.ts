import { Schema, type InferSchemaType } from 'mongoose';

import {
  DEFAULT_AUTO_APPROVE_MAX_VALUE_CENTS,
  DEFAULT_AUTO_APPROVE_MIN_TRUST,
  LISTING_TYPES,
} from '../../config/constants';
import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';

/**
 * Consignment domain (FR-8). Financial correctness + physical chain-of-custody.
 * See DATABASE_SCHEMA_PLAN.md §7.
 */

// ─── hubs (a business with is_hub=true acts as a pickup/return point) ───────────────────────
const HubSchema = new Schema(
  {
    business_id: { type: String, required: true, unique: true },
    owner_user_id: { type: String, required: true },
    /**
     * Signing key for the hub's rotating check-in token. Since Phase 6 this is NEVER displayed —
     * the station shows a short-lived HMAC over it instead (see hubQr.ts).
     */
    checkout_qr_secret: { type: String, required: true },
    /**
     * Grandfathering for hubs that printed the old static QR poster. `true` keeps accepting the
     * raw secret; new hubs default to `false` (rotating tokens only). Phasing this out is what
     * closes the "photograph the poster once, reserve stock forever" hole.
     */
    allow_static_qr: { type: Boolean, default: false },
    /**
     * 6.5 — when this hub's static acceptance ends. `null` on a hub that never had it.
     *
     * The flag alone was never a phase-out: nothing expired it, so "temporary grandfathering"
     * lasted as long as nobody remembered. Acceptance now requires the flag AND a future deadline
     * AND a date before the platform-wide `STATIC_QR_SUNSET_AT` — three conditions, of which two
     * expire on their own.
     */
    static_qr_deadline_at: { type: Date, default: null },
    location: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    address: { type: String, default: null },
    /**
     * Tax jurisdiction the hub sells in (Phase 5). Sales tax is a function of where the sale
     * happens, so the hub's city — not the seller's or the customer's — decides the rate.
     */
    city_slug: { type: String, default: null },
    /**
     * Checkout approval policy (H-03 / FR-8.4). A reservation is auto-approved only when the
     * seller's Trust Score is at or above the floor AND the declared value is at or under the cap;
     * anything else waits in the hub's manual queue. `auto_approve_max_value_cents: null` = no cap.
     */
    auto_approve_min_trust: { type: Number, default: DEFAULT_AUTO_APPROVE_MIN_TRUST },
    auto_approve_max_value_cents: { type: Number, default: DEFAULT_AUTO_APPROVE_MAX_VALUE_CENTS },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'hubs' },
);

// Geospatial discovery (Phase 6): "inventory near me" must be an indexed query, not a full scan.
HubSchema.index({ location: '2dsphere' });
// 5.4: "my hubs" for an owner — the first query every hub-owner screen makes.
HubSchema.index({ owner_user_id: 1 });

export type HubDoc = InferSchemaType<typeof HubSchema>;
export const HubModel = defineModel('Hub', HubSchema);

// ─── products (consignment inventory listed by a hub) ──────────────────────────────────────
const ProductSchema = new Schema(
  {
    hub_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    // Discovery slug (food/shopping/services) — separate from the optional catalog category_id.
    category: { type: String, default: null, index: true },
    photos: { type: [String], default: [] },
    unit_value_cents: { type: Number, required: true },
    // Seller's share of the distributable amount (after platform fee), 0–100.
    consignment_split_percent: { type: Number, required: true, min: 0, max: 100 },
    return_window_hours: { type: Number, required: true },
    condition_requirements: { type: String, default: null },
    listing_type: {
      type: String,
      enum: LISTING_TYPES,
      default: 'consignment',
    },
    /**
     * A-1: set by the gating migration on rows created before `SUPPORTED_LISTING_TYPES` existed,
     * whose `listing_type` the settlement code cannot honour. Purely a review marker — the actual
     * block lives in `addProduct` and `checkout`, which refuse any unsupported type regardless.
     */
    listing_type_flagged_at: { type: Date, default: null },
    /**
     * A-3 premium inventory: the minimum seller Trust Score a hub requires to take this product.
     * `null` = open to anyone who clears the ordinary credit and KYC gates. This is what makes
     * "higher scores unlock better inventory" real rather than aspirational.
     */
    min_seller_trust_score: { type: Number, default: null, min: 0, max: 100 },
    /**
     * D-5: a certification the seller must hold to take this product. Complements — never replaces —
     * `min_seller_trust_score`, because the two answer different questions. Trust measures whether
     * this person's past consignments went well; a certification says they were TAUGHT something.
     * A hub owner with fragile or high-value stock cares about both, and a brand-new seller can earn
     * the certification today where the Trust Score takes weeks.
     */
    required_certification: { type: String, default: null },
    quantity_available: { type: Number, required: true, min: 0 },
    // ── Owner-authored consignment terms (R14/R17/R18), snapshotted onto each checkout ──
    term_days: { type: Number, default: 30 }, // null = no-limit term
    minimum_authorized_price_cents: { type: Number, default: null }, // R18 floor, per unit
    seller_permissions: {
      may_discount: { type: Boolean, default: true },
      may_bundle: { type: Boolean, default: true },
      may_accept_offers: { type: Boolean, default: true },
      may_sell_below_min: { type: Boolean, default: false }, // below floor → needs owner approval
    },
    return_responsibility: { type: String, enum: ['seller', 'hub'], default: 'seller' },
    return_window_days: { type: Number, default: 14 },
    storage_fee_cents_per_day: { type: Number, default: 0 },
    abandonment_after_days: { type: Number, default: 30 },
    /**
     * §39 — automatic renewal, owner-authored and OFF by default. §38 is explicit that a consignment
     * does not auto-renew unless both parties previously agreed to it, so the absence of an answer
     * here has to mean "no", not "probably fine".
     */
    auto_renew: { type: Boolean, default: false },
    /** Days to renew for, or `until_sold` to keep renewing while stock remains. */
    auto_renew_term: { type: Schema.Types.Mixed, default: null },
    /**
     * §37 — notice either party must give to end the agreement early. `null` = derive from the
     * declared value at checkout (`terminationNoticeDaysFor`), which is what the spec's 3 / 7 /
     * 14–30 day bands describe.
     */
    termination_notice_days: { type: Number, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'products' },
);

export type ProductDoc = InferSchemaType<typeof ProductSchema>;
export const ProductModel = defineModel('Product', ProductSchema);

// ─── seller_agreement_acceptances (clickwrap bailment agreement — FR-8.6) ──────────────────
const SellerAgreementAcceptanceSchema = new Schema(
  {
    seller_id: { type: String, required: true },
    version: { type: String, required: true },
    accepted_at: { type: Date, default: () => new Date() },
  },
  { collection: 'seller_agreement_acceptances' },
);
SellerAgreementAcceptanceSchema.index({ seller_id: 1, version: 1 }, { unique: true });

export type SellerAgreementAcceptanceDoc = InferSchemaType<typeof SellerAgreementAcceptanceSchema>;
export const SellerAgreementAcceptanceModel = defineModel(
  'SellerAgreementAcceptance',
  SellerAgreementAcceptanceSchema,
);

// ─── inventory_checkouts (integrity-critical: quantity vs quantity_sold) ───────────────────
const InventoryCheckoutSchema = new Schema(
  {
    seller_id: { type: String, required: true, index: true },
    product_id: { type: String, required: true },
    hub_id: { type: String, required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    quantity_sold: { type: Number, default: 0 }, // maintained by atomic conditional $inc
    unit_value_cents: { type: Number, required: true },
    consignment_split_percent: { type: Number, required: true },
    condition_photo_url: { type: String, required: true },
    seller_agreement_version: { type: String, required: true },
    checked_out_at: { type: Date, default: () => new Date() },
    expected_return_at: { type: Date, required: true },
    // ── Consignment term lifecycle (R14/R15/R17/R18), snapshotted from the product at checkout ──
    term_days: { type: Number, default: null }, // null = no-limit
    expires_at: { type: Date, default: null }, // derived from term; null for no-limit
    current_unit_price_cents: { type: Number, default: null }, // may be reduced (R18); falls back to unit_value_cents
    minimum_authorized_price_cents: { type: Number, default: null },
    seller_permissions: {
      may_discount: { type: Boolean, default: true },
      may_bundle: { type: Boolean, default: true },
      may_accept_offers: { type: Boolean, default: true },
      may_sell_below_min: { type: Boolean, default: false },
    },
    return_responsibility: { type: String, enum: ['seller', 'hub'], default: 'seller' },
    return_window_days: { type: Number, default: 14 },
    storage_fee_cents_per_day: { type: Number, default: 0 },
    abandonment_after_days: { type: Number, default: 30 },
    /**
     * A-3: the seller's Trust band SNAPSHOTTED at checkout, exactly like the owner's terms above.
     * The fee discount a seller was promised when they took the stock must be the one they get at
     * settlement — a score that drifts mid-term (or a band table we re-tune) must never silently
     * re-price a consignment already in flight.
     */
    trust_score_at_checkout: { type: Number, default: null },
    trust_band: { type: String, default: null },
    trust_fee_discount_bps: { type: Number, default: 0 },
    /** F-2: Seller Plus at pickup — its fee discount stacks with the Trust band's at settlement. */
    seller_plus_at_checkout: { type: Boolean, default: false },
    /**
     * B-4: this checkout is covered by a shelter's starter grant. Loss/damage liability on an
     * unsold or lost first pickup falls to the cosigning partner, NOT to the resident — so the
     * return path must never write a debt against them for it.
     */
    starter_grant_partner_id: { type: String, default: null },
    return_pending_at: { type: Date, default: null }, // when it entered Return-Pending (R17)
    notices_sent: { type: [Number], default: [] }, // expiry-notice thresholds already fired (R15)
    /**
     * §37 termination in flight. Ending a consignment is a NOTICE, not an instant repossession:
     * the other party has stock on a shelf or goods in a van and needs the agreed days to react.
     * The sweep completes it once `termination_effective_at` passes.
     */
    termination_notice_days: { type: Number, default: null },
    terminated_by: { type: String, enum: ['seller', 'hub'], default: null },
    termination_notice_at: { type: Date, default: null },
    termination_effective_at: { type: Date, default: null },
    /** §39 renewal terms, snapshotted from the product so a mid-term change cannot apply silently. */
    auto_renew: { type: Boolean, default: false },
    auto_renew_term: { type: Schema.Types.Mixed, default: null },
    /** Who last turned renewal off, for the audit trail either party may need to point at. */
    auto_renew_cancelled_by: { type: String, enum: ['seller', 'hub'], default: null },
    /** Renewals performed — surfaced so nobody has to reverse-engineer why a term keeps moving. */
    renewal_count: { type: Number, default: 0 },
    /** Set when the "this will renew" notice has fired for the current term (§39). */
    renewal_notice_sent_for: { type: Date, default: null },
    status: {
      type: String,
      enum: [
        'pending_approval',
        'declined',
        'active',
        'settled',
        'overdue',
        'disputed',
        'return_pending',
        'ended',
      ],
      default: 'active',
    },
    // ── Hub approval gate (H-03) — goods only leave the hub once this clears ──
    approved_at: { type: Date, default: null },
    approved_by: { type: String, default: null }, // hub owner user id, or 'auto'
    declined_at: { type: Date, default: null },
    decline_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'inventory_checkouts',
  },
);
InventoryCheckoutSchema.index({ seller_id: 1, status: 1 });
InventoryCheckoutSchema.index({ hub_id: 1, status: 1 });
InventoryCheckoutSchema.index({ expected_return_at: 1, status: 1 }); // overdue sweep
InventoryCheckoutSchema.index({ expires_at: 1, status: 1 }); // expiry-notice sweep (R15)

export type InventoryCheckoutDoc = InferSchemaType<typeof InventoryCheckoutSchema>;
export const InventoryCheckoutModel = defineModel('InventoryCheckout', InventoryCheckoutSchema);

// ─── inventory_sales ───────────────────────────────────────────────────────────────────────
const InventorySaleSchema = new Schema(
  {
    checkout_id: { type: String, required: true, index: true },
    quantity_sold: { type: Number, required: true, min: 1 },
    sale_amount_cents: { type: Number, required: true, min: 0 },
    proof_photo_url: { type: String, default: null },
    logged_via: { type: String, enum: ['qr_scan', 'manual'], default: 'manual' },
    /**
     * How the customer paid. `cash` means the money went straight to the seller and NEVER entered
     * the platform — so it can't fund a payout. `digital` means the platform collected it and holds
     * the funds. Until the digital rail ships, every sale is `cash`.
     */
    payment_rail: { type: String, enum: ['cash', 'digital'], default: 'cash', index: true },
    sold_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'inventory_sales' },
);

export type InventorySaleDoc = InferSchemaType<typeof InventorySaleSchema>;
export const InventorySaleModel = defineModel('InventorySale', InventorySaleSchema);

// ─── inventory_returns ──────────────────────────────────────────────────────────────────────
const InventoryReturnSchema = new Schema(
  {
    checkout_id: { type: String, required: true, unique: true },
    quantity_returned: { type: Number, required: true, min: 0 },
    condition_photo_url: { type: String, default: null },
    condition_assessment: { type: String, enum: ['good', 'damaged', 'lost'], default: 'good' },
    returned_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'inventory_returns' },
);

export type InventoryReturnDoc = InferSchemaType<typeof InventoryReturnSchema>;
export const InventoryReturnModel = defineModel('InventoryReturn', InventoryReturnSchema);

// ─── settlements (immutable, append-only) ──────────────────────────────────────────────────
const SettlementSchema = new Schema(
  {
    checkout_id: { type: String, required: true, unique: true },
    gross_sales_cents: { type: Number, required: true },
    platform_fee_cents: { type: Number, required: true },
    hub_share_cents: { type: Number, required: true },
    seller_net_cents: { type: Number, required: true },
    seller_payout_ref: { type: String, default: null },
    hub_payout_ref: { type: String, default: null },
    /**
     * Where the disbursed money came from. A payout may only be made from funds the platform
     * actually collected — paying out `unfunded` proceeds means spending platform capital on a sale
     * that generated none. `legacy_unfunded` marks pre-Phase-0 rows written before this rule existed.
     */
    funding_source: {
      type: String,
      enum: ['collected', 'unfunded', 'mixed', 'none', 'legacy_unfunded'],
      default: 'unfunded',
      index: true,
    },
    /** Gross that actually reached the platform balance (digital rail only). */
    collected_cents: { type: Number, default: 0 },
    /**
     * A-3 Trust reward, recorded so the arithmetic stays auditable years later. `platform_fee_cents`
     * above is the fee ACTUALLY charged (already net of this discount); these two say what the fee
     * would have been and which band earned the reduction. The whole discount is added to
     * `seller_net_cents` — the hub's share is computed from the undiscounted fee and is unaffected.
     */
    trust_fee_discount_cents: { type: Number, default: 0 },
    trust_band: { type: String, default: null },
    /**
     * Per-leg outcome, so "settled" can never again hide the fact that no money moved.
     *   paid            — a transfer was executed
     *   awaiting_funds  — owed, but the sale proceeds never entered the platform
     *   no_account      — funded, but the payee has no payout-enabled Connect account
     *   not_applicable  — nothing owed on this leg
     */
    seller_payout_status: {
      type: String,
      enum: ['paid', 'awaiting_funds', 'no_account', 'not_applicable'],
      default: 'awaiting_funds',
    },
    hub_payout_status: {
      type: String,
      enum: ['paid', 'awaiting_funds', 'no_account', 'not_applicable'],
      default: 'awaiting_funds',
    },
    settled_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'settlements' },
);
SettlementSchema.plugin(immutablePlugin);

export type SettlementDoc = InferSchemaType<typeof SettlementSchema>;
export const SettlementModel = defineModel('Settlement', SettlementSchema);
