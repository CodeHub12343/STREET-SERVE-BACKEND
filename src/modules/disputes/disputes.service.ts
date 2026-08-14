import { DISPUTE_SLA_DAYS } from '../../config/constants';
import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { bizMetrics } from '../../observability/bizMetrics';
import { ERROR_CODES } from '../../shared/errors/codes';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { paymentsService } from '../payments/payments.service';
import { trustService } from '../trust/trust.service';
import { disputesRepository as repo } from './disputes.repository';
import type { DisputeDoc } from './disputes.model';

function isAdmin(principal: Principal): boolean {
  return principal.roles.includes('admin');
}
function isParticipant(principal: Principal, dispute: DisputeDoc): boolean {
  return (
    principal.userId === dispute.opened_by ||
    principal.userId === dispute.subject_id ||
    isAdmin(principal)
  );
}

export const disputesService = {
  async open(
    principal: Principal,
    input: {
      subjectType: 'seller' | 'business' | 'hub';
      subjectId: string;
      refType: 'checkout' | 'transaction' | 'spot_me';
      refId: string;
      note?: string;
    },
  ) {
    const slaDueAt = new Date(Date.now() + DISPUTE_SLA_DAYS * 24 * 60 * 60 * 1000);
    const dispute = await repo.create({
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      related: { ref_type: input.refType, ref_id: input.refId },
      opened_by: principal.userId,
      sla_due_at: slaDueAt,
      evidence: input.note ? [{ note: input.note, by: principal.userId, at: new Date() }] : [],
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'dispute.opened',
      entityType: 'dispute',
      entityId: String(dispute._id),
      metadata: { subjectType: input.subjectType, subjectId: input.subjectId, ref: input.refType },
    });
    // NOTE: no Trust Score change on open — score changes are applied only after resolution (FR-10.3).
    await publish('dispute.opened', {
      disputeId: String(dispute._id),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    });
    return this.view(dispute);
  },

  async addEvidence(
    principal: Principal,
    disputeId: string,
    entry: { url?: string; note?: string },
  ) {
    const dispute = await repo.findById(disputeId);
    if (!dispute) throw NotFoundError('Dispute not found');
    if (!isParticipant(principal, dispute)) {
      throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);
    }
    if (dispute.status === 'resolved') {
      throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Dispute already resolved');
    }
    const updated = await repo.addEvidence(disputeId, {
      url: entry.url,
      note: entry.note,
      by: principal.userId,
      at: new Date(),
    });
    return this.view(updated!);
  },

  /**
   * Admin resolution. The Trust Score change is applied HERE, after resolution — never before
   * (FR-10.3). An optional clawback reverses an already-issued payout via a documented reversal.
   */
  async resolve(
    principal: Principal,
    disputeId: string,
    input: { outcome: 'upheld' | 'dismissed'; resolution: string; clawbackTransactionId?: string },
  ) {
    const resolved = await repo.resolve(disputeId, {
      outcome: input.outcome,
      resolution: input.resolution,
    });
    if (!resolved) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'Dispute not open or already resolved',
      );
    }

    if (input.clawbackTransactionId) {
      // Documented reversal — both parties are notified; never a silent debit (Edge case §4).
      await paymentsService.refund(input.clawbackTransactionId, principal.userId);
    }

    await writeAudit({
      actorId: principal.userId,
      actorRole: 'admin',
      action: 'dispute.resolved',
      entityType: 'dispute',
      entityId: disputeId,
      reason: input.resolution,
      metadata: { outcome: input.outcome, clawback: Boolean(input.clawbackTransactionId) },
    });

    bizMetrics.disputesResolved.inc({ outcome: input.outcome });
    // Apply the score change only now, post-resolution.
    await trustService.recompute(resolved.subject_type, resolved.subject_id);
    await publish('dispute.resolved', {
      disputeId,
      subjectType: resolved.subject_type,
      subjectId: resolved.subject_id,
    });
    return this.view(resolved);
  },

  async get(principal: Principal, disputeId: string) {
    const dispute = await repo.findById(disputeId);
    if (!dispute) throw NotFoundError('Dispute not found');
    if (!isParticipant(principal, dispute)) {
      throw ForbiddenError('Not a participant', ERROR_CODES.NOT_PARTICIPANT);
    }
    return this.view(dispute);
  },

  view(d: DisputeDoc & { _id?: unknown }) {
    return {
      id: String((d as { _id?: unknown })._id),
      subjectType: d.subject_type,
      subjectId: d.subject_id,
      related: d.related,
      status: d.status,
      outcome: d.outcome,
      resolution: d.resolution,
      slaDueAt: d.sla_due_at,
      resolvedAt: d.resolved_at,
      evidenceCount: d.evidence.length,
    };
  },
};
