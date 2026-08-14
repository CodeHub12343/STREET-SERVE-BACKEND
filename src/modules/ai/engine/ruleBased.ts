import {
  AI_ACCEPTANCE_MIN_SHOWN,
  AI_ACCEPTANCE_PERSONAL_BOOST,
  AI_ACCEPTANCE_SMOOTHING,
  AI_ACCEPTANCE_WINDOW_DAYS,
  AI_ENGINE_VERSION,
  AI_RECENT_WINDOW_DAYS,
  AI_TIME_BANDS,
  AI_WEIGHTS,
} from '../../../config/constants';
import { distanceMeters } from '../../../shared/geo';
import { NotFoundError } from '../../../shared/errors/AppError';
import { CategoryModel } from '../../catalog/catalog.model';
import { consignmentRepository } from '../../consignment/consignment.repository';
import { HubModel } from '../../consignment/consignment.model';
import { aiRepository } from '../ai.repository';
import { sellersService } from '../../sellers/sellers.service';
import type {
  LocationRecommendation,
  PricingSuggestion,
  ProductRecommendation,
  RecommendationEngine,
  SellerContext,
} from './types';

const RECENT_WINDOW_MS = AI_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const ACCEPTANCE_WINDOW_MS = AI_ACCEPTANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const PROX_MAX_M = 20_000; // proximity falls off to 0 beyond ~20km

/**
 * A-4. Population acceptance for one product, in [0,1]. Returns 0 — no signal, not a penalty —
 * until the product has been shown enough times to mean anything, so new inventory is never buried
 * for the crime of being new.
 */
function acceptanceScore(stats: { shown: number; accepted: number } | undefined): number {
  if (!stats || stats.shown < AI_ACCEPTANCE_MIN_SHOWN) return 0;
  // Laplace-smoothed rate: 1-of-1 reads as ~0.25, not 1.0.
  return stats.accepted / (stats.shown + AI_ACCEPTANCE_SMOOTHING);
}

function inTimeBand(tab: string | null, hourUtc: number): boolean {
  if (!tab) return false;
  const bands = AI_TIME_BANDS[tab];
  if (!bands) return false;
  return bands.some(([start, end]) => hourUtc >= start && hourUtc < end);
}

/**
 * Rule-based recommendation engine v2: category affinity + recent sell-through + time-of-day +
 * proximity (when locations are available) + ACCEPTANCE (A-4), every score decomposed into an
 * explainable reason. Uses real first-party signals (inventory_sales, checkouts, ai_recommendations).
 * No ML — this is deterministic ranking, and the reason line is always the true decomposition.
 */
export class RuleBasedEngine implements RecommendationEngine {
  readonly version = AI_ENGINE_VERSION;

