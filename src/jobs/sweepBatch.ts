import client from 'prom-client';

import { logger } from '../config/logger';
import { registry } from '../observability/metrics';

/**
 * SC / roadmap 5.3 — the batch cap that every sweep shares, and the instrumentation that makes it
 * stop being silent.
 *
 * ## The problem
 *
 * Every sweep on this platform reads a bounded page of due work — `staleSessions(threshold, 500)`,
 * `dueInstallments(now, 500)`, `expirePendingWaveDowns(now, 500)`, and seven more. The bound is
 * correct: an unbounded sweep is a memory incident waiting for a bad day.
 *
 * What was wrong is that hitting the bound looked exactly like not hitting it. A sweep that
 * processes 500 of 4,000 due items returns `500`, logs success, and **silently defers 3,500 items
 * to the next tick**. If arrivals exceed the drain rate, the backlog grows forever and every
 * individual run looks healthy. The symptom a user reports is not "the sweep is behind" — it is
 * "the map still shows a truck that left an hour ago" or "my payment was taken late", which is
 * several debugging steps away from the cause.
 *
 * ## What this adds
 *
 * One number (`SWEEP_BATCH_LIMIT`) instead of ten copies of `500`, and `reportSweepBatch`, which
 * treats a full batch as the saturation signal it is: a warning log plus a Prometheus counter you
 * can alert on. **Saturation is not an error** — one full batch after a deploy or a backfill is
 * normal. Sustained saturation is the alert, and that is a rate query on the counter, not a
 * threshold this file can decide.
 *
 * ## Drain-rate arithmetic
 *
 * A sweep's capacity is `SWEEP_BATCH_LIMIT ÷ cadence`. At 500 per 60 seconds that is 500/min —
 * fine for stale sessions, where arrivals are bounded by how many vendors go offline per minute.
 * It is much tighter for the hourly RTO installment sweep: 500/hour is 12,000/day, and installments
 * cluster on the 1st and 15th. The full model, per sweep, is in `SWEEP_LOAD_MODEL.md`.
 */

/**
 * Rows a single sweep tick may process. Deliberately one shared constant: sweeps that differ in
 * cadence should differ in *cadence*, not in a per-site magic number nobody can compare.
 */
export const SWEEP_BATCH_LIMIT = 500;

export const sweepMetrics = {
  /** Ticks run, so saturation can be expressed as a RATIO — the only form worth alerting on. */
  ticks: new client.Counter({
    name: 'sweep_ticks_total',
    help: 'Scheduled sweep ticks executed',
    labelNames: ['sweep'] as const,
    registers: [registry],
  }),
  processed: new client.Counter({
    name: 'sweep_items_processed_total',
    help: 'Items processed by a scheduled sweep',
    labelNames: ['sweep'] as const,
    registers: [registry],
  }),
  /**
   * Ticks that filled their batch — i.e. ticks that left work behind. Alert on a sustained rate,
   * never on a single occurrence.
   */
  saturated: new client.Counter({
    name: 'sweep_batch_saturated_total',
    help: 'Sweep ticks that hit the batch limit and deferred work to the next tick',
    labelNames: ['sweep'] as const,
    registers: [registry],
  }),
};

/**
 * Record a sweep tick. Returns `processed` unchanged so call sites can wrap their return value:
 *
 * ```ts
 * return reportSweepBatch('stale-session', stale.length);
 * ```
 */
export function reportSweepBatch(
  sweep: string,
  processed: number,
  limit: number = SWEEP_BATCH_LIMIT,
): number {
  sweepMetrics.ticks.inc({ sweep });
  sweepMetrics.processed.inc({ sweep }, processed);
  if (processed >= limit) {
    sweepMetrics.saturated.inc({ sweep });
    logger.warn(
      { sweep, processed, limit },
      'sweep filled its batch — work was deferred to the next tick. Sustained saturation means the ' +
        'backlog is growing: raise the cadence or the limit.',
    );
  }
  return processed;
}
