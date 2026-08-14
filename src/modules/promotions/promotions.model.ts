import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * 7.6 / P-15 — flash sales.
 *
 * Deliberately built **after** A-7 unified the discount model, and deliberately thin: this schema
 * stores a window, a magnitude, and a scope, and nothing here decides which discount a customer
 * gets. That decision lives in `orders/discounts.ts`, the single contest every price discount goes
 * through. A flash sale that resolved its own discounts would be the third parallel system A-7
 * existed to prevent.
 *
 * Scope is `business` or `menu_item`. Not "product": a flash sale prices a vendor's own goods, and
 * consignment inventory is priced by terms the hub and seller agreed — a vendor discounting stock
 * they do not own would move money out of someone else's split.
 */
const FlashSaleSchema = new Schema(
  {
    business_id: { type: String, required: true, index: true },
    /** `null` = the whole business. Otherwise one menu item. */
    menu_item_id: { type: String, default: null },
    /** Whole percent off, matching how it is communicated to customers ("20% off"). */
    percent: { type: Number, required: true, min: 1, max: 90 },
    label: { type: String, default: null },
    starts_at: { type: Date, required: true },
    ends_at: { type: Date, required: true },
    /**
     * A vendor can pull a sale early. Kept as a flag rather than deleting the row: a customer who
     * saw the price needs an explanation, and a deleted sale explains nothing.
     */
    cancelled_at: { type: Date, default: null },
    created_by: { type: String, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'flash_sales' },
);
// The live-lookup shape: "sales for this business that are in force now".
FlashSaleSchema.index({ business_id: 1, ends_at: 1, starts_at: 1 });

export type FlashSaleDoc = InferSchemaType<typeof FlashSaleSchema>;
export const FlashSaleModel = defineModel('FlashSale', FlashSaleSchema);
