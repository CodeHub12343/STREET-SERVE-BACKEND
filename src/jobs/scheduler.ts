import type { Redis } from 'ioredis';

import {
  PLACEMENT_PAYMENT_RECONCILE_CRON,
  POSTCARD_SETTLEMENT_CRON,
  POSTCARD_STATUS_POLL_CRON,
  POSTCARD_SUBMISSION_CRON,
} from '../config/constants';
import { logger } from '../config/logger';
import { initQueues, getQueue } from './queues';

/**
 * Registers repeatable (cron) jobs. BullMQ dedupes repeatable jobs by key, so a single scheduler
 * owner is safe across multiple worker instances. Phase 0 registers the foundational heartbeats;
 * later phases add the SLA/geo/settlement sweeps from BACKGROUND_JOBS.md §4.
 */
export async function registerScheduledJobs(connection: Redis): Promise<void> {
  initQueues(connection);

  // Nightly reconciliation heartbeat (ledger vs Stripe).
  await getQueue('reconciliation').add(
    'stripe-reconciliation',
    {},
    { repeat: { pattern: '0 3 * * *' }, jobId: 'stripe-reconciliation', removeOnComplete: true },
  );

  // Nightly double-entry integrity check: every account must equal the sum of its entries, and
  // every transaction must net to zero. Drift here means the books can't be trusted, so it runs
  // separately from the Stripe reconciliation and pages on failure.
  await getQueue('reconciliation').add(
    'ledger-reconciliation',
    {},
    { repeat: { pattern: '30 3 * * *' }, jobId: 'ledger-reconciliation', removeOnComplete: true },
  );

  /**
   * Rescues placements that were paid for but never activated because their webhook was missed.
   * A webhook is a delivery promise, not a guarantee, and a paid promotion that never runs is the
   * worst possible outcome for the buyer.
   */
  await getQueue('sweeps').add(
    'placement-payment-reconcile',
    {},
    {
      repeat: { pattern: PLACEMENT_PAYMENT_RECONCILE_CRON },
      jobId: 'placement-payment-reconcile',
      removeOnComplete: true,
    },
  );

  /**
   * Gets paid orders to the printer. Frequent because it is the ONLY trigger — see
   * `fulfilment.service.ts` for why submission is a sweep rather than a job pushed from the
   * payment webhook (a paid order must never depend on Redis having been up for one call).
   */
  await getQueue('sweeps').add(
    'postcard-submission',
    {},
    {
      repeat: { pattern: POSTCARD_SUBMISSION_CRON },
      jobId: 'postcard-submission',
      removeOnComplete: true,
    },
  );

  /**
   * Moderation queue depth + age of the oldest waiting item (TD-8). Cheap, and the only way the
   * scaling ceiling on human review arrives as a graph rather than as a complaint.
   */
  await getQueue('sweeps').add(
    'postcard-moderation-metrics',
    {},
    { repeat: { pattern: '*/5 * * * *' }, jobId: 'postcard-moderation-metrics', removeOnComplete: true },
  );

  /** Asks the vendor how the print run is going. The vendor pushes nothing reliable. */
  await getQueue('sweeps').add(
    'postcard-status-poll',
    {},
    {
      repeat: { pattern: POSTCARD_STATUS_POLL_CRON },
      jobId: 'postcard-status-poll',
      removeOnComplete: true,
    },
  );

  /**
   * Weekly close of postcard vendor payables (ADR-007 Topology B). Closes a statement only; a
   * human confirms the payment, so this never moves money on its own.
   */
  await getQueue('sweeps').add(
    'postcard-settlement',
    {},
    {
      repeat: { pattern: POSTCARD_SETTLEMENT_CRON },
      jobId: 'postcard-settlement',
      removeOnComplete: true,
    },
  );

  // Maintenance heartbeat (retention purge, index health).
  await getQueue('maintenance').add(
    'daily-maintenance',
    {},
    { repeat: { pattern: '0 4 * * *' }, jobId: 'daily-maintenance', removeOnComplete: true },
  );

  // ─── Phase 2 sweeps (BACKGROUND_JOBS.md §4) ────────────────────────────────────────────────
  const sweeps = getQueue('sweeps');
  await sweeps.add(
    'wave-down-sla',
    {},
    { repeat: { every: 30_000 }, jobId: 'wave-down-sla', removeOnComplete: true },
  );
  await sweeps.add(
    'stale-session',
    {},
    { repeat: { every: 60_000 }, jobId: 'stale-session', removeOnComplete: true },
  );
  await sweeps.add(
    'queue-hold-expiry',
    {},
    { repeat: { every: 60_000 }, jobId: 'queue-hold-expiry', removeOnComplete: true },
  );
  // Release claimed gigs nobody showed up for. Every 5 min is ample against a 90-minute grace.
  await sweeps.add(
    'job-no-show',
    {},
    { repeat: { every: 300_000 }, jobId: 'job-no-show', removeOnComplete: true },
  );
  await sweeps.add(
    'proximity-alert-eval',
    {},
    { repeat: { every: 60_000 }, jobId: 'proximity-alert-eval', removeOnComplete: true },
  );
  await sweeps.add(
    'delivery-offer-sweep',
    {},
    // Every 30s. This is the ONLY part of dispatch that is a sweep: the broadcast itself is
    // event-driven (A-6), and this handles expiry and re-broadcast, where a few seconds of slack
    // costs nothing.
    { repeat: { every: 30_000 }, jobId: 'delivery-offer-sweep', removeOnComplete: true },
  );
  await sweeps.add(
    'driver-lapse',
    {},
    { repeat: { every: 86_400_000 }, jobId: 'driver-lapse', removeOnComplete: true },
  );
  await sweeps.add(
    'boost-deadline',
    {},
    // Hourly. A deadline that passes at 3pm should refund the same afternoon, not tomorrow — the
    // promise is "automatically", and a day's silence reads as the money being kept.
    { repeat: { every: 3_600_000 }, jobId: 'boost-deadline', removeOnComplete: true },
  );
  await sweeps.add(
    'boost-rollover',
    {},
    { repeat: { every: 86_400_000 }, jobId: 'boost-rollover', removeOnComplete: true },
  );
  await sweeps.add(
    'subscription-reconcile',
    {},
    /**
     * Six-hourly. The webhook already carries these transitions within seconds, so this exists only
     * for the deliveries that never arrive — a deploy mid-event, a timeout, an instance asleep.
     * Stripe gives up retrying long before anyone would notice, and the failure mode is a cancelled
     * plan that keeps its entitlement, so the gap must be bounded by something other than luck.
     * Six hours costs one Stripe read per entitled subscription and bounds the exposure to a day at
     * the very worst.
     */
    { repeat: { every: 21_600_000 }, jobId: 'subscription-reconcile', removeOnComplete: true },
  );
  await sweeps.add(
    'payforward-expiry',
    {},
    // Daily. Expiry is a 12-month horizon, so a tighter cadence would only add load to discover the
    // same nothing — sweeps are for money and cleanup, not for anything a person is waiting on.
    { repeat: { every: 86_400_000 }, jobId: 'payforward-expiry', removeOnComplete: true },
  );
  await sweeps.add(
    'sponsor-expiry',
    {},
    /**
     * Daily. A sponsorship term is measured in months, so a tighter cadence would only rediscover
     * the same nothing — but it must exist at all: without it a paid placement stays on the landing
     * page for ever and keeps attributing signups after the term it was paid for has ended.
     */
    { repeat: { every: 86_400_000 }, jobId: 'sponsor-expiry', removeOnComplete: true },
  );
  await sweeps.add(
    'payforward-expiry-notice',
    {},
    { repeat: { every: 86_400_000 }, jobId: 'payforward-expiry-notice', removeOnComplete: true },
  );
  await sweeps.add(
    'payforward-abandoned',
    {},
    /**
     * Every 10 minutes. Community money committed to a checkout nobody paid for is unusable by the
     * person it was meant for, and on a fully covered order there is no declined card to notice.
     */
    { repeat: { every: 600_000 }, jobId: 'payforward-abandoned', removeOnComplete: true },
  );
  await sweeps.add(
    'rto-reconcile',
    {},
    /**
     * Every 15 minutes. A dropped webhook here means a customer has paid a deposit and owns
     * nothing, or has paid off an item the system still says is not theirs.
     */
    { repeat: { every: 900_000 }, jobId: 'rto-reconcile', removeOnComplete: true },
  );
  await sweeps.add(
    'payforward-reconcile',
    {},
    /**
     * Every 15 minutes, unlike the daily expiry sweeps above, because this one is about money that
     * has ALREADY been taken. A missed webhook here means the giver was charged and the pool was
     * never credited — with no order to chase and no goods to be missing, nobody has any reason to
     * notice. A day of that is a day of gifts that helped no one.
     */
    { repeat: { every: 900_000 }, jobId: 'payforward-reconcile', removeOnComplete: true },
  );
  await sweeps.add(
    'booking-reminders',
    {},
    { repeat: { every: 300_000 }, jobId: 'booking-reminders', removeOnComplete: true },
  );
  await sweeps.add(
    'overdue-return-sweep',
    {},
    { repeat: { every: 900_000 }, jobId: 'overdue-return-sweep', removeOnComplete: true },
  );
  // ─── Phase 2 digital rail ──────────────────────────────────────────────────────────────────
  // Release units held by customer payments that were never completed.
  await sweeps.add(
    'sale-payment-expiry',
    {},
    { repeat: { every: 300_000 }, jobId: 'sale-payment-expiry', removeOnComplete: true },
  );
  // Complete payout legs that failed because a payee had no payout account at the time.
  await sweeps.add(
    'payout-retry',
    {},
    { repeat: { every: 900_000 }, jobId: 'payout-retry', removeOnComplete: true },
  );
  // ─── Phase 3 cash rail ─────────────────────────────────────────────────────────────────────
  await sweeps.add(
    'debt-reminders',
    {},
    { repeat: { pattern: '0 10 * * *' }, jobId: 'debt-reminders', removeOnComplete: true },
  );
  await sweeps.add(
    'debt-escalation',
    {},
    { repeat: { pattern: '30 10 * * *' }, jobId: 'debt-escalation', removeOnComplete: true },
  );

  // ─── Phase 6 hardening ─────────────────────────────────────────────────────────────────────
  // Consignment fraud signals — flagged for human review, never auto-enforced.
  await sweeps.add(
    'fraud-signals',
    {},
    { repeat: { pattern: '0 5 * * *' }, jobId: 'fraud-signals', removeOnComplete: true },
  );
  // Solvency + Stripe-vs-ledger drift. Runs often enough to warn BEFORE a payout fails.
  await getQueue('reconciliation').add(
    'balance-monitor',
    {},
    { repeat: { every: 3_600_000 }, jobId: 'balance-monitor', removeOnComplete: true },
  );
  await sweeps.add(
    'dispute-sla-alert',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'dispute-sla-alert', removeOnComplete: true },
  );
  // Consignment expiry notices (R15) — daily: 14/7/3-day + on-date notices, and expiry → Return-Pending.
  await sweeps.add(
    'consignment-expiry-notices',
    {},
    {
      repeat: { pattern: '0 9 * * *' },
      jobId: 'consignment-expiry-notices',
      removeOnComplete: true,
    },
  );
  // RTO installments (R21/R22) — hourly: charge due installments + escalate delinquency Grace→Late.
  await sweeps.add(
    'rto-installments',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'rto-installments', removeOnComplete: true },
  );
  /**
   * §49 — the five reminder stages. Daily rather than hourly: these are calendar events in a
   * customer's month, and four nudges a day about the same payment is harassment, not service.
   */
  await sweeps.add(
    'rto-reminders',
    {},
    { repeat: { pattern: '0 10 * * *' }, jobId: 'rto-reminders', removeOnComplete: true },
  );
  await sweeps.add(
    'block-party-detect',
    {},
    { repeat: { every: 60_000 }, jobId: 'block-party-detect', removeOnComplete: true },
  );
  await sweeps.add(
    'gift-expiry',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'gift-expiry', removeOnComplete: true },
  );
  await sweeps.add(
    'spot-me-defaults',
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: 'spot-me-defaults', removeOnComplete: true },
  );
  await sweeps.add(
    'giveaway-reset',
    {},
    { repeat: { pattern: '5 0 * * *' }, jobId: 'giveaway-reset', removeOnComplete: true },
  );
  // Ad settlement: bill accrued impressions, close campaigns past their window, release slots held
  // by abandoned checkouts. Every 5 min — impressions batch at 25, so this bills promptly without
  // making a feed render a write per ad.
  await sweeps.add(
    'ad-settlement',
    {},
    { repeat: { every: 300_000 }, jobId: 'ad-settlement', removeOnComplete: true },
  );

  logger.info('scheduled jobs registered');
}
