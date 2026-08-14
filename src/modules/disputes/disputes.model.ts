import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Disputes are first-class case objects with SLA tracking. Score changes from a dispute are applied
 * ONLY after resolution (FR-10.3). See DATABASE_SCHEMA_PLAN.md §8.
 */
const DisputeSchema = new Schema(
  {
    subject_type: { type: String, enum: ['seller', 'business', 'hub'], required: true },
    subject_id: { type: String, required: true },
    related: {
      ref_type: { type: String, enum: ['checkout', 'transaction', 'spot_me'], required: true },
      ref_id: { type: String, required: true },
    },
    opened_by: { type: String, required: true },
    status: {
      type: String,
      enum: ['open', 'evidence_requested', 'resolved'],
      default: 'open',
    },
    outcome: { type: String, enum: ['upheld', 'dismissed', null], default: null },
    evidence: {
      type: [{ url: String, note: String, by: String, at: Date }],
      default: [],
    },
    resolution: { type: String, default: null },
    resolved_at: { type: Date, default: null },
    sla_due_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'disputes' },
);
DisputeSchema.index({ status: 1, sla_due_at: 1 }); // SLA-breach alerting
DisputeSchema.index({ subject_type: 1, subject_id: 1, status: 1 });

export type DisputeDoc = InferSchemaType<typeof DisputeSchema>;
export const DisputeModel = defineModel('Dispute', DisputeSchema);
