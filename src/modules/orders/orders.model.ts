import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * Direct orders — order from a business's menu for pickup at its current Parked location (Flow 2d),
 * distinct from wave-down (spontaneous) and booking (scheduled). See DATABASE_SCHEMA_PLAN.md §5.
 */
const OrderSchema = new Schema(
  {
    customer_id: { type: String, required: true },
    business_id: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'ready', 'completed', 'cancelled'],
      default: 'pending',
    },
    /**
     * 7.5 / P-14 — `pickup_scheduled` orders are placed for a future slot, so unlike `pickup_now`
     * they do NOT require the business to be Parked at the moment of ordering. Ordering ahead is
     * the entire point; requiring the truck to already be at a pitch would make the feature useless.
     */
    fulfillment_type: {
      type: String,
      enum: ['pickup_now', 'pickup_scheduled', 'delivery'],
      default: 'pickup_now',
    },
    /** When the customer will collect. Null for `pickup_now` and for `delivery`. */
    scheduled_for: { type: Date, default: null },
    /**
     * Where a `delivery` order is going. Null for both pickup modes — enforced by the invariant in
     * `orders.service.ts`, because an order that cannot say where it went is not a delivery record.
     *
     * This lives on the ORDER rather than on the delivery request (DAN-1, Phase 5) deliberately. The
     * order is the record of what was sold and how it reached the buyer; refunds, disputes, receipts,
     * and tax all need to answer "where did this go?" without joining through a dispatch collection
     * that may not exist yet and whose rows have their own lifecycle.
     *
     * ADR-004 §6 — this is the EXACT address. Driver-facing surfaces must show only an approximate
     * area until a driver has accepted, and nothing at all after completion. That staging is applied
     * where the address is served, not where it is stored.
     */
    destination: {
      type: {
        line1: { type: String, required: true },
        line2: { type: String, default: null },
        city: { type: String, required: true },
        region: { type: String, default: null },
        postal_code: { type: String, default: null },
        /** [lng, lat] — what dispatch actually routes on. */
        location: {
          type: { type: String, enum: ['Point'], default: 'Point' },
          coordinates: { type: [Number], required: true },
        },
        /** "Blue door, ring twice." Free text the driver sees only after accepting. */
        notes: { type: String, default: null },
        contact_phone: { type: String, default: null },
      },
      default: null,
      _id: false,
    },
    items: {
      type: [
        {
          menu_item_id: String,
          name: String,
          quantity: Number,
          unit_price_cents: Number,
        },
      ],
      default: [],
    },
    subtotal_cents: { type: Number, required: true },
    // Server-authoritative itemization (R9): every mandated line is persisted so the receipt renders
    // exactly what was charged. tax/delivery/service/processing are $0 in the pickup MVP.
    discount_percent: { type: Number, default: 0 },
    discount_applied_cents: { type: Number, default: 0 },
    tax_cents: { type: Number, default: 0 },
    delivery_cents: { type: Number, default: 0 },
    service_fee_cents: { type: Number, default: 0 },
    processing_fee_cents: { type: Number, default: 0 },
    /**
     * PIF-4 — how much of this order the community fund covered. Kept as its own line rather than
     * folded into the discount, because it is not a discount: the vendor is paid in full, by somebody
     * else. Conflating the two would understate the sale and misreport what the customer was given.
     */
    pay_it_forward_cents: { type: Number, default: 0 },
    tip_cents: { type: Number, default: 0 },
    round_up_cents: { type: Number, default: 0 },
    total_cents: { type: Number, required: true },
    transaction_id: { type: String, default: null },
    cancelled_reason: { type: String, default: null },
    ready_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'orders' },
);
OrderSchema.index({ business_id: 1, status: 1 });
OrderSchema.index({ customer_id: 1, created_at: -1 });
// 7.5 — the vendor's prep queue: "what is due next".
OrderSchema.index({ business_id: 1, scheduled_for: 1 });

export type OrderDoc = InferSchemaType<typeof OrderSchema>;
export const OrderModel = defineModel('Order', OrderSchema);
