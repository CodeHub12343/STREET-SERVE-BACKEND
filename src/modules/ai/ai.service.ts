import { AI_RECENT_WINDOW_DAYS } from '../../config/constants';
import { publish } from '../../events/bus';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { consignmentRepository } from '../consignment/consignment.repository';
import { AiRecommendationModel } from './ai.model';
import { generateCoaching, type ObjectionCategory } from './coaching';
import { engine } from './engine';
import type { SellerContext } from './engine/types';

const RECENT_WINDOW_MS = AI_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const aiService = {
  async recommendProducts(
    principal: Principal,
    ctx: Omit<SellerContext, 'sellerId'>,
    limit: number,
  ) {
    const recs = await engine().recommendProducts({ sellerId: principal.userId, ...ctx }, limit);
    const logged = await AiRecommendationModel.insertMany(
      recs.map((r) => ({
        seller_id: principal.userId,
        recommendation_type: 'product',
        engine_version: engine().version,
        payload: r,
        reason_summary: r.reasonSummary,
      })),
    );
    await publish('recommendation.shown', {
      sellerId: principal.userId,
      type: 'product',
      count: recs.length,
    });
    return recs.map((r, i) => ({ recommendationId: String(logged[i]!._id), ...r }));
  },

  async recommendLocations(
    principal: Principal,
    ctx: Omit<SellerContext, 'sellerId'>,
    limit: number,
  ) {
    const recs = await engine().recommendLocations({ sellerId: principal.userId, ...ctx }, limit);
    const logged = await AiRecommendationModel.insertMany(
      recs.map((r) => ({
        seller_id: principal.userId,
        recommendation_type: 'location',
        engine_version: engine().version,
        payload: r,
        reason_summary: r.reasonSummary,
      })),
    );
    await publish('recommendation.shown', {
      sellerId: principal.userId,
      type: 'location',
      count: recs.length,
    });
    return recs.map((r, i) => ({ recommendationId: String(logged[i]!._id), ...r }));
  },

  async suggestPricing(principal: Principal, productId: string) {
    const suggestion = await engine().suggestPricing(productId);
    await AiRecommendationModel.create({
      seller_id: principal.userId,
      recommendation_type: 'pricing',
      engine_version: engine().version,
      payload: suggestion,
      reason_summary: suggestion.reasonSummary,
    });
    return suggestion;
  },

  /**
   * Mark a served recommendation as acted-upon. Since A-4 this is no longer write-only telemetry:
   * `aiRepository` reads it back and the rule engine ranks on it (`AI_WEIGHTS.acceptance`), so a
   * seller picking up a recommendation genuinely changes what they and others are shown next.
   */
  async accept(principal: Principal, recommendationId: string) {
    const updated = await AiRecommendationModel.findOneAndUpdate(
      { _id: recommendationId, seller_id: principal.userId },
      { $set: { accepted: true } },
      { new: true },
    ).exec();
    if (!updated) throw NotFoundError('Recommendation not found');
    return { recommendationId, accepted: true };
  },

  /** `context` is the seller's own note about what the customer said (optional, untrusted text). */
  coaching(objection: ObjectionCategory, context?: string) {
    return generateCoaching(objection, context);
  },

  /**
   * Basic AI business dashboard for a hub owner (advisory): recent sell-through per product and
   * simple reallocation suggestions. Forecasts and "move inventory here" ML land in V1.x.
   */
  async hubDashboard(principal: Principal, hubId: string) {
    const hub = await consignmentRepository.findHubById(hubId);
    if (!hub) throw NotFoundError('Hub not found');
    if (hub.owner_user_id !== principal.userId) {
      throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
    }

    const since = new Date(Date.now() - RECENT_WINDOW_MS);
    const [products, sales, hubSales] = await Promise.all([
      consignmentRepository.allProductsByHub(hubId),
      consignmentRepository.recentProductSales(since),
      consignmentRepository.recentHubSales(since),
    ]);
    const unitsByProduct = new Map(sales.map((s) => [String(s._id), s.units]));

    const perProduct = products.map((p) => {
      const pid = String(p._id);
      const recentUnits = unitsByProduct.get(pid) ?? 0;
      const denom = recentUnits + p.quantity_available;
      const sellThrough = denom > 0 ? recentUnits / denom : 0;
      let suggestion: string | null = null;
      if (recentUnits > 0 && p.quantity_available <= recentUnits) {
        suggestion = 'Restock — selling faster than current stock covers.';
      } else if (recentUnits === 0 && p.quantity_available > 0) {
        suggestion = 'Slow mover — consider promoting or reallocating.';
      }
      return {
        productId: pid,
        name: p.name,
        quantityAvailable: p.quantity_available,
        recentUnits,
        sellThrough: Math.round(sellThrough * 100) / 100,
        suggestion,
      };
    });

    const thisHub = hubSales.find((h) => String(h._id) === hubId);
    return {
      hubId,
      windowDays: AI_RECENT_WINDOW_DAYS,
      recentRevenueCents: thisHub?.revenueCents ?? 0,
      recentUnits: thisHub?.units ?? 0,
      products: perProduct,
      advisoryOnly: true,
    };
  },
};
