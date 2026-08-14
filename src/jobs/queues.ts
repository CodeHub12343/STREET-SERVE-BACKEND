import { Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * BullMQ queue registry. Queues are created against a Redis connection supplied by the worker /
 * server bootstrap (never at import). Names mirror BACKGROUND_JOBS.md §2; Phase 0 stands up the
 * infrastructure and the scheduled `sweeps`/`reconciliation` queues, which later phases fill in.
 */
export const QUEUE_NAMES = [
  'events',
  'settlement',
  'payments',
  'trust',
  'notifications',
  'fraud',
  'sweeps',
  'geo',
  'reconciliation',
  'maintenance',
  'dead_letter',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const queues = new Map<QueueName, Queue>();

export function initQueues(connection: Redis): Map<QueueName, Queue> {
  const conn = connection as unknown as ConnectionOptions;
  for (const name of QUEUE_NAMES) {
    if (!queues.has(name)) {
      queues.set(name, new Queue(name, { connection: conn }));
    }
  }
  return queues;
}

export function getQueue(name: QueueName): Queue {
  const q = queues.get(name);
  if (!q) throw new Error(`Queue "${name}" not initialised`);
  return q;
}

export function hasQueue(name: QueueName): boolean {
  return queues.has(name);
}

/**
 * Move work off the request path when a queue exists, and run it inline when one doesn't.
 *
 * The fallback is deliberate, not a shortcut: tests and single-process dev runs have no Redis, and
 * silently dropping post-settlement work there would be far worse than doing it synchronously.
 * Enqueue failures fall back the same way — the work matters more than where it runs.
 */
export async function enqueueOrRun(
  name: QueueName,
  jobName: string,
  payload: Record<string, unknown>,
  inline: () => Promise<void>,
): Promise<'queued' | 'inline'> {
  if (!hasQueue(name)) {
    await inline();
    return 'inline';
  }
  try {
    await getQueue(name).add(jobName, payload, {
      removeOnComplete: true,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    });
    return 'queued';
  } catch {
    await inline();
    return 'inline';
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
