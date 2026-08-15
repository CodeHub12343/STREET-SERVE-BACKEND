import type { SubscriptionPlan } from '../../config/constants';
import { SubscriptionModel } from './subscriptions.model';

/**
 * The only statuses that buy anything. Every entitlement read goes through this one list so a plan
 * cannot be honoured on one screen and refused on another — and so `incomplete` (created, never
 * paid) is excluded everywhere by construction rather than by remembering to exclude it.
 */
export const ENTITLED_STATUSES = ['active', 'trialing'] as const;

export const subscriptionsRepository = {
  /**
   * Records the subscription at whatever status Stripe actually reports. This used to hardcode
   * `status: 'active'`, so a subscription Stripe had returned as `incomplete` — no card charged —
   * granted the full paid entitlement anyway. `activated_at` is only stamped once the plan is
   * genuinely live, so it never claims a start date for money that never moved.
   */
  upsert(data: {
    subscriber_id: string;
    subscriber_type: 'business' | 'user';
    plan: SubscriptionPlan;
    status: string;
    stripe_subscription_id: string;
    current_period_end: Date | null;
  }) {
    const live = data.status === 'active' || data.status === 'trialing';
    return SubscriptionModel.findOneAndUpdate(
      { subscriber_id: data.subscriber_id, plan: data.plan },
      {
        $set: {
          subscriber_type: data.subscriber_type,
          status: data.status,
          stripe_subscription_id: data.stripe_subscription_id,
          current_period_end: data.current_period_end,
          cancel_at_period_end: false,
        },
      },
      { upsert: true, new: true },
    )
      .exec()
      .then(async (doc) => {
        if (live && doc && !doc.activated_at) {
          doc.activated_at = new Date();
          await doc.save();
        }
        return doc;
      });
  },
  find(subscriberId: string, plan: SubscriptionPlan) {
    return SubscriptionModel.findOne({ subscriber_id: subscriberId, plan }).exec();
  },
  isActive(subscriberId: string, plan: SubscriptionPlan): Promise<boolean> {
    return SubscriptionModel.exists({
      subscriber_id: subscriberId,
      plan,
      status: { $in: ENTITLED_STATUSES },
    }).then(Boolean);
  },
  listActiveFor(subscriberIds: string[]) {
    return SubscriptionModel.find({
      subscriber_id: { $in: subscriberIds },
      status: { $in: ENTITLED_STATUSES },
    })
      .lean()
      .exec();
  },
  activeByPlan(plan: SubscriptionPlan, subscriberIds: string[]) {
    return SubscriptionModel.find({
      plan,
      status: { $in: ENTITLED_STATUSES },
      subscriber_id: { $in: subscriberIds },
    })
      .select('subscriber_id')
      .lean()
      .exec();
  },
  setStatus(subscriberId: string, plan: SubscriptionPlan, status: string, cancelAtPeriodEnd: boolean) {
    return SubscriptionModel.findOneAndUpdate(
      { subscriber_id: subscriberId, plan },
      { $set: { status, cancel_at_period_end: cancelAtPeriodEnd } },
      { new: true },
    ).exec();
  },

  /**
   * Look a subscription up by Stripe's id.
   *
   * A webhook knows only what Stripe knows — the subscription id — and never our subscriber/plan
   * pair, so every inbound lifecycle event has to arrive through this.
   */
  findByStripeId(stripeSubscriptionId: string) {
    return SubscriptionModel.findOne({ stripe_subscription_id: stripeSubscriptionId })
      .lean()
      .exec();
  },

  /**
   * Every subscription currently granting an entitlement.
   *
   * The reconcile sweep reads this rather than the whole collection: a `canceled` row already
   * grants nothing, so re-checking it with Stripe spends a request to learn nothing. The rows that
   * matter are the ones where being wrong means giving a paid plan away.
   */
  listEntitled() {
    return SubscriptionModel.find({
      status: { $in: ENTITLED_STATUSES },
      stripe_subscription_id: { $nin: [null, ''] },
    })
      .lean()
      .exec();
  },

  /** Full state sync from Stripe — status, period end and the pending-cancel flag together. */
  applyStripeState(
    stripeSubscriptionId: string,
    state: { status: string; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean },
  ) {
    return SubscriptionModel.findOneAndUpdate(
      { stripe_subscription_id: stripeSubscriptionId },
      {
        $set: {
          status: state.status,
          cancel_at_period_end: state.cancelAtPeriodEnd,
          ...(state.currentPeriodEnd
            ? { current_period_end: new Date(state.currentPeriodEnd * 1000) }
            : {}),
        },
      },
      { new: true },
    ).exec();
  },
};
