import { POSTCARD_ACCESS_MODE, POSTCARD_MARGIN_BASIS } from '../../config/constants';
import { PostcardAssetModel, PostcardOrderModel } from './postcards.model';
import { PostcardPayableModel } from './postcards.model';

/**
 * ═══ THE PILOT REVIEW (Phase 8.2) ═══
 *
 * Answers the four questions the roadmap asks before general availability: actual versus quoted
 * cost, margin realised, moderation time per order, and which failure modes actually happened.
 *
 * ## Why this is code rather than a spreadsheet
 *
 * Because the answer decides whether real money flows at scale, and because the numbers are
 * scattered across four collections that a human joining them by hand would join slightly
 * differently each time. The audit's central unknown was the unit economics — the per-piece cost
 * was never verified, only assumed — so the one thing the pilot MUST produce is a defensible
 * comparison of what we quoted against what we were actually billed.
 *
 * ## The honesty rule
 *
 * Every figure here is either measured or reported as `null`. Nothing is estimated, extrapolated,
 * or filled in from a default. A review whose numbers are partly invented is worse than no review:
 * it produces the same confidence with none of the evidence, and this is precisely the decision
 * where false confidence is expensive.
 *
 * `costVariance` in particular is `null` until a payable has been SETTLED. Before settlement the
 * "actual" cost is still our own estimate of what the vendor will bill, so comparing it to our
 * quote would be comparing an assumption to itself and calling it verification.
 */

export interface PilotReview {
  mode: typeof POSTCARD_ACCESS_MODE;
  marginBasis: typeof POSTCARD_MARGIN_BASIS;
  generatedAt: Date;
  orders: {
    total: number;
    byStatus: Record<string, number>;
    /** Reached the printer. The only ones whose economics are real. */
    submitted: number;
    mailed: number;
  };
  economics: {
    /** Sum of what buyers were charged, across paid orders. */
    grossChargedCents: number;
    /** What we told ourselves the vendor would cost, at quote time. */
    quotedVendorCostCents: number;
    /** What the vendor ACTUALLY billed, across settled payables only. */
    settledVendorCostCents: number;
    /** Orders whose vendor cost has actually been settled and can therefore be checked. */
    settledOrderCount: number;
    /**
     * Settled actual minus quoted, over settled orders only. **`null` until something settles** —
     * see the honesty rule above.
     */
    costVarianceCents: number | null;
    costVariancePercent: number | null;
    marginQuotedCents: number;
    /** Gross charged minus what the vendor really billed. The number the business case rests on. */
    marginRealisedCents: number | null;
  };
  moderation: {
    reviewed: number;
    approved: number;
    rejected: number;
    /** Upload → decision, in minutes. The TD-8 scaling signal. */
    medianMinutes: number | null;
    p90Minutes: number | null;
    stillWaiting: number;
  };
  /**
   * What actually went wrong. Counts, not prose — the point is to see which of the failure modes
   * the audit predicted are real, and which never happened.
   */
  failures: {
    paymentFailed: number;
    submissionFailed: number;
    rejectedAfterPayment: number;
    quoteExpiredAtCheckout: number;
    cancelled: number;
    refunded: number;
    submissionRetriesUsed: number;
  };
  /** Plain-language flags a human should read before deciding to go general. */
  readiness: string[];
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx] ?? null;
}

