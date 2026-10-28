import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 0 schema. ═══
 *
 * A Brand is the real-world entity that owns one or more operating businesses. For single-owner
 * profiles (today's world), one `Brand` holds exactly one `Business` and one `BrandMembership`
 * row with `role: 'owner'` — behaviour is identical to the pre-brand model. Later phases widen
 * the model to multiple businesses + operator memberships; this file is the foundation they
 * build on.
 *
 * Why a separate collection rather than fields on Business:
 *
 *  • A franchise owner can have more than one business under the same brand (phase 1 live-map
 *    re-key relies on this).
 *  • Brand-level fields (logo, cover photo) belong on the brand so a renamed location doesn't
 *    orphan customer-facing identity.
 *  • Memberships need a stable anchor id — brand_id — not a business id that may be rotated.
 *
 * See FRANCHISE_IMPLEMENTATION_ROADMAP.md §Phase 0 for the full rationale.
 */
const BrandSchema = new Schema(
  {
    name: { type: String, required: true },
    /** URL-friendly identifier. Human-readable, unique. Set once on creation. */
    slug: { type: String, required: true, unique: true, index: true },
    logo_url: { type: String, default: null },
    cover_photo_url: { type: String, default: null },
    /**
     * The user who owns the brand. Required because every brand must have exactly one owner at
     * all times — Phase 3 adds a transfer flow for admin-mediated ownership changes, but a brand
     * with no owner is a brand nobody can act for.
     */
    owner_user_id: { type: String, required: true, index: true },
    /**
     * Status. `active` is the only workable state for now; `archived` exists so an admin can
     * retire a brand without deleting it (its businesses stop operating together but history
     * stays queryable).
     */
    status: { type: String, enum: ['active', 'archived'], default: 'active' },

    /**
     * ═══ FRANCHISE / MULTI-VENDOR — Phase 2 payout policy. ═══
     *
     * Determines how a brand's sales are settled.
     *
     *  • `pooled` (default) — brand receives the full net exactly as today. Zero behaviour
     *    change for single-owner profiles and franchises that haven't opted in. The owning
     *    business's `payout_account_ref` is where the money lands, same destination charge path
     *    orders have always used.
     *
     *  • `per_operator` — the charge is taken onto the platform balance (NOT a destination
     *    charge), and on order completion the net is split to each operator's connected account
     *    per `splits`. A `brand_split` ledger row is written per leg so the split is auditable
     *    and reconciliation can rebuild it from the event stream. Any operator without an
     *    `approved_at_by_owner + payouts_enabled` Stripe account at settlement time has their
     *    leg routed to the brand owner's own account with a note (`no_payout_account`), so no
     *    money is ever stranded.
     *
     * The splits array must sum to 10000 bps (100%); the service rejects anything else at
     * write time. An empty `per_operator` splits array is a configuration error, treated as
     * `pooled` at settlement with a logged warning — paying 0% to every operator would strand
     * every franchise sale.
     */
    payout_policy: {
      mode: {
        type: String,
        enum: ['pooled', 'per_operator'],
        default: 'pooled',
      },
      splits: {
        type: [
          {
            _id: false,
            operator_id: { type: Schema.Types.ObjectId, ref: 'BrandOperator', required: true },
            /** Share in basis points (10000 = 100%). Sum MUST equal 10000. */
            share_bps: { type: Number, required: true, min: 0, max: 10000 },
          },
        ],
        default: [],
      },
      /** When the policy last changed, so a dispute can see which policy applied to an order. */
      updated_at: { type: Date, default: null },
      updated_by: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'brands' },
);

export type BrandDoc = InferSchemaType<typeof BrandSchema>;
export const BrandModel = defineModel('Brand', BrandSchema);

/**
 * ═══ Brand membership — "who may do what" source of truth. ═══
 *
 * One row per (user, brand). The role dictates what helper calls return in
 * `shared/businessAccess`. Scoped business ids let an `operator` be restricted to specific
 * trucks within the brand — an empty array means "all businesses the brand has".
 *
 * Status is a lifecycle, not a role: `invited` is a pending acceptance (Phase 3 writes these,
 * Phase 0 writes only `active` rows directly for the current owner during migration).
 */
const BrandMembershipSchema = new Schema(
  {
    brand_id: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    user_id: { type: String, required: true, index: true },
    role: {
      type: String,
      enum: ['owner', 'manager', 'operator'],
      required: true,
    },
    /**
     * Businesses this membership is scoped to. Interpretation:
     *   • `[]` (empty) — all businesses the brand has, present and future.
     *   • `[bizA, bizB]` — only those two.
     * Enforced by the `businessAccess` helper. Owners and managers typically have `[]`; an
     * operator typically has one business id (their truck).
     */
    scoped_business_ids: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Business' }],
      default: [],
    },
    /** Who invited this user. Null for the brand owner's own self-membership (migrated or
     * created on brand creation). */
    invited_by: { type: String, default: null },
    /**
     * `invited` — awaiting acceptance (Phase 3). `active` — in effect. `revoked` — history row,
     * no access. Not an enum of two because the admin surface needs to show "invited" distinctly
     * from "active" even in the Phase 0 migration path (which only writes `active`).
     */
    status: {
      type: String,
      enum: ['invited', 'active', 'revoked'],
      default: 'active',
      index: true,
    },
    invited_at: { type: Date, default: null },
    accepted_at: { type: Date, default: null },
    revoked_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'brand_memberships',
  },
);
/**
 * One active role per (user, brand). An `invited` + `active` row for the same pair would be a
 * state-machine bug; the partial unique index enforces that `active` is unique while allowing
 * historical `revoked` rows to coexist with a new `active` row (re-invite scenario).
 */
BrandMembershipSchema.index(
  { brand_id: 1, user_id: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['invited', 'active'] } } },
);

export type BrandMembershipDoc = InferSchemaType<typeof BrandMembershipSchema>;
export const BrandMembershipModel = defineModel('BrandMembership', BrandMembershipSchema);
