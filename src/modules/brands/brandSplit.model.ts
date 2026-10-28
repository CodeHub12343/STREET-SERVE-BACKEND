import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 2 brand-split ledger. ═══
 *
 * Append-only record of every per-operator payout leg. For a `per_operator` brand this is the
 * authoritative log of who was paid what, so reconciliation can rebuild per-operator earnings
 * from the event stream alone — the cached counters elsewhere are convenience projections.
 *
 * Not merged into the main transactions table because:
 *
 *  • Transactions are 1:1 with Stripe payment intents (the customer's charge). A per-operator
 *    settlement is 1:N (one charge, several transfers). Fitting both shapes in one row would
 *    muddle the join from charge → settlement.
 *  • Reconciliation needs to walk per-operator history ("show me every leg paid to operator X
 *    this month"), which is cheap with a dedicated index on `operator_id` and expensive if the
 *    rows live inside the transactions aggregate.
 *
 * One row per leg (operator × transaction). The partial unique index enforces that: a retry
 * on the same (transaction, operator) pair is idempotent, and the Stripe transfer id reflects
 * the committed state.
 */
const BrandSplitSchema = new Schema(
  {
    transaction_id: { type: String, required: true, index: true },
    brand_id: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    business_id: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    operator_id: {
      type: Schema.Types.ObjectId,
      ref: 'BrandOperator',
      required: true,
      index: true,
    },
    /** The user id behind this operator; carried for faster lookups + audit. */
    operator_user_id: { type: String, required: true, index: true },

    share_bps: { type: Number, required: true, min: 0, max: 10000 },
    gross_cents: { type: Number, required: true, min: 0 },
    net_cents: { type: Number, required: true, min: 0 },

    /**
     * Settlement outcome:
     *  • `paid` — transfer succeeded to the operator's own connected account.
     *  • `fallback_to_owner` — operator had no approved/payouts-enabled account; leg was routed
     *    to the brand owner's account with the amount still owed to the operator (recorded as
     *    an off-platform debt the owner has to settle). This exists so money is NEVER stranded.
     *  • `reversed` — later refund reversed the leg.
     */
    status: {
      type: String,
      enum: ['paid', 'fallback_to_owner', 'reversed'],
      required: true,
      index: true,
    },
    stripe_transfer_id: { type: String, default: null },
    fallback_reason: { type: String, default: null },
    reversed_at: { type: Date, default: null },
    reversed_stripe_id: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'brand_splits' },
);
BrandSplitSchema.index(
  { transaction_id: 1, operator_id: 1 },
  { unique: true },
);
BrandSplitSchema.index({ brand_id: 1, created_at: -1 });

export type BrandSplitDoc = InferSchemaType<typeof BrandSplitSchema>;
export const BrandSplitModel = defineModel('BrandSplit', BrandSplitSchema);
