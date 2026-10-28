import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Reviews are tied to a completed transaction (anti-manipulation — one review per transaction).
 * See DATABASE_SCHEMA_PLAN.md §8 and SECURITY_GUIDELINES.md §3.
 */
const ReviewSchema = new Schema(
  {
    author_id: { type: String, required: true },
    subject_type: { type: String, enum: ['business', 'seller'], required: true },
    subject_id: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: null },
    /**
     * ═══ FRANCHISE / MULTI-VENDOR — Phase 4 brand aggregation. ═══
     *
     * The brand that owns the business this review was written against. Set at review-creation
     * time (and backfilled by Phase 4 migration for existing rows). The map pin + profile pin
     * read the brand's aggregate rating — so a Platinum sponsor with two trucks shows ONE 4.6★
     * number across both, not two separate scores one truck lower.
     *
     * `operator_id` is the per-operator CALLOUT — optional, set when the reviewer wants to
     * specifically acknowledge or complain about a particular truck's service. Does NOT change
     * which truck earned the rating (that's still subject_id = business_id). The field exists
     * so a filtered view "see what customers said about the Oakland truck specifically" is
     * possible without re-indexing on write.
     */
    brand_id: { type: String, default: null, index: true },
    operator_id: { type: String, default: null },
    /**
     * CU-30 — photos on a review. A photo of the actual plate is the most useful thing a review can
     * carry for a food business, and the least fakeable.
     */
    photos: { type: [String], default: [] },
    /**
     * Moderation. Photos are user-generated content attached to someone else's business, so they
     * are the one part of a review that can do real harm — a hostile or explicit image on a
     * vendor's profile is a problem the vendor cannot fix themselves.
     *
     * `visible` is the default because holding every photo for review would mean most never appear;
     * `hidden` is what a report or an automated signal produces, and it hides the PHOTOS only —
     * never the rating or the words, which would let a business suppress criticism by reporting the
     * picture attached to it.
     */
    photo_moderation: {
      type: String,
      // No `pending` state: holding photos for review would mean most never appear, and a state the
      // service never writes is a promise the schema cannot keep (A-2).
      enum: ['visible', 'hidden'],
      default: 'visible',
    },
    photo_reports: { type: Number, default: 0 },
    photo_hidden_reason: { type: String, default: null },
    transaction_id: { type: String, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'reviews' },
);
ReviewSchema.index({ subject_type: 1, subject_id: 1, created_at: -1 });
ReviewSchema.index({ transaction_id: 1 }, { unique: true }); // one review per transaction
ReviewSchema.index({ brand_id: 1, created_at: -1 }); // brand-level aggregation reads this

export type ReviewDoc = InferSchemaType<typeof ReviewSchema>;
export const ReviewModel = defineModel('Review', ReviewSchema);
