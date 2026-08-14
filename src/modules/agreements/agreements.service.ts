import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { agreementsRepository as repo } from './agreements.repository';
import { getAgreement, type AgreementType } from './agreements.registry';

/**
 * Agreement acceptance service (R28 / DEBT7). The single gate for "has this user accepted the
 * current version of agreement X?", plus tamper-evident acceptance (S5): we store the exact
 * version + content hash the user agreed to, and reject a client whose attested hash doesn't match
 * the current reviewed text (they saw stale content — make them re-read).
 */
export const agreementsService = {
  /** The current body for the clickwrap to display (title, text, version, hash). */
  get(type: AgreementType) {
    return getAgreement(type);
  },

  async accept(
    principal: Principal,
    type: AgreementType,
    input: { version?: string; contentHash?: string } = {},
  ) {
    const current = getAgreement(type);
    if (input.version && input.version !== current.version) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'This agreement has been updated — please reload and review the current version',
      );
    }
    if (input.contentHash && input.contentHash !== current.contentHash) {
      throw BusinessRuleError(
        ERROR_CODES.BUSINESS_RULE,
        'The agreement text you viewed is out of date — please reload and re-read before accepting',
      );
    }
    const fresh = await repo.record(principal.userId, type, current.version, current.contentHash);
    if (fresh) {
      await writeAudit({
        actorId: principal.userId,
        action: 'agreement.accepted',
        entityType: 'agreement',
        entityId: `${type}:${current.version}`,
        metadata: { type, version: current.version, content_hash: current.contentHash },
      });
    }
    return { type, version: current.version, contentHash: current.contentHash, accepted: true };
  },

  hasAccepted(userId: string, type: AgreementType): Promise<boolean> {
    return repo.exists(userId, type, getAgreement(type).version);
  },

  /** Gate a flow on acceptance of the current version — throws AGREEMENT_REQUIRED otherwise. */
  async assertAccepted(userId: string, type: AgreementType): Promise<void> {
    if (!(await this.hasAccepted(userId, type))) {
      throw BusinessRuleError(
        ERROR_CODES.AGREEMENT_REQUIRED,
        `You must accept the current ${getAgreement(type).title} before continuing`,
      );
    }
  },
};
