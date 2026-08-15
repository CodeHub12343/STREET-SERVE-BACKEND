import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { runRetentionPurge } from '../retention';
import type { Redis } from 'ioredis';

import { logger } from '../../config/logger';
import { settlementService } from '../../modules/postcards/settlement.service';
import { postcardFulfilment } from '../../modules/postcards/fulfilment.service';
import { artworkService } from '../../modules/postcards/artwork.service';
import { runWithContext } from '../../shared/context';
import { EVENTS_QUEUE } from '../../events/bus';
import type { DomainEventName } from '../../events/types';
import { deadLetterFinancialJob, FINANCIAL_JOB_OPTIONS, isFinalAttempt } from '../financial';
import { ledgerIntegrityAlert, platformBalanceAlert } from '../integrityAlerts';
import { getQueue } from '../queues';
import { livemapService } from '../../modules/livemap/livemap.service';
import { jobsService } from '../../modules/jobs/jobs.service';
import { paymentsService } from '../../modules/payments/payments.service';
import { ledgerService } from '../../modules/ledger/ledger.service';
import { balanceMonitorService } from '../../modules/payments/balanceMonitor.service';
import { fraudSignalsService } from '../../modules/consignment/fraudSignals.service';
import { trustService } from '../../modules/trust/trust.service';
import { salePaymentsService } from '../../modules/salepayments/salepayments.service';
import { debtService } from '../../modules/debt/debt.service';
import { queueService } from '../../modules/queue/queue.service';
import { schedulingService } from '../../modules/scheduling/scheduling.service';
import { payforwardService } from '../../modules/payforward/payforward.service';
import { boostService } from '../../modules/boost/boost.service';
import { subscriptionsService } from '../../modules/subscriptions/subscriptions.service';
import { deliveryService } from '../../modules/delivery/delivery.service';
import { driverService } from '../../modules/delivery/driver.service';
import { consignmentService } from '../../modules/consignment/consignment.service';
import { rtoService } from '../../modules/rto/rto.service';
import { adsService } from '../../modules/ads/ads.service';
import { blockPartyService } from '../../modules/growth/blockparty.service';
import { giftsService } from '../../modules/growth/gifts.service';
import { giveawaysService } from '../../modules/growth/giveaways.service';
import { spotMeService } from '../../modules/growth/spotme.service';

/**
 * Worker-side processors. Phase 0 wires the `events` worker with a handler registry (empty now —
 * later phases register handlers, e.g. inventory.settled → payout) plus the scheduled `sweeps`
 * heartbeats. Every processor runs inside a correlation context for end-to-end tracing.
 */
type EventHandler = (payload: unknown) => Promise<void>;
const eventHandlers = new Map<DomainEventName, EventHandler[]>();

export function registerEventHandler(name: DomainEventName, handler: EventHandler): void {
  const list = eventHandlers.get(name) ?? [];
  list.push(handler);
  eventHandlers.set(name, list);
}

interface EventEnvelope {
  name: DomainEventName;
  payload: unknown;
  correlationId: string | null;
}

