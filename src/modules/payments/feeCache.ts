import type { Redis } from '../../config/redis';
import { logger } from '../../config/logger';

/**
 * A-3 / SC-1 — the shared layer under the fee-schedule cache.
 *
 * ## The failure this removes
 *
 * The fee schedule was cached in-process with a 30-second TTL. With N app instances that makes a
 * schedule change propagate **non-atomically**: for up to 30 seconds after ops corrects a mispriced
 * fee, one instance charges the new rate and another charges the old one. On a quiet day that is
 * invisible; at volume it is a reconciliation discrepancy with no single explanation, because the
 * two transactions are identical in every respect except which pod served them.
 *
 * ## The design, and why it is not "read Redis on every resolve"
 *
 * `resolveFeeRule` sits on the money hot path — every `charge()` calls it. Replacing a memory
 * lookup with a network round trip would add latency to every payment to solve a problem that is
 * really about *invalidation*, not about storage. So:
 *
 * ```
 *   L1  in-process Map        ← nanoseconds, cleared by pub/sub
 *   L2  Redis (shared JSON)   ← one round trip, shared by every instance
 *   L3  MongoDB               ← the source of truth
 * ```
 *
 * A write publishes on `fee_schedule:invalidate`; every instance drops L1 immediately. The TTL
 * stays as a **backstop** for a message lost while a subscriber was reconnecting — push
 * invalidation is fast, not guaranteed, and a fee cache should not depend on a delivery promise
 * Redis pub/sub does not make.
 *
 * ## Ordering
 *
 * On invalidation, **L2 is deleted before the message is published.** The reverse order has a real
 * race: an instance that clears L1 on the message and immediately re-reads a not-yet-deleted L2
 * would re-cache the stale schedule and hold it for the full TTL — turning a 30-second window into
 * a 5-minute one.
 *
 * ## Degradation
 *
 * With no Redis configured (tests, single-process dev) every function here is a no-op and the
 * caller falls back to L1 + Mongo, which is exactly the previous behaviour. Redis being down must
 * never stop the platform pricing a charge.
 */

export const FEE_INVALIDATION_CHANNEL = 'fee_schedule:invalidate';
export const FEE_SCHEDULE_KEY = 'fee_schedule:v1';
/** L2 lifetime. Long, because invalidation is push-based; this is only the missed-message backstop. */
export const FEE_SCHEDULE_TTL_SEC = 300;

/** Serialized L2 payload. Deliberately a plain object — Maps do not survive JSON. */
export interface CachedSchedule {
  fees: Record<string, unknown>;
  consignmentBps: number;
}

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let onInvalidate: (() => void) | null = null;

/**
 * Wire the cache to Redis. Called once at startup from server.ts / worker.ts.
 *
 * The subscriber must be a **dedicated connection**: a client in subscriber mode cannot run
 * ordinary commands, so sharing the KV client would break rate limiting and idempotency the moment
 * this was enabled.
 */
export function initFeeCache(options: {
  publisher: Redis;
  subscriber: Redis;
  onInvalidate: () => void;
}): void {
  publisher = options.publisher;
  subscriber = options.subscriber;
  onInvalidate = options.onInvalidate;

  void subscriber.subscribe(FEE_INVALIDATION_CHANNEL, (err) => {
    if (err) logger.error({ err }, 'fee cache: failed to subscribe to invalidation channel');
    else logger.info('fee cache: subscribed to invalidation channel');
  });

  subscriber.on('message', (channel: string) => {
    if (channel !== FEE_INVALIDATION_CHANNEL) return;
    logger.info('fee cache: invalidation received, dropping local schedule');
    onInvalidate?.();
  });
}

/** Test/shutdown hook: forget the clients so a later init starts clean. */
export function resetFeeCacheWiring(): void {
  publisher = null;
  subscriber = null;
  onInvalidate = null;
}

export function feeCacheIsShared(): boolean {
  return publisher !== null;
}

/**
 * Read the shared copy. Returns null when Redis is absent, empty, or holds something unparseable —
 * every one of which means "fall through to Mongo", never "there is no fee schedule".
 */
export async function readSharedSchedule(): Promise<CachedSchedule | null> {
  if (!publisher) return null;
  try {
    const raw = await publisher.get(FEE_SCHEDULE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSchedule;
    if (typeof parsed?.consignmentBps !== 'number') return null;
    return parsed;
  } catch (err) {
    // A cache read must never fail a charge. Log and price from the database.
    logger.warn({ err }, 'fee cache: shared read failed, falling back to database');
    return null;
  }
}

export async function writeSharedSchedule(schedule: CachedSchedule): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.set(FEE_SCHEDULE_KEY, JSON.stringify(schedule), 'EX', FEE_SCHEDULE_TTL_SEC);
  } catch (err) {
    logger.warn({ err }, 'fee cache: shared write failed');
  }
}

/**
 * Delete the shared copy, then tell every instance to drop its local one. Order matters — see the
 * header. Awaiting the delete before publishing is the whole point of this function.
 */
export async function publishInvalidation(): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.del(FEE_SCHEDULE_KEY);
    await publisher.publish(FEE_INVALIDATION_CHANNEL, String(Date.now()));
  } catch (err) {
    // The local cache is cleared by the caller regardless, so this instance is correct even here.
    // Other instances fall back to their TTL, which is why the TTL still exists.
    logger.warn({ err }, 'fee cache: failed to publish invalidation; peers will expire on TTL');
  }
}
