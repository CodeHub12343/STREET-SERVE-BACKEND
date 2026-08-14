import { z } from 'zod';

import { ACCOUNT_TYPES } from './ledger.model';

/** Admin/finance read surfaces only — nothing here writes to the ledger from the outside. */

export const ListAccountsQuery = z
  .object({
    ownerType: z.enum(['platform', 'user', 'business']).optional(),
    ownerId: z.string().max(64).optional(),
    accountType: z.enum(ACCOUNT_TYPES).optional(),
  })
  .strict();

export const ListEntriesQuery = z
  .object({
    accountId: z.string().length(24).optional(),
    transactionId: z.string().max(120).optional(),
    refType: z.string().max(40).optional(),
    refId: z.string().max(64).optional(),
    cursor: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const ReconcileQuery = z
  .object({
    /**
     * Repair drifted cached balances from their entries. Off by default: seeing drift matters.
     *
     * NOT `z.coerce.boolean()` — that is `Boolean(string)`, so every non-empty value is true and
     * `?repair=false` would rewrite balances while explicitly asking not to. Only the literal
     * "true"/"1" turn this on.
     */
    repair: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .transform((v) => v === 'true' || v === '1'),
  })
  .strict();
