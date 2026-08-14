/**
 * Seller analytics (S-15). Deliberately NOT a second earnings ledger — `/checkouts/earnings`
 * already reports settled/paid/awaiting payouts, and `/debts/mine` reports the balance owed.
 *
 * This answers the questions those screens can't: what actually sells, which hub is worth walking
 * to, how fast stock moves, and what is capping how much inventory this seller can take on. For
 * someone selling with no capital of their own, those four things ARE the business.
 */
import { CREDIT_LIMITS_BY_TIER } from '../../config/constants';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { SellerDebtModel } from '../debt/debt.model';
import { BusinessModel } from '../vendors/vendors.model';
import {
  HubModel,
  InventoryCheckoutModel,
  InventorySaleModel,
  ProductModel,
  SettlementModel,
} from './consignment.model';

const DAY_MS = 86_400_000;
/** Checkout states where the seller is genuinely holding the hub's goods. */
const HOLDING = ['pending_approval', 'active', 'overdue', 'return_pending'];

export const sellerAnalyticsService = {
  async overview(principal: Principal, days = 30) {
    if (!principal.roles.includes('seller')) {
      throw ForbiddenError('Seller role required', ERROR_CODES.ROLE_REQUIRED);
    }
    const sellerId = principal.userId;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const windowStart = new Date(startOfToday.getTime() - (days - 1) * DAY_MS);

    const checkouts = await InventoryCheckoutModel.find({ seller_id: sellerId }).lean().exec();
    const checkoutIds = checkouts.map((c) => String(c._id));
    const checkoutById = new Map(checkouts.map((c) => [String(c._id), c]));

    const [sales, settlements, debts] = await Promise.all([
      InventorySaleModel.find({ checkout_id: { $in: checkoutIds } })
        .lean()
        .exec(),
      SettlementModel.find({ checkout_id: { $in: checkoutIds } })
        .lean()
        .exec(),
      SellerDebtModel.find({ seller_id: sellerId, outstanding_cents: { $gt: 0 } })
        .lean()
        .exec(),
    ]);

    // ─── Earnings (the seller's own split) ──────────────────────────────────────────────────
    let netTotal = 0;
    let netPaid = 0;
    let netPending = 0;
    for (const s of settlements) {
      netTotal += s.seller_net_cents;
      if (s.seller_payout_status === 'paid') netPaid += s.seller_net_cents;
      else netPending += s.seller_net_cents;
    }

    // ─── Movement, velocity, and what's still on hand ───────────────────────────────────────
    let unitsTaken = 0;
    let unitsSold = 0;
    let holdingUnits = 0;
    let holdingValueCents = 0;
    let holdingCount = 0;
    for (const c of checkouts) {
      unitsTaken += c.quantity;
      unitsSold += c.quantity_sold ?? 0;
      if (HOLDING.includes(String(c.status))) {
        holdingCount += 1;
        const unsold = Math.max(0, c.quantity - (c.quantity_sold ?? 0));
        holdingUnits += unsold;
        holdingValueCents += unsold * (c.current_unit_price_cents ?? c.unit_value_cents);
      }
    }

    // ─── Sales: rail mix, daily series, leaderboards, days-to-sell ──────────────────────────
    let grossCents = 0;
    let cashGrossCents = 0;
    let digitalGrossCents = 0;
    let daysToSellTotal = 0;
    let daysToSellCount = 0;

    const byDay = new Map<string, { date: string; grossCents: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(windowStart.getTime() + i * DAY_MS);
      byDay.set(d.toISOString().slice(0, 10), { date: d.toISOString().slice(0, 10), grossCents: 0 });
    }

    const byProduct = new Map<string, { units: number; grossCents: number }>();
    const byHub = new Map<string, { units: number; grossCents: number }>();

    for (const sale of sales) {
      const amount = sale.sale_amount_cents;
      grossCents += amount;
      if (sale.payment_rail === 'cash') cashGrossCents += amount;
      else digitalGrossCents += amount;

      const c = checkoutById.get(String(sale.checkout_id));
      if (c) {
        const p = byProduct.get(c.product_id) ?? { units: 0, grossCents: 0 };
        p.units += sale.quantity_sold;
        p.grossCents += amount;
        byProduct.set(c.product_id, p);

        const h = byHub.get(c.hub_id) ?? { units: 0, grossCents: 0 };
        h.units += sale.quantity_sold;
        h.grossCents += amount;
        byHub.set(c.hub_id, h);

        // How long stock sits before it moves — the number that tells a seller what to stop taking.
        const takenAt = c.checked_out_at as Date | undefined;
        const soldAt = (sale.sold_at ?? sale.created_at) as Date | undefined;
        if (takenAt && soldAt && soldAt >= takenAt) {
          daysToSellTotal += (soldAt.getTime() - takenAt.getTime()) / DAY_MS;
          daysToSellCount += 1;
        }
      }

      const soldAt = (sale.sold_at ?? sale.created_at) as Date | undefined;
      if (soldAt && soldAt >= windowStart) {
        const key = new Date(soldAt.getFullYear(), soldAt.getMonth(), soldAt.getDate())
          .toISOString()
          .slice(0, 10);
        const bucket = byDay.get(key);
        if (bucket) bucket.grossCents += amount;
      }
    }

    // ─── Credit headroom: what's actually capping this seller's growth ──────────────────────
    const limits = CREDIT_LIMITS_BY_TIER[principal.verificationTier];
    const outstandingDebtCents = debts.reduce((sum, d) => sum + d.outstanding_cents, 0);

    // ─── Leaderboards, names in one read each ───────────────────────────────────────────────
    const topProductIds = [...byProduct.entries()]
      .sort((a, b) => b[1].grossCents - a[1].grossCents)
      .slice(0, 5);
    const topHubIds = [...byHub.entries()]
      .sort((a, b) => b[1].grossCents - a[1].grossCents)
      .slice(0, 5);

    const [products, hubs] = await Promise.all([
      ProductModel.find({ _id: { $in: topProductIds.map(([id]) => id) } }, { name: 1 })
        .lean()
        .exec(),
      HubModel.find({ _id: { $in: topHubIds.map(([id]) => id) } }, { business_id: 1 })
        .lean()
        .exec(),
    ]);
    const productName = new Map(products.map((p) => [String(p._id), p.name]));
    const hubBusinesses = await BusinessModel.find(
      { _id: { $in: hubs.map((h) => h.business_id) } },
      { name: 1 },
    )
      .lean()
      .exec();
    const bizName = new Map(hubBusinesses.map((b) => [String(b._id), b.name]));
    const hubName = new Map(
      hubs.map((h) => [String(h._id), bizName.get(String(h.business_id)) ?? 'Hub']),
    );

    // ─── Attention ──────────────────────────────────────────────────────────────────────────
    const soon = new Date(Date.now() + 3 * DAY_MS);
    const expiringSoon = checkouts.filter(
      (c) =>
        c.status === 'active' &&
        c.expires_at &&
        (c.expires_at as Date) <= soon &&
        (c.expires_at as Date) >= now,
    ).length;

    return {
      windowDays: days,
      windowStart: windowStart.toISOString(),
      earnings: {
        netTotalCents: netTotal,
        netPaidCents: netPaid,
        netPendingCents: netPending,
        grossCents,
      },
      movement: {
        unitsTaken,
        unitsSold,
        sellThrough: unitsTaken > 0 ? unitsSold / unitsTaken : 0,
        /** Mean days from taking stock to selling it — low is good. */
        avgDaysToSell: daysToSellCount > 0 ? daysToSellTotal / daysToSellCount : 0,
        holdingCount,
        holdingUnits,
        holdingValueCents,
      },
      rail: {
        cashGrossCents,
        digitalGrossCents,
        /** Cash share — the portion that becomes a balance to clear rather than an auto payout. */
        cashRatio: grossCents > 0 ? cashGrossCents / grossCents : 0,
      },
      credit: {
        tier: principal.verificationTier,
        maxInventoryValueCents: limits.maxInventoryValueCents,
        heldValueCents: holdingValueCents,
        availableCents: Math.max(0, limits.maxInventoryValueCents - holdingValueCents),
        outstandingDebtCents,
        maxCashDebtCents: limits.maxCashDebtCents,
      },
      attention: {
        overdue: checkouts.filter((c) => c.status === 'overdue').length,
        returnPending: checkouts.filter((c) => c.status === 'return_pending').length,
        pendingApproval: checkouts.filter((c) => c.status === 'pending_approval').length,
        expiringSoon,
      },
      series: [...byDay.values()],
      topProducts: topProductIds.map(([id, v]) => ({
        id,
        name: productName.get(id) ?? 'Product',
        units: v.units,
        grossCents: v.grossCents,
      })),
      topHubs: topHubIds.map(([id, v]) => ({
        id,
        name: hubName.get(id) ?? 'Hub',
        units: v.units,
        grossCents: v.grossCents,
      })),
    };
  },
};
