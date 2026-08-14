import { Schema, type InferSchemaType } from 'mongoose';

import { ARCHETYPES, CATEGORY_TABS } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * Reference/seed data: the curated launch category taxonomy (~15–25 rows, Q8), cities
 * (city-scoping for expansion), and the admin-configurable fee schedule. See
 * DATABASE_SCHEMA_PLAN.md §2, §11 and BACKEND_FEATURE_INVENTORY.md (fee schedule is data, not code).
 */

// ─── categories ────────────────────────────────────────────────────────────────────────────
const CategorySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    parent_category_id: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    top_level_tab: { type: String, enum: CATEGORY_TABS, required: true },
    /**
     * Drives the business's default module set (BUSINESS_CATEGORY_MATRIX.md §5). Nullable rather
     * than required so legacy rows and the category-suggestion approval path (which doesn't pick
     * one until BP-5) stay valid — the resolver falls back to DEFAULT_ARCHETYPE_BY_TAB.
     */
    archetype: { type: String, enum: ARCHETYPES, default: null },
    /** Per-category tweaks to the archetype defaults, e.g. `{ booking: true }`. */
    module_overrides: { type: Schema.Types.Mixed, default: {} },
    requires_license: { type: Boolean, default: false },
    regulated_by: { type: String, default: null },
    /**
     * §43 — Rent-to-Own eligibility. **Default-deny**: a category may be offered on RTO only when an
     * admin has explicitly enabled it. The spec requires restricting products that are illegal,
     * unsafe, heavily regulated, or unsuitable for repeated use, and singles out vehicles as
     * needing a separately reviewed programme — none of which is expressible as an allow-by-default
     * rule, because the dangerous set is open-ended and the safe set is small and knowable.
     *
     * A licensed or regulated category can never become eligible even with this flag set; see
     * `assertCategoryEligible`.
     */
    rto_eligible: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'categories' },
);
CategorySchema.index({ top_level_tab: 1 });
CategorySchema.index({ parent_category_id: 1 });

export type CategoryDoc = InferSchemaType<typeof CategorySchema>;
export const CategoryModel = defineModel('Category', CategorySchema);

// ─── cities ────────────────────────────────────────────────────────────────────────────────
const CitySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    state: { type: String, required: true },
    status: { type: String, enum: ['pre_launch', 'live'], default: 'pre_launch' },
    launch_date: { type: Date, default: null },
    feature_flags: { type: Schema.Types.Mixed, default: {} },
    /**
     * Marketplace-facilitator sales tax (Phase 5). In most US states a marketplace that PROCESSES
     * payments becomes the facilitator and is legally obliged to collect and remit sales tax on
     * behalf of its sellers. Rate is per-jurisdiction config, in basis points.
     * `null` = not registered in this jurisdiction yet, so nothing is collected.
     */
    sales_tax_bps: { type: Number, default: null },
    /** State registration id used on remittance filings. */
    tax_registration_id: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'cities' },
);

export type CityDoc = InferSchemaType<typeof CitySchema>;
export const CityModel = defineModel('City', CitySchema);

// ─── fee_schedule (versioned) ──────────────────────────────────────────────────────────────
/**
 * One rule in the typed fee registry (DEBT1). A fee = flat_cents + rate_bps·base, clamped to
 * [min_cents, max_cents]. Kept open (Map of this subdoc keyed by fee-type) so adding a fee type is
 * a config write, not a schema/code change. `_id: false` — these are inline value objects.
 */
const FeeRuleSchema = new Schema(
  {
    rate_bps: { type: Number, default: 0 },
    flat_cents: { type: Number, default: 0 },
    min_cents: { type: Number, default: null },
    max_cents: { type: Number, default: null },
  },
  { _id: false },
);

const FeeScheduleSchema = new Schema(
  {
    version: { type: Number, required: true, unique: true },
    effective_at: { type: Date, required: true },
    consignment_fee_bps: { type: Number, required: true }, // basis points — legacy single rate (back-compat)
    /**
     * Typed fee registry keyed by FeeType (constants.FEE_TYPES). The resolver reads this first and
     * falls back to `consignment_fee_bps` (marketplace/consignment) then code defaults, so existing
     * rows with no `fees` still resolve 10%. See payments/fees.ts.
     */
    fees: { type: Map, of: FeeRuleSchema, default: {} },
    round_up_platform_cut_bps: { type: Number, default: 0 }, // always 0 — FR-6.4
    membership_overrides: { type: Schema.Types.Mixed, default: {} },
    created_by: { type: String, default: 'system' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'fee_schedule' },
);

export type FeeScheduleDoc = InferSchemaType<typeof FeeScheduleSchema>;
export const FeeScheduleModel = defineModel('FeeSchedule', FeeScheduleSchema);
