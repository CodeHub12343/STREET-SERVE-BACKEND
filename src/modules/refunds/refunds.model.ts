import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';

/**
 * Refunds (Phase 4).
 *
 * A refund is never an edit. The original sale and its ledger entries stay exactly as written; the
 * refund is a new, balanced REVERSAL that references them. That is what keeps the books auditable —
 * history records what happened, not what we wish had happened.
 *
 * A partial refund reverses each party proportionally to their original share, so the three-way
 * split still reconciles after the money comes back.
 */
export const REFUND_REASONS = [
  'customer_request',
  'defective',
  'not_received',
  'seller_error',
  'dispute_resolution',
  'chargeback',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

const RefundSchema = new Schema(
  {
    sale_payment_id: { type: String, required: true, index: true },
    sale_id: { type: String, default: null },
    checkout_id: { type: String, required: true, index: true },
    amount_cents: { type: Number, required: true, min: 0 },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    /** Proportional reversal per party — these always sum to `amount_cents`. */
    reversed_seller_cents: { type: Number, default: 0 },
    reversed_hub_cents: { type: Number, default: 0 },
    reversed_fee_cents: { type: Number, default: 0 },
    stripe_refund_id: { type: String, default: null },
    seller_reversal_id: { type: String, default: null },
    hub_reversal_id: { type: String, default: null },
    /**
     * When a payee has already spent their share, the money can't be pulled back. The shortfall
     * becomes a clawback debt rather than a silent loss.
     */
    seller_clawback_debt_id: { type: String, default: null },
    absorbed_by: {
      type: String,
      enum: ['platform', 'seller', 'hub', 'shared'],
      default: 'shared',
    },
    restocked_quantity: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'succeeded', 'failed'], default: 'pending' },
    created_by: { type: String, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'refunds' },
);
RefundSchema.plugin(immutablePlugin);

export type RefundDoc = InferSchemaType<typeof RefundSchema>;
export const RefundModel = defineModel('Refund', RefundSchema);
