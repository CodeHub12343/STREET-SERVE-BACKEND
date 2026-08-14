import {
  PostcardAudienceModel,
  PostcardOrderModel,
  type PostcardOrderStatus,
} from './postcards.model';

/**
 * Data access for postcard orders.
 *
 * The only interesting thing here is `transition`, which follows `rto.repository.ts`: a state
 * change is an ATOMIC conditional update on the allowed `from` states, never a read-then-write.
 * Two concurrent requests — a buyer re-quoting while cancelling in another tab, a retried
 * submission — must not both believe they won. A `null` return means the order was not in a state
 * this transition was allowed from, and the caller turns that into a conflict.
 */
export const postcardsRepository = {
  // ─── Audiences ────────────────────────────────────────────────────────────────────────────
  createAudience(row: Record<string, unknown>) {
    return PostcardAudienceModel.create(row);
  },
  findAudience(id: string) {
    return PostcardAudienceModel.findById(id).lean().exec();
  },

  // ─── Orders ───────────────────────────────────────────────────────────────────────────────
  createOrder(row: Record<string, unknown>) {
    return PostcardOrderModel.create(row);
  },
  findOrder(id: string) {
    return PostcardOrderModel.findById(id).lean().exec();
  },
  listOrdersForBusiness(businessId: string, limit: number, skip: number) {
    return PostcardOrderModel.find({ business_id: businessId })
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec();
  },
  countOrdersForBusiness(businessId: string) {
    return PostcardOrderModel.countDocuments({ business_id: businessId }).exec();
  },

  /**
   * Atomic guarded state change. Returns the updated order, or `null` when it was not in one of
   * `from` — which is the signal that somebody else moved it first.
   */
  transition(id: string, from: PostcardOrderStatus[], patch: Record<string, unknown>) {
    return PostcardOrderModel.findOneAndUpdate(
      { _id: id, status: { $in: from } },
      { $set: patch },
      { new: true },
    ).exec();
  },

  /**
   * Edits that must not land on an order that has moved past `draft`/`quoted`.
   *
   * Same guard as `transition`, for changes that do not themselves change status — picking a new
   * audience, say. Without it, a quantity change could be applied to an order already being paid
   * for, silently repricing something the buyer already agreed to.
   */
  patchIfEditable(id: string, patch: Record<string, unknown>) {
    return PostcardOrderModel.findOneAndUpdate(
      { _id: id, status: { $in: ['draft', 'quoted'] } },
      { $set: patch },
      { new: true },
    ).exec();
  },
};
