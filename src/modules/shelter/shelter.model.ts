import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Homeless Shelter Partner Program (Flow 10, FR-12). Admin-verified partner orgs co-sign a CAPPED
 * starter allocation for a resident, who enters at a Tier-1-equivalent without standard KYC. The
 * cosigned allocation is the HARD cap on the shelter's liability (FR-12.4).
 * See DATABASE_SCHEMA_PLAN.md §3.
 */
const ShelterPartnerSchema = new Schema(
  {
    organization_name: { type: String, required: true },
    owner_user_id: { type: String, required: true }, // the shelter-staff account that enrolls residents
    status: { type: String, enum: ['pending', 'verified', 'suspended'], default: 'pending' },
    verified_by_admin_id: { type: String, default: null },
    verified_at: { type: Date, default: null },
    /**
     * B-2: where the shelter is, so residents are pointed at hubs they can actually walk to. Null
     * disables the proximity check rather than blocking enrollment — a partner without coordinates
     * is a data gap, not a reason to turn residents away.
     */
    location: {
      type: { type: String, enum: ['Point'], default: undefined },
      coordinates: { type: [Number], default: undefined },
    },
    /**
     * B-3 CUSTODY. A resident with no bank account cannot receive a Stripe transfer, and their
     * settled money was being stranded as `no_account` forever. With custody enabled, their payouts
     * are transferred to the SHELTER's connected account and earmarked per-resident
     * (`shelter_custody`), for the shelter to hand over as cash or in kind.
     *
     * This is the representative-payee model, and it is a real fiduciary duty — so it is opt-in per
     * partner, recorded with who accepted it, and every held cent is individually tracked and
     * reconcilable. A partner that has not accepted custody simply doesn't receive resident funds.
     */
    custody_enabled: { type: Boolean, default: false },
    custody_accepted_by: { type: String, default: null }, // staff user id who accepted the duty
    custody_accepted_at: { type: Date, default: null },
    /** Where residents physically collect cash — shown to them verbatim. */
    custody_collection_note: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'shelter_partners',
  },
);
ShelterPartnerSchema.index({ owner_user_id: 1 });
ShelterPartnerSchema.index({ location: '2dsphere' });

export type ShelterPartnerDoc = InferSchemaType<typeof ShelterPartnerSchema>;
export const ShelterPartnerModel = defineModel('ShelterPartner', ShelterPartnerSchema);

const ShelterEnrollmentSchema = new Schema(
  {
    shelter_partner_id: { type: String, required: true, index: true },
    /**
     * B-1: null until the resident claims their invite. Enrollment used to REQUIRE a 24-char user
     * id, which meant staff had to get the resident through account signup first, in another app
     * session, on a device they may not own — and then copy an id back. In practice that is where
     * the funnel died. Staff can now enrol first and hand over a claim code.
     */
    resident_user_id: { type: String, default: null },
    // Hard cap on the shelter's liability (FR-12.4) — a resident default recovers only against this.
    cosigned_allocation_cents: { type: Number, required: true, min: 0 },
    staff_verifier_name: { type: String, required: true },
    enrolled_at: { type: Date, default: () => new Date() },

    // ── B-1 invite / claim ──
    /** Short human-readable code the resident types in. Hashed? No — it is single-use, short-lived,
     *  scoped to one enrollment, and staff read it aloud. Storing it plainly is what lets staff
     *  re-read it to someone who lost the slip of paper. */
    claim_code: { type: String, default: null, index: true },
    claim_expires_at: { type: Date, default: null },
    claimed_at: { type: Date, default: null },
    status: {
      type: String,
      enum: ['invited', 'active', 'exited', 'revoked'],
      default: 'invited',
      index: true,
    },
    /** Set when a resident leaves the program — capabilities revert, custody is reconciled. */
    exited_at: { type: Date, default: null },
    exit_reason: { type: String, default: null },

    // ── B-5 training ──
    training_completed_at: { type: Date, default: null },
    /** Best score achieved, kept so staff can see who needed help rather than only who passed. */
    training_score_percent: { type: Number, default: null },

    // ── B-4 starter grant ──
    starter_grant_used: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'shelter_enrollments',
  },
);
/**
 * Partial-unique: one enrollment per (partner, resident) — but only once the resident EXISTS.
 * Without the partial filter every unclaimed invite would collide on `resident_user_id: null`,
 * so a shelter could only ever have one invite outstanding at a time.
 */
