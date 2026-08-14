import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * F-5 — a one-off course purchase.
 *
 * A purchase, not a subscription: a certification is earned once and kept. Renting a credential
 * back to someone monthly would make it worthless as a signal to hub owners, who need to know
 * whether this person was taught something — not whether their card is still valid.
 */
const CoursePurchaseSchema = new Schema(
  {
    user_id: { type: String, required: true },
    course_slug: { type: String, required: true },
    price_cents: { type: Number, required: true },
    /** Stripe payment reference, so a refund can find its purchase. */
    payment_ref: { type: String, default: null },
    purchased_at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'course_purchases' },
);
/** One purchase per (user, course) — a retake never costs again. */
CoursePurchaseSchema.index({ user_id: 1, course_slug: 1 }, { unique: true });

export type CoursePurchaseDoc = InferSchemaType<typeof CoursePurchaseSchema>;
export const CoursePurchaseModel = defineModel('CoursePurchase', CoursePurchaseSchema);
