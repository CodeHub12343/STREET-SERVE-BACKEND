import { Schema, type InferSchemaType } from 'mongoose';

import type { Role } from '../config/constants';
import { logger } from '../config/logger';
import { getContext } from './context';
import { defineModel } from './defineModel';
import { immutablePlugin } from './mongoImmutable';

/**
 * Immutable, append-only audit trail — a compliance + financial-integrity artifact, distinct
 * from operational logs. Every payout, dispute action, role elevation, Trust Score change,
 * suspension, and admin-on-another-user action writes one entry.
 * See LOGGING_AND_MONITORING.md §2 and NFR Auditability.
 */
const AuditLogSchema = new Schema(
  {
    actorId: { type: String, default: null }, // null for system/automated actions
    actorRole: { type: String, default: null },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    reason: { type: String, default: null },
    correlationId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false }, collection: 'audit_logs' },
);

AuditLogSchema.index({ entityType: 1, entityId: 1, created_at: -1 });
AuditLogSchema.index({ actorId: 1, created_at: -1 });
AuditLogSchema.index({ action: 1, created_at: -1 });
AuditLogSchema.plugin(immutablePlugin);

export type AuditLog = InferSchemaType<typeof AuditLogSchema>;
export const AuditLogModel = defineModel('AuditLog', AuditLogSchema);

export interface AuditInput {
  actorId?: string | null;
  actorRole?: Role | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit entry. Auditing must never break the primary operation, so a write failure is
 * logged at error level rather than thrown — but it is loud enough to alert on.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLogModel.create({
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      reason: input.reason ?? null,
      correlationId: getContext()?.correlationId ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit log');
  }
}
