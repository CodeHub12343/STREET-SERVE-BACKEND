import { DEMAND_TILE_DEGREES } from '../../config/constants';
import { logger } from '../../config/logger';
import { CategoryModel } from '../catalog/catalog.model';
import {
  HubModel,
  InventoryCheckoutModel,
  InventorySaleModel,
  ProductModel,
  SettlementModel,
} from '../consignment/consignment.model';
import { calendarFeatures } from './features/calendar';
import { observedWeather } from './features/weatherCache';
import { OutcomeFactModel } from './outcomes.model';

function demandTile(lng: number, lat: number): string {
  return `${Math.floor(lng / DEMAND_TILE_DEGREES)}:${Math.floor(lat / DEMAND_TILE_DEGREES)}`;
}

/**
 * ═══ E-1 — BUILDING THE OUTCOME DATASET ═══
 *
 * Two entry points, deliberately:
 *
 *  • `recordCheckout` — called on the write path when stock leaves a hub. Captures the features
 *    that existed AT DECISION TIME (weather, calendar, events), which is the only moment they can
 *    be captured honestly. Reconstructing "what was the weather when this was picked up" from a
 *    historical API three weeks later is both expensive and, for the free tiers, impossible.
 *
 *  • `backfillOutcomes` — a sweep that fills in what happened afterwards. Sales and settlements
 *    arrive asynchronously and out of order, so the outcome half cannot be written inline.
 *
 * Nothing here is allowed to fail a checkout. A dataset is worth a great deal; it is not worth
 * blocking someone from picking up stock, so every path swallows its errors and logs.
 */
