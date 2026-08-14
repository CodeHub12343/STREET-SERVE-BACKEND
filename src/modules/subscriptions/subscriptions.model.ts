import { Schema, type InferSchemaType } from 'mongoose';

import { SUBSCRIPTION_PLANS } from '../../config/constants';
import { defineModel } from '../../shared/defineModel';

/**
 * Monetization subscriptions (R29/R30). One row per (subscriber, plan). The subscriber is a business
 * (pro / featured / verified badge) or a user (AI assistant). Status is driven by Stripe; entitlements
 * are read from the ACTIVE rows. See DEPLOYMENT_STRATEGY.md (monetization is revenue-leverage-ordered).
 */
const SubscriptionSchema = new Schema(
  {
    subscriber_id: { type: String, required: true },
    subscriber_type: { type: String, enum: ['business', 'user'], required: true },
    plan: { type: String, enum: SUBSCRIPTION_PLANS, required: true },
    /**
     * Mirrors Stripe's own subscription statuses. `incomplete` is the important addition: it is what
     * Stripe returns for a subscription whose first invoice has not been paid, and it was absent
     * here — so the only representable outcome of creating one was "active", paid or not.
     */
    status: {
      type: String,
      enum: ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'],
      default: 'incomplete',
    },
    stripe_subscription_id: { type: String, default: null },
    current_period_end: { type: Date, default: null },
    /**
     * F-4: when this plan most recently became active. Distinct from created_at, which is the row's
     * birth and does NOT move on resubscribe — using it would let someone cancel, resubscribe and
     * skip the waiver's waiting period.
     *
     * Null until the plan actually goes live — it previously defaulted to the row's creation time,
     * which would date an unpaid `incomplete` subscription as though it had already started.
     */
    activated_at: { type: Date, default: null },
    cancel_at_period_end: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'subscriptions' },
);
SubscriptionSchema.index({ subscriber_id: 1, plan: 1 }, { unique: true });
SubscriptionSchema.index({ plan: 1, status: 1 });

export type SubscriptionDoc = InferSchemaType<typeof SubscriptionSchema>;
export const SubscriptionModel = defineModel('Subscription', SubscriptionSchema);
