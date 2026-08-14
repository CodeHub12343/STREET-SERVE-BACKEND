import { logger } from '../config/logger';
import { kv } from './kv';

/**
 * TTL cache for DISPLAY aggregates — impact counters, public totals, anything summed from a large
 * collection and rendered rather than decided on.
 *
 * ## Why this exists, and why it is not the fee cache
 *
 * `payments/feeCache.ts` is a two-level cache with pub/sub invalidation, because a stale fee charges
 * somebody the wrong amount. Nothing here is like that. These numbers are read from immutable
 * receipt rows (D-9 — never from a counter), they are shown on a page, and a minute of staleness is
 * invisible. Rebuilding that machinery for a "meals given" figure would be cost without benefit.
 *
 * What it does buy: the Pay It Forward impact endpoint is **public**, runs two unbounded `$group`
 * aggregations over every contribution and redemption a business has ever had, and is rate-limited
 * only as a read. On a popular business that is a full-collection scan per request, repeated for
 * every viewer. A short TTL collapses that to one scan per window.
 *
 * ## Failure posture
 *
 * A cache miss, a parse failure, or a KV outage all fall through to the real query. Losing the cache
 * degrades speed; it never changes the answer, and it never fails the request.
 */
export async function cachedAggregate<T>(
  key: string,
  ttlSec: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await kv().get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    // A cache that cannot be read is a cache that is not used, not a request that fails.
    logger.debug({ key, err }, 'cachedAggregate: read failed, recomputing');
  }

  const value = await compute();

  try {
    await kv().set(key, JSON.stringify(value), ttlSec);
  } catch (err) {
    logger.debug({ key, err }, 'cachedAggregate: write failed');
  }
  return value;
}

/**
 * Drop a cached aggregate immediately.
 *
 * Used where a write should be visible at once — a vendor who has just watched a contribution land
 * should not be told their pot is still empty for another minute, and "it'll show up shortly" is a
 * support ticket waiting to happen.
 */
export async function invalidateAggregate(key: string): Promise<void> {
  try {
    await kv().del(key);
  } catch (err) {
    logger.debug({ key, err }, 'cachedAggregate: invalidate failed');
  }
}
