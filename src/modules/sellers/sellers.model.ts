import { Schema, type InferSchemaType } from 'mongoose';

import { SELLER_SKILLS, SELLER_VENUES, SELLER_TRANSPORT } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * ═══ D-2 — THE SELLER PROFILE ═══
 *
 * The vision brief promises AI that matches products to people: "someone good at talking with
 * customers receives toys and jewellery; someone attending car events receives automotive". The
 * ranking engine could never do that, because nothing in the system described the SELLER. Matching
 * ran on past-category affinity alone, which means a brand-new seller — the exact person the
 * platform is trying to activate — got no personalisation at all.
 *
 * This is the missing input. Two halves, kept in separate fields on purpose:
 *
 *  • SELF-DECLARED (`skills`, `venues`, `transport`, `hours`) — what someone says about themselves.
 *    Available from minute one, which is what fixes the cold start.
 *  • INFERRED (`inferred_*`) — what their behaviour shows. Recomputed from real outcomes.
 *
 * They are never merged into one field. When the two disagree that disagreement is the signal worth
 * having, and a blended number would destroy it — plus a seller must always be able to see what
 * they told us, separately from what we concluded.
 */
const SellerProfileSchema = new Schema(
  {
    user_id: { type: String, required: true, unique: true },

    // ── Self-declared ──
    /** What they're good at. Drives which product categories rank for them. */
    skills: { type: [String], enum: SELLER_SKILLS, default: [] },
    /** Where they actually sell — the brief's "someone at car events" signal. */
    venues: { type: [String], enum: SELLER_VENUES, default: [] },
    /** Caps how much stock, and how bulky, is realistic to recommend. */
    transport: { type: String, enum: SELLER_TRANSPORT, default: null },
    /** UTC hours they're typically available, 0–23. Feeds the time-of-day signal per seller. */
    available_hours: { type: [Number], default: [] },
    /** Free text, shown to hub owners deciding on a checkout. Never parsed. */
    bio: { type: String, default: null, maxlength: 400 },

    // ── Inferred (written only by `recomputeInferred`) ──
    /** Category slugs they've actually sold, best-selling first. */
    inferred_categories: { type: [String], default: [] },
    /** Units sold per completed checkout — the honest read on whether they shift stock. */
    inferred_sell_through: { type: Number, default: null },
    /** UTC hours their sales actually happen in. */
    inferred_active_hours: { type: [Number], default: [] },
    inferred_at: { type: Date, default: null },
    /**
     * How much evidence sits behind the inferred fields. The engine weights them by this, so a
     * profile with one sale doesn't overrule what the seller told us about themselves.
     */
    inferred_sample_size: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'seller_profiles' },
);

export type SellerProfileDoc = InferSchemaType<typeof SellerProfileSchema>;
export const SellerProfileModel = defineModel('SellerProfile', SellerProfileSchema);
