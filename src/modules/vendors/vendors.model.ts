import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Vendor / business domain. See DATABASE_SCHEMA_PLAN.md §2. Discount schedule + live sessions are
 * Phase 2; Phase 1 covers business CRUD, menus, category suggestions, and license gating.
 */

/** One weekly opening-hours entry. `day` is 0=Sun..6=Sat; times are "HH:MM" 24h. */
const HoursSchema = new Schema(
  { day: Number, open: String, close: String },
  { _id: false },
);

// ─── businesses ────────────────────────────────────────────────────────────────────────────
const BusinessSchema = new Schema(
  {
    owner_user_id: { type: String, required: true, index: true },
    /**
     * The owner's explicit module set (BUSINESS_MODULE_SYSTEM.md §3).
     * `undefined` means INHERIT the category archetype's defaults — NOT "no modules". That's why
     * it has no default: existing businesses keep resolving to full defaults with no backfill,
     * and improving an archetype default improves every business that never customised.
     */
    enabled_modules: { type: [String], default: undefined },
    name: { type: String, required: true },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    description: { type: String, default: null },
    logo_url: { type: String, default: null }, // customer-facing map pin icon
    cover_photo_url: { type: String, default: null },
    /**
     * `_id: false` — an opening-hours entry is a value, not an entity: nothing references one, and
     * the whole array is replaced on every update. The generated id was pure noise that leaked into
     * the API response and then broke the strict update schema when a client echoed it back.
     */
    hours: { type: [HoursSchema], default: [] },
    today_special_menu_item_id: { type: Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    service_area: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined }, // [lng, lat]
    },
    service_radius_m: { type: Number, default: null },
    /** What a service business charges to come to you (BP-3). Null = not applicable / not set. */
    travel_fee_cents: { type: Number, default: null },
    /**
     * 7.5 / P-14 — scheduled pickup. Off by default: a vendor who has not thought about it will not
     * be at a pitch to hand over an order at 4pm, and a scheduled order nobody shows up for is a
     * refund and a bad review rather than a feature.
     */
    scheduled_pickup: {
      enabled: { type: Boolean, default: false },
      /** How far ahead an order must be placed. Below this, it is a `pickup_now` order. */
      min_lead_minutes: { type: Number, default: 30, min: 5, max: 1440 },
      /** How far ahead orders may be taken. Bounded — a truck cannot promise next month. */
      max_days_ahead: { type: Number, default: 7, min: 1, max: 30 },
      /** Slot granularity in minutes. Times are rounded to this, so a queue is manageable. */
      slot_minutes: { type: Number, default: 15, min: 5, max: 60 },
    },
    payout_account_ref: { type: String, default: null },
    is_hub: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'businesses' },
);
BusinessSchema.index({ category_id: 1 });
BusinessSchema.index({ service_area: '2dsphere' });

export type BusinessDoc = InferSchemaType<typeof BusinessSchema>;
export const BusinessModel = defineModel('Business', BusinessSchema);

// ─── menu_items ────────────────────────────────────────────────────────────────────────────
const MenuItemSchema = new Schema(
  {
    business_id: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    photo_url: { type: String, default: null },
    price_cents: { type: Number, required: true },
    is_available: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'menu_items' },
);
MenuItemSchema.index({ business_id: 1, is_available: 1 });

export type MenuItemDoc = InferSchemaType<typeof MenuItemSchema>;
export const MenuItemModel = defineModel('MenuItem', MenuItemSchema);

// ─── category_suggestions (admin-reviewed; never self-service — Q8) ─────────────────────────
const CategorySuggestionSchema = new Schema(
  {
    submitted_by_business_id: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    proposed_name: { type: String, required: true },
    proposed_parent_category_id: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    justification: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewed_by: { type: String, default: null },
    reviewed_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'category_suggestions',
  },
);

export type CategorySuggestionDoc = InferSchemaType<typeof CategorySuggestionSchema>;
export const CategorySuggestionModel = defineModel('CategorySuggestion', CategorySuggestionSchema);

// ─── license_documents (gate going-live for regulated categories) ──────────────────────────
const LicenseDocumentSchema = new Schema(
  {
    business_id: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    category_id: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    document_url: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewed_by: { type: String, default: null },
    reviewed_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'license_documents',
  },
);
LicenseDocumentSchema.index({ business_id: 1, category_id: 1, status: 1 });

export type LicenseDocumentDoc = InferSchemaType<typeof LicenseDocumentSchema>;
export const LicenseDocumentModel = defineModel('LicenseDocument', LicenseDocumentSchema);
