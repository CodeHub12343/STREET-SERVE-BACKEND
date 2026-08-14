import {
  COACH_MAX_BASKET_ITEMS,
  COACH_MAX_GOAL_CENTS,
  FORECAST_BASELINE_SELL_THROUGH,
} from '../../config/constants';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError } from '../../shared/errors/AppError';
import { formatCents } from '../../shared/money';
import type { Principal } from '../../shared/types/principal';
import { HubModel } from '../consignment/consignment.model';
import { consignmentRepository } from '../consignment/consignment.repository';
import { feeService } from '../payments/fees';
import { calendarFeatures } from './features/calendar';
import { engine } from './engine';
import { OutcomeFactModel } from './outcomes.model';

export interface CoachBasketItem {
  productId: string;
  hubId: string;
  name: string;
  unitValueCents: number;
  /** Units to take — derived from the forecast, not a flat guess. */
  suggestedQuantity: number;
  /** What the seller keeps per unit sold, net of the platform fee. */
  netPerUnitCents: number;
  /** Expected units sold × net — the honest contribution, not the optimistic one. */
  expectedContributionCents: number;
  expectedSellThrough: number;
  reasonSummary: string;
}

export interface CoachPlan {
  goalCents: number;
  /** Sum of expected contributions. Deliberately allowed to fall short of the goal. */
  projectedCents: number;
  achievable: boolean;
  basket: CoachBasketItem[];
  /** Where and when, from the location recommender. */
  locations: Array<{ hubId: string; reasonSummary: string }>;
  /** Plain-language plan, in the brief's own "to earn $100 today, sell these 12 items" shape. */
  summary: string;
  /** What would have to change for a shortfall to close. Empty when the plan clears the goal. */
  advice: string[];
  /** How the seller has actually tracked against past plans — measured, not asserted. */
  track: { plansMeasured: number; medianActualCents: number | null };
}

/**
 * ═══ E-9 — THE INCOME COACH ═══
 *
 * The brief's most concrete AI promise: *"To earn $100 today, sell these 12 items at these
 * locations."* This is that, built on the forecaster rather than on wishful arithmetic.
 *
 * The design decision that matters most here is that **the plan is allowed to say no**.
 *
 * A coach that always produces a plan for any goal is a fortune-teller. If someone asks for $200
 * and the available stock plus realistic sell-through supports $60, the honest output is $60 and a
 * clear statement of the gap — not twelve items that "could" hit $200 if everything sold. The
 * person reading this is deciding how to spend a day they cannot get back, and possibly whether
 * they can eat tonight. Over-promising here is not a UX flaw; it is a harm.
 *
 * So: quantities come from forecast sell-through, contributions are expected values (not maximums),
 * and `achievable` is a real boolean the UI must respect.
 */
