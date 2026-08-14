import { SalePaymentModel } from './salepayments.model';

export const salePaymentsRepository = {
  create(data: Record<string, unknown>) {
    return SalePaymentModel.create(data);
  },

  findById(id: string) {
    return SalePaymentModel.findById(id).exec();
  },

  findByToken(token: string) {
    return SalePaymentModel.findOne({ pay_token: token }).exec();
  },

  findByIntent(paymentIntentId: string) {
    return SalePaymentModel.findOne({ stripe_payment_intent_id: paymentIntentId }).exec();
  },

  findByIdempotencyKey(key: string) {
    return SalePaymentModel.findOne({ idempotency_key: key }).exec();
  },

  attachIntent(id: unknown, paymentIntentId: string, clientSecret: string | null) {
    return SalePaymentModel.findByIdAndUpdate(
      id,
      { $set: { stripe_payment_intent_id: paymentIntentId, stripe_client_secret: clientSecret } },
      { new: true },
    ).exec();
  },

  /**
   * Mark paid — conditional on still being `pending`, so a duplicated webhook (Stripe delivers more
   * than once) can never record the same money twice.
   */
  markSucceeded(id: unknown, saleId: string) {
    return SalePaymentModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'succeeded', paid_at: new Date(), sale_id: saleId, reserved: false } },
      { new: true },
    ).exec();
  },

  /** Persist the split as executed so a later refund knows exactly what to reverse. */
  recordSplit(
    id: unknown,
    split: {
      platform_fee_cents: number;
      seller_net_cents: number;
      hub_share_cents: number;
      seller_transfer_id: string | null;
      hub_transfer_id: string | null;
      seller_netted_cents: number;
    },
  ) {
    return SalePaymentModel.findByIdAndUpdate(id, { $set: { split } }, { new: true }).exec();
  },

  addRefunded(id: unknown, amountCents: number) {
    return SalePaymentModel.findByIdAndUpdate(
      id,
      { $inc: { refunded_cents: amountCents } },
      { new: true },
    ).exec();
  },

  markFailed(id: unknown, reason: string) {
    return SalePaymentModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'failed', failure_reason: reason, reserved: false } },
      { new: true },
    ).exec();
  },

  markCancelled(id: unknown) {
    return SalePaymentModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'cancelled', reserved: false } },
      { new: true },
    ).exec();
  },

  /** Unpaid intents past their expiry — their held units must go back on the shelf. */
  findExpired(now: Date, limit = 100) {
    return SalePaymentModel.find({ status: 'pending', expires_at: { $lt: now } })
      .limit(limit)
      .exec();
  },

  markExpired(id: unknown) {
    return SalePaymentModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'expired', reserved: false } },
      { new: true },
    ).exec();
  },

  listByCheckout(checkoutId: string) {
    return SalePaymentModel.find({ checkout_id: checkoutId }).sort({ created_at: -1 }).lean().exec();
  },

  /** Total actually collected for a checkout — drives the settlement solvency guard. */
  async sumCollected(checkoutId: string): Promise<number> {
    const rows = await SalePaymentModel.aggregate<{ _id: null; total: number }>([
      { $match: { checkout_id: checkoutId, status: 'succeeded' } },
      { $group: { _id: null, total: { $sum: '$amount_cents' } } },
    ]).exec();
    return rows[0]?.total ?? 0;
  },
};
