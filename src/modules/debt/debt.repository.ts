import { SellerDebtModel, type DebtOrigin } from './debt.model';

export const debtRepository = {
  create(data: {
    seller_id: string;
    origin_type: DebtOrigin;
    origin_ref_id?: string | null;
    hub_id?: string | null;
    hub_share_cents: number;
    platform_fee_cents: number;
    principal_cents: number;
    outstanding_cents: number;
    due_at: Date;
  }) {
    return SellerDebtModel.create(data);
  },

  findById(id: string) {
    return SellerDebtModel.findById(id).exec();
  },

  /** Oldest first — debt is always recovered in the order it was incurred. */
  listOpen(sellerId: string) {
    return SellerDebtModel.find({
      seller_id: sellerId,
      status: { $in: ['open', 'partially_repaid'] },
    })
      .sort({ created_at: 1 })
      .exec();
  },

  listForSeller(sellerId: string, limit = 50) {
    return SellerDebtModel.find({ seller_id: sellerId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },

  async totalOutstanding(sellerId: string): Promise<number> {
    const rows = await SellerDebtModel.aggregate<{ _id: null; total: number }>([
      { $match: { seller_id: sellerId, status: { $in: ['open', 'partially_repaid'] } } },
      { $group: { _id: null, total: { $sum: '$outstanding_cents' } } },
    ]).exec();
    return rows[0]?.total ?? 0;
  },

  /**
   * Apply a repayment atomically, guarded so concurrent netting can never drive a balance below
   * zero or repay more than is owed.
   */
  applyRepayment(
    debtId: unknown,
    amountCents: number,
    method: 'netted' | 'card' | 'manual',
    ref: string | null,
  ) {
    return SellerDebtModel.findOneAndUpdate(
      { _id: debtId, outstanding_cents: { $gte: amountCents } },
      {
        $inc: { outstanding_cents: -amountCents },
        $push: { repayments: { amount_cents: amountCents, method, at: new Date(), ref } },
      },
      { new: true },
    ).exec();
  },

  setStatus(debtId: unknown, status: string) {
    return SellerDebtModel.findByIdAndUpdate(debtId, { $set: { status } }, { new: true }).exec();
  },

  /** Overdue debts that haven't been reminded recently. */
  findDueForReminder(now: Date, limit = 100) {
    return SellerDebtModel.find({
      status: { $in: ['open', 'partially_repaid'] },
      due_at: { $lt: now },
      $or: [{ reminded_at: null }, { reminded_at: { $lt: new Date(now.getTime() - 86_400_000 * 3) } }],
    })
      .limit(limit)
      .exec();
  },

  markReminded(debtId: unknown) {
    return SellerDebtModel.updateOne({ _id: debtId }, { $set: { reminded_at: new Date() } }).exec();
  },

  /** Badly overdue debts that should block new inventory. */
  findForEscalation(cutoff: Date, limit = 100) {
    return SellerDebtModel.find({
      status: { $in: ['open', 'partially_repaid'] },
      due_at: { $lt: cutoff },
      escalated_at: null,
    })
      .limit(limit)
      .exec();
  },

  markEscalated(debtId: unknown) {
    return SellerDebtModel.updateOne({ _id: debtId }, { $set: { escalated_at: new Date() } }).exec();
  },
};
