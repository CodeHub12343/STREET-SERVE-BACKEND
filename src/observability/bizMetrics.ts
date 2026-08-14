import client from 'prom-client';

import { registry } from './metrics';

/**
 * Business / SLA metrics (Phase 8). The specific signals the docs say to alert on:
 * settlement latency, payout success, reconciliation drift, oversell rejects, dispute SLA,
 * fraud-flag rate, live-session staleness, wave-down SLA breach. Exposed on the same /metrics
 * registry. See LOGGING_AND_MONITORING.md §3/§6.
 */
export const bizMetrics = {
  oversellReject: new client.Counter({
    name: 'oversell_reject_total',
    help: 'Consignment sales rejected by the oversell guard',
    registers: [registry],
  }),
  settlements: new client.Counter({
    name: 'settlements_total',
    help: 'Consignment settlements written',
    registers: [registry],
  }),
  settlementGrossCents: new client.Counter({
    name: 'settlement_gross_cents_total',
    help: 'Gross consignment sales settled (cents)',
    registers: [registry],
  }),
  settlementLatency: new client.Histogram({
    name: 'settlement_processing_seconds',
    help: 'Settlement processing latency (checkout → settled)',
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  }),
  payouts: new client.Counter({
    name: 'payouts_total',
    help: 'Payout transfers attempted',
    labelNames: ['kind', 'result'] as const,
    registers: [registry],
  }),
  reconciliationDrift: new client.Gauge({
    name: 'reconciliation_drift_cents',
    help: 'Ledger vs Stripe drift at last reconciliation (cents)',
    registers: [registry],
  }),
  disputesResolved: new client.Counter({
    name: 'disputes_resolved_total',
    help: 'Disputes resolved',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  fraudFlags: new client.Counter({
    name: 'fraud_flags_total',
    help: 'Fraud flags raised for human review',
    labelNames: ['type'] as const,
    registers: [registry],
  }),
  pingTipsPaid: new client.Counter({
    name: 'ping_tips_paid_total',
    help: 'Paid-share tips that qualified and were paid',
    registers: [registry],
  }),
  waveDownSlaBreach: new client.Counter({
    name: 'wave_down_sla_breach_total',
    help: 'Wave-downs expired unanswered past SLA',
    registers: [registry],
  }),
  staleSessionsSwept: new client.Counter({
    name: 'live_session_stale_swept_total',
    help: 'Live sessions marked stale by the sweep',
    registers: [registry],
  }),
  blockPartyDetected: new client.Counter({
    name: 'block_party_detected_total',
    help: 'Block Party clusters detected + broadcast',
    registers: [registry],
  }),
  financialJobsDeadLettered: new client.Counter({
    name: 'financial_jobs_dead_lettered_total',
    help: 'Financial jobs sent to the dead-letter queue (needs on-call review)',
    labelNames: ['queue'] as const,
    registers: [registry],
  }),

  // ─── Postcard marketing (7.5) ─────────────────────────────────────────────────────────────
  /**
   * Artwork waiting on a human.
   *
   * The audit named manual moderation as the scaling bottleneck (TD-8) and asked for it to be
   * *observed* rather than discovered: the queue is fine at ten orders a week and becomes the whole
   * product at a few hundred. A gauge means the ceiling arrives as a graph, not as a complaint.
   */
  postcardModerationQueueDepth: new client.Gauge({
    name: 'postcard_moderation_queue_depth',
    help: 'Artwork awaiting human review before it can be printed',
    registers: [registry],
  }),
  /** Age of the oldest waiting item. Depth alone hides a small queue nobody is working. */
  postcardModerationOldestSeconds: new client.Gauge({
    name: 'postcard_moderation_oldest_seconds',
    help: 'Age of the oldest artwork still awaiting review',
    registers: [registry],
  }),
  /**
   * Paid orders that could not be handed to the printer.
   *
   * The single most important number in this feature: each one is a customer who has been charged
   * and has no mailing. Labelled by outcome so a vendor outage reads differently from artwork
   * rejected after payment, which need different responses.
   */
  postcardSubmissionFailures: new client.Counter({
    name: 'postcard_submission_failures_total',
    help: 'Paid postcard orders that failed to reach the print vendor',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  postcardSubmissions: new client.Counter({
    name: 'postcard_submissions_total',
    help: 'Postcard orders successfully handed to the print vendor',
    registers: [registry],
  }),
  /**
   * How long the vendor takes to price a run.
   *
   * Quoting is on the buyer's critical path — it runs while they change the quantity — and it is a
   * live upstream call. Buckets are wide because the interesting question is "is this seconds or
   * tens of seconds", not milliseconds of jitter.
   */
  postcardQuoteSeconds: new client.Histogram({
    name: 'postcard_quote_seconds',
    help: 'Time to produce a postcard quote, including the vendor pricing call',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  }),
};