export const pilotReviewService = {
  async build(): Promise<PilotReview> {
    const [orders, assets, payables] = await Promise.all([
      PostcardOrderModel.find({}).lean().exec(),
      PostcardAssetModel.find({}).lean().exec(),
      PostcardPayableModel.find({}).lean().exec(),
    ]);

    // ─── orders ─────────────────────────────────────────────────────────────────────────────
    const byStatus: Record<string, number> = {};
    for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

    const paid = orders.filter((o) => o.charged_cents != null && o.paid_at);
    const submitted = orders.filter((o) => o.submitted_at).length;
    const mailed = orders.filter((o) => o.fulfilment_stage === 'mailed').length;

    // ─── economics ──────────────────────────────────────────────────────────────────────────
    const grossChargedCents = paid.reduce((sum, o) => sum + (o.charged_cents ?? 0), 0);
    const quotedVendorCostCents = paid.reduce((sum, o) => sum + (o.vendor_cost_cents ?? 0), 0);
    const marginQuotedCents = paid.reduce((sum, o) => sum + (o.margin_cents ?? 0), 0);

    /**
     * Only settled payables count as "actual". An accrued-but-unsettled payable still holds OUR
     * figure, so treating it as the vendor's would make the variance always read zero — the exact
     * false reassurance this review exists to avoid.
     */
    const settled = payables.filter((p) => p.status === 'settled');
    const settledByOrder = new Map(settled.map((p) => [p.order_id, p]));
    const settledOrders = paid.filter((o) => settledByOrder.has(String(o._id)));

    const settledVendorCostCents = settledOrders.reduce(
      (sum, o) => sum + (settledByOrder.get(String(o._id))?.amount_cents ?? 0),
      0,
    );
    const settledQuotedCents = settledOrders.reduce(
      (sum, o) => sum + (o.vendor_cost_cents ?? 0),
      0,
    );

    const costVarianceCents = settledOrders.length
      ? settledVendorCostCents - settledQuotedCents
      : null;
    const costVariancePercent =
      costVarianceCents !== null && settledQuotedCents > 0
        ? Math.round((costVarianceCents / settledQuotedCents) * 1000) / 10
        : null;
    const marginRealisedCents = settledOrders.length
      ? settledOrders.reduce((sum, o) => sum + (o.charged_cents ?? 0), 0) - settledVendorCostCents
      : null;

    // ─── moderation ─────────────────────────────────────────────────────────────────────────
    const decided = assets.filter((a) => a.moderated_at);
    const waits = decided
      .map((a) => {
        const created = (a as { created_at?: Date }).created_at;
        if (!created || !a.moderated_at) return null;
        return Math.round((a.moderated_at.getTime() - created.getTime()) / 60_000);
      })
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);

    // ─── failures ───────────────────────────────────────────────────────────────────────────
    const rejectedAssetIds = new Set(
      assets.filter((a) => a.moderation_status === 'rejected').map((a) => String(a._id)),
    );
    const failures = {
      paymentFailed: orders.filter((o) => o.status === 'payment_failed').length,
      submissionFailed: orders.filter((o) => o.status === 'submission_failed').length,
      // The one that costs a refund: artwork refused AFTER the buyer paid.
      rejectedAfterPayment: paid.filter(
        (o) => o.asset_id && rejectedAssetIds.has(String(o.asset_id)),
      ).length,
      quoteExpiredAtCheckout: orders.filter(
        (o) => o.status === 'quoted' && o.quote_expires_at && o.quote_expires_at < new Date(),
      ).length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
      refunded: orders.filter((o) => o.status === 'refunded').length,
      submissionRetriesUsed: orders.reduce((sum, o) => sum + (o.submission_attempts ?? 0), 0),
    };

    // ─── readiness ──────────────────────────────────────────────────────────────────────────
    const readiness: string[] = [];
    if (mailed === 0) {
      readiness.push(
        'No order has reached `mailed` yet. Nothing about fulfilment has been proven end to end.',
      );
    }
    if (!settledOrders.length) {
      readiness.push(
        'No vendor payable has settled, so the real per-piece cost is still unverified — the ' +
          'central unknown the pilot exists to answer.',
      );
    }
    if (costVariancePercent !== null && Math.abs(costVariancePercent) > 5) {
      readiness.push(
        `The vendor billed ${costVariancePercent > 0 ? 'MORE' : 'less'} than quoted by ` +
          `${Math.abs(costVariancePercent)}%. Understand why before pricing at scale.`,
      );
    }
    if (failures.submissionFailed > 0) {
      readiness.push(
        `${failures.submissionFailed} paid order(s) never reached the printer. Each is a customer ` +
          'charged with nothing to show for it.',
      );
    }
    if (failures.rejectedAfterPayment > 0) {
      readiness.push(
        `${failures.rejectedAfterPayment} order(s) had artwork rejected after payment. If this is ` +
          'common, moderation belongs before checkout rather than after it.',
      );
    }
    const p90 = percentile(waits, 0.9);
    if (p90 !== null && p90 > 24 * 60) {
      readiness.push(
        `Slowest artwork reviews took over ${Math.round(p90 / 60)}h. Mail dates will start slipping.`,
      );
    }
    if (paid.length < 5) {
      readiness.push(
        `Only ${paid.length} paid order(s). The roadmap asks for 5–10 before drawing conclusions.`,
      );
    }
    if (!readiness.length) {
      readiness.push('No blocking signals. A human should still read the numbers before going general.');
    }

    return {
      mode: POSTCARD_ACCESS_MODE,
      marginBasis: POSTCARD_MARGIN_BASIS,
      generatedAt: new Date(),
      orders: { total: orders.length, byStatus, submitted, mailed },
      economics: {
        grossChargedCents,
        quotedVendorCostCents,
        settledVendorCostCents,
        settledOrderCount: settledOrders.length,
        costVarianceCents,
        costVariancePercent,
        marginQuotedCents,
        marginRealisedCents,
      },
      moderation: {
        reviewed: decided.length,
        approved: assets.filter((a) => a.moderation_status === 'approved').length,
        rejected: rejectedAssetIds.size,
        medianMinutes: percentile(waits, 0.5),
        p90Minutes: p90,
        stillWaiting: assets.filter(
          (a) => a.moderation_status === 'pending' && a.prepress_status === 'passed',
        ).length,
      },
      failures,
      readiness,
    };
  },
};