  async recommendProducts(ctx: SellerContext, limit: number): Promise<ProductRecommendation[]> {
    const since = new Date(Date.now() - RECENT_WINDOW_MS);
    const hourUtc = ctx.hourUtc ?? new Date().getUTCHours();

    // A-4: acceptance uses a wider window than sell-through — accepts are far rarer events than
    // sales, so a 7-day window would leave almost every product below the minimum sample.
    const acceptanceSince = new Date(Date.now() - ACCEPTANCE_WINDOW_MS);
    const [products, sales, sellerProductIds, acceptanceStats, personallyAccepted, profile] =
      await Promise.all([
        consignmentRepository.availableProducts(200),
        consignmentRepository.recentProductSales(since),
        consignmentRepository.sellerProductIds(ctx.sellerId),
        aiRepository.productAcceptance(acceptanceSince),
        aiRepository.sellerAcceptedProductIds(ctx.sellerId, acceptanceSince),
        // D-2: what this seller says they're good at and where they sell. Null when they've told us
        // nothing AND done nothing — the engine then behaves exactly as it did before Phase D.
        sellersService.matchingContext(ctx.sellerId),
      ]);
    if (products.length === 0) return [];

    const unitsByProduct = new Map(sales.map((s) => [String(s._id), s.units]));
    const maxUnits = Math.max(1, ...sales.map((s) => s.units));

    // Category affinity: categories the seller has sold before.
    const sellerProducts = await consignmentRepository.productsByIds(sellerProductIds);
    const affinityCats = new Set(
      sellerProducts.map((p) => (p.category_id ? String(p.category_id) : null)).filter(Boolean),
    );

    // Resolve category → top_level_tab for the time-of-day signal.
    const catIds = [
      ...new Set(
        products.map((p) => (p.category_id ? String(p.category_id) : null)).filter(Boolean),
      ),
    ] as string[];
    const cats = catIds.length
      ? await CategoryModel.find({ _id: { $in: catIds } })
          .lean()
          .exec()
      : [];
    const tabByCat = new Map(cats.map((c) => [String(c._id), c.top_level_tab]));

    // Hub locations for proximity (only when both seller + hub have coordinates).
    const hubIds = [...new Set(products.map((p) => p.hub_id))];
    const hubs = await HubModel.find({ _id: { $in: hubIds } })
      .lean()
      .exec();
    const hubLoc = new Map(
      hubs
        .filter((h) => h.location?.coordinates?.length === 2)
        .map((h) => [String(h._id), h.location!.coordinates as [number, number]]),
    );

    const scored = products.map((p) => {
      const pid = String(p._id);
      const catId = p.category_id ? String(p.category_id) : null;
      const tab = catId ? (tabByCat.get(catId) ?? null) : null;

      const sellThrough = (unitsByProduct.get(pid) ?? 0) / maxUnits;

      /**
       * D-2 — AFFINITY NOW HAS TWO SOURCES.
       *
       * Before Phase D this was purely "have they sold this category before", which is exactly the
       * signal a brand-new seller cannot have — so the person the platform most needs to activate
       * got no personalisation at all. The declared profile fills that gap from minute one.
       *
       * Behavioural affinity still outranks declared affinity: what someone has actually sold beats
       * what they said they'd be good at. `Math.max` rather than a sum so the two can't stack.
       */
      const behaviouralAffinity = catId && affinityCats.has(catId) ? 1 : 0;
      let declaredAffinity = 0;
      if (profile) {
        const tabSlug = catId ? (tabByCat.get(catId) ?? null) : null;
        const hay = `${p.name} ${p.category ?? ''} ${tabSlug ?? ''}`.toLowerCase();
        if (profile.categories.some((c) => hay.includes(c.toLowerCase()))) declaredAffinity = 0.9;
        else if (profile.skills.some((s) => hay.includes(s.split('_')[0]!))) declaredAffinity = 0.7;

        /**
         * Transport is a real constraint, applied as a SOFT penalty rather than a filter: a pickup
         * worth more than someone on foot can carry ranks lower, but a seller who says they can
         * manage it is a better authority on their own legs than we are.
         */
        if (profile.capacityCents !== null && p.unit_value_cents > profile.capacityCents) {
          declaredAffinity = Math.max(0, declaredAffinity - 0.4);
        }
      }
      const affinity = Math.max(behaviouralAffinity, declaredAffinity);
      const timeOfDay = inTimeBand(tab, hourUtc) ? 1 : 0;
      let proximity = 0;
      const loc = hubLoc.get(p.hub_id);
      if (loc && ctx.lng !== undefined && ctx.lat !== undefined) {
        const d = distanceMeters([ctx.lng, ctx.lat], loc);
        proximity = Math.max(0, 1 - d / PROX_MAX_M);
      }

      /**
       * A-4. The seller's own prior accept outranks the population's — it is direct evidence about
       * what this person can carry and sell, where the crowd rate is only an average. `Math.max`
       * rather than a sum so the two can't stack into a runaway score.
       */
      const acceptance = Math.max(
        acceptanceScore(acceptanceStats.get(pid)),
        personallyAccepted.has(pid) ? AI_ACCEPTANCE_PERSONAL_BOOST : 0,
      );

      const score =
        AI_WEIGHTS.sellThrough * sellThrough +
        AI_WEIGHTS.affinity * affinity +
        AI_WEIGHTS.timeOfDay * timeOfDay +
        AI_WEIGHTS.proximity * proximity +
        AI_WEIGHTS.acceptance * acceptance;

      const factors: string[] = [];
      if (sellThrough > 0) factors.push('high sell-through in your area this week');
      if (behaviouralAffinity) factors.push("matches what you've sold before");
      else if (declaredAffinity > 0) factors.push('matches your seller profile');
      if (timeOfDay) factors.push('popular at this time of day');
      if (proximity > 0.1) factors.push('close to you');
      // Explainability is the whole contract of this engine — a signal that moves the ranking has to
      // be able to say so, or the reason line quietly becomes a lie.
      if (personallyAccepted.has(pid)) factors.push('you picked this up before');
      else if (acceptance > 0) factors.push('other sellers near you took this on');
      const reasonSummary =
        factors.length > 0
          ? `Recommended because: ${factors.join('; ')}.`
          : 'Recommended as available inventory near you.';

      return {
        productId: pid,
        hubId: p.hub_id,
        name: p.name,
        unitValueCents: p.unit_value_cents,
        score,
        reasonSummary,
        factors,
      };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async recommendLocations(ctx: SellerContext, limit: number): Promise<LocationRecommendation[]> {
    const since = new Date(Date.now() - RECENT_WINDOW_MS);
    const hubSales = await consignmentRepository.recentHubSales(since);
    if (hubSales.length === 0) return [];
    const maxRevenue = Math.max(1, ...hubSales.map((h) => h.revenueCents));

    const hubIds = hubSales.map((h) => String(h._id));
    const hubs = await HubModel.find({ _id: { $in: hubIds } })
      .lean()
      .exec();
    const hubLoc = new Map(
      hubs
        .filter((h) => h.location?.coordinates?.length === 2)
        .map((h) => [String(h._id), h.location!.coordinates as [number, number]]),
    );

    return hubSales
      .map((h) => {
        const hubId = String(h._id);
        let proximity = 0;
        const loc = hubLoc.get(hubId);
        if (loc && ctx.lng !== undefined && ctx.lat !== undefined) {
          proximity = Math.max(0, 1 - distanceMeters([ctx.lng, ctx.lat], loc) / PROX_MAX_M);
        }
        const busy = h.revenueCents / maxRevenue;
        const score = 0.7 * busy + 0.3 * proximity;
        const parts = [`busy this week (${h.units} recent sales)`];
        if (proximity > 0.1) parts.push('close to you');
        return {
          hubId,
          score,
          recentUnits: h.units,
          recentRevenueCents: h.revenueCents,
          reasonSummary: `Recommended because: ${parts.join('; ')}.`,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async suggestPricing(productId: string): Promise<PricingSuggestion> {
    const product = await consignmentRepository.findProductById(productId);
    if (!product) throw NotFoundError('Product not found');

    // Observed unit prices from recent sales of same-category products.
    const since = new Date(Date.now() - RECENT_WINDOW_MS * 4); // wider window for pricing stability
    const sales = await consignmentRepository.recentProductSales(since);
    const sameCatProductIds = new Set<string>();
    if (product.category_id) {
      const all = await consignmentRepository.productsByIds(sales.map((s) => String(s._id)));
      for (const p of all) {
        if (p.category_id && String(p.category_id) === String(product.category_id)) {
          sameCatProductIds.add(String(p._id));
        }
      }
    }
    const relevant = sales.filter((s) => sameCatProductIds.has(String(s._id)) && s.units > 0);
    const unitPrices = relevant
      .map((s) => Math.round(s.revenueCents / s.units))
      .sort((a, b) => a - b);

    if (unitPrices.length === 0) {
      return {
        productId,
        suggestedPriceCents: product.unit_value_cents,
        lowCents: product.unit_value_cents,
        highCents: product.unit_value_cents,
        sampleSize: 0,
        reasonSummary:
          'No recent comparable sales yet — suggesting the listed unit value. Advisory only.',
        advisoryOnly: true,
      };
    }

    const median = unitPrices[Math.floor(unitPrices.length / 2)]!;
    const low = unitPrices[0]!;
    const high = unitPrices[unitPrices.length - 1]!;
    return {
      productId,
      suggestedPriceCents: median,
      lowCents: low,
      highCents: high,
      sampleSize: unitPrices.length,
      reasonSummary: `Based on ${unitPrices.length} recent sale(s) of similar items, prices typically ran ${low}–${high}¢. Advisory only — you set the final price.`,
      advisoryOnly: true,
    };
  }
}
