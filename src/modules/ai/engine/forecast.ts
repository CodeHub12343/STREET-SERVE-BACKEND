import {
  DEMAND_TILE_DEGREES,
  FORECAST_BASELINE_SELL_THROUGH,
  FORECAST_ENGINE_VERSION,
  FORECAST_MIN_CELL_OBSERVATIONS,
  FORECAST_PRIOR_WEIGHT,
  FORECAST_RECENCY_HALFLIFE_DAYS,
  FORECAST_WEIGHTS,
  FORECAST_WINDOW_DAYS,
} from '../../../config/constants';
import { FEATURED_LABEL } from '../../../config/constants';
import { distanceMeters } from '../../../shared/geo';
import { NotFoundError } from '../../../shared/errors/AppError';
import { weatherMultiplier, weatherFactor } from '../../../integrations/weather';
import { CategoryModel } from '../../catalog/catalog.model';
import { HubModel } from '../../consignment/consignment.model';
import { consignmentRepository } from '../../consignment/consignment.repository';
import { sellersService } from '../../sellers/sellers.service';
import { adsService } from '../../ads/ads.service';
import { aiRepository } from '../ai.repository';
import { calendarFeatures, calendarMultiplier } from '../features/calendar';
import { observedWeather } from '../features/weatherCache';
import { OutcomeFactModel } from '../outcomes.model';
import { RuleBasedEngine } from './ruleBased';
import type {
  LocationRecommendation,
  PricingSuggestion,
  ProductRecommendation,
  RecommendationEngine,
  SellerContext,
} from './types';

const PROX_MAX_M = 20_000;

function demandTile(lng: number, lat: number): string {
  return `${Math.floor(lng / DEMAND_TILE_DEGREES)}:${Math.floor(lat / DEMAND_TILE_DEGREES)}`;
}

interface CellStats {
  /** Recency-weighted mean sell-through. */
  rate: number;
  /** Effective observation count after recency decay — the confidence denominator. */
  weight: number;
}

/**
 * ═══ E-6 — THE FORECASTER ═══
 *
 * ⚠ THIS IS A STATISTICAL FORECASTER, NOT A TRAINED MODEL. That distinction is load-bearing, and
 * it is stated here rather than buried because the brief markets this capability as "AI predicts
 * demand" and someone reading this file deserves to know exactly what it does.
 *
 * What it does: predicts expected sell-through for a product in a (category × geo tile × hour)
 * cell, from recency-weighted historical outcomes in `outcome_facts` (E-1), then adjusts by weather
 * (E-2), calendar (E-3) and nearby events (E-4).
 *
 * Why not a trained model:
 *  • The labelled dataset only started existing with E-1. Training on it today would mean fitting
 *    to a few hundred rows, which produces a model that is confidently wrong.
 *  • Every output here decomposes into named factors a seller can read. Replacing an explainable
 *    ranking with an opaque one, on no evidence that the opaque one is better, would be a downgrade
 *    dressed as an upgrade.
 *  • The `RecommendationEngine` seam means a real model is one `setRecommendationEngine()` call
 *    later — and by then `outcome_facts` will have the history to VALIDATE it, which is the part
 *    that actually matters.
 *
 * Statistical honesty measures, all deliberate:
 *  • Thin cells are blended toward their category prior (`FORECAST_PRIOR_WEIGHT`), so one lucky
 *    sale in an empty cell cannot read as a 100% forecast.
 *  • With no evidence at all the baseline is pessimistic (0.25), not neutral — over-promising a
 *    seller's day costs them a wasted trip and us their trust.
 *  • Every prediction carries its own confidence, and the reason line says when it is thin.
 */
export class ForecastEngine implements RecommendationEngine {
  readonly version = FORECAST_ENGINE_VERSION;

  /** Rule-based fallback for the paths a forecast adds nothing to (locations). */
  private readonly rules = new RuleBasedEngine();

