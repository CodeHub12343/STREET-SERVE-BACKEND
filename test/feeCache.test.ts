import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Redis } from '../src/config/redis';
import {
  FEE_INVALIDATION_CHANNEL,
  FEE_SCHEDULE_KEY,
  FEE_SCHEDULE_TTL_SEC,
  initFeeCache,
  publishInvalidation,
  readSharedSchedule,
  resetFeeCacheWiring,
  writeSharedSchedule,
} from '../src/modules/payments/feeCache';

/**
 * A-3 / SC-1 — the shared fee cache.
 *
 * The failure being prevented is specific: with an in-process cache and N instances, a schedule
 * change propagates over a TTL, so two pods price the same transaction differently for the width of
 * that window. These tests pin the three properties that close it — invalidation reaches peers, it
 * deletes the shared copy BEFORE announcing, and none of it can fail a charge.
 */

/** A fake ioredis with just enough surface, plus recorded call order. */
function fakeRedis() {
  const calls: string[] = [];
  const store = new Map<string, string>();
  const handlers: ((channel: string, message: string) => void)[] = [];

  const client = {
    calls,
    store,
    get(key: string) {
      calls.push(`get:${key}`);
      return Promise.resolve(store.get(key) ?? null);
    },
    set(key: string, value: string, _mode?: string, _ttl?: number) {
      calls.push(`set:${key}`);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    del(key: string) {
      calls.push(`del:${key}`);
      store.delete(key);
      return Promise.resolve(1);
    },
    publish(channel: string, message: string) {
      calls.push(`publish:${channel}`);
      for (const handler of handlers) handler(channel, message);
      return Promise.resolve(1);
    },
    subscribe(_channel: string, cb: (err: Error | null) => void) {
      cb(null);
      return Promise.resolve(1);
    },
    on(event: string, handler: (channel: string, message: string) => void) {
      if (event === 'message') handlers.push(handler);
      return client;
    },
  };
  return client;
}

describe('shared fee cache (A-3)', () => {
  afterEach(() => resetFeeCacheWiring());

  it('is a no-op with no Redis — pricing must work without a cache', async () => {
    // Tests and single-process dev run without Redis. Every path has to degrade to L1 + Mongo.
    expect(await readSharedSchedule()).toBeNull();
    await expect(writeSharedSchedule({ fees: {}, consignmentBps: 1000 })).resolves.toBeUndefined();
    await expect(publishInvalidation()).resolves.toBeUndefined();
  });

  it('round-trips a schedule through the shared copy', async () => {
    const redis = fakeRedis();
    initFeeCache({
      publisher: redis as unknown as Redis,
      subscriber: redis as unknown as Redis,
      onInvalidate: () => {},
    });

    await writeSharedSchedule({ fees: { marketplace: { rate_bps: 1000 } }, consignmentBps: 1000 });
    expect(await readSharedSchedule()).toEqual({
      fees: { marketplace: { rate_bps: 1000 } },
      consignmentBps: 1000,
    });
  });

  it('deletes the shared copy BEFORE announcing the invalidation', async () => {
    // Order is the whole point. Publishing first lets an instance clear L1 on the message, re-read
    // the not-yet-deleted shared copy, and re-cache the stale schedule for the full TTL — turning a
    // short window into a long one.
    const redis = fakeRedis();
    initFeeCache({
      publisher: redis as unknown as Redis,
      subscriber: redis as unknown as Redis,
      onInvalidate: () => {},
    });
    await writeSharedSchedule({ fees: {}, consignmentBps: 1000 });
    redis.calls.length = 0;

    await publishInvalidation();

    expect(redis.calls).toEqual([`del:${FEE_SCHEDULE_KEY}`, `publish:${FEE_INVALIDATION_CHANNEL}`]);
  });

  it('drops the local cache on a peer invalidation message', async () => {
    const redis = fakeRedis();
    const onInvalidate = vi.fn();
    initFeeCache({
      publisher: redis as unknown as Redis,
      subscriber: redis as unknown as Redis,
      onInvalidate,
    });

    await publishInvalidation();
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('ignores traffic on other channels', async () => {
    const redis = fakeRedis();
    const onInvalidate = vi.fn();
    initFeeCache({
      publisher: redis as unknown as Redis,
      subscriber: redis as unknown as Redis,
      onInvalidate,
    });

    await redis.publish('some:other:channel', 'noise');
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('falls back to the database rather than failing when Redis errors', async () => {
    // A cache read must never be able to fail a charge.
    const redis = fakeRedis();
    redis.get = () => Promise.reject(new Error('connection reset'));
    initFeeCache({
      publisher: redis as unknown as Redis,
      subscriber: redis as unknown as Redis,
      onInvalidate: () => {},
    });

    expect(await readSharedSchedule()).toBeNull();
  });

  it('treats a corrupt shared payload as a miss, not as "there are no fees"', async () => {
    // The dangerous reading of a garbled cache entry is "the schedule is empty", which would price
    // every fee at its code default without anyone noticing.
    const redis = fakeRedis();
    initFeeCache({
      publisher: redis as unknown as Redis,
      subscriber: redis as unknown as Redis,
      onInvalidate: () => {},
    });
    redis.store.set(FEE_SCHEDULE_KEY, '{not json');
    expect(await readSharedSchedule()).toBeNull();

    redis.store.set(FEE_SCHEDULE_KEY, JSON.stringify({ fees: {} })); // no consignmentBps
    expect(await readSharedSchedule()).toBeNull();
  });

  it('keeps a TTL as the missed-message backstop', () => {
    // Pub/sub is fast, not guaranteed. A subscriber reconnecting during a publish misses it, so the
    // shared copy must still expire on its own.
    expect(FEE_SCHEDULE_TTL_SEC).toBeGreaterThan(0);
  });
});
