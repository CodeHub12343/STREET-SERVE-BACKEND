import type { FeeType, Tier } from '../../config/constants';
import { ConnectedAccountModel, TransactionModel } from './payments.model';

/**
 * Explicit create input (not Partial<TransactionDoc>) — Mongoose's InferSchemaType emits a
 * `[x: string]: NativeDate` index signature under custom timestamp field names, which poisons
 * Partial typing. See the same pattern in identity.repository.
 */
export interface NewTransaction {
  customer_id: string;
  counterparty_type: 'business' | 'seller';
  counterparty_id: string;
  connected_account_id: string;
  amount_cents: number;
  discount_applied_cents: number;
  tip_cents: number;
  round_up_cents: number;
  fee_type: FeeType;
  platform_fee_cents: number;
  /** Customer-paid fee components inside `amount_cents` — drive the refund policy (spec §58). */
  service_fee_cents: number;
  processing_fee_cents: number;
  currency: string;
  fee_breakdown: { platform_cents: number; counterparty_net_cents: number };
  status: 'pending';
  idempotency_key: string;
  transfer_group: string;
}

export const paymentsRepository = {
  findAccountByOwner(ownerType: 'user' | 'business', ownerId: string) {
    return ConnectedAccountModel.findOne({ owner_type: ownerType, owner_id: ownerId }).exec();
  },

  findAccountByStripeId(stripeAccountId: string) {
    return ConnectedAccountModel.findOne({ stripe_account_id: stripeAccountId }).exec();
  },

  createAccount(data: {
    owner_type: 'user' | 'business';
    owner_id: string;
    stripe_account_id: string;
  }) {
    return ConnectedAccountModel.create(data);
  },

  updateAccountStatus(
    stripeAccountId: string,
    patch: {
      charges_enabled?: boolean;
      payouts_enabled?: boolean;
      details_submitted?: boolean;
      payout_tier?: Tier;
      payouts_frozen?: boolean;
      frozen_reason?: string | null;
    },
  ) {
    return ConnectedAccountModel.findOneAndUpdate(
      { stripe_account_id: stripeAccountId },
      { $set: patch },
      { new: true },
    ).exec();
  },

  createTransaction(data: NewTransaction) {
    return TransactionModel.create(data);
  },

  findTransactionById(id: string) {
    return TransactionModel.findById(id).exec();
  },

  findTransactionByPaymentIntent(ref: string) {
    return TransactionModel.findOne({ payment_intent_ref: ref }).exec();
  },

  findByIdempotencyKey(key: string) {
    return TransactionModel.findOne({ idempotency_key: key }).exec();
  },

  setPaymentIntentRef(id: string, ref: string) {
    return TransactionModel.findByIdAndUpdate(
      id,
      { $set: { payment_intent_ref: ref } },
      { new: true },
    ).exec();
  },

  /** Guarded transition: only a pending transaction can complete (immutable once completed). */
  completePendingByPaymentIntent(ref: string) {
    return TransactionModel.findOneAndUpdate(
      { payment_intent_ref: ref, status: 'pending' },
      { $set: { status: 'completed', completed_at: new Date() } },
      { new: true },
    ).exec();
  },

  /** Same guarded completion, by transaction id — used when an order is fulfilled. */
  completePendingById(id: string) {
    return TransactionModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'completed', completed_at: new Date() } },
      { new: true },
    ).exec();
  },

  failPendingByPaymentIntent(ref: string) {
    return TransactionModel.findOneAndUpdate(
      { payment_intent_ref: ref, status: 'pending' },
      { $set: { status: 'failed' } },
      { new: true },
    ).exec();
  },

  markRefunded(id: string, refundRef: string) {
    return TransactionModel.findOneAndUpdate(
      { _id: id, status: 'completed' },
      { $set: { status: 'refunded', refund_ref: refundRef } },
      { new: true },
    ).exec();
  },

  listByCustomer(customerId: string, limit: number) {
    return TransactionModel.find({ customer_id: customerId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },

  listByCounterparty(counterpartyId: string, limit: number) {
    return TransactionModel.find({ counterparty_id: counterpartyId, status: 'completed' })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },

  /**
   * Still-pending charges for a counterparty that have a PaymentIntent. These are the ones that may
   * have actually succeeded at Stripe while our ledger never heard about it (missed webhook), so
   * they can be settled by reading their status back.
   */
  listPendingByCounterparty(counterpartyId: string, limit: number) {
    return TransactionModel.find({
      counterparty_id: counterpartyId,
      status: 'pending',
      payment_intent_ref: { $ne: null },
    })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },

  sumCompletedNet() {
    return TransactionModel.aggregate<{ _id: null; total: number }>([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount_cents' } } },
    ]).exec();
  },
};
