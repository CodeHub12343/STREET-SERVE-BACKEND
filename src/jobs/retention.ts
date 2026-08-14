import { NotificationModel } from '../modules/notifications/notifications.model';
import { AuditLogModel } from '../shared/audit';
import { logger } from '../config/logger';

/**
 * 6.4 — data retention, actually implemented.
 *
 * The scheduler registered a `daily-maintenance` job described as *"retention purge, index health"*
 * and the worker for it logged `'maintenance heartbeat'` and returned. Retention was documented and
 * did not exist — the same shape as the audit's other findings, and worth naming as such rather
 * than quietly fixing.
 *
 * ## What is deleted, and what is never deleted
 *
 * The dividing line is **what the record is for**, not how big the collection gets:
 *
 * - **Operational convenience data** (a read notification from four months ago) is deleted. Keeping
 *   it serves nobody and every retained personal record is one more thing to disclose in a breach.
 * - **Compliance and financial records are never deleted here.** Audit logs, ledger entries,
 *   settlements, RTO statements, transactions, and agreement acceptances are the evidence that the
 *   platform did what it said it did. A retention job that can reach them is a retention job that
 *   can destroy the record of a dispute, and no operational benefit justifies that.
 *
 * `AUDIT_RETENTION` below exists to make the second point explicit rather than implicit. An audit
 * log with no stated policy looks like an oversight; an audit log with a stated policy of "kept
 * indefinitely, deliberately" is a decision someone made.
 *
 * ## Why unread notifications survive
 *
 * Only **read** notifications age out. An unread one is a message the user has not seen — deleting
 * it is deleting communication, which is exactly what the §38/§49 notice obligations mean when they
 * say a party must be told something.
 */

/** Read notifications older than this are deleted. Unread ones are never deleted by age. */
export const NOTIFICATION_RETENTION_DAYS = 180;

/**
 * Audit logs are **kept indefinitely, on purpose.** Stated as a constant so the policy is visible
 * in code review rather than inferred from the absence of a purge. Changing this is a compliance
 * decision, not a cleanup task.
 */
export const AUDIT_RETENTION = 'indefinite';

export interface RetentionResult {
  notificationsDeleted: number;
  auditLogsRetained: number;
}

/**
 * Run the daily retention purge. Returns counts so the job's log line says what it did, rather than
 * "heartbeat" — a maintenance job whose output does not distinguish "ran and deleted nothing" from
 * "did not run" is a job nobody can tell is broken.
 */
export async function runRetentionPurge(now: Date = new Date()): Promise<RetentionResult> {
  const notificationCutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);

  const notifications = await NotificationModel.deleteMany({
    created_at: { $lt: notificationCutoff },
    read_at: { $ne: null }, // unread = unseen communication; age is not a reason to delete it
  }).exec();

  // Counted, never deleted. The number is here so the retained volume is observable — an audit
  // trail that grows without anyone watching is how a collection becomes a surprise.
  const auditLogsRetained = await AuditLogModel.estimatedDocumentCount().exec();

  logger.info(
    {
      notificationsDeleted: notifications.deletedCount ?? 0,
      notificationCutoff,
      auditLogsRetained,
      auditRetention: AUDIT_RETENTION,
    },
    'retention purge complete',
  );

  return { notificationsDeleted: notifications.deletedCount ?? 0, auditLogsRetained };
}
