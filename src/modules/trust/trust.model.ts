import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Trust scores — per ROLE (not per user), computed from a documented, versioned, explainable
 * formula (FR-10.1, Q10). Append-only history: each recompute writes a new row.
 * See DATABASE_SCHEMA_PLAN.md §8.
 */
const TrustScoreSchema = new Schema(
  {
    subject_type: { type: String, enum: ['seller', 'business', 'hub'], required: true },
    subject_id: { type: String, required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    formula_version: { type: String, required: true },
    inputs: {
      unresolved_dispute_rate: { type: Number, default: 0 },
      upheld_dispute_rate: { type: Number, default: 0 },
      late_return_rate: { type: Number, default: 0 },
      on_time_rate: { type: Number, default: 0 },
      avg_review: { type: Number, default: 3 },
    },
    computed_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'trust_scores' },
);
TrustScoreSchema.index({ subject_type: 1, subject_id: 1, computed_at: -1 });

export type TrustScoreDoc = InferSchemaType<typeof TrustScoreSchema>;
export const TrustScoreModel = defineModel('TrustScore', TrustScoreSchema);