export const incomeCoach = {
  async plan(
    principal: Principal,
    input: { goalCents: number; lng?: number; lat?: number; hourUtc?: number },
  ): Promise<CoachPlan> {
    if (input.goalCents > COACH_MAX_GOAL_CENTS) {
      /**
       * Refused rather than attempted. A four-figure day is not achievable through street
       * consignment, and producing a plan for one would be a lie with a spreadsheet attached.
       */
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        `Daily goals are capped at ${formatCents(COACH_MAX_GOAL_CENTS)} — beyond that this isn't a realistic single-day plan, and pretending otherwise would waste your time.`,
      );
    }

    const ctx = {
      sellerId: principal.userId,
      lng: input.lng,
      lat: input.lat,
      hourUtc: input.hourUtc,
    };
    const [recommendations, locations] = await Promise.all([
      engine().recommendProducts(ctx, 25),
      engine().recommendLocations(ctx, 3),
    ]);

    const basket: CoachBasketItem[] = [];
    let projected = 0;

    for (const rec of recommendations) {
      if (basket.length >= COACH_MAX_BASKET_ITEMS) break;
      if (projected >= input.goalCents) break;

      const product = await consignmentRepository.findProductById(rec.productId);
      if (!product || product.quantity_available <= 0) continue;

      // Net per unit, from the same fee registry settlement uses — so the plan's arithmetic
      // matches the eventual payout rather than a rounder, friendlier number.
      const fee = await feeService.resolveFee('consignment_digital', product.unit_value_cents);
      const netPerUnit = Math.floor(
        ((product.unit_value_cents - fee) * product.consignment_split_percent) / 100,
      );
      if (netPerUnit <= 0) continue;

      /**
       * Expected sell-through, recovered from the forecaster's own reason line. The forecast engine
       * states its prediction in `factors[0]`; parsing it back keeps ONE source of truth for the
       * number rather than re-deriving it here and risking the plan and the recommendation
       * disagreeing about the same product.
       */
      const match = /about (\d+)%/.exec(rec.factors[0] ?? '');
      const expectedSellThrough = match
        ? Number(match[1]) / 100
        : FORECAST_BASELINE_SELL_THROUGH;

      const remaining = input.goalCents - projected;
      // Units needed to close the gap, allowing for the fact that not all of them will sell.
      const unitsForGap = Math.ceil(remaining / Math.max(1, netPerUnit * expectedSellThrough));
      const quantity = Math.max(1, Math.min(product.quantity_available, unitsForGap, 25));
      const contribution = Math.round(quantity * expectedSellThrough * netPerUnit);

      basket.push({
        productId: rec.productId,
        hubId: rec.hubId,
        name: rec.name,
        unitValueCents: product.unit_value_cents,
        suggestedQuantity: quantity,
        netPerUnitCents: netPerUnit,
        expectedContributionCents: contribution,
        expectedSellThrough,
        reasonSummary: rec.reasonSummary,
      });
      projected += contribution;
    }

    const achievable = projected >= input.goalCents;
    const cal = calendarFeatures();
    const totalUnits = basket.reduce((n, b) => n + b.suggestedQuantity, 0);

    const advice: string[] = [];
    if (!achievable) {
      const gap = input.goalCents - projected;
      advice.push(
        `Today's stock realistically supports about ${formatCents(projected)} — roughly ${formatCents(gap)} short of your goal.`,
      );
      advice.push('Picking up again tomorrow, or adding a gig, is the realistic way to close it.');
      if (!cal.isPaydayWindow) {
        advice.push('It’s not payday week, which is the single biggest drag on street sales.');
      }
    }

    const summary = achievable
      ? `To earn ${formatCents(input.goalCents)} today: take ${totalUnits} item${totalUnits === 1 ? '' : 's'} across ${basket.length} product${basket.length === 1 ? '' : 's'}, and work the spots below.`
      : `Realistically you can make about ${formatCents(projected)} today from what's available — here's the best of it.`;

    return {
      goalCents: input.goalCents,
      projectedCents: projected,
      achievable,
      basket,
      locations: locations.map((l) => ({ hubId: l.hubId, reasonSummary: l.reasonSummary })),
      summary,
      advice,
      track: await this.trackRecord(principal.userId),
    };
  },

  /**
   * What this seller has ACTUALLY earned per day recently.
   *
   * The measurement half of E-9 — the roadmap explicitly asks for plans "measured against actual
   * outcome". Without it a coach only ever makes claims; with it a seller can see whether its
   * claims have been worth anything, which is the only basis on which they should trust the next one.
   */
  async trackRecord(sellerId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await OutcomeFactModel.find(
      { seller_id: sellerId, settled: true, checked_out_at: { $gte: since } },
      { seller_net_cents: 1, checked_out_at: 1 },
    )
      .lean()
      .exec();
    if (rows.length === 0) return { plansMeasured: 0, medianActualCents: null };

    // Group by day, because the goal is a DAILY one.
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const day = new Date(r.checked_out_at).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (r.seller_net_cents ?? 0));
    }
    const totals = [...byDay.values()].sort((a, b) => a - b);
    const mid = Math.floor(totals.length / 2);
    const median =
      totals.length % 2 === 0
        ? Math.round(((totals[mid - 1] ?? 0) + (totals[mid] ?? 0)) / 2)
        : (totals[mid] ?? 0);

    return { plansMeasured: totals.length, medianActualCents: median };
  },

  /**
   * ═══ E-10 — HUB REALLOCATION ADVICE ═══
   *
   * The brief: *"You should move inventory to San Jose this weekend."*
   *
   * Compares a hub's own products' sell-through against the same categories in OTHER tiles, and
   * surfaces the gaps worth acting on. Only advises a move when the destination has real evidence
   * behind it — recommending a move on one lucky sale elsewhere would be worse than silence, since
   * the hub owner physically moves stock on the strength of it.
   */
  async reallocationAdvice(hubId: string): Promise<
    Array<{ category: string; hereRate: number; bestTile: string; bestRate: number; advice: string }>
  > {
    const hub = await HubModel.findById(hubId).lean().exec();
    const coords = hub?.location?.coordinates as [number, number] | undefined;
    if (!coords || coords.length !== 2) return [];

    const { DEMAND_TILE_DEGREES: deg } = await import('../../config/constants');
    const hereTile = `${Math.floor(coords[0] / deg)}:${Math.floor(coords[1] / deg)}`;

    const since = new Date(Date.now() - 60 * 86_400_000);
    const rows = await OutcomeFactModel.aggregate<{
      _id: { category: string | null; tile: string | null };
      rate: number;
      n: number;
    }>([
      { $match: { settled: true, checked_out_at: { $gte: since }, category: { $ne: null } } },
      {
        $group: {
          _id: { category: '$category', tile: '$tile' },
          rate: { $avg: '$sell_through' },
          n: { $sum: 1 },
        },
      },
      // Enough evidence that a hub owner could act on it without regretting it.
      { $match: { n: { $gte: 5 } } },
    ]).exec();

    const here = new Map<string, { rate: number; n: number }>();
    const elsewhere = new Map<string, Array<{ tile: string; rate: number; n: number }>>();
    for (const r of rows) {
      const cat = r._id.category;
      if (!cat) continue;
      if (r._id.tile === hereTile) here.set(cat, { rate: r.rate, n: r.n });
      else {
        const list = elsewhere.get(cat) ?? [];
        list.push({ tile: r._id.tile ?? '?', rate: r.rate, n: r.n });
        elsewhere.set(cat, list);
      }
    }

    const out: Array<{
      category: string;
      hereRate: number;
      bestTile: string;
      bestRate: number;
      advice: string;
    }> = [];
    for (const [category, local] of here) {
      const others = (elsewhere.get(category) ?? []).sort((a, b) => b.rate - a.rate);
      const best = others[0];
      // A 25-point gap: large enough to be worth the physical effort of moving stock.
      if (!best || best.rate - local.rate < 0.25) continue;
      out.push({
        category,
        hereRate: Number(local.rate.toFixed(2)),
        bestTile: best.tile,
        bestRate: Number(best.rate.toFixed(2)),
        advice: `${category} sells about ${Math.round(best.rate * 100)}% elsewhere versus ${Math.round(local.rate * 100)}% here. Worth sending stock to sellers working that area.`,
      });
    }
    return out.sort((a, b) => b.bestRate - b.hereRate - (a.bestRate - a.hereRate)).slice(0, 5);
  },
};
