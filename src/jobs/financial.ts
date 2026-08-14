import type { Job, JobsOptions, Queue } from 'bullmq';

import { logger } from '../config/logger';
import { bizMetrics } from '../observability/bizMetrics';

/**
 * Financial jobs get CONSERVATIVE retry (fewer attempts, longer backoff) and a dead-letter queue
 * on final failure — never silently retry a money move into duplication (Stripe idempotency keys
 * make retries safe). A dead-lettered financial job pages on-call. See BACKGROUND_JOBS.md §5.
 */
export const FINANCIAL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: false, // keep failed financial jobs for triage
};

export const DEAD_LETTER_QUEUE = 'dead_letter';

/** Pure: has this job exhausted its retries? (Testable without Redis.) */
export function isFinalAttempt(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade >= maxAttempts;
}

/**
 * Route a permanently-failed financial job to the dead-letter queue + raise the on-call metric.
 * Called from a worker's `failed` handler once retries are exhausted.
 */
export async function deadLetterFinancialJob(
  deadLetterQueue: Queue | null,
  sourceQueue: string,
  job: Job | undefined,
  err: Error,
): Promise<void> {
  bizMetrics.financialJobsDeadLettered.inc({ queue: sourceQueue });
  logger.fatal(
    { err, queue: sourceQueue, jobId: job?.id, name: job?.name, attempts: job?.attemptsMade },
    'financial job dead-lettered — on-call review required',
  );
  if (deadLetterQueue && job) {
    await deadLetterQueue.add(
      'dead-letter',
      { sourceQueue, name: job.name, data: job.data as unknown, failedReason: err.message },
      { removeOnComplete: false, removeOnFail: false },
    );
  }
}
