import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';

/**
 * Sales tax collected as marketplace facilitator (Phase 5).
 *
 * Once the platform processes the customer's payment it becomes the *marketplace facilitator* in
 * most US states, which makes collecting and remitting sales tax a legal obligation rather than a
 * feature. The money is never ours: it is collected on the state's behalf, held as a liability, and
 * remitted on a filing schedule.
 *
 * One immutable record per taxed sale, so a filing can always be reconstructed from source.
 */
const TaxCollectionSchema = new Schema(
  {
    sale_payment_id: { type: String, required: true, index: true },
    checkout_id: { type: String, required: true },
    /** State code (e.g. "CA") — the filing jurisdiction. */
    jurisdiction: { type: String, required: true, index: true },
    city_slug: { type: String, default: null },
    /** Pre-tax amount the tax was computed on. */
    taxable_amount_cents: { type: Number, required: true },
    rate_bps: { type: Number, required: true },
    tax_cents: { type: Number, required: true },
    /** Stripe Tax calculation id when Stripe Tax is active; null when using the local rate table. */
    provider_calculation_id: { type: String, default: null },
    source: { type: String, enum: ['stripe_tax', 'rate_table'], default: 'rate_table' },
    /** Set once included in a remittance filing — prevents double-filing. */
    remitted_at: { type: Date, default: null },
    remittance_ref: { type: String, default: null },
    collected_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'tax_collections' },
);
TaxCollectionSchema.index({ jurisdiction: 1, collected_at: 1 });
TaxCollectionSchema.index({ remitted_at: 1, jurisdiction: 1 }); // open-liability queries
TaxCollectionSchema.plugin(immutablePlugin);

export type TaxCollectionDoc = InferSchemaType<typeof TaxCollectionSchema>;
export const TaxCollectionModel = defineModel('TaxCollection', TaxCollectionSchema);
