import { Queue, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { logger } from '../config/logger';
import { getContext } from '../shared/context';
import type { DomainEventName, DomainEventPayload } from './types';

/**
 * Internal event bus over BullMQ (guaranteed-delivery, Redis-backed). `publish` enqueues to the
 * `events` queue; the worker fans events to registered handlers. Without Redis (some dev/test
 * runs) publish is a logged no-op so the request path never breaks.
 */
export const EVENTS_QUEUE = 'events';

let queue: Queue | null = null;

export function initEventBus(connection: Redis): void {
  // BullMQ bundles its own ioredis; the instance is compatible at runtime — bridge the nominal
  // type gap from the duplicate package.
  queue = new Queue(EVENTS_QUEUE, { connection: connection as unknown as ConnectionOptions });
  logger.info('event bus initialised');
}

export async function publish<K extends DomainEventName>(
  name: K,
  payload: DomainEventPayload<K>,
): Promise<void> {
  const envelope = { name, payload, correlationId: getContext()?.correlationId ?? null };
  if (!queue) {
    logger.warn({ event: name }, 'event bus not initialised — event dropped');
    return;
  }
  await queue.add(name, envelope, {
    removeOnComplete: 1000,
    removeOnFail: 5000,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
  });
}

export async function closeEventBus(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
