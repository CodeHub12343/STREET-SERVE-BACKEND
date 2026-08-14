/**
 * Hub analytics (H-08). A consignment hub's economics are not a vendor's: it does not sell to
 * customers, it *stocks sellers* and earns a share of what they sell. So the questions are
 * different — how much of my stock is actually moving, who is moving it, how much am I owed, and
 * how much value is sitting out on the street right now.
 *
 * Every figure here is aggregated from the hub's own records. Nothing is estimated or benchmarked
 * against invented peers.
 */
import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { SellerDebtModel } from '../debt/debt.model';
import { UserModel } from '../identity/identity.model';
import {
  HubModel,
  InventoryCheckoutModel,
  InventorySaleModel,
  ProductModel,
  SettlementModel,
} from './consignment.model';
import { vendorsService } from '../vendors/vendors.service';

const DAY_MS = 86_400_000;

/** Checkout states where the hub's goods are genuinely out with a seller. */
const LIVE_STATUSES = ['active', 'overdue', 'return_pending'];

interface DayBucket {
  date: string;
  grossCents: number;
  hubShareCents: number;
}

export const hubAnalyticsService = {
  async overview(principal: Principal, hubId: string, days = 30) {
    const hub = await HubModel.findById(hubId).lean().exec();
    if (!hub) throw NotFoundError('Hub not found');
    const owner = await vendorsService.getBusinessOwner(hub.business_id);
    if (owner !== principal.userId) {
      throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const windowStart = new Date(startOfToday.getTime() - (days - 1) * DAY_MS);

    // Every checkout this hub has ever issued — the join key for sales and settlements, both of
    // which are keyed by checkout rather than hub.
    const checkouts = await InventoryCheckoutModel.find({ hub_id: hubId }).lean().exec();
    const checkoutIds = checkouts.map((c) => String(c._id));
    const checkoutById = new Map(checkouts.map((c) => [String(c._id), c]));

    const [sales, settlements, debts] = await Promise.all([
      InventorySaleModel.find({ checkout_id: { $in: checkoutIds } })
        .lean()
        .exec(),
      SettlementModel.find({ checkout_id: { $in: checkoutIds } })
        .lean()
        .exec(),
      SellerDebtModel.find({ hub_id: hubId, outstanding_cents: { $gt: 0 } })
        .lean()
        .exec(),
    ]);

    // ─── Earnings ────────────────────────────────────────────────────────────────────────────
    let hubShareTotal = 0;
    let hubSharePaid = 0;
    let hubShareAwaiting = 0;
    for (const s of settlements) {
      hubShareTotal += s.hub_share_cents;
      if (s.hub_payout_status === 'paid') hubSharePaid += s.hub_share_cents;
      else hubShareAwaiting += s.hub_share_cents;
    }

    // ─── Movement ────────────────────────────────────────────────────────────────────────────
    let unitsOut = 0;
    let unitsSold = 0;
    let liveCount = 0;
    let valueAtRiskCents = 0;
    const liveSellers = new Set<string>();
    for (const c of checkouts) {
      unitsOut += c.quantity;
      unitsSold += c.quantity_sold ?? 0;
      if (LIVE_STATUSES.includes(String(c.status))) {
        liveCount += 1;
        liveSellers.add(c.seller_id);
        const unsold = Math.max(0, c.quantity - (c.quantity_sold ?? 0));
        valueAtRiskCents += unsold * (c.current_unit_price_cents ?? c.unit_value_cents);
      }
    }

    // ─── Rail mix + daily series ─────────────────────────────────────────────────────────────
    // Cash matters disproportionately to a hub: the money never reaches the platform, so the hub's
    // share becomes a debt the seller must settle rather than an automatic transfer.
    let cashGrossCents = 0;
    let digitalGrossCents = 0;
    let grossCents = 0;
    const byDay = new Map<string, DayBucket>();
    for (let i = 0; i < days; i++) {
      const d = new Date(windowStart.getTime() + i * DAY_MS);
      byDay.set(d.toISOString().slice(0, 10), {
        date: d.toISOString().slice(0, 10),
        grossCents: 0,
        hubShareCents: 0,
      });
    }

    const productUnits = new Map<string, { units: number; grossCents: number }>();
    const sellerGross = new Map<string, { units: number; grossCents: number }>();

    for (const sale of sales) {
      const amount = sale.sale_amount_cents;
      grossCents += amount;
      if (sale.payment_rail === 'cash') cashGrossCents += amount;
      else digitalGrossCents += amount;

      const c = checkoutById.get(String(sale.checkout_id));
      if (c) {
        const p = productUnits.get(c.product_id) ?? { units: 0, grossCents: 0 };
        p.units += sale.quantity_sold;
        p.grossCents += amount;
        productUnits.set(c.product_id, p);

        const s = sellerGross.get(c.seller_id) ?? { units: 0, grossCents: 0 };
        s.units += sale.quantity_sold;
        s.grossCents += amount;
        sellerGross.set(c.seller_id, s);
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

    // Hub share per day, from the settlement that recorded it.
    for (const s of settlements) {
      const at = (s.settled_at ?? s.created_at) as Date | undefined;
      if (!at || at < windowStart) continue;
      const key = new Date(at.getFullYear(), at.getMonth(), at.getDate()).toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (bucket) bucket.hubShareCents += s.hub_share_cents;
    }

    // ─── Leaderboards (names resolved in one read each) ──────────────────────────────────────
    const topProductIds = [...productUnits.entries()]
      .sort((a, b) => b[1].grossCents - a[1].grossCents)
      .slice(0, 5);
    const topSellerIds = [...sellerGross.entries()]
      .sort((a, b) => b[1].grossCents - a[1].grossCents)
      .slice(0, 5);

    const [products, sellers] = await Promise.all([
      ProductModel.find({ _id: { $in: topProductIds.map(([id]) => id) } }, { name: 1 })
        .lean()
        .exec(),
      UserModel.find({ _id: { $in: topSellerIds.map(([id]) => id) } }, { display_name: 1 })
        .lean()
        .exec(),
    ]);
    const productName = new Map(products.map((p) => [String(p._id), p.name]));
    const sellerName = new Map(sellers.map((u) => [String(u._id), u.display_name ?? 'Seller']));

    // ─── Attention: what the operator should act on today ────────────────────────────────────
    const pendingApproval = checkouts.filter((c) => c.status === 'pending_approval').length;
    const overdue = checkouts.filter((c) => c.status === 'overdue').length;
    const returnPending = checkouts.filter((c) => c.status === 'return_pending').length;
    const owedBySellersCents = debts.reduce((sum, d) => sum + d.outstanding_cents, 0);

    return {
      hubId,
      windowDays: days,
      windowStart: windowStart.toISOString(),
      earnings: {
        hubShareTotalCents: hubShareTotal,
        hubSharePaidCents: hubSharePaid,
        hubShareAwaitingCents: hubShareAwaiting,
        grossCents,
      },
      movement: {
        unitsOut,
        unitsSold,
        /** Share of all consigned units that actually sold — the hub's core efficiency measure. */
        sellThrough: unitsOut > 0 ? unitsSold / unitsOut : 0,
        liveCheckouts: liveCount,
        activeSellers: liveSellers.size,
        valueAtRiskCents,
      },
      rail: {
        cashGrossCents,
        digitalGrossCents,
        /** Cash share of sales — the portion that arrives as seller debt, not an automatic payout. */
        cashRatio: grossCents > 0 ? cashGrossCents / grossCents : 0,
      },
      attention: { pendingApproval, overdue, returnPending, owedBySellersCents },
      series: [...byDay.values()],
      topProducts: topProductIds.map(([id, v]) => ({
        id,
        name: productName.get(id) ?? 'Product',
        units: v.units,
        grossCents: v.grossCents,
      })),
      topSellers: topSellerIds.map(([id, v]) => ({
        id,
        name: sellerName.get(id) ?? 'Seller',
        units: v.units,
        grossCents: v.grossCents,
      })),
    };
  },
};
