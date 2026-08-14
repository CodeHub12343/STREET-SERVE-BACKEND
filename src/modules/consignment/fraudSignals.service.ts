import { logger } from '../../config/logger';
import { raiseFraudFlag } from '../../shared/fraud';
import { formatCents } from '../../shared/money';
import {
  InventoryCheckoutModel,
  InventoryReturnModel,
  InventorySaleModel,
} from './consignment.model';

/**
 * Consignment fraud signals (Phase 6).
 *
 * DESIGN PRINCIPLE, taken from the security docs: anomalies are FLAGGED FOR HUMAN REVIEW, never
 * auto-banned. The cost of wrongly banning a legitimate low-income seller is far higher than the
 * cost of a reviewer spending two minutes on a false positive — these people are the reason the
 * product exists. Every threshold below is deliberately conservative for that reason.
 */

/** Minimum sales before a ratio means anything — small samples produce nonsense. */
const MIN_SALES_FOR_RATIO = 8;
/** Below this share of digital sales, a seller looks like they're steering customers to cash. */
const SUSPICIOUS_DIGITAL_RATIO = 0.1;
/** Loss claims across distinct checkouts before it stops looking like bad luck. */
const REPEAT_LOSS_THRESHOLD = 3;
/** Checkouts opened in the window before the pace itself is the signal. */
const VELOCITY_CHECKOUT_THRESHOLD = 10;
const VELOCITY_WINDOW_DAYS = 7;

export const fraudSignalsService = {
  /**
   * Under-reporting detection. In a cash sale the seller already holds the money, so reporting
   * less than they sold is directly profitable and nearly undetectable per-transaction. What IS
   * visible is the pattern: a seller whose sales are almost entirely cash while their peers use
   * the digital rail.
   */
  async checkCashRatio(sellerId: string): Promise<boolean> {
    const checkoutIds = (
      await InventoryCheckoutModel.find({ seller_id: sellerId }).select({ _id: 1 }).lean().exec()
    ).map((c) => String(c._id));
    if (checkoutIds.length === 0) return false;

    const rows = await InventorySaleModel.aggregate<{ _id: string; count: number; cents: number }>([
      { $match: { checkout_id: { $in: checkoutIds } } },
      { $group: { _id: '$payment_rail', count: { $sum: 1 }, cents: { $sum: '$sale_amount_cents' } } },
    ]).exec();

    const digital = rows.find((r) => r._id === 'digital');
    const cash = rows.find((r) => r._id === 'cash');
    const totalSales = (digital?.count ?? 0) + (cash?.count ?? 0);
    if (totalSales < MIN_SALES_FOR_RATIO) return false;

    const digitalRatio = (digital?.count ?? 0) / totalSales;
    if (digitalRatio >= SUSPICIOUS_DIGITAL_RATIO) return false;

    await raiseFraudFlag({
      type: 'cash_under_reporting',
      subjectId: sellerId,
      signals: {
        totalSales,
        digitalSales: digital?.count ?? 0,
        cashSales: cash?.count ?? 0,
        digitalRatio: Number(digitalRatio.toFixed(3)),
        cashValue: formatCents(cash?.cents ?? 0),
        note: 'Almost all sales are cash. May be legitimate (cash-only pitch) — review, do not auto-act.',
      },
    });
    logger.info({ sellerId, digitalRatio }, 'fraud signal: cash-heavy sales pattern');
    return true;
  },

  /**
   * Repeat "lost" claims. Losing inventory once is plausible; doing it repeatedly across separate
   * checkouts is a pattern. Phase 4 already charges the seller for losses, so this is about
   * catching someone treating that charge as an acceptable cost of taking free stock.
   */
  async checkRepeatLossClaims(sellerId: string): Promise<boolean> {
    const checkoutIds = (
      await InventoryCheckoutModel.find({ seller_id: sellerId }).select({ _id: 1 }).lean().exec()
    ).map((c) => String(c._id));
    if (checkoutIds.length < REPEAT_LOSS_THRESHOLD) return false;

    const lossClaims = await InventoryReturnModel.countDocuments({
      checkout_id: { $in: checkoutIds },
      condition_assessment: { $in: ['lost', 'damaged'] },
    }).exec();
    if (lossClaims < REPEAT_LOSS_THRESHOLD) return false;

    await raiseFraudFlag({
      type: 'repeat_loss_claims',
      subjectId: sellerId,
      signals: {
        lossClaims,
        totalCheckouts: checkoutIds.length,
        note: 'Repeated lost/damaged claims across separate checkouts.',
      },
    });
    logger.info({ sellerId, lossClaims }, 'fraud signal: repeat loss claims');
    return true;
  },

  /**
   * Velocity. Taking stock far faster than it is sold or returned is the shape of someone
   * accumulating inventory they don't intend to account for.
   */
  async checkVelocity(sellerId: string): Promise<boolean> {
    const since = new Date(Date.now() - VELOCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recent = await InventoryCheckoutModel.countDocuments({
      seller_id: sellerId,
      created_at: { $gte: since },
    }).exec();
    if (recent < VELOCITY_CHECKOUT_THRESHOLD) return false;

    const settled = await InventoryCheckoutModel.countDocuments({
      seller_id: sellerId,
      created_at: { $gte: since },
      status: { $in: ['settled', 'ended'] },
    }).exec();
    // Busy AND closing them out is a good seller, not a risk.
    if (settled >= recent / 2) return false;

    await raiseFraudFlag({
      type: 'checkout_velocity',
      subjectId: sellerId,
      signals: {
        checkoutsInWindow: recent,
        settledInWindow: settled,
        windowDays: VELOCITY_WINDOW_DAYS,
        note: 'High checkout rate with few closed out. May be a genuinely busy seller — review.',
      },
    });
    logger.info({ sellerId, recent, settled }, 'fraud signal: checkout velocity');
    return true;
  },

  /** Run every signal for one seller. Never throws — a monitoring failure must not block a sale. */
  async evaluateSeller(sellerId: string): Promise<void> {
    try {
      await Promise.all([
        this.checkCashRatio(sellerId),
        this.checkRepeatLossClaims(sellerId),
        this.checkVelocity(sellerId),
      ]);
    } catch (err) {
      logger.error({ err, sellerId }, 'fraud signal evaluation failed');
    }
  },

  /** Nightly sweep across sellers with recent activity. */
  async sweep(): Promise<{ evaluated: number }> {
    const since = new Date(Date.now() - VELOCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const sellerIds = await InventoryCheckoutModel.distinct('seller_id', {
      created_at: { $gte: since },
    }).exec();
    for (const id of sellerIds) await this.evaluateSeller(String(id));
    return { evaluated: sellerIds.length };
  },
};
