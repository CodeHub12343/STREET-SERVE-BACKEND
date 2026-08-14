import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Seller debt (Phase 3 — the cash rail).
 *
 * When a customer pays a seller in CASH, the money never reaches the platform: the seller is
 * holding the hub's share and the platform's fee. That obligation is real, and modelling it as a
 * debt is what makes cash honest instead of invisible.
 *
 * Recovery is deliberately humane — the default path is netting against the seller's next digital
 * payout, not collections. Chasing a low-income seller for money is both ineffective and contrary
 * to the product's purpose.
 */
export const DEBT_ORIGINS = [
  'cash_sale', // seller collected cash owed to the hub + platform
  'lost_inventory',
  'damaged_inventory',
  'refund_clawback',
  'chargeback',
] as const;
export type DebtOrigin = (typeof DEBT_ORIGINS)[number];

const SellerDebtSchema = new Schema(
  {
    seller_id: { type: String, required: true, index: true },
    origin_type: { type: String, enum: DEBT_ORIGINS, required: true },
    origin_ref_id: { type: String, default: null }, // sale / checkout / refund it came from
    hub_id: { type: String, default: null },
    /** Split of what is owed, so recovery can be routed to the right party. */
    hub_share_cents: { type: Number, default: 0 },
    platform_fee_cents: { type: Number, default: 0 },
    principal_cents: { type: Number, required: true, min: 0 },
    outstanding_cents: { type: Number, required: true, min: 0, index: true },
    status: {
      type: String,
      enum: ['open', 'partially_repaid', 'repaid', 'written_off', 'disputed'],
      default: 'open',
      index: true,
    },
    due_at: { type: Date, required: true },
    repayments: {
      type: [
        {
          amount_cents: Number,
          method: { type: String, enum: ['netted', 'card', 'manual'] },
          at: Date,
          ref: String,
        },
      ],
      default: [],
    },
    reminded_at: { type: Date, default: null },
    escalated_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'seller_debts' },
);
SellerDebtSchema.index({ seller_id: 1, status: 1 });
SellerDebtSchema.index({ status: 1, due_at: 1 }); // reminder + escalation sweeps

export type SellerDebtDoc = InferSchemaType<typeof SellerDebtSchema>;
export const SellerDebtModel = defineModel('SellerDebt', SellerDebtSchema);
