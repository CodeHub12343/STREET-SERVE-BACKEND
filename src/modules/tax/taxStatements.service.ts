import { isOwnerSync } from '../../shared/businessAccess';
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import { ERROR_CODES } from '../../shared/errors/codes';
import type { Principal } from '../../shared/types/principal';
import { BrandSplitModel } from '../brands/brandSplit.model';
import { consignmentRepository } from '../consignment/consignment.repository';
import { SalePaymentModel } from '../salepayments/salepayments.model';
import { SellerDebtModel } from '../debt/debt.model';
import { SettlementModel } from '../consignment/consignment.model';

/**
 * Annual tax statements (Phase 5).
 *
 * Sellers and hubs need a defensible summary of what they earned through the platform in order to
 * file their own taxes. Stripe issues the 1099-K for payouts it processed; this statement is the
 * platform-side view — gross sales, platform fees, and net — reconstructed from source records
 * rather than a cached total, so it can always be re-derived and audited.
 */
function yearRange(year: number) {
  return {
    from: new Date(Date.UTC(year, 0, 1)),
    to: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

export const taxStatementsService = {
  /** A seller's own annual earnings summary. */
  async sellerStatement(principal: Principal, year: number) {
    const { from, to } = yearRange(year);

    const checkouts = await consignmentRepository.listCheckoutsBySeller(principal.userId, 1000);
    const checkoutIds = checkouts.map((c) => String(c._id));

    const [digital, settlements, debts] = await Promise.all([
      SalePaymentModel.find({
        seller_id: principal.userId,
        status: 'succeeded',
        paid_at: { $gte: from, $lt: to },
      })
        .lean()
        .exec(),
      SettlementModel.find({
        checkout_id: { $in: checkoutIds },
        settled_at: { $gte: from, $lt: to },
      })
        .lean()
        .exec(),
      SellerDebtModel.find({
        seller_id: principal.userId,
        created_at: { $gte: from, $lt: to },
      })
        .lean()
        .exec(),
    ]);

    const digitalGrossCents = digital.reduce((s, p) => s + p.amount_cents, 0);
    const taxCollectedCents = digital.reduce((s, p) => s + (p.tax_cents ?? 0), 0);
    const refundedCents = digital.reduce((s, p) => s + (p.refunded_cents ?? 0), 0);
    const settledGrossCents = settlements.reduce((s, r) => s + r.gross_sales_cents, 0);
    const platformFeesCents = settlements.reduce((s, r) => s + r.platform_fee_cents, 0);
    const netEarningsCents = settlements.reduce((s, r) => s + r.seller_net_cents, 0);
    const liabilitiesCents = debts
      .filter((d) => d.origin_type !== 'cash_sale')
      .reduce((s, d) => s + d.principal_cents, 0);

    return {
      year,
      subjectType: 'seller' as const,
      subjectId: principal.userId,
      grossSalesCents: settledGrossCents,
      digitalGrossCents,
      // Sales tax was collected and remitted BY THE PLATFORM as marketplace facilitator — it is
      // not the seller's income and not their liability. Shown so their books reconcile.
      salesTaxCollectedByPlatformCents: taxCollectedCents,
      platformFeesCents,
      refundsCents: refundedCents,
      inventoryLiabilitiesCents: liabilitiesCents,
      netEarningsCents,
      settlementCount: settlements.length,
      note: 'Sales tax on marketplace sales is collected and remitted by StreetServe as marketplace facilitator. Payout totals reported to tax authorities are issued by Stripe.',
      generatedAt: new Date(),
    };
  },

  /**
   * ═══ FRANCHISE / MULTI-VENDOR — Phase 5 operator tax statement. ═══
   *
   * For a `per_operator` brand, each operator receives their share of each sale as a direct
   * transfer to their own Stripe account (see `BrandSplit` ledger). The platform is still the
   * marketplace facilitator for the sale itself (sales tax, 1099-K via Stripe), but the
   * OPERATOR needs their own annual summary of what passed through their account.
   *
   * This reconstructs that summary from the authoritative source — the `BrandSplit` event
   * stream — rather than a cached counter, so it can always be re-derived. Rows with status
   * `fallback_to_owner` are explicitly EXCLUDED: that money reached the brand owner, not the
   * operator, and reporting it to the operator would misstate what they actually received.
   * Reversed rows are netted out of the paid total so a refund in the same year nets correctly.
   */
  async operatorStatement(principal: Principal, year: number) {
    const { from, to } = yearRange(year);
    const legs = await BrandSplitModel.find({
      operator_user_id: principal.userId,
      created_at: { $gte: from, $lt: to },
    })
      .select('status net_cents stripe_transfer_id reversed_at')
      .lean()
      .exec();

    let paidCents = 0;
    let reversedCents = 0;
    let paidCount = 0;
    for (const leg of legs) {
      if (leg.status === 'paid') {
        paidCents += leg.net_cents;
        paidCount += 1;
      } else if (leg.status === 'reversed') {
        /**
         * A reversed row MEANS that leg's money came back out via refund. Count the amount
         * once as negative so the net equals what the operator actually kept at year-end.
         * (The leg's historical `paid` was captured earlier; we subtract rather than touch it
         * so the audit log of what happened stays intact.)
         */
        reversedCents += leg.net_cents;
      }
      // fallback_to_owner is NOT part of this operator's statement — see docblock above.
    }

    return {
      year,
      subjectType: 'operator' as const,
      subjectId: principal.userId,
      /** Direct Stripe transfers to the operator's own connected account. */
      transfersReceivedCents: paidCents,
      /** Reversed via refunds in the same tax year — netted below. */
      transfersReversedCents: reversedCents,
      netReceivedCents: paidCents - reversedCents,
      transferCount: paidCount,
      note:
        'Direct Stripe transfers to your operator account. Sales tax on the underlying marketplace sales is collected and remitted by StreetServe as marketplace facilitator; Stripe issues the 1099-K for payouts processed to your connected account.',
      generatedAt: new Date(),
    };
  },

  /** A hub's annual summary — the supply side of the same records. */
  async hubStatement(principal: Principal, hubId: string, year: number) {
    const hub = await consignmentRepository.findHubById(hubId);
    if (!hub) throw NotFoundError('Hub not found');
    if (!isOwnerSync(principal.userId, hub)) {
      throw ForbiddenError('You do not own this hub', ERROR_CODES.NOT_OWNER);
    }
    const { from, to } = yearRange(year);

    const checkouts = await consignmentRepository.listCheckoutsByHub(hubId);
    const checkoutIds = checkouts.map((c) => String(c._id));
    const settlements = await SettlementModel.find({
      checkout_id: { $in: checkoutIds },
      settled_at: { $gte: from, $lt: to },
    })
      .lean()
      .exec();

    return {
      year,
      subjectType: 'hub' as const,
      subjectId: hubId,
      grossSalesCents: settlements.reduce((s, r) => s + r.gross_sales_cents, 0),
      platformFeesCents: settlements.reduce((s, r) => s + r.platform_fee_cents, 0),
      hubShareCents: settlements.reduce((s, r) => s + r.hub_share_cents, 0),
      settlementCount: settlements.length,
      note: 'Sales tax on marketplace sales is collected and remitted by StreetServe as marketplace facilitator.',
      generatedAt: new Date(),
    };
  },
};
