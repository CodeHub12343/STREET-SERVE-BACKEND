import { createServer, type Server as HttpServer } from 'node:http';

import type { Server as IoServer } from 'socket.io';

import { createApp } from './app';
import { aiProvider, env } from './config/env';
import { connectMongo, disconnectMongo } from './config/db';
import { logger } from './config/logger';
import { closeRedis, createRedis, getSharedRedis, hasRedis } from './config/redis';
import { initEventBus, closeEventBus } from './events/bus';
import { initQueues, closeQueues } from './jobs/queues';
import { createSocketServer } from './realtime/io';
import { useRedisKV } from './shared/kv';
import { initFeeCache } from './modules/payments/feeCache';
import { feeService } from './modules/payments/fees';

/**
 * API + Socket.IO process. Long-lived (NOT serverless) so WebSockets stay up (DEPLOYMENT_STRATEGY.md
 * §1). Owns datastore connections and graceful shutdown; the same image runs worker.ts for jobs.
 */
async function main(): Promise<void> {
  await connectMongo();

  const app = createApp();
  const httpServer: HttpServer = createServer(app);
  let io: IoServer | undefined;

  if (hasRedis()) {
    const shared = getSharedRedis();
    useRedisKV(shared); // rate-limit + idempotency backed by Redis in real deployments
    initEventBus(createRedis({ forBullmq: true }));
    initQueues(createRedis({ forBullmq: true }));

    // A-3: the fee schedule is cached in-process on the money hot path; without this, a schedule
    // change propagates instance-by-instance over a TTL, so two pods can price the same transaction
    // differently for the width of that window. The subscriber must be its own connection — a
    // client in subscriber mode cannot serve the KV store.
    initFeeCache({
      publisher: shared,
      subscriber: createRedis(),
      onInvalidate: () => feeService.invalidateFeeCache(),
    });

    // Socket.IO needs dedicated pub/sub connections for its adapter.
    io = createSocketServer(httpServer, createRedis(), createRedis());
  } else {
    logger.warn('REDIS_URL not set — realtime, event bus, and Redis-backed limits are disabled');
  }

  httpServer.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        // Which engine is answering /ai/* — the fallback is silent by design, so state it at boot.
        aiProvider,
        ...(aiProvider === 'gemini' ? { aiModel: env.GEMINI_MODEL, aiFastModel: env.GEMINI_FAST_MODEL } : {}),
      },
      'streetserve api listening',
    );
  });

  // ─── Graceful shutdown ───────────────────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    httpServer.close();
    if (io) await io.close();
    await closeEventBus();
    await closeQueues();
    await disconnectMongo();
    await closeRedis();

    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled rejection — shutting down');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