  /**
   * Recency-weighted sell-through per cell, plus per-category priors, in ONE pass over the window.
   * Reading per product would be N queries; the whole window is a single indexed scan.
   */
  private async loadCells(): Promise<{
    byCell: Map<string, CellStats>;
    byCategory: Map<string, CellStats>;
    global: CellStats;
  }> {
    const since = new Date(Date.now() - FORECAST_WINDOW_DAYS * 86_400_000);
    const rows = await OutcomeFactModel.find(
      { settled: true, checked_out_at: { $gte: since } },
      { category: 1, tile: 1, hour_utc: 1, sell_through: 1, checked_out_at: 1 },
    )
      .lean()
      .exec();

    const byCell = new Map<string, { sum: number; weight: number }>();
    const byCategory = new Map<string, { sum: number; weight: number }>();
    let globalSum = 0;
    let globalWeight = 0;

    const now = Date.now();
    for (const r of rows) {
      // Exponential recency decay — a sale last week outweighs one two months ago.
      const ageDays = (now - new Date(r.checked_out_at).getTime()) / 86_400_000;
      const w = Math.pow(0.5, ageDays / FORECAST_RECENCY_HALFLIFE_DAYS);
      const value = r.sell_through ?? 0;

      const cellKey = `${r.category ?? '?'}|${r.tile ?? '?'}|${r.hour_utc}`;
      const cell = byCell.get(cellKey) ?? { sum: 0, weight: 0 };
      cell.sum += value * w;
      cell.weight += w;
      byCell.set(cellKey, cell);

      const catKey = r.category ?? '?';
      const cat = byCategory.get(catKey) ?? { sum: 0, weight: 0 };
      cat.sum += value * w;
      cat.weight += w;
      byCategory.set(catKey, cat);

      globalSum += value * w;
      globalWeight += w;
    }

    const finalise = (m: Map<string, { sum: number; weight: number }>) =>
      new Map(
        [...m].map(([k, v]) => [
          k,
          { rate: v.weight > 0 ? v.sum / v.weight : FORECAST_BASELINE_SELL_THROUGH, weight: v.weight },
        ]),
      );

    return {
      byCell: finalise(byCell),
      byCategory: finalise(byCategory),
      global: {
        rate: globalWeight > 0 ? globalSum / globalWeight : FORECAST_BASELINE_SELL_THROUGH,
        weight: globalWeight,
      },
    };
  }

  /**
   * Predicted sell-through for one cell, blended toward its category prior when thin.
   *
   * This blend is what stops the forecaster embarrassing itself. A cell with two observations that
   * both happened to sell out would otherwise forecast 100%; blended against a category prior of
   * (say) 30%, it forecasts ~45% and says its confidence is low — which is both more accurate and
   * more honest.
   */
  private predictCell(
    cells: Awaited<ReturnType<ForecastEngine['loadCells']>>,
    category: string | null,
    tile: string | null,
    hourUtc: number,
  ): { rate: number; confidence: number; thin: boolean } {
    const catKey = category ?? '?';
    const prior = cells.byCategory.get(catKey) ?? cells.global;
    const cell = cells.byCell.get(`${catKey}|${tile ?? '?'}|${hourUtc}`);

    if (!cell || cell.weight <= 0) {
      return {
        rate: prior.weight > 0 ? prior.rate : FORECAST_BASELINE_SELL_THROUGH,
        confidence: prior.weight > 0 ? Math.min(0.4, prior.weight / 20) : 0,
        thin: true,
      };
    }

    const blended =
      (cell.rate * cell.weight + prior.rate * FORECAST_PRIOR_WEIGHT) /
      (cell.weight + FORECAST_PRIOR_WEIGHT);
    return {
      rate: blended,
      confidence: Math.min(1, cell.weight / (FORECAST_MIN_CELL_OBSERVATIONS * 3)),
      thin: cell.weight < FORECAST_MIN_CELL_OBSERVATIONS,
    };
  }

