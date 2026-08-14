import { ERROR_CODES } from '../../shared/errors/codes';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { livemapService } from '../livemap/livemap.service';
import { messagingService } from '../messaging/messaging.service';
import { ordersService } from '../orders/orders.service';
import { paymentsService } from '../payments/payments.service';
import { queueService } from '../queue/queue.service';
import { vendorsService } from '../vendors/vendors.service';

/**
 * Vendor dashboard read model — composes live status, queue, order queue, a basic sales log, and
 * incoming message threads for a business the caller owns. See MODULE_BREAKDOWN.md §2 (dashboards).
 */
export const dashboardService = {
  async getVendorDashboard(principal: Principal, businessId: string) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId)
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);

    const [liveStatus, queue, orders, sales, threads] = await Promise.all([
      livemapService.getActiveStatus('business', businessId),
      queueService.getQueueState('business', businessId),
      ordersService.listForBusiness(principal, businessId, ['pending', 'accepted', 'ready'], 50),
      paymentsService.listForCounterparty(businessId, 20),
      messagingService.listThreads(principal),
    ]);

    const ordersByStatus = {
      pending: orders.filter((o) => o.status === 'pending'),
      accepted: orders.filter((o) => o.status === 'accepted'),
      ready: orders.filter((o) => o.status === 'ready'),
    };
    const salesLog = sales.map((t) => ({
      transactionId: String(t._id),
      amountCents: t.amount_cents,
      platformFeeCents: t.platform_fee_cents,
      netCents: t.fee_breakdown?.counterparty_net_cents ?? null,
      createdAt: t.created_at,
    }));
    const grossCents = sales.reduce((s, t) => s + t.amount_cents, 0);

    return {
      businessId,
      liveStatus,
      queue,
      orders: ordersByStatus,
      salesLog,
      salesSummary: { count: sales.length, grossCents },
      threads: threads.filter((t) => t.businessId === businessId),
    };
  },

  /**
   * V-11 Analytics, computed from what the business actually did. The screen previously rendered a
   * fixed demo object in EVERY environment, so a vendor with no sales still saw "$482 today · 37
   * orders · +18% vs category" — numbers they might price or staff against.
   *
   * Only genuinely derivable figures are returned. There is deliberately no category benchmark:
   * that needs a peer cohort this data set can't honestly produce, and a fabricated one is exactly
   * what this is replacing.
   */
  async getVendorAnalytics(principal: Principal, businessId: string) {
    const owner = await vendorsService.getBusinessOwner(businessId);
    if (!owner) throw NotFoundError('Business not found');
    if (owner !== principal.userId)
      throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Seven day-buckets ending today, so the chart always has a full week of context.
    const weekStart = new Date(startOfToday);
    weekStart.setDate(weekStart.getDate() - 6);

    const [txns, orders, queueStats] = await Promise.all([
      paymentsService.listForCounterparty(businessId, 500),
      ordersService.countSince(businessId, startOfToday),
      queueService.conversionSince(businessId, weekStart),
    ]);

    const paid = txns.filter((t) => t.status === 'completed');
    const inWindow = (d: Date | undefined, from: Date) => Boolean(d && d >= from);

    const weekSeries = Array.from({ length: 7 }, () => 0);
    let salesTodayCents = 0;
    let salesWeekCents = 0;
    for (const t of paid) {
      const created = t.created_at as Date | undefined;
      if (!inWindow(created, weekStart)) continue;
      salesWeekCents += t.amount_cents;
      const dayIndex = Math.floor(
        (new Date(created!.getFullYear(), created!.getMonth(), created!.getDate()).getTime() -
          weekStart.getTime()) /
          86_400_000,
      );
      if (dayIndex >= 0 && dayIndex < 7) weekSeries[dayIndex]! += t.amount_cents;
      if (inWindow(created, startOfToday)) salesTodayCents += t.amount_cents;
    }

    return {
      businessId,
      salesTodayCents,
      ordersToday: orders,
      salesWeekCents,
      /** Oldest → newest, one bucket per day, ending today. */
      weekSeries,
      weekStart: weekStart.toISOString(),
      queueConversion: queueStats.conversion,
      queueJoined: queueStats.joined,
      avgWaitMin: queueStats.avgWaitMin,
    };
  },
};
