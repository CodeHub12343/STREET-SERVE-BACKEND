import { z } from 'zod';

import {
  PAY_FORWARD_EXPIRY_DAY_OPTIONS,
  PAY_FORWARD_MAX_CONTRIBUTION_CENTS,
  PAY_FORWARD_MIN_CONTRIBUTION_CENTS,
} from '../../config/constants';

const objectId = z.string().length(24);

export const BusinessIdParam = z.object({ businessId: objectId }).strict();
/** ADR-005 §7 — the gift being taken back. Ownership is checked in the service. */
export const ContributionIdParam = z.object({ contributionId: objectId }).strict();

export const ContributeBody = z
  .object({
    amountCents: z
      .number()
      .int()
      .min(PAY_FORWARD_MIN_CONTRIBUTION_CENTS)
      .max(PAY_FORWARD_MAX_CONTRIBUTION_CENTS),
    /**
     * Anonymity is the default, so this is opt-OUT. A client that omits the field gets the private
     * behaviour — the safe direction for a flag whose wrong value is a privacy incident.
     */
    anonymous: z.boolean().optional(),
    displayName: z.string().min(1).max(60).optional(),
    note: z.string().max(200).optional(),
  })
  .strict()
  .refine((v) => v.anonymous !== false || Boolean(v.displayName), {
    message: 'Give a name to be credited with, or contribute anonymously',
    path: ['displayName'],
  });

export const FundSettingsBody = z
  .object({
    accepting: z.boolean().optional(),
    maxPerRedemptionCents: z.number().int().min(1).nullable().optional(),
    maxPercentOfOrder: z.number().int().min(1).max(100).optional(),
    maxPerDayCents: z.number().int().min(1).nullable().optional(),
    // "Never" is not on this list, and that is a decision (ADR-005 §6), not an omission.
    expiryDays: z
      .number()
      .int()
      .refine((v) => (PAY_FORWARD_EXPIRY_DAY_OPTIONS as readonly number[]).includes(v), {
        message: `Expiry must be one of: ${PAY_FORWARD_EXPIRY_DAY_OPTIONS.join(', ')} days`,
      })
      .optional(),
  })
  .strict();
