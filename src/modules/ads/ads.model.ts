import { Schema, type InferSchemaType } from 'mongoose';

import { AD_PLACEMENTS } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * ═══ F-1 / F-3 — PAID PLACEMENT ═══
 *
 * Two related products on one model, because they are the same mechanic with different subjects:
 *
 *  • F-1 FEATURED — a product or hub boosted in ranking it already appears in.
 *  • F-3 ADVERTISING — a bought slot in a feed, with its own creative.
 *
 * Both are DISCLOSED and both are BOOSTS, never filters. Paid placement that could bury organic
 * results makes discovery untrustworthy, and a marketplace nobody trusts to rank honestly is worth
 * less than the placement fees it collected. `AD_MAX_SHARE_OF_FEED` is the hard version of that.
 */
const PlacementSchema = new Schema(
  {
    /** Who is paying. A user (seller promoting their own stock) or a business (hub, vendor). */
    owner_type: { type: String, enum: ['user', 'business'], required: true },
    owner_id: { type: String, required: true, index: true },

    kind: { type: String, enum: ['featured_product', 'featured_hub', 'ad'], required: true },
    /** Product/hub id for a featured placement; null for a standalone ad. */
    subject_id: { type: String, default: null },

    // ── Ad creative (F-3 only) ──
    headline: { type: String, default: null },
    body: { type: String, default: null },
    image_url: { type: String, default: null },
    click_url: { type: String, default: null },
    placement: { type: String, enum: AD_PLACEMENTS, default: null },

    // ── Targeting ──
    /** City slug; null = everywhere the campaign's budget reaches. */
    city_slug: { type: String, default: null, index: true },
    /** Category slugs this should appear against. Empty = all. */
    categories: { type: [String], default: [] },
    location: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    radius_m: { type: Number, default: null },

    // ── Budget & billing ──
    /**
     * Prepaid, and spent down. Post-pay would mean chasing an advertiser for money already spent on
     * impressions we can't take back — the same reason the consignment rail collects before it pays.
     */
    budget_cents: { type: Number, required: true, min: 0 },
    spent_cents: { type: Number, default: 0 },
    cpm_cents: { type: Number, required: true },

    starts_at: { type: Date, default: () => new Date() },
    ends_at: { type: Date, default: null },
    /**
     * The flat tier bought, if any (spec §32). Null = a CPM campaign priced by budget. Recorded so
     * a receipt and the dashboard can say "one week — $15" rather than reverse-engineering it from
     * a budget and a date range.
     */
    tier_days: { type: Number, default: null },
    status: {
      type: String,
      enum: ['pending_payment', 'active', 'paused', 'exhausted', 'ended'],
      /**
       * Placements start UNPAID. The module's own comment always claimed the budget was "prepaid
       * and spent down", but nothing ever charged for one — every placement on the platform was
       * free, and the serving path happily delivered it. A placement now becomes `active` only when
       * its charge settles, which is the same solvency rule the ping budget and the consignment
       * settlement rail already follow: never spend, or deliver, against money that has not arrived.
       */
      default: 'pending_payment',
      index: true,
    },
    /** The Stripe intent that pays for this placement; matched by the webhook to activate it. */
    payment_intent_ref: { type: String, default: null },
    paid_at: { type: Date, default: null },

    // ── Delivery counters ──
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    /** Impressions counted but not yet billed — see AD_IMPRESSION_BATCH. */
    unbilled_impressions: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'placements' },
);
PlacementSchema.index({ kind: 1, status: 1, city_slug: 1 });
PlacementSchema.index({ location: '2dsphere' });
/** The serving query: active, in-budget, in-window. */
PlacementSchema.index({ status: 1, starts_at: 1, ends_at: 1 });
/** Activation on webhook: find the placement this intent paid for. */
PlacementSchema.index({ payment_intent_ref: 1 }, { unique: true, sparse: true });

export type PlacementDoc = InferSchemaType<typeof PlacementSchema>;
export const PlacementModel = defineModel('Placement', PlacementSchema);
