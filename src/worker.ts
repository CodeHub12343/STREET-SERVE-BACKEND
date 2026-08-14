import type { Worker } from 'bullmq';

import { connectMongo, disconnectMongo } from './config/db';
import { logger } from './config/logger';
import { closeRedis, createRedis, getSharedRedis, hasRedis } from './config/redis';
import { closeQueues, initQueues } from './jobs/queues';
import { registerScheduledJobs } from './jobs/scheduler';
import { startWorkers } from './jobs/processors';
import { initFeeCache } from './modules/payments/feeCache';
import { feeService } from './modules/payments/fees';

/**
 * BullMQ worker process — the same image as the API, started with a different command so async
 * work scales independently and never competes with request latency (BACKGROUND_JOBS.md §1).
 */
async function main(): Promise<void> {
  if (!hasRedis()) {
    logger.fatal('REDIS_URL is required to run the worker');
    process.exit(1);
  }

  await connectMongo();
  const connection = createRedis({ forBullmq: true });
  initQueues(connection);
  await registerScheduledJobs(connection);
  const workers: Worker[] = startWorkers(createRedis({ forBullmq: true }));

  // A-3: the worker prices money too — settlement sweeps, installment charges, placement billing —
  // so it needs the same invalidation feed as the API. A worker holding a stale fee schedule is
  // worse than an API instance doing it, because nobody is watching a sweep's output in real time.
  initFeeCache({
    publisher: getSharedRedis(),
    subscriber: createRedis(),
    onInvalidate: () => feeService.invalidateFeeCache(),
  });

  logger.info('worker process ready');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await disconnectMongo();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start worker');
  process.exit(1);
});