export function startWorkers(redis: Redis): Worker[] {
  const workers: Worker[] = [];
  const connection = redis as unknown as ConnectionOptions;
  const deadLetter = (() => {
    try {
      return getQueue('dead_letter');
    } catch {
      return null;
    }
  })();

  const eventsWorker = new Worker(
    EVENTS_QUEUE,
    async (job: Job<EventEnvelope>) => {
      const { name, payload, correlationId } = job.data;
      const cid = correlationId ?? job.id ?? 'job';
      await runWithContext({ requestId: cid, correlationId: cid }, async () => {
        const handlers = eventHandlers.get(name) ?? [];
        if (handlers.length === 0) {
          logger.debug({ event: name }, 'no handlers registered for event');
          return;
        }
        await Promise.all(handlers.map((h) => h(payload)));
      });
    },
    { connection, concurrency: 10 },
  );
  eventsWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id, name: job?.name }, 'events worker job failed'),
  );
  workers.push(eventsWorker);

  // Scheduled heartbeats — placeholders that later phases replace with real sweep logic.
  const reconciliationWorker = new Worker(
    'reconciliation',
    async (job: Job) => {
      if (job.name === 'balance-monitor') {
        const result = await balanceMonitorService.check();
        // 8.3: the alert DECISION lives in `integrityAlerts.ts` so it can be exercised against a
        // seeded failure. Throwing is the alert — the financial-job handler dead-letters and pages
        // on-call, because being unable to fund payouts is not something to learn from a complaint.
        const alert = platformBalanceAlert(result);
        if (alert) throw new Error(alert);
        return;
      }
      if (job.name === 'ledger-reconciliation') {
        // Repair the cached balances (entries remain the source of truth), but report the drift —
        // a silent self-heal would hide the bug that caused it.
        const result = await ledgerService.reconcile({ repair: true });
        const alert = ledgerIntegrityAlert(result);
        if (alert) throw new Error(alert);
        logger.info({ name: job.name, ...result }, 'ledger reconciliation clean');
        return;
      }
      const result = await paymentsService.reconcile();
      logger.info({ name: job.name, ...result }, 'reconciliation run complete');
    },
    { connection, concurrency: 1 },
  );
  // Reconciliation is a FINANCIAL job: conservative retry, then dead-letter + page on-call.
  reconciliationWorker.on('failed', (job, err) => {
    const maxAttempts = job?.opts.attempts ?? FINANCIAL_JOB_OPTIONS.attempts ?? 3;
    if (job && isFinalAttempt(job.attemptsMade, maxAttempts)) {
      void deadLetterFinancialJob(deadLetter, 'reconciliation', job, err);
    } else {
      logger.warn(
        { err, jobId: job?.id, attempt: job?.attemptsMade },
        'reconciliation job failed — will retry',
      );
    }
  });
  workers.push(reconciliationWorker);

  /**
   * Post-settlement follow-up (Phase 6). Trust recompute and fraud evaluation read a seller's whole
   * history, so they run here rather than in the request that closed the sale.
   */
  const settlementWorker = new Worker(
    'settlement',
    async (job: Job) => {
      if (job.name !== 'settlement-followup') return;
      const { sellerId, checkoutId } = job.data as { sellerId: string; checkoutId: string };
      await trustService.recompute('seller', sellerId);
      await fraudSignalsService.evaluateSeller(sellerId);
      logger.debug({ checkoutId, sellerId }, 'settlement follow-up complete');
    },
    { connection, concurrency: 4 },
  );
  settlementWorker.on('failed', (job, err) => {
    const maxAttempts = job?.opts.attempts ?? FINANCIAL_JOB_OPTIONS.attempts ?? 3;
    if (job && isFinalAttempt(job.attemptsMade, maxAttempts)) {
      void deadLetterFinancialJob(deadLetter, 'settlement', job, err);
    } else {
      logger.warn({ err, jobId: job?.id }, 'settlement follow-up failed — will retry');
    }
  });
  workers.push(settlementWorker);

  const maintenanceWorker = new Worker(
    'maintenance',
    async (job: Job) => {
      // 6.4: this used to log 'maintenance heartbeat' and return, while the scheduler described it
      // as "retention purge, index health" — documented retention that did not exist.
      if (job.name === 'daily-maintenance') {
        const result = await runRetentionPurge();
        return result;
      }
      logger.info({ name: job.name }, 'maintenance job with no handler');
      return null;
    },
    { connection, concurrency: 1 },
  );
  workers.push(maintenanceWorker);

  // Phase 2 time-based sweeps.
  const sweepsWorker = new Worker(
    'sweeps',
    async (job: Job) => {
      switch (job.name) {
        case 'wave-down-sla': {
          const n = await queueService.expireWaveDowns();
          if (n) logger.info({ expired: n }, 'wave-down SLA sweep');
          break;
        }
        case 'stale-session': {
          const n = await livemapService.expireStaleSessions();
          if (n) logger.info({ ended: n }, 'stale-session sweep');
          break;
        }
        case 'job-no-show': {
          const n = await jobsService.sweepNoShows();
          if (n) logger.info({ released: n }, 'job no-show sweep');
          break;
        }
        case 'queue-hold-expiry': {
          const n = await queueService.expireHolds();
          if (n) logger.info({ released: n }, 'queue-hold-expiry sweep');
          break;
        }
        case 'proximity-alert-eval': {
          const n = await livemapService.evaluateProximityAlerts();
          if (n) logger.info({ sent: n }, 'proximity-alert sweep');
          break;
        }
        case 'delivery-offer-sweep': {
          const r = await deliveryService.sweepOffers();
          if (r.rebroadcast || r.expired) logger.info(r, 'delivery-offer sweep');
          break;
        }
        case 'driver-lapse': {
          const n = await driverService.suspendLapsed();
          if (n) logger.info({ suspended: n }, 'driver-lapse sweep');
          break;
        }
        case 'boost-deadline': {
          const r = await boostService.sweepDeadlines();
          if (r.expired) logger.info(r, 'boost-deadline sweep');
          break;
        }
        case 'boost-rollover': {
          const n = await boostService.sweepRollovers();
          if (n) logger.info({ refunded: n }, 'boost-rollover sweep');
          break;
        }
        case 'subscription-reconcile': {
          // Logs inside the service, and only when something actually changed — a sweep that finds
          // every subscription exactly as expected is the normal case and not worth a line.
          await subscriptionsService.reconcile();
          break;
        }
        case 'payforward-expiry': {
          const n = await payforwardService.expireStale();
          if (n) logger.info({ expired: n }, 'payforward-expiry sweep');
          break;
        }
        case 'payforward-expiry-notice': {
          const n = await payforwardService.sendExpiryNotices();
          if (n) logger.info({ notified: n }, 'payforward-expiry-notice sweep');
          break;
        }
        case 'booking-reminders': {
          const r = await schedulingService.sendDueReminders();
          if (r.sent24h || r.sent1h) logger.info(r, 'booking-reminders sweep');
          break;
        }
        case 'overdue-return-sweep': {
          const n = await consignmentService.sweepOverdue();
          if (n) logger.info({ flagged: n }, 'overdue-return sweep');
          break;
        }
        case 'placement-payment-reconcile': {
          const r = await adsService.reconcilePendingPayments();
          if (r.activated) {
            logger.warn(r, 'placement payment reconcile activated paid placements — webhook delivery may be broken');
          }
          break;
        }
        case 'postcard-submission': {
          const r = await postcardFulfilment.submitDue();
          if (r.submitted || r.failed) {
            logger.info(r, 'postcard submission sweep');
          }
          break;
        }
        case 'postcard-moderation-metrics': {
          await artworkService.refreshQueueMetrics();
          break;
        }
        case 'postcard-status-poll': {
          const r = await postcardFulfilment.pollDue();
          if (r.advanced) logger.info(r, 'postcard status poll');
          break;
        }
        case 'postcard-settlement': {
          /**
           * Closes a statement of what we owe the print vendor. Deliberately does NOT pay them:
           * the vendor takes payment out of band, and a cron that wires money to an external
           * account unattended is not something this service should do (ADR-007 Topology B).
           */
          const closed = await settlementService.closePeriod();
          if (closed) {
            logger.info(
              { settlementId: closed.id, totalCents: closed.totalCents, payables: closed.payableCount },
              'postcard settlement closed — awaiting payment confirmation',
            );
          }
          // Surfaces the credit exposure the topology accepted, and logs loudly past the threshold.
          const exposure = await settlementService.exposure();
          if (exposure.overAlertThreshold) {
            logger.error(exposure, 'postcard vendor payable over threshold');
          }
          break;
        }
        case 'sale-payment-expiry': {
          // Units held by an unpaid customer payment must go back on the shelf.
          const n = await salePaymentsService.expireStalePayments();
          if (n) logger.info({ released: n }, 'sale-payment expiry sweep');
          break;
        }
        case 'debt-reminders': {
          const n = await debtService.sendDueReminders();
          if (n) logger.info({ reminded: n }, 'debt reminder sweep');
          break;
        }
        case 'debt-escalation': {
          const n = await debtService.escalateOverdue();
          if (n) logger.info({ escalated: n }, 'debt escalation sweep');
          break;
        }
        case 'fraud-signals': {
          // Flags for human review only — never auto-enforced against a seller.
          const r = await fraudSignalsService.sweep();
          logger.info(r, 'consignment fraud-signal sweep');
          break;
        }
        case 'payout-retry': {
          // A payout leg that failed (no payout account yet) is otherwise stuck forever.
          const r = await consignmentService.retryFailedPayouts();
          if (r.attempted) logger.info(r, 'payout retry sweep');
          break;
        }
        case 'consignment-expiry-notices': {
          const r = await consignmentService.sweepExpiryNotices();
          if (r.noticed || r.returnPending || r.abandonment)
            logger.info(r, 'consignment expiry-notice sweep');
          break;
        }
        case 'rto-installments': {
          const r = await rtoService.chargeDueInstallments();
          const escalated = await rtoService.sweepDelinquency();
          if (r.charged || r.missed || r.completed || escalated)
            logger.info({ ...r, escalated }, 'rto installment sweep');
          break;
        }
        case 'dispute-sla-alert': {
          logger.debug('dispute SLA alert sweep (alerting hook)');
          break;
        }
        case 'block-party-detect': {
          const events = await blockPartyService.detectAndBroadcast();
          if (events.length) logger.info({ events: events.length }, 'block-party sweep');
          break;
        }
        case 'gift-expiry': {
          const r = await giftsService.sweepExpiry();
          if (r.noticed || r.expired) logger.info(r, 'gift-expiry sweep');
          break;
        }
        case 'spot-me-defaults': {
          const n = await spotMeService.sweepDefaults();
          if (n) logger.info({ defaulted: n }, 'spot-me-defaults sweep');
          break;
        }
        case 'giveaway-reset': {
          const n = await giveawaysService.resetDaily();
          logger.info({ reset: n }, 'giveaway-reset sweep');
          break;
        }
        /**
         * Bill accrued ad impressions, close campaigns whose window has passed, and release slots
         * held by abandoned checkouts. Nothing scheduled this before, so impressions accumulated
         * and were never charged for — the counter moved and the money never did.
         */
        case 'rto-reminders': {
          const r = await rtoService.sweepReminders();
          const total = Object.values(r).reduce((n, v) => n + v, 0);
          if (total > 0) logger.info(r, 'rto-reminders sweep');
          break;
        }
        case 'ad-settlement': {
          const r = await adsService.settleImpressions();
          if (r.billed || r.exhausted || r.ended || r.abandoned)
            logger.info(r, 'ad-settlement sweep');
          break;
        }
        default:
          logger.debug({ name: job.name }, 'unknown sweep job');
      }
    },
    { connection, concurrency: 1 },
  );
  sweepsWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id, name: job?.name }, 'sweep job failed'),
  );
  workers.push(sweepsWorker);

  logger.info('workers started');
  return workers;
}
