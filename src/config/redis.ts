import IORedis, { type Redis } from 'ioredis';

import { env } from './env';
import { logger } from './logger';

/**
 * Redis clients. One managed Redis backs three logical concerns, separated by key prefix:
 *   - cache / rate-limit / idempotency (the KV store)
 *   - BullMQ queues + event bus
 *   - the Socket.IO adapter (pub/sub)
 *
 * BullMQ requires `maxRetriesPerRequest: null`, so queue clients use a dedicated factory.
 * Connections are created lazily by server.ts / worker.ts, never at module import — this
 * keeps app.ts importable in tests without a live Redis.
 */
let sharedClient: Redis | null = null;

export function createRedis(opts?: { forBullmq?: boolean }): Redis {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured');
  }
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: opts?.forBullmq ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (err) => logger.error({ err }, 'redis error'));
  client.on('connect', () => logger.info('redis connected'));
  return client;
}

/** Shared client for cache / rate-limit / idempotency. */
export function getSharedRedis(): Redis {
  if (!sharedClient) sharedClient = createRedis();
  return sharedClient;
}

export function hasRedis(): boolean {
  return Boolean(env.REDIS_URL);
}

export async function closeRedis(): Promise<void> {
  if (sharedClient) {
    await sharedClient.quit();
    sharedClient = null;
  }
}

export type { Redis };
