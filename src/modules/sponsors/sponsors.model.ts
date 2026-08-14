import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Sponsors (Q9 default): logo placement + UTM attribution + manual reporting for the pilot — a
 * dedicated sponsor dashboard is deferred to V1.x. See DATABASE_SCHEMA_PLAN.md §11.
 */
const SponsorSchema = new Schema(
  {
    name: { type: String, required: true },
    logo_url: { type: String, default: null },
    tier: { type: String, default: 'launch' },
    launch_city_slug: { type: String, default: null },
    utm_code: { type: String, required: true, unique: true },
    impressions_count: { type: Number, default: 0 },
    attributed_signups_count: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'sponsors' },
);

export type SponsorDoc = InferSchemaType<typeof SponsorSchema>;
export const SponsorModel = defineModel('Sponsor', SponsorSchema);

const PreregistrationSchema = new Schema(
  {
    full_name: { type: String, required: true },
    // Normalized lowercase; one waitlist spot per email (LP-5 duplicate flow → 409 DUPLICATE).
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, default: null },
    intended_role: { type: String, default: 'customer' },
    city_slug: { type: String, default: null },
    utm_code: { type: String, default: null },
    sponsor_id: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'preregistrations' },
);
PreregistrationSchema.index({ email: 1 }, { unique: true });
PreregistrationSchema.index({ sponsor_id: 1 });

export type PreregistrationDoc = InferSchemaType<typeof PreregistrationSchema>;
export const PreregistrationModel = defineModel('Preregistration', PreregistrationSchema);
