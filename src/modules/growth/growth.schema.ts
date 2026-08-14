import { z } from 'zod';

import { NonNegativeCents, PositiveCents } from '../../shared/money';

const objectId = z.string().length(24);

// Ping budgets + pings
export const BusinessIdParam = z.object({ businessId: objectId }).strict();
export const FundBudgetBody = z
  .object({ reloadCents: NonNegativeCents, perShareTipCents: NonNegativeCents })
  .strict();
export const BudgetStatusBody = z.object({ status: z.enum(['active', 'paused']) }).strict();
export const ShareBody = z
  .object({
    businessId: objectId,
    recipientContact: z.string().min(3).max(200),
    deviceFingerprint: z.string().max(200).optional(),
  })
  .strict();
export const PingIdParam = z.object({ id: objectId }).strict();
export const QualifyBody = z.object({ deviceFingerprint: z.string().max(200).optional() }).strict();

// Gifts
export const CreateGiftBody = z
  .object({
    businessId: objectId,
    itemName: z.string().min(1).max(160),
    amountCents: PositiveCents,
    recipientContact: z.string().min(3).max(200),
  })
  .strict();
export const GiftCodeParam = z.object({ code: z.string().min(4).max(64) }).strict();

// Giveaways
export const CreateGiveawayBody = z
  .object({
    businessId: objectId,
    productName: z.string().min(1).max(160),
    dailyQuantityCap: z.number().int().min(1).max(100000),
  })
  .strict();
export const GiveawayIdParam = z.object({ id: objectId }).strict();

// Spot Me
export const SpotMeRequestBody = z
  .object({
    counterpartyType: z.enum(['vendor', 'peer']),
    counterpartyId: z.string().min(1).max(64),
    amountCents: PositiveCents,
    repayBy: z.string().datetime(),
  })
  .strict();
export const SpotMeIdParam = z.object({ id: objectId }).strict();
export const SpotMeDecideBody = z.object({ accept: z.boolean() }).strict();