ShelterEnrollmentSchema.index(
  { shelter_partner_id: 1, resident_user_id: 1 },
  { unique: true, partialFilterExpression: { resident_user_id: { $type: 'string' } } },
);
ShelterEnrollmentSchema.index({ resident_user_id: 1, status: 1 });

export type ShelterEnrollmentDoc = InferSchemaType<typeof ShelterEnrollmentSchema>;
export const ShelterEnrollmentModel = defineModel('ShelterEnrollment', ShelterEnrollmentSchema);

// ─── shelter_custody (B-3) ──────────────────────────────────────────────────────────────────
/**
 * One earmarked sum the shelter is holding for one resident.
 *
 * The platform ledger is unchanged by custody: when the transfer executes, the platform genuinely
 * paid out and its payable to the resident is genuinely discharged. What custody records is the
 * duty that then exists OFF the platform — the shelter holding someone else's money — so it can be
 * reconciled, reported to funders, and disputed if it goes wrong.
 *
 * Append-only in spirit: `status` moves forward, and a disbursement records who handed it over and
 * whether the resident acknowledged receipt.
 */
const ShelterCustodySchema = new Schema(
  {
    shelter_partner_id: { type: String, required: true, index: true },
    resident_user_id: { type: String, required: true, index: true },
    amount_cents: { type: Number, required: true, min: 1 },
    /** What earned it — so a resident can match a held sum to the work they did. */
    source_type: {
      type: String,
      enum: ['consignment_settlement', 'sale_payment', 'job_payout'],
      required: true,
    },
    source_ref_id: { type: String, required: true },
    /** The Stripe transfer that moved the money into the shelter's account. */
    transfer_id: { type: String, default: null },
    status: { type: String, enum: ['held', 'disbursed'], default: 'held', index: true },
    disbursed_at: { type: Date, default: null },
    disbursed_by: { type: String, default: null }, // staff user id
    disbursement_method: { type: String, enum: ['cash', 'in_kind', 'stored'], default: null },
    /**
     * The resident confirming they received it, in their own session. Not required to disburse —
     * insisting on it would strand money when someone leaves the shelter — but its ABSENCE is the
     * signal worth auditing.
     */
    resident_ack_at: { type: Date, default: null },
    note: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'shelter_custody' },
);
ShelterCustodySchema.index({ shelter_partner_id: 1, status: 1, created_at: -1 });
// Idempotency: one custody row per payout leg, so a retried webhook can't double-earmark.
ShelterCustodySchema.index({ source_type: 1, source_ref_id: 1 }, { unique: true });

export type ShelterCustodyDoc = InferSchemaType<typeof ShelterCustodySchema>;
export const ShelterCustodyModel = defineModel('ShelterCustody', ShelterCustodySchema);

// ─── training_completions (B-5, shared with the Phase D Academy) ────────────────────────────
/**
 * Deliberately NOT shelter-specific. The Academy (Phase D) will issue badges and certifications
 * from the same table; the resident starter curriculum is simply the first course to use it. Naming
 * it `shelter_training` would have guaranteed a second, near-identical table in three months.
 */
const TrainingCompletionSchema = new Schema(
  {
    user_id: { type: String, required: true, index: true },
    course_slug: { type: String, required: true },
    /** Content version passed, so a materially changed curriculum can require a re-take. */
    course_version: { type: String, required: true },
    score_percent: { type: Number, required: true, min: 0, max: 100 },
    passed: { type: Boolean, required: true },
    completed_at: { type: Date, default: () => new Date() },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false },
    collection: 'training_completions',
  },
);
TrainingCompletionSchema.index({ user_id: 1, course_slug: 1, completed_at: -1 });

export type TrainingCompletionDoc = InferSchemaType<typeof TrainingCompletionSchema>;
export const TrainingCompletionModel = defineModel('TrainingCompletion', TrainingCompletionSchema);
