import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Customer payments for consignment sales (Phase 2 — the digital rail).
 *
 * One row per attempt to collect money from a customer. Created BEFORE the customer pays (units are
 * reserved at that moment so two customers can't buy the same last item), and only marked
 * `succeeded` by the Stripe webhook — never by the client, which cannot be trusted to report that
 * money arrived.
 */
const SalePaymentSchema = new Schema(
  {
    checkout_id: { type: String, required: true, index: true },
    seller_id: { type: String, required: true, index: true },
    hub_id: { type: String, required: true },
    product_id: { type: String, required: true },
    /** Opaque public token in the customer's payment URL — never exposes an internal id. */
    pay_token: { type: String, required: true, unique: true },
    quantity: { type: Number, required: true, min: 1 },
    unit_price_cents: { type: Number, required: true, min: 0 },
    /** Pre-tax sale amount — this is what the seller/hub/platform split applies to. */
    amount_cents: { type: Number, required: true, min: 0 },
    /**
     * Marketplace-facilitator sales tax, charged ON TOP. Never split, never revenue — the platform
     * holds it for the state (Phase 5).
     */
    tax_cents: { type: Number, default: 0 },
    tax_rate_bps: { type: Number, default: 0 },
    tax_jurisdiction: { type: String, default: null },
    tax_city_slug: { type: String, default: null },
    /** What the customer actually paid: amount + tax. */
    total_charged_cents: { type: Number, default: 0 },
    currency: { type: String, required: true, default: 'USD' },
    rail: { type: String, enum: ['digital'], default: 'digital' },
    stripe_payment_intent_id: { type: String, default: null },
    stripe_client_secret: { type: String, default: null },
    transfer_group: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'expired', 'cancelled'],
      default: 'pending',
      index: true,
    },
    /** Units are held from creation; an unpaid intent must release them (`payment.expire` sweep). */
    reserved: { type: Boolean, default: true },
    customer_email: { type: String, default: null },
    customer_phone: { type: String, default: null },
    /** The sale row created once payment succeeded — links money to inventory movement. */
    sale_id: { type: String, default: null },
    /**
     * The split as executed, so a refund knows exactly what to reverse and from whom. Separate
     * charges + transfers means each leg must be reversed explicitly.
     */
    split: {
      platform_fee_cents: { type: Number, default: 0 },
      seller_net_cents: { type: Number, default: 0 },
      hub_share_cents: { type: Number, default: 0 },
      seller_transfer_id: { type: String, default: null },
      hub_transfer_id: { type: String, default: null },
      /** Withheld against the seller's debt instead of transferred — nothing to reverse. */
      seller_netted_cents: { type: Number, default: 0 },
    },
    refunded_cents: { type: Number, default: 0 },
    idempotency_key: { type: String, required: true, unique: true },
    expires_at: { type: Date, required: true, index: true },
    paid_at: { type: Date, default: null },
    failure_reason: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'sale_payments' },
);
SalePaymentSchema.index({ stripe_payment_intent_id: 1 }, { sparse: true });
SalePaymentSchema.index({ status: 1, expires_at: 1 }); // expiry sweep

export type SalePaymentDoc = InferSchemaType<typeof SalePaymentSchema>;
export const SalePaymentModel = defineModel('SalePayment', SalePaymentSchema);
