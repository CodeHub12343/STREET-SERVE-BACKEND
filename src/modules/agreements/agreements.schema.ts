import { z } from 'zod';

import { AGREEMENT_TYPES } from './agreements.registry';

export const AgreementTypeParam = z.object({ type: z.enum(AGREEMENT_TYPES) }).strict();

export const AcceptAgreementBody = z
  .object({
    // Optional attestation: when present, must match the current version + hash (tamper-evident).
    version: z.string().max(64).optional(),
    contentHash: z.string().length(64).optional(),
  })
  .strict();
