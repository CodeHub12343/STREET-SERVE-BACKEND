import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { formatCents } from '../../shared/money';
import { stripe } from '../../integrations/stripe';
import { ledgerService } from '../ledger/ledger.service';

/**
 * Platform balance monitoring (Phase 6).
 *
 * Two questions, asked nightly:
 *   1. SOLVENCY — do we hold enough to cover what we owe sellers, hubs, and the state?
 *   2. DRIFT   — does the Stripe balance agree with what the ledger says we hold?
 *
 * A payout that fails for insufficient funds is a user-visible failure and a trust event, so this
 * is designed to fire BEFORE that happens rather than diagnose it afterwards.
 */

/** Warn while there is still time to top up, rather than at the moment of failure. */
const LOW_BALANCE_WARNING_RATIO = 1.2; // cash < 120% of obligations
/** Stripe vs ledger difference tolerated before it's treated as a real discrepancy. */
const BALANCE_DRIFT_TOLERANCE_CENTS = 100;

export const balanceMonitorService = {
  async check(): Promise<{
    solvency: Awaited<ReturnType<typeof ledgerService.solvency>>;
    stripeAvailableCents: number | null;
    driftCents: number | null;
    alerts: string[];
  }> {
    const solvency = await ledgerService.solvency();
    const alerts: string[] = [];

    if (!solvency.healthy) {
      alerts.push(
        `INSOLVENT: holding ${formatCents(solvency.cashCents)} against ${formatCents(solvency.obligationsCents)} owed ` +
          `(short ${formatCents(Math.abs(solvency.surplusCents))})`,
      );
    } else if (solvency.cashCents < solvency.obligationsCents * LOW_BALANCE_WARNING_RATIO) {
      alerts.push(
        `LOW BALANCE: ${formatCents(solvency.cashCents)} held vs ${formatCents(solvency.obligationsCents)} owed — top up before payouts fail`,
      );
    }

    if (solvency.taxPayableCents > 0) {
      alerts.push(
        `${formatCents(solvency.taxPayableCents)} of collected sales tax is awaiting remittance — this is not spendable`,
      );
    }

    // Compare against the real Stripe balance where credentials allow it.
    let stripeAvailableCents: number | null = null;
    let driftCents: number | null = null;
    try {
      const balance = await stripe().getPlatformBalance();
      stripeAvailableCents = balance.availableCents;
      driftCents = balance.availableCents - solvency.cashCents;
      if (Math.abs(driftCents) > BALANCE_DRIFT_TOLERANCE_CENTS) {
        alerts.push(
          `BALANCE DRIFT: Stripe reports ${formatCents(balance.availableCents)} but the ledger says ${formatCents(solvency.cashCents)} ` +
            `(difference ${formatCents(driftCents)})`,
        );
      }
    } catch (err) {
      // Missing credentials in dev are expected; a real failure is worth knowing about.
      logger.debug({ err }, 'platform balance unavailable — skipping Stripe comparison');
    }

    if (alerts.length > 0) {
      logger.error({ alerts, solvency, stripeAvailableCents }, 'PLATFORM BALANCE ALERT');
    } else {
      logger.info(
        { cash: solvency.cashCents, obligations: solvency.obligationsCents },
        'platform balance healthy',
      );
    }

    return { solvency, stripeAvailableCents, driftCents, alerts };
  },

  /** Guard for the payout path: refuse to disburse money the platform doesn't hold. */
  async canDisburse(amountCents: number): Promise<boolean> {
    if (!env.STRIPE_SECRET_KEY) return true; // dev/test without Stripe
    const { cashCents } = await ledgerService.solvency();
    return cashCents >= amountCents;
  },
};
