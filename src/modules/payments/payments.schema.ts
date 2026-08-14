import { z } from 'zod';

import { PositiveCents, NonNegativeCents } from '../../shared/money';

export const CreateTransactionBody = z
  .object({
    counterpartyType: z.enum(['business', 'seller']),
    counterpartyId: z.string().min(1).max(64),
    amountCents: PositiveCents,
    discountAppliedCents: NonNegativeCents.optional(),
    tipCents: NonNegativeCents.optional(),
    roundUpCents: NonNegativeCents.optional(),
  })
  .strict()
  .refine((v) => (v.tipCents ?? 0) + (v.roundUpCents ?? 0) <= v.amountCents, {
    message: 'tip + round-up cannot exceed the total amount',
  });
export type CreateTransactionBody = z.infer<typeof CreateTransactionBody>;

export const TransactionIdParam = z.object({ id: z.string().length(24) }).strict();