export const outcomesService = {
  /**
   * Snapshot the decision-time features for a checkout. Fire-and-forget from the checkout path.
   */
  async recordCheckout(input: {
    checkoutId: string;
    sellerId: string;
    productId: string;
    hubId: string;
    unitValueCents: number;
    quantity: number;
    recommendationId?: string | null;
  }): Promise<void> {
    try {
      const [product, hub] = await Promise.all([
        ProductModel.findById(input.productId).lean().exec(),
        HubModel.findById(input.hubId).lean().exec(),
      ]);

      // Resolve the category slug — the forecaster's primary grouping dimension.
      let category = product?.category ?? null;
      if (!category && product?.category_id) {
        const cat = await CategoryModel.findById(product.category_id).lean().exec();
        category = cat?.slug ?? null;
      }

      const coords = hub?.location?.coordinates as [number, number] | undefined;
      const now = new Date();
      const cal = calendarFeatures(now);

      // E-2/E-4 features, captured now because they are unrecoverable later.
      let weatherCode: string | null = null;
      let tempC: number | null = null;
      let eventAttendance = 0;
      if (coords?.length === 2) {
        const obs = await observedWeather(coords[0], coords[1], now);
        if (obs) {
          weatherCode = obs.condition;
          tempC = obs.tempC;
        }
        const { eventsService } = await import('../events/events.service');
        const ev = await eventsService.eventSignal(coords[0], coords[1], now);
        eventAttendance = ev.attendance;
      }

      await OutcomeFactModel.updateOne(
        { checkout_id: input.checkoutId },
        {
          $setOnInsert: {
            checkout_id: input.checkoutId,
            seller_id: input.sellerId,
            product_id: input.productId,
            hub_id: input.hubId,
            category,
            tile: coords?.length === 2 ? demandTile(coords[0], coords[1]) : null,
            hour_utc: now.getUTCHours(),
            day_of_week: cal.dayOfWeek,
            is_holiday: cal.isHoliday,
            is_payday_window: cal.isPaydayWindow,
            weather_code: weatherCode,
            temp_c: tempC,
            event_attendance: eventAttendance,
            recommendation_id: input.recommendationId ?? null,
            was_recommended: Boolean(input.recommendationId),
            unit_value_cents: input.unitValueCents,
            quantity_out: input.quantity,
            checked_out_at: now,
          },
        },
        { upsert: true },
      ).exec();
    } catch (err) {
      // Never fail a checkout for the sake of analytics.
      logger.warn({ err, checkoutId: input.checkoutId }, 'outcome fact capture failed');
    }
  },

  /**
   * Fill in outcomes for rows whose checkouts have since settled.
   *
   * Only settled checkouts are marked complete: an active checkout's sell-through is still moving,
   * and training on in-flight rows would systematically under-report every product's performance
   * (everything looks like it sold less than it eventually did).
   */
  async backfillOutcomes(limit = 200): Promise<number> {
    const pending = await OutcomeFactModel.find({ settled: false })
      .sort({ checked_out_at: 1 })
      .limit(limit)
      .lean()
      .exec();
    if (pending.length === 0) return 0;

    const checkoutIds = pending.map((p) => p.checkout_id);
    const [checkouts, sales, settlements] = await Promise.all([
      InventoryCheckoutModel.find({ _id: { $in: checkoutIds } })
        .lean()
        .exec(),
      InventorySaleModel.find({ checkout_id: { $in: checkoutIds } })
        .lean()
        .exec(),
      SettlementModel.find({ checkout_id: { $in: checkoutIds } })
        .lean()
        .exec(),
    ]);

    const checkoutById = new Map(checkouts.map((c) => [String(c._id), c]));
    const settlementByCheckout = new Map(settlements.map((s) => [s.checkout_id, s]));
    const salesByCheckout = new Map<string, typeof sales>();
    for (const s of sales) {
      const list = salesByCheckout.get(s.checkout_id) ?? [];
      list.push(s);
      salesByCheckout.set(s.checkout_id, list);
    }

    let updated = 0;
    for (const fact of pending) {
      const checkout = checkoutById.get(fact.checkout_id);
      if (!checkout) continue;

      const rows = salesByCheckout.get(fact.checkout_id) ?? [];
      const quantitySold = rows.reduce((n, r) => n + r.quantity_sold, 0);
      const grossCents = rows.reduce((n, r) => n + r.sale_amount_cents, 0);
      const firstSale = rows
        .map((r) => new Date(r.sold_at).getTime())
        .sort((a, b) => a - b)[0];

      const settlement = settlementByCheckout.get(fact.checkout_id);
      const isSettled = Boolean(settlement) || checkout.status === 'settled';

      await OutcomeFactModel.updateOne(
        { checkout_id: fact.checkout_id },
        {
          $set: {
            quantity_sold: quantitySold,
            gross_cents: grossCents,
            seller_net_cents: settlement?.seller_net_cents ?? 0,
            sell_through:
              fact.quantity_out > 0
                ? Math.min(1, Number((quantitySold / fact.quantity_out).toFixed(4)))
                : 0,
            hours_to_first_sale:
              firstSale !== undefined
                ? Number(
                    (
                      (firstSale - new Date(fact.checked_out_at).getTime()) /
                      3_600_000
                    ).toFixed(2),
                  )
                : null,
            settled: isSettled,
            settled_at: settlement?.settled_at ?? null,
          },
        },
      ).exec();
      if (isSettled) updated += 1;
    }

    if (updated > 0) logger.info({ completed: updated }, 'outcome dataset backfill');
    return updated;
  },

  /** Dataset health — the number to watch before trusting any forecast built on it. */
  async stats() {
    const [total, settled, recommended] = await Promise.all([
      OutcomeFactModel.countDocuments({}).exec(),
      OutcomeFactModel.countDocuments({ settled: true }).exec(),
      OutcomeFactModel.countDocuments({ was_recommended: true }).exec(),
    ]);
    const avg = await OutcomeFactModel.aggregate<{ _id: null; avg: number }>([
      { $match: { settled: true } },
      { $group: { _id: null, avg: { $avg: '$sell_through' } } },
    ]).exec();

    return {
      totalRows: total,
      completeRows: settled,
      fromRecommendations: recommended,
      averageSellThrough: Number((avg[0]?.avg ?? 0).toFixed(4)),
      /**
       * The honest readiness signal. A forecast built on a handful of rows is a guess wearing a
       * lab coat, and this is what the admin surface should show before anyone trusts it.
       */
      readyForForecasting: settled >= 50,
    };
  },
};
