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

/**
 * Free AI advice consumed, per user per calendar month.
 *
 * A counter rather than a row per request: the quota only ever needs "how many this month", and one
 * document per user per month keeps that a single indexed read on the hot path. The served
 * recommendations themselves are already recorded in `ai_recommendations` for the outcome dataset,
 * so nothing about the audit trail depends on this collection.
 *
 * `period` is `YYYY-MM` in UTC. A string, not a date range, so the unique index does the resetting:
 * a new month simply has no document yet. There is no job to run and no window to slide.
 */
const AiUsageSchema = new Schema(
  {
    user_id: { type: String, required: true },
    /** Calendar month in UTC, `YYYY-MM`. */
    period: { type: String, required: true },
    count: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'ai_usage',
  },
);
/**
 * Unique so the atomic upsert in `aiQuota.consume` cannot race two concurrent requests into two
 * documents — which would silently double every user's free allowance under exactly the load that
 * makes it worth enforcing.
 */
AiUsageSchema.index({ user_id: 1, period: 1 }, { unique: true });

export type AiUsageDoc = InferSchemaType<typeof AiUsageSchema>;
export const AiUsageModel = defineModel('AiUsage', AiUsageSchema);
