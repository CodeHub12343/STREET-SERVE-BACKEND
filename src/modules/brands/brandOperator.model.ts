import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 1 BrandOperator. ═══
 *
 * One row per truck in a multi-truck brand. The live session's `actor_id` points here (NOT at
 * a Business), so one brand with two trucks produces two distinct `(actor_type: 'operator',
 * actor_id: <brandOperatorId>)` sessions — exactly what the one-pin-per-actor invariant
 * requires.
 *
 * Why NOT reuse `Business` for this: a Business already is the fuzz-radius, menu, hours, licence,
 * payout-account unit — all of those are brand-level in a franchise, not per-truck. A truck of a
 * franchise is a position in space + an operator user id + a human-readable name, and that is
 * exactly what this collection stores.
 *
 * `business_id` is the "virtual home" business the operator operates on behalf of. Phase 2
 * (payouts) widens this with per-operator payout routing; Phase 3 adds the invite flow that
 * creates these rows. In Phase 1 these rows are created manually by an admin so James can run
 * two-truck operations today.
 */
const BrandOperatorSchema = new Schema(
  {
    brand_id: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    /**
     * The business this operator operates as. Required: a truck without a home business has no
     * menu, no category, no licence context — none of the data a map pin needs. Multiple
     * operators MAY share one business (two drivers on one truck is a thing, Phase 3 question).
     */
    business_id: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    /** The person at the wheel. Live-session control is scoped to this exact user id. */
    user_id: { type: String, required: true, index: true },
    /**
     * Public truck name. Shown on the pin together with the brand chip, e.g. "James's Ice Cream —
     * North truck". Required because a pin with no name is a pin a customer cannot refer to.
     */
    display_name: { type: String, required: true },
    status: { type: String, enum: ['active', 'retired'], default: 'active', index: true },

    /**
     * ═══ FRANCHISE / MULTI-VENDOR — Phase 2 operator Stripe-Connect state. ═══
     *
     * `stripe_account_id` is the operator's OWN connected account (not the brand owner's). It's
     * populated after they complete Stripe onboarding; the id is the only piece we store, every
     * other piece (charges_enabled, payouts_enabled, details_submitted) is re-fetched from
     * Stripe at settlement time so a frozen or lapsed account is never silently paid.
     *
     * `approved_at_by_owner` is the SECOND gate. Even after the operator has a valid Stripe
     * account, the brand owner must confirm that this is the account money should go to — the
     * guard against an operator connecting a stolen or wrong account. No approval means the
     * leg routes to the brand owner's own account at settlement with a `no_approval` note.
     */
    stripe_account_id: { type: String, default: null },
    payouts_enabled: { type: Boolean, default: false },
    approved_at_by_owner: { type: Date, default: null },
    approved_by: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'brand_operators',
  },
);
/**
 * One active operator row per (brand, user, business). Partial on `active` so a retired row can
 * coexist with a fresh active one — e.g. the same user is re-added to the same truck later.
 */
BrandOperatorSchema.index(
  { brand_id: 1, business_id: 1, user_id: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

export type BrandOperatorDoc = InferSchemaType<typeof BrandOperatorSchema>;
export const BrandOperatorModel = defineModel('BrandOperator', BrandOperatorSchema);