  async recommendProducts(ctx: SellerContext, limit: number): Promise<ProductRecommendation[]> {
    const hourUtc = ctx.hourUtc ?? new Date().getUTCHours();
    const acceptanceSince = new Date(Date.now() - 30 * 86_400_000);

    const [products, cells, acceptance, personallyAccepted, profile, featured] = await Promise.all([
      consignmentRepository.availableProducts(200),
      this.loadCells(),
      aiRepository.productAcceptance(acceptanceSince),
      aiRepository.sellerAcceptedProductIds(ctx.sellerId, acceptanceSince),
      sellersService.matchingContext(ctx.sellerId),
      // F-1: paid boosts, applied additively and ALWAYS disclosed in the reason line.
      adsService.featuredBoosts('featured_product'),
    ]);
    if (products.length === 0) return [];

    // Hubs: needed for both proximity and the tile a product's demand is forecast in.
    const hubs = await HubModel.find({ _id: { $in: [...new Set(products.map((p) => p.hub_id))] } })
      .lean()
      .exec();
    const hubLoc = new Map(
      hubs
        .filter((h) => h.location?.coordinates?.length === 2)
        .map((h) => [String(h._id), h.location!.coordinates as [number, number]]),
    );

    // Category slugs for the forecast's grouping dimension.
    const catIds = [
      ...new Set(products.map((p) => (p.category_id ? String(p.category_id) : null)).filter(Boolean)),
    ] as string[];
    const cats = catIds.length
      ? await CategoryModel.find({ _id: { $in: catIds } }).lean().exec()
      : [];
    const slugByCat = new Map(cats.map((c) => [String(c._id), c.slug]));

    // E-2/E-3/E-4: context multipliers, resolved ONCE for the seller's own position.
    const cal = calendarFeatures();
    const calMult = calendarMultiplier(cal);
    let obs = null;
    let eventSignal = { signal: 0, attendance: 0, top: null as { name: string } | null };
    if (ctx.lng !== undefined && ctx.lat !== undefined) {
      obs = await observedWeather(ctx.lng, ctx.lat);
      const { eventsService } = await import('../../events/events.service');
      eventSignal = await eventsService.eventSignal(ctx.lng, ctx.lat);
    }
    const wxMult = weatherMultiplier(obs);
    const wxFactor = weatherFactor(obs);

    const scored = products.map((p) => {
      const pid = String(p._id);
      const loc = hubLoc.get(p.hub_id);
      const category = p.category ?? (p.category_id ? (slugByCat.get(String(p.category_id)) ?? null) : null);
      const tile = loc ? demandTile(loc[0], loc[1]) : null;

      const forecast = this.predictCell(cells, category, tile, hourUtc);
      // The prediction, adjusted by today's conditions. Clamped: a multiplier stack must never
      // push a forecast above 1.0 (you cannot sell 130% of what you took).
      const predicted = Math.max(0, Math.min(1, forecast.rate * calMult * wxMult));

      // E-7: skill-aware matching from the D-2 profile.
      let affinity = 0;
      const affinityFactors: string[] = [];
      if (profile) {
        const hay = `${p.name} ${category ?? ''}`.toLowerCase();
        if (profile.categories.some((c) => hay.includes(c.toLowerCase()))) {
          affinity = 1;
          affinityFactors.push('matches what you sell');
        } else if (profile.skills.some((s) => hay.includes(s.split('_')[0]!))) {
          affinity = 0.75;
          affinityFactors.push('matches your skills');
        }
        // Transport is a soft penalty, never a filter — the seller knows their own legs.
        if (profile.capacityCents !== null && p.unit_value_cents > profile.capacityCents) {
          affinity = Math.max(0, affinity - 0.35);
        }
      }

      const acceptanceScore = personallyAccepted.has(pid)
        ? 1
        : (() => {
            const s = acceptance.get(pid);
            return !s || s.shown < 5 ? 0 : s.accepted / (s.shown + 3);
          })();

      let proximity = 0;
      if (loc && ctx.lng !== undefined && ctx.lat !== undefined) {
        proximity = Math.max(0, 1 - distanceMeters([ctx.lng, ctx.lat], loc) / PROX_MAX_M);
      }

      /**
       * F-1 featured placement. Additive and bounded — it lifts a product within results it
       * already qualifies for, and can never remove or bury an organic one. Disclosed below.
       */
      const featuredBoost = featured.get(pid) ?? 0;

      const score =
        featuredBoost +
        FORECAST_WEIGHTS.demand * predicted +
        FORECAST_WEIGHTS.affinity * affinity +
        FORECAST_WEIGHTS.acceptance * acceptanceScore +
        FORECAST_WEIGHTS.proximity * proximity +
        FORECAST_WEIGHTS.event * eventSignal.signal;

      /**
       * The reason line leads with the forecast in plain language, then names the conditions that
       * moved it. A forecast that cannot explain itself is an oracle, and this product has no
       * business shipping oracles to people deciding how to spend their day.
       */
      const factors: string[] = [];
      factors.push(
        forecast.thin
          ? `early estimate: about ${Math.round(predicted * 100)}% of these tend to sell`
          : `forecast: about ${Math.round(predicted * 100)}% of these sell around now`,
      );
      factors.push(...affinityFactors);
      if (wxFactor) factors.push(wxFactor);
      factors.push(...cal.factors);
      if (eventSignal.top && eventSignal.signal > 0.2) {
        factors.push(
          eventSignal.attendance > 0
            ? `${eventSignal.attendance} people expected at ${eventSignal.top.name}`
            : `${eventSignal.top.name} is on nearby`,
        );
      }
      if (personallyAccepted.has(pid)) factors.push('you picked this up before');
      if (proximity > 0.7) factors.push('close to you');
      // Disclosure is not optional: a paid lift the seller can't see is a ranking they can't trust.
      if (featuredBoost > 0) factors.push(FEATURED_LABEL.toLowerCase());

      return {
        productId: pid,
        hubId: p.hub_id,
        name: p.name,
        unitValueCents: p.unit_value_cents,
        score,
        reasonSummary: `${factors[0]!}${factors.length > 1 ? `. Also: ${factors.slice(1).join('; ')}.` : '.'}`,
        factors,
      };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Locations. Delegated to the rule-based engine unchanged: "where did stock actually sell
   * recently" is already the right answer, and a forecast adds nothing a hub's own revenue history
   * doesn't say more directly.
   */
  recommendLocations(ctx: SellerContext, limit: number): Promise<LocationRecommendation[]> {
    return this.rules.recommendLocations(ctx, limit);
  }

  /**
   * E-8 — pricing with bundle and event awareness.
   *
   * Builds on the rule-based comparable-sales band, then adds the two things the brief asks for:
   * a bundle ("one for $10 or three for $25") and an event-day nudge. Both are advisory, and the
   * bundle is expressed as a real multi-unit offer rather than a vague "consider discounting".
   */
  async suggestPricing(productId: string): Promise<PricingSuggestion> {
    const base = await this.rules.suggestPricing(productId);
    const product = await consignmentRepository.findProductById(productId);
    if (!product) throw NotFoundError('Product not found');

    const hub = await HubModel.findById(product.hub_id).lean().exec();
    const coords = hub?.location?.coordinates as [number, number] | undefined;

    let eventNote: string | null = null;
    if (coords?.length === 2) {
      const { eventsService } = await import('../../events/events.service');
      const ev = await eventsService.eventSignal(coords[0], coords[1]);
      if (ev.top && ev.signal > 0.3) {
        eventNote =
          ev.attendance > 0
            ? `${ev.top.name} nearby (~${ev.attendance} people) — full price should hold today.`
            : `${ev.top.name} is on nearby — full price should hold today.`;
      }
    }

    const unit = base.suggestedPriceCents;
    /**
     * A three-for bundle at ~83% of unit price. Chosen because it is the smallest discount that
     * reliably reads as a deal, and because tripling basket size at a 17% discount beats a single
     * sale at full price on both revenue and — for a street seller — time.
     */
    const bundleQty = 3;
    const bundleCents = Math.max(unit, Math.round(unit * bundleQty * 0.83));

    const parts = [base.reasonSummary];
    parts.push(
      `Bundle idea: one for ${(unit / 100).toFixed(2)}, or ${bundleQty} for ${(bundleCents / 100).toFixed(2)}.`,
    );
    if (eventNote) parts.push(eventNote);

    return {
      ...base,
      reasonSummary: parts.join(' '),
    };
  }
}
