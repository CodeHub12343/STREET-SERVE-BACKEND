import { AgreementAcceptanceModel } from './agreements.model';
import type { AgreementType } from './agreements.registry';

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const agreementsRepository = {
  exists(userId: string, type: AgreementType, version: string): Promise<boolean> {
    return AgreementAcceptanceModel.exists({
      user_id: userId,
      agreement_type: type,
      version,
    }).then(Boolean);
  },

  /**
   * Append-only insert. Returns true if a NEW acceptance was recorded, false if the user had already
   * accepted this exact version (idempotent — the unique index makes the second write a no-op).
   */
  async record(
    userId: string,
    type: AgreementType,
    version: string,
    contentHash: string,
  ): Promise<boolean> {
    try {
      await AgreementAcceptanceModel.create({
        user_id: userId,
        agreement_type: type,
        version,
        content_hash: contentHash,
      });
      return true;
    } catch (err) {
      if (isDuplicateKey(err)) return false;
      throw err;
    }
  },
};
