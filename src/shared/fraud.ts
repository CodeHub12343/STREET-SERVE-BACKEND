import { Schema, type InferSchemaType } from 'mongoose';

import { logger } from '../config/logger';
import { bizMetrics } from '../observability/bizMetrics';
import { defineModel } from './defineModel';

/**
 * Fraud-flag queue — anomalies are flagged for HUMAN review, never auto-banned (the docs stress the
 * real cost of wrongly banning a legitimate low-income seller). See SECURITY_GUIDELINES.md §3 and
 * DATABASE_SCHEMA_PLAN.md §11 (admin owns fraud_flags).
 */
const FraudFlagSchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        'oversell',
        'ping',
        'spot_me',
        'duplicate_account',
        // Phase 6 consignment signals.
        'cash_under_reporting', // suspiciously little digital volume vs peers
        'repeat_loss_claims', // "lost" inventory claimed repeatedly
        'checkout_velocity', // taking stock far faster than they sell it
        'other',
      ],
      required: true,
    },
    subject_id: { type: String, required: true },
    signals: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['open', 'reviewed', 'dismissed'], default: 'open', index: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'fraud_flags' },
);
FraudFlagSchema.index({ type: 1, status: 1, created_at: -1 });

export type FraudFlag = InferSchemaType<typeof FraudFlagSchema>;
export const FraudFlagModel = defineModel('FraudFlag', FraudFlagSchema);

export type FraudFlagType =
  | 'oversell'
  | 'ping'
  | 'spot_me'
  | 'duplicate_account'
  | 'cash_under_reporting'
  | 'repeat_loss_claims'
  | 'checkout_velocity'
  | 'other';

export async function raiseFraudFlag(input: {
  type: FraudFlagType;
  subjectId: string;
  signals?: Record<string, unknown>;
}): Promise<void> {
  try {
    await FraudFlagModel.create({
      type: input.type,
      subject_id: input.subjectId,
      signals: input.signals ?? {},
    });
    bizMetrics.fraudFlags.inc({ type: input.type });
  } catch (err) {
    logger.error({ err, type: input.type }, 'failed to raise fraud flag');
  }
}
