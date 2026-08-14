import { AiRecommendationModel } from './ai.model';

/**
 * A-4. Reads back the acceptance signal the service has been writing since day one.
 *
 * `POST /ai/recommendations/:id/accept` set `accepted: true` on a served recommendation and nothing
 * ever read it. A dead telemetry path is worse than no telemetry: it implies the system is learning
 * from the seller when it is not. These queries close the loop.
 */
export const aiRepository = {
  /**
   * Population-level acceptance per product: how often a served product recommendation was acted
   * on. Deliberately a RATE, not a count — a raw count would rank whatever has been shown most,
   * which is simply whatever ranked highest yesterday, and the engine would spend the rest of its
   * life re-recommending its own first guess.
   */
  async productAcceptance(since: Date): Promise<Map<string, { shown: number; accepted: number }>> {
    const rows = await AiRecommendationModel.aggregate<{
      _id: string;
      shown: number;
      accepted: number;
    }>([
      { $match: { recommendation_type: 'product', shown_at: { $gte: since } } },
      {
        $group: {
          _id: '$payload.productId',
          shown: { $sum: 1 },
          accepted: { $sum: { $cond: [{ $eq: ['$accepted', true] }, 1, 0] } },
        },
      },
    ]).exec();

    return new Map(
      rows
        .filter((r) => typeof r._id === 'string' && r._id.length > 0)
        .map((r) => [String(r._id), { shown: r.shown, accepted: r.accepted }]),
    );
  },

  /**
   * Products THIS seller accepted before. A personal signal is worth more than a population one —
   * it reflects what they can actually carry, sell and get to — and it is what lets a seller's own
   * behaviour steer their feed rather than the crowd's.
   */
  async sellerAcceptedProductIds(sellerId: string, since: Date): Promise<Set<string>> {
    const rows = await AiRecommendationModel.find(
      {
        seller_id: sellerId,
        recommendation_type: 'product',
        accepted: true,
        shown_at: { $gte: since },
      },
      { payload: 1 },
    )
      .lean()
      .exec();

    const ids = new Set<string>();
    for (const r of rows) {
      const pid = (r.payload as { productId?: unknown } | undefined)?.productId;
      if (typeof pid === 'string' && pid.length > 0) ids.add(pid);
    }
    return ids;
  },
};
