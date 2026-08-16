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
    /**
     * What the sponsor agreed to pay, RECORDED BY HAND.
     *
     * Deliberately not a payment rail: no Stripe, no invoice, nothing collected. Sponsorships are
     * negotiated and settled off-platform, and this module describes itself as record-keeping for
     * the pilot. The admin table has always shown a "Spend" column against no field at all — the
     * figure came from a demo fixture — so it was reporting a number nobody had entered and nothing
     * could verify. A hand-entered figure is honest about what it is; an invented one is not.
     */
    contracted_cents: { type: Number, default: 0 },
    /** Free-text note for the arrangement — term, deliverables, who signed it. */
    note: { type: String, default: null },

    /**
     * ═══ SELF-SERVE SPONSORSHIP ═══
     *
     * A sponsor can now buy a placement in the app instead of the deal being closed entirely by
     * email. `contracted_cents` above stays for hand-recorded arrangements; everything below
     * describes money the platform actually collected.
     *
     * The lifecycle is deliberately NOT pay → live:
     *
     *   pending_payment → (webhook) → pending_review → (admin) → active → (sweep) → expired
     *
     * Publishing on payment alone would let anyone with a card put an arbitrary image on the
     * landing page — offensive artwork, a competitor's mark, a scam. The money is taken first and a
     * person approves the logo before it appears; a rejection refunds.
     *
     * `active` (above) stays the single thing the public list and UTM attribution read, so there is
     * exactly one answer to "is this sponsor live right now". `status` records WHY.
     */
    status: {
      type: String,
      enum: ['manual', 'pending_payment', 'pending_review', 'active', 'rejected', 'expired'],
      default: 'manual',
      index: true,
    },
    /** Who bought it, so they can be told when it goes live or is refunded. */
    owner_user_id: { type: String, default: null, index: true },
    contact_email: { type: String, default: null },
    /** The intent this placement waits on — cleared as it settles, which is also the claim. */
    pending_intent_ref: { type: String, default: null, index: true },
    /** What was actually COLLECTED, as opposed to `contracted_cents` which is typed by hand. */
    paid_cents: { type: Number, default: 0 },
    /**
     * The SETTLED intent, kept for the refund path.
     *
     * Distinct from `pending_intent_ref`, which is cleared the moment the webhook claims it — so by
     * the time an admin refuses a logo there would otherwise be nothing left to refund against. A
     * platform charge creates no Transaction row (it is a direct charge to the platform balance),
     * so the intent id IS the handle, exactly as Pay It Forward refunds a contribution.
     */
    paid_intent_ref: { type: String, default: null },
    term_months: { type: Number, default: null },
    /** Set on approval — the term starts when the logo does, not when they paid. */
    starts_at: { type: Date, default: null },
    ends_at: { type: Date, default: null, index: true },
    rejected_reason: { type: String, default: null },
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
