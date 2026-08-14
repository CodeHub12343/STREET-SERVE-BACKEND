import { Schema, type InferSchemaType } from 'mongoose';

import { DEFAULT_JOB_TYPE, JOB_TYPES } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * Jobs / "Earn Today" (Flow 9). Postings + applications with tap check-in-out → same-day payout.
 * Pilot uses explicit tap check-in (optionally proximity-validated), not background geofence.
 * See DATABASE_SCHEMA_PLAN.md §3 (jobs_postings, job_applications).
 */
const JobPostingSchema = new Schema(
  {
    poster_business_id: { type: String, default: null }, // null = platform-posted
    poster_user_id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: null },
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    /**
     * A-5: what KIND of work this is. Distinct from `pay_unit`, which only says how it's priced.
     * Filterable, indexed, and the input a future AI job-matcher needs — a title string is not.
     */
    job_type: { type: String, enum: JOB_TYPES, default: DEFAULT_JOB_TYPE, index: true },
    pay_cents: { type: Number, required: true, min: 0 },
    pay_unit: { type: String, enum: ['flat', 'hourly'], default: 'flat' },
    status: { type: String, enum: ['open', 'filled', 'cancelled', 'completed'], default: 'open' },
    filled_by: { type: String, default: null },
    // When the gig is expected to start and how long it runs. Both drive the worker-facing card
    // ("4h · Jul 30, 11:57 AM") and the hourly payout ceiling, so they're first-class columns
    // rather than free text buried in `description`.
    starts_at: { type: Date, default: null },
    duration_hrs: { type: Number, default: null, min: 0 },
    cancelled_reason: { type: String, default: null },
    /**
     * Signing key for the on-site check-in QR (see jobQr.ts). Never displayed — the poster's screen
     * shows a rotating HMAC over it, so a photographed code dies within a minute. Generated at post
     * time so every gig has the fallback available when GPS won't cooperate.
     */
    checkin_qr_secret: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'jobs_postings' },
);
JobPostingSchema.index({ location: '2dsphere' });
// 5.4: "postings I made", newest first — the poster's own dashboard, which had no index at all.
JobPostingSchema.index({ poster_user_id: 1, created_at: -1 });
JobPostingSchema.index({ status: 1, created_at: -1 });
// A-5: the browse query is always "open gigs of this type" — index the pair, not the type alone.
JobPostingSchema.index({ status: 1, job_type: 1, created_at: -1 });

export type JobPostingDoc = InferSchemaType<typeof JobPostingSchema>;
export const JobPostingModel = defineModel('JobPosting', JobPostingSchema);

const JobApplicationSchema = new Schema(
  {
    job_id: { type: String, required: true },
    applicant_id: { type: String, required: true },
    status: {
      type: String,
      // `cancelled` is the poster-cancelled-after-acceptance state (Flow 9's failure path). It is
      // distinct from `no_show`: one is the employer's doing, the other the worker's, and the
      // compensation policy differs.
      enum: ['applied', 'accepted', 'checked_in', 'completed', 'no_show', 'cancelled'],
      default: 'accepted',
    },
    checked_in_at: { type: Date, default: null },
    checked_out_at: { type: Date, default: null },
    payout_ref: { type: String, default: null },
    payout_cents: { type: Number, default: 0 },
    cancelled_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'job_applications',
  },
);
JobApplicationSchema.index({ job_id: 1, applicant_id: 1 }, { unique: true });
JobApplicationSchema.index({ applicant_id: 1, status: 1 });

export type JobApplicationDoc = InferSchemaType<typeof JobApplicationSchema>;
export const JobApplicationModel = defineModel('JobApplication', JobApplicationSchema);
