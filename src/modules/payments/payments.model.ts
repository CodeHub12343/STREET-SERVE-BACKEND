import { Schema, type InferSchemaType } from 'mongoose';

import { FEE_TYPES, TIERS } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * Payments domain — a reconciled MIRROR of Stripe, which remains authoritative for balances.
 * See DATABASE_SCHEMA_PLAN.md §6 and BACKEND_ARCHITECTURE.md §3.1.
 */

// ─── connected_accounts (Stripe Connect account per payout owner) ──────────────────────────
const ConnectedAccountSchema = new Schema(
  {
    owner_type: { type: String, enum: ['user', 'business'], required: true },
    owner_id: { type: String, required: true },
    stripe_account_id: { type: String, required: true, unique: true },
    charges_enabled: { type: Boolean, default: false },
    payouts_enabled: { type: Boolean, default: false },
    details_submitted: { type: Boolean, default: false },
    payout_tier: { type: String, enum: TIERS, default: 'tier0' },
    /**
     * Chargeback/dispute hold (Phase 4). While frozen, no split or settlement transfer may reach
     * this account — the obligation stays a payable on the books until the dispute resolves.
     */
    payouts_frozen: { type: Boolean, default: false },
    frozen_reason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'connected_accounts',
  },
);
ConnectedAccountSchema.index({ owner_type: 1, owner_id: 1 }, { unique: true });

export type ConnectedAccountDoc = InferSchemaType<typeof ConnectedAccountSchema>;
export const ConnectedAccountModel = defineModel('ConnectedAccount', ConnectedAccountSchema);

// ─── transactions (charge ledger mirror; immutable once completed — enforced in service) ────
const TransactionSchema = new Schema(
  {
    customer_id: { type: String, required: true },
    counterparty_type: { type: String, enum: ['business', 'seller'], required: true },
    counterparty_id: { type: String, required: true },
    connected_account_id: { type: String, required: true },
    amount_cents: { type: Number, required: true },
    discount_applied_cents: { type: Number, default: 0 },
    tip_cents: { type: Number, default: 0 },
    round_up_cents: { type: Number, default: 0 },
    // Which registry fee-type produced platform_fee_cents (R7 auditability); default keeps
    // pre-registry rows meaningful.
    fee_type: { type: String, enum: FEE_TYPES, default: 'marketplace' },
    platform_fee_cents: { type: Number, required: true },
    tax_cents: { type: Number, default: 0 },
    /**
     * Customer-paid fee components folded into `amount_cents` (R8/R10, spec §31). Recorded here —
     * not only on the order — because the refund policy operates on the TRANSACTION and has to know
     * which parts of the total are refundable on their own terms. Without them a post-fulfilment
     * refund silently hands back fees its own disclosure calls non-refundable. Default 0 keeps
     * pre-Phase-1 rows and non-order charges (gifts, RTO, wave-downs) correct.
     */
    service_fee_cents: { type: Number, default: 0 },
    processing_fee_cents: { type: Number, default: 0 },
    currency: { type: String, required: true },
    fee_breakdown: {
      platform_cents: { type: Number, required: true },
      counterparty_net_cents: { type: Number, required: true },
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'refunded', 'failed'],
      default: 'pending',
      index: true,
    },
    payment_intent_ref: { type: String, default: null },
    idempotency_key: { type: String, default: null },
    transfer_group: { type: String, required: true },
    refund_ref: { type: String, default: null },
    completed_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'transactions' },
);
/**
 * Partial, NOT sparse — the same correction `UserSchema` already carries for email/phone.
 *
 * A sparse unique index still indexes an EXPLICIT null, and both of these fields default to null.
 * So two transactions that simply have not been given a payment intent yet collided on a duplicate
 * key. Sequentially this never fired (the first row's ref was set before the second was inserted),
 * which is why it survived until concurrent orders became ordinary — a customer paying while the
 * community fund covers someone else's order at the same business is now a normal Saturday.
 *
 * `$type: 'string'` indexes only rows that actually carry a value, which is what "unique when
 * present" was always meant to say.
 */
TransactionSchema.index(
  { payment_intent_ref: 1 },
  { unique: true, partialFilterExpression: { payment_intent_ref: { $type: 'string' } } },
);
TransactionSchema.index(
  { idempotency_key: 1 },
  { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } },
);
TransactionSchema.index({ customer_id: 1, created_at: -1 });
TransactionSchema.index({ counterparty_id: 1, created_at: -1 });

export type TransactionDoc = InferSchemaType<typeof TransactionSchema>;
export const TransactionModel = defineModel('Transaction', TransactionSchema);
