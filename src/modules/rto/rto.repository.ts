import {
  RtoAgreementModel,
  RtoInstallmentModel,
  RtoLedgerEntryModel,
  RtoListingModel,
  RtoSellerApprovalModel,
  RtoStatementEntryModel,
} from './rto.model';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const rtoRepository = {
  // ─── Approvals (R27) ──────────────────────────────────────────────────────────────────────
  approveSeller(sellerId: string, approvedBy: string, note: string | null) {
    return RtoSellerApprovalModel.updateOne(
      { seller_id: sellerId },
      { $setOnInsert: { seller_id: sellerId, approved_by: approvedBy, note } },
      { upsert: true },
    ).exec();
  },
  isSellerApproved(sellerId: string): Promise<boolean> {
    return RtoSellerApprovalModel.exists({ seller_id: sellerId }).then(Boolean);
  },
  listApprovedSellers(limit: number) {
    return RtoSellerApprovalModel.find().sort({ created_at: -1 }).limit(limit).lean().exec();
  },
  revokeSeller(sellerId: string) {
    return RtoSellerApprovalModel.deleteOne({ seller_id: sellerId }).exec();
  },

  // ─── Listings (§42/§44) ───────────────────────────────────────────────────────────────────
  createListing(data: Record<string, unknown>) {
    return RtoListingModel.create(data);
  },
  findListingById(id: string) {
    return RtoListingModel.findById(id).lean().exec();
  },
  listListingsForSeller(sellerId: string, limit: number) {
    return RtoListingModel.find({ seller_id: sellerId, status: { $ne: 'withdrawn' } })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  /** Public browse. Only live, in-stock offers in a market the platform has opened. */
  browseListings(
    filter: { citySlug?: string; categoryId?: string; sellerId?: string },
    limit: number,
  ) {
    return RtoListingModel.find({
      status: 'active',
      quantity_available: { $gt: 0 },
      ...(filter.citySlug ? { city_slug: filter.citySlug } : {}),
      ...(filter.categoryId ? { category_id: filter.categoryId } : {}),
      /**
       * One seller's offers, for their business profile. You rent to own FROM someone, so the offer
       * belongs where the customer is already deciding about that seller — not only in a separate
       * marketplace they have to think to visit.
       */
      ...(filter.sellerId ? { seller_id: filter.sellerId } : {}),
    })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  setListingStatus(id: string, sellerId: string, status: 'active' | 'paused' | 'withdrawn') {
    return RtoListingModel.findOneAndUpdate(
      { _id: id, seller_id: sellerId },
      { $set: { status } },
      { new: true },
    )
      .lean()
      .exec();
  },
  /**
   * Claim one unit. Conditional so two customers accepting the same last item cannot both win —
   * the loser gets a clean "no longer available" rather than an oversold agreement.
   */
  claimListingUnit(id: string) {
    return RtoListingModel.findOneAndUpdate(
      { _id: id, status: 'active', quantity_available: { $gt: 0 } },
      { $inc: { quantity_available: -1 } },
      { new: true },
    )
      .lean()
      .exec();
  },
  /** Hand a claimed unit back when the acceptance that claimed it could not be completed. */
  releaseListingUnit(id: string) {
    return RtoListingModel.updateOne({ _id: id }, { $inc: { quantity_available: 1 } }).exec();
  },

  // ─── Agreements ───────────────────────────────────────────────────────────────────────────
  createAgreement(data: Record<string, unknown>) {
    return RtoAgreementModel.create(data);
  },
  /**
   * §50/§51 — apply a lifecycle change. Takes a raw patch because the remedies each touch a
   * different set of fields, and `$inc` alongside `$set` is exactly what "one more deferral" needs.
   */
  applyRemedy(agreementId: string, patch: Record<string, unknown>) {
    const { $inc, ...set } = patch as { $inc?: Record<string, number> };
    return RtoAgreementModel.findByIdAndUpdate(
      agreementId,
      { ...(Object.keys(set).length ? { $set: set } : {}), ...($inc ? { $inc } : {}) },
      { new: true },
    ).exec();
  },
  /** §50 "move the payment date" — shift every unpaid instalment, keeping the schedule's spacing. */
  deferScheduledInstallments(agreementId: string, days: number) {
    return RtoInstallmentModel.updateMany(
      { agreement_id: agreementId, status: { $in: ['scheduled', 'missed'] } },
      [
        {
          $set: {
            due_at: { $add: ['$due_at', days * 86_400_000] },
            // A missed instalment that has been given more time is scheduled again, not still late.
            status: 'scheduled',
          },
        },
      ],
    ).exec();
  },
  /** Nothing further is owed once the goods have gone back (§51). */
  cancelScheduledInstallments(agreementId: string) {
    return RtoInstallmentModel.updateMany(
      { agreement_id: agreementId, status: { $in: ['scheduled', 'missed'] } },
      { $set: { status: 'waived' } },
    ).exec();
  },
  /** §49 — record that a reminder stage fired for this due date (idempotent per stage). */
  recordReminder(agreementId: string, stage: string, dueAt: Date) {
    return RtoAgreementModel.updateOne({ _id: agreementId }, [
      {
        $set: {
          // Re-arm when the due date moved; otherwise append to what has already been sent.
          reminders_sent: {
            $cond: [
              { $eq: ['$reminders_sent_for', dueAt] },
              { $setUnion: [{ $ifNull: ['$reminders_sent', []] }, [stage]] },
              [stage],
            ],
          },
          reminders_sent_for: dueAt,
        },
      },
    ]).exec();
  },
  findAgreementById(id: string) {
    return RtoAgreementModel.findById(id).exec();
  },
  listAgreementsForCustomer(customerId: string, limit: number) {
    return RtoAgreementModel.find({ customer_id: customerId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  listAgreementsForSeller(sellerId: string, limit: number) {
    return RtoAgreementModel.find({ seller_id: sellerId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
  updateAgreement(id: string, patch: Record<string, unknown>) {
    return RtoAgreementModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },
  /** Guarded transition: only apply when the current status is one of `from`. */
  transitionAgreement(id: string, from: string[], patch: Record<string, unknown>) {
    return RtoAgreementModel.findOneAndUpdate(
      { _id: id, status: { $in: from } },
      { $set: patch },
      { new: true },
    ).exec();
  },

  // ─── Installments (schedule) ──────────────────────────────────────────────────────────────
  insertInstallments(rows: Record<string, unknown>[]) {
    return RtoInstallmentModel.insertMany(rows);
  },
  installmentsForAgreement(agreementId: string) {
    return RtoInstallmentModel.find({ agreement_id: agreementId })
      .sort({ installment_number: 1 })
      .lean()
      .exec();
  },
  /** Claim a specific scheduled installment for charging (idempotent guard against double-charge). */
  claimInstallment(agreementId: string, installmentNumber: number) {
    return RtoInstallmentModel.findOneAndUpdate(
      { agreement_id: agreementId, installment_number: installmentNumber, status: 'scheduled' },
      { $set: { status: 'paid', paid_at: new Date() } },
      { new: true },
    ).exec();
  },
  setInstallmentTxn(agreementId: string, installmentNumber: number, transactionId: string) {
    return RtoInstallmentModel.updateOne(
      { agreement_id: agreementId, installment_number: installmentNumber },
      { $set: { transaction_id: transactionId } },
    ).exec();
  },
  markInstallmentsWaived(agreementId: string) {
    return RtoInstallmentModel.updateMany(
      { agreement_id: agreementId, status: 'scheduled' },
      { $set: { status: 'waived' } },
    ).exec();
  },
  markInstallmentMissed(agreementId: string, installmentNumber: number) {
    return RtoInstallmentModel.findOneAndUpdate(
      { agreement_id: agreementId, installment_number: installmentNumber, status: 'scheduled' },
      { $set: { status: 'missed' } },
      { new: true },
    ).exec();
  },
  /** Scheduled installments now due (for the charge sweep). */
  dueInstallments(now: Date, limit: number) {
    return RtoInstallmentModel.find({ status: 'scheduled', due_at: { $lte: now } })
      .sort({ due_at: 1 })
      .limit(limit)
      .lean()
      .exec();
  },

  // ─── Immutable ledger ─────────────────────────────────────────────────────────────────────
  /** Append a ledger entry; returns the created doc, or null if this key was already recorded. */
  async appendLedger(data: {
    agreement_id: string;
    entry_type: string;
    installment_number: number | null;
    amount_cents: number;
    fee_cents: number;
    ownership_credit_cents: number;
    transaction_id: string | null;
    idempotency_key: string;
  }) {
    try {
      return await RtoLedgerEntryModel.create(data);
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  },
  ledgerForAgreement(agreementId: string) {
    return RtoLedgerEntryModel.find({ agreement_id: agreementId })
      .sort({ created_at: 1 })
      .lean()
      .exec();
  },
  sumLedgerAmount(agreementId: string) {
    return RtoLedgerEntryModel.aggregate<{ _id: null; total: number }>([
      { $match: { agreement_id: agreementId, entry_type: { $ne: 'refund' } } },
      { $group: { _id: null, total: { $sum: '$amount_cents' } } },
    ]).exec();
  },

  // ─── Consignment-RTO statements (R19) ───────────────────────────────────────────────────────
  async appendStatement(data: {
    agreement_id: string;
    installment_number: number | null;
    party: string;
    party_ref: string | null;
    role: string;
    amount_cents: number;
    transfer_ref: string | null;
    idempotency_key: string;
  }) {
    try {
      return await RtoStatementEntryModel.create(data);
    } catch (err) {
      if (isDuplicateKey(err)) return null;
      throw err;
    }
  },
  statementsForAgreement(agreementId: string) {
    return RtoStatementEntryModel.find({ agreement_id: agreementId })
      .sort({ created_at: 1 })
      .lean()
      .exec();
  },
};
