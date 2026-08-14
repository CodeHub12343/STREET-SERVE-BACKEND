import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Log of served recommendations — records the explainable reason and whether the seller acted on
 * it (accepted). This is the first-party signal that eventually trains the ML replacement.
 * See DATABASE_SCHEMA_PLAN.md §7 (ai_recommendations) and FR-9.1.
 */
const AiRecommendationSchema = new Schema(
  {
    seller_id: { type: String, required: true, index: true },
    recommendation_type: { type: String, enum: ['product', 'location', 'pricing'], required: true },
    engine_version: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    reason_summary: { type: String, required: true },
    accepted: { type: Boolean, default: null },
    shown_at: { type: Date, default: () => new Date() },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'ai_recommendations',
  },
);
AiRecommendationSchema.index({ seller_id: 1, recommendation_type: 1, shown_at: -1 });

export type AiRecommendationDoc = InferSchemaType<typeof AiRecommendationSchema>;
export const AiRecommendationModel = defineModel('AiRecommendation', AiRecommendationSchema);
