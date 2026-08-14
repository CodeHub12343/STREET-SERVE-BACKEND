import { z } from 'zod';

import { PositiveCents, NonNegativeCents } from '../../shared/money';

export const OwnerParams = z
  .object({ ownerType: z.enum(['business', 'seller']), ownerId: z.string().min(1).max(64) })
  .strict();

export const DiscountScheduleBody = z
  .object({
    tiers: z
      .array(
        z
          .object({
            position: z.number().int().positive(),
            discount_percent: z.number().int().min(0).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    capPercent: z.number().int().min(0).max(100),
  })
  .strict();

export const CreateWaveDownBody = z
  .object({
    targetType: z.enum(['business', 'seller']),
    targetId: z.string().min(1).max(64),
    note: z.string().max(280).optional(),
  })
  .strict();

export const WaveIdParam = z.object({ id: z.string().length(24) }).strict();
export const AcceptWaveBody = z
  .object({ etaSeconds: z.number().int().min(0).max(7200).optional() })
  .strict();
export const DeclineWaveBody = z.object({ reason: z.string().max(280).optional() }).strict();

export const CheckoutBody = z
  .object({
    baseAmountCents: PositiveCents,
    tipCents: NonNegativeCents.optional(),
    roundUpCents: NonNegativeCents.optional(),
  })
  .strict();
